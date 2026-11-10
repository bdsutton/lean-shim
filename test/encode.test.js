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
assert(hasImport('import Mathlib\nimport SorryClaude.Base64\n\ntheorem t', 'SorryClaude.Base64'));
assert(hasImport('  import SorryClaude.Base64 -- the tactic', 'SorryClaude.Base64'));
assert(!hasImport('import SorryClaude.Base64Extra', 'SorryClaude.Base64'));
assert(!hasImport('-- import SorryClaude.Base64', 'SorryClaude.Base64'));
assert(!hasImport('import Mathlib\n', 'SorryClaude.Base64'));

// importInsertOffset: after the last import; at 0 when none
const f1 = 'import Mathlib\nimport Foo\n\ntheorem t : True := trivial\n';
assert.strictEqual(f1.slice(0, importInsertOffset(f1)), 'import Mathlib\nimport Foo\n');
const f2 = '-- a comment\n\ntheorem t : True := trivial\n';
assert.strictEqual(importInsertOffset(f2), 0);
const f3 = 'import A\ntheorem t := by skip';
assert.strictEqual(f3.slice(0, importInsertOffset(f3)), 'import A\n');

console.log('encode tests passed');
