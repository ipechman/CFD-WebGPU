// 2D compressible Euler, finite volume, MUSCL (minmod) + HLLC, dimensional
// splitting (one sweep per dispatch). Cartesian immersed boundary: solid cells
// mirror the adjacent fluid state (slip wall); wall pressure comes out of the
// HLLC star state and is accumulated for force coefficients.
//
// Nondimensionalization: rho_inf = 1, a_inf = 1  =>  p_inf = 1/gamma, U_inf = M.
//
// NOTE: tests/hllc_sod.mjs contains a JS mirror of prim/cons/flux/hllc.
// Keep the math in sync.

struct Params {
  nx: u32,
  ny: u32,
  axis: u32,       // 0 = x sweep, 1 = y sweep
  writeMacro: u32, // 1 = write macro texture this pass
  dtdx: f32,
  gamma: f32,
  minf: f32,
  alpha: f32,
  fscale: f32,
  cmx: f32,
  cmy: f32,
  vmax: f32,  // velocity bound; sized for the hottest recent Mach (see euler.js)
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> Uin: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> Uout: array<vec4f>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> forceAcc: array<atomic<i32>>; // Fx, Fy, Tz
@group(0) @binding(5) var macroTex: texture_storage_2d<rgba16float, write>;

const RHO_MIN: f32 = 1e-6;
const P_MIN: f32 = 1e-7;
const BIG: f32 = 1e12;

fn prim(U: vec4f) -> vec4f {
  let rho = max(U.x, RHO_MIN);
  var u = U.y / rho;
  var v = U.z / rho;
  // pressure from the UNclamped velocity, so the clamp below discards excess
  // kinetic energy instead of converting it to pressure (a p-feedback there
  // detonates the field: p up -> a up -> CFL violated -> more clamping)
  let p = max((P.gamma - 1.0) * (U.w - 0.5 * rho * (u * u + v * v)), P_MIN);
  // total-enthalpy speed limit (1.25x margin): a vacuum-floor cell dividing
  // finite momentum by RHO_MIN would otherwise drive dt*|u| far past CFL.
  // P.vmax tracks the hottest recent Mach (euler.js), not the instantaneous
  // one - a live Mach drop must not clamp the still-fast old field.
  let V2 = u * u + v * v;
  if (V2 > P.vmax * P.vmax) {
    let sc = P.vmax / sqrt(V2);
    u *= sc;
    v *= sc;
  }
  return vec4f(rho, u, v, p);
}

fn cons(W: vec4f) -> vec4f {
  let E = W.w / (P.gamma - 1.0) + 0.5 * W.x * (W.y * W.y + W.z * W.z);
  return vec4f(W.x, W.x * W.y, W.x * W.z, E);
}

fn freestream() -> vec4f { // primitive
  return vec4f(1.0, P.minf * cos(P.alpha), P.minf * sin(P.alpha), 1.0 / P.gamma);
}

fn fluxPhys(W: vec4f, ax: u32) -> vec4f {
  let E = W.w / (P.gamma - 1.0) + 0.5 * W.x * (W.y * W.y + W.z * W.z);
  var un: f32;
  if (ax == 0u) { un = W.y; } else { un = W.z; }
  var F = vec4f(W.x * un, W.x * un * W.y, W.x * un * W.z, un * (E + W.w));
  if (ax == 0u) { F.y += W.w; } else { F.z += W.w; }
  return F;
}

// HLLC flux for primitive states L, R across a face with normal along axis ax.
fn hllc(L: vec4f, R: vec4f, ax: u32) -> vec4f {
  var unL: f32;
  var unR: f32;
  if (ax == 0u) { unL = L.y; unR = R.y; } else { unL = L.z; unR = R.z; }
  let g = P.gamma;
  let aL = sqrt(g * L.w / L.x);
  let aR = sqrt(g * R.w / R.x);
  let sL = min(unL - aL, unR - aR);
  let sR = max(unL + aL, unR + aR);
  let FL = fluxPhys(L, ax);
  let FR = fluxPhys(R, ax);
  if (sL >= 0.0) { return FL; }
  if (sR <= 0.0) { return FR; }
  let dL = L.x * (sL - unL);
  let dR = R.x * (sR - unR);
  let sStar = (R.w - L.w + unL * dL - unR * dR) / (dL - dR);
  let EL = L.w / (g - 1.0) + 0.5 * L.x * (L.y * L.y + L.z * L.z);
  let ER = R.w / (g - 1.0) + 0.5 * R.x * (R.y * R.y + R.z * R.z);
  let UL = vec4f(L.x, L.x * L.y, L.x * L.z, EL);
  let UR = vec4f(R.x, R.x * R.y, R.x * R.z, ER);
  var F: vec4f;
  if (sStar >= 0.0) {
    let fac = dL / (sL - sStar);
    let en = EL / L.x + (sStar - unL) * (sStar + L.w / dL);
    var Us = vec4f(fac, 0.0, 0.0, fac * en);
    if (ax == 0u) { Us.y = fac * sStar; Us.z = fac * L.z; }
    else { Us.y = fac * L.y; Us.z = fac * sStar; }
    F = FL + sL * (Us - UL);
  } else {
    let fac = dR / (sR - sStar);
    let en = ER / R.x + (sStar - unR) * (sStar + R.w / dR);
    var Us = vec4f(fac, 0.0, 0.0, fac * en);
    if (ax == 0u) { Us.y = fac * sStar; Us.z = fac * R.z; }
    else { Us.y = fac * R.y; Us.z = fac * sStar; }
    F = FR + sR * (Us - UR);
  }
  // low-Mach damping: HLLC preserves contacts exactly, so odd-even
  // pressure-velocity noise ("dithering") is never damped on near-stagnant
  // faces; blend toward the dissipative HLL flux there (no effect M >= 0.3)
  let mFace = max(abs(unL), abs(unR)) / max(0.5 * (aL + aR), 1e-9);
  let w = clamp(mFace / 0.3, 0.0, 1.0);
  if (w < 1.0) {
    let Fhll = (sR * FL - sL * FR + sL * sR * (UR - UL)) / (sR - sL);
    F = mix(Fhll, F, w);
  }
  return F;
}

fn minmod(a: vec4f, b: vec4f) -> vec4f {
  let s = sign(a);
  return s * max(vec4f(0.0), min(abs(a), s * b));
}

// Wall force: staircase-face quadrature of the adjacent fluid static
// pressure (zero-order wall extrapolation). With true-normal ghosts the
// face flux carries convective slip terms, and an axis-mirrored star
// pressure would turn the (physical) tangential slip into spurious ram
// pressure on every staircase step - plain cell pressure is consistent.
fn wallP(W0: vec4f, ax: u32) -> f32 {
  return W0.w;
}

// 1D characteristic far-field along the sweep axis (Riemann invariants).
// Wi = boundary-adjacent interior primitives; sgn = outward normal sign.
// Subsonic boundaries absorb outgoing waves instead of reflecting them
// (hard freestream Dirichlet acted like wind-tunnel walls ~1.6 chords away).
fn farfield(Wi: vec4f, sgn: f32) -> vec4f {
  let g = P.gamma;
  let Wf = freestream();
  var uni: f32;
  var unf: f32;
  var uti: f32;
  var utf: f32;
  if (P.axis == 0u) {
    uni = sgn * Wi.y; unf = sgn * Wf.y; uti = Wi.z; utf = Wf.z;
  } else {
    uni = sgn * Wi.z; unf = sgn * Wf.z; uti = Wi.y; utf = Wf.y;
  }
  let ai = sqrt(g * Wi.w / Wi.x);
  if (uni >= ai) { return Wi; }        // supersonic outflow: extrapolate
  if (unf <= -1.0) { return Wf; }      // supersonic inflow: freestream (a_inf = 1)
  let Rp = uni + 2.0 * ai / (g - 1.0); // outgoing invariant (interior)
  let Rm = unf - 2.0 / (g - 1.0);      // incoming invariant (freestream)
  let unb = 0.5 * (Rp + Rm);
  let ab = max(0.25 * (g - 1.0) * (Rp - Rm), 0.02);
  var s: f32;
  var ut: f32;
  if (unb > 0.0) { // outflow: entropy & tangential velocity advect from inside
    s = Wi.w / pow(Wi.x, g);
    ut = uti;
  } else {         // inflow: from freestream
    s = Wf.w / pow(Wf.x, g);
    ut = utf;
  }
  let rho = pow(ab * ab / (g * s), 1.0 / (g - 1.0));
  let p = rho * ab * ab / g;
  if (P.axis == 0u) { return vec4f(rho, sgn * unb, ut, p); }
  return vec4f(rho, ut, sgn * unb, p);
}

// Sample primitive state at offset along sweep axis; flags solid/ghost cells.
// W0: querying (fluid) cell's primitives, used for solid mirroring.
fn sampleW(x: i32, y: i32, off: i32, W0: vec4f, isGhost: ptr<function, bool>) -> vec4f {
  var px = x;
  var py = y;
  if (P.axis == 0u) { px += off; } else { py += off; }
  *isGhost = false;
  // domain edges: characteristic far-field from the boundary-adjacent cell
  // (px only leaves range during x sweeps, py only during y sweeps)
  if (px < 0) { *isGhost = true; return farfield(prim(Uin[u32(y) * P.nx]), -1.0); }
  if (px >= i32(P.nx)) { *isGhost = true; return farfield(prim(Uin[u32(y) * P.nx + (P.nx - 1u)]), 1.0); }
  if (py < 0) { *isGhost = true; return farfield(prim(Uin[u32(x)]), -1.0); }
  if (py >= i32(P.ny)) { *isGhost = true; return farfield(prim(Uin[(P.ny - 1u) * P.nx + u32(x)]), 1.0); }
  let idx = u32(py) * P.nx + u32(px);
  let sv = solid[idx];
  if (sv != 0u) {
    *isGhost = true;
    var Wm = W0; // slip-wall ghost of the querying cell
    if (sv >= 2u) {
      // boundary cell carries the true outline normal (see rasterize):
      // reflect velocity about the actual surface tangent instead of the
      // sweep axis - the staircase mirror weakens the Kutta condition
      let th = f32(sv - 2u) / 1019.0 * 6.28318531 - 3.14159265;
      let n = vec2f(cos(th), sin(th));
      let un = W0.y * n.x + W0.z * n.y;
      Wm.y = W0.y - 2.0 * un * n.x;
      Wm.z = W0.z - 2.0 * un * n.y;
    } else if (P.axis == 0u) {
      Wm.y = -W0.y;
    } else {
      Wm.z = -W0.z;
    }
    return Wm;
  }
  return prim(Uin[idx]);
}

@compute @workgroup_size(16, 16)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.nx || gid.y >= P.ny) { return; }
  Uout[gid.y * P.nx + gid.x] = cons(freestream());
  // seed macro texture so the first rendered frame is sane
  textureStore(macroTex, vec2i(i32(gid.x), i32(gid.y)),
    vec4f(cos(P.alpha), sin(P.alpha), 1.0, 0.0));
}

@compute @workgroup_size(16, 16)
fn sweep(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (gid.x >= P.nx || gid.y >= P.ny) { return; }
  let idx = gid.y * P.nx + gid.x;

  if (solid[idx] != 0u) {
    Uout[idx] = Uin[idx];
    if (P.writeMacro == 1u) {
      textureStore(macroTex, vec2i(x, y), vec4f(0.0, 0.0, 1.0, 0.0));
    }
    return;
  }

  let W0 = prim(Uin[idx]);
  var gm2: bool;
  var gm1: bool;
  var gp1: bool;
  var gp2: bool;
  let Wm2 = sampleW(x, y, -2, W0, &gm2);
  let Wm1 = sampleW(x, y, -1, W0, &gm1);
  let Wp1 = sampleW(x, y, 1, W0, &gp1);
  let Wp2 = sampleW(x, y, 2, W0, &gp2);

  // slopes (zeroed when stencil touches ghost/solid cells -> first order there)
  var sm1 = vec4f(0.0);
  var s0 = vec4f(0.0);
  var sp1 = vec4f(0.0);
  if (!gm2 && !gm1) { sm1 = minmod(Wm1 - Wm2, W0 - Wm1); }
  if (!gm1 && !gp1) { s0 = minmod(W0 - Wm1, Wp1 - W0); }
  if (!gp1 && !gp2) { sp1 = minmod(Wp1 - W0, Wp2 - Wp1); }

  // face states
  let Lfl = Wm1 + 0.5 * sm1; // left face: left state
  let Lfr = W0 - 0.5 * s0;   // left face: right state
  let Rfl = W0 + 0.5 * s0;   // right face: left state
  let Rfr = Wp1 - 0.5 * sp1; // right face: right state

  let FL = hllc(Lfl, Lfr, P.axis);
  let FR = hllc(Rfl, Rfr, P.axis);

  var U1 = Uin[idx] - P.dtdx * (FR - FL);
  // scrub non-finite cells (extreme transients, e.g. live Mach scrubbing):
  // one poisoned cell otherwise NaN-floods the whole domain. Recover gently
  // by freezing the previous state - injecting freestream inside a confined
  // supersonic jet (ducts) detonates locally; freestream only if that too
  // is poisoned.
  let ok = abs(U1.x) < BIG && abs(U1.y) < BIG && abs(U1.z) < BIG && abs(U1.w) < BIG;
  if (!ok) {
    U1 = Uin[idx];
    let okp = abs(U1.x) < BIG && abs(U1.y) < BIG && abs(U1.z) < BIG && abs(U1.w) < BIG;
    if (!okp) { U1 = cons(freestream()); }
  }
  U1 = cons(prim(U1)); // positivity clamp
  Uout[idx] = U1;

  // --- wall force accumulation (pressure from HLLC star state at wall faces) ---
  if (P.axis == 0u) {
    var sxp = false;
    var sxm = false;
    if (x + 1 < i32(P.nx)) { sxp = solid[idx + 1u] != 0u; }
    if (x - 1 >= 0) { sxm = solid[idx - 1u] != 0u; }
    if (sxp || sxm) {
      var fx = 0.0;
      var tz = 0.0;
      let pw = wallP(W0, 0u);
      if (sxp) { // body at +x
        fx += pw;
        tz += -(f32(y) + 0.5 - P.cmy) * pw;
      }
      if (sxm) {
        fx -= pw;
        tz += (f32(y) + 0.5 - P.cmy) * pw;
      }
      atomicAdd(&forceAcc[0], i32(round(fx * P.fscale)));
      atomicAdd(&forceAcc[2], i32(round(tz * P.fscale * 0.01)));
    }
  } else {
    var syp = false;
    var sym = false;
    if (y + 1 < i32(P.ny)) { syp = solid[idx + P.nx] != 0u; }
    if (y - 1 >= 0) { sym = solid[idx - P.nx] != 0u; }
    if (syp || sym) {
      var fy = 0.0;
      var tz = 0.0;
      let pw = wallP(W0, 1u);
      if (syp) {
        fy += pw;
        tz += (f32(x) + 0.5 - P.cmx) * pw;
      }
      if (sym) {
        fy -= pw;
        tz -= (f32(x) + 0.5 - P.cmx) * pw;
      }
      atomicAdd(&forceAcc[1], i32(round(fy * P.fscale)));
      atomicAdd(&forceAcc[2], i32(round(tz * P.fscale * 0.01)));
    }
  }

  if (P.writeMacro == 1u) {
    let W1 = prim(U1);
    let q = 0.5 * P.minf * P.minf;
    let cp = (W1.w - 1.0 / P.gamma) / max(q, 1e-6);
    let um = max(P.minf, 1e-3);
    textureStore(macroTex, vec2i(x, y), vec4f(W1.y / um, W1.z / um, W1.x, cp));
  }
}
