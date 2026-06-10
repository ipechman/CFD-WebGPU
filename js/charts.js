// Minimal dependency-free canvas charts: line/scatter series, axes, legend.

const COLORS = ['#4cc2ff', '#ffb454', '#7ee787', '#ff7b72', '#d2a8ff', '#ffd866', '#9aa3b2'];

/**
 * plot(canvas, { series, xlabel, ylabel, invertY, xrange, yrange, legend, title })
 * series: [{ x: [], y: [], label, color, type: 'line'|'scatter', dash, width }]
 */
export function plot(canvas, opts) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 420, cssH = canvas.clientHeight || 260;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  const series = (opts.series || []).filter(s => s.x && s.x.length);
  const padL = 46, padR = 12, padT = opts.title ? 22 : 10, padB = 32;

  // ranges
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of series) for (let i = 0; i < s.x.length; i++) {
    const xv = s.x[i], yv = s.y[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    xmin = Math.min(xmin, xv); xmax = Math.max(xmax, xv);
    ymin = Math.min(ymin, yv); ymax = Math.max(ymax, yv);
  }
  if (!Number.isFinite(xmin)) { xmin = 0; xmax = 1; ymin = 0; ymax = 1; }
  if (opts.xrange) [xmin, xmax] = opts.xrange;
  if (opts.yrange) [ymin, ymax] = opts.yrange;
  if (xmax - xmin < 1e-12) { xmax += 1; xmin -= 1; }
  if (ymax - ymin < 1e-12) { ymax += 1; ymin -= 1; }
  if (!opts.yrange) { const m = (ymax - ymin) * 0.08; ymin -= m; ymax += m; }
  if (!opts.xrange) { const m = (xmax - xmin) * 0.04; xmin -= m; xmax += m; }

  const X = (v) => padL + (v - xmin) / (xmax - xmin) * (W - padL - padR);
  const Y = (v) => {
    const t = (v - ymin) / (ymax - ymin);
    return opts.invertY ? padT + t * (H - padT - padB) : H - padB - t * (H - padT - padB);
  };

  // grid + ticks
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#7d8590';
  ctx.strokeStyle = 'rgba(125,133,144,0.18)';
  ctx.lineWidth = 1;
  for (const tx of ticks(xmin, xmax, 6)) {
    const px = X(tx);
    ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, H - padB); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(fmtTick(tx), px, H - padB + 13);
  }
  for (const ty of ticks(ymin, ymax, 5)) {
    const py = Y(ty);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmtTick(ty), padL - 5, py + 3);
  }
  // zero lines
  ctx.strokeStyle = 'rgba(125,133,144,0.45)';
  if (ymin < 0 && ymax > 0) { const py = Y(0); ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke(); }
  if (xmin < 0 && xmax > 0) { const px = X(0); ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, H - padB); ctx.stroke(); }

  // axes labels
  ctx.fillStyle = '#9aa3b2';
  ctx.textAlign = 'center';
  if (opts.xlabel) ctx.fillText(opts.xlabel, padL + (W - padL - padR) / 2, H - 4);
  if (opts.ylabel) {
    ctx.save(); ctx.translate(11, padT + (H - padT - padB) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.ylabel, 0, 0); ctx.restore();
  }
  if (opts.title) { ctx.textAlign = 'left'; ctx.fillStyle = '#c9d1d9'; ctx.font = '11px system-ui'; ctx.fillText(opts.title, padL, 13); }

  // clip plot area
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, W - padL - padR, H - padT - padB); ctx.clip();

  series.forEach((s, si) => {
    const color = s.color || COLORS[si % COLORS.length];
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = s.width || 1.6;
    ctx.setLineDash(s.dash || []);
    if (s.type === 'scatter') {
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) continue;
        ctx.beginPath(); ctx.arc(X(s.x[i]), Y(s.y[i]), s.r || 2.6, 0, 7); ctx.fill();
      }
    } else {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) { started = false; continue; }
        const px = X(s.x[i]), py = Y(s.y[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  ctx.restore();

  // legend
  if (opts.legend !== false && series.length > 1) {
    let lx = padL + 8, ly = padT + 6;
    ctx.font = '10px system-ui';
    for (let si = 0; si < series.length; si++) {
      const s = series[si];
      if (!s.label) continue;
      const color = s.color || COLORS[si % COLORS.length];
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly, 14, 3);
      ctx.fillStyle = '#c9d1d9';
      ctx.textAlign = 'left';
      ctx.fillText(s.label, lx + 18, ly + 5);
      ly += 14;
    }
  }
}

function ticks(lo, hi, n) {
  const span = hi - lo;
  const step = niceStep(span / n);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}
function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag;
}
function fmtTick(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return +v.toFixed(2) + '';
  return +v.toFixed(3) + '';
}

/** Download array-of-rows as CSV. */
export function exportCSV(filename, header, rows) {
  const lines = [header.join(','), ...rows.map(r => r.map(v =>
    typeof v === 'number' ? (Number.isFinite(v) ? v.toPrecision(6) : '') : `"${v}"`).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
