const assert = require('node:assert');
const { extractProof, layoutInsertion, buildPrompt, CURSOR_MARK, isUnsolvedGoals, goalsFromUnsolvedMessage, splitGoals, DECLARATION_START } = require('../out/format');

// Fence stripping
assert.strictEqual(extractProof('Here you go:\n```lean\n  intro h\n  simp\n```\nDone.'), '  intro h\n  simp');
assert.strictEqual(extractProof('simp'), 'simp');

// Cursor in indentation of an empty line inside a `by` block
assert.strictEqual(layoutInsertion('intro h\nexact h', '  ', '\n'), 'intro h\n  exact h');
// Nested structure preserved, model indentation normalised
assert.strictEqual(layoutInsertion('    constructor\n    · simp\n    · ring', '    ', '\n'),
  'constructor\n    · simp\n    · ring');
// Cursor right after `:= by` -> single line goes inline
assert.strictEqual(layoutInsertion('simp', 'theorem t : 1 = 1 := by', '\n'), ' simp');
// ...multi-line goes on new indented lines
assert.strictEqual(layoutInsertion('intro h\nexact h', 'theorem t : p → p := by ', '\n'),
  '\n  intro h\n  exact h');
assert.strictEqual(layoutInsertion('a\nb', '  have h : x := by', '\n'), '\n    a\n    b');

// Prompt contains marker and rejected suggestions
const p = buildPrompt({ before: 'theorem t : 1 = 1 := by\n  ', after: '\n', contextLines: 400,
  goal: '⊢ 1 = 1', otherGoals: 2, diagnostics: ['- at `rfl`: boom'], rejected: ['rfl'], extraInstructions: '' });
assert(p.includes('theorem t : 1 = 1 := by\n  ' + CURSOR_MARK));
assert(p.includes('Rejected suggestion 1') && p.includes('boom'));
assert(p.includes('current goal at the cursor') && p.includes('⊢ 1 = 1') && p.includes('2 other goals also remain'));
const p2 = buildPrompt({ before: 'x', after: '', contextLines: 400, diagnostics: [], rejected: [], extraInstructions: '' });
assert(p2.includes('could not be obtained') && !p2.includes('rejected suggestion'));

// Goal helpers
const msg = 'unsolved goals\ncase left\np q : Prop\nh : p ∧ q\n⊢ q\n\ncase right\np q : Prop\nh : p ∧ q\n⊢ p';
assert(isUnsolvedGoals(msg) && !isUnsolvedGoals('unknown identifier foo'));
assert.deepStrictEqual(goalsFromUnsolvedMessage(msg), ['case left\np q : Prop\nh : p ∧ q\n⊢ q', 'case right\np q : Prop\nh : p ∧ q\n⊢ p']);
assert.deepStrictEqual(goalsFromUnsolvedMessage('type mismatch'), []);
assert.deepStrictEqual(splitGoals('a\n⊢ x\n\n\nb\n⊢ y\n'), ['a\n⊢ x', 'b\n⊢ y']);
for (const l of ['theorem foo', 'lemma x', '@[simp] theorem foo', 'private def f', 'noncomputable instance i', 'example : True']) assert(DECLARATION_START.test(l), l);
for (const l of ['  exact foo', 'theorems', '-- theorem', '  have h : x := by']) assert(!DECLARATION_START.test(l), l);

// Long file gets windowed but keeps header and cursor
const before = Array.from({length: 1000}, (_, i) => `line${i}`).join('\n') + '\n  ';
const q = buildPrompt({ before, after: '\nend', contextLines: 100, diagnostics: [], rejected: [], extraInstructions: '' });
assert(q.includes('line0') && q.includes('line999') && !q.includes('line500') && q.includes(CURSOR_MARK));
console.log('all tests passed');
