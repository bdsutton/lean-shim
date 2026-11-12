const assert = require('node:assert');
const { toSingleLine } = require('../out/singleline');
const t = (input, expected) => assert.strictEqual(toSingleLine(input), expected, JSON.stringify(input));

t('simp', 'simp');
t('intro h\nexact h', 'intro h; exact h');
t('    intro h\n    exact h\n', 'intro h; exact h'); // indentation and trailing blank line
t('intro h -- introduce h\nexact h', 'intro h; exact h'); // line comments dropped
t('constructor\n· exact hp\n· exact hq', 'constructor; (· exact hp); · exact hq');
t('constructor\n· intro x\n  exact x\n· trivial', 'constructor; (· intro x; exact x); · trivial');
t('have h : 0 + n = n := by\n  simp\nexact h', '(have h : 0 + n = n := by simp); exact h');
t('have h : 0 ≤ n :=\n  Nat.zero_le n\nexact h', 'have h : 0 ≤ n := Nat.zero_le n; exact h'); // term continuation
t('induction n with\n| zero => rfl\n| succ k ih => simp [ih]', 'induction n with | zero => rfl | succ k ih => simp [ih]');
t('constructor\n<;> assumption', 'constructor <;> assumption');
t('try simp\nexact h', '(try simp); exact h'); // `try` must not swallow `exact h`
t('rcases h with a | b\n· exact a\n· exact b', '(rcases h with a | b); (· exact a); · exact b');
t('simpa using\n  h', 'simpa using h');
t('exact "a -- b"', 'exact "a -- b"'); // `--` inside a string is not a comment
// can't be put on one line
assert.strictEqual(toSingleLine('calc a = b := h1\n  _ = c := h2'), undefined);
assert.strictEqual(toSingleLine('/- note -/\nsimp'), undefined);
assert.strictEqual(toSingleLine('\n\n'), undefined);
console.log('singleline tests passed');
