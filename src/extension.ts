import * as vscode from 'vscode';
import { buildPrompt, extractProof, layoutInsertion } from './format';

/** What we inserted last time, so pressing the button again can swap it for a new suggestion. */
interface LastInsertion {
  uri: string;
  /** Document version immediately after our edit. */
  version: number;
  range: vscode.Range;
  text: string;
  /** Raw proofs suggested so far at this spot (most recent last). */
  history: string[];
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

function describeDiagnostics(doc: vscode.TextDocument, cursor: vscode.Position, prev?: vscode.Range): string[] {
  const out: string[] = [];
  const diags = vscode.languages.getDiagnostics(doc.uri);
  const window = 60;
  for (const d of diags) {
    const near =
      d.range.contains(cursor) ||
      Math.abs(d.range.start.line - cursor.line) <= window ||
      (prev && d.range.intersection(prev));
    if (!near) continue;
    const sev = ['error', 'warning', 'info', 'hint'][d.severity] ?? 'info';
    const where = prev && d.range.intersection(prev)
      ? 'in the previously rejected suggestion'
      : `at \`${doc.lineAt(d.range.start.line).text.trim().slice(0, 120)}\``;
    out.push(`- [${sev}] ${where}:\n${indentBlock(d.message.trim(), '    ')}`);
    if (out.length >= 15) break;
  }
  return out;
}

function indentBlock(s: string, ind: string) {
  return s.split('\n').map((l) => ind + l).join('\n');
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

async function runSuggest(editor: vscode.TextEditor) {
  const doc = editor.document;
  const cfg = vscode.workspace.getConfiguration('leanProofFill');
  const regenerate = isRegeneration(editor);

  // The range we will replace. A fresh suggestion replaces an empty range at the
  // cursor (pure insertion); a regeneration replaces only our own previous text.
  const target = regenerate ? last!.range : new vscode.Range(editor.selection.active, editor.selection.active);
  const history = regenerate ? last!.history : [];

  const full = doc.getText();
  const before = full.slice(0, doc.offsetAt(target.start));
  const after = full.slice(doc.offsetAt(target.end));
  const linePrefix = doc.lineAt(target.start.line).text.slice(0, target.start.character);

  const prompt = buildPrompt({
    before,
    after,
    contextLines: cfg.get<number>('contextLines', 400),
    diagnostics: describeDiagnostics(doc, target.start, regenerate ? target : undefined),
    rejected: history.slice(-5),
    extraInstructions: cfg.get<string>('extraInstructions', ''),
  });

  const model = await getModel();
  if (!model) return;

  const startVersion = doc.version;
  statusItem.text = '$(loading~spin) Filling proof…';

  logSection(
    `${new Date().toLocaleString()} — ${regenerate ? `regenerating (attempt ${history.length + 1})` : 'new suggestion'}` +
      ` — model: ${model.name} (${model.family}) — ${vscode.workspace.asRelativePath(doc.uri)}:${target.start.line + 1}:${target.start.character + 1}`,
    '=',
  );
  logSection('PROMPT');
  log.appendLine(prompt);
  if (cfg.get<boolean>('showPromptOnRequest', false)) log.show(true);

  const proof = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: regenerate ? `Lean Proof Fill: generating a new suggestion (${model.name})…` : `Lean Proof Fill: asking ${model.name}…`,
      cancellable: true,
    },
    async (_progress, token) => {
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
        if (token.isCancellationRequested) {
          logSection('CANCELLED');
          return undefined;
        }
        logSection('ERROR');
        log.appendLine(err instanceof Error ? err.message : String(err));
        reportError(err);
        return undefined;
      }
    },
  );

  if (proof === undefined) return;
  if (!proof.trim()) {
    vscode.window.showWarningMessage('Lean Proof Fill: the model returned an empty suggestion. Try again.');
    return;
  }
  if (doc.isClosed) return;
  if (doc.version !== startVersion) {
    // Positions may have shifted; refuse rather than risk touching the wrong text.
    vscode.window.showWarningMessage('Lean Proof Fill: the file changed while the suggestion was generated. Please try again.');
    return;
  }

  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 2;
  const text = layoutInsertion(proof, linePrefix, eol, tabSize);

  const ok = await editor.edit(
    (b) => (target.isEmpty ? b.insert(target.start, text) : b.replace(target, text)),
    { undoStopBefore: true, undoStopAfter: true },
  );
  if (!ok) {
    vscode.window.showErrorMessage('Lean Proof Fill: could not apply the edit.');
    return;
  }

  const start = target.start;
  const end = doc.positionAt(doc.offsetAt(start) + text.length);
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(end, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  logSection('INSERTED');
  log.appendLine(text.replace(/\r\n/g, '\n'));
  log.appendLine('');

  last = { uri: doc.uri.toString(), version: doc.version, range, text, history: [...history, proof] };
  flashHighlight(editor, range);
  vscode.window.setStatusBarMessage(
    'Lean Proof Fill: suggestion inserted — press again for a different one, or Ctrl+Z to undo.',
    6000,
  );
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
