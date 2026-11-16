const assert = require('node:assert');
const { StartupTracker, lastImportLine } = require('../out/startup-tracker');

// lastImportLine
assert.strictEqual(lastImportLine('-- c\nimport Lean\n\nopen Lean\n'), 1);
assert.strictEqual(lastImportLine('/- doc\n   more -/\nimport Mathlib\nimport LeanShim.Base64\ntheorem t := 1'), 3);
assert.strictEqual(lastImportLine('module\n\npublic import Lean\n\ndef x := 1'), 2);
assert.strictEqual(lastImportLine('theorem t : True := trivial'), -1);

function make(text) {
  let t = 0;
  const lines = [];
  const tr = new StartupTracker({ log: (l) => lines.push(l.replace(/^\[[^\]]*\] /, '')), now: () => t, docText: () => text, fileName: () => 'P.lean' });
  return { tr, lines, at: (ms) => (t = ms) };
}
const R = (a, b) => ({ range: { start: { line: a }, end: { line: b } }, kind: 1 });

// The real event sequence from a Lean v4.35.0 server for a file importing `Lean` (times in ms),
// with the declaration on line 8 made slow (5 s) to exercise the "slowest parts" report.
const text = '-- header comment\nimport Lean\n\nopen Lean\n\ntheorem a : 1 = 1 := rfl\n\ntheorem b (n : Nat) : n + 0 = n := by simp\n\nexample : 2 + 2 = 4 := by decide\n';
{
  const { tr, lines, at } = make(text);
  at(0); tr.serverStarting();
  at(1500); tr.serverReady();
  at(1600); tr.serverReady(); // reported twice by the Lean extension; logged once
  at(1891); tr.progress('u', [R(0, 10)]);
  at(2157); tr.progress('u', [R(0, 10)]);
  at(9731); tr.progress('u', [R(3, 3), R(5, 10)]);
  at(9733); tr.progress('u', [R(5, 5), R(7, 10)]);
  at(9752); tr.progress('u', [R(7, 7), R(9, 10)]);
  at(14752); tr.progress('u', [R(9, 9)]);
  at(14763); tr.progress('u', []);
  at(20000); tr.progress('u', [R(7, 10)]); // later re-check after an edit: not logged
  const out = lines.join('\n');
  console.log(out);
  assert.match(out, /Lean server ready after 1\.5s\./);
  assert.strictEqual(lines.filter((l) => /server ready/.test(l)).length, 1);
  assert.match(out, /P\.lean: Lean started processing the file — loading imports \(lines 1–2\)/);
  assert.match(out, /P\.lean: imports loaded after 7\.8s\./);
  assert.match(out, /finished — 12\.9s in total: loading imports 7\.8s, checking the file 5\.0s\./);
  assert.match(out, /line 8: 5\.0s  theorem b \(n : Nat\)/);
  assert.strictEqual(lines.filter((l) => /finished/.test(l)).length, 1);
}
// Fatal error while loading imports (e.g. missing module)
{
  const { tr, lines, at } = make('import Nope\ntheorem t : True := trivial\n');
  at(0); tr.progress('u', [R(0, 1)]);
  at(300); tr.progress('u', [{ range: { start: { line: 0 }, end: { line: 1 } }, kind: 2 }]);
  assert.match(lines.join('\n'), /fatal error at line 1 after 0\.3s/);
}
// Tracking began after Lean had already moved past the imports
{
  const { tr, lines, at } = make(text);
  at(0); tr.progress('u', [R(5, 10)]);
  at(400); tr.progress('u', []);
  const out = lines.join('\n');
  assert.match(out, /already processing this file when tracking began/);
  assert.match(out, /finished — 0\.4s from when tracking began/);
}
// A server restart resets file tracking, so the next processing is timed again
{
  const { tr, lines, at } = make(text);
  at(0); tr.progress('u', [R(0, 10)]); at(100); tr.progress('u', []);
  at(200); tr.serverStarting(); at(300); tr.serverReady();
  at(400); tr.progress('u', [R(0, 10)]); at(900); tr.progress('u', []);
  assert.strictEqual(lines.filter((l) => /finished/.test(l)).length, 2);
}
console.log('startup-tracker tests passed');
