import * as vscode from 'vscode';
import { Diag, Region } from './check';
import { DECLARATION_START } from './format';

/** Minimal view of the API the Lean 4 extension (leanprover.lean4) exports. */
export interface LeanClientLike {
  isRunning(): boolean | undefined;
  sendRequest(method: string, params: unknown, token?: vscode.CancellationToken): Promise<unknown>;
}
interface LeanExports {
  lean4EnabledFeatures?: Promise<{ clientProvider?: { getActiveClient(): LeanClientLike | undefined } }>;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
  ]);
}

export async function getLeanClient(): Promise<LeanClientLike | undefined> {
  const ext = vscode.extensions.getExtension<LeanExports>('leanprover.lean4');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  const features = exports?.lean4EnabledFeatures ? await withTimeout(exports.lean4EnabledFeatures, 5000) : undefined;
  const client = features?.clientProvider?.getActiveClient();
  return client && client.isRunning() ? client : undefined;
}

export type WaitResult = 'done' | 'timeout' | 'cancelled' | 'unavailable';

/**
 * Wait until Lean has finished checking the given version of the document and published all its
 * messages (`textDocument/waitForDiagnostics`; tested against Lean v4.35.0). The Lean extension
 * applies messages to VS Code as they arrive, so `vscode.languages.getDiagnostics` is up to date
 * once this resolves.
 */
export async function waitForLean(
  doc: vscode.TextDocument,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<WaitResult> {
  const client = await getLeanClient();
  if (!client) return 'unavailable';
  const version = doc.version;
  try {
    const res = await withTimeout(
      client.sendRequest('textDocument/waitForDiagnostics', { uri: doc.uri.toString(), version }, token).then(() => true),
      timeoutMs,
    );
    if (token.isCancellationRequested) return 'cancelled';
    if (!res) return 'timeout';
  } catch {
    return token.isCancellationRequested ? 'cancelled' : 'unavailable';
  }
  // Let the extension host finish dispatching the diagnostics notifications.
  await new Promise((r) => setTimeout(r, 100));
  return 'done';
}

/** The declaration containing `range`: from its first line to the line before the next declaration. */
export function declarationRegion(doc: vscode.TextDocument, range: vscode.Range): Region {
  let startLine = range.start.line;
  while (startLine > 0 && !DECLARATION_START.test(doc.lineAt(startLine).text)) startLine--;
  let endLine = range.end.line + 1;
  while (endLine < doc.lineCount && !DECLARATION_START.test(doc.lineAt(endLine).text)) endLine++;
  return { startLine, endLine };
}

export function currentDiags(doc: vscode.TextDocument): Diag[] {
  return vscode.languages.getDiagnostics(doc.uri).map((d) => ({
    severity:
      d.severity === vscode.DiagnosticSeverity.Error ? 'error' : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'other',
    message: d.message,
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
  }));
}

export function span(r: vscode.Range) {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}
