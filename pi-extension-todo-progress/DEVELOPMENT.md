# Development guide: Todo Progress for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Source layout

- `index.ts` owns extension registration, checklist extraction, Pi lifecycle hooks, commands, widget rendering, persistence calls, and continuation dispatch.
- `goal-runtime.ts` owns the serializable goal state model, checkpoint validation, restore validation, progress deduplication, pause/resume transitions, and retry bounds.
- `tests/follow-up-delivery.test.mjs` provides the extension lifecycle harness and end-to-end controller regressions without model or network calls.
- `tests/goal-runtime.test.mjs` covers pure state, checkpoint, progress, restore, and bound behavior.

## Checklist flow

Assistant Markdown is split into checklist blocks outside fenced code. The best block is merged with the active list, favoring overlap with prior items. Status-only deltas can update existing items but cannot replace an active list with unrelated work. A completed list requires a goal check before another list starts. Successful compaction permits one complete replacement list.

Checklist lines are stripped from the finalized visible assistant text after they are copied into widget state. The injected hidden checklist context keeps the current list available to the model. Ordinary final assistant text clears the widget; interrupted and tool-use endings preserve it.

Checklist state is stored as version-1 `todo-progress-state` custom entries. These entries do not enter model context. The current active branch supplies the latest valid snapshot during restore.

## Goal state and identities

Explicit goal state is stored separately as version-1 `todo-progress-goal-state` custom entries. The state contains:

- durable goal text and goal identity;
- the identity of the current low-level run;
- controller status and optional pause reason;
- the latest validated checkpoint;
- continuation and consecutive no-progress counters;
- progress revisions and up to 100 bounded progress digests;
- whether a continuation was dispatched but has not started.

The goal identity stays stable for the explicit goal. The run identity changes for every actual low-level agent run, including automatic continuation, native retry, and recovery after compaction. Checkpoints must match both identities, so a checkpoint from a prior run is rejected. Retry counters remain across low-level runs; explicit resume resets the continuation budget and consecutive no-progress count.

Running and waiting states restored on startup, reload, or tree navigation are persisted back as paused. Completed and blocked states remain terminal. The controller never restarts restored work without `/goal-resume`. Every append deep-clones goal state because Pi's session manager retains object references; older branches must not acquire future checkpoint mutations.

## `goal_checkpoint` contract

Every checkpoint requires:

- `status`: `continue`, `completed`, `blocked`, or `waiting`;
- exact `goalId` and `runId` values from injected goal context;
- a nonempty bounded `summary`.

Status-specific fields are:

- `continue`: nonempty `remainingWork` list and `nextAction`;
- `completed`: nonempty `coverage` and `verificationEvidence` lists;
- `blocked`: `blockerCause` and `requiredIntervention`;
- `waiting`: `waitingFor` and `jobId`.

A completion whose verification list consists only of skipped, absent, or unverified claims is rejected. This is shape and obvious-negative validation, not semantic proof.

Terminal checkpoints return a user-readable summary, including completion evidence, blocker intervention, or waiting reference, and request early termination. A terminal checkpoint must be the only tool call in its assistant batch. Pi preflights sibling calls before concurrent execution, so validating the finalized assistant batch prevents a terminal checkpoint from racing with sibling work.

Later assistant or non-checkpoint tool work in the same low-level run invalidates a terminal checkpoint. This invalidation cannot change a paused state and does not reopen a completed goal during a later unrelated run.

## Lifecycle integration

The controller follows Pi’s native lifecycle:

1. `/goal` uses `sendUserMessage` with a uniquely identified controller envelope and records the matching in-memory pending identity. This preserves Pi's native input interception and prompt-startup hooks instead of bypassing them through `sendMessage`. Native busy-session follow-ups keep Pi's existing queue semantics.
2. `message_start` activates the goal only when that exact kickoff identity is delivered; identical ordinary user text cannot activate it.
3. `agent_start` binds or rotates the low-level run identity.
4. `context` removes transport envelopes, preserves the user-authored kickoff, and converts automatic continuation envelopes to custom context. Automatic continuation does not supply new user authorization. The hook also injects the current goal, identities, status, and checkpoint guidance.
5. assistant and tool events update checklist state, invalidate stale terminal checkpoints, and record bounded progress digests.
6. `agent_end` records the latest stop reason and pauses native aborts immediately.
7. `agent_settled` runs only after Pi has exhausted native retries, automatic compaction recovery, and queued continuations. Final provider failure or truncation pauses here; otherwise the controller may dispatch one correlated continuation through native prompt startup. This reapplies per-run policies that Pi clears at settlement.

Repeated `agent_settled` events for the same agent sequence are ignored. Pending messages, waiting state, terminal state, pause, failed dispatch, three no-progress runs, and the 20-continuation ceiling all suppress another follow-up.

`pi.sendUserMessage()` has a void extension API. Synchronous dispatch failures pause immediately. An outstanding dispatch that reaches another settled boundary without starting is also paused. Asynchronous preflight failures cannot be observed directly through this API; `/goal-pause` then `/goal-resume` provides recovery.

A user prompt or non-waking custom notification delivered after a terminal checkpoint retires that checkpoint's execution ownership, even when Pi drains the message in the same low-level run. Subsequent clarification replies cannot reopen a completed or blocked goal. Same-turn late tool work still invalidates terminal evidence.

## Cancellation and waiting

Abort signals are captured from active lifecycle and compaction events. An already-aborted signal pauses immediately. Each observed goal/run identity has one listener per signal; the listener checks that identity before changing current state.

Explicit pause clears pending goal activations and marks their uniquely identified kickoff messages as canceled without clearing Pi’s unrelated message queue. Canceled kickoff and continuation envelopes are neutralized and filtered from model context. Continuations are accepted only while the matching goal/run remains runnable. If an asynchronous startup hook finishes after pause, a canceled standalone controller delivery requests native abort before model work; canceled deliveries within an unrelated queue do not abort that unrelated run. Explicit pause also requests native abort when its active goal is already running.

A waiting checkpoint suppresses automatic continuation. A later non-controller custom message starts a fresh assessment run. Pi exposes no generic independently verifiable job registry here, so custom notification content and stored `jobId` remain attestations; the wake means “reassess” rather than “job succeeded.”

## Observable progress and bounds

Checklist states and successful non-checkpoint tool input/output are serialized in stable key order, hashed with SHA-256, and persisted only as bounded digests. Duplicate digests do not advance the progress revision. Checkpoint prose does not count as progress.

Restore clamps continuation, no-progress, revision, and settled-revision numbers to finite bounds. Malformed terminal states, identifiers, checkpoint fields, oversized progress signatures, and incompatible versions are rejected or restored paused as appropriate.

## Verification

Run deterministic package tests:

```bash
npm test
```

Run focused TypeScript checking:

```bash
tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2023 --skipLibCheck index.ts goal-runtime.ts
```

Integration validation should also import `index.ts` with the `jiti` loader bundled with the installed Pi runtime.

Inspect package contents without publishing:

```bash
npm pack --dry-run --json
```

The lifecycle harness covers real checklist extraction, premature final output, duplicate settlement, run identity rollover, stale checkpoints, same-batch terminal rejection, late-work invalidation, cancellation dominance, completed-goal isolation from later aborts, pending input, native retries and compaction recovery, waiting notifications, exact kickoff correlation, canceled kickoff filtering, queued-goal pause, dispatch failure, restore and tree navigation, malformed state, the 100,000-character acceptance/restore boundary, ordinary chat, and both continuation limits.

Native `AgentSession.prompt` and `sendUserMessage` methods are exercised with an in-memory transport to check input/startup hooks for kickoff and continuation. Native `SessionManager` verifies immutable branch snapshots. Set `PI_GOAL_TEST_RUNTIME` to a Pi runtime module file URL to repeat these tests against a different installed version. Tests have been run against repository Pi 0.84.2 and installed Pi 0.86.1.

The harness intentionally makes no live provider, network, TUI, or background-job calls.
