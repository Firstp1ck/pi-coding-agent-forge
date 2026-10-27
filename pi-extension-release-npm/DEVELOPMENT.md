# Development guide: Release Npm for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Additional implementation details

```text
pi-coding-agent-forge/
  dev/
    scripts/
      release-workflow.sh
      bump-package-versions.sh
      check-publish-readiness.sh
      publish-packages.sh

  pi-extension-example/
    package.json
    README.md
    LICENSE
    index.ts

  pi-skill-example/
    package.json
    README.md
    LICENSE
    ...
```

```json
{
  "name": "@scope/package-name",
  "version": "0.1.0",
  "license": "MIT",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  },
  "files": [
    "index.ts",
    "README.md",
    "LICENSE"
  ]
}
```

## Preserved package internals

Release orchestration command for this pi-coding-agent-forge workspace.

## What it does

- Adds `/release-npm` command.
- Adds `/release-npm-setup` command to configure the npm auth token via Pi native input.
- Checks npm authentication with `npm whoami` before release preflight starts.
- Runs release preflight checks before asking to publish.
- Before preflight, `chooseCheckTargets()` asks which package directories to check, all selected by default. `listChangedPackageDirs()` runs `git rev-parse --show-prefix` and `git status --porcelain=v1 -z --untracked-files=all -- .`, strips the prefix from the repository-relative paths (including the original path of renames and copies), and marks the top-level package directories that have staged, unstaged, or untracked changes; Git failures mark nothing. TUI mode uses `showCheckPicker()` (`publish-picker.ts`; `Space`, `Ctrl+A`, `Ctrl+X`, `Enter`, `Esc`); other UI modes page through `ctx.ui.select()`; without a UI every package is checked. When every package stays selected the plan runs with `--all`, otherwise with `--targets <dir,dir,...>`. The selection is recorded in the run log.
- In TUI mode (`ctx.mode === "tui"`), shows the preflight summary and target checklist in a `ctx.ui.custom()` overlay (`publish-picker.ts`) with two independently scrollable panes sized from `tui.terminal.rows`. Pi's built-in extension selector renders the full title and every option without scrolling, so a long summary or package list pushed the choices off-screen.
- `formatPreflightSummary` leaves `unchanged (no publishable changes)` entries out of the Version changes list and adds one line with how many were hidden; the full list stays in the run log.
- Outside TUI mode `custom()` returns `undefined`, so RPC/Web UI clients get the native `ctx.ui.select()` flow: the summary is posted as a chat notice, the prompt title stays two lines, and package toggles are paged (`process.stdout.rows` minus `SELECTOR_RESERVED_ROWS`, minimum 3; 12 when no terminal height is available).
- Publishes only after explicit confirmation.
- During preflight, uses version planning to shortlist publish candidates and runs publish checks only for that shortlist.
- After confirmation, publishes only package targets detected in the pre-confirmation publish plan instead of scanning all packages again.
- After a successful publish, updates installed Pi extensions only for packages detected in that same pre-confirmation publish plan.
- Streams live release output in an above-editor panel, separate from the conversation transcript.
- Shows exact helper commands and current publish target/progress in the live stream.
- In Pi Web UI, renders the live stream as a scrollable release card with toggle/abort actions.
- Keeps the normal Pi input row usable while the release is running.
- Shows phase, output mode, elapsed time, and controls in a below-editor footer.
- In TUI mode, renders live output in a fixed-size, centered, capturing `ctx.ui.custom()` overlay (`release-output-overlay.ts`) instead of above-editor widgets. Pi's interactive mode cuts string-array widgets to `MAX_WIDGET_LINES` (10) and keeps the first lines, so the widget showed stale lines plus `... (widget truncated)`. The overlay owns keyboard focus while visible, so scroll keys reach it rather than Pi's chat; while following, it keeps the snapshot's `focusLine` (the active package from `compactReleaseView()`) about a third from the top, or the tail when no focus line is given. `footer` lines (the progress summary) are pinned below the scrolling area. Manual scrolling stops following; `End` resumes it. `Esc`/`Ctrl+O`/`q` call `OverlayHandle.setHidden(true)`, which returns focus to the editor so slash commands work; `Ctrl+O` or `/release-toggle` calls `setHidden(false)` plus `focus()`. An earlier non-capturing design left scroll keys going to Pi and swallowed typed commands once focused, so it was replaced.
- Matches `Ctrl+O`/`Ctrl+C` with pi-tui `matchesKey` (plus the pi-utils matchers) and ignores key-release events, so Kitty/CSI-u and other terminal encodings work. The key subscription is re-established for the publish phase.
- On Windows, aborts stop the Git Bash (MSYS) process group instead of relying on `taskkill /T` alone. MSYS starts the script in a process whose Windows parent is not the `bash` that Node spawned, so the tree kill missed it and the script kept running. `runScriptLive` writes bash's MSYS PID (`$$`) to a temporary file through `RELEASE_NPM_PID_FILE` and aborts with MSYS `kill -INT -- -<pid>`, then `KILL` plus `terminateProcessTree` after 1.5 s if the step has not exited.
- Renders the live view with `compactReleaseOutput()` (`compact-release-output.ts`) instead of the raw script stream. It re-parses the whole buffer, cached by buffer length, on each render: `==> <dir>` starts a package block and a blank line ends it. Bump-plan lines (`- package:`, `- local version:`, `- npm version:`, `- action:`) set the version line. Readiness lines (`- [PASS|WARN|FAIL|INFO] ...`, `Result: FAIL`) set the status and issues. Publish lines outside blocks (`Publishing`, `PASS Published`, `FAIL`/`WARN ... <name>@<version>`) are matched to packages by npm name. Other lines are shown only when they look like errors or warnings. Changing the output format of `bump-package-versions.sh` or `publish-packages.sh` requires updating this parser and `tests/compact-release-output.test.mjs`. The run log and the LLM failure analysis still receive the full raw output.
- Outside TUI mode, toggles compact/expanded widget output with `/release-toggle` while `/release-npm` runs in the background.
- Aborts the active release subprocess with `Ctrl+C` or `/release-abort` while `/release-npm` runs in the background.
- Saves each release run log under `~/.pi/agent/release-npm-logs/`.
- Shows saved logs with `/release-npm-logs` in an above-editor widget display that works in both TUI and Web UI.

## Install

```bash
pi install npm:@firstpick/pi-extension-release-npm
```

## Configuration

Publishing requires valid npm credentials. `/release-npm` checks `npm whoami` before it starts preflight work and aborts immediately if npm is not authenticated.

Run `/release-npm-setup`, paste an npm access token, and the extension will run:

```bash
npm config set //registry.npmjs.org/:_authToken "<token>"
```

It then verifies the token with `npm whoami`.

## Expected workspace structure

This extension is intended for a package workspace, not a single arbitrary npm package. Run `/release-npm` from the workspace root.

For local development workspaces, release helper scripts live under `dev/scripts`:

Package discovery is shallow: only direct child directories of the current working directory that contain a `package.json` are considered. Nested packages and npm/yarn/pnpm workspace metadata are not scanned.

Each package should include:

Readiness checks require or verify:

- valid `package.json`
- `name`, `version`, and `license`
- `README.md`
- `pi.extensions` with entries pointing to existing files or matching globs
- `keywords` containing `pi-package` is recommended for discoverability
- `LICENSE` is recommended

`/release-npm` runs `./dev/scripts/release-workflow.sh --plan --all` first, or `--plan --targets <dir,dir,...>` when the user narrowed the package list. `--targets` is accepted only with `--plan`; it writes the list to a temporary file and passes it to `bump-package-versions.sh --targets-file` instead of `--target`. The plan step writes publish candidates from version planning to a temporary target list, applies planned version bumps in a temporary workspace, materializes missing `bundledDependencies` there with dependency scripts disabled, and runs publish checks only for those candidate directories. After confirmation, the publish step materializes missing bundles in each selected source package before calling `publish-packages.sh`.

Publishable-content comparison keeps a script-free `npm pack --dry-run` fast path for ordinary packages. Packages declaring `prepare`, `prepack`, or `postpack` are instead packed into a temporary tarball with lifecycle scripts enabled and compared artifact-to-artifact against npm, preventing generated files from causing false release candidates.

### Preflight performance

`prepare_plan_workspace()` in both copies of `release-workflow.sh` copies only candidate directories for ordinary packages. It retains root files for ancestor npm configuration and package metadata, skips `.git`, and skips `node_modules` unless the candidate declares a nonempty `bundledDependencies` or `bundleDependencies` array. Existing bundled dependency trees are copied intact, including transitive dependencies, rather than silently resolving newer versions.

If any candidate declares `prepare`, `prepack`, `postpack`, `prepublishOnly`, `publish`, or `postpublish`, or has `file:`, `link:`, or `workspace:` dependency references, planning falls back to a full repository copy. Hooks may read sibling files (the Anthropic recovery prepack reads `patches/`), ancestor dependencies, or Git metadata. All copying uses Node's filesystem operations to avoid Git Bash process overhead. Version changes and missing bundle installation still happen only in the temporary workspace.

`dev/scripts/package-publishable-changes.sh` and its bundled copy compare the complete file list and contents in one Node process. A NUL-separated file list carries spaces safely. File contents are compared as bytes; only the top-level `package.json` version is ignored. Read or parse errors return `unknown`, which blocks release planning. Both bundled readiness and version scripts source this helper instead of maintaining separate comparison implementations.

Workflow lines beginning `Release progress: ` identify workspace preparation, copying, version changes, bundled dependency preparation, readiness, and cleanup. `compactReleaseView()` displays the latest activity, clears focus from the previous package, and includes it in the pinned summary until a new package header arrives. Keep both workflow copies and both comparison helpers synchronized.

Run `npm test` in this package for release regressions, including `tests/plan-targets.test.mjs`, which checks that both workflows forward `--targets` to the bump planner and reject it outside `--plan`, and `tests/plan-workspace.test.mjs`, which covers selective copying, multiple candidates, installed bundles, hook/local dependency compatibility, no candidates, source isolation, and cleanup after failure for both workflows. Run `node --test dev/scripts/package-publishable-changes.test.mjs` from the repository root for real npm artifact comparisons, including lifecycle-generated files, version-only changes, metadata, binary content, file additions/removals, and paths containing spaces.

## Commands

- `/release-npm-setup` — prompts for an npm token with Pi native input, saves it using `npm config set //registry.npmjs.org/:_authToken <token>`, then verifies with `npm whoami`.
- `/release-npm` — checks `npm whoami` first, asks which packages to check, runs `./dev/scripts/release-workflow.sh --plan --all` (or `--plan --targets <dirs>`), shows the planned version/publish summary plus exact package targets, prompts for confirmation, then runs `./dev/scripts/release-workflow.sh --publish --target <dir>` only for those detected targets. Missing bundled dependencies are prepared before validation and publication; it does not install released packages into Pi afterward.
- `/release-toggle` — in TUI, shows or hides the scrollable output overlay (`Ctrl+O` does the same); in RPC/Web UI, toggles widget output between compact and expanded mode.
- `/release-abort` — aborts the active release subprocess (`Ctrl+C` also aborts in TUI while the release subprocess is active).
- `/release-npm-logs` — select a saved release run and display it above the editor; press `Esc`/`q` in TUI or run `/release-npm-logs close` to close it.

## Tools

None.

## Example view

```text
/release-npm
Release preflight summary:
Version changes:
  @firstpick/pi-extension-release-npm from 0.2.0: would bump up -> 0.2.1
Bump summary:
  - would bump up: 1
  - would reduce down: 0
  - unchanged: 13
  - first release (no npm version): 0
  - errors: 0
Will publish:
  @firstpick/pi-extension-release-npm@0.2.1 -> publish-update
Will skip:
  none
Blocked:
  none

Publish npm packages · 0/3 selected   (TUI overlay: summary pane + package checklist pane)
  [ ] @firstpick/pi-extension-release-npm@0.2.1 (publish-update)
  Tab pane · ↑↓ PgUp/PgDn scroll · Space toggle · A all/none · Enter publish · Esc cancel

Release workflow
  Publish candidates from version planning:
    - pi-extension-release-npm
  Applying planned version bumps in temporary workspace for publish candidates: ./dev/scripts/bump-package-versions.sh --targets-file /tmp/.../publish-targets.txt --apply
  Running publish plan for preselected targets against version-bumped temp workspace: ./dev/scripts/publish-packages.sh --targets-file /tmp/.../publish-targets.txt --publisher npm --access public --strict-auth

Publish summary:
  - published total: 3
  - skipped: 11
  - failed: 0
```

The command checks first, asks only after showing the preflight summary, then shows a scrollable package checklist (paged All/toggle buttons outside the TUI) so you can publish every eligible package or only selected publish/update targets. It keeps release output visible in Pi.
