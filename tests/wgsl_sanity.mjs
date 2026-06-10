// Structural sanity checks for WGSL shaders (no GPU needed):
// balanced delimiters, expected entry points & bindings, no corruption.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECT = {
  'shaders/lbm.wgsl': { entries: ['init', 'step_lbm'], bindings: [0, 1, 2, 3, 4, 5] },
  'shaders/euler.wgsl': { entries: ['init', 'sweep'], bindings: [0, 1, 2, 3, 4, 5] },
  'shaders/render.wgsl': { entries: ['vsField', 'fsField', 'advect', 'vsParticle', 'fsParticle'], bindings: [0, 1, 2, 3, 4] },
};

export function test() {
  const checks = [];
  for (const [file, exp] of Object.entries(EXPECT)) {
    const src = readFileSync(join(root, file), 'utf8');
    const name = file.split('/')[1];

    checks.push([`${name}: no NUL/corruption`, !src.includes('\0'), `${src.length} chars`]);

    for (const [open, close, label] of [['{', '}', 'braces'], ['(', ')', 'parens'], ['[', ']', 'brackets']]) {
      let bal = 0, min = 0;
      for (const ch of src) {
        if (ch === open) bal++;
        else if (ch === close) bal--;
        min = Math.min(min, bal);
      }
      checks.push([`${name}: balanced ${label}`, bal === 0 && min >= 0, `net ${bal}`]);
    }

    const entryRe = /@(compute|vertex|fragment)[^f]*fn\s+(\w+)/g;
    const found = [...src.matchAll(entryRe)].map(m => m[2]);
    for (const e of exp.entries) {
      checks.push([`${name}: entry point ${e}`, found.includes(e), found.join(',')]);
    }

    const bindings = [...src.matchAll(/@binding\((\d+)\)/g)].map(m => +m[1]);
    for (const b of exp.bindings) {
      checks.push([`${name}: binding ${b} declared`, bindings.includes(b), '']);
    }

    // regression guards: reserved-ish identifiers & builtin shadowing
    checks.push([`${name}: no 'fn step(' (builtin shadow)`, !/fn\s+step\s*\(/.test(src), '']);
    checks.push([`${name}: no bare 'in:' param`, !/fn\s+\w+\(\s*in\s*:/.test(src), '']);
  }
  return checks;
}
