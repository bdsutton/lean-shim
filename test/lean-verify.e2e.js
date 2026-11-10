// Checks the accept/reject rules (src/check.ts) against a real Lean server.
// Usage: npm run compile && node test/lean-verify.e2e.js [path/to/lean]   (needs Lean v4.x on PATH or given)
const { spawn } = require('child_process');
const X = require('path').join(__dirname, '..', 'out') + '/';
const { judge, makeBaseline } = require(X + 'check');
const { layoutInsertion, DECLARATION_START } = require(X + 'format');
const lean = process.argv[2] || 'lean';
const uri = 'file:///tmp/E.lean';
const srv = spawn(lean, ['--server']);
let buf = Buffer.alloc(0), id = 1000; const pending = {}; let diags = [];
srv.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const s = buf.indexOf('\r\n\r\n'); if (s < 0) break;
    const len = +/Content-Length: (\d+)/.exec(buf.slice(0, s).toString())[1];
    if (buf.length < s + 4 + len) break;
    const msg = JSON.parse(buf.slice(s + 4, s + 4 + len)); buf = buf.slice(s + 4 + len);
    if (msg.method && msg.id !== undefined) { send({ id: msg.id, result: null }); continue; }
    if (!msg.method && msg.id !== undefined && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
    if (msg.method === 'textDocument/publishDiagnostics') { if (!msg.params.isIncremental) diags = []; diags.push(...msg.params.diagnostics); }
  }
});
const send = (m) => { const s = JSON.stringify({ jsonrpc: '2.0', ...m }); srv.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const req = (method, params) => new Promise((r) => { const i = ++id; pending[i] = r; send({ id: i, method, params }); });
let version = 0, opened = false;
async function setText(text) {
  version++;
  if (!opened) { send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'lean4', version, text } } }); opened = true; }
  else send({ method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
  await req('textDocument/waitForDiagnostics', { uri, version });
  return diags.map((d) => ({ severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'other', message: d.message, range: d.range }));
}
const posAt = (text, off) => { const pre = text.slice(0, off).split('\n'); return { line: pre.length - 1, character: pre[pre.length - 1].length }; };
function region(lines, s, e) { let a = s.line; while (a > 0 && !DECLARATION_START.test(lines[a])) a--; let b = e.line + 1; while (b < lines.length && !DECLARATION_START.test(lines[b])) b++; return { startLine: a, endLine: b }; }

async function run(label, file, proof, expectOk) {
  const off = file.indexOf('§'); const orig = file.replace('§', '');
  const p = posAt(orig, off); const lines = orig.split('\n');
  const d0 = await setText(orig);
  const hole = { start: p, end: p };
  const m = /\S\s*$/.exec(orig.slice(0, off)); const prev = posAt(orig, m.index + 1);
  const g = await req('$/lean/plainGoal', { textDocument: { uri }, position: prev });
  const goal = g.result && g.result.goals[0];
  const base = makeBaseline(d0, region(lines, p, p), hole, goal);
  const text = layoutInsertion(proof, lines[p.line].slice(0, p.character), '\n');
  const now = orig.slice(0, off) + text + orig.slice(off);
  const ins = { start: p, end: posAt(now, off + text.length) };
  const d1 = await setText(now);
  const v = judge(d1, region(now.split('\n'), ins.start, ins.end), ins, base);
  const mark = v.ok === expectOk ? 'PASS' : 'FAIL';
  console.log(`${mark} ${label}: goal=${goal ? 'yes' : 'NO'} verified=${v.ok} tolerated=${v.tolerated}${v.problems.length ? ' problems=' + JSON.stringify(v.problems.map((x) => x.message.split('\n')[0])) : ''}`);
  return v.ok === expectOk;
}
const F1 = `theorem a2 (n : Nat) : n + 0 = n := by
  §

theorem next (n : Nat) : n = n := rfl
`;
const F2 = `theorem t (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  §
`;
const F3 = `theorem m (n : Nat) (h : n = 2) : n + n = 4 := by
  subst h
  §
  rfl
`;
const F4 = `theorem pre (a b : Nat) : a + b = b + a ∧ True := by
  constructor
  · §
  · exact foo_unknown
`;
const F5 = `theorem inl (n : Nat) : n + 0 = n := by§

theorem other : True := trivial
`;
(async () => {
  await req('initialize', { processId: null, rootUri: null, capabilities: {} });
  send({ method: 'initialized', params: {} });
  const results = [
    await run('empty by, correct (simp)', F1, 'simp', true),
    await run('empty by, does nothing (skip)', F1, 'skip', false),
    await run('empty by, wrong lemma', F1, 'exact Nat.add_comm n 0', false),
    await run('empty by, unknown identifier', F1, 'exact foo_bar n', false),
    await run('empty by, parse error', F1, 'exact (', false),
    await run('empty by, sorry', F1, 'sorry', false),
    await run('after constructor, closes both', F2, 'exact hp\nexact hq', true),
    await run('after constructor, closes only first', F2, 'exact hp', false),
    await run('between existing steps, correct (no-op ok)', F3, 'show 2 + 2 = 4', true),
    await run('between existing steps, breaks the next step', F3, 'exact absurd', false),
    await run('bullet, unrelated pre-existing error tolerated', F4, 'exact Nat.add_comm a b', true),
    await run('bullet, wrong proof with pre-existing error', F4, 'exact rfl', false),
    await run('after constructor, does nothing (skip)', F2, 'skip', false),
    await run('bullet, does nothing (skip) with pre-existing error', F4, 'skip', false),
    await run('between existing steps, no-op skip (proof already complete)', F3, 'skip', true),
    await run('multi-line insert before a pre-existing error that shifts down', F4, 'rw [Nat.add_comm]', true),
    await run('after constructor, nothing at all (comment)', F2, '-- hmm', false),
    await run('inline after := by, correct', F5, 'simp', true),
    await run('inline after := by, multi-line correct', F5, 'rw [Nat.add_zero]', true),
  ];
  console.log(results.every(Boolean) ? 'ALL E2E PASSED' : 'SOME E2E FAILED');
  srv.kill();
})();
