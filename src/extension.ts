import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Baseline, describe, judge, makeBaseline, touches, usesSorry } from './check';
import { singleLineObstacle, toSingleLine } from './singleline';
import { CopilotState, copilotModels, getCopilotState, signInToCopilot, stateMessage, waitForAuto, watchCopilot } from './copilot';
import { checkLeanReady, Readiness, trackLeanProgress } from './ready';
import { watchLeanStartup } from './startup';
import { buildPrompt, extractProof, layoutInsertion } from './format';
import { goalAtCursor, GoalResult } from './goal';
import { currentDiags, declarationRegion, span, WaitResult, waitForLean } from './lean';

/** What we inserted last time, so pressing the button again can swap it for a new suggestion. */
interface LastInsertion {
  uri: string;
  /** Document version immediately after our edit. */
  version: number;
  range: vscode.Range;
  text: string;
  /** Raw proofs suggested so far at this spot (most recent last). */
  history: string[];
  /** Goal at this spot, found before the first suggestion (reused when regenerating). */
  goal?: GoalResult;
  /** Lean's messages in the declaration before anything was inserted. */
  baseline?: Baseline;
  /** Lean's complaints about the most recent attempt (fed back to the model). */
  problems?: string[];
}

let last: LastInsertion | undefined;
let busy = false;
let extContext: vscode.ExtensionContext;
/** Copilot's readiness, kept up to date by watchCopilot (assume fine until known). */
let copilot: CopilotState = 'ready';
/** Cancels the request in progress (also triggered by the progress notification's Cancel button). */
let currentRun: vscode.CancellationTokenSource | undefined;
let statusItem: vscode.StatusBarItem;
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  startLeanWarmUp();
  log = vscode.window.createOutputChannel('Lean Shim');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'leanShim.suggest';
  setIdleStatus();
  updateStatusVisibility(vscode.window.activeTextEditor);

  if (vscode.workspace.getConfiguration('leanShim').get<boolean>('logLeanStartup', true)) {
    context.subscriptions.push(watchLeanStartup((line) => log.appendLine(line)));
  }

  context.subscriptions.push(trackLeanProgress());
  context.subscriptions.push(
    vscode.commands.registerCommand('leanShim.copilotStatus', copilotStatusAction),
    watchCopilot(context, {
      startupWaitMs: 20000,
      autoSignIn: vscode.workspace.getConfiguration('leanShim').get<boolean>('autoSignInToCopilot', true),
      onState: (s) => {
        copilot = s;
        if (!busy) setIdleStatus();
      },
      log: (line) => log.appendLine(line),
    }),
  );

  context.subscriptions.push(
    statusItem,
    log,
    vscode.commands.registerCommand('leanShim.showLog', () => log.show(true)),
    vscode.commands.registerCommand('leanShim.showStartupTimeline', () => log.show(true)),
    vscode.commands.registerTextEditorCommand('leanShim.suggest', (editor) => suggest(editor)),
    vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
  );
}

export function deactivate() {}

function setIdleStatus() {
  if (copilot === 'signedOut' || copilot === 'notInstalled') {
    statusItem.text = '$(account) Sign in to Copilot';
    statusItem.tooltip = `${stateMessage(copilot)} Click to sign in.`;
    statusItem.command = 'leanShim.copilotStatus';
  } else if (copilot === 'denied' || copilot === 'noAuto') {
    statusItem.text = '$(warning) Fill Proof';
    statusItem.tooltip = `${stateMessage(copilot)} Click for details.`;
    statusItem.command = 'leanShim.copilotStatus';
  } else {
    statusItem.text = '$(sparkle) Fill Proof';
    statusItem.tooltip = 'Insert AI-suggested Lean proof steps at the cursor (press again for a different suggestion)';
    statusItem.command = 'leanShim.suggest';
  }
}

/**
 * Backup start for the repo's warm-up script (.devcontainer/warm-lean.sh), which reads ahead of time
 * the files Lean needs first. The Codespace's start-up step normally starts it; the script runs at most
 * once per boot, so this does nothing if it already ran.
 */
function startLeanWarmUp() {
  if (process.platform !== 'linux') return;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const script = path.join(folder.uri.fsPath, '.devcontainer', 'warm-lean.sh');
    if (!fs.existsSync(script)) continue;
    execFile('bash', [script], { cwd: folder.uri.fsPath, timeout: 30000 }, () => undefined);
    return;
  }
}

/** What the status bar button does when Copilot isn't usable. */
async function copilotStatusAction() {
  const state = await getCopilotState(extContext);
  copilot = state;
  if (!busy) setIdleStatus();
  if (state === 'signedOut' || state === 'notInstalled') await signInToCopilot();
  else if (state === 'ready' || state === 'needsPermission') void vscode.window.showInformationMessage(stateMessage(state));
  else void vscode.window.showWarningMessage(stateMessage(state));
}

function updateStatusVisibility(editor: vscode.TextEditor | undefined) {
  if (editor?.document.languageId === 'lean4') statusItem.show();
  else statusItem.hide();
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/** Lean Shim always uses Copilot's Auto model. Handles Copilot not being signed in or allowed. */
async function getModel(): Promise<vscode.LanguageModelChat | undefined> {
  let state = await getCopilotState(extContext);
  if (state === 'signedOut') {
    // Copilot may still be starting up (its models appear a few seconds after the window opens).
    statusItem.text = '$(loading~spin) Waiting for Copilot…';
    if (await waitForAuto(5000)) state = await getCopilotState(extContext);
  }
  if (state === 'ready' || state === 'needsPermission') {
    // needsPermission: VS Code asks the user once, when this first request is sent.
    return (await copilotModels()).auto;
  }

  // Not awaited: an unanswered notification must not keep the command running.
  if (state === 'signedOut' || state === 'notInstalled') {
    void vscode.window
      .showInformationMessage(`${stateMessage(state)} Sign in, then try again.`, 'Sign in to Copilot')
      .then((choice) => choice && void signInToCopilot());
  } else if (state === 'noAuto') {
    try {
      await logAvailableModels("Copilot's Auto model was not among the models VS Code offers to extensions.");
    } catch (e) {
      log.appendLine(`Could not list models: ${e instanceof Error ? e.message : String(e)}`);
    }
    void vscode.window.showErrorMessage(
      "Lean Shim: Copilot's Auto model isn't available to extensions right now, so no request was sent. " +
        'The models VS Code does offer are listed in the Lean Shim output panel.',
    );
  } else if (state === 'denied') {
    void vscode.window.showWarningMessage(stateMessage(state));
  }
  return undefined;
}

/** Every readable, non-function property of a model object (own and inherited getters). */
function modelProperties(m: vscode.LanguageModelChat): [string, unknown][] {
  const seen = new Set<string>();
  const out: [string, unknown][] = [];
  for (let o: object | null = m; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor' || key.startsWith('_') || seen.has(key)) continue;
      seen.add(key);
      let value: unknown;
      try {
        value = (m as unknown as Record<string, unknown>)[key];
      } catch (e) {
        value = `<error reading: ${e instanceof Error ? e.message : String(e)}>`;
      }
      if (typeof value !== 'function') out.push([key, value]);
    }
  }
  return out;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Write full information about all available language models to the output panel. */
async function logAvailableModels(reason: string): Promise<void> {
  const all = await vscode.lm.selectChatModels();
  logSection(`${new Date().toLocaleString()} — AVAILABLE LANGUAGE MODELS (${all.length})`, '=');
  log.appendLine(reason);
  log.appendLine('Lean Shim only uses Copilot\'s Auto model (vendor "copilot", id/family/name "auto").');
  const known = ['name', 'id', 'vendor', 'family', 'version', 'maxInputTokens'];
  all.forEach((m, i) => {
    logSection(`${i + 1}. ${m.name}`);
    const props = new Map(modelProperties(m));
    for (const k of known) log.appendLine(`  ${k.padEnd(16)} ${formatValue(props.has(k) ? props.get(k) : (m as unknown as Record<string, unknown>)[k])}`);
    for (const [k, v] of props) if (!known.includes(k)) log.appendLine(`  ${k.padEnd(16)} ${formatValue(v)}`);
  });
  if (!all.length) log.appendLine('No language models are available. Is GitHub Copilot Chat installed and signed in?');
  log.appendLine('');
  log.show(true); // reveal the panel without taking focus
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

function isRegeneration(editor: vscode.TextEditor): boolean {
  if (!last) return false;
  const doc = editor.document;
  if (doc.uri.toString() !== last.uri || doc.version !== last.version) return false;
  if (doc.getText(last.range) !== last.text) return false;
  // Only treat it as "try again" if the cursor is still on/at the edges of our insertion.
  return last.range.contains(editor.selection.active);
}

/** Lean's complaints inside the rejected suggestion (used when verification is turned off). */
function rejectedSuggestionProblems(doc: vscode.TextDocument, prev: vscode.Range): string[] {
  return currentDiags(doc)
    .filter((d) => d.severity === 'error' && touches(d.range, span(prev)))
    .slice(0, 10)
    .map((d) => describe(d, doc.lineAt(d.range.start.line).text));
}

async function suggest(editor: vscode.TextEditor) {
  if (editor.document.languageId !== 'lean4') {
    vscode.window.showWarningMessage('Lean Shim only works in Lean 4 files.');
    return;
  }
  if (busy) {
    void vscode.window
      .showInformationMessage('Lean Shim: a suggestion is already being generated.', 'Cancel it')
      .then((choice) => {
        if (choice) currentRun?.cancel();
      });
    return;
  }
  busy = true;
  try {
    await runSuggest(editor);
  } finally {
    busy = false;
    setIdleStatus();
  }
}

type Outcome = 'verified' | 'unverified' | 'failed' | 'cancelled' | 'aborted' | 'error';

async function askModel(
  model: vscode.LanguageModelChat,
  prompt: string,
  runToken: vscode.CancellationToken,
): Promise<string | 'cancelled' | 'error'> {
  const timeoutSec = Math.max(10, vscode.workspace.getConfiguration('leanShim').get<number>('modelTimeoutSeconds', 120));
  const cts = new vscode.CancellationTokenSource();
  const sub = runToken.onCancellationRequested(() => cts.cancel());
  const token = cts.token;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cts.cancel();
      reject(new Error(`the model did not finish responding within ${timeoutSec}s`));
    }, timeoutSec * 1000);
  });
  deadline.catch(() => undefined); // handled where it is raced
  // End the wait as soon as the run is cancelled, even if the model's stream never yields again.
  const cancelled = new Promise<never>((_, reject) => {
    if (token.isCancellationRequested) reject(new Error('cancelled'));
    token.onCancellationRequested(() => reject(new Error('cancelled')));
  });
  cancelled.catch(() => undefined);
  try {
    return await Promise.race([deadline, cancelled, askModelInner(model, prompt, token)]);
  } catch (err) {
    if (runToken.isCancellationRequested && !timedOut) return 'cancelled';
    logSection('ERROR');
    log.appendLine(timedOut ? `${model.name} did not finish responding within ${timeoutSec}s; request cancelled.` : err instanceof Error ? err.message : String(err));
    if (timedOut) {
      vscode.window.showWarningMessage(
        `Lean Shim: ${model.name} did not finish responding within ${timeoutSec}s, so the request was cancelled. ` +
          'Try again, or raise leanShim.modelTimeoutSeconds.',
      );
    } else {
      reportError(err);
    }
    return 'error';
  } finally {
    clearTimeout(timer);
    sub.dispose();
    cts.dispose();
  }
}

async function askModelInner(
  model: vscode.LanguageModelChat,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<string> {
  {
    logSection('MODEL REQUESTED');
    for (const k of ['name', 'id', 'vendor', 'family', 'version', 'maxInputTokens'] as const) {
      log.appendLine(`  ${k.padEnd(16)} ${formatValue(model[k])}`);
    }
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'Lean Shim sends the current Lean file to Copilot to suggest proof steps at your cursor.' },
      token,
    );

    // VS Code's API has no field naming the model that actually served the request (Copilot's
    // routing notice is shown only in its own chat UI). Log everything the response does expose:
    // extra properties on the response object, and any non-text parts in its stream, so routing
    // metadata appears here if Copilot ever attaches it.
    const extraProps = Object.getOwnPropertyNames(response).filter((k) => k !== 'text' && k !== 'stream');
    const extras: string[] = extraProps.map((k) => `response.${k} = ${formatValue((response as unknown as Record<string, unknown>)[k])}`);
    let reply = '';
    const stream = (response as unknown as { stream?: AsyncIterable<unknown> }).stream;
    if (stream) {
      for await (const part of stream) {
        if (token.isCancellationRequested) throw new Error('cancelled');
        // Text parts are the only parts with a string `value` (data parts have `data`, tool calls `callId`).
        const value = (part as { value?: unknown } | null)?.value;
        if (typeof value === 'string') reply += value;
        else extras.push(describeStreamPart(part));
      }
    } else {
      for await (const chunk of response.text) {
        if (token.isCancellationRequested) throw new Error('cancelled');
        reply += chunk;
      }
    }

    logSection('MODEL ROUTING INFORMATION');
    if (extras.length) for (const e of extras) log.appendLine(`  ${e}`);
    else {
      log.appendLine(
        `  The response did not report which model served it. It was sent to "${model.name}" (id ${model.id}, family ${model.family}).`,
      );
      if (/auto/i.test(`${model.id} ${model.family} ${model.name}`)) {
        log.appendLine('  This is an auto-routing model, so Copilot chose the actual model; VS Code does not expose which one.');
      }
    }
    logSection('RAW REPLY');
    log.appendLine(reply);
    return extractProof(reply);
  }
}

/** Describe a non-text part of a response stream (data parts are decoded when they're text/JSON). */
function describeStreamPart(part: unknown): string {
  const kind = (part as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof part;
  const p = part as { mimeType?: unknown; data?: unknown } | null;
  if (p && typeof p.mimeType === 'string' && p.data instanceof Uint8Array) {
    const textual = /^(text\/|application\/(json|.*\+json))/.test(p.mimeType);
    const body = textual ? Buffer.from(p.data).toString('utf8') : `<${p.data.length} bytes>`;
    return `${kind} [${p.mimeType}]: ${body.length > 2000 ? body.slice(0, 2000) + '…' : body}`;
  }
  const s = formatValue(part);
  return `${kind}: ${s.length > 2000 ? s.slice(0, 2000) + '…' : s}`;
}

/** Replace `range` (only ever our own text, or an empty range at the cursor) with `text`. */
async function replaceOwnText(doc: vscode.TextDocument, range: vscode.Range, text: string): Promise<vscode.Range | undefined> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, text);
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  return new vscode.Range(range.start, doc.positionAt(doc.offsetAt(range.start) + text.length));
}

async function runSuggest(editor: vscode.TextEditor) {
  const doc = editor.document;
  const cfg = vscode.workspace.getConfiguration('leanShim');

  // Don't start unless Lean is ready (server running, this file fully checked): otherwise the goal
  // lookup and the check of the suggestion would sit waiting for Lean. Wait a few seconds at most.
  const waitMs = Math.max(0, cfg.get<number>('readyWaitSeconds', 3)) * 1000;
  statusItem.text = '$(loading~spin) Checking Lean…';
  const probe = new vscode.CancellationTokenSource();
  currentRun = probe; // so "Cancel it" works while waiting
  let readiness: Readiness;
  try {
    readiness = await checkLeanReady(doc, waitMs, probe.token);
  } finally {
    if (currentRun === probe) currentRun = undefined;
    probe.dispose();
  }
  if (!readiness.ready) {
    if (!readiness.cancelled) {
      log.appendLine(`[${new Date().toLocaleTimeString()}] Not started: Lean isn't ready (${readiness.reason}).`);
      void vscode.window.showInformationMessage(
        `Lean Shim: Lean isn't ready yet — ${readiness.reason}. ` +
          "Please wait until it's done (the orange bar beside the editor shows what Lean is still working on), then try again.",
      );
    }
    return;
  }

  const regenerate = isRegeneration(editor);
  const verify = cfg.get<boolean>('verify', true);
  const maxAttempts = verify ? Math.min(10, Math.max(1, Math.floor(cfg.get<number>('maxAttempts', 3)))) : 1;
  const timeoutMs = Math.max(5, cfg.get<number>('verifyTimeoutSeconds', 120)) * 1000;

  // The range we replace: an empty range at the cursor (pure insertion), or our own previous
  // suggestion when regenerating. Nothing outside it is ever touched.
  let target = regenerate ? last!.range : new vscode.Range(editor.selection.active, editor.selection.active);
  const origin = target.start;
  const history = regenerate ? [...last!.history] : [];
  let goal = regenerate ? last!.goal : undefined;
  let baseline = regenerate ? last!.baseline : undefined;
  let problems: string[] = regenerate
    ? (last!.problems ?? (verify ? [] : rejectedSuggestionProblems(doc, target)))
    : [];

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 2;

  const model = await getModel();
  if (!model) return;

  let expectedVersion = doc.version;
  let outcome = 'failed' as Outcome;
  let note = '';
  let attemptsMade = 0;
  let lastAttemptText: string | undefined;
  let lastProof: string | undefined;
  const singleLine = cfg.get<string>('acceptedProofFormat', 'singleLine') === 'singleLine';
  statusItem.text = '$(loading~spin) Filling proof…';

  logSection(
    `${new Date().toLocaleString()} — ${regenerate ? 'new suggestion requested for the same spot' : 'new suggestion'}` +
      ` — model: ${model.name} (${model.family}) — ${vscode.workspace.asRelativePath(doc.uri)}:${origin.line + 1}:${origin.character + 1}`,
    '=',
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Lean Shim', cancellable: true },
    async (progress, progressToken) => {
      const run = new vscode.CancellationTokenSource();
      currentRun = run;
      const sub = progressToken.onCancellationRequested(() => run.cancel());
      const token = run.token;

      // Run one step, logging when it starts and finishes, and showing elapsed time, so a slow step
      // is visible (and cancellable) rather than looking like a freeze.
      const clock = () => new Date().toLocaleTimeString();
      const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        const t0 = Date.now();
        log.appendLine(`[${clock()}] ${label}…`);
        statusItem.tooltip = `Lean Shim: ${label}… (click to cancel)`;
        progress.report({ message: `${label}…` });
        const tick = setInterval(
          () => progress.report({ message: `${label}… ${Math.round((Date.now() - t0) / 1000)}s` }),
          5000,
        );
        try {
          return await work();
        } finally {
          clearInterval(tick);
          log.appendLine(`[${clock()}] ${label}: finished after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      };
      try {
      // Lean only reports goals and messages for parts of the file it has finished checking.
      let w: WaitResult | undefined;
      if (!goal || (verify && !baseline)) {
        w = await step('waiting for Lean to finish checking the file', () => waitForLean(doc, timeoutMs, token));
        log.appendLine(`  result: ${w}`);
        if (w === 'cancelled') {
          outcome = 'cancelled';
          return;
        }
      }

      // Only the current goal at the cursor is sent. When regenerating, the goal found the first
      // time is reused: the document now contains the rejected suggestion, which can confuse Lean.
      if (!goal) {
        goal = await step('getting the goal at the cursor from Lean', () => goalAtCursor(doc, origin, token));
      }
      log.appendLine(`Goal source: ${goal ? goal.source : 'none found'}`);

      let canVerify = verify;
      if (verify && !baseline) {
        if (w === 'done') {
          const region = declarationRegion(doc, target);
          // When regenerating without a stored baseline, leave out messages about our own text.
          const diags = currentDiags(doc).filter((d) => !(regenerate && touches(d.range, span(target))));
          baseline = makeBaseline(diags, region, span(target), goal?.goals[0]);
        } else {
          canVerify = false;
          note = w === 'unavailable' ? 'the Lean server is not available, so the suggestion was not checked' : 'Lean took too long to check the file';
          log.appendLine(`Verification disabled for this request: ${note}`);
        }
      }

      // Find where our text should go right now, tolerating benign edits made meanwhile by autosave
      // (trimming whitespace), formatters, or other extensions. Returns undefined only if the doc is
      // gone or our own previous text can no longer be found at all.
      const reanchor = (): vscode.Range | undefined => {
        if (doc.isClosed) return undefined;
        if (lastAttemptText === undefined && !regenerate) {
          // Nothing inserted yet: anchor to the live cursor, which VS Code keeps valid across edits.
          const cur = editor.document === doc ? editor.selection.active : target.start;
          return new vscode.Range(cur, cur);
        }
        const own = lastAttemptText ?? last!.text; // our current text in the buffer
        if (doc.getText(target) === own) return target;
        return findText(doc, own, doc.offsetAt(target.start));
      };

      for (let attempt = 1; attempt <= (canVerify ? maxAttempts : 1); attempt++) {
        // (singleLine: every accepted proof is written on one line, or nothing is inserted.)
        attemptsMade = attempt;
        if (token.isCancellationRequested) {
          outcome = 'cancelled';
          return;
        }
        let anchored = reanchor();
        if (!anchored) {
          outcome = 'aborted';
          return;
        }
        target = anchored;
        const full = doc.getText();
        const before = full.slice(0, doc.offsetAt(target.start));
        const after = full.slice(doc.offsetAt(target.end));

        const prompt = buildPrompt({
          singleLine,
          before,
          after,
          contextLines: cfg.get<number>('contextLines', 400),
          goal: goal?.goals[0],
          otherGoals: goal ? goal.goals.length - 1 : 0,
          diagnostics: problems,
          rejected: history.slice(-5),
          extraInstructions: cfg.get<string>('extraInstructions', ''),
        });
        logSection(`ATTEMPT ${attempt}/${canVerify ? maxAttempts : 1} — PROMPT`);
        log.appendLine(prompt);
        if (attempt === 1 && cfg.get<boolean>('showPromptOnRequest', false)) log.show(true);

        const tag = canVerify && maxAttempts > 1 ? `attempt ${attempt}/${maxAttempts}: ` : '';
        const proof = await step(`${tag}asking ${model.name}`, () => askModel(model, prompt, token));
        if (proof === 'cancelled') {
          outcome = 'cancelled';
          return;
        }
        if (proof === 'error') {
          outcome = 'error';
          return;
        }
        if (!proof.trim() || usesSorry(proof)) {
          // Never inserted: nothing for Lean to check.
          const why = !proof.trim() ? 'the reply was empty' : 'the suggestion used `sorry` or `admit`, which is not allowed';
          logSection('REJECTED WITHOUT INSERTING');
          log.appendLine(why);
          if (proof.trim()) history.push(proof);
          problems = [`- ${why}`];
          continue;
        }
        const obstacle = singleLine ? singleLineObstacle(proof) : undefined;
        if (obstacle) {
          logSection('REJECTED WITHOUT INSERTING');
          log.appendLine(`The proof must fit on one line, but ${obstacle}.`);
          history.push(proof);
          problems = [`- the proof must fit on one line, but ${obstacle}; write it without that`];
          continue;
        }

        // Re-anchor once more: the buffer may have been edited while the model was responding.
        anchored = reanchor();
        if (!anchored) {
          outcome = 'aborted';
          return;
        }
        target = anchored;
        const linePrefix = doc.lineAt(target.start.line).text.slice(0, target.start.character);
        const insertProof = singleLine && !canVerify ? (toSingleLine(proof) ?? proof) : proof;
        const text = layoutInsertion(insertProof, linePrefix, eol, tabSize);
        const range = await replaceOwnText(doc, target, text);
        if (!range) {
          vscode.window.showErrorMessage('Lean Shim: could not apply the edit.');
          outcome = 'error';
          return;
        }
        target = range;
        expectedVersion = doc.version;
        lastAttemptText = text;
        lastProof = proof;
        history.push(proof);
        logSection('INSERTED');
        log.appendLine(text.replace(/\r\n/g, '\n'));

        if (!canVerify) {
          outcome = 'unverified';
          return;
        }

        let w = await step(`${tag}checking the suggestion with Lean`, () => waitForLean(doc, timeoutMs, token));
        log.appendLine(`  result: ${w}`);
        if (doc.isClosed) {
          outcome = 'aborted';
          return;
        }
        if (w === 'cancelled') {
          outcome = 'cancelled';
          return;
        }
        // The version changes if anything edited the buffer during the check — often not the user but
        // autosave trimming whitespace, a formatter, or another extension. Tolerate it as long as our
        // inserted text is still intact: relocate it and wait for Lean on the new version once more.
        if (doc.version !== expectedVersion) {
          const relocated = findText(doc, text, doc.offsetAt(target.start));
          if (!relocated) {
            outcome = 'aborted';
            return;
          }
          target = relocated;
          expectedVersion = doc.version;
          log.appendLine('(the file was edited during checking — relocated the suggestion and re-checked)');
          w = await step(`${tag}re-checking with Lean after the file was edited`, () => waitForLean(doc, timeoutMs, token));
          log.appendLine(`  result: ${w}`);
          if (doc.isClosed) {
            outcome = 'aborted';
            return;
          }
          if (w === 'cancelled') {
            outcome = 'cancelled';
            return;
          }
          if (doc.version !== expectedVersion || doc.getText(target) !== text) {
            outcome = 'unverified';
            note = 'the file kept changing during checking, so it could not be verified';
            return;
          }
        }
        if (w !== 'done') {
          outcome = 'unverified';
          note = w === 'timeout' ? `Lean did not finish checking within ${timeoutMs / 1000}s` : 'the Lean server stopped responding';
          return;
        }

        const verdict = judge(currentDiags(doc), declarationRegion(doc, target), span(target), baseline!);
        logSection(verdict.ok ? 'VERIFIED BY LEAN' : 'REJECTED BY LEAN');
        problems = verdict.problems.map((d) => describe(d, doc.lineAt(d.range.start.line).text));
        log.appendLine(verdict.ok ? 'No errors in this declaration from the suggestion.' : problems.join('\n'));
        if (verdict.tolerated) {
          log.appendLine(`(${verdict.tolerated} error(s) elsewhere in this declaration were already there and were ignored.)`);
        }
        if (verdict.ok) {
          outcome = 'verified';
          if (verdict.tolerated) note = `${verdict.tolerated} unrelated error(s) already in this declaration were ignored`;
          if (singleLine) {
            const enc = await step('rewriting the proof on one line and re-checking it', () =>
              storeSingleLine(doc, target, proof, linePrefix, eol, tabSize, baseline!, timeoutMs, token),
            );
            target = enc.range;
            expectedVersion = doc.version;
            if (token.isCancellationRequested) {
              outcome = 'cancelled';
              lastAttemptText = doc.getText(target);
              return;
            }
            if (!enc.oneLine) {
              // Correct on several lines but not on one: not accepted. Retry, saying why.
              outcome = 'failed';
              note = '';
              lastAttemptText = doc.getText(target); // the multi-line proof, restored in place
              problems = [
                '- the proof checked on several lines, but its one-line form did not, so it was rejected; ' +
                  'give a proof that also works when its tactics are joined with `;` on one line',
                ...(enc.problems ?? []),
              ];
              log.appendLine('One-line form rejected; trying again.');
              continue;
            }
          }
          return;
        }
      }
      outcome = 'failed';
      } finally {
        sub.dispose();
        run.dispose();
        if (currentRun === run) currentRun = undefined;
      }
    },
  );

  const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  const remember = () => {
    last = { uri: doc.uri.toString(), version: doc.version, range: target, text: doc.getText(target), history, goal, baseline, problems };
  };
  const placeCursor = () => {
    if (!shown) return;
    shown.selection = new vscode.Selection(target.end, target.end);
    shown.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!target.isEmpty) flashHighlight(shown, target);
  };
  log.appendLine('');
  log.appendLine(`Outcome: ${outcome}${note ? ` (${note})` : ''}`);

  switch (outcome) {
    case 'verified':
      remember();
      placeCursor();
      vscode.window.setStatusBarMessage(
        `$(pass) Lean Shim: suggestion verified by Lean${attemptsMade > 1 ? ` (attempt ${attemptsMade})` : ''}` +
          `${note ? ` — ${note}` : ''}. Press again for a different one.`,
        8000,
      );
      return;
    case 'unverified':
      remember();
      placeCursor();
      if (verify) vscode.window.showWarningMessage(`Lean Shim: suggestion inserted but NOT verified — ${note}.`);
      else vscode.window.setStatusBarMessage('Lean Shim: suggestion inserted — press again for a different one, or Ctrl+Z to undo.', 6000);
      return;
    case 'cancelled':
      if (lastAttemptText !== undefined) {
        remember();
        placeCursor();
        vscode.window.showWarningMessage('Lean Shim: cancelled. The current suggestion was left in place but has NOT been verified.');
      }
      return;
    case 'aborted':
      last = undefined;
      vscode.window.showWarningMessage(
        'Lean Shim: stopped because the editor was closed or the inserted text could no longer be located. Anything left in the file has not been verified.',
      );
      return;
    case 'failed':
    case 'error': {
      // Put the file back exactly as it was (only our own text is removed). Relocate our text first
      // in case the buffer shifted (autosave/formatter) since we inserted it.
      if (!target.isEmpty && !doc.isClosed && lastAttemptText !== undefined) {
        const here = doc.getText(target) === lastAttemptText ? target : findText(doc, lastAttemptText, doc.offsetAt(target.start));
        if (here) {
          const restored = await replaceOwnText(doc, here, '');
          if (restored) target = restored;
        }
      }
      remember();
      placeCursor();
      if (outcome === 'error' || lastAttemptText === undefined) {
        if (outcome === 'failed') vscode.window.showWarningMessage('Lean Shim: no usable suggestion was produced. Try again.');
        return;
      }
      // Not awaited: an unanswered notification must not keep the command (and the status bar) busy.
      // With the one-line format, "insert anyway" inserts the one-line form (offered only if there is one).
      let attemptText: string | undefined = lastAttemptText;
      if (singleLine) {
        const one = lastProof !== undefined ? toSingleLine(lastProof) : undefined;
        const prefix = doc.lineAt(target.start.line).text.slice(0, target.start.character);
        attemptText = one !== undefined ? layoutInsertion(one, prefix, eol, tabSize) : undefined;
      }
      const buttons = attemptText !== undefined ? ['Insert last attempt anyway', 'Show log'] : ['Show log'];
      void vscode.window
        .showWarningMessage(
          `Lean Shim: none of the ${attemptsMade} suggestion(s) passed Lean's check, so the file was left unchanged. ` +
            'Press again to keep trying (rejected attempts are remembered).',
          ...buttons,
        )
        .then(async (choice) => {
          if (choice === 'Show log') log.show(true);
          // Only if no new request has started and the file is still exactly as we left it.
          if (choice === 'Insert last attempt anyway' && attemptText !== undefined && !busy && isRegenerationState(doc)) {
            const range = await replaceOwnText(doc, last!.range, attemptText);
            if (range) {
              target = range;
              remember();
              placeCursor();
            }
          }
        });
      return;
    }
  }
}

/**
 * Rewrite a verified proof on a single line, then re-check it with Lean. If the proof can't be put on
 * one line, or the one-line form doesn't check, the verified multi-line proof is kept/restored.
 */
async function storeSingleLine(
  doc: vscode.TextDocument,
  target: vscode.Range,
  proof: string,
  linePrefix: string,
  eol: string,
  tabSize: number,
  baseline: Baseline,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<{ range: vscode.Range; note?: string; oneLine: boolean; problems?: string[] }> {
  const plainText = doc.getText(target);
  const one = toSingleLine(proof);
  if (one === undefined) {
    log.appendLine('This proof cannot be written on one line (e.g. it uses calc); kept as generated.');
    return { range: target, oneLine: false, problems: [`- ${singleLineObstacle(proof) ?? 'it could not be written on one line'}`] };
  }
  const oneText = layoutInsertion(one, linePrefix, eol, tabSize);
  if (oneText === plainText) return { range: target, oneLine: true };
  if (token.isCancellationRequested) return { range: target, oneLine: false };

  const startOff = doc.offsetAt(target.start);
  const range = await replaceOwnText(doc, target, oneText);
  if (!range || doc.getText(range) !== oneText) {
    return { range: findText(doc, plainText, startOff) ?? target, oneLine: false, problems: ['- it could not be rewritten in place'] };
  }
  logSection('REWRITTEN ON ONE LINE');
  log.appendLine(oneText.replace(/\r\n/g, '\n'));

  const w = await waitForLean(doc, timeoutMs, token);
  const here = doc.getText(range) === oneText ? range : findText(doc, oneText, startOff);
  const verdict =
    w === 'done' && !doc.isClosed && here
      ? judge(currentDiags(doc), declarationRegion(doc, here), span(here), baseline)
      : undefined;
  if (verdict?.ok && here) return { range: here, oneLine: true, note: 'written on one line' };

  // Restore the verified multi-line proof.
  logSection('ONE-LINE RE-CHECK FAILED — RESTORED THE MULTI-LINE PROOF');
  if (verdict) log.appendLine(verdict.problems.map((d) => describe(d, doc.lineAt(d.range.start.line).text)).join('\n'));
  else log.appendLine(`Lean did not confirm the one-line form (${w}).`);
  const problems = verdict
    ? verdict.problems.map((d) => describe(d, doc.lineAt(d.range.start.line).text))
    : [`- Lean did not confirm the one-line form (${w})`];
  if (here) {
    const back = await replaceOwnText(doc, here, plainText);
    if (back) return { range: back, oneLine: false, problems };
  }
  return { range: findText(doc, plainText, startOff) ?? target, oneLine: false, problems };
}

/** Range of `text` in the document nearest `nearOff`, or undefined if absent. */
function findText(doc: vscode.TextDocument, text: string, nearOff: number): vscode.Range | undefined {
  const full = doc.getText();
  const i = full.indexOf(text);
  if (i < 0) return undefined;
  let best = i;
  for (let j = i; j >= 0; j = full.indexOf(text, j + 1)) {
    if (Math.abs(j - nearOff) < Math.abs(best - nearOff)) best = j;
  }
  return new vscode.Range(doc.positionAt(best), doc.positionAt(best + text.length));
}

/** True if the document is still exactly as we left it. */
function isRegenerationState(doc: vscode.TextDocument): boolean {
  return !!last && last.uri === doc.uri.toString() && last.version === doc.version && doc.getText(last.range) === last.text;
}

const highlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: false,
});

function flashHighlight(editor: vscode.TextEditor, range: vscode.Range) {
  editor.setDecorations(highlight, [range]);
  setTimeout(() => editor.setDecorations(highlight, []), 1500);
}

function logSection(title: string, ch = '-') {
  log.appendLine('');
  log.appendLine(`${ch.repeat(4)} ${title} ${ch.repeat(Math.max(4, 76 - title.length))}`);
}

function reportError(err: unknown) {
  if (err instanceof vscode.LanguageModelError) {
    let msg = err.message;
    if (err.code === vscode.LanguageModelError.NoPermissions.name) {
      msg = 'permission to use Copilot was not granted. Run the command again and allow access.';
    } else if (err.code === vscode.LanguageModelError.Blocked.name) {
      msg = 'the request was blocked (quota or rate limit). Try again later.';
    } else if (err.code === vscode.LanguageModelError.NotFound.name) {
      msg = 'the selected Copilot model was not found. Use "Lean Shim: Select Copilot Model".';
    }
    vscode.window.showErrorMessage(`Lean Shim: ${msg}`);
  } else {
    vscode.window.showErrorMessage(`Lean Shim: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Exported for tests only. */
export { askModel as _askModelForTest };
