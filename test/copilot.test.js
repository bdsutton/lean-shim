// copilot.ts against a fake VS Code / Copilot.
const assert = require('node:assert');
const Module = require('node:module');

class Emitter {
  constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose: () => (this.l = this.l.filter((x) => x !== f)) }); }
  fire(v) { this.l.forEach((f) => f(v)); }
}
const modelsChanged = new Emitter();
const extensionsChanged = new Emitter();
let models = [], copilotInstalled = true, availableCommands = [], commandsRun = [], infoMessages = [], onCommand = () => {}, clickButton = false;
const vscode = {
  lm: { selectChatModels: async () => models, onDidChangeChatModels: modelsChanged.event },
  extensions: { getExtension: (id) => (id === 'github.copilot-chat' && copilotInstalled ? {} : undefined), onDidChange: extensionsChanged.event },
  commands: {
    getCommands: async () => availableCommands,
    executeCommand: async (id) => { commandsRun.push(id); onCommand(id); },
  },
  window: {
    showInformationMessage: async (m, ...buttons) => { infoMessages.push(m); return clickButton ? buttons[0] : undefined; },
    showWarningMessage: async (m) => { infoMessages.push(m); },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const C = require('../out/copilot');
const M = (name, id = name.toLowerCase(), family = id) => ({ name, id, family, vendor: 'copilot' });
const ctx = (allowed) => ({ languageModelAccessInformation: { canSendRequest: () => allowed, onDidChange: new Emitter().event } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { models = []; copilotInstalled = true; availableCommands = []; commandsRun = []; infoMessages = []; onCommand = () => {}; clickButton = false; };

(async () => {
  // states
  reset(); copilotInstalled = false;
  assert.strictEqual(await C.getCopilotState(ctx(true)), 'notInstalled');
  reset();
  assert.strictEqual(await C.getCopilotState(ctx(true)), 'signedOut');
  models = [M('GPT 5')];
  assert.strictEqual(await C.getCopilotState(ctx(true)), 'noAuto');
  models = [M('GPT 5'), M('Auto')];
  assert.strictEqual(await C.getCopilotState(ctx(true)), 'ready');
  assert.strictEqual(await C.getCopilotState(ctx(undefined)), 'needsPermission');
  assert.strictEqual(await C.getCopilotState(ctx(false)), 'denied');
  assert.strictEqual(await C.getCopilotState({}), 'needsPermission'); // no access info: VS Code will ask

  // waitForAuto: resolves when Copilot registers Auto; times out otherwise
  reset();
  setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 50);
  assert.strictEqual((await C.waitForAuto(2000)).name, 'Auto');
  reset();
  assert.strictEqual(await C.waitForAuto(100), undefined);

  // openCopilotSignIn: best available command, with fallbacks
  reset(); availableCommands = ['github.copilot.chat.triggerPermissiveSignIn', 'workbench.action.chat.triggerSetup'];
  assert.strictEqual(await C.openCopilotSignIn(), true);
  assert.deepStrictEqual(commandsRun, ['workbench.action.chat.triggerSetup']);
  reset(); availableCommands = ['github.copilot.chat.triggerPermissiveSignIn'];
  await C.openCopilotSignIn();
  assert.deepStrictEqual(commandsRun, ['github.copilot.chat.triggerPermissiveSignIn']);
  reset();
  assert.strictEqual(await C.openCopilotSignIn(), false);
  reset(); copilotInstalled = false; availableCommands = ['workbench.action.chat.triggerSetup'];
  await C.openCopilotSignIn();
  assert.deepStrictEqual(commandsRun, ['workbench.extensions.installExtension', 'workbench.action.chat.triggerSetup']);

  // watchCopilot 1: Copilot signs itself in during the start-up wait -> no sign-in opened
  reset(); availableCommands = ['workbench.action.chat.triggerSetup'];
  let states = [];
  const w1 = C.watchCopilot(ctx(true), { installWaitMs: 300, startupWaitMs: 500, autoSignIn: true, onState: (s) => states.push(s), log() {} });
  setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 100);
  await sleep(700);
  assert.deepStrictEqual(commandsRun, []);
  assert.strictEqual(states[states.length - 1], 'ready');
  w1.dispose();

  // watchCopilot 2: still signed out after the wait -> opens Copilot's sign-in once; then ready
  reset(); availableCommands = ['workbench.action.chat.triggerSetup'];
  onCommand = (id) => { if (id === 'workbench.action.chat.triggerSetup') setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 100); };
  states = [];
  const w2 = C.watchCopilot(ctx(true), { installWaitMs: 300, startupWaitMs: 200, autoSignIn: true, onState: (s) => states.push(s), log() {} });
  await sleep(800);
  // sign-in opened at start-up, then the Chat side bar it opened is closed again
  assert.deepStrictEqual(commandsRun, ['workbench.action.chat.triggerSetup', 'workbench.action.closeAuxiliaryBar']);
  assert(infoMessages.some((m) => /GitHub Copilot is ready/.test(m)));
  assert.strictEqual(states[states.length - 1], 'ready');
  assert(states.includes('signedOut'));
  w2.dispose();

  // watchCopilot 3: automatic sign-in turned off -> a notification with a button; clicking signs in
  reset(); availableCommands = ['workbench.action.chat.triggerSetup']; clickButton = true;
  onCommand = (id) => { if (id === 'workbench.action.chat.triggerSetup') setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 50); };
  const w3 = C.watchCopilot(ctx(true), { installWaitMs: 300, startupWaitMs: 100, autoSignIn: false, onState() {}, log() {} });
  await sleep(600);
  assert(infoMessages.some((m) => /isn't signed in yet/.test(m)));
  assert.deepStrictEqual(commandsRun, ['workbench.action.chat.triggerSetup', 'workbench.action.closeAuxiliaryBar']);

  // signing in later from the status bar (not at start-up) leaves the Chat view alone
  reset(); availableCommands = ['workbench.action.chat.triggerSetup'];
  onCommand = (id) => { if (id === 'workbench.action.chat.triggerSetup') setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 50); };
  assert.strictEqual(await C.signInToCopilot(2000), true);
  assert.deepStrictEqual(commandsRun, ['workbench.action.chat.triggerSetup']);
  w3.dispose();

  // watchCopilot 4: Copilot Chat is still being installed when the window opens; VS Code finishes, Copilot
  // signs itself in -> no sign-in is opened (the case seen in a new Codespace)
  reset(); availableCommands = ['workbench.action.chat.triggerSetup']; copilotInstalled = false;
  states = [];
  const w4 = C.watchCopilot(ctx(true), { installWaitMs: 3000, startupWaitMs: 1000, autoSignIn: true, onState: (s) => states.push(s), log() {} });
  setTimeout(() => { copilotInstalled = true; extensionsChanged.fire(); }, 1500); // after the 1 s start-up wait
  setTimeout(() => { models = [M('Auto')]; modelsChanged.fire(); }, 1800);
  await sleep(2400);
  assert.deepStrictEqual(commandsRun, [], 'must not open the sign-in while Copilot Chat is still being installed');
  assert.strictEqual(states[states.length - 1], 'ready');
  w4.dispose();

  // watchCopilot 5: Copilot Chat never shows up -> after the install wait, the sign-in (which installs it) opens
  reset(); availableCommands = ['workbench.action.chat.triggerSetup']; copilotInstalled = false;
  onCommand = (id) => { if (id === 'workbench.extensions.installExtension') copilotInstalled = true; };
  const w5 = C.watchCopilot(ctx(true), { installWaitMs: 200, startupWaitMs: 100, autoSignIn: true, onState() {}, log() {} });
  await sleep(700);
  assert.deepStrictEqual(commandsRun.slice(0, 2), ['workbench.extensions.installExtension', 'workbench.action.chat.triggerSetup']);
  w5.dispose();

  // waitForExtension
  reset(); copilotInstalled = false;
  setTimeout(() => { copilotInstalled = true; extensionsChanged.fire(); }, 50);
  assert.strictEqual(await C.waitForExtension('github.copilot-chat', 1000), true);
  reset(); copilotInstalled = false;
  assert.strictEqual(await C.waitForExtension('github.copilot-chat', 100), false);

  console.log('copilot tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
