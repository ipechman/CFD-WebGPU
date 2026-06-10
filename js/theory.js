// Aerodynamic theory: compressibility corrections, linearized supersonic (Ackeret),
// oblique shock / Prandtl-Meyer relations, exact diamond-airfoil shock-expansion,
// and empirical skin-friction drag. All angles in radians unless noted.

import { splitSurfaces, interp1, geomInfo } from './airfoils.js';

export const GAMMA = 1.4;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- subsonic

export function prandtlGlauert(M) { return 1 / Math.sqrt(Math.max(1e-6, 1 - M * M)); }

/** Karman-Tsien corrected Cp from incompressible Cp. Valid M < ~0.7 (subcritical). */
export function karmanTsien(cp0, M) {
  const b = Math.sqrt(Math.max(1e-6, 1 - M * M));
  return cp0 / (b + (M * M / (1 + b)) * (cp0 / 2));
}

/** Thin-airfoil lift slope per radian incl. compressibility (subsonic) or Ackeret (supersonic). */
export function liftSlope(M) {
  if (M < 0.75) return 2 * Math.PI * prandtlGlauert(M);
  if (M > 1.15) return 4 / Math.sqrt(M * M - 1);
  return NaN; // transonic: linear theory invalid
}

// ---------------------------------------------------------------- Ackeret (linearized supersonic)

/**
 * Linearized supersonic surface pressures for an arbitrary thin airfoil.
 * Cp = 2*delta/beta, delta = local surface slope relative to freestream.
 * Returns { cl, cd, cm, cpU: [[x,cp]...], cpL: [[x,cp]...] , valid }.
 */
export function ackeret(coords, M, alphaDeg) {
  if (M <= 1.05) return { valid: false };
  const a = alphaDeg * D2R;
  const beta = Math.sqrt(M * M - 1);
  const { upper, lower } = splitSurfaces(coords);
  const n = 80;
  const yU = interp1(upper), yL = interp1(lower);
  let cn = 0, ca = 0, cm = 0;
  const cpU = [], cpL = [];
  for (let i = 0; i < n; i++) {
    const x0 = i / n, x1 = (i + 1) / n, xm = (x0 + x1) / 2, dx = x1 - x0;
    const dyU = (yU(x1) - yU(x0)) / dx, dyL = (yL(x1) - yL(x0)) / dx;
    const cpu = 2 * (dyU - a) / beta;          // upper surface
    const cpl = -2 * (dyL - a) / beta;         // lower surface
    cpU.push([xm, cpu]); cpL.push([xm, cpl]);
    cn += (cpl - cpu) * dx;
    ca += (cpu * dyU - cpl * dyL) * dx;
    cm += -(cpl - cpu) * (xm - 0.25) * dx;     // about quarter chord, nose-up positive
  }
  const cl = cn * Math.cos(a) - ca * Math.sin(a);
  const cd = cn * Math.sin(a) + ca * Math.cos(a);
  return { cl, cd, cm, cpU, cpL, valid: true };
}

// ---------------------------------------------------------------- shock relations

/** Prandtl-Meyer function nu(M), radians. */
export function pmFunction(M, g = GAMMA) {
  const k = Math.sqrt((g + 1) / (g - 1));
  const s = Math.sqrt(Math.max(0, M * M - 1));
  return k * Math.atan(s / k) - Math.atan(s);
}

/** Inverse Prandtl-Meyer: M(nu), bisection. */
export function pmInverse(nu, g = GAMMA) {
  let lo = 1.0001, hi = 80;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (pmFunction(mid, g) < nu) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Weak oblique shock angle beta for deflection theta at Mach M. Returns NaN if detached. */
export function thetaBetaM(M, theta, g = GAMMA) {
  if (theta <= 0) return Math.asin(1 / M);
  const f = (b) => Math.atan(2 / Math.tan(b) * (M * M * Math.sin(b) ** 2 - 1) /
    (M * M * (g + Math.cos(2 * b)) + 2)) - theta;
  // weak branch: scan from Mach angle upward to the theta-max point
  const mu = Math.asin(1 / M);
  let bPrev = mu + 1e-6, fPrev = f(bPrev);
  for (let i = 1; i <= 2000; i++) {
    const b = mu + (Math.PI / 2 - mu) * i / 2000;
    const fb = f(b);
    if (fPrev < 0 && fb >= 0) { // bracket on rising branch
      let lo = bPrev, hi = b;
      for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
      return (lo + hi) / 2;
    }
    if (fb < fPrev && fPrev < 0) break; // passed theta-max without crossing: detached
    bPrev = b; fPrev = fb;
  }
  return NaN;
}

/** Oblique shock jump for deflection theta>0: returns {p2p1, M2, beta} (weak solution). */
export function obliqueShock(M1, theta, g = GAMMA) {
  const beta = thetaBetaM(M1, theta, g);
  if (!Number.isFinite(beta)) return { detached: true };
  const M1n = M1 * Math.sin(beta);
  const p2p1 = 1 + 2 * g / (g + 1) * (M1n * M1n - 1);
  const M2n2 = (1 + (g - 1) / 2 * M1n * M1n) / (g * M1n * M1n - (g - 1) / 2);
  const M2 = Math.sqrt(M2n2) / Math.sin(beta - theta);
  return { p2p1, M2, beta, detached: false };
}

/** Isentropic expansion through turn dTheta>0: returns {p2p1, M2}. */
export function pmExpansion(M1, dTheta, g = GAMMA) {
  const M2 = pmInverse(pmFunction(M1, g) + dTheta, g);
  const r = (1 + (g - 1) / 2 * M1 * M1) / (1 + (g - 1) / 2 * M2 * M2);
  return { p2p1: Math.pow(r, g / (g - 1)), M2 };
}

/** Pressure ratio across a deflection (shock if compression, PM fan if expansion). */
function turnFlow(M1, delta, g = GAMMA) {
  if (Math.abs(delta) < 1e-9) return { p2p1: 1, M2: M1 };
  if (delta > 0) { const s = obliqueShock(M1, delta, g); return s.detached ? null : s; }
  return pmExpansion(M1, -delta, g);
}

/**
 * Exact (shock-expansion) solution for a symmetric diamond airfoil.
 * tc: thickness ratio; half-angle eps = atan(tc). Valid while leading shocks attach.
 * Returns { cl, cd, faces, valid }.
 */
export function diamondShockExpansion(M, alphaDeg, tc, g = GAMMA) {
  if (M <= 1.05) return { valid: false };
  const a = alphaDeg * D2R, eps = Math.atan(tc);
  const qFac = 0.5 * g * M * M; // q / p_inf
  // Front faces: deflection relative to freestream (positive = compression)
  const dFU = eps - a;   // front-upper
  const dFL = eps + a;   // front-lower
  const fu = turnFlow(M, dFU, g), fl = turnFlow(M, dFL, g);
  if (!fu || !fl) return { valid: false, detached: true };
  // Rear faces: flow turns outward by 2*eps from front-face direction (expansion)
  const ru = turnFlow(fu.M2, -2 * eps, g), rl = turnFlow(fl.M2, -2 * eps, g);
  if (!ru || !rl) return { valid: false };
  const pFU = fu.p2p1, pFL = fl.p2p1, pRU = fu.p2p1 * ru.p2p1, pRL = fl.p2p1 * rl.p2p1;
  const cp = (p) => (p - 1) / qFac;
  // Face geometry (unit chord): each face has dx=0.5, |dy|=tc/2
  // Normal force (body axes): sum of cp * dx contributions; axial: cp * dy with sign by face slope.
  const cn = 0.5 * ((cp(pFL) + cp(pRL)) - (cp(pFU) + cp(pRU)));
  const ca = (tc / 2) * ((cp(pFU) + cp(pFL)) - (cp(pRU) + cp(pRL)));
  const cl = cn * Math.cos(a) - ca * Math.sin(a);
  const cd = cn * Math.sin(a) + ca * Math.cos(a);
  return { cl, cd, valid: true, faces: { pFU, pFL, pRU, pRL } };
}

// ---------------------------------------------------------------- viscous drag estimate

/**
 * Empirical profile-drag estimate (flat-plate friction + form factor + lift penalty).
 * Calibrated so NACA 0012 @ Re 6e6 gives Cd0 ~ 0.006 (Abbott & von Doenhoff).
 * Returns { cd0, cdOfCl } - cdOfCl(cl) adds the lift-dependent profile drag rise.
 */
export function frictionDrag(Re, tc, M = 0) {
  Re = Math.max(1e4, Re);
  let cf, bubble = 1;
  if (Re < 5e5) {
    cf = 1.328 / Math.sqrt(Re);                                   // laminar
    // low-Re penalty: laminar separation bubbles raise drag well above flat-plate
    bubble = 1 + 0.45 * Math.pow(Math.min(2.5, Math.max(0, 5e5 / Re - 1)), 0.6);
  } else {
    cf = 0.455 / Math.pow(Math.log10(Re), 2.58) - 1700 / Re;      // turbulent w/ transition credit
  }
  cf = Math.max(cf, 0) * bubble;
  if (M > 0.3) cf *= Math.pow(1 + 0.144 * M * M, -0.65);          // compressibility
  const ff = 1 + 2 * tc + 60 * Math.pow(tc, 4);                    // Hoerner form factor
  const CAL = 0.82;                                                // calibration to A&vD data
  const cd0 = 2 * cf * ff * CAL;
  const k = 0.0045 * (1 + 2 * tc);                                 // profile drag rise ~ k*Cl^2
  return { cd0, cdOfCl: (cl) => cd0 + k * cl * cl };
}

// ---------------------------------------------------------------- combined quick estimate

/**
 * Best-available instant estimate across the Mach range, given panel-method
 * incompressible results (clInc, cmInc) and geometry.
 * Regimes: M<0.75 panel+KT; 0.75..1.15 invalid (transonic); M>1.15 Ackeret (or exact for diamond).
 */
export function quickEstimate({ coords, M, Re, alphaDeg, clInc, cmInc, isDiamond, tc }) {
  const info = tc != null ? { tc } : geomInfo(coords);
  const fric = frictionDrag(Re, info.tc, M);
  if (M < 0.75) {
    const cl = clInc * prandtlGlauert(M);
    return { regime: M < 0.3 ? 'incompressible' : 'subsonic', valid: true,
      cl, cm: cmInc * prandtlGlauert(M), cd: fric.cdOfCl(cl), cdSource: 'empirical friction + induced-profile' };
  }
  if (M > 1.15) {
    if (isDiamond) {
      const ex = diamondShockExpansion(M, alphaDeg, info.tc);
      if (ex.valid) return { regime: 'supersonic (exact shock-expansion)', valid: true,
        cl: ex.cl, cd: ex.cd + fric.cd0, cm: NaN, cdWave: ex.cd, cdSource: 'shock-expansion + friction' };
    }
    const ak = ackeret(coords, M, alphaDeg);
    if (ak.valid) return { regime: M > 5 ? 'hypersonic (linear theory, indicative)' : 'supersonic (Ackeret)',
      valid: true, cl: ak.cl, cd: ak.cd + fric.cd0, cm: ak.cm, cdWave: ak.cd, cpU: ak.cpU, cpL: ak.cpL,
      cdSource: 'linearized wave drag + friction' };
  }
  return { regime: 'transonic', valid: false,
    note: 'Linear theory invalid for 0.75 < M < 1.15 - use the Euler engine.' };
}
