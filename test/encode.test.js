const assert = require('node:assert');
const { toBase64, tacticCall, hasImport, importInsertOffset } = require('../out/encode');

// Base64 matches Node/Lean (UTF-8)
assert.strictEqual(toBase64('rfl'), 'cmZs');
assert.strictEqual(Buffer.from(toBase64('intro h\nexact h'), 'base64').toString('utf8'), 'intro h\nexact h');
// Unicode survives
const u = 'rcases h with ⟨ha, hb⟩\nexact ⟨hb, ha⟩';
assert.strictEqual(Buffer.from(toBase64(u), 'base64').toString('utf8'), u);

// tacticCall dedents and round-trips
const call = tacticCall('    intro h\n    exact h');
assert.strictEqual(call, 'from_base64 "aW50cm8gaApleGFjdCBo"');
const m = /^from_base64 "(.+)"$/.exec(call);
assert.strictEqual(Buffer.from(m[1], 'base64').toString('utf8'), 'intro h\nexact h');

// hasImport
assert(hasImport('import Mathlib\nimport LeanShim.Base64\n\ntheorem t', 'LeanShim.Base64'));
assert(hasImport('  import LeanShim.Base64 -- the tactic', 'LeanShim.Base64'));
assert(!hasImport('import LeanShim.Base64Extra', 'LeanShim.Base64'));
assert(!hasImport('-- import LeanShim.Base64', 'LeanShim.Base64'));
assert(!hasImport('import Mathlib\n', 'LeanShim.Base64'));

// importInsertOffset: after the last import; at 0 when none
const f1 = 'import Mathlib\nimport Foo\n\ntheorem t : True := trivial\n';
assert.strictEqual(f1.slice(0, importInsertOffset(f1)), 'import Mathlib\nimport Foo\n');
const f2 = '-- a comment\n\ntheorem t : True := trivial\n';
assert.strictEqual(importInsertOffset(f2), 0);
const f3 = 'import A\ntheorem t := by skip';
assert.strictEqual(f3.slice(0, importInsertOffset(f3)), 'import A\n');

// tacticCall trims surrounding blank lines
assert.strictEqual(Buffer.from(/"(.+)"/.exec(tacticCall('\n\nsimp\n\n'))[1], 'base64').toString('utf8'), 'simp');

// Ragged selection (first line unindented, siblings indented) is fixed by reconstructing the first
// line's indentation (what the Encode-Selection command does) so dedent normalises it to column 0.
const ragged = 'have h1 : True := trivial\n      have h2 : True := trivial\n      exact h2';
const reconstructed = ' '.repeat(6) + ragged;  // command prepends the first line's indentation
const dec = Buffer.from(/"(.+)"/.exec(tacticCall(reconstructed))[1], 'base64').toString('utf8');
assert.strictEqual(dec, 'have h1 : True := trivial\nhave h2 : True := trivial\nexact h2');
// without reconstruction the raggedness survives (the bug)
const bad = Buffer.from(/"(.+)"/.exec(tacticCall(ragged))[1], 'base64').toString('utf8');
assert(bad.includes('\n      have h2'));

console.log('encode tests passed');
