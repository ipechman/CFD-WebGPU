// Validation against real-world reference data and exact theory.
//
// Experimental anchors digitized (approximate, +/-0.03 in Cl) from:
//   Abbott & von Doenhoff, "Theory of Wing Sections" (1959), Re = 6e6, smooth.
// Transonic reference: RAE 2822 Case 6 (Cook, McDonald & Firmin, AGARD AR-138, 1979).
// Supersonic: exact shock-expansion (diamond) and Ackeret linear theory.

import { liftSlope, ackeret, diamondShockExpansion, frictionDrag, prandtlGlauert, ductQuasi1D } from './theory.js';
import { geomInfo } from './airfoils.js';

export const EXP_DATA = {
  naca0012: {
    source: 'Abbott & von Doenhoff (1959), Re 6e6',
    Re: 6e6,
    alpha: [-8, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16],
    cl: [-0.86, -0.44, -0.22, 0.00, 0.22, 0.44, 0.66, 0.87, 1.07, 1.25, 1.40, 1.52],
    cd: [0.0085, 0.0064, 0.0059, 0.0058, 0.0059, 0.0064, 0.0072, 0.0084, 0.0100, 0.0124, 0.0160, 0.0245],
    clmax: 1.58, alphaStall: 16.5, cm0: 0.0,
  },
  naca2412: {
    source: 'Abbott & von Doenhoff (1959), Re 5.7e6',
    Re: 5.7e6,
    alpha: [-8, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16],
    cl: [-0.62, -0.21, 0.01, 0.23, 0.44, 0.65, 0.86, 1.06, 1.24, 1.40, 1.54, 1.64],
    cd: [0.0088, 0.0066, 0.0061, 0.0059, 0.0060, 0.0065, 0.0074, 0.0086, 0.0102, 0.0126, 0.0162, 0.0240],
    clmax: 1.68, alphaStall: 16.5, cm0: -0.047,
  },
  naca4412: {
    source: 'Abbott & von Doenhoff (1959), Re 6e6',
    Re: 6e6,
    alpha: [-8, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14],
    cl: [-0.42, 0.00, 0.21, 0.42, 0.63, 0.84, 1.04, 1.23, 1.41, 1.56, 1.65],
    cd: [0.0088, 0.0070, 0.0065, 0.0063, 0.0066, 0.0072, 0.0082, 0.0096, 0.0118, 0.0152, 0.0210],
    clmax: 1.67, alphaStall: 14.0, cm0: -0.093,
  },
};

export const RAE2822_CASE6 = {
  source: 'RAE 2822 Case 6 (AGARD AR-138)',
  M: 0.725, Re: 6.5e6, alpha: 2.31, cl: 0.743, cd: 0.0127, cm: -0.095,
};

function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) if (xs[i] >= x) {
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  }
  return ys[ys.length - 1];
}

/**
 * Build validation rows for the current case.
 * ctx: { airfoilId, coords, M, Re, alphaDeg, engine }
 * results: { solver: {cl,cd,cm}|null, panel: {cl,cm}|null, theory: quickEstimate result }
 * Returns [{ name, computed, reference, refSource, delta, status, note }]
 */
export function evaluateCase(ctx, results) {
  const rows = [];
  const { airfoilId, coords, M, Re, alphaDeg, engine } = ctx;
  const { solver, panel, theory } = results;
  const add = (r) => rows.push(r);

  const pct = (a, b) => Math.abs(b) > 1e-4 ? Math.abs((a - b) / b) * 100 : Math.abs(a - b) * 100;
  const status = (d, warn, fail) => d <= warn ? 'pass' : d <= fail ? 'warn' : 'fail';

  // ---- duct/nozzle mode: quasi-1D comparison, then done ----
  if (ctx.duct) {
    const q = ductQuasi1D(ctx.duct.a1, ctx.duct.a2, Math.max(M, 0.05));
    const meas = ctx.ductMeas;
    if (engine === 'euler' && meas && meas.exit) {
      const ref = q.choked ? q.mExitSup : q.mExit;
      const dM = pct(meas.exit.M, ref);
      const dMsub = q.choked ? pct(meas.exit.M, q.mExitSub) : Infinity;
      const best = Math.min(dM, dMsub);
      add({
        name: 'Duct exit Mach vs quasi-1D', computed: meas.exit.M,
        reference: best === dM ? ref : q.mExitSub,
        refSource: 'Isentropic area-Mach relation',
        delta: best, status: status(best, 12, 30),
        note: q.choked
          ? `Choked (throat M=1). Branches: supersonic ${q.mExitSup.toFixed(2)} / subsonic ${q.mExitSub.toFixed(2)} - the simulated back pressure picks one; a shock in the divergent section lands between them.`
          : 'Unchoked duct: subsonic throughout. 2D wall effects vs 1D theory cost a few percent.',
      });
    } else if (engine === 'lbm' && meas && meas.exit && meas.inlet) {
      const ref = ctx.duct.a1 / ctx.duct.a2; // continuity: u_ex/u_in = A_in/A_ex
      const r = meas.exit.V / Math.max(meas.inlet.V, 1e-6);
      const d = pct(r, ref);
      add({
        name: 'Duct speed ratio vs continuity', computed: r, reference: ref,
        refSource: 'Incompressible continuity (A_in/A_exit)',
        delta: d, status: status(d, 12, 30),
        note: 'Mean speed at exit vs inlet plane; boundary layers on the walls shift it a few percent.',
      });
    } else {
      add({
        name: 'Duct quasi-1D prediction', computed: NaN,
        reference: q.choked ? q.mExitSup : q.mExit,
        refSource: 'Isentropic area-Mach relation', delta: NaN, status: 'info',
        note: (q.choked ? 'Choked at throat (M=1). ' : `Throat M=${q.mThroat.toFixed(2)}. `) +
          'Run the LBM/Euler engine to convergence to measure the exit plane.',
      });
    }
    add({
      name: 'Engine validity', computed: NaN, reference: NaN, delta: NaN, status: 'info', refSource: '',
      note: engine === 'lbm'
        ? 'LBM duct: incompressible venturi/diffuser physics; Mach effects are not modeled below M 0.3.'
        : 'Euler duct: compressible, captures choking and shocks; quasi-1D theory ignores 2D wall curvature effects.',
    });
    return rows;
  }

  const info = geomInfo(coords);

  // Reynolds number the solver actually resolves (LBM stability clamp can sit
  // decades below the request); references are judged against this.
  const simRe = (engine === 'lbm' && ctx.effRe) ? ctx.effRe : Re;
  const lowRe = engine === 'lbm' && simRe < 3e4; // largely separated regime
  const shedNote = ctx.shedding
    ? ' Flow is shedding (values are time-averages); 2D simulations exaggerate oscillation amplitude and mean lift vs 3D reality.'
    : '';

  // ---- 1. Lift vs thin-airfoil / linearized theory ----
  const slope = liftSlope(M);
  if (Number.isFinite(slope) && panel && M < 0.75) {
    const clTheory = panel.cl * prandtlGlauert(M); // panel (exact incompressible) + PG
    if (solver) {
      const d = pct(solver.cl, clTheory);
      let st = status(d, 12, 25);
      let note = 'Inviscid attached-flow reference; expect CFD slightly lower (viscous decambering).' + shedNote;
      if (lowRe) {
        st = 'info';
        note = `At resolved Re~${simRe.toExponential(1)} the flow is largely separated - attached-flow inviscid references do not apply.`;
      } else if (engine === 'lbm' && alphaDeg >= 10) {
        // the panel method never stalls; past ~10 deg the reference is the
        // invalid party, not the solver
        st = d <= 25 ? st : 'info';
        note = 'Panel method never stalls - beyond ~10 deg this reference is invalid; use the wind-tunnel row instead.';
      }
      add({
        name: `Cl vs panel method${M > 0.05 ? ' + Prandtl-Glauert' : ''}`,
        computed: solver.cl, reference: clTheory, refSource: 'Hess-Smith panel (inviscid)',
        delta: d, status: st, note,
      });
    }
  }

  // ---- 2. Experimental anchor (A&vD) ----
  const exp = EXP_DATA[airfoilId];
  if (exp && M < 0.4 && alphaDeg >= exp.alpha[0] && alphaDeg <= exp.alpha[exp.alpha.length - 1]) {
    const clRef = interp(exp.alpha, exp.cl, alphaDeg);
    const cdRef = interp(exp.alpha, exp.cd, alphaDeg);
    const reOff = Math.abs(Math.log10(simRe / exp.Re));
    const reNote = reOff > 0.5
      ? ` Data at Re=${exp.Re.toExponential(0)}; simulation resolves Re~${simRe.toExponential(1)}.`
      : '';
    if (solver) {
      const dl = pct(solver.cl, clRef);
      add({
        name: 'Cl vs wind tunnel', computed: solver.cl, reference: clRef, refSource: exp.source,
        delta: dl,
        // lift is only mildly Re-dependent pre-stall: widen, don't excuse.
        // Beyond ~2 decades it is a different flow regime entirely.
        status: reOff > 2 ? 'info' : reOff > 0.7 ? status(dl, 20, 40) : status(dl, 15, 30),
        note: (reOff > 2
          ? `Different flow regime: lift at Re~${simRe.toExponential(1)} (separated/laminar) is not comparable to Re=${exp.Re.toExponential(0)} data.`
          : `Experimental polar.${reNote}${reOff > 0.7 ? ' Expect earlier stall and higher Cl scatter at low Re.' : ''}`) + shedNote,
      });
      const dd = pct(solver.cd, cdRef);
      if (reOff > 0.7) {
        // drag is viscosity-dominated: across a decade of Re this is a
        // condition mismatch, not a solver error - report, don't fail
        add({
          name: 'Cd vs wind tunnel', computed: solver.cd, reference: cdRef, refSource: exp.source,
          delta: dd, status: 'info',
          note: `Not comparable: Cd is Re-dominated and the conditions differ by ${reOff.toFixed(1)} decades.${reNote} See the matched-Re row.`,
        });
        const frEff = frictionDrag(simRe, info.tc, M);
        const cdMatched = frEff.cdOfCl(solver.cl);
        const dm = pct(solver.cd, cdMatched);
        // boundary-layer resolution at the resolved Re (laminar estimate)
        const blCells = ctx.chordCells ? 5 * ctx.chordCells / Math.sqrt(simRe) : null;
        const underRes = blCells !== null && blCells < 8;
        add({
          name: 'Cd vs empirical (resolved Re)', computed: solver.cd, reference: cdMatched,
          refSource: `Empirical drag polar at Re=${simRe.toExponential(1)}`,
          delta: dm,
          status: underRes ? (dm <= 350 ? 'warn' : 'fail')
            : lowRe ? status(dm, 60, 150) // empirical model itself is +/-50% down here
            : status(dm, 35, 70),
          note: underRes
            ? `Boundary layer ~${blCells.toFixed(0)} cells thick here - LBM Cd runs 2-4x high when under-resolved. Drop Re below ~3e4 or use the fine grid for a meaningful Cd.`
            : lowRe ? 'Like-for-like at the resolved Re; the empirical model itself carries large uncertainty below Re~3e4.'
            : 'Like-for-like drag check at the Reynolds number the grid actually resolves.',
        });
      } else {
        add({
          name: 'Cd vs wind tunnel', computed: solver.cd, reference: cdRef, refSource: exp.source,
          delta: dd, status: status(dd, 30, 60),
          note: `Experimental polar.${reNote}`,
        });
      }
    }
    if (theory && theory.valid) {
      const dt = pct(theory.cl, clRef);
      add({
        name: 'Cl (instant estimate) vs wind tunnel', computed: theory.cl, reference: clRef,
        refSource: exp.source, delta: dt, status: status(dt, 12, 25),
        note: 'Panel method runs inviscid: no stall; diverges from data beyond ~10 deg.',
      });
    }
  }

  // ---- 3. Supersonic: exact shock-expansion (diamond) or Ackeret ----
  if (M > 1.15 && solver) {
    if (airfoilId === 'diamond8') {
      const ex = diamondShockExpansion(M, alphaDeg, info.tc);
      if (ex.valid) {
        const dl = pct(solver.cl, ex.cl), dd = pct(solver.cd, ex.cd);
        add({
          name: 'Cl vs exact shock-expansion', computed: solver.cl, reference: ex.cl,
          refSource: 'Oblique shock + Prandtl-Meyer (exact)', delta: dl,
          status: status(dl, 10, 20), note: 'Exact inviscid solution for the diamond airfoil.',
        });
        add({
          name: 'Cd (wave) vs exact shock-expansion', computed: solver.cd, reference: ex.cd,
          refSource: 'Oblique shock + Prandtl-Meyer (exact)', delta: dd,
          status: status(dd, 12, 25),
          note: 'Euler drag is wave drag (ghost-fluid boundary, ~2% on this case at default grid); add skin friction for total.',
        });
      }
    } else {
      const ak = ackeret(coords, M, alphaDeg);
      if (ak.valid) {
        const dl = pct(solver.cl, ak.cl);
        add({
          name: 'Cl vs Ackeret linear theory', computed: solver.cl, reference: ak.cl,
          refSource: 'Linearized supersonic theory', delta: dl,
          status: status(dl, 15, 30),
          note: M > 3 ? 'Linear theory degrades above M~3 (use as order-of-magnitude).' : 'Thin-airfoil linearized reference.',
        });
        const dd = pct(solver.cd, ak.cd);
        add({
          name: 'Cd (wave) vs Ackeret', computed: solver.cd, reference: ak.cd,
          refSource: 'Linearized supersonic theory', delta: dd,
          status: status(dd, 20, 40),
          note: 'Wave drag comparison (viscous excluded); linear theory itself is approximate.',
        });
      }
    }
  }

  // ---- 4. RAE 2822 Case 6 ----
  if (airfoilId === 'rae2822' && Math.abs(M - RAE2822_CASE6.M) < 0.02 && Math.abs(alphaDeg - RAE2822_CASE6.alpha) < 0.4) {
    if (solver) {
      const dl = pct(solver.cl, RAE2822_CASE6.cl);
      add({
        name: 'Cl vs RAE 2822 Case 6', computed: solver.cl, reference: RAE2822_CASE6.cl,
        refSource: RAE2822_CASE6.source, delta: dl, status: status(dl, 15, 30),
        note: 'Classic transonic benchmark (M=0.725, a=2.31 deg corrected). Inviscid Euler reads ~10% low here at the default grid (no viscous decambering match).',
      });
    } else {
      add({
        name: 'RAE 2822 Case 6 target', computed: NaN, reference: RAE2822_CASE6.cl,
        refSource: RAE2822_CASE6.source, delta: NaN, status: 'info',
        note: 'Run the Euler engine at M=0.725, a=2.31 to compare against this benchmark (Cl=0.743, Cd=0.0127).',
      });
    }
  }

  // ---- 5. Panel self-consistency ----
  if (panel && Number.isFinite(panel.cdCheck)) {
    const d = Math.abs(panel.cdCheck);
    add({
      name: "Panel d'Alembert check (Cd ~ 0)", computed: panel.cdCheck, reference: 0,
      refSource: 'Inviscid theory (exact)', delta: NaN,
      status: d < 0.002 ? 'pass' : d < 0.01 ? 'warn' : 'fail',
      note: `Numerical self-consistency of the panel discretization (|Cd| = ${d.toExponential(1)}).`,
    });
  }

  // ---- 6. Friction estimate context ----
  const fr = frictionDrag(Re, info.tc, M);
  add({
    name: 'Empirical Cd0 (friction + form)', computed: fr.cd0, reference: NaN, delta: NaN,
    refSource: 'Schlichting flat plate x Hoerner form factor, calibrated to A&vD',
    status: 'info',
    note: `At Re=${Re.toExponential(1)}: Cd0 ~ ${fr.cd0.toFixed(4)}. Add to inviscid (Euler/panel) results for total drag.`,
  });

  // ---- 7. Engine trust note ----
  add({
    name: 'Engine validity', computed: NaN, reference: NaN, delta: NaN, status: 'info',
    refSource: '',
    note: trustNote(engine, M, Re, ctx.effRe),
  });

  return rows;
}

export function trustNote(engine, M, Re, effRe) {
  if (engine === 'lbm') {
    let n = 'LBM (viscous, LES): good for flow structure, Cl, vortex shedding at M<0.3. ';
    if (effRe && effRe < Re * 0.97) {
      n += `NOTE: viscosity is stability-clamped on this grid - you requested Re=${Re.toExponential(1)} but the resolved Re is ~${effRe.toExponential(1)} plus LES subgrid effects. Use a finer grid or trust Cl trends only. `;
    }
    n += Re > 1e5 ? `At Re=${Re.toExponential(1)} the boundary layer is under-resolved: Cd indicative, stall angle approximate.`
      : 'At this Re the simulation is well resolved.';
    return n;
  }
  if (engine === 'euler') {
    if (M < 0.5) return 'Euler (inviscid, ghost-fluid surface): no boundary layer, so no friction drag and no stall. Cl validated within ~2% of panel+PG at M0.5; residual numerical Cd ~0.01-0.02 (use empirical Cd0 for real drag).';
    if (M < 1.15) return 'Transonic Euler (ghost-fluid surface): shocks captured; Cl ~10% low on RAE 2822 Case 6 (M0.725, a2.31) at the default grid; wave drag approximate, expect mild buffet near M~1.';
    if (M <= 4) return 'Supersonic Euler: shocks and wave drag well captured; compare with Ackeret/shock-expansion rows above.';
    return 'M>4: calorically perfect gas assumed (no real-gas/chemistry effects -> real stagnation temperatures lower). Treat as qualitative hypersonic.';
  }
  return 'Theory engine: instant estimates. Panel+PG valid M<0.7 attached flow; Ackeret valid 1.15<M<3 thin airfoils; transonic gap requires Euler.';
}
