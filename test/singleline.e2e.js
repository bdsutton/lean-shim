// Checks every proof in singleline-cases.js and its one-line form with a real Lean (core only).
// Usage: npm run compile && node test/singleline.e2e.js [path/to/lean]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toSingleLine } = require('../out/singleline');
const cases = require('./singleline-cases');

const lean = process.argv[2] || 'lean';
let out = '';
let one = 0;
for (const [name, ty, proof] of cases) {
  const body = proof.split('\n').filter((l) => l.trim() !== '');
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  out += `theorem ${name}_multi ${ty} := by\n${body.map((l) => '  ' + l.slice(indent)).join('\n')}\n\n`;
  const s = toSingleLine(proof);
  if (s !== undefined) { out += `theorem ${name}_one ${ty} := by\n  ${s}\n\n`; one++; }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneline-'));
const file = path.join(dir, 'OneLine.lean');
fs.writeFileSync(file, out);
try {
  execFileSync(lean, [file], { stdio: 'pipe' });
  console.log(`one-line rewrite: ${cases.length} proofs and ${one} one-line forms checked by Lean`);
} catch (e) {
  console.error('one-line rewrite FAILED:\n' + (e.stdout || '') + (e.stderr || ''));
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
