// Hess-Smith panel method (constant-strength sources + single vortex, Kutta condition).
// Incompressible, inviscid. Reference: Moran, "Theoretical and Computational Aerodynamics".
// Input coords: closed Selig-order polygon (TE -> upper -> LE -> lower -> TE), CCW.

import { resample } from './airfoils.js';

const TWO_PI = 2 * Math.PI;

/**
 * Solve flow about airfoil at alpha (deg).
 * Returns { cl, cm, cdCheck, cp: [[x/c, Cp]...], gamma }
 * cdCheck ~ 0 is a self-consistency (d'Alembert) check.
 */
export function solvePanel(coords, alphaDeg, nPerSurf = 70) {
  const pts = resample(coords, nPerSurf);
  const N = pts.length - 1; // panels
  const a = alphaDeg * Math.PI / 180;
  const Vinf = [Math.cos(a), Math.sin(a)];

  const xm = new Float64Array(N), ym = new Float64Array(N);
  const ct = new Float64Array(N), st = new Float64Array(N), len = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    xm[i] = (x1 + x2) / 2; ym[i] = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    len[i] = Math.hypot(dx, dy);
    ct[i] = dx / len[i]; st[i] = dy / len[i];
  }
  // Outward normal (CCW polygon): n = (st, -ct)

  // Influence of panel j (unit source, unit CCW vortex) at point (x,y) -> global velocities
  function influence(j, x, y, self) {
    if (self) {
      // local: source (0, -1/2) on fluid side (local -y); vortex (+1/2, 0)
      const us = 0 * ct[j] - (-0.5) * st[j], vs = 0 * st[j] + (-0.5) * ct[j];
      const uv = 0.5 * ct[j] - 0 * st[j], vv = 0.5 * st[j] + 0 * ct[j];
      return [us, vs, uv, vv];
    }
    const [x1, y1] = pts[j];
    const xt = x - x1, yt = y - y1;
    const xl = xt * ct[j] + yt * st[j];
    const yl = -xt * st[j] + yt * ct[j];
    const l = len[j];
    const r12 = xl * xl + yl * yl, r22 = (xl - l) * (xl - l) + yl * yl;
    const lnr = 0.5 * Math.log(r12 / r22);
    const beta = Math.atan2(yl, xl - l) - Math.atan2(yl, xl);
    // local-frame velocities
    const usl = lnr / TWO_PI, vsl = beta / TWO_PI;       // unit source
    const uvl = -beta / TWO_PI, vvl = lnr / TWO_PI;      // unit CCW vortex
    return [
      usl * ct[j] - vsl * st[j], usl * st[j] + vsl * ct[j],
      uvl * ct[j] - vvl * st[j], uvl * st[j] + vvl * ct[j],
    ];
  }

  // Assemble (N+1) x (N+1) system
  const M = N + 1;
  const A = Array.from({ length: M }, () => new Float64Array(M));
  const b = new Float64Array(M);
  for (let i = 0; i < N; i++) {
    const nx = st[i], ny = -ct[i];
    let vortN = 0;
    for (let j = 0; j < N; j++) {
      const [us, vs, uv, vv] = influence(j, xm[i], ym[i], i === j);
      A[i][j] = us * nx + vs * ny;
      vortN += uv * nx + vv * ny;
    }
    A[i][N] = vortN;
    b[i] = -(Vinf[0] * nx + Vinf[1] * ny);
  }
  // Kutta: (V . t)_first + (V . t)_last = 0  (panels 0 and N-1 meet at TE)
  {
    let vortT = 0;
    for (let j = 0; j < N; j++) {
      const [us0, vs0, uv0, vv0] = influence(j, xm[0], ym[0], j === 0);
      const [us1, vs1, uv1, vv1] = influence(j, xm[N - 1], ym[N - 1], j === N - 1);
      A[N][j] = (us0 * ct[0] + vs0 * st[0]) + (us1 * ct[N - 1] + vs1 * st[N - 1]);
      vortT += (uv0 * ct[0] + vv0 * st[0]) + (uv1 * ct[N - 1] + vv1 * st[N - 1]);
    }
    A[N][N] = vortT;
    b[N] = -(Vinf[0] * (ct[0] + ct[N - 1]) + Vinf[1] * (st[0] + st[N - 1]));
  }

  const sol = gauss(A, b);
  const gamma = sol[N];

  // Tangential velocity & Cp at each control point
  const cp = [], vtArr = new Float64Array(N);
  let cfx = 0, cfy = 0, cm = 0;
  for (let i = 0; i < N; i++) {
    let u = Vinf[0], v = Vinf[1];
    for (let j = 0; j < N; j++) {
      const [us, vs, uv, vv] = influence(j, xm[i], ym[i], i === j);
      u += sol[j] * us + gamma * uv;
      v += sol[j] * vs + gamma * vv;
    }
    const vt = u * ct[i] + v * st[i];
    vtArr[i] = vt;
    const cpi = 1 - vt * vt;
    cp.push([xm[i], cpi, ym[i]]);
    const nx = st[i], ny = -ct[i];
    const dFx = -cpi * nx * len[i], dFy = -cpi * ny * len[i];
    cfx += dFx; cfy += dFy;
    cm -= (xm[i] - 0.25) * dFy - ym[i] * dFx; // nose-up positive (aero convention)
  }
  const cl = cfy * Math.cos(a) - cfx * Math.sin(a);
  const cdCheck = cfx * Math.cos(a) + cfy * Math.sin(a);
  return { cl, cm, cdCheck, cp, gamma, vt: vtArr, sigma: Array.from(sol.slice(0, N)) };
}

/** Lift curve over a range of alphas (deg). Returns [[alpha, cl]...]. */
export function liftCurve(coords, alphas, nPerSurf = 60) {
  return alphas.map(al => [al, solvePanel(coords, al, nPerSurf).cl]);
}

/** Velocity at arbitrary field points (for CPU flow visualization). */
export function makeFieldEvaluator(coords, alphaDeg, nPerSurf = 50) {
  const res = solvePanel(coords, alphaDeg, nPerSurf);
  const pts = resample(coords, nPerSurf);
  const N = pts.length - 1;
  const a = alphaDeg * Math.PI / 180;
  const Vinf = [Math.cos(a), Math.sin(a)];
  const ct = [], st = [], len = [];
  for (let i = 0; i < N; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dy);
    len.push(l); ct.push(dx / l); st.push(dy / l);
  }
  return {
    result: res,
    velocity(x, y) {
      let u = Vinf[0], v = Vinf[1];
      for (let j = 0; j < N; j++) {
        const xt = x - pts[j][0], yt = y - pts[j][1];
        const xl = xt * ct[j] + yt * st[j];
        const yl = -xt * st[j] + yt * ct[j];
        const l = len[j];
        const r12 = Math.max(1e-10, xl * xl + yl * yl);
        const r22 = Math.max(1e-10, (xl - l) * (xl - l) + yl * yl);
        const lnr = 0.5 * Math.log(r12 / r22);
        const beta = Math.atan2(yl, xl - l) - Math.atan2(yl, xl);
        const usl = lnr / TWO_PI, vsl = beta / TWO_PI;
        const uvl = -beta / TWO_PI, vvl = lnr / TWO_PI;
        const sg = res.gamma;
        u += sol2(res, j) * (usl * ct[j] - vsl * st[j]) + sg * (uvl * ct[j] - vvl * st[j]);
        v += sol2(res, j) * (usl * st[j] + vsl * ct[j]) + sg * (uvl * st[j] + vvl * ct[j]);
      }
      return [u, v];
    },
  };
  function sol2(r, j) { return r.sigma ? r.sigma[j] : 0; }
}

// Gaussian elimination with partial pivoting; returns solution, attaches sigma to caller via return
function gauss(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (piv !== col) { [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]]; }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c2 = col; c2 < n; c2++) A[r][c2] -= f * A[col][c2];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c2 = r + 1; c2 < n; c2++) s -= A[r][c2] * x[c2];
        x[r] = s / A[r][r];
  }
  return x;
}
