# Kaizen log

Continuous small improvements. Every entry is a small, shippable change with a reason.
Add new entries at the top of the changelog; pull backlog items from the list below.

## Changelog

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

1. **Cut-cell boundary** (or ghost-fluid with true normals) to replace staircase walls — biggest single accuracy win. Measured need: subsonic Euler Cl 30-40% low, supersonic wave drag ~2x on thin sharp sections; both scale ~1/N with resolution.
3. **URL state sharing** — encode airfoil/M/Re/α in the hash for shareable cases.
4. **Local time stepping** for steady Euler cases (3–5× faster convergence).
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
