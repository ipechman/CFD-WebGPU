// Sod shock tube: JS mirror of shaders/euler.wgsl (MUSCL + minmod + HLLC)
// against the exact Riemann solution. Validates the flux math used on GPU.

const G = 1.4;

// ---- mirrors of the WGSL functions (keep in sync with shaders/euler.wgsl) ----
function prim(U) {
  const rho = Math.max(U[0], 1e-6);
  const u = U[1] / rho, v = U[2] / rho;
  const p = Math.max((G - 1) * (U[3] - 0.5 * rho * (u * u + v * v)), 1e-7);
  return [rho, u, v, p];
}
function cons(W) {
  const E = W[3] / (G - 1) + 0.5 * W[0] * (W[1] * W[1] + W[2] * W[2]);
  return [W[0], W[0] * W[1], W[0] * W[2], E];
}
function fluxPhys(W) { // axis 0
  const E = W[3] / (G - 1) + 0.5 * W[0] * (W[1] * W[1] + W[2] * W[2]);
  const un = W[1];
  return [W[0] * un, W[0] * un * W[1] + W[3], W[0] * un * W[2], un * (E + W[3])];
}
function hllc(L, R) { // axis 0
  const unL = L[1], unR = R[1];
  const aL = Math.sqrt(G * L[3] / L[0]), aR = Math.sqrt(G * R[3] / R[0]);
  const sL = Math.min(unL - aL, unR - aR), sR = Math.max(unL + aL, unR + aR);
  const FL = fluxPhys(L), FR = fluxPhys(R);
  if (sL >= 0) return FL;
  if (sR <= 0) return FR;
  const dL = L[0] * (sL - unL), dR = R[0] * (sR - unR);
  const sStar = (R[3] - L[3] + unL * dL - unR * dR) / (dL - dR);
  const EL = L[3] / (G - 1) + 0.5 * L[0] * (L[1] ** 2 + L[2] ** 2);
  const ER = R[3] / (G - 1) + 0.5 * R[0] * (R[1] ** 2 + R[2] ** 2);
  if (sStar >= 0) {
    const fac = dL / (sL - sStar);
    const en = EL / L[0] + (sStar - unL) * (sStar + L[3] / dL);
    const Us = [fac, fac * sStar, fac * L[2], fac * en];
    const UL = [L[0], L[0] * L[1], L[0] * L[2], EL];
    return FL.map((f, i) => f + sL * (Us[i] - UL[i]));
  }
  const fac = dR / (sR - sStar);
  const en = ER / R[0] + (sStar - unR) * (sStar + R[3] / dR);
  const Us = [fac, fac * sStar, fac * R[2], fac * en];
  const UR = [R[0], R[0] * R[1], R[0] * R[2], ER];
  return FR.map((f, i) => f + sR * (Us[i] - UR[i]));
}
const mm = (a, b) => (Math.sign(a) !== Math.sign(b)) ? 0 : Math.sign(a) * Math.min(Math.abs(a), Math.abs(b));
function minmod(A, B) { return A.map((a, i) => mm(a, B[i])); }

// ---- 1D MUSCL-HLLC march (same scheme as the GPU sweep) ----
function runSod(N) {
  const dx = 1 / N;
  let U = [];
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * dx;
    U.push(cons(x < 0.5 ? [1, 0, 0, 1] : [0.125, 0, 0, 0.1]));
  }
  const getW = (arr, i) => prim(arr[Math.max(0, Math.min(N - 1, i))]);
  let t = 0;
  while (t < 0.2) {
    let smax = 0;
    for (let i = 0; i < N; i++) {
      const w = prim(U[i]);
      smax = Math.max(smax, Math.abs(w[1]) + Math.sqrt(G * w[3] / w[0]));
    }
    const dt = Math.min(0.45 * dx / smax, 0.2 - t);
    const Un = [];
    for (let i = 0; i < N; i++) {
      const Wm2 = getW(U, i - 2), Wm1 = getW(U, i - 1), W0 = getW(U, i), Wp1 = getW(U, i + 1), Wp2 = getW(U, i + 2);
      const sub = (A, B) => A.map((a, k) => a - B[k]);
      const sm1 = minmod(sub(Wm1, Wm2), sub(W0, Wm1));
      const s0 = minmod(sub(W0, Wm1), sub(Wp1, W0));
      const sp1 = minmod(sub(Wp1, W0), sub(Wp2, Wp1));
      const ax = (A, S, f) => A.map((a, k) => a + f * S[k]);
      const FL = hllc(ax(Wm1, sm1, 0.5), ax(W0, s0, -0.5));
      const FR = hllc(ax(W0, s0, 0.5), ax(Wp1, sp1, -0.5));
      Un.push(U[i].map((u, k) => u - dt / dx * (FR[k] - FL[k])));
    }
    U = Un.map(u => cons(prim(u)));
    t += dt;
  }
  return U.map(prim);
}

// ---- exact Riemann solver (Toro) ----
function exactRiemann(WL, WR, x, t) {
  const [rL, uL, , pL] = WL, [rR, uR, , pR] = WR;
  const aL = Math.sqrt(G * pL / rL), aR = Math.sqrt(G * pR / rR);
  const AL = 2 / ((G + 1) * rL), BL = (G - 1) / (G + 1) * pL;
  const AR = 2 / ((G + 1) * rR), BR = (G - 1) / (G + 1) * pR;
  const fK = (p, pK, aK, AK, BK) => p > pK
    ? (p - pK) * Math.sqrt(AK / (p + BK))
    : (2 * aK / (G - 1)) * (Math.pow(p / pK, (G - 1) / (2 * G)) - 1);
  const dfK = (p, pK, rK, aK, AK, BK) => p > pK
    ? Math.sqrt(AK / (BK + p)) * (1 - (p - pK) / (2 * (BK + p)))
    : Math.pow(p / pK, -(G + 1) / (2 * G)) / (rK * aK);
  let p = Math.max(1e-6, 0.5 * (pL + pR));
  for (let it = 0; it < 60; it++) {
    const f = fK(p, pL, aL, AL, BL) + fK(p, pR, aR, AR, BR) + (uR - uL);
    const df = dfK(p, pL, rL, aL, AL, BL) + dfK(p, pR, rR, aR, AR, BR);
    const pn = Math.max(1e-8, p - f / df);
    if (Math.abs(pn - p) / p < 1e-12) { p = pn; break; }
    p = pn;
  }
  const u = 0.5 * (uL + uR) + 0.5 * (fK(p, pR, aR, AR, BR) - fK(p, pL, aL, AL, BL));
  const s = x / t;
  if (s < u) { // left of contact
    if (p > pL) { // left shock
      const sl = uL - aL * Math.sqrt((G + 1) / (2 * G) * p / pL + (G - 1) / (2 * G));
      if (s < sl) return [rL, uL, 0, pL];
      const r = rL * ((p / pL + (G - 1) / (G + 1)) / ((G - 1) / (G + 1) * p / pL + 1));
      return [r, u, 0, p];
    }
    const shl = uL - aL;
    if (s < shl) return [rL, uL, 0, pL];
    const aStar = aL * Math.pow(p / pL, (G - 1) / (2 * G));
    const stl = u - aStar;
    if (s > stl) return [rL * Math.pow(p / pL, 1 / G), u, 0, p];
    const af = (2 / (G + 1)) * (aL + (G - 1) / 2 * (uL - s));
    const uf = (2 / (G + 1)) * (aL + (G - 1) / 2 * uL + s);
    return [rL * Math.pow(af / aL, 2 / (G - 1)), uf, 0, pL * Math.pow(af / aL, 2 * G / (G - 1))];
  }
  if (p > pR) { // right shock
    const sr = uR + aR * Math.sqrt((G + 1) / (2 * G) * p / pR + (G - 1) / (2 * G));
    if (s > sr) return [rR, uR, 0, pR];
    const r = rR * ((p / pR + (G - 1) / (G + 1)) / ((G - 1) / (G + 1) * p / pR + 1));
    return [r, u, 0, p];
  }
  const shr = uR + aR;
  if (s > shr) return [rR, uR, 0, pR];
  const aStar = aR * Math.pow(p / pR, (G - 1) / (2 * G));
  const str = u + aStar;
  if (s < str) return [rR * Math.pow(p / pR, 1 / G), u, 0, p];
  const af = (2 / (G + 1)) * (aR - (G - 1) / 2 * (uR - s));
  const uf = (2 / (G + 1)) * (-aR + (G - 1) / 2 * uR + s);
  return [rR * Math.pow(af / aR, 2 / (G - 1)), uf, 0, pR * Math.pow(af / aR, 2 * G / (G - 1))];
}

// ---- run & compare ----
export function test() {
  const N = 400;
  const sol = runSod(N);
  let errR = 0, errP = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N;
    const ex = exactRiemann([1, 0, 0, 1], [0.125, 0, 0, 0.1], x - 0.5, 0.2);
    errR += Math.abs(sol[i][0] - ex[0]) / N;
    errP += Math.abs(sol[i][3] - ex[3]) / N;
  }
  const checks = [
    ['Sod density L1 error < 0.012', errR < 0.012, errR.toFixed(5)],
    ['Sod pressure L1 error < 0.012', errP < 0.012, errP.toFixed(5)],
  ];
  // sanity on star values via exact solver
  const star = exactRiemann([1, 0, 0, 1], [0.125, 0, 0, 0.1], 0.01, 0.2);
  checks.push(['exact p* ~ 0.30313', Math.abs(star[3] - 0.30313) < 0.0005, star[3].toFixed(5)]);
  checks.push(['exact u* ~ 0.92745', Math.abs(star[1] - 0.92745) < 0.0005, star[1].toFixed(5)]);
  return checks;
}
