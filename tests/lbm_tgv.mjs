// Taylor-Green vortex decay: JS mirror of shaders/lbm.wgsl collision/streaming
// (BGK + Smagorinsky, pull scheme) on a periodic grid. The analytic solution
// decays as exp(-2 nu k^2 t); this validates the tau <-> viscosity mapping.

const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const SMAG = 0.027; // same as shader

function feq(k, rho, ux, uy) {
  const eu = EX[k] * ux + EY[k] * uy;
  return W[k] * rho * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * (ux * ux + uy * uy));
}

export function test() {
  const N = 64, tau = 0.8, nu = (tau - 0.5) / 3;
  const U0 = 0.02, k = 2 * Math.PI / N;
  const NT = N * N;
  let f = new Float64Array(9 * NT), g = new Float64Array(9 * NT);

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ux = -U0 * Math.cos(k * (x + 0.5)) * Math.sin(k * (y + 0.5));
    const uy = U0 * Math.sin(k * (x + 0.5)) * Math.cos(k * (y + 0.5));
    const rho = 1 - (3 * U0 * U0 / 4) * (Math.cos(2 * k * (x + 0.5)) + Math.cos(2 * k * (y + 0.5)));
    for (let q = 0; q < 9; q++) f[q * NT + y * N + x] = feq(q, rho, ux, uy);
  }

  const steps = 1500;
  for (let s = 0; s < steps; s++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const idx = y * N + x;
      const fl = new Array(9);
      for (let q = 0; q < 9; q++) { // pull streaming, periodic
        const sx = (x - EX[q] + N) % N, sy = (y - EY[q] + N) % N;
        fl[q] = f[q * NT + sy * N + sx];
      }
      let rho = 0, mx = 0, my = 0;
      for (let q = 0; q < 9; q++) { rho += fl[q]; mx += EX[q] * fl[q]; my += EY[q] * fl[q]; }
      const ux = mx / rho, uy = my / rho;
      // Smagorinsky (mirror of shader)
      let pxx = 0, pyy = 0, pxy = 0;
      const fe = new Array(9);
      for (let q = 0; q < 9; q++) {
        fe[q] = feq(q, rho, ux, uy);
        const fneq = fl[q] - fe[q];
        pxx += EX[q] * EX[q] * fneq; pyy += EY[q] * EY[q] * fneq; pxy += EX[q] * EY[q] * fneq;
      }
      const Q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
      const tauEff = 0.5 * (tau + Math.sqrt(tau * tau + 18 * Math.SQRT2 * SMAG * Q / rho));
      const om = 1 / tauEff;
      for (let q = 0; q < 9; q++) g[q * NT + idx] = fl[q] - om * (fl[q] - fe[q]);
    }
    [f, g] = [g, f];
  }

  // measure peak velocity
  let umax = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const idx = y * N + x;
    let rho = 0, mx = 0, my = 0;
    for (let q = 0; q < 9; q++) { const v = f[q * NT + idx]; rho += v; mx += EX[q] * v; my += EY[q] * v; }
    umax = Math.max(umax, Math.hypot(mx / rho, my / rho));
  }
  const expected = U0 * Math.exp(-2 * nu * k * k * steps);
  const err = Math.abs(umax - expected) / expected;
  return [
    [`TGV decay: u_max ${umax.toExponential(3)} vs analytic ${expected.toExponential(3)}`, err < 0.02, `rel err ${(err * 100).toFixed(2)}%`],
  ];
}
