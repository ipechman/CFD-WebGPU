// WebGPU field renderer + tracer particles + readback utilities.

export const FIELDS = [
  { id: 0, name: 'Velocity magnitude', lo: 0, hi: 1.8, cmap: 0, engines: ['lbm', 'euler'] },
  { id: 1, name: 'Vorticity', lo: -0.18, hi: 0.18, cmap: 2, engines: ['lbm'] },
  { id: 2, name: 'Pressure (Cp)', lo: -2.0, hi: 1.2, cmap: 2, engines: ['lbm', 'euler'] },
  { id: 3, name: 'Density (rho/rho_inf)', lo: 0.5, hi: 2.0, cmap: 0, engines: ['euler'] },
  { id: 4, name: 'Schlieren |grad rho|', lo: 0, hi: 28, cmap: 0, engines: ['euler'] },
  { id: 5, name: 'Temperature (T/T_inf)', lo: 0.8, hi: 3.0, cmap: 1, engines: ['euler'] },
  { id: 6, name: 'Local Mach', lo: 0, hi: 2.5, cmap: 0, engines: ['euler'] },
];

const N_PARTICLES = 16384;

export class Renderer {
  static async create(device, canvas, shaderCode) {
    const r = new Renderer();
    r.device = device;
    r.canvas = canvas;
    r.ctx = canvas.getContext('webgpu');
    r.format = navigator.gpu.getPreferredCanvasFormat();
    r.ctx.configure({ device, format: r.format, alphaMode: 'opaque' });

    const module = device.createShaderModule({ code: shaderCode, label: 'render' });

    r.fieldBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    r.fieldPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [r.fieldBGL] }),
      vertex: { module, entryPoint: 'vsField' },
      fragment: { module, entryPoint: 'fsField', targets: [{ format: r.format }] },
      primitive: { topology: 'triangle-list' },
    });

    r.advectBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      ],
    });
    r.advectPipe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [r.advectBGL] }),
      compute: { module, entryPoint: 'advect' },
    });

    r.partBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    r.partPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [r.partBGL] }),
      vertex: { module, entryPoint: 'vsParticle' },
      fragment: {
        module, entryPoint: 'fsParticle',
        targets: [{
          format: r.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    r.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    r.viewUni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.partUni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    r.partBuf = device.createBuffer({ size: N_PARTICLES * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    r.frame = 0;
    return r;
  }

  /** Build per-engine resources (mask texture + bind groups). Call on engine/geometry change. */
  attach(engine) {
    const { device } = this;
    const { nx, ny } = engine;
    if (this.maskTex) this.maskTex.destroy();
    this.maskTex = device.createTexture({
      size: [nx, ny], format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uploadMask(engine);
    const maskView = this.maskTex.createView();
    this.fieldBG = device.createBindGroup({
      layout: this.fieldBGL,
      entries: [
        { binding: 0, resource: { buffer: this.viewUni } },
        { binding: 1, resource: engine.macroView },
        { binding: 2, resource: maskView },
        { binding: 3, resource: this.sampler },
      ],
    });
    this.advectBG = device.createBindGroup({
      layout: this.advectBGL,
      entries: [
        { binding: 0, resource: { buffer: this.partUni } },
        { binding: 1, resource: { buffer: this.partBuf } },
        { binding: 2, resource: engine.macroView },
        { binding: 3, resource: maskView },
      ],
    });
    this.partBG = device.createBindGroup({
      layout: this.partBGL,
      entries: [
        { binding: 0, resource: { buffer: this.partUni } },
        { binding: 4, resource: { buffer: this.partBuf } },
      ],
    });
    this.engine = engine;
    this.seedParticles(engine);
  }

  uploadMask(engine) {
    const { nx, ny } = engine;
    const bytes = new Uint8Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) bytes[i] = engine.mask && engine.mask[i] ? 255 : 0;
    this.device.queue.writeTexture({ texture: this.maskTex }, bytes, { bytesPerRow: nx }, [nx, ny]);
  }

  seedParticles(engine) {
    const data = new Float32Array(N_PARTICLES * 2);
    for (let i = 0; i < N_PARTICLES; i++) {
      data[2 * i] = Math.random() * engine.nx;
      data[2 * i + 1] = 1 + Math.random() * (engine.ny - 2);
    }
    this.device.queue.writeBuffer(this.partBuf, 0, data);
  }

  render(opts) {
    const { engine } = this;
    if (!engine) return;
    const { mode, cmap, lo, hi, particles, minf, partSpeed } = opts;
    const zv = opts.view || { cx: 0.5, cy: 0.5, zoom: 1 };
    const dev = this.device;
    this.frame++;

    const vbuf = new ArrayBuffer(48);
    new Uint32Array(vbuf, 0, 2).set([mode, cmap]);
    new Float32Array(vbuf, 8, 10).set([
      engine.nx, engine.ny, lo, hi, minf, 1.4, 1.0, zv.cx, zv.cy, zv.zoom,
    ]);
    dev.queue.writeBuffer(this.viewUni, 0, vbuf);

    const pbuf = new ArrayBuffer(48);
    new Float32Array(pbuf, 0, 2).set([engine.nx, engine.ny]);
    new Uint32Array(pbuf, 8, 2).set([N_PARTICLES, this.frame]);
    const pxClipX = 2 / this.canvas.width * 1.25 * (window.devicePixelRatio || 1);
    const pxClipY = 2 / this.canvas.height * 1.25 * (window.devicePixelRatio || 1);
    // C-shaped particle inlet: split respawns between the left edge and the
    // windward (bottom/top) edge in proportion to the inflow flux per edge
    const aRad = (opts.alphaDeg || 0) * Math.PI / 180;
    const sideFlux = Math.abs(Math.sin(aRad)) * engine.nx;
    const leftFlux = Math.max(Math.cos(aRad), 0.1) * engine.ny;
    const sideFrac = Math.sign(aRad) * sideFlux / (sideFlux + leftFlux);
    new Float32Array(pbuf, 16, 8).set([partSpeed || 1.5, 1.6, pxClipX, pxClipY, zv.cx, zv.cy, zv.zoom, sideFrac]);
    dev.queue.writeBuffer(this.partUni, 0, pbuf);

    const enc = dev.createCommandEncoder();
    if (particles) {
      const cp = enc.beginComputePass();
      cp.setPipeline(this.advectPipe);
      cp.setBindGroup(0, this.advectBG);
      cp.dispatchWorkgroups(Math.ceil(N_PARTICLES / 256));
      cp.end();
    }
    const view = this.ctx.getCurrentTexture().createView();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }],
    });
    rp.setPipeline(this.fieldPipe);
    rp.setBindGroup(0, this.fieldBG);
    rp.draw(3);
    if (particles) {
      rp.setPipeline(this.partPipe);
      rp.setBindGroup(0, this.partBG);
      rp.draw(N_PARTICLES * 6);
    }
    rp.end();
    dev.queue.submit([enc.finish()]);
  }

  /** Read macro texture back to CPU as Float32Array [nx*ny*4] (u, v, rho, Cp). */
  async readMacro() {
    const { engine, device } = this;
    const { nx, ny } = engine;
    const size = nx * ny * 8;
    if (!this.readBuf || this.readBufSize !== size) {
      if (this.readBuf) this.readBuf.destroy();
      this.readBuf = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.readBufSize = size;
    }
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: engine.macroTex }, { buffer: this.readBuf, bytesPerRow: nx * 8, rowsPerImage: ny }, [nx, ny]);
    device.queue.submit([enc.finish()]);
    await this.readBuf.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(this.readBuf.getMappedRange().slice(0));
    this.readBuf.unmap();
    const out = new Float32Array(nx * ny * 4);
    for (let i = 0; i < out.length; i++) out[i] = halfToFloat(raw[i]);
    return out;
  }
}

export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * Math.pow(2, -24);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

// ---- JS colormap mirrors (for colorbar) ----
function poly(t, C) {
  let r = [0, 0, 0];
  for (let i = C.length - 1; i >= 0; i--) for (let k = 0; k < 3; k++) r[k] = r[k] * t + C[i][k];
  return r.map(v => Math.max(0, Math.min(1, v)));
}
const VIR = [[0.2777273, 0.0054073, 0.3340998], [0.1050930, 1.4046135, 1.3845902], [-0.3308618, 0.2148476, 0.0950952], [-4.6342305, -5.7991010, -19.3324410], [6.2282699, 14.1799334, 56.6905526], [4.7763850, -13.7451454, -65.3530326], [-5.4354559, 4.6458526, 26.3124352]];
const INF = [[0.0002189, 0.0016510, -0.0194809], [0.1065134, 0.5639564, 3.9327124], [11.6024931, -3.9728540, -15.9423941], [-41.7039961, 17.4363989, 44.3541452], [77.1629357, -33.4023589, -81.8073093], [-71.3194282, 32.6260643, 73.2095199], [25.1311262, -12.2426690, -23.0703250]];

export function cmapJS(t, id) {
  t = Math.max(0, Math.min(1, t));
  if (id === 1) return poly(t, INF);
  if (id === 2) {
    const b = [0.230, 0.299, 0.754], w = [0.93, 0.93, 0.93], r = [0.706, 0.016, 0.150];
    const mix = (a, c, s) => a.map((v, i) => v + (c[i] - v) * s);
    return t < 0.5 ? mix(b, w, t * 2) : mix(w, r, (t - 0.5) * 2);
  }
  return poly(t, VIR);
}

export function drawColorbar(canvas, lo, hi, cmapId, label, schlieren = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const barH = 10, y0 = 4;
  for (let i = 0; i < W; i++) {
    const t = i / (W - 1);
    let rgb;
    if (schlieren) { const v = t; rgb = [1 - 0.92 * v, 1 - 0.92 * v, 1 - 0.92 * v]; }
    else rgb = cmapJS(t, cmapId);
    ctx.fillStyle = `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;
    ctx.fillRect(i, y0, 1, barH);
  }
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(schlieren ? '0' : fmt(lo), 0, y0 + barH + 11);
  ctx.textAlign = 'right';
  ctx.fillText(schlieren ? 'max' : fmt(hi), W, y0 + barH + 11);
  ctx.textAlign = 'center';
  ctx.fillText(label, W / 2, y0 + barH + 11);
  function fmt(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2); }
}
