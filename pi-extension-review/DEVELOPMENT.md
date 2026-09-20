# Development guide: Deterministic review for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Architecture

The package has two layers. The deterministic core freezes source bytes, validates immutable identities, admits exact read evidence, computes interval coverage, persists versioned state, and renders reports. The runtime layer registers Pi commands, bridges the current model registry into an isolated public `Agent`, captures session provenance, and owns settings and TUI status.

`index.ts` registers `/review`, `/review-setup`, and `/review-status`. It tracks finalized host-session tool provenance but never changes the host's active tools or model.

`src/runner.ts` owns snapshot selection, the provider/auth stream bridge, reviewer tools, continuation limits, cancellation, report persistence, and drift checks. `src/settings.ts` owns strict settings plus a separate W2 runtime record because the core review-state schema intentionally accepts no extra fields. `src/session-work.ts` reads only the active session branch and distinguishes exact built-in write/edit attribution from unverified shell or custom-tool activity. `src/tui.ts` owns setup prompts and the nonblocking status overlay.

The core files remain independently testable:

- `src/core.ts` defines state, targets, ranges, evidence, and legal transitions.
- `src/snapshot.ts` captures bounded path content and visible exclusions.
- `src/git.ts` captures immutable Git old/new targets without shell interpolation.
- `src/read-evidence.ts` validates exact complete returned lines.
- `src/storage.ts` performs bounded private atomic state and artifact writes.
- `src/report.ts` renders the deterministic JSON ledger and Markdown report.

## Isolated Agent contract

The runtime constructs `@earendil-works/pi-agent-core` `Agent` directly. It does not call `createAgentSession` or create a new model runtime. The initial state contains a static reviewer prompt, the configured model and reasoning effort, persisted reviewer messages on resume, and these tools:

- `read`, built by Pi's public `createReadTool` with immutable in-memory operations;
- `read_snapshot`, which returns one exact required range;
- `expand_review_context`, which persists a union-only requirement before a wider read;
- `record_review_findings`; and
- `submit_review_report`.

No shell, search, write, edit, extension, skill, or project-resource loader enters this Agent.

The `StreamFn` returns an event stream immediately. Authentication and provider setup run behind that stream, and every setup, malformed-stream, cancellation, and provider error becomes a terminal protocol error event. The function never rejects for those failures. Provider requests receive the Agent signal, registry-resolved API key, headers, base URL, and provider environment.

The stream bridge accepts `TranscriptContext` from Pi 0.86's Agent loop and forwards it unchanged. Prompts and tool declarations live in system messages, not top-level context fields. The registry-adapter regression runs a real public Agent with a fake provider and verifies both through `getCurrentSystemPrompt()` and `getCurrentTools()`.

## Evidence observation

Native reads use virtual paths under `__review_snapshot__/<target-id>/...`. Custom read operations resolve those paths to frozen buffers only. Coverage is admitted from the finalized `tool_execution_end` event, not from model text or a partial update.

The observer reconstructs native output for offsets, caller limits, 2,000-line truncation, the 50 KiB limit, CRLF, UTF-8 BOM, terminal newlines, and the first-long-line case. It verifies the exact native continuation notice and strips no source characters. Only complete source lines then pass to `finalizeReadObservation`.

Tracked reads return identity and lines in tool-result details. The same finalizer validates them. Findings tools can replace validated findings, but they cannot alter hashes, coverage, target versions, or required ranges.

## Lifecycle and persistence

A new review writes core state and its separate runtime record before `Agent.prompt`. Initialization writes, state mutations, final/partial report publication, cancellation, and shutdown commits use one promise queue. Claim lifecycle ownership before the first asynchronous lookup; cancellation invalidates it immediately and commits behind earlier writes. Guards recheck timeout/cancellation at final publication boundaries. A failed report pair rewrites every writable artifact as incomplete before releasing the queue. Agent event listeners are awaited and persist evidence and JSON-safe reviewer messages before settlement.

Each `turn_end` increments the attempt turn count, including turns followed by another tool request. After each Agent completion, the runtime persists the latest count and no-progress result, then injects the current deterministic coverage list into a new prompt. A final report tool call is accepted only when `reviewReadyForReport` is true.

Report completion follows this order:

1. transition to `reporting`;
2. render one deterministic report pair;
3. persist `report.json` and `report.md`;
4. transition to `complete` with those exact artifact hashes; and
5. save completed state.

The core retains its validated `failed` phase and `failReview` export for callers and persisted-state compatibility. The extension runtime currently preserves recoverable execution errors as paused reviews instead.

Explicit cancellation is terminal. One lifecycle token covers initialization, Agent execution, and report-only recovery so stale terminal writes cannot win. Session shutdown aborts and settles the Agent, removes listeners and timers, and leaves a running review paused. A saved `reviewing` state found after an unclean restart is converted to paused before an explicit resume. Generation numbers prevent late events from mutating state after cancellation.

## Settings and storage

All local data lives under `review` in Pi's agent directory. `settings.json` contains versioned user defaults. `runs/<review-id>.json` stores validated runtime-only metadata. `current/` maps an owner session and canonical project to its latest review. Core state and report artifacts live below `state/reviews/<review-id>/`.

The live work tracker belongs to one extension instance. A replacement instance starts empty; active-branch reconstruction restores finalized write/edit and persisted user-shell warnings after reload.

Settings and runtime records reject unknown fields, unsafe IDs, invalid timestamps, unbounded arrays, unsupported reasoning values, and non-finite limits. Writes use private same-directory temporary files and atomic rename. Credentials are never serialized.

## Tests

Run from this package:

```bash
npm test
npm run check
npm run typecheck
npm pack --dry-run --json
```

Tests use Node's built-in runner, temporary repositories, fake providers, fake Agents, and the installed public Pi SDK. They make no paid or network model calls. Fault-injection tests cover context-cap pauses, early resume shutdown, delayed initialization and report renames, final-turn submission, paired ownership, mode-only Git changes, and untracked baseline reuse. Current-file baselines reuse frozen bytes; historical Git blobs never serve as live-worktree baselines. Runtime tests cover native read edge cases, failure-stream translation, public Agent tool loops, auth and tool-loop cancellation, continuation, restart, report artifacts, unknown models, session-branch provenance, nonblocking status, and cleanup.

The repository may not have package-local peer installations. Runtime tests first use normal package resolution, then fall back to the Pi installation next to the active Node executable. Set `PI_TEST_SDK_ROOT` to an explicit `@earendil-works/pi-coding-agent` package directory when Pi is installed elsewhere. Published source keeps normal package imports.

## Maintenance rules

Keep reviewer capabilities read-only and snapshot-backed. Do not add ambient resource discovery or use private model-registry fields. Any new persisted field needs strict validation and a schema-version decision. Any new read path must end at the same evidence finalizer. Update user documentation when command grammar, privacy behavior, storage, or limits change.
