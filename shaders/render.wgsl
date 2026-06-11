// Field rendering (fullscreen) + tracer particles.
// Macro texture layout (both engines): (u/U_inf, v/U_inf, density, Cp).

struct ViewParams {
  mode: u32,     // 0 speed, 1 vorticity, 2 Cp, 3 density, 4 schlieren, 5 temperature, 6 local Mach
  cmap: u32,     // 0 viridis, 1 inferno, 2 diverging
  nx: f32,
  ny: f32,
  lo: f32,
  hi: f32,
  minf: f32,
  gamma: f32,
  bodyMix: f32,
  vcx: f32,   // view center (uv space)
  vcy: f32,
  vzoom: f32, // 1 = full domain
};

@group(0) @binding(0) var<uniform> V: ViewParams;
@group(0) @binding(1) var macroTex: texture_2d<f32>;
@group(0) @binding(2) var maskTex: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsField(@builtin(vertex_index) vi: u32) -> VSOut {
  // fullscreen triangle
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = (p[vi] + 1.0) * 0.5;
  return o;
}

// ---- colormaps (polynomial fits, Matt Zucker) ----
fn viridis(t: f32) -> vec3f {
  let c0 = vec3f(0.2777273, 0.0054073, 0.3340998);
  let c1 = vec3f(0.1050930, 1.4046135, 1.3845902);
  let c2 = vec3f(-0.3308618, 0.2148476, 0.0950952);
  let c3 = vec3f(-4.6342305, -5.7991010, -19.3324410);
  let c4 = vec3f(6.2282699, 14.1799334, 56.6905526);
  let c5 = vec3f(4.7763850, -13.7451454, -65.3530326);
  let c6 = vec3f(-5.4354559, 4.6458526, 26.3124352);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
fn inferno(t: f32) -> vec3f {
  let c0 = vec3f(0.0002189, 0.0016510, -0.0194809);
  let c1 = vec3f(0.1065134, 0.5639564, 3.9327124);
  let c2 = vec3f(11.6024931, -3.9728540, -15.9423941);
  let c3 = vec3f(-41.7039961, 17.4363989, 44.3541452);
  let c4 = vec3f(77.1629357, -33.4023589, -81.8073093);
  let c5 = vec3f(-71.3194282, 32.6260643, 73.2095199);
  let c6 = vec3f(25.1311262, -12.2426690, -23.0703250);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
fn diverging(t: f32) -> vec3f { // blue - white - red
  let blue = vec3f(0.230, 0.299, 0.754);
  let white = vec3f(0.93, 0.93, 0.93);
  let red = vec3f(0.706, 0.016, 0.150);
  if (t < 0.5) { return mix(blue, white, t * 2.0); }
  return mix(white, red, (t - 0.5) * 2.0);
}
fn colormap(t: f32, id: u32) -> vec3f {
  let tc = clamp(t, 0.0, 1.0);
  if (id == 1u) { return clamp(inferno(tc), vec3f(0.0), vec3f(1.0)); }
  if (id == 2u) { return diverging(tc); }
  return clamp(viridis(tc), vec3f(0.0), vec3f(1.0));
}

// Footprint-aware fetch: with fine grids the field is minified several
// texels per screen pixel, and plain bilinear sampling aliases - cell-scale
// detail shows up as speckle/"dithering". Box-average 4 taps when minified.
fn boxSample(uv: vec2f, ddx: vec2f, ddy: vec2f, minified: bool) -> vec4f {
  if (!minified) { return textureSampleLevel(macroTex, smp, uv, 0.0); }
  return 0.25 * (
    textureSampleLevel(macroTex, smp, uv + 0.3 * ddx + 0.3 * ddy, 0.0) +
    textureSampleLevel(macroTex, smp, uv - 0.3 * ddx + 0.3 * ddy, 0.0) +
    textureSampleLevel(macroTex, smp, uv + 0.3 * ddx - 0.3 * ddy, 0.0) +
    textureSampleLevel(macroTex, smp, uv - 0.3 * ddx - 0.3 * ddy, 0.0));
}

@fragment
fn fsField(inp: VSOut) -> @location(0) vec4f {
  // screen uv -> world uv through the zoom view
  let uv = vec2f(V.vcx, V.vcy) + (inp.uv - 0.5) / max(V.vzoom, 1.0);
  let texel = vec2f(1.0 / V.nx, 1.0 / V.ny);
  let ddx = dpdx(uv);
  let ddy = dpdy(uv);
  let minified = max(abs(ddx.x) * V.nx, abs(ddy.y) * V.ny) > 1.5;
  let m = boxSample(uv, ddx, ddy, minified);
  var s: f32 = 0.0;

  switch V.mode {
    case 0u: { s = length(m.xy); }
    case 1u: { // vorticity (per-cell central difference)
      let mxp = boxSample(uv + vec2f(texel.x, 0.0), ddx, ddy, minified);
      let mxm = boxSample(uv - vec2f(texel.x, 0.0), ddx, ddy, minified);
      let myp = boxSample(uv + vec2f(0.0, texel.y), ddx, ddy, minified);
      let mym = boxSample(uv - vec2f(0.0, texel.y), ddx, ddy, minified);
      s = 0.5 * ((mxp.y - mxm.y) - (myp.x - mym.x));
    }
    case 2u: { s = m.w; }
    case 3u: { s = m.z; }
    case 4u: { // numerical schlieren |grad rho|
      let mxp = boxSample(uv + vec2f(texel.x, 0.0), ddx, ddy, minified);
      let mxm = boxSample(uv - vec2f(texel.x, 0.0), ddx, ddy, minified);
      let myp = boxSample(uv + vec2f(0.0, texel.y), ddx, ddy, minified);
      let mym = boxSample(uv - vec2f(0.0, texel.y), ddx, ddy, minified);
      let g = 0.5 * vec2f(mxp.z - mxm.z, myp.z - mym.z);
      s = length(g);
    }
    case 5u: { // temperature ratio T/T_inf
      let pr = 1.0 + 0.5 * V.gamma * V.minf * V.minf * m.w;
      s = max(pr, 1e-4) / max(m.z, 1e-4);
    }
    case 6u: { // local Mach
      let pr = 1.0 + 0.5 * V.gamma * V.minf * V.minf * m.w;
      let That = max(pr, 1e-4) / max(m.z, 1e-4);
      s = length(m.xy) * V.minf / sqrt(That);
    }
    default: { s = 0.0; }
  }

  var rgb: vec3f;
  if (V.mode == 4u) {
    // schlieren: white background, dark gradients; V.hi = sensitivity
    let v = 1.0 - exp(-s * V.hi);
    rgb = vec3f(1.0 - 0.92 * v);
  } else {
    let t = (s - V.lo) / max(V.hi - V.lo, 1e-9);
    rgb = colormap(t, V.cmap);
  }

  // solid body overlay
  let msk = textureSampleLevel(maskTex, smp, uv, 0.0).r;
  let body = vec3f(0.10, 0.12, 0.16);
  rgb = mix(rgb, body, smoothstep(0.35, 0.65, msk) * V.bodyMix);
  return vec4f(rgb, 1.0);
}

// ============================ particles ============================

struct PartParams {
  nx: f32,
  ny: f32,
  count: u32,
  seed: u32,
  dt: f32,      // cells per frame at |u/U|=1
  size: f32,    // half-size in pixels (clip conversion done in JS-provided scale)
  sx: f32,      // half-size in clip units x
  sy: f32,      // half-size in clip units y
  vcx: f32,     // view center / zoom (match ViewParams)
  vcy: f32,
  vzoom: f32,
  sideFrac: f32, // fraction of respawns on the bottom (+) / top (-) edge
};

@group(0) @binding(0) var<uniform> PP: PartParams;
@group(0) @binding(1) var<storage, read_write> parts: array<vec2f>;
@group(0) @binding(2) var macroTexP: texture_2d<f32>;
@group(0) @binding(3) var maskTexP: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> partsR: array<vec2f>; // read-only view for vertex stage

fn hash2(n: u32) -> vec2f {
  var x = n;
  x = x * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  let a = f32((x >> 16u) & 0xffffu) / 65535.0;
  var y = n ^ 0x9e3779b9u;
  y = y * 747796405u + 2891336453u;
  y = ((y >> ((y >> 28u) + 4u)) ^ y) * 277803737u;
  let b = f32((y >> 16u) & 0xffffu) / 65535.0;
  return vec2f(a, b);
}

fn velAt(p: vec2f) -> vec2f {
  let x = clamp(p.x, 0.5, PP.nx - 1.5);
  let y = clamp(p.y, 0.5, PP.ny - 1.5);
  let x0 = i32(floor(x - 0.5)); let y0 = i32(floor(y - 0.5));
  let fx = x - 0.5 - f32(x0); let fy = y - 0.5 - f32(y0);
  let v00 = textureLoad(macroTexP, vec2i(x0, y0), 0).xy;
  let v10 = textureLoad(macroTexP, vec2i(x0 + 1, y0), 0).xy;
  let v01 = textureLoad(macroTexP, vec2i(x0, y0 + 1), 0).xy;
  let v11 = textureLoad(macroTexP, vec2i(x0 + 1, y0 + 1), 0).xy;
  return mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);
}

@compute @workgroup_size(256)
fn advect(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= PP.count) { return; }
  var p = parts[i];
  let v = velAt(p);
  // RK2 midpoint
  let pm = p + 0.5 * PP.dt * v;
  p += PP.dt * velAt(pm);

  var dead = false;
  if (p.x < 0.0 || p.x >= PP.nx || p.y < 1.0 || p.y >= PP.ny - 1.0) { dead = true; }
  let mi = vec2i(i32(clamp(p.x, 0.0, PP.nx - 1.0)), i32(clamp(p.y, 0.0, PP.ny - 1.0)));
  if (textureLoad(maskTexP, mi, 0).r > 0.5) { dead = true; }
  // occasional respawn to keep seeding fresh
  let h = hash2(i * 7919u + PP.seed);
  if (h.x < 0.002) { dead = true; }
  if (dead) {
    let r = hash2(i * 2654435761u + PP.seed * 668265263u);
    let r2 = hash2(i * 374761393u + PP.seed * 2246822519u);
    // C-shaped inlet: at angle of attack the freestream also enters through
    // the bottom (alpha > 0) or top (alpha < 0) boundary, not just the left
    if (r2.x < abs(PP.sideFrac)) {
      let x = r.x * PP.nx * 0.85;
      if (PP.sideFrac > 0.0) { p = vec2f(x, 1.0 + r.y * 3.0); }
      else { p = vec2f(x, PP.ny - 2.0 - r.y * 3.0); }
    } else {
      p = vec2f(r.x * 3.0, 1.0 + r.y * (PP.ny - 2.0));
    }
  }
  parts[i] = p;
}

struct PVSOut { @builtin(position) pos: vec4f, @location(0) q: vec2f };

@vertex
fn vsParticle(@builtin(vertex_index) vi: u32) -> PVSOut {
  let pi = vi / 6u;
  let corner = vi % 6u;
  var off = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let p = partsR[pi];
  // world uv -> screen uv through the zoom view -> clip
  let suv = (vec2f(p.x / PP.nx, p.y / PP.ny) - vec2f(PP.vcx, PP.vcy)) * max(PP.vzoom, 1.0) + 0.5;
  let clip = suv * 2.0 - 1.0;
  var o: PVSOut;
  o.pos = vec4f(clip + off[corner] * vec2f(PP.sx, PP.sy), 0.0, 1.0);
  o.q = off[corner];
  return o;
}

@fragment
fn fsParticle(inp: PVSOut) -> @location(0) vec4f {
  let r2 = dot(inp.q, inp.q);
  if (r2 > 1.0) { discard; }
  // subtle: dense bright dots read as field noise ("dithering") in stills
  return vec4f(0.95, 0.97, 1.0, 0.16 * (1.0 - r2));
}
