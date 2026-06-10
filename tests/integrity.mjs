// Whole-project integrity: every JS module must parse (browser-only modules
// are allowed to fail at runtime on missing DOM/GPU globals, but never with a
// SyntaxError), brace balance must hold, and no file may contain NUL bytes.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function test() {
  const checks = [];
  const jsFiles = [
    ...readdirSync(join(root, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f),
    ...readdirSync(join(root, 'tests')).filter(f => f.endsWith('.mjs')).map(f => 'tests/' + f),
  ];

  for (const f of jsFiles) {
    const src = readFileSync(join(root, f), 'utf8');
    checks.push([`${f}: no NUL bytes`, !src.includes('\0'), `${src.length} chars`]);

    // brace balance outside strings/comments (cheap heuristic: strip them first)
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
    let bal = 0, ok = true;
    for (const ch of stripped) {
      if (ch === '{') bal++;
      else if (ch === '}') { bal--; if (bal < 0) ok = false; }
    }
    checks.push([`${f}: balanced braces`, ok && bal === 0, `net ${bal}`]);
  }

  // parse check via dynamic import: SyntaxError = fail, runtime ReferenceError
  // (document/navigator/GPU* missing in node) = acceptable for browser modules
  for (const f of jsFiles.filter(x => x.startsWith('js/'))) {
    let status = 'ok';
    try {
      await import(pathToFileURL(join(root, f)).href);
    } catch (e) {
      if (e instanceof SyntaxError) status = 'SYNTAX: ' + e.message.slice(0, 80);
      else status = 'ok (runtime-only: ' + String(e.message).slice(0, 40) + ')';
    }
    checks.push([`${f}: parses as ES module`, !status.startsWith('SYNTAX'), status]);
  }
  return checks;
}
