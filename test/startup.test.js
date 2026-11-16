// watchLeanStartup wiring against a fake Lean 4 extension that fires events like the real one.
const assert = require('node:assert');
const Module = require('node:module');

class Emitter {
  constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose: () => (this.l = this.l.filter((x) => x !== f)) }); }
  fire(v) { this.l.forEach((f) => f(v)); }
}
const mkClient = (running) => {
  const c = { restartingE: new Emitter(), restartedE: new Emitter(), failedE: new Emitter(), stoppedE: new Emitter(), running };
  return Object.assign(c, { isRunning: () => c.running, restarting: c.restartingE.event, restarted: c.restartedE.event, serverFailed: c.failedE.event, stopped: c.stoppedE.event });
};
let ext;
const vscode = {
  extensions: { getExtension: () => ext },
  workspace: { textDocuments: [{ uri: { toString: () => 'file:///w/P.lean' }, getText: () => 'import Lean\n\ntheorem a : True := trivial\n' }], asRelativePath: () => 'P.lean' },
  Uri: { parse: (s) => s },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const { watchLeanStartup } = require('../out/startup');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (a, b) => ({ range: { start: { line: a }, end: { line: b } }, kind: 1 });

(async () => {
  // 1. Lean extension loads after us; client added and started afterwards (full timing)
  const added = new Emitter(), progress = new Emitter();
  const provider = { getClients: () => [], clientAdded: added.event, progressChanged: progress.event };
  ext = { isActive: false, exports: undefined };
  let lines = [];
  const d = watchLeanStartup((l) => lines.push(l));
  await sleep(150);
  ext.isActive = true; ext.exports = { lean4EnabledFeatures: Promise.resolve({ clientProvider: provider }) };
  await sleep(250);
  const client = mkClient(false);
  added.fire(client);
  client.restartingE.fire(); await sleep(30); client.restartedE.fire(); client.restartedE.fire();
  progress.fire(['file:///w/P.lean', [R(0, 3)]]); await sleep(30);
  progress.fire(['file:///w/P.lean', [R(2, 2)]]); await sleep(10);
  progress.fire(['file:///w/P.lean', []]);
  let out = lines.join('\n');
  assert.match(out, /==== LEAN SERVER START-UP/);
  assert.match(out, /Lean server starting/);
  assert.strictEqual(lines.filter((l) => /server ready after/.test(l)).length, 1);
  assert.match(out, /P\.lean: imports loaded after/);
  assert.match(out, /P\.lean: finished — .* in total: loading imports .*, checking the file/);
  d.dispose();

  // 2. Server already running when we start watching
  const running = mkClient(true);
  ext = { isActive: true, exports: { lean4EnabledFeatures: Promise.resolve({ clientProvider: { getClients: () => [running], clientAdded: new Emitter().event, progressChanged: new Emitter().event } }) } };
  lines = [];
  const d2 = watchLeanStartup((l) => lines.push(l));
  await sleep(50);
  assert.match(lines.join('\n'), /already running when Lean Proof Fill loaded/);
  // a later manual restart is timed
  running.restartingE.fire(); await sleep(20); running.restartedE.fire();
  assert.match(lines.join('\n'), /Lean server ready after/);
  d2.dispose();

  // 3. No Lean extension installed: nothing logged, no errors
  ext = undefined; lines = [];
  const d3 = watchLeanStartup((l) => lines.push(l)); await sleep(50); d3.dispose();
  assert.strictEqual(lines.length, 0);

  console.log('startup wiring tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
