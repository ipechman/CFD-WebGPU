# Airfoil CFD Lab — WebGPU

Interactive 2D airfoil aerodynamics in the browser. Three solvers cover Mach 0–6, run entirely client-side (GitHub Pages friendly, no backend, no build step), and every result is checked against wind-tunnel data or exact theory in a built-in **Validation** tab.

## Engines

| Engine | Method | Regime | Physics |
|---|---|---|---|
| **LBM** | D2Q9 lattice-Boltzmann, BGK + Smagorinsky LES, momentum-exchange forces | M < 0.3 | Viscous, unsteady — Reynolds number is the knob; vortex shedding, separation |
| **Euler** | Finite volume, MUSCL + minmod, HLLC, dimensional splitting, immersed boundary | M 0.3–6 | Compressible, inviscid — shocks, expansion fans, transonic buffet, bow shocks |
| **Theory** | Hess-Smith panel method (+ Kármán-Tsien), Ackeret linearized theory, exact shock-expansion (diamond) | instant | No GPU needed; also powers reference overlays |

Auto mode picks LBM below M 0.3 and Euler above. Both GPU engines rotate the *inflow* for angle of attack, so geometry changes never re-rasterize on an α change.

## Features

- Airfoil database: NACA 4/5-digit generators (any code), Clark Y, RAE 2822, S1223, E387, S809 (UIUC coordinates), diamond wedge, flat plate, plus **custom .dat paste/upload** (Selig & Lednicer formats)
- Mach 0–6, Re 10³–10⁸, α −15°…+20°, three grid resolutions, live parameter changes
- Fields: velocity, vorticity, Cp, density, numerical schlieren, temperature, local Mach — viridis/inferno/diverging colormaps, tracer particles
- Plots: surface Cp (panel/Ackeret lines + solver samples), lift polar with wind-tunnel anchors, drag polar, force history; automatic **α-sweep**; CSV export
- Readouts: C_L, C_D, C_M(c/4), L/D with convergence detection
- Works without WebGPU too (Theory engine + CPU potential-flow rendering)

## Validation (the point of this project)

Every converged run is compared automatically against the best available reference:

- **NACA 0012 / 2412 / 4412** — Abbott & von Doenhoff (1959) wind-tunnel polars, Re 6×10⁶
- **RAE 2822 Case 6** — AGARD AR-138 transonic benchmark (M 0.725, Cl 0.743)
- **Diamond airfoil** — exact oblique-shock + Prandtl-Meyer solution (supersonic)
- **Ackeret / thin-airfoil / Prandtl-Glauert** — linearized theory across the range
- **Panel method** — d'Alembert self-consistency, lift-slope cross-check

The CI-style test suite (`node tests/run_all.mjs`, 77 checks, no GPU required) validates the numerics themselves:

- HLLC + MUSCL flux math vs **exact Riemann solution** (Sod tube, L1 error < 0.002)
- LBM collision/streaming vs **Taylor-Green vortex** analytic decay (< 0.5% error)
- Panel method vs thin-airfoil theory and A&vD anchors (lift slope, α₀, C_m)
- Shock relations vs Anderson's tables (β, p₂/p₁, ν(M) exact to table precision)
- WGSL shader structural sanity

### Honest limitations

Staircase immersed boundaries (~5–15% force error, improves with grid), no transition modeling, LBM under-resolves boundary layers above Re ≈ 10⁵ (C_D indicative; C_L fine), Euler is inviscid (use the supplied empirical friction C_D₀ for totals), calorically perfect gas (above M ≈ 4–5 treat as qualitative). The Validation tab states the trust level for every regime. Educational tool — not for certification.

## Run locally

Any static server works (ES modules need http, not file://):

```bash
cd CFD-WebGPU
python -m http.server 8000     # or: npx serve
# open http://localhost:8000
```

WebGPU requires Chrome/Edge 113+, Safari 18+, or Firefox 141+.

## Deploy to GitHub Pages

1. Create a GitHub repo and push this folder (`main` branch).
2. Repo **Settings → Pages → Source: GitHub Actions** — the included `.github/workflows/deploy.yml` publishes on every push.
   (Alternative: Source: *Deploy from a branch* → `main` / root. The `.nojekyll` file is already there.)
3. Open `https://<user>.github.io/<repo>/`.

## Tests

```bash
node tests/run_all.mjs
```

## Architecture

```
index.html, css/style.css      UI shell (no frameworks, no build step)
js/main.js                     orchestration, run loop, charts/validation wiring
js/airfoils.js, airfoil-data.js  NACA generators, UIUC coords, .dat parser, rasterizer
js/panel.js                    Hess-Smith panel method (CPU)
js/theory.js                   PG/KT corrections, Ackeret, oblique shock + PM, friction drag
js/lbm.js + shaders/lbm.wgsl   D2Q9 LBM engine (WebGPU compute)
js/euler.js + shaders/euler.wgsl  compressible Euler engine (WebGPU compute)
js/viz.js + shaders/render.wgsl   field rendering, colormaps, particles, readback
js/charts.js                   dependency-free canvas plots
js/validation.js               reference data + auto-comparison
js/cpuflow.js                  no-GPU potential-flow visualization
tests/                         headless validation suite (Node, no GPU)
```

## Credits

Airfoil coordinates: [UIUC Airfoil Coordinates Database](https://m-selig.ae.illinois.edu/ads/coord_database.html) (M. Selig). Wind-tunnel data: Abbott & von Doenhoff, *Theory of Wing Sections* (1959). RAE 2822: Cook, McDonald & Firmin, AGARD AR-138. Colormap fits: M. Zucker. Numerical methods: Toro (HLLC), Moran (panel), Anderson (compressible relations).

MIT License.
