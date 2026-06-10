# Kaizen log

Continuous small improvements. Every entry is a small, shippable change with a reason.
Add new entries at the top of the changelog; pull backlog items from the list below.

## Changelog

### v0.1.1 — 2026-06-10
- Fix: low-Re friction model now includes laminar-separation-bubble penalty (was pure flat-plate laminar, underestimated Cd0 at Re < 5e5 vs E387/UIUC data).
- Fix: module init order (TDZ) — app start moved after const bindings.
- Fix: renamed LBM entry point `step` → `step_lbm` and avoided `in`/`out` identifiers in WGSL (builtin/reserved-word collision safety across implementations).
- Add: adaptive fixed-point force scale in Euler engine (i32 atomic headroom at M ≥ 3).
- Add: WGSL structural sanity test suite (entry points, bindings, balance).
- Typed NACA codes now bind to preset validation anchors when available.

### v0.1.0 — 2026-06-10
- Initial release: LBM (D2Q9+LES), compressible Euler (MUSCL+HLLC), panel/Ackeret theory engine.
- Airfoil database (NACA 4/5-digit generators + 5 UIUC sections + diamond + flat plate), custom .dat input.
- Fields, particles, Cp/polar/history charts, α-sweep, CSV export.
- Validation tab: A&vD polars, RAE 2822 Case 6, exact shock-expansion, Ackeret, panel cross-checks.
- Headless test suite: Sod tube vs exact Riemann, Taylor-Green decay, shock tables, panel anchors.

## Backlog (small, prioritized)

1. **Characteristic far-field BC** for subsonic Euler outlet (reduces reflections, faster convergence).
2. **Cut-cell boundary** (or ghost-fluid with true normals) to replace staircase walls — biggest single accuracy win.
3. **Cp sample auto-refresh** on convergence (currently manual button).
4. **URL state sharing** — encode airfoil/M/Re/α in the hash for shareable cases.
5. **Local time stepping** for steady Euler cases (3–5× faster convergence).
6. **LBM wall function** or grid refinement near the surface for better high-Re Cd.
7. **Drag decomposition display** (pressure vs friction vs wave) in Results tab.
8. **PNG export** of canvas + charts.
9. **Streamline (LIC) field mode** as alternative to particles.
10. **More airfoils**: NACA 6-series (63/64/65), supercritical SC(2)-0714, MH-series.
11. **Interactive geometry editor** (drag control points, live reshaping).
12. **Convergence-aware auto-stop** for the α-sweep (instead of fixed step counts).
13. **WENO option** for the Euler engine at high Mach (crisper shocks at cost of speed).
14. **Mobile layout** pass (collapsible sidebar, touch sliders).
15. **Web Worker** for panel polar sweeps (avoid main-thread hitches on slow machines).

## Process

- Always run `node tests/run_all.mjs` before committing.
- Each improvement = one commit, message prefixed `kaizen:`.
- New physics → new validation row or test first.
