// waitForLean must end promptly on cancel even if the Lean client never answers and ignores the token.
const assert = require('node:assert');
const Module = require('node:module');

let behaviour = 'hang';
const fakeClient = {
  isRunning: () => true,
  sendRequest: () => (behaviour === 'hang' ? new Promise(() => {}) : Promise.resolve({})),
};
class CancellationTokenSource {
  constructor() {
    this.l = [];
    this.token = { isCancellationRequested: false, onCancellationRequested: (f) => (this.l.push(f), { dispose() {} }) };
  }
  cancel() { this.token.isCancellationRequested = true; this.l.forEach((f) => f()); }
}
const vscode = {
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: { lean4EnabledFeatures: Promise.resolve({ clientProvider: { getActiveClient: () => fakeClient } }) },
    }),
  },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const { waitForLean } = require('../out/lean');
const doc = { version: 7, uri: { toString: () => 'file:///x.lean' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // cancel while Lean never answers -> 'cancelled' quickly
  let cts = new CancellationTokenSource();
  const p = waitForLean(doc, 60000, cts.token);
  await sleep(50);
  cts.cancel();
  assert.strictEqual(await Promise.race([p, sleep(2000).then(() => 'still waiting')]), 'cancelled');

  // no cancel, Lean never answers -> 'timeout' at the time limit
  cts = new CancellationTokenSource();
  assert.strictEqual(await waitForLean(doc, 200, cts.token), 'timeout');

  // Lean answers -> 'done'
  behaviour = 'answer';
  assert.strictEqual(await waitForLean(doc, 5000, new CancellationTokenSource().token), 'done');

  console.log('waitForLean tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
