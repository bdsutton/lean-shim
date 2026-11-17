// Tests the model request time limit and cancellation using the compiled extension and a stub VS Code API.
const assert = require('node:assert');
const Module = require('node:module');

const warnings = [];
let settings = { modelTimeoutSeconds: 10 };
class CancellationTokenSource {
  constructor() {
    this.listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (f) => { this.listeners.push(f); return { dispose() {} }; },
    };
  }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; this.listeners.forEach((f) => f()); } }
  dispose() {}
}
const disposable = { dispose() {} };
const vscode = {
  CancellationTokenSource,
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  LanguageModelChatMessage: { User: (t) => ({ role: 'user', content: t }) },
  LanguageModelError: class extends Error {},
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => disposable,
    onDidChangeActiveTextEditor: () => disposable,
    showWarningMessage: (m) => { warnings.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { warnings.push(m); return Promise.resolve(undefined); },
    activeTextEditor: undefined,
  },
  commands: { registerCommand: () => disposable, registerTextEditorCommand: () => disposable, getCommands: async () => [], executeCommand: async () => undefined },
  lm: { selectChatModels: async () => [], onDidChangeChatModels: () => disposable },
  extensions: { getExtension: () => undefined },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const ext = require('../out/extension');
ext.activate({ subscriptions: [] });
const askModel = ext._askModelForTest;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeModel = (stream) => ({
  name: 'Fake', id: 'fake-1', vendor: 'copilot', family: 'fake', version: '1', maxInputTokens: 1000,
  sendRequest: async () => ({ stream: stream() }),
});
class TextPart { constructor(v) { this.value = v; } }

(async () => {
  // 1. normal reply
  let run = new CancellationTokenSource();
  const ok = await askModel(fakeModel(async function* () { yield new TextPart('```lean\nsimp\n```'); }), 'p', run.token);
  assert.strictEqual(ok, 'simp');

  // 2. a stream that stalls forever: the time limit must end it (time limit shortened for the test)
  settings.modelTimeoutSeconds = 10;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (f, ms, ...a) => realSetTimeout(f, ms >= 10000 ? 200 : ms, ...a); // 10 s -> 0.2 s
  run = new CancellationTokenSource();
  let t = Date.now();
  const stalled = await askModel(fakeModel(async function* () { yield new TextPart('partial'); await new Promise(() => {}); }), 'p', run.token);
  global.setTimeout = realSetTimeout;
  assert.strictEqual(stalled, 'error');
  assert(Date.now() - t < 2000, 'should end promptly');
  assert(warnings.some((w) => /did not finish responding within 10s/.test(w)), 'should tell the user about the time limit');

  // 3. "Cancel it" / notification Cancel while the model is stalled -> 'cancelled', promptly
  run = new CancellationTokenSource();
  t = Date.now();
  const p = askModel(fakeModel(async function* () { await new Promise(() => {}); }), 'p', run.token);
  await sleep(50);
  run.cancel();
  const cancelled = await Promise.race([p, sleep(2000).then(() => 'still running')]);
  assert.strictEqual(cancelled, 'cancelled');

  // 4. cancellation while the stream keeps producing text (ignores the token) also stops it
  run = new CancellationTokenSource();
  const p2 = askModel(fakeModel(async function* () { for (;;) { yield new TextPart('x'); await sleep(5); } }), 'p', run.token);
  await sleep(50);
  run.cancel();
  assert.strictEqual(await Promise.race([p2, sleep(2000).then(() => 'still running')]), 'cancelled');

  console.log('askModel tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
