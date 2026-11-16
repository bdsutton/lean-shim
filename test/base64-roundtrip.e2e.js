// Confirms the extension's `tacticCall(...)` output runs through the real `from_base64` tactic.
// Usage: npm run compile && node test/base64-roundtrip.e2e.js [path/to/lean]
// Needs the LeanShim library built (`lake build LeanShim.Base64`) and `lean` on PATH.
// Runs `lean` directly with LEAN_PATH (no Mathlib needed), so it works without network access.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tacticCall } = require('../out/encode');

const lean = process.argv[2] || 'lean';
const cases = [
  ['one', '1 = 1', '', 'rfl'],
  ['imp', 'p → p', '(p : Prop)', 'intro h\nexact h'],
  ['andi', 'p ∧ q', '(p q : Prop) (hp : p) (hq : q)', 'constructor\n· exact hp\n· exact hq'],
  ['swap', 'p ∧ q → q ∧ p', '(p q : Prop)', 'intro h\nrcases h with ⟨ha, hb⟩\nexact ⟨hb, ha⟩'],
  // model output with indentation + trailing blank line; tacticCall must dedent it
  ['indented', 'n + 0 = n', '(n : Nat)', '    simp\n'],
  ['block', '(0:Nat) ≤ 1 ∧ (0:Nat) ≤ 2', '', '      have h1 : (0:Nat) ≤ 1 := Nat.zero_le _\n      have h2 : (0:Nat) ≤ 2 := Nat.zero_le _\n      exact ⟨h1, h2⟩'],  // reconstructed ragged selection
];
let out = 'import LeanShim.Base64\n\n';
for (const [name, ty, binders, proof] of cases) {
  out += `theorem rt_${name} ${binders} : ${ty} := by\n  ${tacticCall(proof)}\n\n`;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b64rt-'));
const file = path.join('examples', `_roundtrip_tmp.lean`);
fs.writeFileSync(file, out);
const libDir = path.resolve('.lake/build/lib/lean');
if (!fs.existsSync(path.join(libDir, 'LeanShim', 'Base64.olean'))) {
  console.error('LeanShim library not built; run: lake build LeanShim.Base64');
  process.exit(2);
}
try {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { ...process.env, LEAN_PATH: [libDir, process.env.LEAN_PATH].filter(Boolean).join(sep) };
  execFileSync(lean, [file], { stdio: 'pipe', env });
  console.log(`base64 round-trip: all ${cases.length} proofs checked via from_base64`);
} catch (e) {
  console.error('base64 round-trip FAILED:\n' + (e.stdout || '') + (e.stderr || ''));
  process.exitCode = 1;
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
