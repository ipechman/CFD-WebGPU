// CPU potential-flow visualization (panel method) - used for the Theory engine
// and as a fallback when WebGPU is unavailable.

import { makeFieldEvaluator } from './panel.js';
import { cmapJS } from './viz.js';

const GW = 220, GH = 110;               // coarse evaluation grid
const X0 = -1.3, X1 = 4.2, Y0 = -1.375, Y1 = 1.375;

export function renderCPUFlow(canvas, coords, alphaDeg, { cmap = 0, lo = 0, hi = 1.8 } = {}) {
  const ev = makeFieldEvaluator(coords, alphaDeg, 40);
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // field
  const tmp = document.createElement('canvas');
  tmp.width = GW; tmp.height = GH;
  const tctx = tmp.getContext('2d');
  const data = tctx.createImageData(GW, GH);
  const inside = makeInsideTest(coords);
  for (let j = 0; j < GH; j++) {
    const y = Y1 - (j + 0.5) / GH * (Y1 - Y0); // canvas row 0 = top = +y
    for (let i = 0; i < GW; i++) {
      const x = X0 + (i + 0.5) / GW * (X1 - X0);
      let rgb;
      if (inside(x, y)) rgb = [0.10, 0.12, 0.16];
      else {
        const [u, v] = ev.velocity(x, y);
        const s = Math.hypot(u, v);
        rgb = cmapJS((s - lo) / (hi - lo), cmap);
      }
      const o = (j * GW + i) * 4;
      data.data[o] = rgb[0] * 255; data.data[o + 1] = rgb[1] * 255; data.data[o + 2] = rgb[2] * 255; data.data[o + 3] = 255;
    }
  }
  tctx.putImageData(data, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, W, H);

  // streamlines
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  const toPx = (x, y) => [(x - X0) / (X1 - X0) * W, (Y1 - y) / (Y1 - Y0) * H];
  for (let k = 0; k < 26; k++) {
    let x = X0 + 0.02, y = Y0 + (k + 0.5) / 26 * (Y1 - Y0);
    ctx.beginPath();
    let [px, py] = toPx(x, y);
    ctx.moveTo(px, py);
    const h = 0.02;
    for (let s = 0; s < 600; s++) {
      const [u1, v1] = ev.velocity(x, y);
      const xm = x + 0.5 * h * u1, ym = y + 0.5 * h * v1;
      const [u2, v2] = ev.velocity(xm, ym);
      x += h * u2; y += h * v2;
      if (x > X1 || y < Y0 || y > Y1 || inside(x, y)) break;
      [px, py] = toPx(x, y);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  return ev.result;
}

function makeInsideTest(coords) {
  const n = coords.length - 1;
  return (x, y) => {
    if (x < -0.02 || x > 1.02 || y < -0.55 || y > 0.55) return false;
    let cross = 0;
    for (let k = 0; k < n; k++) {
      const [x1, y1] = coords[k], [x2, y2] = coords[k + 1];
      if ((y1 <= y) !== (y2 <= y)) {
        const xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1);
        if (xi > x) cross++;
      }
    }
    return (cross & 1) === 1;
  };
}
