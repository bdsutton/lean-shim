import * as vscode from 'vscode';
import { ProcessingInfo, StartupTracker } from './startup-tracker';

/** The parts of the Lean 4 extension's client API used to watch server start-up and file processing. */
interface LeanClientEvents {
  isRunning(): boolean | undefined;
  restarting?: vscode.Event<unknown>;
  restarted?: vscode.Event<unknown>;
  serverFailed?: vscode.Event<string>;
  stopped?: vscode.Event<{ message?: string; reason?: string } | undefined>;
}
interface ClientProviderEvents {
  getClients?(): LeanClientEvents[];
  clientAdded?: vscode.Event<LeanClientEvents>;
  progressChanged?: vscode.Event<[string, ProcessingInfo[]]>;
}
interface LeanExports {
  lean4EnabledFeatures?: Promise<{ clientProvider?: ClientProviderEvents }>;
}

/**
 * Log a timeline of the Lean server's start-up and of the first processing of each file (imports vs.
 * checking, and the slowest declarations). Waits for the Lean extension to load by itself instead of
 * forcing it to, so this never changes when Lean starts.
 */
export function watchLeanStartup(log: (line: string) => void): vscode.Disposable {
  const subs: vscode.Disposable[] = [];
  let disposed = false;
  let headerShown = false;
  const write = (line: string) => {
    if (!headerShown) {
      headerShown = true;
      log('');
      log(`==== LEAN SERVER START-UP ${'='.repeat(55)}`);
    }
    log(line);
  };

  void (async () => {
    const ext = vscode.extensions.getExtension<LeanExports>('leanprover.lean4');
    if (!ext) return;
    while (!ext.isActive && !disposed) await new Promise((r) => setTimeout(r, 100));
    if (disposed) return;
    const features = await ext.exports?.lean4EnabledFeatures;
    const provider = features?.clientProvider;
    if (!provider || disposed) return;

    const tracker = new StartupTracker({
      log: write,
      now: Date.now,
      docText: (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)?.getText(),
      fileName: (uri) => {
        try {
          return vscode.workspace.asRelativePath(vscode.Uri.parse(uri));
        } catch {
          return uri;
        }
      },
    });
    const track = (c: LeanClientEvents) => {
      if (c.restarting) subs.push(c.restarting(() => tracker.serverStarting()));
      if (c.restarted) subs.push(c.restarted(() => tracker.serverReady()));
      if (c.serverFailed) subs.push(c.serverFailed((m) => tracker.serverFailed(m)));
      if (c.stopped) subs.push(c.stopped((e) => tracker.serverStopped(e?.message ?? '')));
    };
    for (const c of provider.getClients?.() ?? []) {
      track(c);
      tracker.alreadyStarted(!!c.isRunning());
    }
    if (provider.clientAdded) subs.push(provider.clientAdded((c) => track(c)));
    if (provider.progressChanged) subs.push(provider.progressChanged(([uri, infos]) => tracker.progress(uri, infos)));
  })().catch((e) => write(`(could not watch the Lean server: ${e instanceof Error ? e.message : String(e)})`));

  return {
    dispose() {
      disposed = true;
      subs.forEach((s) => s.dispose());
    },
  };
}
