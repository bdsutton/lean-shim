# Lean Proof Fill (Copilot)

Fill in a missing piece of a Lean 4 proof with GitHub Copilot. Put the cursor where the proof
should go and trigger the command. The suggested steps are inserted at the cursor, and **nothing else in
the file is changed**.

Don't like the suggestion? Trigger it again without moving the cursor or editing. The extension
replaces only the text it just inserted with a **different** suggestion. It tells the model which
suggestions you rejected and which Lean errors they caused.

## How to trigger it

| Where | How |
|---|---|
| Editor title bar | ✨ (sparkle) button at the top right of a `.lean` file |
| Status bar | **✨ Fill Proof** at the bottom right |
| Keyboard | `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS) |
| Command Palette | **Lean Proof Fill: Suggest Proof Steps at Cursor** |
| Right-click menu | **Suggest Proof Steps at Cursor** |

`Ctrl+Z` undoes a suggestion. To stop a request in progress, press the button (or shortcut) again and choose **Cancel it**, or use the Cancel button on the progress notification.

## Accepted proofs are written on one line

Once Lean verifies a proof, the extension rewrites it on a single line, with tactics joined by `;`:

```lean
theorem and_swap (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor; (· exact hp); · exact hq
```

Steps that take a whole block of tactics (bullets `·`, `case … =>`, `next =>`, `… := by`, `try`,
`all_goals`, `first | …` and similar) are wrapped in parentheses when more steps follow, so the block
doesn't absorb them. The one-line form is re-checked with Lean. If the proof can't be put on one line
(for example a `calc` block) or the one-line form doesn't check, the verified multi-line proof is kept.

This is controlled by `leanProofFill.acceptedProofFormat`:

- `singleLine` (default): rewrite on one line as described above.
- `asGenerated`: keep the proof exactly as the model wrote it.
- `base64`: replace the proof with a `from_base64 "..."` call (see below).

### The `from_base64` tactic

`from_base64` is a Lean tactic (in this repo's `LeanShim.Base64` module) that decodes Base64 to
tactic source and runs it, so Lean still checks the proof in full — the source text just isn't shown:

```lean
theorem add_zero' (n : Nat) : n + 0 = n := by
  from_base64 "c2ltcA=="
```

With `acceptedProofFormat` set to `base64`, the extension writes accepted proofs this way, adding
`import LeanShim.Base64` at the top if needed (turn that off with `leanProofFill.base64AutoImport`),
and re-checks the encoded form, restoring the plain proof if anything is wrong.

You can also encode an existing proof by hand: select the tactics and run
**Lean Proof Fill: Encode Selection as from_base64** from the Command Palette (or the right-click menu).
It replaces the selection with the equivalent `from_base64 "..."` call and adds the import if needed.
Unlike the automatic path, this one does not re-check with Lean, so encode a proof you know already works.
The `LeanShim.Base64` library is built automatically in the Codespace; to build it by hand run
`lake build LeanShim.Base64`.

## Checked by Lean before it's accepted

With `leanProofFill.verify` on (the default), each press works like this:

1. Copilot suggests proof steps, which are inserted at the cursor.
2. The extension waits for Lean to finish checking the file, then looks at Lean's messages for the
   theorem you're in. The suggestion is accepted only if it adds no errors and no `sorry` warning,
   and the gap's own *unsolved goals* error is gone. Suggestions containing `sorry`/`admit` are
   rejected without being inserted.
3. If Lean rejects it, the extension asks again, sending Lean's errors and the rejected attempts,
   and replaces only its own inserted text. It tries up to `leanProofFill.maxAttempts` times (default 3).
4. If an attempt passes, the status bar shows **✓ suggestion verified by Lean**. If none does, the
   file is put back exactly as it was, and you can choose **Insert last attempt anyway**. Pressing
   the button again keeps trying and remembers the rejected attempts.

Errors that were already in the theorem and are unrelated to the gap (same message at the same place)
don't block acceptance; the status bar mentions them. If Lean takes longer than
`leanProofFill.verifyTimeoutSeconds`, or the Lean server isn't running, the suggestion is inserted
but clearly marked as **not verified**. Every attempt and Lean's verdict on it is recorded in the
output panel (see below).

## Seeing the prompt sent to the model

Every request is logged to the **Lean Proof Fill** output panel. Each entry shows the model used, the
full prompt (file context, Lean messages, rejected suggestions), the model's raw reply, and the exact
text inserted. To open it, run **Lean Proof Fill: Show Prompt and Response Log** from the Command
Palette, or pick *Lean Proof Fill* in the Output panel's drop-down (**View → Output**). To open it
automatically on every request, turn on `leanProofFill.showPromptOnRequest`.

## Requirements

* **GitHub Copilot Chat** installed and signed in. It is available in Codespaces by default if your
  account has Copilot. The extension uses VS Code's Language Model API (`vscode.lm`), so you don't
  need an API key.
* The **Lean 4** extension (`leanprover.lean4`), so `.lean` files get the `lean4` language ID.
  The extension asks the Lean server for the goal at the cursor (the state the infoview shows) and
  sends only the current goal to the model, not other goals or messages from elsewhere in the file.
  If Lean can't provide it, the *unsolved goals* error for the proof you're in is used instead,
  trimmed to its first goal. When you retry, Lean's errors on the rejected suggestion are also sent.
* VS Code 1.90 or newer.

The first time you run it, VS Code asks you to allow the extension to use Copilot. Choose **Allow**.

## Where to put the cursor

* On an empty, indented line inside a `by` block: the steps are inserted at that column.
* At the end of a line such as `theorem foo : … := by`: one-line proofs go on the same line, and
  longer proofs go on new lines indented one level.

## Mathlib

This repository is also a Lean project that depends on [Mathlib](https://github.com/leanprover-community/mathlib4)
(v4.35.0, pinned in `lakefile.toml`, `lake-manifest.json` and `lean-toolchain`). When a Codespace is
created, it downloads Mathlib's prebuilt files with `lake exe cache get`. This takes a few minutes and
about 5 GB of disk. Any `.lean` file in the repo can then `import Mathlib`; try `examples/MathlibDemo.lean`.

`lake`, `lean` and `elan` are on the PATH in the Codespace's terminals (`~/.elan/bin`).

Mathlib uses a lot of memory: a 2-core Codespace (8 GB RAM) works, and a 4-core machine is noticeably faster.

To move to a newer Mathlib, change `rev` in `lakefile.toml` and the version in `lean-toolchain` to
match, then run:

```bash
lake update && lake exe cache get
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `leanProofFill.modelFamily` | `""` | Copilot model family, e.g. `gpt-4o` or `claude-sonnet-4`. Leave empty for the first available model. Use **Lean Proof Fill: Select Copilot Model** to pick from a list. |
| `leanProofFill.acceptedProofFormat` | `singleLine` | How to write a verified proof: on one line, exactly as generated, or as a `from_base64` call. |
| `leanProofFill.base64Module` | `LeanShim.Base64` | The module providing the `from_base64` tactic, imported for the `base64` format and the Encode Selection command. |
| `leanProofFill.base64AutoImport` | `true` | Add the import automatically when it's missing (the one edit made outside the cursor). |
| `leanProofFill.modelTimeoutSeconds` | `120` | Cancel a model request that hasn't finished replying within this many seconds. |
| `leanProofFill.verify` | `true` | Check each suggestion with Lean, retry automatically, and leave the file unchanged if nothing passes. |
| `leanProofFill.maxAttempts` | `3` | Suggestions tried per press when verifying (1–10). |
| `leanProofFill.verifyTimeoutSeconds` | `120` | How long to wait for Lean's check before inserting the suggestion as not verified. |
| `leanProofFill.contextLines` | `400` | Maximum number of lines of the file sent as context. The header and imports are always included. |
| `leanProofFill.showPromptOnRequest` | `false` | Open the output panel with the prompt and reply on every request. |
| `leanProofFill.extraInstructions` | `""` | Extra text added to the prompt, e.g. "Prefer `omega` and `simp`". |

## Install in a Codespace

**In a Codespace for this repository:** nothing to do. The extension is built while the Codespace is
created and installed when you first open it (`.devcontainer/install-extension.sh`). After that, opening
the Codespace only rebuilds the extension if its source changed since the last build, and only
reinstalls it if the installed copy is out of date, so an unchanged start takes a fraction of a second.

After you pull or edit the source, the next start picks up the change automatically. To apply it right
away, run the script yourself (add `--force` to rebuild and reinstall regardless):

```bash
bash .devcontainer/install-extension.sh
```

Then run **Developer: Reload Window**.

The built `lean-proof-fill.vsix` is not committed (`*.vsix` is in `.gitignore`), so pulls never conflict
on it. Please don't force-add it.

**In another repository's Codespace:** build the package here with `npm install && npm run package`.
Then copy `lean-proof-fill.vsix` into that Codespace and install it from the Extensions view
(**… → Install from VSIX…**) or with:

```bash
code --install-extension lean-proof-fill.vsix
```

## Development

```bash
npm install
npm test                          # compiles and runs the unit tests
node test/lean-verify.e2e.js      # checks the verification rules against a real Lean server (needs `lean` on PATH)
node test/base64-roundtrip.e2e.js # checks from_base64 round-trips (needs the LeanShim lib built)
node test/singleline.e2e.js       # checks the one-line rewrite of 28 proof shapes with a real Lean
```

Press `F5` in VS Code with this folder open to start an Extension Development Host.
