// WebGPU D2Q9 Lattice-Boltzmann engine wrapper (viscous, incompressible, M < 0.3).
// Physics knob is Reynolds number; lattice inflow speed is fixed at 0.1 (Ma_lat ~ 0.17).

import { rasterize } from './airfoils.js';

const U_LAT = 0.1;          // lattice inflow speed
const RAMP_STEPS = 600;     // inflow ramp-up
const TORQUE_SCALE = 0.01;  // must match shader

export class LBMEngine {
  static async create(device, shaderCode, opts) {
    const e = new LBMEngine();
    e.type = 'lbm';
    e.device = device;
    e.nx = opts.nx; e.ny = opts.ny;
    e.ntot = e.nx * e.ny;
    e.chord = e.nx / 5.5;
    e.origin = [1.3 * e.chord, e.ny / 2];   // LE position (cells)
    e.iter = 0;
    e.stepsSinceRead = 0;
    e.fscale = 1e6;
    e.flow = { M: 0.1, Re: 2e5, alphaDeg: 4 };

    const n = e.ntot;
    e.bufA = device.createBuffer({ size: 9 * n * 4, usage: GPUBufferUsage.STORAGE });
    e.bufB = device.createBuffer({ size: 9 * n * 4, usage: GPUBufferUsage.STORAGE });
    e.solidBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    e.uni = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    e.forceBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    e.stagingBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    e.macroTex = device.createTexture({
      size: [e.nx, e.ny], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    e.macroView = e.macroTex.createView();

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: shaderCode, label: 'lbm' });
    e.pipeInit = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'init' } });
    e.pipeStep = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'step_lbm' } });

    const mkBG = (_pipe, fin, fout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: e.uni } },
        { binding: 1, resource: { buffer: fin } },
        { binding: 2, resource: { buffer: fout } },
        { binding: 3, resource: { buffer: e.solidBuf } },
        { binding: 4, resource: { buffer: e.forceBuf } },
        { binding: 5, resource: e.macroView },
      ],
    });
    e.bgStepAB = mkBG(e.pipeStep, e.bufA, e.bufB);
    e.bgStepBA = mkBG(e.pipeStep, e.bufB, e.bufA);
    e.bgInitA = mkBG(e.pipeInit, e.bufB, e.bufA);
    e.bgInitB = mkBG(e.pipeInit, e.bufA, e.bufB);
    e.parity = 0;
    e.inFlight = false;
    return e;
  }

  /** tau from Re; alpha rotates the inflow (geometry stays axis-aligned). */
  setFlow(M, Re, alphaDeg) {
    this.flow = { M, Re, alphaDeg };
    this.writeUniforms();
  }

  get tau() {
    const nu = U_LAT * this.chord / Math.max(1e3, this.flow.Re);
    return Math.max(0.5008, 3 * nu + 0.5);
  }

  writeUniforms() {
    const { alphaDeg } = this.flow;
    const ramp = Math.min(1, this.iter / RAMP_STEPS);
    const u32 = new Uint32Array([this.nx, this.ny, this.ntot, this.iter]);
    const f32 = new Float32Array([
      this.tau, U_LAT, alphaDeg * Math.PI / 180, 0.027,
      ramp, this.fscale, this.origin[0] + 0.25 * this.chord, this.origin[1],
    ]);
    const buf = new ArrayBuffer(48);
    new Uint32Array(buf, 0, 4).set(u32);
    new Float32Array(buf, 16, 8).set(f32);
    this.device.queue.writeBuffer(this.uni, 0, buf);
  }

  setGeometry(coords) {
    this.coords = coords;
    const mask = rasterize(coords, this.nx, this.ny, this.chord, this.origin[0], this.origin[1]);
    this.mask = mask;
    this.device.queue.writeBuffer(this.solidBuf, 0, mask);
  }

  reset() {
    this.iter = 0;
    this.writeUniforms();
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(this.forceBuf);
    const wg = [Math.ceil(this.nx / 16), Math.ceil(this.ny / 16)];
    for (const bg of [this.bgInitA, this.bgInitB]) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeInit);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(wg[0], wg[1]);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
    this.parity = 0;
    this.stepsSinceRead = 0;
  }

  step(n) {
    this.writeUniforms(); // ramp/iter update once per batch
    const enc = this.device.createCommandEncoder();
    const wg = [Math.ceil(this.nx / 16), Math.ceil(this.ny / 16)];
    for (let i = 0; i < n; i++) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeStep);
      pass.setBindGroup(0, this.parity === 0 ? this.bgStepAB : this.bgStepBA);
      pass.dispatchWorkgroups(wg[0], wg[1]);
      pass.end();
      this.parity ^= 1;
    }
    this.device.queue.submit([enc.finish()]);
    this.iter += n;
    this.stepsSinceRead += n;
  }

  /** Average force coefficients since last call. Returns null while a read is in flight. */
  async readForces() {
    if (this.inFlight || this.stepsSinceRead === 0) return null;
    this.inFlight = true;
    const steps = this.stepsSinceRead;
    this.stepsSinceRead = 0;
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.forceBuf, 0, this.stagingBuf, 0, 16);
    enc.clearBuffer(this.forceBuf);
    this.device.queue.submit([enc.finish()]);
    await this.stagingBuf.mapAsync(GPUMapMode.READ);
    const data = new Int32Array(this.stagingBuf.getMappedRange().slice(0));
    this.stagingBuf.unmap();
    this.inFlight = false;

    const ramp = Math.min(1, this.iter / RAMP_STEPS);
    const U = U_LAT * Math.max(ramp, 1e-3);
    const q = 0.5 * U * U;
    const Fx = data[0] / this.fscale / steps;
    const Fy = data[1] / this.fscale / steps;
    const Tz = data[2] / this.fscale / TORQUE_SCALE / steps;
    const a = this.flow.alphaDeg * Math.PI / 180;
    const cl = (Fy * Math.cos(a) - Fx * Math.sin(a)) / (q * this.chord);
    const cd = (Fx * Math.cos(a) + Fy * Math.sin(a)) / (q * this.chord);
    const cm = -Tz / (q * this.chord * this.chord);
    return { cl, cd, cm, steps, settledRamp: ramp >= 1 };
  }

  /** Nondimensional time (chords traveled). */
  get tStar() { return this.iter * U_LAT / this.chord; }

  destroy() {
    for (const b of [this.bufA, this.bufB, this.solidBuf, this.uni, this.forceBuf, this.stagingBuf]) b.destroy();
    this.macroTex.destroy();
  }
}
