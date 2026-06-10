// 2D compressible Euler, finite volume, MUSCL (minmod) + HLLC, dimensional
// splitting (one sweep per dispatch). Cartesian immersed boundary: solid cells
// mirror the adjacent fluid state (slip wall); wall pressure comes out of the
// HLLC star state and is accumulated for force coefficients.
//
// Nondimensionalization: rho_inf = 1, a_inf = 1  =>  p_inf = 1/gamma, U_inf = M.
//
// NOTE: tests/hllc_mirror.mjs contains a JS mirror of prim/cons/flux/hllc.
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
  pad0: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> Uin: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> Uout: array<vec4f>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> forceAcc: array<atomic<i32>>; // Fx, Fy, Tz
@group(0) @binding(5) var macroTex: texture_storage_2d<rgba16float, write>;

const RHO_MIN: f32 = 1e-6;
const P_MIN: f32 = 1e-7;

fn prim(U: vec4f) -> vec4f {
  let rho = max(U.x, RHO_MIN);
  let u = U.y / rho;
  let v = U.z / rho;
  let p = max((P.gamma - 1.0) * (U.w - 0.5 * rho * (u * u + v * v)), P_MIN);
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
  var unL: f32; var unR: f32;
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
  if (sStar >= 0.0) {
    let fac = dL / (sL - sStar);
    let en = EL / L.x + (sStar - unL) * (sStar + L.w / dL);
    var Us = vec4f(fac, 0.0, 0.0, fac * en);
    if (ax == 0u) { Us.y = fac * sStar; Us.z = fac * L.z; }
    else { Us.y = fac * L.y; Us.z = fac * sStar; }
    return FL + sL * (Us - vec4f(L.x, L.x * L.y, L.x * L.z, EL));
  } else {
    let fac = dR / (sR - sStar);
    let en = ER / R.x + (sStar - unR) * (sStar + R.w / dR);
    var Us = vec4f(fac, 0.0, 0.0, fac * en);
    if (ax == 0u) { Us.y = fac * sStar; Us.z = fac * R.z; }
    else { Us.y = fac * R.y; Us.z = fac * sStar; }
    return FR + sR * (Us - vec4f(R.x, R.x * R.y, R.x * R.z, ER));
  }
}

fn minmod(a: vec4f, b: vec4f) -> vec4f {
  let s = sign(a);
  return s * max(vec4f(0.0), min(abs(a), s * b));
}

// Sample primitive state at offset along sweep axis; flags solid/ghost cells.
// W0: querying (fluid) cell's primitives, used for solid mirroring.
fn sampleW(x: i32, y: i32, off: i32, W0: vec4f, isGhost: ptr<function, bool>) -> vec4f {
  var px = x; var py = y;
  if (P.axis == 0u) { px += off; } else { py += off; }
  *isGhost = false;
  if (px < 0 || py < 0 || py >= i32(P.ny)) { *isGhost = true; return freestream(); }
  if (px >= i32(P.nx)) {
    *isGhost = true;
    return prim(Uin[u32(py) * P.nx + u32(P.nx - 1u)]); // outflow: zero gradient
  }
  let idx = u32(py) * P.nx + u32(px);
  if (solid[idx] == 1u) {
    *isGhost = true;
    var Wm = W0; // slip-wall mirror of the querying cell
    if (P.axis == 0u) { Wm.y = -W0.y; } else { Wm.z = -W0.z; }
    return Wm;
  }
  return prim(Uin[idx]);
}

@compute @workgroup_size(16, 16)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.nx || gid.y >= P.ny) { return; }
  Uout[gid.y * P.nx + gid.x] = cons(freestream());
}

@compute @workgroup_size(16, 16)
fn sweep(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (gid.x >= P.nx || gid.y >= P.ny) { return; }
  let idx = gid.y * P.nx + gid.x;

  if (solid[idx] == 1u) {
    Uout[idx] = Uin[idx];
    if (P.writeMacro == 1u) {
      textureStore(macroTex, vec2i(x, y), vec4f(0.0, 0.0, 1.0, 0.0));
    }
    return;
  }

  let W0 = prim(Uin[idx]);
  var gm2: bool; var gm1: bool; var gp1: bool; var gp2: bool;
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
  U1 = cons(prim(U1)); // positivity clamp
  Uout[idx] = U1;

  // --- wall force accumulation (pressure from HLLC star state at wall faces) ---
  var sxp = false; var sxm = false;
  if (P.axis == 0u) {
    if (x + 1 < i32(P.nx)) { sxp = solid[idx + 1u] == 1u; }
    if (x - 1 >= 0) { sxm = solid[idx - 1u] == 1u; }
    if (sxp || sxm) {
      var fx = 0.0; var tz = 0.0;
      if (sxp) { // body at +x: wall pressure = x-momentum flux component
        fx += FR.y;
        tz += (f32(x) + 1.0 - P.cmx) * 0.0 - (f32(y) + 0.5 - P.cmy) * FR.y;
      }
      if (sxm) {
        fx -= FL.y;
        tz -= (f32(x) - P.cmx) * 0.0 - (f32(y) + 0.5 - P.cmy) * FL.y;
      }
      atomicAdd(&forceAcc[0], i32(round(fx * P.fscale)));
      atomicAdd(&forceAcc[2], i32(round(tz * P.fscale * 0.01)));
    }
  } else {
    var syp = false; var sym = false;
    if (y + 1 < i32(P.ny)) { syp = solid[idx + P.nx] == 1u; }
    if (y - 1 >= 0) { sym = solid[idx - P.nx] == 1u; }
    if (syp || sym) {
      var fy = 0.0; var tz = 0.0;
      if (syp) {
        fy += FR.z;
        tz += (f32(x) + 0.5 - P.cmx) * FR.z;
      }
      if (sym) {
        fy -= FL.z;
        tz -= (f32(x) + 0.5 - P.cmx) * FL.z;
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
