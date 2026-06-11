# Kaizen log

Continuous small improvements. Every entry is a small, shippable change with a reason.
Add new entries at the top of the changelog; pull backlog items from the list below.

## Changelog

### v0.1.17 — 2026-06-11
- Fix: **choked steep-cone ducts "broke" the simulation** (repro: A_in/A_t=2,
  A_ex/A_t=3, M0.4 → 27° diffuser half-angle; real nozzles separate above
  ~15°). The detached jet evacuates wall pockets to the clamp floors and the
  scrub's freestream injection detonated inside the supersonic jet. Now:
  non-finite cells freeze their previous state (freestream only if that too
  is poisoned), duct mode runs a stiffer CFL margin (0.48 vs 0.65), the duct
  builder warns when a cone exceeds ~18°, and the exit measurement excludes
  vacuum/backflow cells — reporting "exit plane N% separated - not
  measurable" (info) instead of a garbage Mach 24 "fail" when the jet
  detaches. Gentle nozzles still validate (exit M 0.536 vs 0.471 subsonic
  branch, check; the honest filter no longer counts stagnant wall cells that
  previously flattered the average).

### v0.1.16 — 2026-06-11
- Fix: **C-shaped particle inlet** — particles respawned only on the left
  edge, so at angle of attack the streamlines entering through the windward
  (bottom/top) boundary carried no particles and "flow only came from the
  left". Respawns now split between the left and windward edges in proportion
  to the inflow flux per edge. (The physics boundaries already admitted flow
  on all sides; this was visualization-only.)
- Fix: **oversized ducts** — the throat half-height was fixed at 0.5c, so
  area ratios near 4 wanted ±2-chord sections in a ±1.4-chord domain. The
  throat now auto-shrinks so the widest section fits with margin; area
  *ratios* (the physics) are unchanged.

### v0.1.15 — 2026-06-11
- Fix: the remaining "dithering" on both engines was the **tracer particles**
  — 16k bright semi-transparent dots reading as field noise over the (now
  smooth) fields. Verified by cell-level probes (LBM |ΔV| ~ 3e-4/cell) and
  particles-off screenshots: both engines' converged fields are clean.
  Particle alpha 0.35 → 0.16 and size reduced ~20%; uncheck "Particles" for
  the raw field. Early-run graininess during the inflow ramp is display
  normalization by the still-small inflow and fades within the first chords.

### v0.1.14 — 2026-06-10
- Fix: **periodic pressure waves from the LBM outflow** (user repro: S1223,
  M0.12, Re 4e4, α14.5). The outlet copied each cell's own previous
  populations — acoustically reflective, so every shed vortex fired a wave
  back upstream at the shedding frequency, contaminating the whole domain
  (probe row aft of the wing: mean Cp −2.4, σ 1.7, spikes to −8.6). Now an
  absorbing sponge (last nx/16 columns, density→ambient with velocity kept)
  plus spatial-extrapolation outflow. Same probe row after: mean +0.07,
  σ 0.57 — only real vortex cores remain; the case now converges
  (time-averaged, 31 chords) instead of hitting the cap.
- The reflections had been *driving* the exaggerated shedding everywhere:
  the 2412 M0.1 Re2e5 α4 anchor went from Cl 0.99±0.05 (52% high vs A&vD,
  oscillating) to **0.591 steady-ish (9% low)** — the long-standing LBM
  lift overshoot was largely outlet feedback.
- Duct exit measurement plane moved upstream of the sponge.

### v0.1.13 — 2026-06-10
- Add: **parametric ducts / nozzles / diffusers** (sidebar panel): set
  A_in/A_throat, A_exit/A_throat and the two cone lengths; the geometry is
  built as two wall polygons (multi-polygon rasterizer + Bouzidi/ghost-fluid
  machinery reused as-is). The theory line shows the quasi-1D isentropic
  prediction (choking, throat/exit Mach, both branches); after convergence the
  Validation tab compares the measured exit plane — exit Mach (Euler) or the
  continuity speed ratio (LBM). Measured on the default CD nozzle at M0.5:
  exit M 0.479 vs 0.471 quasi-1D (subsonic/shocked branch) — 1.8%, pass.
  New headless checks: A/A*(M=2)=1.6875, area-Mach roundtrips, choking logic.

### v0.1.12 — 2026-06-10
- Add: grids up to **3072×1536** (device limits raised at init; graceful
  fallback if the GPU can't), default now 2048×1024, 768×384 removed.
- Add: **vector-drawn body** on the overlay canvas (zoom-aware) — the surface
  looks perfectly smooth at any grid and matches the Bouzidi/ghost-fluid wall.
- Fix: **low-Mach "dithering"** in the Euler engine. Two causes: HLLC
  preserves contacts exactly so odd-even pressure-velocity noise is never
  damped on near-stagnant faces (now blended toward HLL below face Mach 0.3 —
  no effect at M≥0.3), and the impulsive start seeded the noise (inflow now
  ramps over ~half a chord, like LBM). M0.4 field: checkerboard gone, Cl
  0.813 vs 0.819 baseline, spurious Cd 0.0145 → 0.0118; Sod and diamond-M2
  anchors unchanged. (A Thornber-type jump-centering fix was tried first and
  *rejected by measurement*: it destabilized forces, σ_Cl 0.33.)

### v0.1.11 — 2026-06-10
- Fix: **URL hash silently reset Re to 1e3 on reload** — `toExponential` wrote
  `re=2.0e+5`, URLSearchParams decodes `+` as a space, parseFloat truncated to
  2.0, and the clamp floored it. Hash now written without `+`; old links are
  parsed tolerantly. (Found because a verification run quietly became Re 10³.)
- Fix: **shedding flows looked "never converged" with values all over the
  place**. Three causes: readouts/validation/pin/CSV used the latest
  *instantaneous* sample (which swings every frame in a limit cycle); the
  stationarity check compared two 20-sample windows and fired while the limit
  cycle was still growing (mean drifted 20%+ after "convergence"); and the
  sparkline showed only the raw oscillation. Now: all consumers use the
  ~10-chord time-average, readouts state "oscillating (shedding): time-avg
  ±σ", convergence requires mean AND amplitude agreement across two 10-chord
  windows, and the sparkline overlays the running mean. Verified: displayed
  Cl moved 0.720→0.723 over ~85 post-convergence chords (was 0.62↔1.11
  every second).

### v0.1.10 — 2026-06-10
- Honesty: re-measured RAE 2822 **at the true Case 6 angle** (α=2.31 corrected,
  via the new URL hash): Cl 0.668 vs 0.743 — 10.1% low, passes the 15% band.
  The v0.1.7 "1.3% off Case 6" figure was taken at α2.9 (wrong angle); the
  changelog, trust notes, and validation row note are corrected.
- Add: **α-sweep warm starts** — each angle continues from the previous
  converged field instead of resetting. Measured at M2 (diamond): ~7.5-8
  chords/point, comparable to cold starts (supersonic transients exit fast);
  main benefit is LBM (skips the 600-step inflow re-ramp) and the pinned
  polar matches theory exactly (α2 0.081 vs Ackeret 0.0806, α4 0.163 vs
  exact 0.1634, α0 symmetric 0.000).

### v0.1.9 — 2026-06-10
- Add: **URL state sharing** — the hash tracks airfoil/M/Re/α/engine/grid
  (`#af=rae2822&m=0.73&...`), restored on load; copy the address-bar link to
  share an exact case. Custom pasted airfoils are excluded (not encodable).

### v0.1.8 — 2026-06-10
- Add: **Bouzidi interpolated bounce-back** for the LBM engine (backlog #1).
  Per-link wall fractions q are computed from the true outline at geometry
  setup (8 bytes/cell, new storage buffer) and the streaming step interpolates
  the bounced population to the actual wall position; momentum exchange uses
  the interpolated outgoing population and the q-weighted wall point.
  Measured (NACA 2412, M0.1, Re 2e5 → resolved ~9e4, default grid):
  Cl(α4) 0.765 → **0.703** vs 0.65 A&vD (17.7% → 8.2% high);
  Cl(α8) **1.125** vs 1.06 (6%). α14 shedding stable; TGV test unchanged.

### v0.1.7 — 2026-06-10
- Add: **ghost-fluid boundary with true surface normals** for the Euler engine
  (backlog #1). The rasterizer encodes the nearest-outline normal into each
  boundary solid cell; ghost states reflect velocity about the actual surface
  tangent instead of the sweep axis. Wall forces switch to staircase-face
  pressure quadrature (the face flux now carries physical slip terms).
  Measured at the default grid:
  - NACA 2412 M0.5 α4: Cl 0.513 → **0.864** vs 0.849 panel+PG (40% low → 1.8%)
  - RAE 2822 M0.73 α2.9: Cl 0.221 → **0.753** (same-α A/B). *Correction
    (v0.1.10): at the true Case 6 angle (α=2.31) Cl is 0.668 vs 0.743 exp —
    10.1% low, passes; the earlier "1.3% off Case 6" read used α2.9.*
  - Diamond M2 α4: Cl **0.163** vs 0.1634 exact (0.2%); wave Cd 0.058 →
    **0.0259** vs 0.0265 exact (120% high → 2.3%)
  - All cases now converge *steady* (was time-averaged/oscillatory); M6 and
    the live Mach-scrub gauntlet remain stable. LBM results bit-identical.
- Docs: retired the now-false "staircase Kutta deficit / 2x wave drag" notes
  in validation + Help; trust guide updated with the new validated numbers.

### v0.1.6 — 2026-06-10
- Add: **scroll-wheel zoom** on the flow view (cursor-anchored, 1-12×,
  double-click resets; HUD shows the factor). The hover probe maps through the
  same view transform, so probed x/c stays correct while zoomed.
- Fix: **validation honesty** — rows now pass/fail only when their reference
  actually applies. Cd vs A&vD across >0.7 decades of Re is condition mismatch
  (info), replaced by a matched-Re empirical row; LBM's *resolved* Re (after
  the stability clamp) is used everywhere; attached-flow references go info
  below Re~3e4 (separated regime) and past α~10° (panel never stalls); known
  staircase deficits (subsonic Euler Cl, supersonic wave drag) stay failing
  but say why. Default case went from a wall of >70% "fails" to 3 pass /
  2 check / honest info — without softening any genuine failure.

### v0.1.5 — 2026-06-10
- Add: **characteristic far-field BCs** for the Euler engine (1D Riemann
  invariants along each sweep axis, all four boundaries). Subsonic/transonic
  boundaries absorb outgoing waves instead of reflecting them. Measured (RAE
  2822, M 0.73, α 2.9, default grid): Cl 0.221 → 0.309, spurious Cd
  0.095 → 0.061. Supersonic cases unchanged (correct limit behavior).
- Change: Euler chord nx/6.5 → nx/5.5, LE at 1.7c (absorbing boundaries can
  sit closer, so spend domain on surface resolution): diamond M2 wave-drag
  error 120% → 100%, transonic spurious Cd −15% more.
- Honesty: Help/trust guide now states subsonic Euler Cl reads 30-40% low
  (staircase Kutta deficit — resolution study: Cl 0.31 @197c/c → 0.39 @315c/c
  vs 0.74 target). Cut-cell boundary (backlog #1) is the real fix.

### v0.1.4 — 2026-06-10
- Fix: **NaN flood** (diamond, M6, high α, live Mach changes). Three layers:
  (1) `prim()` bounds velocity at the total-enthalpy limit — a vacuum-floor cell
  dividing finite momentum by RHO_MIN was the NaN seed; the bound discards
  excess KE rather than converting it to pressure (a p-feedback detonates the
  field). (2) Non-finite cells are scrubbed to freestream (one poisoned cell
  otherwise floods the domain). (3) Live Mach changes keep dt and the velocity
  bound sized for the hottest recent Mach until the old flow flushes out
  (~20%/chord decay) — dropping M live used to violate CFL instantly.
  Regression: vacuum-cell prim unit check + fixed-dt deep-rarefaction march.

### v0.1.3 — 2026-06-10
- Fix: fast-forward and α-sweep now run **to force convergence** (batched, with a
  chord-travel cap) instead of fixed step counts. 2000 steps was under one chord
  of travel on the default LBM grid; steady cases need 10-30 chords. Sweep points
  pin the mean of the last 20 settled force samples (robust for shedding cases).
- Add: **hover probe** on the flow field — x/c, y/c, |V|/U∞, Cp, plus local Mach
  & density (Euler) or vorticity (LBM); works in Theory mode via the panel
  evaluator. Macro readbacks are throttled (250 ms) and serialized with Cp
  sampling (shared staging buffer can't be mapped twice).
- Add: hover crosshair + nearest-point tooltips on all four plots.

### v0.1.2 — 2026-06-10
- Fix: macro texture is now seeded by the init kernels — first rendered frame
  after reset was undefined GPU memory until the first step completed.
- Add: time-averaged convergence detection for unsteady flows (vortex shedding
  at high α never satisfied the steady criterion, so validation never ran);
  HUD now shows "steady" vs "time-averaged".

### v0.1.1 — 2026-06-10
- Honesty: LBM now reports the *resolved* Reynolds number when the stability clamp
  caps viscosity on the current grid (Results line + Validation trust note).
- UX: surface-pressure plot auto-refreshes when a run converges (was manual only).
- UX: solver-only buttons (run/reset/fast-forward/sweep/sample) disable in Theory mode.

### v0.1.0 — 2026-06-10
- Fix: low-Re friction model includes laminar-separation-bubble penalty (pure flat-plate laminar underestimated Cd0 at Re < 5e5 vs E387/UIUC data).
- Fix: module init order (TDZ) — app start moved after const bindings.
- Fix: renamed LBM entry point `step` → `step_lbm`; avoided `in`/`out` identifiers in WGSL (builtin/reserved-word collision safety).
- Add: adaptive fixed-point force scale in Euler engine (i32 atomic headroom at M ≥ 3).
- Add: WGSL structural sanity test suite (entry points, bindings, balance).
- Typed NACA codes bind to preset validation anchors when available.
- Initial release: LBM (D2Q9+LES), compressible Euler (MUSCL+HLLC), panel/Ackeret theory engine.
- Airfoil database (NACA 4/5-digit generators + 5 UIUC sections + diamond + flat plate), custom .dat input.
- Fields, particles, Cp/polar/history charts, α-sweep, CSV export.
- Validation tab: A&vD polars, RAE 2822 Case 6, exact shock-expansion, Ackeret, panel cross-checks.
- Headless test suite: Sod tube vs exact Riemann, Taylor-Green decay, shock tables, panel anchors.

## Backlog (small, prioritized)

1. **Residual Euler numerical drag** (~0.01-0.02 at subsonic/transonic) — entropy generation at the staircase quadrature; cut cells or higher-order wall pressure would shrink it.
2. **Residual LBM Cl bias** (~6-8% high pre-stall at default grid) — likely wall-function / resolution; finer grid or multi-relaxation-time collision would help.
3. **Local time stepping** for steady Euler cases (3–5× faster convergence).
5. **LBM wall function** or grid refinement near the surface for better high-Re Cd.
6. **Drag decomposition display** (pressure vs friction vs wave) in Results tab.
7. **PNG export** of canvas + charts.
8. **Streamline (LIC) field mode** as alternative to particles.
9. **More airfoils**: NACA 6-series (63/64/65), supercritical SC(2)-0714, MH-series.
10. **Interactive geometry editor** (drag control points, live reshaping).
11. **WENO option** for the Euler engine at high Mach (crisper shocks at cost of speed).
12. **Mobile layout** pass (collapsible sidebar, touch sliders).
13. **Web Worker** for panel polar sweeps (avoid main-thread hitches on slow machines).

## Process

- Always run `node tests/run_all.mjs` before committing.
- Each improvement = one commit, message prefixed `kaizen:`.
- New physics → new validation row or test first.
