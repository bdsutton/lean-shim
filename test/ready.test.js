// checkLeanReady against a fake Lean 4 extension.
const assert = require('node:assert');
const Module = require('node:module');

class Emitter {
  constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose() {} }); }
  fire(v) { this.l.forEach((f) => f(v)); }
}
class CTS {
  constructor() { this.l = []; this.token = { isCancellationRequested: false, onCancellationRequested: (f) => (this.l.push(f), { dispose() {} }) }; }
  cancel() { this.token.isCancellationRequested = true; this.l.forEach((f) => f()); }
}
let ext;
const vscode = { extensions: { getExtension: () => ext } };
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const { checkLeanReady, trackLeanProgress } = require('../out/ready');

const progress = new Emitter();
let client = { running: true, answer: true };
const leanClient = {
  isRunning: () => client.running,
  sendRequest: () => (client.answer ? Promise.resolve({}) : new Promise(() => {})),
};
const provider = { getActiveClient: () => (client ? leanClient : undefined), progressChanged: progress.event };
const activeExt = () => ({ isActive: true, exports: { lean4EnabledFeatures: Promise.resolve({ clientProvider: provider }) } });
const text = 'import Mathlib\n\ntheorem a : True := trivial\n\ntheorem b : True := trivial\n';
const doc = { version: 3, uri: { toString: () => 'file:///w/T.lean' }, getText: () => text };
const R = (a, b) => ({ range: { start: { line: a }, end: { line: b } }, kind: 1 });

(async () => {
  ext = undefined;
  assert.deepStrictEqual(await checkLeanReady(doc, 1000, new CTS().token), { ready: true }); // no Lean extension: nothing to check

  ext = { isActive: false };
  assert.match((await checkLeanReady(doc, 1000, new CTS().token)).reason, /extension is still starting/);

  ext = activeExt();
  trackLeanProgress();
  await new Promise((r) => setTimeout(r, 50));

  const savedClient = client; client = undefined;
  assert.match((await checkLeanReady(doc, 1000, new CTS().token)).reason, /has not started for this file/);
  client = { ...savedClient, running: false };
  assert.match((await checkLeanReady(doc, 1000, new CTS().token)).reason, /server is still starting/);

  client = { running: true, answer: true };
  assert.deepStrictEqual(await checkLeanReady(doc, 1000, new CTS().token), { ready: true });

  // Lean busy: gives up after the budget and says what Lean is doing
  client = { running: true, answer: false };
  progress.fire(['file:///w/T.lean', [R(0, 5)]]);
  let t = Date.now();
  let r = await checkLeanReady(doc, 300, new CTS().token);
  assert(Date.now() - t < 1500, 'should give up after about the budget');
  assert.match(r.reason, /loading this file's imports/);
  progress.fire(['file:///w/T.lean', [R(4, 5)]]);
  r = await checkLeanReady(doc, 200, new CTS().token);
  assert.match(r.reason, /checking this file \(line 5 of 6\)/);

  // cancelled while waiting
  const c = new CTS();
  const p = checkLeanReady(doc, 5000, c.token);
  setTimeout(() => c.cancel(), 50);
  r = await p;
  assert.strictEqual(r.cancelled, true);

  console.log('ready tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
