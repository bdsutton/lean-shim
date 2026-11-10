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

`Ctrl+Z` undoes a suggestion.

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
  Its error messages, including *unsolved goals* with the goal state, are sent to the model as context.
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
| `leanProofFill.contextLines` | `400` | Maximum number of lines of the file sent as context. The header and imports are always included. |
| `leanProofFill.showPromptOnRequest` | `false` | Open the output panel with the prompt and reply on every request. |
| `leanProofFill.extraInstructions` | `""` | Extra text added to the prompt, e.g. "Prefer `omega` and `simp`". |

## Install in a Codespace

**In a Codespace for this repository:** nothing to do. Each time you open the Codespace, it builds the
extension from the current source and installs it (`.devcontainer/install-extension.sh`). After you
pull or edit the source, rebuild and reinstall with:

```bash
bash .devcontainer/install-extension.sh
```

Then run **Developer: Reload Window**.

The built `lean-proof-fill.vsix` is not committed (it's in `.gitignore`), so pulls never conflict on it.

**In another repository's Codespace:** build the package here with `npm install && npm run package`.
Then copy `lean-proof-fill.vsix` into that Codespace and install it from the Extensions view
(**… → Install from VSIX…**) or with:

```bash
code --install-extension lean-proof-fill.vsix
```

## Development

```bash
npm install
npm test          # compiles and runs the formatting unit tests
```

Press `F5` in VS Code with this folder open to start an Extension Development Host.
