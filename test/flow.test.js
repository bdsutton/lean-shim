// End-to-end run of the Fill Proof command with a fake editor, a fake Copilot and a fake Lean server.
// Checks the command always finishes (no freeze) after Lean rejects a suggestion, and leaves the file right.
const assert = require('node:assert');
const Module = require('node:module');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  compareTo(o) { return this.line - o.line || this.character - o.character; }
  isEqual(o) { return this.compareTo(o) === 0; }
  isBefore(o) { return this.compareTo(o) < 0; }
  isBeforeOrEqual(o) { return this.compareTo(o) <= 0; }
}
class Range {
  constructor(a, b) { this.start = a; this.end = b; }
  get isEmpty() { return this.start.isEqual(this.end); }
  contains(p) { return this.start.isBeforeOrEqual(p) && p.isBeforeOrEqual(this.end); }
}
class Selection extends Range { get active() { return this.end; } }
class CancellationTokenSource {
  constructor() { this.l = []; this.token = { isCancellationRequested: false, onCancellationRequested: (f) => (this.l.push(f), { dispose() {} }) }; }
  cancel() { this.token.isCancellationRequested = true; this.l.forEach((f) => f()); }
  dispose() {}
}
function makeDoc(text) {
  const doc = {
    text, version: 1, isClosed: false, languageId: 'lean4', eol: 1, uri: { toString: () => 'file:///T.lean' },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(n) { return { text: this.text.split('\n')[n] }; },
    offsetAt(p) { const ls = this.text.split('\n'); let o = 0; for (let i = 0; i < p.line; i++) o += ls[i].length + 1; return Math.min(o + p.character, this.text.length); },
    positionAt(o) { o = Math.max(0, Math.min(o, this.text.length)); const pre = this.text.slice(0, o).split('\n'); return new Position(pre.length - 1, pre[pre.length - 1].length); },
    getText(r) { return r ? this.text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : this.text; },
  };
  return doc;
}
class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(_u, r, t) { this.ops.push([r, t]); }
  insert(_u, p, t) { this.ops.push([new Range(p, p), t]); }
  delete(_u, r) { this.ops.push([r, '']); }
}

let doc, editor, modelReplies, diagsFor, warnings, cmd, requestsSent = 0;
const commandsRun = [];
const fakeModel = (name, id, family) => ({
  name, id, vendor: 'copilot', family, version: '1', maxInputTokens: 1000,
  sendRequest: async () => {
    requestsSent++;
    const r = modelReplies.shift() ?? 'exact bad';
    return { stream: (async function* () { yield { value: r }; })() };
  },
});
// Copilot offers several models; Lean Shim must always pick Auto.
let offeredModels = [fakeModel('GPT Fake', 'gpt-fake', 'gpt-fake'), fakeModel('Auto', 'auto', 'auto')];
let leanBusy = false; // when true, Lean never finishes checking the file
const leanClient = {
  isRunning: () => true,
  sendRequest: async (method) => {
    if (method === 'textDocument/waitForDiagnostics' && leanBusy) return new Promise(() => {});
    return method === '$/lean/plainGoal' ? { goals: ['n : Nat\n⊢ n + 0 = n'] } : {};
  },
};
const vscode = {
  Position, Range, Selection, CancellationTokenSource, WorkspaceEdit,
  EndOfLine: { LF: 1, CRLF: 2 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ThemeColor: class {}, ConfigurationTarget: { Global: 1 },
  LanguageModelChatMessage: { User: (t) => ({ content: t }) }, LanguageModelError: class extends Error {},
  extensions: { getExtension: () => ({ isActive: true, exports: { lean4EnabledFeatures: Promise.resolve({ clientProvider: { getActiveClient: () => leanClient } }) } }) },
  languages: { getDiagnostics: () => diagsFor(doc.text) },
  lm: { selectChatModels: async () => offeredModels, onDidChangeChatModels: () => ({ dispose() {} }) },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),
    asRelativePath: () => 'T.lean',
    applyEdit: async (e) => {
      const ops = e.ops.map(([r, t]) => [doc.offsetAt(r.start), doc.offsetAt(r.end), t]).sort((a, b) => b[0] - a[0]);
      for (const [s, en, t] of ops) doc.text = doc.text.slice(0, s) + t + doc.text.slice(en);
      doc.version++;
      return true;
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    // A notification nobody answers: never resolves (this used to freeze the command).
    showWarningMessage: (m) => { warnings.push(m); return new Promise(() => {}); },
    showErrorMessage: (m) => { warnings.push(m); return new Promise(() => {}); },
    showInformationMessage: (m) => { warnings.push(m); return new Promise(() => {}); },
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: (_o, cb) => cb({ report() {} }, new CancellationTokenSource().token),
    get visibleTextEditors() { return [editor]; },
    activeTextEditor: undefined,
  },
  commands: {
    getCommands: async () => ['workbench.action.chat.triggerSetup'],
    executeCommand: async (id) => { commandsRun.push(id); },
    registerCommand: () => ({ dispose() {} }),
    registerTextEditorCommand: (id, f) => { if (id === 'leanShim.suggest') cmd = f; return { dispose() {} }; },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const ext = require('../out/extension');
ext.activate({ subscriptions: [] });

const FILE = 'theorem t (n : Nat) : n + 0 = n := by\n  \n\ntheorem u : True := trivial\n';
function setup(replies) {
  doc = makeDoc(FILE);
  const cursor = new Position(1, 2);
  editor = { document: doc, selection: new Selection(cursor, cursor), options: { tabSize: 2 }, revealRange() {}, setDecorations() {} };
  modelReplies = replies;
  warnings = [];
  // Lean: the hole (or a bad proof) is an error on `by`; `simp` closes the goal.
  diagsFor = (text) => {
    if (/^  simp$/m.test(text)) return [];
    const line0 = text.split('\n')[0];
    const by = line0.indexOf('by');
    const msg = /exact bad/.test(text) ? 'Unknown identifier `bad`' : 'unsolved goals\nn : Nat\n⊢ n + 0 = n';
    const badLine = text.split('\n').findIndex((l) => l.includes('exact bad'));
    const r = badLine >= 0 ? new Range(new Position(badLine, 8), new Position(badLine, 11)) : new Range(new Position(0, by), new Position(0, by + 2));
    return [{ severity: 0, message: msg, range: r }];
  };
}
const within = (p, ms) => Promise.race([p.then(() => 'finished'), new Promise((r) => setTimeout(() => r('FROZE'), ms))]);

(async () => {
  // 1. Lean rejects attempt 1, accepts attempt 2
  setup(['```lean\nexact bad\n```', '```lean\nsimp\n```']);
  assert.strictEqual(await within(cmd(editor), 5000), 'finished');
  assert.strictEqual(doc.text, 'theorem t (n : Nat) : n + 0 = n := by\n  simp\n\ntheorem u : True := trivial\n');

  // 2. Lean rejects every attempt; the "none passed" notification is never answered
  setup(['```lean\nexact bad\n```', '```lean\nexact bad\n```', '```lean\nexact bad\n```']);
  assert.strictEqual(await within(cmd(editor), 5000), 'finished', 'command froze after Lean rejected every attempt');
  assert.strictEqual(doc.text, FILE, 'file should be restored exactly');
  assert(warnings.some((w) => /none of the 3 suggestion/.test(w)));

  // 3. The command is usable again afterwards (busy was cleared): runs and succeeds
  setup(['```lean\nsimp\n```']);
  assert.strictEqual(await within(cmd(editor), 5000), 'finished');
  assert(!warnings.some((w) => /already being generated/.test(w)), 'should not still be busy');
  assert(doc.text.includes('  simp\n'));

  // 4. Multi-line proof accepted -> rewritten on one line (and the one-line form re-checked)
  setup(['```lean\nhave h : 0 + n = n := by\n  simp\nexact h\n```']);
  diagsFor = (text) => (/exact h/.test(text) ? [] : [{ severity: 0, message: 'unsolved goals\nn : Nat\n⊢ n + 0 = n', range: new Range(new Position(0, 36), new Position(0, 38)) }]);
  assert.strictEqual(await within(cmd(editor), 5000), 'finished');
  assert.strictEqual(doc.text, 'theorem t (n : Nat) : n + 0 = n := by\n  (have h : 0 + n = n := by simp); exact h\n\ntheorem u : True := trivial\n');

  // 5. Lean rejects the one-line form -> the verified multi-line proof is restored
  setup(['```lean\nhave h : 0 + n = n := by\n  simp\nexact h\n```']);
  diagsFor = (text) =>
    /exact h/.test(text) && !/; exact h/.test(text)
      ? []
      : [{ severity: 0, message: 'boom', range: new Range(new Position(1, 2), new Position(1, 5)) }];
  assert.strictEqual(await within(cmd(editor), 5000), 'finished');
  assert.strictEqual(doc.text, 'theorem t (n : Nat) : n + 0 = n := by\n  have h : 0 + n = n := by\n    simp\n  exact h\n\ntheorem u : True := trivial\n');

  // 6. Auto is always the model used
  {
    let used;
    offeredModels = [fakeModel('GPT Fake', 'gpt-fake', 'gpt-fake'), fakeModel('Auto', 'auto', 'auto')];
    offeredModels.forEach((m) => { const send = m.sendRequest; m.sendRequest = (...a) => { used = m.name; return send(...a); }; });
    setup(['```lean\nsimp\n```']);
    assert.strictEqual(await within(cmd(editor), 5000), 'finished');
    assert.strictEqual(used, 'Auto');
  }

  // 7. Copilot doesn't offer Auto: no request is sent, the file is untouched, the user is told
  offeredModels = [fakeModel('GPT Fake', 'gpt-fake', 'gpt-fake')];
  setup(['```lean\nsimp\n```']);
  requestsSent = 0;
  assert.strictEqual(await within(cmd(editor), 5000), 'finished');
  assert.strictEqual(requestsSent, 0);
  assert.strictEqual(doc.text, FILE);
  assert(warnings.some((w) => /Auto model isn't available/.test(w)));

  // 8. Lean still busy with the file: after the short wait, a message; nothing sent, file untouched
  offeredModels = [fakeModel('Auto', 'auto', 'auto')];
  setup(['```lean\nsimp\n```']);
  requestsSent = 0;
  leanBusy = true;
  const t8 = Date.now();
  assert.strictEqual(await within(cmd(editor), 8000), 'finished');
  leanBusy = false;
  assert(Date.now() - t8 < 6000, 'should give up after about readyWaitSeconds (3 s)');
  assert.strictEqual(requestsSent, 0);
  assert.strictEqual(doc.text, FILE);
  assert(warnings.some((w) => /Lean isn't ready yet/.test(w)), 'should ask the user to wait');

  // 9. Copilot not signed in (offers no models): waits briefly, then asks to sign in; nothing sent
  offeredModels = [];
  setup(['```lean\nsimp\n```']);
  requestsSent = 0;
  const t9 = Date.now();
  assert.strictEqual(await within(cmd(editor), 9000), 'finished');
  assert(Date.now() - t9 >= 4500, 'should give Copilot a few seconds to come up first');
  assert.strictEqual(requestsSent, 0);
  assert.strictEqual(doc.text, FILE);
  assert(warnings.some((w) => /GitHub Copilot, which isn't signed in yet/.test(w)));
  offeredModels = [fakeModel('Auto', 'auto', 'auto')];

  console.log('flow tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
