# Lean Shim

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
| Command Palette | **Lean Shim: Suggest Proof Steps at Cursor** |
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
doesn't absorb them. The one-line form is re-checked with Lean.

Everything Lean Shim inserts is on one line, or nothing is inserted:

- Copilot is told the proof will be put on one line, so it must not use `calc` (whose steps need separate
  lines) or `/- … -/` comments, and is given one-line alternatives (`h1.trans h2`, `rw [h1, h2]`,
  `Trans.trans (show … by …) (show … by …)`, or a closing tactic such as `omega`, `linarith`,
  `nlinarith`, `positivity`, `gcongr`).
- A suggestion that still uses `calc` (or a block comment) is rejected without being inserted, and the
  next attempt is told why.
- A suggestion that checks on several lines but not on one is also rejected and retried.
- If no attempt works on one line, the file is left unchanged.

This is controlled by `leanShim.acceptedProofFormat`:

- `singleLine` (default): one line only, as described above.
- `asGenerated`: insert the proof exactly as the model wrote it (any number of lines, `calc` allowed).

## Waits for Lean to be ready

Suggestions depend on Lean: it provides the goal at the cursor and checks the result. So when you ask
for one, the extension first waits up to 3 seconds (`leanShim.readyWaitSeconds`) for Lean's server
to be running and for the current file to be fully checked. If Lean isn't ready by then, nothing is
sent to Copilot and a message says what Lean is still doing — starting up, loading the file's imports,
or checking a particular line — so you can try again when it's done.

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

## What Lean does when it starts

The first time you open a `.lean` file, the Lean 4 extension shows *"[Server Startup] Starting Lean
language server and cloning missing project dependencies"*. That is several steps, and Lean Shim
logs how long each takes to its output panel (**Lean Shim: Show Lean Server Start-up Timeline**).
It looks like this (an illustration; your times will differ):

```
[10:41:02] Lean server starting: choosing the Lean version (elan), launching `lake serve` …
[10:41:05] Lean server ready after 3.1s.
[10:41:05] examples/MathlibDemo.lean: Lean started processing the file — loading imports (lines 1–1)…
[10:41:19] examples/MathlibDemo.lean: imports loaded after 13.8s.
[10:41:20] examples/MathlibDemo.lean: finished — 14.6s in total: loading imports 13.8s, checking the file 0.8s.
    slowest parts of the file:
      line 6: 0.5s  theorem sum_sq_nonneg (a b : ℝ) : 0 ≤ a ^ 2 + b ^ 2 := by
```

1. **Server start** — choosing the Lean version with elan (the first time, this downloads Lean), launching
   `lake serve`, which reads the lakefile and checks the project's dependencies (cloning any that are
   missing), and connecting.
2. **Loading imports**, for each file — preparing the imports (`lake setup-file`, building project
   modules that are out of date) and loading their compiled files. With `import Mathlib` this is usually
   the slowest step.
3. **Checking the file** — Lean checks the file's declarations in order; the slowest are listed.

Only the first processing of each file after a server start is timed. To time a start-up again, run
**Lean 4: Restart Server**. Turn the timeline off with `leanShim.logLeanStartup`.

The server-start step can't be split further from inside VS Code. The notification's *(Click for
details)* link opens the **Lean: Editor** output, which shows what elan and Lake print (including any
cloning). To time the sub-steps separately, run these in a terminal in the project folder:

```bash
time elan which lean      # choose the Lean version (downloads it the first time)
time lake env true        # what `lake serve` does first: read the lakefile, check and clone dependencies
time lake env lean examples/MathlibDemo.lean   # load the imports and check the file
```

## Requirements

* **GitHub Copilot Chat** installed and signed in. It is available in Codespaces by default if your
  account has Copilot. The extension uses VS Code's Language Model API (`vscode.lm`), so you don't
  need an API key. It always uses Copilot's **Auto** model, which lets Copilot choose the underlying
  model for each request; there is no option to pick a different one. If Copilot doesn't offer Auto to
  extensions, no request is sent and the models VS Code does offer are listed in the output panel.
* The **Lean 4** extension (`leanprover.lean4`), so `.lean` files get the `lean4` language ID.
  The extension asks the Lean server for the goal at the cursor (the state the infoview shows) and
  sends only the current goal to the model, not other goals or messages from elsewhere in the file.
  If Lean can't provide it, the *unsolved goals* error for the proof you're in is used instead,
  trimmed to its first goal. When you retry, Lean's errors on the rejected suggestion are also sent.
* VS Code 1.90 or newer.

### Signing in to GitHub Copilot

Lean Shim needs GitHub Copilot to be signed in. In a Codespace Copilot usually signs in by itself with
your GitHub account; Lean Shim does as much of the rest as VS Code allows:

- When the window opens, it gives Copilot about 20 seconds to sign in. If it still isn't, Lean Shim opens
  Copilot's sign-in automatically (or, with `leanShim.autoSignInToCopilot` off, shows a notification with
  a **Sign in to Copilot** button). Signing in itself needs your click — VS Code doesn't let extensions
  sign in for you.
- While Copilot isn't signed in, the status bar button reads **Sign in to Copilot**; click it to sign in.
  When Copilot is ready you get a notification and the button goes back to **✨ Fill Proof**.
- If you ask for a suggestion while Copilot is signed out, Lean Shim waits a few seconds (in case Copilot
  is still starting), then offers to sign in instead of failing.

The first time a suggestion is requested, VS Code asks once whether Lean Shim may use Copilot. Choose
**Allow**. (VS Code only asks this with a real request, so it can't be done ahead of time.) If you chose
not to allow it, the status bar button shows a warning and explains how to change it.

## Where to put the cursor

* On an empty, indented line inside a `by` block: the steps are inserted at that column.
* At the end of a line such as `theorem foo : … := by`: one-line proofs go on the same line, and
  longer proofs go on new lines indented one level.

## Mathlib

This repository is also a Lean project that depends on [Mathlib](https://github.com/leanprover-community/mathlib4)
(v4.35.0, pinned in `lakefile.toml`, `lake-manifest.json` and `lean-toolchain`). The Codespace setup
downloads Mathlib's source and **all** of its prebuilt files, so any `import Mathlib…` works right away
without compiling Mathlib from source. Specific imports (as in `examples/MathlibDemo.lean`) still make
files open faster, since Lean only loads what a file imports.

If prebuilt files are ever missing (for example after changing the Mathlib version), download them with:

```bash
bash .devcontainer/fetch-mathlib.sh
```

It skips files already downloaded. `--imports` downloads only what the project's `.lean` files import.
Copilot is told it can only use what the file's imports provide, since it can't add imports itself.

### Fast Codespace creation with prebuilds

The slow set-up work happens in steps that GitHub Codespaces **prebuilds** run ahead of time:

- `onCreateCommand` → `.devcontainer/setup.sh`: installs elan (Lean's version manager).
- `updateContentCommand` → `.devcontainer/update-content.sh`: downloads the Lean toolchain and all of
  Mathlib's prebuilt files, then builds Lean Shim. Rerun whenever the prebuild is refreshed for new commits.
- `postStartCommand` → `.devcontainer/warm-lean.sh`: every time the Codespace starts, reads in the
  background the prebuilt Lean files that the repo's `.lean` files import, including Lean's core library
  (log: `/tmp/lean-shim-warm.log`). A new Codespace starts with a cold disk, and without this the first
  file opened waits minutes for those files with Lean mostly idle. Files added later are covered from the
  next start; to warm them right away, run `bash .devcontainer/warm-lean.sh`.
- `postAttachCommand` → `.devcontainer/install-extension.sh`: only installs the already-built extension
  when the Codespace opens.

With a prebuild configured for the branch (repository **Settings → Codespaces → Set up prebuild**), a
new Codespace starts from the finished result and skips the first two steps. Without one, they run when
the Codespace is created.

`lake`, `lean` and `elan` are on the PATH in the Codespace's terminals (`~/.elan/bin`).

Mathlib uses a lot of memory, so new Codespaces default to at least 4 cores and 16 GB
(`"hostRequirements": { "cpus": 4 }` in `devcontainer.json`). That uses a personal account's monthly
Codespaces allowance twice as fast as a 2-core machine.

To move to a newer Mathlib, change `rev` in `lakefile.toml` and the version in `lean-toolchain` to
match, then run:

```bash
MATHLIB_NO_CACHE_ON_UPDATE=1 lake update && bash .devcontainer/fetch-mathlib.sh
```

(`MATHLIB_NO_CACHE_ON_UPDATE=1` stops `lake update` from downloading all of Mathlib's prebuilt files,
which it otherwise does automatically.)

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

The Codespace also turns off inline suggestions (`"editor.inlineSuggest.enabled": false` in
`.devcontainer/devcontainer.json`), so Copilot's grey "ghost text" completions don't appear while you type.
Lean Shim doesn't use them. The minimap (the code overview at the right edge of the editor) is turned off
(`"editor.minimap.enabled": false`). It also starts with the Chat view closed
(`"workbench.secondarySideBar.defaultVisibility": "hidden"`); if Lean Shim has to open Copilot's sign-in
at start-up, which happens in the Chat view, it closes the view again once you're signed in. To change
either setting, edit `devcontainer.json`, or override it in the Settings editor under the
**Remote [Codespaces]** tab.

The built `lean-shim.vsix` is not committed (`*.vsix` is in `.gitignore`), so pulls never conflict
on it. Please don't force-add it.

**In another repository's Codespace:** build the package here with `npm install && npm run package`.
Then copy `lean-shim.vsix` into that Codespace and install it from the Extensions view
(**… → Install from VSIX…**) or with:

```bash
code --install-extension lean-shim.vsix
```

## Development

```bash
npm install
npm test                          # compiles and runs the unit tests
node test/lean-verify.e2e.js      # checks the verification rules against a real Lean server (needs `lean` on PATH)
node test/singleline.e2e.js       # checks the one-line rewrite of 28 proof shapes with a real Lean
```

Press `F5` in VS Code with this folder open to start an Extension Development Host.
