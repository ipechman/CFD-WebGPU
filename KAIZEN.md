# Kaizen log

Continuous small improvements. Every entry is a small, shippable change with a reason.
Add new entries at the top of the changelog; pull backlog items from the list below.

## Changelog

### v0.1.3 — 2026-06-10
- Fix: fast-forward and α-sweep now run **to force convergence** (batched, with a
  chord-travel cap) instead of fixed step counts. 2000 steps was under one chord
  of travel on the default LBM grid; steady cases need 10-30 chords. Sweep points
  pin the mean of the last 20 settled force samples (robust for shedding cases).

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

1. **Characteristic far-field BC** for subsonic Euler outlet (reduces reflections, faster convergence).
2. **Cut-cell boundary** (or ghost-fluid with true normals) to replace staircase walls — biggest single accuracy win.
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
