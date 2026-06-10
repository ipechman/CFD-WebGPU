// Airfoil CFD Lab - app orchestration.

import { PRESETS, getAirfoil, parseDat, geomInfo, nearestSurfacePoint } from './airfoils.js';
import { solvePanel, liftCurve } from './panel.js';
import { quickEstimate, ackeret, karmanTsien, prandtlGlauert, frictionDrag } from './theory.js';
import { LBMEngine } from './lbm.js';
import { EulerEngine } from './euler.js';
import { Renderer, FIELDS, drawColorbar } from './viz.js';
import { renderCPUFlow } from './cpuflow.js';
import { plot, exportCSV } from './charts.js';
import { evaluateCase, EXP_DATA } from './validation.js';

const $ = (id) => document.getElementById(id);

const state = {
  airfoilId: 'naca2412', airfoilName: '', coords: null,
  M: 0.10, Re: 2e5, alphaDeg: 4.0,
  engineSel: 'auto', res: [1280, 640],
  field: 0, cmap: 0, lo: 0, hi: 1.8, particles: true,
  running: false, speed: 6, busy: false, sweepCancel: false,
  history: [], pinned: [], converged: false, lastForces: null,
  panelRes: null, theoryRes: null, cpSample: null, polarCache: null,
  device: null, engine: null, renderer: null, shaders: {},
};

// ============================================================ init

async function init() {
  populateAirfoils();
  bindUI();
  setAirfoilLocal(state.airfoilId);

  // shaders
  const [lbm, euler, render] = await Promise.all(
    ['shaders/lbm.wgsl', 'shaders/euler.wgsl', 'shaders/render.wgsl'].map(u => fetch(u).then(r => {
      if (!r.ok) throw new Error('Failed to load ' + u);
      return r.text();
    })));
  state.shaders = { lbm, euler, render };

  // WebGPU
  const gpuOK = await initGPU();
  $('gpu-status').textContent = gpuOK ? 'WebGPU ready' : 'no WebGPU';
  $('gpu-status').classList.add(gpuOK ? 'ok' : 'bad');
  if (!gpuOK && state.engineSel !== 'theory') {
    $('engine-select').value = 'theory';
    state.engineSel = 'theory';
    $('gpu-error').classList.remove('hidden');
    setTimeout(() => $('gpu-error').classList.add('hidden'), 9000);
  }

  await rebuildEngine();
  computeTheory();
  setRunning(true);
  requestAnimationFrame(loop);
  setStatus('Ready. LBM engine below M 0.3, Euler above; Theory always on. Results validate automatically.');
}

async function initGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') {
        setStatus('GPU device lost (' + info.message + '). Reload the page.');
        $('gpu-status').textContent = 'GPU lost';
        $('gpu-status').classList.add('bad');
      }
    });
    device.onuncapturederror = (e) => console.error('WebGPU error:', e.error.message);
    state.device = device;
    state.renderer = await Renderer.create(device, $('gpu-canvas'), state.shaders.render);
    return true;
  } catch (e) {
    console.error('WebGPU init failed:', e);
    return false;
  }
}

// ============================================================ engines

function activeEngineKind() {
  if (state.engineSel === 'theory' || !state.device) return 'theory';
  if (state.engineSel === 'auto') return state.M < 0.3 ? 'lbm' : 'euler';
  return state.engineSel;
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildEngine().catch(console.error), 250);
}

let rebuildChain = Promise.resolve();
function rebuildEngine() {
  rebuildChain = rebuildChain.then(() => rebuildEngineInner());
  return rebuildChain;
}

async function rebuildEngineInner() {
  const kind = activeEngineKind();
  $('engine-badge').textContent = kind.toUpperCase();
  updateRegimeLabel();

  const gpuButtons = ['btn-run', 'btn-reset', 'btn-ff', 'btn-sweep', 'btn-sample-cp'];
  if (kind === 'theory') {
    if (state.engine) { state.engine.destroy(); state.engine = null; }
    $('gpu-canvas').classList.add('hidden');
    $('cpu-canvas').classList.remove('hidden');
    for (const id of gpuButtons) $(id).disabled = true;
    populateFields('theory');
    renderCPUSoon();
    resetRun();
    return;
  }

  $('gpu-canvas').classList.remove('hidden');
  $('cpu-canvas').classList.add('hidden');
  for (const id of gpuButtons) $(id).disabled = false;

  const [nx, ny] = state.res;
  if (state.engine && state.engine.type === kind && state.engine.nx === nx) {
    state.engine.setFlow(state.M, state.Re, state.alphaDeg);
    return;
  }
  state.busy = true;
  setStatus(`Building ${kind.toUpperCase()} engine ${nx}x${ny}...`);
  try {
    if (state.engine) { state.engine.destroy(); state.engine = null; }
    const cls = kind === 'lbm' ? LBMEngine : EulerEngine;
    const eng = await cls.create(state.device, state.shaders[kind], { nx, ny });
    eng.setGeometry(state.coords);
    eng.setFlow(state.M, state.Re, state.alphaDeg);
    eng.reset();
    state.engine = eng;
    state.renderer.attach(eng);
    populateFields(kind);
    resetRun();
    setStatus(`${kind.toUpperCase()} ready - ${nx}x${ny}, chord ${eng.chord.toFixed(0)} cells.`);
  } finally {
    state.busy = false;
  }
}

function resetRun() {
  state.history = [];
  state.converged = false;
  state.lastForces = null;
  state.cpSample = null;
  updateResultsDisplay();
  refreshValidation();
}

// ============================================================ main loop

let frames = 0, fps = 0, lastFpsT = performance.now(), lastForceT = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const eng = state.engine;
  if (eng && state.renderer) {
    if (state.running && !state.busy) eng.step(state.speed);
    state.renderer.render({
      mode: state.field, cmap: state.cmap, lo: state.lo, hi: state.hi,
      particles: state.particles && state.field !== 4,
      minf: Math.max(state.M, 0.05),
      partSpeed: Math.min(3, Math.max(0.8, 0.3 * state.speed)),
    });
    frames++;
    if (now - lastFpsT > 1000) { fps = frames; frames = 0; lastFpsT = now; }
    updateHUD();
    if (state.running && !state.busy &&
        (now - lastForceT > 350 || eng.stepsSinceRead > 120)) {
      lastForceT = now;
      sampleForces().catch(console.error);
    }
  }
}

async function sampleForces() {
  const eng = state.engine;
  if (!eng) return;
  const f = await eng.readForces();
  if (!f) return;
  state.lastForces = f;
  state.history.push({ t: eng.tStar, cl: f.cl, cd: f.cd, cm: f.cm, settled: f.settledRamp });
  if (state.history.length > 800) state.history.shift();
  checkConvergence();
  updateResultsDisplay();
  drawConvSparkline();
  if (isTabActive('plots')) updateHistoryChart();
}

function checkConvergence() {
  const h = state.history.filter(s => s.settled);
  if (h.length < 20) { state.converged = false; state.convergedKind = null; return; }
  const w = h.slice(-20);
  const mean = w.reduce((a, s) => a + s.cl, 0) / w.length;
  const sd = Math.sqrt(w.reduce((a, s) => a + (s.cl - mean) ** 2, 0) / w.length);
  const wasConverged = state.converged;

  // steady convergence: tiny scatter
  const steady = sd / Math.max(Math.abs(mean), 0.05) < 0.012;
  // statistical stationarity (unsteady flows, e.g. vortex shedding): the
  // running mean has stopped drifting even though samples oscillate
  let stationary = false;
  if (!steady && h.length >= 40) {
    const a = h.slice(-40, -20), b = w;
    const ma = a.reduce((x, s) => x + s.cl, 0) / a.length;
    stationary = Math.abs(ma - mean) / Math.max(Math.abs(mean), 0.05) < 0.02;
  }
  state.converged = steady || stationary;
  state.convergedKind = steady ? 'steady' : stationary ? 'time-averaged' : null;
  if (state.converged && !wasConverged) {
    setStatus(`Converged (${state.convergedKind}): Cl=${mean.toFixed(3)} (sigma ${sd.toFixed(4)}). Validation updated.`);
    refreshValidation();
    if (!state.busy) sampleCp(false).catch(() => {}); // auto-refresh surface pressure plot
  }
}

// ============================================================ UI binding

function bindUI() {
  $('airfoil-select').addEventListener('change', (e) => setAirfoilLocal(e.target.value));
  $('naca-apply').addEventListener('click', applyNaca);
  $('naca-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyNaca(); });
  $('custom-apply').addEventListener('click', applyCustom);

  bindSlider('mach-slider', 'mach-val', (v) => v.toFixed(2), (v) => {
    state.M = v; onFlowChange();
  });
  bindSlider('re-slider', 're-val', (v) => fmtRe(Math.pow(10, v)), (v) => {
    state.Re = Math.pow(10, v); onFlowChange();
  });
  bindSlider('alpha-slider', 'alpha-val', (v) => v.toFixed(1) + '°', (v) => {
    state.alphaDeg = v; onFlowChange();
  });
  bindSlider('speed-slider', 'speed-val', (v) => v.toFixed(0), (v) => { state.speed = v; });

  $('engine-select').addEventListener('change', (e) => { state.engineSel = e.target.value; scheduleRebuild(); });
  $('res-select').addEventListener('change', (e) => {
    state.res = e.target.value.split('x').map(Number);
    if (state.engine) { state.engine.destroy(); state.engine = null; }
    scheduleRebuild();
  });

  $('btn-run').addEventListener('click', () => setRunning(!state.running));
  $('btn-reset').addEventListener('click', () => { if (state.engine) { state.engine.reset(); } resetRun(); });
  $('btn-ff').addEventListener('click', () => runToConvergence().catch(console.error));

  $('field-select').addEventListener('change', (e) => setField(+e.target.value));
  $('cmap-select').addEventListener('change', (e) => { state.cmap = +e.target.value; drawBar(); });
  $('particles-check').addEventListener('change', (e) => { state.particles = e.target.checked; });
  $('range-lo').addEventListener('change', (e) => { state.lo = +e.target.value; drawBar(); });
  $('range-hi').addEventListener('change', (e) => { state.hi = +e.target.value; drawBar(); });

  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'plots') { updateCpChart(); updatePolarChart(); updateHistoryChart(); updateDragChart(); }
    if (b.dataset.tab === 'validation') refreshValidation();
  }));

  $('btn-pin').addEventListener('click', pinPoint);
  $('btn-sweep').addEventListener('click', () => {
    if (state.busy) { state.sweepCancel = true; return; }
    alphaSweep().catch(console.error);
  });
  $('btn-csv').addEventListener('click', doExport);
  $('btn-sample-cp').addEventListener('click', () => sampleCp().catch(console.error));
  $('btn-revalidate').addEventListener('click', refreshValidation);

  const wrap = $('canvas-wrap');
  new ResizeObserver(() => resizeCanvases()).observe(wrap);
  resizeCanvases();
}

function bindSlider(id, valId, fmt, cb) {
  const el = $(id);
  const update = () => { $(valId).textContent = fmt(+el.value); };
  el.addEventListener('input', () => { update(); cb(+el.value); });
  update();
}

function setRunning(on) {
  state.running = on;
  $('btn-run').innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Run';
}

function onFlowChange() {
  updateRegimeLabel();
  const kind = activeEngineKind();
  if (state.engine && state.engine.type === kind) {
    state.engine.setFlow(state.M, state.Re, state.alphaDeg);
    state.history = [];
    state.converged = false;
  } else {
    scheduleRebuild();
  }
  computeTheoryDebounced();
  drawOverlay();
  if (activeEngineKind() === 'theory') renderCPUSoon();
}

function updateRegimeLabel() {
  const M = state.M;
  const r = M < 0.3 ? 'incompressible' : M < 0.8 ? 'subsonic' : M < 1.2 ? 'transonic' : M < 5 ? 'supersonic' : 'hypersonic';
  $('regime-label').textContent = `M ${M.toFixed(2)} - ${r}`;
}

// ============================================================ airfoil handling

function populateAirfoils() {
  const sel = $('airfoil-select');
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  const oc = document.createElement('option');
  oc.value = '__custom'; oc.textContent = 'Custom (pasted)'; oc.hidden = true;
  sel.appendChild(oc);
  sel.value = state.airfoilId;
}

function setAirfoilLocal(id, coordsOverride = null, nameOverride = '') {
  try {
    const af = coordsOverride ? { name: nameOverride || 'Custom', coords: coordsOverride } : getAirfoil(id);
    state.airfoilId = coordsOverride ? '__custom' : id;
    state.coords = af.coords;
    state.airfoilName = af.name;
    state.polarCache = null;
    state.cpSample = null;
    if (coordsOverride) $('airfoil-select').value = '__custom';
    drawPreview();
    if (state.engine) {
      state.engine.setGeometry(state.coords);
      state.engine.reset();
      state.renderer.attach(state.engine);
      resetRun();
    }
    computeTheoryDebounced();
    if (activeEngineKind() === 'theory') renderCPUSoon();
    drawOverlay();
  } catch (e) {
    setStatus('Airfoil error: ' + e.message);
  }
}

function applyNaca() {
  const code = $('naca-code').value.trim();
  if (!code) return;
  try {
    const presetId = 'naca' + code.replace(/^naca\s*/i, '');
    if (PRESETS.some(p => p.id === presetId)) {
      // known preset: keeps wind-tunnel validation anchors attached
      $('airfoil-select').value = presetId;
      setAirfoilLocal(presetId);
    } else {
      const af = getAirfoil(code);
      setAirfoilLocal(code, af.coords, af.name);
    }
  } catch (e) { setStatus(e.message); }
}

async function applyCustom() {
  let text = $('custom-dat').value;
  const file = $('custom-file').files[0];
  if (file) text = await file.text();
  if (!text.trim()) { setStatus('Paste .dat coordinates or choose a file first.'); return; }
  try {
    const { name, coords } = parseDat(text);
    setAirfoilLocal('__custom', coords, name);
    setStatus(`Loaded custom airfoil "${name}" (${coords.length - 1} points).`);
  } catch (e) { setStatus('Parse error: ' + e.message); }
}

function drawPreview() {
  const c = $('foil-preview');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = c.clientWidth, H = c.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const pad = 12, sc = W - 2 * pad;
  ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  state.coords.forEach(([x, y], i) => {
    const px = pad + x * sc, py = H / 2 - y * sc;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.strokeStyle = 'rgba(139,149,165,0.4)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(pad, H / 2); ctx.lineTo(pad + sc, H / 2); ctx.stroke();
  ctx.setLineDash([]);
  const info = geomInfo(state.coords);
  $('foil-info').textContent =
    `${state.airfoilName} - t/c ${(info.tc * 100).toFixed(1)}% @ ${(info.xt * 100).toFixed(0)}%c, camber ${(info.camber * 100).toFixed(1)}% @ ${(info.xc * 100).toFixed(0)}%c`;
}

// ============================================================ theory & results

const computeTheoryDebounced = debounce(computeTheory, 130);

function computeTheory() {
  try {
    state.panelRes = solvePanel(state.coords, state.alphaDeg, 60);
  } catch (e) { state.panelRes = null; console.error(e); }
  try {
    state.theoryRes = quickEstimate({
      coords: state.coords, M: state.M, Re: state.Re, alphaDeg: state.alphaDeg,
      clInc: state.panelRes ? state.panelRes.cl : 0,
      cmInc: state.panelRes ? state.panelRes.cm : 0,
      isDiamond: state.airfoilId === 'diamond8',
    });
  } catch (e) { state.theoryRes = null; console.error(e); }
  renderTheoryBlock();
  updateResultsDisplay();
  if (isTabActive('plots')) { updateCpChart(); updatePolarChart(); updateDragChart(); }
  refreshValidation();
}

function renderTheoryBlock() {
  const t = state.theoryRes;
  const el = $('theory-out');
  if (!t) { el.innerHTML = ''; return; }
  if (!t.valid) {
    el.innerHTML = `<b>Instant estimate</b> - ${t.note || 'not available in this regime'}`;
    return;
  }
  const cd = Number.isFinite(t.cd) ? t.cd.toFixed(4) : '-';
  const cm = Number.isFinite(t.cm) ? t.cm.toFixed(3) : '-';
  el.innerHTML = `<b>Instant estimate</b> (${t.regime}): ` +
    `C<sub>L</sub> <span class="t-num">${t.cl.toFixed(3)}</span> &nbsp; ` +
    `C<sub>D</sub> <span class="t-num">${cd}</span> &nbsp; ` +
    `C<sub>M</sub> <span class="t-num">${cm}</span> ` +
    `<span class="dim">(${t.cdSource})</span>`;
}

function updateResultsDisplay() {
  const kind = activeEngineKind();
  let src = '';
  let r = null;
  if (kind === 'theory') {
    if (state.theoryRes && state.theoryRes.valid) {
      r = state.theoryRes;
      src = `Theory engine - ${state.theoryRes.regime}`;
    } else { src = 'Theory engine - regime not covered (use Euler)'; }
  } else if (state.lastForces) {
    r = state.lastForces;
    const conv = state.converged ? ' - converged' : ' - averaging...';
    src = `${kind.toUpperCase()} solver, ${state.engine ? state.engine.iter.toLocaleString() : 0} steps${conv}`;
    if (kind === 'euler') {
      const fr = frictionDrag(state.Re, geomInfo(state.coords).tc, state.M);
      src += ` | inviscid: add Cd0~${fr.cd0.toFixed(4)} friction for total drag`;
    }
    if (kind === 'lbm' && state.engine && state.engine.reClamped) {
      src += ` | grid-limited: resolved Re ~ ${fmtRe(state.engine.effectiveRe)}`;
    }
  }
  $('out-cl').textContent = r && Number.isFinite(r.cl) ? r.cl.toFixed(3) : '-';
  $('out-cd').textContent = r && Number.isFinite(r.cd) ? r.cd.toFixed(4) : '-';
  $('out-cm').textContent = r && Number.isFinite(r.cm) ? r.cm.toFixed(3) : '-';
  $('out-ld').textContent = r && Number.isFinite(r.cl) && Number.isFinite(r.cd) && Math.abs(r.cd) > 1e-5
    ? (r.cl / r.cd).toFixed(1) : '-';
  $('out-source').textContent = src;
}

// ============================================================ charts

function updateCpChart() {
  const series = [];
  const M = state.M;
  if (state.panelRes && M < 0.75) {
    const n = state.panelRes.cp.length / 2;
    const mk = (arr) => ({
      x: arr.map(p => p[0]),
      y: arr.map(p => Math.max(-12, M > 0.05 ? karmanTsien(p[1], M) : p[1])),
    });
    const upper = state.panelRes.cp.slice(0, n).reverse();
    const lower = state.panelRes.cp.slice(n);
    series.push({ ...mk(upper), label: 'panel upper' + (M > 0.05 ? ' +KT' : ''), color: '#4cc2ff' });
    series.push({ ...mk(lower), label: 'panel lower', color: '#ffb454' });
  } else if (state.theoryRes && state.theoryRes.cpU) {
    series.push({ x: state.theoryRes.cpU.map(p => p[0]), y: state.theoryRes.cpU.map(p => p[1]), label: 'Ackeret upper', color: '#4cc2ff' });
    series.push({ x: state.theoryRes.cpL.map(p => p[0]), y: state.theoryRes.cpL.map(p => p[1]), label: 'Ackeret lower', color: '#ffb454' });
  }
  if (state.cpSample) {
    series.push({ x: state.cpSample.U.map(p => p[0]), y: state.cpSample.U.map(p => p[1]), label: 'solver upper', color: '#7ee787', type: 'scatter' });
    series.push({ x: state.cpSample.L.map(p => p[0]), y: state.cpSample.L.map(p => p[1]), label: 'solver lower', color: '#ff7b72', type: 'scatter' });
  }
  plot($('cp-canvas'), { series, xlabel: 'x/c', ylabel: 'Cp', invertY: true, xrange: [0, 1] });
}

function theoryPolar() {
  const key = `${state.airfoilId}|${state.M.toFixed(2)}`;
  if (state.polarCache && state.polarCache.key === key) return state.polarCache.data;
  const alphas = [];
  for (let a = -6; a <= 15.01; a += 1) alphas.push(a);
  let data = null;
  if (state.M < 0.75) {
    const pg = prandtlGlauert(state.M);
    data = liftCurve(state.coords, alphas, 40).map(([a, cl]) => [a, cl * pg]);
  } else if (state.M > 1.15) {
    data = alphas.map(a => {
      const r = ackeret(state.coords, state.M, a);
      return [a, r.valid ? r.cl : NaN];
    });
  }
  state.polarCache = { key, data };
  return data;
}

function updatePolarChart() {
  const series = [];
  const th = theoryPolar();
  if (th) series.push({ x: th.map(p => p[0]), y: th.map(p => p[1]), label: state.M > 1.15 ? 'Ackeret' : 'panel + PG', color: '#4cc2ff' });
  const exp = EXP_DATA[state.airfoilId];
  if (exp && state.M < 0.4) {
    series.push({ x: exp.alpha, y: exp.cl, label: 'wind tunnel (A&vD, Re 6e6)', color: '#9aa3b2', type: 'scatter', r: 3 });
  }
  if (state.pinned.length) {
    series.push({ x: state.pinned.map(p => p.alpha), y: state.pinned.map(p => p.cl), label: 'solver (pinned)', color: '#7ee787', type: 'scatter', r: 3.4 });
  }
  plot($('polar-canvas'), { series, xlabel: 'alpha (deg)', ylabel: 'Cl' });
}

function updateDragChart() {
  const series = [];
  const exp = EXP_DATA[state.airfoilId];
  if (exp && state.M < 0.4) {
    series.push({ x: exp.cd, y: exp.cl, label: 'wind tunnel', color: '#9aa3b2', type: 'scatter', r: 3 });
  }
  const fr = frictionDrag(state.Re, geomInfo(state.coords).tc, state.M);
  const cls = [], cds = [];
  for (let cl = -0.4; cl <= 1.8; cl += 0.05) { cls.push(cl); cds.push(fr.cdOfCl(cl)); }
  series.push({ x: cds, y: cls, label: 'empirical estimate', color: '#ffb454', dash: [4, 3] });
  if (state.pinned.length) {
    series.push({ x: state.pinned.map(p => p.cd), y: state.pinned.map(p => p.cl), label: 'solver (pinned)', color: '#7ee787', type: 'scatter', r: 3.4 });
  }
  plot($('drag-canvas'), { series, xlabel: 'Cd', ylabel: 'Cl' });
}

function updateHistoryChart() {
  const h = state.history;
  plot($('hist-canvas'), {
    series: [
      { x: h.map(s => s.t), y: h.map(s => s.cl), label: 'Cl', color: '#4cc2ff' },
      { x: h.map(s => s.t), y: h.map(s => s.cd), label: 'Cd', color: '#ffb454' },
    ],
    xlabel: 't* (chords traveled)', ylabel: 'coefficient',
  });
}

function drawConvSparkline() {
  const c = $('conv-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const h = state.history.slice(-120);
  if (h.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const s of h) { lo = Math.min(lo, s.cl); hi = Math.max(hi, s.cl); }
  if (hi - lo < 1e-4) { lo -= 0.01; hi += 0.01; }
  ctx.strokeStyle = state.converged ? '#3fb950' : '#4cc2ff';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  h.forEach((s, i) => {
    const x = i / (h.length - 1) * (c.width - 4) + 2;
    const y = c.height - 4 - (s.cl - lo) / (hi - lo) * (c.height - 8);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#8b95a5';
  ctx.font = '9px ui-monospace';
  ctx.fillText(state.converged ? 'converged' : 'Cl history', 4, 9);
}

// ============================================================ Cp sampling

async function sampleCp(manual = true) {
  const eng = state.engine;
  if (!eng || !state.renderer) { if (manual) setStatus('Cp sampling needs a running LBM/Euler engine.'); return; }
  if (manual) setStatus('Sampling surface pressure...');
  const macro = await state.renderer.readMacro();
  const { nx, ny, chord, origin, mask } = eng;
  const U = [], L = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const idx = j * nx + i;
    if (mask[idx]) continue;
    if (!(mask[idx + 1] || mask[idx - 1] || mask[idx + nx] || mask[idx - nx])) continue;
    const px = (i + 0.5 - origin[0]) / chord, py = (j + 0.5 - origin[1]) / chord;
    if (px < -0.05 || px > 1.05 || Math.abs(py) > 0.6) continue;
    const near = nearestSurfacePoint(state.coords, px, py);
    if (near.dist > 4 / chord) continue;
    const cp = macro[idx * 4 + 3];
    (near.side > 0 ? U : L).push([near.xc, cp]);
  }
  U.sort((a, b) => a[0] - b[0]); L.sort((a, b) => a[0] - b[0]);
  state.cpSample = { U, L };
  updateCpChart();
  if (manual) {
    setStatus(`Sampled ${U.length + L.length} surface points from the ${eng.type.toUpperCase()} field.`);
    if (!isTabActive('plots')) document.querySelector('[data-tab="plots"]').click();
  }
}

// ============================================================ fast-forward & sweep

/**
 * Run the solver in batches until the force-convergence criterion fires,
 * capped at maxChords of freestream travel. A fixed step count is useless
 * here: 2000 steps is under one chord on the default LBM grid, while steady
 * cases need 10-30 chords.
 */
async function runToConvergence(maxChords = 40, internal = false, label = 'Converging') {
  const eng = state.engine;
  if (!eng || (!internal && state.busy)) return false;
  if (!internal) state.busy = true;
  const bar = $('ff-progress');
  bar.classList.remove('hidden');
  // a fresh verdict needs >= 20 settled samples (5 chords at quarter-chord batches)
  const minChords = state.converged ? 2 : 5;
  const batch = Math.max(40, Math.round(eng.stepsPerChord / 4));
  const total = Math.round(maxChords * eng.stepsPerChord);
  const t0 = eng.tStar;
  let hit = false;
  try {
    for (let done = 0; done < total; done += batch) {
      if (internal && state.sweepCancel) break;
      eng.step(batch);
      await state.device.queue.onSubmittedWorkDone();
      await sampleForces();
      if (state.converged && eng.tStar - t0 >= minChords) { hit = true; break; }
      bar.firstElementChild.style.width = `${Math.min(100, (done + batch) / total * 100).toFixed(0)}%`;
      const f = state.lastForces;
      setStatus(`${label}: t* ${eng.tStar.toFixed(1)} of ${(t0 + maxChords).toFixed(0)} chords` +
        (f && Number.isFinite(f.cl) ? `, Cl ${f.cl.toFixed(3)}` : '') + '...');
    }
  } finally {
    bar.classList.add('hidden');
    bar.firstElementChild.style.width = '0%';
    if (!internal) {
      state.busy = false;
      setStatus(hit
        ? `Converged (${state.convergedKind}) after ${(eng.tStar - t0).toFixed(1)} chords of travel.`
        : `Hit the ${maxChords}-chord cap without full convergence - flow is likely unsteady; readouts show the running average.`);
    }
  }
  return hit;
}

/** Mean of the recent settled force samples (robust for shedding/unsteady cases). */
function meanRecentForces(n = 20) {
  const h = state.history.filter(s => s.settled).slice(-n);
  if (!h.length) return null;
  const avg = (k) => h.reduce((acc, s) => acc + s[k], 0) / h.length;
  return { cl: avg('cl'), cd: avg('cd'), cm: avg('cm') };
}

async function alphaSweep() {
  const eng = state.engine;
  if (!eng) { setStatus('Sweep needs the LBM or Euler engine.'); return; }
  state.busy = true;
  state.sweepCancel = false;
  $('btn-sweep').textContent = 'cancel sweep';
  const saved = state.alphaDeg;
  const alphas = eng.type === 'lbm' ? [-4, -2, 0, 2, 4, 6, 8, 10, 12] : [-2, 0, 2, 4, 6, 8];
  try {
    for (const a of alphas) {
      if (state.sweepCancel) break;
      const label = `Alpha sweep ${alphas.indexOf(a) + 1}/${alphas.length} (${a.toFixed(0)} deg)`;
      state.alphaDeg = a;
      $('alpha-slider').value = a;
      $('alpha-val').textContent = a.toFixed(1) + '°';
      eng.setFlow(state.M, state.Re, a);
      eng.reset();
      state.history = [];
      state.converged = false;
      const hit = await runToConvergence(30, true, label);
      const f = meanRecentForces();
      if (f && !state.sweepCancel) {
        state.pinned.push({ alpha: a, cl: f.cl, cd: f.cd, cm: f.cm, M: state.M, Re: state.Re, engine: eng.type });
        updatePolarChart(); updateDragChart();
        setStatus(`${label}: ${hit ? `converged (${state.convergedKind})` : 'capped, time-averaged'} - Cl ${f.cl.toFixed(3)}.`);
      }
    }
    setStatus(state.sweepCancel ? 'Sweep cancelled.' : 'Alpha sweep complete - see the Plots tab.');
    if (!isTabActive('plots')) document.querySelector('[data-tab="plots"]').click();
  } finally {
    state.busy = false;
    state.sweepCancel = false;
    $('btn-sweep').innerHTML = '&alpha; sweep';
    state.alphaDeg = saved;
    $('alpha-slider').value = saved;
    $('alpha-val').textContent = saved.toFixed(1) + '°';
    eng.setFlow(state.M, state.Re, saved);
    eng.reset();
    resetRun();
  }
}

function pinPoint() {
  const kind = activeEngineKind();
  const r = kind === 'theory' ? state.theoryRes : state.lastForces;
  if (!r || !Number.isFinite(r.cl)) { setStatus('No result to pin yet.'); return; }
  state.pinned.push({
    alpha: state.alphaDeg, cl: r.cl, cd: r.cd, cm: r.cm ?? NaN,
    M: state.M, Re: state.Re, engine: kind,
  });
  updatePolarChart(); updateDragChart();
  setStatus(`Pinned (alpha=${state.alphaDeg.toFixed(1)}, Cl=${r.cl.toFixed(3)}). ${state.pinned.length} point(s) on the polar.`);
}

function doExport() {
  const rows = state.pinned.map(p => [state.airfoilName, p.engine, p.M, p.Re, p.alpha, p.cl, p.cd, p.cm]);
  const r = activeEngineKind() === 'theory' ? state.theoryRes : state.lastForces;
  if (r && Number.isFinite(r.cl)) {
    rows.push([state.airfoilName, activeEngineKind() + ' (current)', state.M, state.Re, state.alphaDeg, r.cl, r.cd, r.cm ?? NaN]);
  }
  if (!rows.length) { setStatus('Nothing to export yet - run the solver or pin points first.'); return; }
  exportCSV('cfd-results.csv', ['airfoil', 'engine', 'M', 'Re', 'alpha_deg', 'Cl', 'Cd', 'Cm'], rows);
}

// ============================================================ validation

function refreshValidation() {
  const tbody = document.querySelector('#valid-table tbody');
  if (!tbody) return;
  const kind = activeEngineKind();
  const solver = (kind !== 'theory' && state.converged && state.lastForces) ? state.lastForces : null;
  let rows = [];
  try {
    rows = evaluateCase(
      {
        airfoilId: state.airfoilId, coords: state.coords, M: state.M, Re: state.Re,
        alphaDeg: state.alphaDeg, engine: kind,
        effRe: (kind === 'lbm' && state.engine) ? state.engine.effectiveRe : null,
      },
      { solver, panel: state.panelRes, theory: state.theoryRes });
  } catch (e) { console.error(e); }
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const f = (v, d = 4) => Number.isFinite(v) ? v.toFixed(d) : '-';
    tr.innerHTML =
      `<td>${r.name}</td>` +
      `<td class="num">${f(r.computed, 4)}</td>` +
      `<td class="num">${f(r.reference, 4)}${r.refSource ? `<div class="dim">${r.refSource}</div>` : ''}</td>` +
      `<td class="num">${Number.isFinite(r.delta) ? r.delta.toFixed(1) + '%' : '-'}</td>` +
      `<td><span class="pill ${r.status}">${r.status === 'warn' ? 'check' : r.status}</span></td>` +
      `<td class="dim">${r.note || ''}</td>`;
    tbody.appendChild(tr);
  }
}

// ============================================================ display helpers

function populateFields(kind) {
  const sel = $('field-select');
  sel.innerHTML = '';
  const list = kind === 'theory'
    ? [{ id: 0, name: 'Velocity magnitude (potential flow)' }]
    : FIELDS.filter(f => f.engines.includes(kind));
  for (const f of list) {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.name;
    sel.appendChild(o);
  }
  const def = kind === 'euler' ? (state.M >= 1.05 ? 4 : 2) : 0;
  const chosen = list.some(f => f.id === def) ? def : list[0].id;
  sel.value = chosen;
  setField(chosen);
}

function setField(id) {
  state.field = id;
  const f = FIELDS.find(x => x.id === id) || FIELDS[0];
  state.lo = f.lo; state.hi = f.hi; state.cmap = f.cmap;
  $('range-lo').value = f.lo; $('range-hi').value = f.hi;
  $('cmap-select').value = f.cmap;
  drawBar();
}

function drawBar() {
  const f = FIELDS.find(x => x.id === state.field) || FIELDS[0];
  drawColorbar($('colorbar'), state.lo, state.hi, state.cmap, f.name.split('(')[0].trim(), state.field === 4);
}

function updateHUD() {
  const eng = state.engine;
  const kind = activeEngineKind();
  if (kind === 'theory') {
    $('hud').textContent = 'theory engine - instant';
    return;
  }
  if (!eng) return;
  const conv = state.converged ? ` | converged (${state.convergedKind})` : '';
  $('hud').textContent =
    `${kind} ${eng.nx}x${eng.ny} | it ${eng.iter.toLocaleString()} | t* ${eng.tStar.toFixed(1)} | ${(fps * state.speed).toLocaleString()} steps/s | ${fps} fps${conv}`;
}

function resizeCanvases() {
  const wrap = $('canvas-wrap');
  const dpr = window.devicePixelRatio || 1;
  for (const id of ['gpu-canvas', 'cpu-canvas', 'overlay-canvas']) {
    const c = $(id);
    c.width = Math.max(2, Math.floor(wrap.clientWidth * dpr));
    c.height = Math.max(2, Math.floor(wrap.clientHeight * dpr));
  }
  drawOverlay();
  if (activeEngineKind() === 'theory') renderCPUSoon();
}

function drawOverlay() {
  const c = $('overlay-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const a = -state.alphaDeg * Math.PI / 180; // canvas y is down
  const cx = c.width * 0.06, cy = c.height * 0.5;
  const len = Math.min(60 * (window.devicePixelRatio || 1), c.width * 0.08);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  const ex = cx + len * Math.cos(a), ey = cy + len * Math.sin(a);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
  const ah = 7 * (window.devicePixelRatio || 1);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ah * Math.cos(a - 0.45), ey - ah * Math.sin(a - 0.45));
  ctx.lineTo(ex - ah * Math.cos(a + 0.45), ey - ah * Math.sin(a + 0.45));
  ctx.fill();
  ctx.font = `${11 * (window.devicePixelRatio || 1)}px ui-monospace`;
  ctx.fillText(`V at ${state.alphaDeg.toFixed(1)} deg`, cx - 4, cy - 12 * (window.devicePixelRatio || 1));
}

const renderCPUSoon = debounce(() => {
  if (activeEngineKind() !== 'theory') return;
  const c = $('cpu-canvas');
  try {
    renderCPUFlow(c, state.coords, state.alphaDeg, { cmap: state.cmap, lo: state.lo, hi: state.hi });
  } catch (e) { console.error(e); }
}, 180);

// ============================================================ misc

function isTabActive(name) {
  const el = $('tab-' + name);
  return el && el.classList.contains('active');
}
function setStatus(msg) { $('status-line').textContent = msg; }
function fmtRe(v) {
  const exp = Math.floor(Math.log10(v));
  return (v / Math.pow(10, exp)).toFixed(1) + 'e' + exp;
}
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// kick off (kept at end of module so all const bindings above are initialized)
init().catch(err => {
  console.error(err);
  setStatus('Initialization error: ' + err.message);
});
