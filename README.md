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

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `leanProofFill.modelFamily` | `""` | Copilot model family, e.g. `gpt-4o` or `claude-sonnet-4`. Leave empty for the first available model. Use **Lean Proof Fill: Select Copilot Model** to pick from a list. |
| `leanProofFill.contextLines` | `400` | Maximum number of lines of the file sent as context. The header and imports are always included. |
| `leanProofFill.extraInstructions` | `""` | Extra text added to the prompt, e.g. "Prefer `omega` and `simp`". |

## Install in a Codespace

1. Build the package (or use the prebuilt `lean-proof-fill-0.1.0.vsix`):
   ```bash
   npm install
   npm run package
   ```
2. In the Codespace, open the Extensions view, click **…**, choose **Install from VSIX…**, and pick the
   `.vsix` file. You can also run this in the Codespace terminal:
   ```bash
   code --install-extension lean-proof-fill-0.1.0.vsix
   ```

To install it automatically in every new Codespace, commit the `.vsix` to your repo and add this
to `.devcontainer/devcontainer.json`:

```jsonc
{
  "customizations": {
    "vscode": { "extensions": ["leanprover.lean4", "GitHub.copilot-chat"] }
  },
  "postAttachCommand": "code --install-extension ${containerWorkspaceFolder}/tools/lean-proof-fill-0.1.0.vsix"
}
```

## Development

```bash
npm install
npm test          # compiles and runs the formatting unit tests
```

Press `F5` in VS Code with this folder open to start an Extension Development Host.
