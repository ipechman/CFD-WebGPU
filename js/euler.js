// WebGPU compressible Euler engine wrapper (inviscid, M 0.3 - 6, shock capturing).

import { rasterize } from './airfoils.js';

const TORQUE_SCALE = 0.01; // must match shader

function bindLayout(device) {
  return device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });
}

export class EulerEngine {
  static async create(device, shaderCode, opts) {
    const e = new EulerEngine();
    e.type = 'euler';
    e.device = device;
    e.nx = opts.nx; e.ny = opts.ny;
    e.ntot = e.nx * e.ny;
    // characteristic far-field BCs absorb waves, so boundaries can sit closer:
    // spend the domain on surface resolution (staircase error drops ~1/N)
    e.chord = e.nx / 5.5;
    e.origin = [1.7 * e.chord, e.ny / 2];
    e.iter = 0;
    e.stepsSinceRead = 0;
    e.fscale = 1000;
    e.flow = { M: 2, Re: 1e6, alphaDeg: 2 };

    const n = e.ntot;
    e.bufA = device.createBuffer({ size: 16 * n, usage: GPUBufferUsage.STORAGE });
    e.bufB = device.createBuffer({ size: 16 * n, usage: GPUBufferUsage.STORAGE });
    e.solidBuf = device.createBuffer({ size: 4 * n, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    e.forceBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    e.stagingBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    e.macroTex = device.createTexture({
      size: [e.nx, e.ny], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    e.macroView = e.macroTex.createView();

    // 4 uniform variants: (axis, writeMacro) = (0,0), (1,1), (1,0), (0,1)
    e.uniCombos = [[0, 0], [1, 1], [1, 0], [0, 1]];
    e.unis = e.uniCombos.map(() => device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

    const layout = bindLayout(device);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ code: shaderCode, label: 'euler' });
    e.pipeInit = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'init' } });
    e.pipeSweep = device.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'sweep' } });

    const mkBG = (uni, fin, fout) => device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: fin } },
        { binding: 2, resource: { buffer: fout } },
        { binding: 3, resource: { buffer: e.solidBuf } },
        { binding: 4, resource: { buffer: e.forceBuf } },
        { binding: 5, resource: e.macroView },
      ],
    });
    // even step: bg[0] (x, A->B) then bg[1] (y w/macro, B->A)
    // odd step:  bg[2] (y, A->B) then bg[3] (x w/macro, B->A)
    e.bgs = [
      mkBG(e.unis[0], e.bufA, e.bufB),
      mkBG(e.unis[1], e.bufB, e.bufA),
      mkBG(e.unis[2], e.bufA, e.bufB),
      mkBG(e.unis[3], e.bufB, e.bufA),
    ];
    e.bgInit = [mkBG(e.unis[0], e.bufB, e.bufA), mkBG(e.unis[0], e.bufA, e.bufB)];
    return e;
  }

  setFlow(M, Re, alphaDeg) {
    const newM = Math.max(0.05, M);
    // live Mach changes leave a "hot" field at the old speeds; size dt for the
    // larger of old/new M until the transient washes out (decayed in step()),
    // otherwise lowering M on a hot field violates CFL and NaN-floods the grid
    this.mHot = Math.max(this.mHot || 0, this.flow ? this.flow.M : 0, newM);
    this.flow = { M: newM, Re, alphaDeg };
    // adaptive fixed-point scale: high-M stagnation pressures need headroom in i32 atomics
    const fs = this.flow.M >= 3 ? 250 : 1000;
    if (fs !== this.fscale) {
      this.fscale = fs;
      this.stepsSinceRead = 0;
      const enc = this.device.createCommandEncoder();
      enc.clearBuffer(this.forceBuf);
      this.device.queue.submit([enc.finish()]);
    }
    this.writeUniforms();
  }

  get dtdx() {
    const M = Math.max(this.flow.M, this.mHot || 0);
    const denom = 1.15 * Math.max(M + 1, Math.min(2.2 * M + 1.1, M + 2));
    return 0.65 / denom;
  }

  writeUniforms() {
    const a = this.flow.alphaDeg * Math.PI / 180;
    // velocity bound from total enthalpy at the hottest recent Mach (+25%)
    const mEff = Math.max(this.flow.M, this.mHot || 0);
    const vmax = 1.25 * Math.sqrt(mEff * mEff + 2 / 0.4);
    for (let i = 0; i < 4; i++) {
      const [axis, wm] = this.uniCombos[i];
      const buf = new ArrayBuffer(48);
      new Uint32Array(buf, 0, 4).set([this.nx, this.ny, axis, wm]);
      new Float32Array(buf, 16, 8).set([
        this.dtdx, 1.4, this.flow.M, a,
        this.fscale, this.origin[0] + 0.25 * this.chord, this.origin[1], vmax,
      ]);
      this.device.queue.writeBuffer(this.unis[i], 0, buf);
    }
  }

  setGeometry(coords) {
    this.coords = coords;
    this.mask = rasterize(coords, this.nx, this.ny, this.chord, this.origin[0], this.origin[1]);
    this.device.queue.writeBuffer(this.solidBuf, 0, this.mask);
  }

  reset() {
    this.iter = 0;
    this.mHot = this.flow.M; // fresh field carries no hot transient
    this.writeUniforms();
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(this.forceBuf);
    const wg = [Math.ceil(this.nx / 16), Math.ceil(this.ny / 16)];
    for (const bg of this.bgInit) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeInit);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(wg[0], wg[1]);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
    this.stepsSinceRead = 0;
  }

  step(n) {
    if ((this.mHot || 0) > this.flow.M + 1e-6) {
      // relax the hot-field guard as the old flow flushes out: ~20% per chord
      // of travel (the domain takes ~7 chord-times to refill at the new speed)
      const chords = n / this.stepsPerChord;
      this.mHot = Math.max(this.flow.M, this.mHot * Math.pow(0.8, chords));
      this.writeUniforms();
    }
    const enc = this.device.createCommandEncoder();
    const wg = [Math.ceil(this.nx / 16), Math.ceil(this.ny / 16)];
    for (let i = 0; i < n; i++) {
      const pair = (this.iter + i) % 2 === 0 ? [this.bgs[0], this.bgs[1]] : [this.bgs[2], this.bgs[3]];
      for (const bg of pair) {
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipeSweep);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(wg[0], wg[1]);
        pass.end();
      }
    }
    this.device.queue.submit([enc.finish()]);
    this.iter += n;
    this.stepsSinceRead += n;
  }

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

    const M = this.flow.M;
    const q = 0.5 * M * M; // rho_inf = 1, a_inf = 1
    const Fx = data[0] / this.fscale / steps;
    const Fy = data[1] / this.fscale / steps;
    const Tz = data[2] / this.fscale / TORQUE_SCALE / steps;
    const a = this.flow.alphaDeg * Math.PI / 180;
    const cl = (Fy * Math.cos(a) - Fx * Math.sin(a)) / (q * this.chord);
    const cd = (Fx * Math.cos(a) + Fy * Math.sin(a)) / (q * this.chord);
    const cm = -Tz / (q * this.chord * this.chord);
    return { cl, cd, cm, steps, settledRamp: true };
  }

  /** Nondimensional time (chords traveled at U_inf). */
  get tStar() { return this.iter * this.dtdx * this.flow.M / this.chord; }

  /** Solver steps for the flow to travel one chord length. */
  get stepsPerChord() { return this.chord / (this.dtdx * Math.max(this.flow.M, 0.05)); }

  destroy() {
    for (const b of [this.bufA, this.bufB, this.solidBuf, this.forceBuf, this.stagingBuf, ...this.unis]) b.destroy();
    this.macroTex.destroy();
  }
}
