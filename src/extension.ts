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
    const choice = await vscode.window.showErrorMessage(
      'Lean Proof Fill: no GitHub Copilot language model is available. Make sure the GitHub Copilot Chat extension is installed and you are signed in.',
      'Install Copilot Chat',
    );
    if (choice) {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', 'github.copilot-chat');
    }
    return undefined;
  }
  return models[0];
}

async function selectModel() {
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
    vscode.window.setStatusBarMessage('Lean Proof Fill: a suggestion is already being generated…', 3000);
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
  token: vscode.CancellationToken,
): Promise<string | 'cancelled' | 'error'> {
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'Lean Proof Fill sends the current Lean file to Copilot to suggest proof steps at your cursor.' },
      token,
    );
    let reply = '';
    for await (const chunk of response.text) reply += chunk;
    logSection('RAW REPLY');
    log.appendLine(reply);
    return extractProof(reply);
  } catch (err) {
    if (token.isCancellationRequested) return 'cancelled';
    logSection('ERROR');
    log.appendLine(err instanceof Error ? err.message : String(err));
    reportError(err);
    return 'error';
  }
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

  const full = doc.getText();
  const before = full.slice(0, doc.offsetAt(target.start));
  const after = full.slice(doc.offsetAt(target.end));
  const linePrefix = doc.lineAt(target.start.line).text.slice(0, target.start.character);
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
    async (progress, token) => {
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

      for (let attempt = 1; attempt <= (canVerify ? maxAttempts : 1); attempt++) {
        attemptsMade = attempt;
        if (token.isCancellationRequested) {
          outcome = 'cancelled';
          return;
        }
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
        if (doc.isClosed || doc.version !== expectedVersion) {
          outcome = 'aborted';
          return;
        }

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
        const w = await waitForLean(doc, timeoutMs, token);
        if (doc.isClosed || doc.version !== expectedVersion) {
          outcome = 'aborted';
          return;
        }
        if (w === 'cancelled') {
          outcome = 'cancelled';
          return;
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
        'Lean Proof Fill: the file changed while working, so it stopped. Any text it inserted was left as is and is not verified.',
      );
      return;
    case 'failed':
    case 'error': {
      // Put the file back exactly as it was (only our own text is removed).
      if (!target.isEmpty && doc.version === expectedVersion && !doc.isClosed) {
        const restored = await replaceOwnText(doc, target, '');
        if (restored) target = restored;
      }
      remember();
      placeCursor();
      if (outcome === 'error' || lastAttemptText === undefined) {
        if (outcome === 'failed') vscode.window.showWarningMessage('Lean Proof Fill: no usable suggestion was produced. Try again.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Lean Proof Fill: none of the ${attemptsMade} suggestion(s) passed Lean's check, so the file was left unchanged. ` +
          'Press again to keep trying (rejected attempts are remembered).',
        'Insert last attempt anyway',
        'Show log',
      );
      if (choice === 'Show log') log.show(true);
      if (choice === 'Insert last attempt anyway' && isRegenerationState(doc)) {
        const range = await replaceOwnText(doc, last!.range, lastAttemptText);
        if (range) {
          target = range;
          remember();
          placeCursor();
        }
      }
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

  // Add the import if missing (the only change made outside the inserted range).
  let importText = '';
  let importRange: vscode.Range | undefined;
  if (needImport) {
    importText = `import ${moduleName}${eol}`;
    const at = doc.positionAt(importInsertOffset(doc.getText()));
    const r = await replaceOwnText(doc, new vscode.Range(at, at), importText);
    if (!r) return { range: target, note: 'kept as plain text (could not add the import)' };
    importRange = r;
    const startOff = doc.offsetAt(target.start) + importText.length; // import is entirely above the proof
    target = new vscode.Range(doc.positionAt(startOff), doc.positionAt(startOff + plainText.length));
  }

  // Replace the proof with the tactic call.
  const encodedText = layoutInsertion(tacticCall(proof), linePrefix, eol, tabSize);
  const encRange = await replaceOwnText(doc, target, encodedText);
  if (!encRange) {
    if (importRange) await replaceOwnText(doc, importRange, '');
    return { range: target, note: 'kept as plain text (could not write the encoded proof)' };
  }
  target = encRange;
  logSection('ENCODED AS BASE64');
  log.appendLine(encodedText.replace(/\r\n/g, '\n'));

  // Re-verify the encoded form.
  const w = await waitForLean(doc, timeoutMs, token);
  const verdict =
    w === 'done' && !doc.isClosed ? judge(currentDiags(doc), declarationRegion(doc, target), span(target), baseline) : undefined;
  if (verdict?.ok) {
    return { range: target, note: needImport ? `stored as Base64 (added \`import ${moduleName}\`)` : 'stored as Base64' };
  }

  // Something went wrong: restore the plain, verified proof and remove any import we added.
  logSection('BASE64 RE-CHECK FAILED — RESTORED THE PLAIN PROOF');
  if (verdict) log.appendLine(verdict.problems.map((d) => describe(d, doc.lineAt(d.range.start.line).text)).join('\n'));
  else log.appendLine(`Lean did not confirm the encoded proof (${w}).`);
  const back = await replaceOwnText(doc, target, plainText);
  if (back) target = back;
  if (importRange) {
    const startOff = doc.offsetAt(target.start) - importText.length;
    await replaceOwnText(doc, importRange, '');
    target = new vscode.Range(doc.positionAt(startOff), doc.positionAt(startOff + plainText.length));
  }
  const reason = w === 'done' ? 'the encoded proof did not check' : `Lean did not finish checking it (${w})`;
  return { range: target, note: `kept as plain text (${reason}; is \`${moduleName}\` built and imported?)` };
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
