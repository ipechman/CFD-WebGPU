// D2Q9 Lattice-Boltzmann (BGK + Smagorinsky LES), pull-scheme streaming with
// fused collision. Bounce-back solids, momentum-exchange force accumulation.
// Lattice units: dx = dt = 1, cs^2 = 1/3. Inflow speed P.uin (~0.1).
//
// NOTE: tests/lbm_tgv.mjs contains a JS mirror of feq/collision/streaming.
// Keep the math in sync.

struct Params {
  nx: u32,
  ny: u32,
  ntot: u32,
  iter: u32,
  tau: f32,
  uin: f32,
  alpha: f32,    // inflow angle, radians
  smag: f32,     // Smagorinsky Cs^2 (~0.027)
  ramp: f32,     // inflow ramp 0..1
  fscale: f32,   // fixed-point scale for force atomics
  cmx: f32,      // moment center (cells)
  cmy: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fin: array<f32>;
@group(0) @binding(2) var<storage, read_write> fout: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> forceAcc: array<atomic<i32>>; // Fx, Fy, Tz
@group(0) @binding(5) var macroTex: texture_storage_2d<rgba16float, write>;
// Bouzidi link fractions: per fluid cell, 8 bytes (k=1..8) packed in 2 u32;
// byte b!=0 encodes q=(b-1)/254 = fraction of the link to the true outline
@group(0) @binding(6) var<storage, read> wallq: array<u32>;

var<private> E: array<vec2i, 9> = array<vec2i, 9>(
  vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0), vec2i(0, -1),
  vec2i(1, 1), vec2i(-1, 1), vec2i(-1, -1), vec2i(1, -1));
var<private> W: array<f32, 9> = array<f32, 9>(
  4.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0, 1.0 / 9.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);
var<private> OPP: array<u32, 9> = array<u32, 9>(0u, 3u, 4u, 1u, 2u, 7u, 8u, 5u, 6u);

fn feq(k: u32, rho: f32, u: vec2f) -> f32 {
  let eu = dot(vec2f(E[k]), u);
  return W[k] * rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * dot(u, u));
}

fn inflowVel() -> vec2f {
  return P.uin * P.ramp * vec2f(cos(P.alpha), sin(P.alpha));
}

@compute @workgroup_size(16, 16)
fn init(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.nx || gid.y >= P.ny) { return; }
  let idx = gid.y * P.nx + gid.x;
  let u = inflowVel();
  for (var k = 0u; k < 9u; k++) {
    fout[k * P.ntot + idx] = feq(k, 1.0, u);
  }
  // seed macro texture so the first rendered frame is sane
  textureStore(macroTex, vec2i(i32(gid.x), i32(gid.y)),
    vec4f(cos(P.alpha), sin(P.alpha), 1.0, 0.0));
}

@compute @workgroup_size(16, 16)
fn step_lbm(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= P.nx || y >= P.ny) { return; }
  let idx = y * P.nx + x;
  let N = P.ntot;

  if (solid[idx] != 0u) {
    for (var k = 0u; k < 9u; k++) { fout[k * N + idx] = fin[k * N + idx]; }
    textureStore(macroTex, vec2i(i32(x), i32(y)), vec4f(0.0, 0.0, 1.0, 0.0));
    return;
  }

  let uIn = inflowVel();
  var f: array<f32, 9>;
  var dFx = 0.0;
  var dFy = 0.0;
  var dTz = 0.0;

  // --- streaming (pull) with boundaries ---
  for (var k = 0u; k < 9u; k++) {
    let ek = E[k];
    let sx = i32(x) - ek.x;
    let sy = i32(y) - ek.y;
    if (sx < 0 || sy < 0 || sy >= i32(P.ny)) {
      f[k] = feq(k, 1.0, uIn);                 // inflow / far-field equilibrium
    } else if (sx >= i32(P.nx)) {
      f[k] = fin[k * N + idx - 1u];             // outflow: spatial extrapolation
    } else {
      let sidx = u32(sy) * P.nx + u32(sx);
      if (solid[sidx] != 0u) {
        // Bouzidi interpolated bounce-back: the wall for population k lies
        // along OPP[k]; q is the link fraction to the true outline there
        let fbb = fin[OPP[k] * N + idx];        // post-collision f_opp at this node
        let d = OPP[k];
        let w = wallq[2u * idx + ((d - 1u) >> 2u)];
        let b = (w >> (8u * ((d - 1u) & 3u))) & 0xffu;
        var q = 0.5;
        if (b != 0u) { q = f32(b - 1u) / 254.0; }
        var fk = fbb;                            // q = 0.5 reduces to halfway BB
        if (q < 0.5) {
          // needs f_opp one node further from the wall (along +e_k)
          let n2x = i32(x) + ek.x;
          let n2y = i32(y) + ek.y;
          var f2 = fbb;
          if (n2x >= 0 && n2x < i32(P.nx) && n2y >= 0 && n2y < i32(P.ny)) {
            let nidx = u32(n2y) * P.nx + u32(n2x);
            if (solid[nidx] == 0u) { f2 = fin[OPP[k] * N + nidx]; }
          }
          fk = 2.0 * q * fbb + (1.0 - 2.0 * q) * f2;
        } else if (q > 0.5) {
          fk = fbb / (2.0 * q) + (1.0 - 1.0 / (2.0 * q)) * fin[k * N + idx];
        }
        f[k] = fk;
        // momentum to body from this link: -e_k * (incoming + outgoing)
        let e = vec2f(ek);
        let px = -e.x * (fbb + fk);
        let py = -e.y * (fbb + fk);
        dFx += px;
        dFy += py;
        // wall point ~ q of the way to the solid neighbor
        let rx = f32(x) + 0.5 - q * e.x - P.cmx;
        let ry = f32(y) + 0.5 - q * e.y - P.cmy;
        dTz += rx * py - ry * px;
      } else {
        f[k] = fin[k * N + sidx];
      }
    }
  }

  // --- macroscopic ---
  var rho = 0.0;
  var mom = vec2f(0.0);
  for (var k = 0u; k < 9u; k++) {
    rho += f[k];
    mom += vec2f(E[k]) * f[k];
  }
  rho = max(rho, 1e-6);
  var u = mom / rho;
  // clamp velocity for stability in pathological cells
  let umax = 0.35;
  let uu = length(u);
  if (uu > umax) { u *= umax / uu; }

  // --- Smagorinsky subgrid viscosity from non-equilibrium stress ---
  var pxx = 0.0; var pyy = 0.0; var pxy = 0.0;
  var fe: array<f32, 9>;
  for (var k = 0u; k < 9u; k++) {
    fe[k] = feq(k, rho, u);
    let fneq = f[k] - fe[k];
    let e = vec2f(E[k]);
    pxx += e.x * e.x * fneq;
    pyy += e.y * e.y * fneq;
    pxy += e.x * e.y * fneq;
  }
  let Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  let tauEff = 0.5 * (P.tau + sqrt(P.tau * P.tau + 18.0 * 1.41421356 * P.smag * Q / rho));
  let omega = 1.0 / tauEff;

  // --- collide & write ---
  if (x == 0u) {
    // inlet: impose equilibrium at freestream
    for (var k = 0u; k < 9u; k++) { fout[k * N + idx] = feq(k, 1.0, uIn); }
  } else {
    // absorbing sponge ahead of the outlet: relax density to ambient while
    // keeping the local velocity, so vortices and pressure waves exit
    // instead of reflecting back upstream at the shedding frequency
    let edge = f32(P.nx - 1u - x);
    let sw = max(0.0, 1.0 - edge / (f32(P.nx) / 16.0));
    let sig = 0.25 * sw * sw;
    for (var k = 0u; k < 9u; k++) {
      var fp = f[k] - omega * (f[k] - fe[k]);
      if (sig > 0.0) { fp += sig * (feq(k, 1.0, u) - fp); }
      fout[k * N + idx] = fp;
    }
  }

  // --- force accumulation (fixed point) ---
  if (dFx != 0.0 || dFy != 0.0) {
    atomicAdd(&forceAcc[0], i32(round(dFx * P.fscale)));
    atomicAdd(&forceAcc[1], i32(round(dFy * P.fscale)));
    atomicAdd(&forceAcc[2], i32(round(dTz * P.fscale * 0.01))); // torque scaled down (larger magnitude)
  }

  // --- macro output: (u/U, v/U, density, Cp) - velocity normalized by inflow speed ---
  let uref = P.uin * max(P.ramp, 0.01);
  let qdyn = 0.5 * uref * uref;
  let cpv = (rho - 1.0) / 3.0 / qdyn;
  textureStore(macroTex, vec2i(i32(x), i32(y)), vec4f(u.x / uref, u.y / uref, rho, cpv));
}
