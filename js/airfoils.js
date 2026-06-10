// Airfoil geometry: NACA generators, .dat parsing, resampling, rasterization.
// Coordinate convention used internally: Selig order — array of [x,y] starting at
// trailing edge, over the UPPER surface to the leading edge, then back along the
// LOWER surface to the trailing edge. Chord normalized to [0,1].

import { COORD_DATA } from './airfoil-data.js';

// ---------------------------------------------------------------- generators

/** NACA 4-digit, e.g. "2412". Closed trailing edge. n points per surface. */
export function naca4(code, n = 81) {
  const m = parseInt(code[0], 10) / 100;     // max camber
  const p = parseInt(code[1], 10) / 10;      // camber position
  const t = parseInt(code.slice(2), 10) / 100; // thickness
  return buildFromCamberThickness(
    (x) => camber4(x, m, p), (x) => dCamber4(x, m, p), (x) => thickness4(x, t), n);
}

/** NACA 5-digit (standard camber line), e.g. "23012". */
export function naca5(code, n = 81) {
  const p = parseInt(code[1], 10) / 20;        // position of max camber (e.g. 3 -> 0.15)
  const t = parseInt(code.slice(3), 10) / 100;
  // Tabulated constants for standard (non-reflex) 5-digit camber lines.
  const tab = { 0.05: [0.0580, 361.40], 0.10: [0.1260, 51.640], 0.15: [0.2025, 15.957], 0.20: [0.2900, 6.643], 0.25: [0.3910, 3.230] };
  const key = Object.keys(tab).reduce((a, b) => Math.abs(b - p) < Math.abs(a - p) ? b : a);
  const [r, k1] = tab[key];
  const cl = (x) => x < r ? (k1 / 6) * (x ** 3 - 3 * r * x * x + r * r * (3 - r) * x)
    : (k1 * r ** 3 / 6) * (1 - x);
  const dcl = (x) => x < r ? (k1 / 6) * (3 * x * x - 6 * r * x + r * r * (3 - r))
    : -(k1 * r ** 3 / 6);
  // Scale camber for design Cl: first digit L gives Cl_design = 0.15*L; table is for Cl=0.3 (L=2).
  const scale = (parseInt(code[0], 10) * 0.15) / 0.3;
  return buildFromCamberThickness(
    (x) => scale * cl(x), (x) => scale * dcl(x), (x) => thickness4(x, t), n);
}

function thickness4(x, t) { // closed-TE coefficient set (-0.1036)
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}
function camber4(x, m, p) {
  if (m === 0) return 0;
  return x < p ? (m / (p * p)) * (2 * p * x - x * x)
    : (m / ((1 - p) ** 2)) * ((1 - 2 * p) + 2 * p * x - x * x);
}
function dCamber4(x, m, p) {
  if (m === 0) return 0;
  return x < p ? (2 * m / (p * p)) * (p - x) : (2 * m / ((1 - p) ** 2)) * (p - x);
}

function buildFromCamberThickness(yc, dyc, yt, n) {
  const upper = [], lower = [];
  for (let i = 0; i < n; i++) {
    const x = 0.5 * (1 - Math.cos(Math.PI * i / (n - 1))); // cosine spacing
    const th = Math.atan(dyc(x)), tt = yt(x);
    upper.push([x - tt * Math.sin(th), yc(x) + tt * Math.cos(th)]);
    lower.push([x + tt * Math.sin(th), yc(x) - tt * Math.cos(th)]);
  }
  // Selig order: TE -> upper -> LE -> lower -> TE
  const pts = [];
  for (let i = n - 1; i >= 0; i--) pts.push(upper[i]);
  for (let i = 1; i < n; i++) pts.push(lower[i]);
  return pts;
}

/** Symmetric diamond (double-wedge) airfoil; exact shock-expansion reference shape. */
export function diamond(tc = 0.08, nPerFace = 24) {
  const h = tc / 2;
  const face = (x0, y0, x1, y1) => {
    const pts = [];
    for (let i = 0; i < nPerFace; i++) {
      const s = i / nPerFace;
      pts.push([x0 + s * (x1 - x0), y0 + s * (y1 - y0)]);
    }
    return pts;
  };
  return [
    ...face(1, 0, 0.5, h), ...face(0.5, h, 0, 0),       // upper: TE -> mid -> LE
    ...face(0, 0, 0.5, -h), ...face(0.5, -h, 1, 0), [1, 0], // lower: LE -> mid -> TE
  ];
}

/** Thin flat plate with elliptic nose/tail caps. */
export function flatPlate(tc = 0.02, n = 61) {
  const h = tc / 2;
  const y = (x) => { // elliptic blend in first/last 5% chord
    const a = 0.05;
    if (x < a) return h * Math.sqrt(Math.max(0, 1 - ((a - x) / a) ** 2));
    if (x > 1 - a) return h * Math.sqrt(Math.max(0, 1 - ((x - (1 - a)) / a) ** 2));
    return h;
  };
  const pts = [];
  for (let i = 0; i < n; i++) { const x = 1 - i / (n - 1); pts.push([x, y(x)]); }
  for (let i = 1; i < n; i++) { const x = i / (n - 1); pts.push([x, -y(x)]); }
  return pts;
}

// ---------------------------------------------------------------- parsing

/** Parse .dat airfoil text (Selig or Lednicer format). Returns Selig-ordered points. */
export function parseDat(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  let name = 'Custom';
  const nums = [];
  for (const line of lines) {
    const toks = line.split(/[\s,]+/).map(Number);
    if (toks.length >= 2 && toks.every(v => Number.isFinite(v))) nums.push([toks[0], toks[1]]);
    else if (nums.length === 0) name = line;
  }
  if (nums.length < 6) throw new Error('Could not parse airfoil coordinates');
  let pts;
  if (nums[0][0] > 1.5 && nums[0][1] > 1.5) {
    // Lednicer: first line is point counts; two blocks LE->TE (upper, then lower)
    const nUp = Math.round(nums[0][0]);
    const up = nums.slice(1, 1 + nUp);           // LE -> TE
    const lo = nums.slice(1 + nUp);              // LE -> TE
    pts = [...up.slice().reverse(), ...lo.slice(1)]; // TE -> LE -> TE
  } else {
    pts = nums;
  }
  return { name, coords: normalize(pts) };
}

/** Normalize: chord to [0,1], remove duplicate consecutive points, close TE gap midway. */
export function normalize(ptsIn) {
  let pts = ptsIn.map(p => [p[0], p[1]]);
  let xmin = Infinity, xmax = -Infinity;
  for (const [x] of pts) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); }
  const c = xmax - xmin;
  pts = pts.map(([x, y]) => [(x - xmin) / c, y / c]);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [out[out.length - 1], pts[i]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) out.push(b);
  }
  // close TE: average first/last if they differ
  const f = out[0], l = out[out.length - 1];
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 1e-9) {
    const te = [(f[0] + l[0]) / 2, (f[1] + l[1]) / 2];
    out[0] = te; out.push([te[0], te[1]]);
  } else { out.push([f[0], f[1]]); } // ensure closed
  return out;
}

// ---------------------------------------------------------------- geometry info

/** Split closed Selig polygon at LE (min x). Returns {upper, lower} each LE->TE sorted by x. */
export function splitSurfaces(coords) {
  let iLE = 0, best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = coords[i][0] * coords[i][0] + coords[i][1] * coords[i][1] * 0.25;
    if (coords[i][0] < best) { best = coords[i][0]; iLE = i; }
    void d;
  }
  const upper = coords.slice(0, iLE + 1).reverse(); // LE -> TE
  const lower = coords.slice(iLE);                  // LE -> TE
  return { upper, lower };
}

export function geomInfo(coords) {
  const { upper, lower } = splitSurfaces(coords);
  const yU = interp1(upper), yL = interp1(lower);
  let tmax = 0, xt = 0, cmax = 0, xc = 0;
  for (let i = 1; i < 100; i++) {
    const x = i / 100, t = yU(x) - yL(x), cam = (yU(x) + yL(x)) / 2;
    if (t > tmax) { tmax = t; xt = x; }
    if (Math.abs(cam) > Math.abs(cmax)) { cmax = cam; xc = x; }
  }
  return { tc: tmax, xt, camber: cmax, xc };
}

export function interp1(pts) { // pts sorted ascending in x; linear interp, clamped
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] > x) hi = m; else lo = m; }
    const [x0, y0] = pts[lo], [x1, y1] = pts[hi];
    return y0 + (y1 - y0) * (x - x0) / Math.max(1e-12, x1 - x0);
  };
}

/** Resample closed polygon to 2*n-1 points with cosine clustering at LE/TE (for panel method). */
export function resample(coords, n = 70) {
  const { upper, lower } = splitSurfaces(coords);
  const yU = interp1(upper), yL = interp1(lower);
  const pts = [];
  for (let i = 0; i <= n; i++) {           // TE -> LE along upper
    const x = 0.5 * (1 + Math.cos(Math.PI * i / n));
    pts.push([x, yU(x)]);
  }
  for (let i = 1; i <= n; i++) {           // LE -> TE along lower
    const x = 0.5 * (1 - Math.cos(Math.PI * i / n));
    pts.push([x, yL(x)]);
  }
  return pts;
}

// ---------------------------------------------------------------- rasterization

/**
 * Rasterize airfoil onto grid. Returns Uint32Array(nx*ny):
 *   0 = fluid, 1 = interior solid,
 *   2..1021 = boundary solid carrying the true outline-normal angle,
 *   quantized over [0, 2pi) as value-2 in 1019 steps (ghost-fluid mirror).
 * chordPx: chord length in cells; (ox, oy): LE position in cells.
 * Scanline fill + edge dilation (guarantees min ~1.5 cell thickness, closed body).
 */
export function rasterize(coords, nx, ny, chordPx, ox, oy) {
  const mask = new Uint32Array(nx * ny);
  const poly = coords.map(([x, y]) => [ox + x * chordPx, oy + y * chordPx]);
  const m = poly.length - 1; // closed: last == first
  // scanline fill
  for (let j = 0; j < ny; j++) {
    const yc = j + 0.5, xs = [];
    for (let k = 0; k < m; k++) {
      const [x1, y1] = poly[k], [x2, y2] = poly[k + 1];
      if ((y1 <= yc) !== (y2 <= yc)) xs.push(x1 + (yc - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let p = 0; p + 1 < xs.length; p += 2) {
      const i0 = Math.max(0, Math.ceil(xs[p] - 0.5)), i1 = Math.min(nx - 1, Math.floor(xs[p + 1] - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * nx + i] = 1;
    }
  }
  // edge dilation: mark cells whose center is within rad of the outline
  const rad = 0.75;
  for (let k = 0; k < m; k++) {
    const [x1, y1] = poly[k], [x2, y2] = poly[k + 1];
    const i0 = Math.max(0, Math.floor(Math.min(x1, x2) - rad - 1)), i1 = Math.min(nx - 1, Math.ceil(Math.max(x1, x2) + rad + 1));
    const j0 = Math.max(0, Math.floor(Math.min(y1, y2) - rad - 1)), j1 = Math.min(ny - 1, Math.ceil(Math.max(y1, y2) + rad + 1));
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - x1, py = j + 0.5 - y1;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
      const ddx = px - t * dx, ddy = py - t * dy;
      if (ddx * ddx + ddy * ddy < rad * rad) mask[j * nx + i] = 1;
    }
  }
  // encode true surface normals into boundary solid cells (any solid cell
  // with a fluid 4-neighbor): nearest outline segment's perpendicular
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const idx = j * nx + i;
    if (!mask[idx]) continue;
    if (mask[idx - 1] && mask[idx + 1] && mask[idx - nx] && mask[idx + nx]) continue;
    const px = i + 0.5, py = j + 0.5;
    let best = Infinity, pnx = 0, pny = 1;
    for (let k = 0; k < m; k++) {
      const [x1, y1] = poly[k], [x2, y2] = poly[k + 1];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
      const ddx = px - (x1 + t * dx), ddy = py - (y1 + t * dy);
      const d = ddx * ddx + ddy * ddy;
      if (d < best) { best = d; pnx = -dy; pny = dx; } // perpendicular; sign irrelevant for reflection
    }
    const th = Math.atan2(pny, pnx); // [-pi, pi]
    mask[idx] = 2 + Math.round((th + Math.PI) / (2 * Math.PI) * 1019);
  }
  return mask;
}

/** Nearest point on outline (for Cp surface mapping). Returns {xc, side} side:+1 upper,-1 lower. */
export function nearestSurfacePoint(coords, px, py) {
  let best = Infinity, bx = 0, by = 0;
  const m = coords.length - 1;
  for (let k = 0; k < m; k++) {
    const [x1, y1] = coords[k], [x2, y2] = coords[k + 1];
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    const d = (px - qx) ** 2 + (py - qy) ** 2;
    if (d < best) { best = d; bx = qx; by = qy; }
  }
  const { upper, lower } = splitSurfaces(coords);
  const yU = interp1(upper), yL = interp1(lower);
  const side = Math.abs(by - yU(bx)) <= Math.abs(by - yL(bx)) ? 1 : -1;
  return { xc: bx, side, dist: Math.sqrt(best) };
}

// ---------------------------------------------------------------- database

export const PRESETS = [
  { id: 'naca0012', name: 'NACA 0012 (symmetric, classic)', kind: 'naca4', code: '0012' },
  { id: 'naca2412', name: 'NACA 2412 (Cessna 172)', kind: 'naca4', code: '2412' },
  { id: 'naca4412', name: 'NACA 4412 (high camber GA)', kind: 'naca4', code: '4412' },
  { id: 'naca0006', name: 'NACA 0006 (thin symmetric)', kind: 'naca4', code: '0006' },
  { id: 'naca6412', name: 'NACA 6412 (high lift)', kind: 'naca4', code: '6412' },
  { id: 'naca23012', name: 'NACA 23012 (5-digit, Beechcraft)', kind: 'naca5', code: '23012' },
  { id: 'clarky', name: 'Clark Y (flat-bottom classic)', kind: 'coords', data: 'clarky' },
  { id: 'rae2822', name: 'RAE 2822 (transonic research)', kind: 'coords', data: 'rae2822' },
  { id: 's1223', name: 'Selig S1223 (high-lift, low Re)', kind: 'coords', data: 's1223' },
  { id: 'e387', name: 'Eppler E387 (sailplane, low Re)', kind: 'coords', data: 'e387' },
  { id: 's809', name: 'NREL S809 (wind turbine)', kind: 'coords', data: 's809' },
  { id: 'diamond8', name: 'Diamond wedge 8% (supersonic ref)', kind: 'diamond', tc: 0.08 },
  { id: 'flatplate', name: 'Flat plate 2%', kind: 'flatplate', tc: 0.02 },
];

/** Get normalized Selig coords for a preset id or NACA code. */
export function getAirfoil(idOrCode) {
  const p = PRESETS.find(q => q.id === idOrCode);
  if (p) {
    if (p.kind === 'naca4') return { name: p.name, coords: normalize(naca4(p.code)) };
    if (p.kind === 'naca5') return { name: p.name, coords: normalize(naca5(p.code)) };
    if (p.kind === 'coords') return { name: p.name, coords: parseDat(COORD_DATA[p.data]).coords };
    if (p.kind === 'diamond') return { name: p.name, coords: normalize(diamond(p.tc)) };
    if (p.kind === 'flatplate') return { name: p.name, coords: normalize(flatPlate(p.tc)) };
  }
  const code = String(idOrCode).replace(/^naca\s*/i, '').trim();
  if (/^\d{4}$/.test(code)) return { name: `NACA ${code}`, coords: normalize(naca4(code)) };
  if (/^\d{5}$/.test(code)) return { name: `NACA ${code}`, coords: normalize(naca5(code)) };
  throw new Error(`Unknown airfoil: ${idOrCode}`);
}
