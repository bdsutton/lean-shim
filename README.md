# Lean Shim

## By Brian Sutton and Claude Code

Fill in a missing piece of a Lean 4 proof with GitHub Copilot. Put the cursor where the proof
should go and trigger the command. The suggested steps are inserted at the cursor, and nothing else in
the file is changed.

## How to trigger it

| Where | How |
|---|---|
| Editor title bar | ✨ (sparkle) button at the top right of a `.lean` file |
| Status bar | **✨ Fill Proof** at the bottom right |
| Keyboard | `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS) |
| Command Palette | **Lean Shim: Suggest Proof Steps at Cursor** |
| Right-click menu | **Suggest Proof Steps at Cursor** |

`Ctrl+Z` undoes a suggestion. To stop a request in progress, press the button (or shortcut) again and choose **Cancel it**, or use the Cancel button on the progress notification.

## Accepted proofs are written on one line

Once Lean verifies a proof, the extension rewrites it on a single line. The idea is that a human writes a proof outline, and then tool fills in the details. The details are placed on a single line so they can be ignored easily.

## Checked by Lean before it's accepted

With `leanShim.verify` on (the default), each press works like this:

1. Copilot suggests proof steps, which are inserted at the cursor.
2. The extension waits for Lean to finish checking the file, then looks at Lean's messages for the
   theorem you're in. The suggestion is accepted only if it adds no errors and no `sorry` warning,
   and the gap's own *unsolved goals* error is gone. Suggestions containing `sorry`/`admit` are
   rejected without being inserted.
3. If Lean rejects it, the extension asks again, sending Lean's errors and the rejected attempts,
   and replaces only its own inserted text. It tries up to `leanShim.maxAttempts` times (default 3).
4. If an attempt passes, the status bar shows **✓ suggestion verified by Lean**. If none does, the
   file is put back exactly as it was, and you can choose **Insert last attempt anyway**. Pressing
   the button again keeps trying and remembers the rejected attempts.

Errors that were already in the theorem and are unrelated to the gap (same message at the same place)
don't block acceptance; the status bar mentions them. If Lean takes longer than
`leanShim.verifyTimeoutSeconds`, or the Lean server isn't running, the suggestion is inserted
but clearly marked as **not verified**. Every attempt and Lean's verdict on it is recorded in the
output panel (see below).

## Seeing the prompt sent to the model

Every request is logged to the **Lean Shim** output panel. Each entry shows the model used, the
full prompt (file context, Lean messages, rejected suggestions), the model's raw reply, and the exact
text inserted. To open it, run **Lean Shim: Show Prompt and Response Log** from the Command
Palette, or pick *Lean Shim* in the Output panel's drop-down (**View → Output**). To open it
automatically on every request, turn on `leanShim.showPromptOnRequest`.

## Requirements

* **GitHub Copilot Chat** installed and signed in. It is available in Codespaces by default if your
  account has Copilot. The extension uses VS Code's Language Model API (`vscode.lm`), so you don't
  need an API key.
* The **Lean 4** extension (`leanprover.lean4`), so `.lean` files get the `lean4` language ID.
  The extension asks the Lean server for the goal at the cursor (the state the InfoView shows) and
  sends only the current goal to the model, not other goals or messages from elsewhere in the file.
  If Lean can't provide it, the *unsolved goals* error for the proof you're in is used instead,
  trimmed to its first goal. When you retry, Lean's errors on the rejected suggestion are also sent.
* VS Code 1.90 or newer.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `leanShim.acceptedProofFormat` | `singleLine` | How to write a verified proof: on one line, or exactly as generated. |
| `leanShim.modelTimeoutSeconds` | `120` | Cancel a model request that hasn't finished replying within this many seconds. |
| `leanShim.logLeanStartup` | `true` | Log how long the Lean server takes to start and to process each file (see above). |
| `leanShim.readyWaitSeconds` | `3` | How long to wait for Lean to be ready before showing a "please wait" message instead of starting. |
| `leanShim.autoSignInToCopilot` | `true` | Open Copilot's sign-in automatically if it isn't signed in shortly after the window opens. |
| `leanShim.verify` | `true` | Check each suggestion with Lean, retry automatically, and leave the file unchanged if nothing passes. |
| `leanShim.maxAttempts` | `3` | Suggestions tried per press when verifying (1–10). |
| `leanShim.verifyTimeoutSeconds` | `120` | How long to wait for Lean's check before inserting the suggestion as not verified. |
| `leanShim.contextLines` | `400` | Maximum number of lines of the file sent as context. The header and imports are always included. |
| `leanShim.showPromptOnRequest` | `false` | Open the output panel with the prompt and reply on every request. |
| `leanShim.extraInstructions` | `""` | Extra text added to the prompt, e.g. "Prefer `omega` and `simp`". |
