// Panel method & theory validation against textbook / wind-tunnel anchors.

import { getAirfoil, geomInfo, rasterize, parseDat } from '../js/airfoils.js';
import { solvePanel } from '../js/panel.js';
import {
  obliqueShock, pmFunction, pmInverse, diamondShockExpansion, ackeret,
  frictionDrag, karmanTsien, prandtlGlauert,
} from '../js/theory.js';
import { COORD_DATA } from '../js/airfoil-data.js';

const D = Math.PI / 180;

export function test() {
  const checks = [];
  const ck = (name, cond, detail) => checks.push([name, cond, detail]);

  // ---- panel method ----
  const f0012 = getAirfoil('naca0012');
  const r0 = solvePanel(f0012.coords, 0);
  const r5 = solvePanel(f0012.coords, 5);
  const slope = (r5.cl - r0.cl) / 5;
  ck('0012: Cl(0)=0 (symmetry)', Math.abs(r0.cl) < 5e-3, r0.cl.toExponential(2));
  ck('0012: lift slope ~ 2pi(1+0.77 t/c) = 0.118/deg', slope > 0.112 && slope < 0.127, slope.toFixed(4));
  ck("0012: d'Alembert Cd ~ 0", Math.abs(r0.cdCheck) < 2e-3, r0.cdCheck.toExponential(2));

  const f2412 = getAirfoil('naca2412');
  let lo = -6, hi = 2;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (solvePanel(f2412.coords, m).cl < 0) lo = m; else hi = m; }
  const a0 = (lo + hi) / 2;
  const cm2412 = solvePanel(f2412.coords, 0).cm;
  ck('2412: alpha_0 ~ -2.1 deg (A&vD: -2.0)', a0 > -2.7 && a0 < -1.6, a0.toFixed(2));
  ck('2412: Cm_c/4 ~ -0.05 (A&vD: -0.047)', cm2412 > -0.08 && cm2412 < -0.02, cm2412.toFixed(3));

  const f4412 = getAirfoil('naca4412');
  const cl4412 = solvePanel(f4412.coords, 0).cl;
  ck('4412: Cl(0) ~ 0.5 inviscid (A&vD viscous: 0.42)', cl4412 > 0.40 && cl4412 < 0.62, cl4412.toFixed(3));

  // ---- compressible corrections ----
  ck('Prandtl-Glauert(0.5) = 1.1547', Math.abs(prandtlGlauert(0.5) - 1.1547) < 1e-3, prandtlGlauert(0.5).toFixed(4));
  const kt = karmanTsien(-1, 0.5);
  ck('Karman-Tsien(-1, M0.5) ~ -1.25', kt > -1.32 && kt < -1.18, kt.toFixed(3));

  // ---- shock relations (Anderson, Modern Compressible Flow tables) ----
  const os = obliqueShock(2, 10 * D);
  ck('M2 wedge 10deg: beta = 39.31 deg', Math.abs(os.beta / D - 39.31) < 0.15, (os.beta / D).toFixed(2));
  ck('M2 wedge 10deg: p2/p1 = 1.7066', Math.abs(os.p2p1 - 1.7066) < 0.01, os.p2p1.toFixed(4));
  ck('M2 wedge 10deg: M2 = 1.641', Math.abs(os.M2 - 1.641) < 0.01, os.M2.toFixed(3));
  ck('PM nu(2) = 26.38 deg', Math.abs(pmFunction(2) / D - 26.38) < 0.05, (pmFunction(2) / D).toFixed(2));
  ck('PM inverse roundtrip M=2.5', Math.abs(pmInverse(pmFunction(2.5)) - 2.5) < 1e-3, pmInverse(pmFunction(2.5)).toFixed(4));

  // ---- supersonic airfoil theory ----
  const dia = diamondShockExpansion(2, 0, 0.08);
  const cdLin = 4 * Math.atan(0.08) ** 2 / Math.sqrt(3);
  ck('diamond M2 a0: Cd ~ linear 4e^2/beta', Math.abs(dia.cd - cdLin) / cdLin < 0.05, `${dia.cd.toFixed(5)} vs ${cdLin.toFixed(5)}`);
  ck('diamond M2 a0: Cl = 0 (symmetry)', Math.abs(dia.cl) < 1e-6, dia.cl.toExponential(1));
  const dia4 = diamondShockExpansion(2, 4, 0.08);
  const clLin = 4 * (4 * D) / Math.sqrt(3);
  ck('diamond M2 a4: Cl ~ 4a/beta', Math.abs(dia4.cl - clLin) / clLin < 0.05, `${dia4.cl.toFixed(4)} vs ${clLin.toFixed(4)}`);
  const fp = getAirfoil('flatplate');
  const ak = ackeret(fp.coords, 2, 4);
  ck('flat plate Ackeret M2 a4: Cl = 0.1612', Math.abs(ak.cl - 0.1612) < 0.006, ak.cl.toFixed(4));

  // ---- friction drag calibration ----
  const fr = frictionDrag(6e6, 0.12);
  ck('Cd0(0012, Re 6e6) ~ 0.006 (A&vD: 0.0058)', fr.cd0 > 0.0048 && fr.cd0 < 0.0075, fr.cd0.toFixed(4));
  const frLow = frictionDrag(2e5, 0.10);
  ck('Cd0 rises at low Re', frLow.cd0 > fr.cd0, frLow.cd0.toFixed(4));

  // ---- geometry & rasterization ----
  const expectedTc = { clarky: 0.117, rae2822: 0.121, s1223: 0.121, e387: 0.091, s809: 0.21 };
  for (const [id, tcRef] of Object.entries(expectedTc)) {
    const { coords } = parseDat(COORD_DATA[id]);
    const info = geomInfo(coords);
    ck(`${id}: t/c ~ ${(tcRef * 100).toFixed(1)}%`, Math.abs(info.tc - tcRef) < 0.012, `t/c ${(info.tc * 100).toFixed(1)}%`);
  }

  const mask = rasterize(f0012.coords, 768, 384, 768 / 5.5, 1.3 * 768 / 5.5, 192);
  let cells = 0, border = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) cells++;
  const nx = 768, ny = 384;
  for (let i = 0; i < nx; i++) { border += mask[i] + mask[(ny - 1) * nx + i]; }
  for (let j = 0; j < ny; j++) { border += mask[j * nx] + mask[j * nx + nx - 1]; }
  const expectArea = 0.0822 * (768 / 5.5) ** 2; // 0012 area = 0.685*t*c^2
  ck('0012 raster area sane (fill + dilation)', cells > expectArea * 0.95 && cells < expectArea * 1.45,
    `${cells} cells vs ~${expectArea.toFixed(0)} geometric`);
  ck('raster: nothing on domain border', border === 0, String(border));

  // 5-digit generator
  const f23012 = getAirfoil('naca23012');
  const i23012 = geomInfo(f23012.coords);
  ck('23012: t/c = 12%', Math.abs(i23012.tc - 0.12) < 0.006, (i23012.tc * 100).toFixed(1) + '%');
  const r23012 = solvePanel(f23012.coords, 0);
  ck('23012: Cl(0) ~ 0.1-0.2 (design Cl 0.3 at ~1.2deg)', r23012.cl > 0.05 && r23012.cl < 0.3, r23012.cl.toFixed(3));

  return checks;
}
