const assert = require('node:assert');
const { judge, makeBaseline, usesSorry, touches, mapPos, isHoleError } = require('../out/check');

const P = (l, c) => ({ line: l, character: c });
const S = (l1, c1, l2, c2) => ({ start: P(l1, c1), end: P(l2, c2) });
const E = (msg, span) => ({ severity: 'error', message: msg, range: span });
const W = (msg, span) => ({ severity: 'warning', message: msg, range: span });

// usesSorry
assert(usesSorry('  sorry'));
assert(usesSorry('exact foo\nadmit'));
assert(usesSorry('· sorry'));
assert(!usesSorry('exact sorryAx_foo'));
assert(!usesSorry('exact Foo.sorry_lemma'));
assert(!usesSorry('simp -- sorry, no idea'));
assert(!usesSorry('exact h.admits'));

// touches
assert(touches(S(1, 0, 1, 5), S(1, 5, 2, 0)));
assert(!touches(S(1, 0, 1, 4), S(1, 5, 2, 0)));

// Layout from a real Lean run: `theorem a2 (n : Nat) : n + 0 = n := by` on line 0, hole on line 1,
// next theorem on line 2. Region = lines 0..2 (exclusive).
const region = { startLine: 0, endLine: 2 };
const hole = S(1, 0, 1, 0);
const before = [E('unsolved goals\nn : Nat\n⊢ n + 0 = n', S(0, 36, 0, 38))];
const base = makeBaseline(before, region, hole);
// the gap's own 'unsolved goals' error is never part of the baseline
assert.deepStrictEqual(base.errors, []);
assert.strictEqual(base.hadSorryWarning, false);
const ins = S(1, 0, 1, 8); // inserted "  simp\n"-style text

// good proof: no messages
assert(judge([], region, ins, base).ok);
// `skip` (real Lean ranges, cursor indented at column 2): same message as before, range grows from
// (0,36)-(0,38) to (0,36)-(1,0) and doesn't touch the inserted text -> must still be rejected
const indentHole = S(1, 2, 1, 2);
const baseI = makeBaseline(before, region, indentHole);
assert(!judge([E('unsolved goals\nn : Nat\n⊢ n + 0 = n', S(0, 36, 1, 0))], region, S(1, 2, 1, 6), baseI).ok);
// wrong lemma inside the insertion
assert(!judge([E('Type mismatch ...', S(1, 2, 1, 24))], region, ins, base).ok);
// sorry warning on the theorem name (new) -> rejected
assert(!judge([W('declaration uses `sorry`', S(0, 8, 0, 10))], region, ins, base).ok);
// errors in the NEXT declaration are not our business
assert(judge([E('something else', S(2, 0, 2, 5))], region, ins, base).ok);
// parse error starting in our text and running into the next theorem -> rejected
assert(!judge([E("unexpected token 'theorem'", S(1, 9, 3, 7))], region, ins, base).ok);

// Pre-existing unrelated error elsewhere in the same declaration is tolerated…
const region2 = { startLine: 0, endLine: 6 };
const other = E('unknown identifier `foo`', S(4, 8, 4, 11));
const base2 = makeBaseline([before[0], other], region2, hole);
const v = judge([E('unknown identifier `foo`', S(4, 8, 4, 11))], region2, ins, base2);
assert(v.ok && v.tolerated === 1);
// …but a second copy of it (a new error with the same text) is not.
assert(!judge([other, E('unknown identifier `foo`', S(5, 8, 5, 11))], region2, ins, base2).ok);
// A pre-existing sorry warning is tolerated
const base3 = makeBaseline([W('declaration uses `sorry`', S(0, 8, 0, 10))], region, hole);
assert(judge([W('declaration uses `sorry`', S(0, 8, 0, 10))], region, ins, base3).ok);

// mapPos: before the anchor unchanged; after it shifted by the inserted text
const anchor = S(2, 4, 2, 4), now = S(2, 4, 4, 6);
assert.deepStrictEqual(mapPos(P(1, 9), anchor, now), P(1, 9));
assert.deepStrictEqual(mapPos(P(2, 10), anchor, now), P(4, 12));
assert.deepStrictEqual(mapPos(P(7, 3), anchor, now), P(9, 3));
// regenerating: anchor is the old suggestion (2,4)-(3,8), replaced by a one-line one
assert.deepStrictEqual(mapPos(P(5, 1), S(2, 4, 3, 8), S(2, 4, 2, 9)), P(4, 1));
assert.deepStrictEqual(mapPos(P(3, 10), S(2, 4, 3, 8), S(2, 4, 2, 9)), P(2, 11));
// A pre-existing error after the insertion point that moved by the inserted lines is still tolerated
const preAfter = E('unknown identifier `foo`', S(4, 8, 4, 11));
const baseA = makeBaseline([preAfter], { startLine: 0, endLine: 8 }, S(2, 2, 2, 2));
assert(judge([E('unknown identifier `foo`', S(6, 8, 6, 11))], { startLine: 0, endLine: 8 }, S(2, 2, 4, 5), baseA).ok);

// isHoleError: recognised by the goal at the cursor
const two = 'unsolved goals\ncase left\np q : Prop\nhp : p\nhq : q\n⊢ p\n\ncase right\np q : Prop\nhp : p\nhq : q\n⊢ q';
assert(isHoleError(two, 'case left\np q : Prop\nhp : p\nhq : q\n⊢ p'));
assert(isHoleError(two, 'case right\r\np q : Prop\nhp : p\nhq : q\n⊢ q  '));
assert(!isHoleError(two, 'x : Nat\n⊢ x = x'));
assert(isHoleError(two, undefined));
assert(!isHoleError('Type mismatch', undefined));
// Real Lean ranges for `skip` after `constructor`: the error is identical before and after.
const regionC = { startLine: 0, endLine: 3 };
const errC = E(two, S(0, 52, 1, 0));
const goalC = 'case left\np q : Prop\nhp : p\nhq : q\n⊢ p';
const baseC = makeBaseline([errC], regionC, S(2, 2, 2, 2), goalC);
assert(!judge([errC], regionC, S(2, 2, 2, 6), baseC).ok);
// An unrelated unsolved-goals error (different goal, e.g. another unfinished branch) is tolerated
const otherBranch = E('unsolved goals\nx : Nat\n⊢ x = x', S(5, 4, 5, 6));
const baseD = makeBaseline([errC, otherBranch], { startLine: 0, endLine: 7 }, S(2, 2, 2, 2), goalC);
const vD = judge([otherBranch], { startLine: 0, endLine: 7 }, S(2, 2, 2, 10), baseD);
assert(vD.ok && vD.tolerated === 1);

console.log('check tests passed');
