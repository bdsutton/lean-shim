import * as vscode from 'vscode';
import { Baseline, describe, judge, makeBaseline, touches, usesSorry } from './check';
import { hasImport, importInsertOffset, tacticCall } from './encode';
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
/** Cancels the request in progress (also triggered by the progress notification's Cancel button). */
let currentRun: vscode.CancellationTokenSource | undefined;
let statusItem: vscode.StatusBarItem;
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Lean Proof Fill');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'leanProofFill.suggest';
  setIdleStatus();
  updateStatusVisibility(vscode.window.activeTextEditor);

  context.subscriptions.push(
    statusItem,
    log,
    vscode.commands.registerCommand('leanProofFill.showLog', () => log.show(true)),
    vscode.commands.registerTextEditorCommand('leanProofFill.suggest', (editor) => suggest(editor)),
    vscode.commands.registerTextEditorCommand('leanProofFill.encodeSelection', (editor) => encodeSelection(editor)),
    vscode.commands.registerCommand('leanProofFill.selectModel', selectModel),
    vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
  );
}

export function deactivate() {}

function setIdleStatus() {
  statusItem.text = '$(sparkle) Fill Proof';
  statusItem.tooltip = 'Insert AI-suggested Lean proof steps at the cursor (press again for a different suggestion)';
}

function updateStatusVisibility(editor: vscode.TextEditor | undefined) {
  if (editor?.document.languageId === 'lean4') statusItem.show();
  else statusItem.hide();
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

async function getModel(): Promise<vscode.LanguageModelChat | undefined> {
  const family = vscode.workspace.getConfiguration('leanProofFill').get<string>('modelFamily', '').trim();
  let models = await vscode.lm.selectChatModels(family ? { vendor: 'copilot', family } : { vendor: 'copilot' });
  if (!models.length && family) {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length) {
      vscode.window.showWarningMessage(
        `Lean Proof Fill: Copilot model family "${family}" not available; using ${models[0].name} instead.`,
      );
    }
  }
  if (!models.length) {
    // Not awaited: an unanswered notification must not keep the command running.
    void vscode.window
      .showErrorMessage(
        'Lean Proof Fill: no GitHub Copilot language model is available. Make sure the GitHub Copilot Chat extension is installed and you are signed in.',
        'Install Copilot Chat',
      )
      .then((choice) => {
        if (choice) void vscode.commands.executeCommand('workbench.extensions.installExtension', 'github.copilot-chat');
      });
    return undefined;
  }
  return models[0];
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
async function logAvailableModels(): Promise<void> {
  const all = await vscode.lm.selectChatModels();
  const current = vscode.workspace.getConfiguration('leanProofFill').get<string>('modelFamily', '');
  logSection(`${new Date().toLocaleString()} — AVAILABLE LANGUAGE MODELS (${all.length})`, '=');
  log.appendLine(`Current leanProofFill.modelFamily: ${current ? `"${current}"` : '(empty: first available Copilot model)'}`);
  log.appendLine('The picker offers models whose vendor is "copilot".');
  const known = ['name', 'id', 'vendor', 'family', 'version', 'maxInputTokens'];
  all.forEach((m, i) => {
    logSection(`${i + 1}. ${m.name}${m.vendor === 'copilot' ? '' : ' (not offered: vendor is not copilot)'}`);
    const props = new Map(modelProperties(m));
    for (const k of known) log.appendLine(`  ${k.padEnd(16)} ${formatValue(props.has(k) ? props.get(k) : (m as unknown as Record<string, unknown>)[k])}`);
    for (const [k, v] of props) if (!known.includes(k)) log.appendLine(`  ${k.padEnd(16)} ${formatValue(v)}`);
  });
  if (!all.length) log.appendLine('No language models are available. Is GitHub Copilot Chat installed and signed in?');
  log.appendLine('');
  log.show(true); // reveal the panel without taking focus from the picker
}

async function selectModel() {
  try {
    await logAvailableModels();
  } catch (e) {
    log.appendLine(`Could not list models: ${e instanceof Error ? e.message : String(e)}`);
  }
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    vscode.window.showErrorMessage('Lean Proof Fill: no Copilot models available. Is GitHub Copilot Chat installed and signed in?');
    return;
  }
  const current = vscode.workspace.getConfiguration('leanProofFill').get<string>('modelFamily', '');
  const seen = new Set<string>();
  const items: (vscode.QuickPickItem & { family: string })[] = [
    { label: 'Default', description: 'first available Copilot model', family: '', picked: !current },
  ];
  for (const m of models) {
    if (seen.has(m.family)) continue;
    seen.add(m.family);
    items.push({ label: m.name, description: m.family, family: m.family, picked: m.family === current });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Copilot model used for Lean proof suggestions' });
  if (!pick) return;
  await vscode.workspace
    .getConfiguration('leanProofFill')
    .update('modelFamily', pick.family, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Lean Proof Fill will use ${pick.label}.`);
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
    vscode.window.showWarningMessage('Lean Proof Fill only works in Lean 4 files.');
    return;
  }
  if (busy) {
    void vscode.window
      .showInformationMessage('Lean Proof Fill: a suggestion is already being generated.', 'Cancel it')
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
  const timeoutSec = Math.max(10, vscode.workspace.getConfiguration('leanProofFill').get<number>('modelTimeoutSeconds', 120));
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
        `Lean Proof Fill: ${model.name} did not finish responding within ${timeoutSec}s, so the request was cancelled. ` +
          'Try again, or raise leanProofFill.modelTimeoutSeconds.',
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
      { justification: 'Lean Proof Fill sends the current Lean file to Copilot to suggest proof steps at your cursor.' },
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

/** Replace the selected proof text with an equivalent `from_base64 "..."` tactic call. */
async function encodeSelection(editor: vscode.TextEditor) {
  const doc = editor.document;
  if (doc.languageId !== 'lean4') {
    vscode.window.showWarningMessage('Lean Proof Fill: this command only works in Lean 4 files.');
    return;
  }
  const sel = editor.selection;
  if (sel.isEmpty || !doc.getText(sel).trim()) {
    vscode.window.showWarningMessage('Lean Proof Fill: select the proof tactics to encode first.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('leanProofFill');
  const moduleName = (cfg.get<string>('base64Module', 'SorryClaude.Base64') || 'SorryClaude.Base64').trim();
  const autoImport = cfg.get<boolean>('base64AutoImport', true);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 2;

  const selected = doc.getText(sel);
  const linePrefix = doc.lineAt(sel.start.line).text.slice(0, sel.start.character);
  // The selection usually starts after the first line's indentation, so that line loses its indent
  // while the rest keep theirs — a ragged block the decoder can't parse. Rebuild the first line's
  // indentation (from the line prefix, or its column) so tacticCall's dedent normalises it uniformly.
  const firstIndent = linePrefix.trim() === '' ? linePrefix : ' '.repeat(sel.start.character);
  const proofText = firstIndent + selected;
  const encodedText = layoutInsertion(tacticCall(proofText), linePrefix, eol, tabSize);
  const needImport = !hasImport(doc.getText(), moduleName);
  const willImport = needImport && autoImport;

  const selStartOff = doc.offsetAt(sel.start);
  const importText = willImport ? `import ${moduleName}${eol}` : '';
  const edit = new vscode.WorkspaceEdit();
  if (willImport) edit.insert(doc.uri, doc.positionAt(importInsertOffset(doc.getText())), importText);
  edit.replace(doc.uri, sel, encodedText);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage('Lean Proof Fill: could not replace the selection.');
    return;
  }

  // Select the new tactic call and reset any regeneration state.
  const start = selStartOff + importText.length;
  const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + encodedText.length));
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  last = undefined;

  logSection(`${new Date().toLocaleString()} — encoded selection — ${vscode.workspace.asRelativePath(doc.uri)}`);
  log.appendLine(encodedText.replace(/\r\n/g, '\n'));
  if (needImport && !autoImport) {
    vscode.window.showWarningMessage(
      `Lean Proof Fill: selection encoded, but the file does not import \`${moduleName}\`. Add \`import ${moduleName}\` for \`from_base64\` to work.`,
    );
  } else {
    vscode.window.setStatusBarMessage(
      `Lean Proof Fill: selection encoded as from_base64${willImport ? ` (added \`import ${moduleName}\`)` : ''}. Ctrl+Z to undo.`,
      6000,
    );
  }
}

async function runSuggest(editor: vscode.TextEditor) {
  const doc = editor.document;
  const cfg = vscode.workspace.getConfiguration('leanProofFill');
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
  statusItem.text = '$(loading~spin) Filling proof…';

  logSection(
    `${new Date().toLocaleString()} — ${regenerate ? 'new suggestion requested for the same spot' : 'new suggestion'}` +
      ` — model: ${model.name} (${model.family}) — ${vscode.workspace.asRelativePath(doc.uri)}:${origin.line + 1}:${origin.character + 1}`,
    '=',
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Lean Proof Fill', cancellable: true },
    async (progress, progressToken) => {
      const run = new vscode.CancellationTokenSource();
      currentRun = run;
      const sub = progressToken.onCancellationRequested(() => run.cancel());
      const token = run.token;
      try {
      // Lean only reports goals and messages for parts of the file it has finished checking.
      let w: WaitResult | undefined;
      if (!goal || (verify && !baseline)) {
        progress.report({ message: 'waiting for Lean to finish checking the file…' });
        w = await waitForLean(doc, timeoutMs, token);
        if (w === 'cancelled') {
          outcome = 'cancelled';
          return;
        }
      }

      // Only the current goal at the cursor is sent. When regenerating, the goal found the first
      // time is reused: the document now contains the rejected suggestion, which can confuse Lean.
      if (!goal) {
        progress.report({ message: 'getting the goal at the cursor from Lean…' });
        goal = await goalAtCursor(doc, origin, token);
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
        progress.report({ message: `${tag}asking ${model.name}…` });
        const proof = await askModel(model, prompt, token);
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

        // Re-anchor once more: the buffer may have been edited while the model was responding.
        anchored = reanchor();
        if (!anchored) {
          outcome = 'aborted';
          return;
        }
        target = anchored;
        const linePrefix = doc.lineAt(target.start.line).text.slice(0, target.start.character);
        const text = layoutInsertion(proof, linePrefix, eol, tabSize);
        const range = await replaceOwnText(doc, target, text);
        if (!range) {
          vscode.window.showErrorMessage('Lean Proof Fill: could not apply the edit.');
          outcome = 'error';
          return;
        }
        target = range;
        expectedVersion = doc.version;
        lastAttemptText = text;
        history.push(proof);
        logSection('INSERTED');
        log.appendLine(text.replace(/\r\n/g, '\n'));

        if (!canVerify) {
          outcome = 'unverified';
          return;
        }

        progress.report({ message: `${tag}checking the suggestion with Lean…` });
        let w = await waitForLean(doc, timeoutMs, token);
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
          w = await waitForLean(doc, timeoutMs, token);
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
          if (cfg.get<boolean>('encodeAcceptedProof', false)) {
            const enc = await storeAsBase64(doc, target, proof, linePrefix, eol, tabSize, baseline!, timeoutMs, cfg, progress, token);
            target = enc.range;
            expectedVersion = doc.version;
            if (enc.note) note = note ? `${note}; ${enc.note}` : enc.note;
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
        `$(pass) Lean Proof Fill: suggestion verified by Lean${attemptsMade > 1 ? ` (attempt ${attemptsMade})` : ''}` +
          `${note ? ` — ${note}` : ''}. Press again for a different one.`,
        8000,
      );
      return;
    case 'unverified':
      remember();
      placeCursor();
      if (verify) vscode.window.showWarningMessage(`Lean Proof Fill: suggestion inserted but NOT verified — ${note}.`);
      else vscode.window.setStatusBarMessage('Lean Proof Fill: suggestion inserted — press again for a different one, or Ctrl+Z to undo.', 6000);
      return;
    case 'cancelled':
      if (lastAttemptText !== undefined) {
        remember();
        placeCursor();
        vscode.window.showWarningMessage('Lean Proof Fill: cancelled. The current suggestion was left in place but has NOT been verified.');
      }
      return;
    case 'aborted':
      last = undefined;
      vscode.window.showWarningMessage(
        'Lean Proof Fill: stopped because the editor was closed or the inserted text could no longer be located. Anything left in the file has not been verified.',
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
        if (outcome === 'failed') vscode.window.showWarningMessage('Lean Proof Fill: no usable suggestion was produced. Try again.');
        return;
      }
      // Not awaited: an unanswered notification must not keep the command (and the status bar) busy.
      const attemptText = lastAttemptText;
      void vscode.window
        .showWarningMessage(
          `Lean Proof Fill: none of the ${attemptsMade} suggestion(s) passed Lean's check, so the file was left unchanged. ` +
            'Press again to keep trying (rejected attempts are remembered).',
          'Insert last attempt anyway',
          'Show log',
        )
        .then(async (choice) => {
          if (choice === 'Show log') log.show(true);
          // Only if no new request has started and the file is still exactly as we left it.
          if (choice === 'Insert last attempt anyway' && !busy && isRegenerationState(doc)) {
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
 * Replace a verified proof with a `from_base64 "..."` tactic call, adding the import if needed, then
 * re-check with Lean. On any problem (e.g. the module isn't built/imported) the plain, verified proof
 * is restored, so this never leaves a broken file.
 */
async function storeAsBase64(
  doc: vscode.TextDocument,
  target: vscode.Range,
  proof: string,
  linePrefix: string,
  eol: string,
  tabSize: number,
  baseline: Baseline,
  timeoutMs: number,
  cfg: vscode.WorkspaceConfiguration,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<{ range: vscode.Range; note?: string }> {
  const moduleName = (cfg.get<string>('base64Module', 'SorryClaude.Base64') || 'SorryClaude.Base64').trim();
  const autoImport = cfg.get<boolean>('base64AutoImport', true);
  const plainText = doc.getText(target);
  const needImport = !hasImport(doc.getText(), moduleName);
  if (needImport && !autoImport) {
    return { range: target, note: `kept as plain text (the file does not import \`${moduleName}\`)` };
  }
  if (token.isCancellationRequested) return { range: target };
  progress.report({ message: 'storing the proof as Base64…' });

  // Capture offsets BEFORE editing: Position objects do not track edits, so once a line is inserted
  // above the proof, a stale Position no longer points at the proof. Offsets do shift predictably.
  const encodedText = layoutInsertion(tacticCall(proof), linePrefix, eol, tabSize);
  const importText = needImport ? `import ${moduleName}${eol}` : '';
  const importOffset = needImport ? importInsertOffset(doc.getText()) : 0; // always above the proof
  const proofStartOff = doc.offsetAt(target.start);

  // Apply the import insert (if any) and the proof→tactic-call replacement as ONE atomic edit, so
  // both resolve against the current coordinates and I don't have to track intermediate positions.
  const edit = new vscode.WorkspaceEdit();
  if (needImport) edit.insert(doc.uri, doc.positionAt(importOffset), importText);
  edit.replace(doc.uri, target, encodedText);
  if (!(await vscode.workspace.applyEdit(edit))) {
    return { range: target, note: 'kept as plain text (could not write the encoded proof)' };
  }
  const encStart = proofStartOff + importText.length; // the import (if added) sits entirely above
  target = new vscode.Range(doc.positionAt(encStart), doc.positionAt(encStart + encodedText.length));
  logSection('ENCODED AS BASE64');
  log.appendLine(encodedText.replace(/\r\n/g, '\n'));

  // Guard against any position miscalculation before trusting the result.
  if (doc.getText(target) !== encodedText) {
    logSection('BASE64 PLACEMENT CHECK FAILED — RESTORED THE PLAIN PROOF');
    await undoBase64(doc, moduleName, importText, encodedText, plainText);
    return { range: findText(doc, plainText, proofStartOff) ?? target, note: 'kept as plain text (could not place the encoded proof safely)' };
  }

  // Re-verify the encoded form.
  const w = await waitForLean(doc, timeoutMs, token);
  const verdict =
    w === 'done' && !doc.isClosed && doc.getText(target) === encodedText
      ? judge(currentDiags(doc), declarationRegion(doc, target), span(target), baseline)
      : undefined;
  if (verdict?.ok) {
    return { range: target, note: needImport ? `stored as Base64 (added \`import ${moduleName}\`)` : 'stored as Base64' };
  }

  // Something went wrong: restore the plain, verified proof and remove any import we added.
  logSection('BASE64 RE-CHECK FAILED — RESTORED THE PLAIN PROOF');
  if (verdict) log.appendLine(verdict.problems.map((d) => describe(d, doc.lineAt(d.range.start.line).text)).join('\n'));
  else log.appendLine(`Lean did not confirm the encoded proof (${w}).`);
  const restored = await undoBase64(doc, moduleName, importText, encodedText, plainText);
  const reason = w === 'done' ? 'the encoded proof did not check' : `Lean did not finish checking it (${w})`;
  return {
    range: restored ?? findText(doc, plainText, proofStartOff) ?? target,
    note: `kept as plain text (${reason}; is \`${moduleName}\` built and imported?)`,
  };
}

/** Undo encoding: turn the tactic call back into the plain proof and drop the import we added. */
async function undoBase64(
  doc: vscode.TextDocument,
  moduleName: string,
  importText: string,
  encodedText: string,
  plainText: string,
): Promise<vscode.Range | undefined> {
  const encAt = doc.getText().indexOf(encodedText);
  if (encAt < 0) return undefined; // the document moved on; leave it as is
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(encAt), doc.positionAt(encAt + encodedText.length)), plainText);
  let shift = 0;
  if (importText) {
    const impAt = doc.getText().indexOf(importText);
    if (impAt >= 0 && impAt < encAt && hasImport(doc.getText(), moduleName)) {
      edit.delete(doc.uri, new vscode.Range(doc.positionAt(impAt), doc.positionAt(impAt + importText.length)));
      shift = importText.length;
    }
  }
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  const start = encAt - shift;
  return new vscode.Range(doc.positionAt(start), doc.positionAt(start + plainText.length));
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
      msg = 'the selected Copilot model was not found. Use "Lean Proof Fill: Select Copilot Model".';
    }
    vscode.window.showErrorMessage(`Lean Proof Fill: ${msg}`);
  } else {
    vscode.window.showErrorMessage(`Lean Proof Fill: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Exported for tests only. */
export { askModel as _askModelForTest };
