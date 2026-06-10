// Run all validation tests: node tests/run_all.mjs
import { test as panelTheory } from './panel_theory.mjs';
import { test as sod } from './hllc_sod.mjs';
import { test as tgv } from './lbm_tgv.mjs';
import { test as wgsl } from './wgsl_sanity.mjs';
import { test as integrity } from './integrity.mjs';

const suites = [
  ['Panel method & theory vs textbook/wind-tunnel', panelTheory],
  ['Euler flux math (HLLC+MUSCL) vs exact Riemann (Sod)', sod],
  ['LBM collision/streaming vs Taylor-Green analytic', tgv],
  ['WGSL shader structural sanity', wgsl],
  ['Project integrity (parse, balance, corruption)', integrity],
];

let pass = 0, fail = 0;
for (const [name, fn] of suites) {
  console.log(`\n=== ${name} ===`);
  let checks;
  try {
    checks = await fn();
  } catch (e) {
    console.log(`  SUITE ERROR: ${e.message}`);
    fail++;
    continue;
  }
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  [${detail}]`);
    if (ok) pass++; else fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
