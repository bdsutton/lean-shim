import * as vscode from 'vscode';

// Getting GitHub Copilot ready for Lean Shim with as little user effort as possible.
//
// Signing in always needs a click from the user (VS Code doesn't let an extension sign in on their
// behalf), so the most that can be automated is: notice when Copilot isn't ready, open Copilot's own
// sign-in/set-up flow, and notice when it has finished. VS Code's "allow Lean Shim to use Copilot"
// question can't be asked ahead of time; it appears with the first request.

export type CopilotState =
  | 'ready' // Auto model available and Lean Shim is allowed to use it
  | 'needsPermission' // available; VS Code will ask the user once, with the first request
  | 'denied' // the user refused Lean Shim access to Copilot's models
  | 'noAuto' // Copilot offers models, but not its Auto model
  | 'signedOut' // Copilot is installed but offers no models: not signed in or not set up
  | 'notInstalled'; // the GitHub Copilot Chat extension isn't installed

export const COPILOT_CHAT_ID = 'github.copilot-chat';

/** Commands that open Copilot's sign-in / set-up flow, best first (availability varies by version). */
const SIGN_IN_COMMANDS = [
  'workbench.action.chat.triggerSetup', // VS Code's built-in Copilot set-up: signs in, installs, signs up
  'github.copilot.chat.triggerPermissiveSignIn', // Copilot Chat's own sign-in
  'workbench.action.chat.triggerSetupFromAccounts',
];

/** Is this Copilot's "Auto" model (Copilot picks the underlying model for each request)? */
export function isAutoModel(m: vscode.LanguageModelChat): boolean {
  return [m.id, m.family, m.name].some((v) => typeof v === 'string' && v.trim().toLowerCase() === 'auto');
}

export async function copilotModels(): Promise<{ models: vscode.LanguageModelChat[]; auto?: vscode.LanguageModelChat }> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return { models, auto: models.find(isAutoModel) };
}

export async function getCopilotState(context: vscode.ExtensionContext): Promise<CopilotState> {
  if (!vscode.extensions.getExtension(COPILOT_CHAT_ID)) return 'notInstalled';
  const { models, auto } = await copilotModels();
  if (!models.length) return 'signedOut';
  if (!auto) return 'noAuto';
  const allowed = context.languageModelAccessInformation?.canSendRequest(auto);
  return allowed === true ? 'ready' : allowed === false ? 'denied' : 'needsPermission';
}

/** Resolves with Copilot's Auto model as soon as it's available, or undefined after `timeoutMs`. */
export function waitForAuto(timeoutMs: number): Promise<vscode.LanguageModelChat | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (m: vscode.LanguageModelChat | undefined) => {
      if (done) return;
      done = true;
      sub.dispose();
      clearTimeout(timer);
      resolve(m);
    };
    const check = () => void copilotModels().then(({ auto }) => auto && finish(auto), () => undefined);
    const sub = vscode.lm.onDidChangeChatModels(check);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    check();
  });
}

/** Open Copilot's sign-in / set-up flow. Returns false if no such command exists in this VS Code. */
export async function openCopilotSignIn(): Promise<boolean> {
  if (!vscode.extensions.getExtension(COPILOT_CHAT_ID)) {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', COPILOT_CHAT_ID);
  }
  const available = new Set(await vscode.commands.getCommands(true));
  for (const id of SIGN_IN_COMMANDS) {
    if (!available.has(id)) continue;
    try {
      await vscode.commands.executeCommand(id);
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

export function stateMessage(state: CopilotState): string {
  switch (state) {
    case 'notInstalled':
      return 'Lean Shim needs the GitHub Copilot Chat extension, which is not installed.';
    case 'signedOut':
      return "Lean Shim needs GitHub Copilot, which isn't signed in yet.";
    case 'noAuto':
      return "GitHub Copilot is signed in but doesn't offer its Auto model to extensions right now.";
    case 'denied':
      return (
        'Lean Shim is not allowed to use GitHub Copilot. To allow it, open the Accounts menu (the person ' +
        "icon at the bottom left) and change Lean Shim's language model access for your GitHub account."
      );
    default:
      return 'GitHub Copilot is ready.';
  }
}

/**
 * Sign in to Copilot interactively: open its sign-in flow, then wait (up to `waitMs`) for its Auto model
 * to become available. Reports the outcome with a notification.
 */
export async function signInToCopilot(waitMs = 5 * 60 * 1000, closeChatWhenDone = false): Promise<boolean> {
  const opened = await openCopilotSignIn();
  if (!opened) {
    void vscode.window.showWarningMessage(
      "Lean Shim couldn't open GitHub Copilot's sign-in. Sign in from the Accounts menu (the person icon at " +
        'the bottom left) or the Copilot icon in the status bar.',
    );
  }
  const auto = await waitForAuto(opened ? waitMs : 30 * 1000);
  if (auto && opened && closeChatWhenDone) {
    // Copilot's sign-in takes place in the Chat view, in the secondary side bar; put it away again.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
  }
  if (auto) {
    void vscode.window.showInformationMessage('Lean Shim: GitHub Copilot is ready. Press Ctrl+Alt+L (or ✨) to get a suggestion.');
  }
  return !!auto;
}

export interface CopilotWatchOptions {
  /** How long to give Copilot to come up by itself after the window opens before acting. */
  startupWaitMs: number;
  /** Open Copilot's sign-in flow automatically if it still isn't signed in after that. */
  autoSignIn: boolean;
  onState(state: CopilotState): void;
  log(line: string): void;
}

/**
 * Track Copilot's readiness for the status bar, and when the window opens give Copilot time to sign in
 * by itself (in a Codespace it usually does); if it still isn't, open its sign-in flow (or offer to).
 */
export function watchCopilot(context: vscode.ExtensionContext, opts: CopilotWatchOptions): vscode.Disposable {
  let disposed = false;
  const refresh = () =>
    void getCopilotState(context).then(
      (s) => !disposed && opts.onState(s),
      () => undefined,
    );
  const subs: vscode.Disposable[] = [vscode.lm.onDidChangeChatModels(refresh)];
  if (context.languageModelAccessInformation?.onDidChange) subs.push(context.languageModelAccessInformation.onDidChange(refresh));
  refresh();

  void (async () => {
    if (await waitForAuto(opts.startupWaitMs)) return refresh();
    if (disposed) return;
    const state = await getCopilotState(context);
    opts.onState(state);
    if (state !== 'signedOut' && state !== 'notInstalled') return;
    opts.log(`[${new Date().toLocaleTimeString()}] ${stateMessage(state)}`);
    if (opts.autoSignIn) {
      opts.log('Opening GitHub Copilot sign-in (turn this off with leanShim.autoSignInToCopilot).');
      await signInToCopilot(undefined, true);
    } else {
      const choice = await vscode.window.showInformationMessage(stateMessage(state), 'Sign in to Copilot');
      if (choice) await signInToCopilot(undefined, true);
    }
    refresh();
  })().catch(() => undefined);

  return {
    dispose() {
      disposed = true;
      subs.forEach((s) => s.dispose());
    },
  };
}
