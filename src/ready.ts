import * as vscode from 'vscode';
import { LeanClientLike, waitForLean, withTimeout } from './lean';
import { describeLeanActivity, ProcessingInfo } from './startup-tracker';

interface ProviderLike {
  getActiveClient(): LeanClientLike | undefined;
  progressChanged?: vscode.Event<[string, ProcessingInfo[]]>;
}
interface LeanExports {
  lean4EnabledFeatures?: Promise<{ clientProvider?: ProviderLike }>;
}

/** Latest progress report from Lean for each file (what is still being processed). */
const latestProgress = new Map<string, ProcessingInfo[]>();

/** Keep `latestProgress` up to date. Waits for the Lean extension to load by itself. */
export function trackLeanProgress(): vscode.Disposable {
  let sub: vscode.Disposable | undefined;
  let disposed = false;
  void (async () => {
    const ext = vscode.extensions.getExtension<LeanExports>('leanprover.lean4');
    if (!ext) return;
    while (!ext.isActive && !disposed) await new Promise((r) => setTimeout(r, 100));
    const provider = (await ext.exports?.lean4EnabledFeatures)?.clientProvider;
    if (disposed || !provider?.progressChanged) return;
    sub = provider.progressChanged(([uri, infos]) => latestProgress.set(uri, infos));
  })().catch(() => undefined);
  return {
    dispose() {
      disposed = true;
      sub?.dispose();
    },
  };
}

export type Readiness = { ready: true } | { ready: false; reason: string; cancelled?: boolean };

/**
 * Is Lean ready to help with `doc`: its server running and the file fully checked? Waits at most
 * `budgetMs` for that. Without the Lean 4 extension there is nothing to check, so that counts as ready.
 */
export async function checkLeanReady(
  doc: vscode.TextDocument,
  budgetMs: number,
  token: vscode.CancellationToken,
): Promise<Readiness> {
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(0, deadline - Date.now());
  const ext = vscode.extensions.getExtension<LeanExports>('leanprover.lean4');
  if (!ext) return { ready: true };
  if (!ext.isActive) return { ready: false, reason: 'the Lean 4 extension is still starting' };
  const features = ext.exports?.lean4EnabledFeatures ? await withTimeout(ext.exports.lean4EnabledFeatures, left()) : undefined;
  const client = features?.clientProvider?.getActiveClient();
  if (!client) return { ready: false, reason: 'the Lean server has not started for this file yet' };
  if (!client.isRunning()) return { ready: false, reason: 'the Lean server is still starting' };
  const w = await waitForLean(doc, left(), token);
  if (w === 'done') return { ready: true };
  if (w === 'cancelled') return { ready: false, reason: 'cancelled', cancelled: true };
  if (w === 'unavailable') return { ready: false, reason: "the Lean server isn't responding" };
  return { ready: false, reason: describeLeanActivity(latestProgress.get(doc.uri.toString()), doc.getText()) };
}
