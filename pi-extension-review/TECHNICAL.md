# Deterministic review: technical reference

Advanced user guidance for commands, settings, storage, privacy, limits, and recovery.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements

- Pi packages `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` version 0.86.0 or newer
- Node.js 22.19 or newer
- Git on `PATH` for Git mode
- An authenticated model in the current Pi model scope

## Commands

```text
/review
/review git
/review work
/review paths <project-relative-path> [...]
/review resume [review-id]
/review cancel [review-id]
/review-setup
/review-status [up|down|close]
```

With no arguments, `/review` uses saved settings. Quote a path that contains spaces. `git` and `work` take no extra arguments. `paths` needs at least one path. `resume` and `cancel` use the current review for this Pi session and project unless you provide an ID.

`/review-setup` is available in the native TUI. It selects a scoped, authenticated model and validates its reasoning effort. It also configures mode, paths, extra exclusions, Git context lines, maximum turns, attempt timeout, and consecutive no-progress completions. Cancelling any step leaves the saved file unchanged.

`/review-status` opens an unfocused, live overlay and returns immediately. Run it again to close the panel. The `up` and `down` forms scroll it, and `close` closes it. RPC receives text notifications instead of an overlay. Print and JSON modes do not provide an interactive status display. Pi exposes custom overlays through its prompt-shaped UI API, so hosts may briefly report a `ui_prompt` status even though this extension does not wait for the panel or pause either agent.

## Review modes

### Git

Git mode must be started from the Git repository root and freezes staged, unstaged, and untracked changes. Changed hunks include the configured context on old and new versions. Deleted content remains an old-version target. Git commands use argument arrays and disable external diff and text conversion.

### Work

Work mode examines successful `write` and `edit` calls on the active session branch. It includes a bounded selection of user requests and session summaries. Shell commands and custom tools may change files without a reliable path record. The manifest shows those changes as blocked attribution warnings, so the report cannot claim complete coverage.

### Paths

Paths mode freezes explicit files or recursively selected directories inside the project. It rejects traversal and symbolic links. Git-ignored untracked files and default vendor, generated, runtime, and secret-bearing paths remain visible as exclusions.

Extra exclusion patterns use project-relative paths. `*` matches within the complete relative path, and a matched directory pattern also excludes its descendants.

## Snapshots and continuation

Each review keeps the file versions and required lines selected at its start. Resuming uses those same versions and preserves verified coverage. Start a new review to check newer content.

Read coverage comes only from finalized successful reads whose target identity, exact complete lines, byte limits, and returned range match the frozen snapshot. Duplicate and overlapping reads do not increase coverage. The reviewer can add wider frozen ranges, but it cannot remove an existing requirement or edit snapshot identities.

An attempt pauses on its turn limit, timeout, provider failure, context limit, or no-progress limit. Tool-calling turns count. A successful final submission on the last allowed turn can complete, but a timeout or provider error cannot. Explicit `/review cancel` is terminal, not resumable. Reloading Pi does not resume automatically or spend model tokens. Use `/review resume` explicitly.

The JSON ledger and Markdown report list covered, pending, blocked, excluded, empty, and metadata-only targets. Pauses and cancellation write an explicitly incomplete report when storage is available; they never count as successful completion. Completion requires full non-blocked coverage and a final structured report. Current working-tree files are checked against their capture-time baselines when reporting; changes or removals appear as snapshot-drift warnings. Historical Git versions are not compared directly with the live worktree.

## Models and privacy

The reviewer runs separately and can only read frozen content, request more lines from those versions, and record findings. It does not discover project extensions, skills, prompt files, executable project configuration, or ambient tools. The main agent's model, reasoning effort, messages, and tools remain unchanged.

Pi's current model registry supplies the selected provider and resolved authentication. The extension does not store API keys or provider headers. Frozen source, evidence, findings, bounded work context, and reports are stored under `<Pi agent directory>/review`: settings at `settings.json`, runtime records at `runs/<review-id>.json`, current pointers under `current/`, and state plus `report.json`/`report.md` under `state/reviews/<review-id>/`. Files use private permissions where the platform supports them.

This restriction is not an operating-system sandbox. The extension itself runs with the same user permissions as Pi.

## Limits

Default secret-bearing filename exclusions are conservative path heuristics, including singular/plural secret and credential names and private-key names; they are not secret scanning and cannot detect secrets in ordinary source files.

Defaults are three Git context lines, 100 turns per attempt, a 15-minute attempt timeout, three no-progress completions, 2 MiB per target, 20 MiB of frozen text, and 500 targets. Native and tracked reads return at most 2,000 lines or 50 KiB per call. Settings reject non-finite and out-of-range values.

## Troubleshooting

### The saved model is unavailable

Open `/review-setup` and choose a model in the current scope with configured authentication. The extension does not silently substitute another model.

### Reviewer context is exhausted

The extension does not summarize or discard old review context automatically. It pauses with the last valid saved context when its 2 MiB context-storage limit is reached. Keep the incomplete report, then start a new, narrower path review if either that limit or the provider's context limit is reached repeatedly.

### A review is paused

Run `/review-status` for the reason and remaining ranges, then `/review resume`. Repeated no-progress pauses often mean the reviewer did not use the shown target ID or exact snapshot path.

### A Git target is blocked

Binary-classified, oversized, unsupported, or conflicted changes prevent completion. The incomplete report records the reason. Resolve conflicts or narrow the scope, then start a new review. You can explicitly exclude a path through `/review-setup`; the new review will list it as excluded, not reviewed. For valid text marked binary by Git attributes, `/review paths <path>` reviews its current full content instead of a Git comparison.

### Work mode is blocked

A shell command or custom tool occurred on the active branch, or no successful built-in write/edit result named a current project file. Use `/review paths ...` or `/review git` when you can name the intended source directly.

### The source changed during capture

Start a new review after the worktree or index settles. Capture fails closed rather than pairing moving content with stale line ranges.

## Removal

Remove the package with:

```bash
pi remove npm:@firstpick/pi-extension-review
```

Removing the package does not delete saved review snapshots. Delete the `review` directory under Pi's agent directory only after you no longer need its local reports or resumable state.
