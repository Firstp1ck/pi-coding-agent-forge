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

Running and waiting states restored on startup, reload, or tree navigation are persisted back as paused. Completed and blocked states remain terminal. The controller never restarts restored work without `/goal-resume` or a user-requested `goal_resume` call. Every append deep-clones goal state because Pi's session manager retains object references; older branches must not acquire future checkpoint mutations.

## `goal` contract

The agent calls `goal` with `{ goal: string }`. The schema rejects additional properties; runtime validation rejects missing, blank, non-string, or oversized text. `createGoalRequest` shares whitespace normalization, the 100,000-character limit, and identity creation with `/goal`.

The tool calls the same `activateGoal` helper as the delivered `/goal` kickoff, but starts within the current run. It does not dispatch a slash command or promote agent-authored text to a user message. The existing tool-result continuation provides the next model request, with the durable goal context already injected. Normal tool preflight hooks and the current run's policies still apply.

Successful results contain a visible `Goal:` preview, status, identities, and continuation/pause guidance. `details` contains `goalId`, `runId`, and `status`. The preview is limited to 2000 characters with a truncation notice; persisted goal text and injected context retain the full goal. Creation does not terminate the run.

Guards:

- Require a sole tool call in the assistant batch to avoid racing sibling work.
- Reject an aborted tool or context signal before activation, and observe cancellation after activation.
- Reject creation while a user `/goal` kickoff is pending.
- Reuse identical normalized running goals without resetting identities, checkpoints, checklists, or continuation budgets. Reject a different goal while one is unfinished.
- Reject paused, blocked, and waiting goals. Only user commands may replace them; `goal_resume` can resume them on user request.
- Require a delivered ordinary user request before creating a new goal. Activation, terminal checkpoints, explicit pause, and restore consume or clear this permission. Controller continuations and custom notifications do not grant it.
- Exclude `goal` calls from observable progress so repeated controller calls cannot defeat the no-progress limit.

`GOAL_TOOL_GUIDELINES` and the checklist policy instruct agents to call `goal` before multi-step work instead of merely printing a label. Simple conversation and user requests without automatic continuation are excluded. An active goal is reused across checklist changes. Scope preservation and the user's opt-out are prompt-level requirements, not semantic checks of the submitted goal text. If the goal tools are unavailable, checklist labels still work without starting the controller.

## `goal_resume` contract

The agent calls `goal_resume` with `{ goalId: string, runId: string }`, matching the stopped goal context exactly. The schema bounds both strings to 200 characters and rejects additional properties. The tool rejects missing or stale identities, missing goals, running or completed goals, sibling tool calls, aborted tool/context signals, pending messages, and queued `/goal` kickoffs.

A delivered ordinary user message while the goal is paused, blocked, or waiting grants one opportunity to resume. Activation, resume, explicit pause, automatic pause, terminal checkpoints, restoration, and custom-message delivery clear that permission. This guard prevents autonomous budget resets without new user input. It does not classify the meaning of the user's words. Tool guidelines, the checklist policy, and stopped-goal context instruct the agent to call `goal_resume` when the user indicates resume intent, but not for status questions, clarifications alone, stop requests, or notifications. Scope and approval constraints still apply.

Both resume entry points call the shared `resumeGoal` helper and `resumeGoalRuntime`. They preserve the goal identity, text, checklist, progress revision, and deduplication history; rotate the run identity; clear the checkpoint and pause reason; reset continuation and no-progress counters; and snapshot the current progress revision as the settlement baseline.

The command still requires an idle session without pending messages and dispatches a correlated continuation. The tool binds the resumed state to the current agent sequence, observes cancellation, and returns without dispatching a message or terminating the run. Its text and `details` report the new `goalId`, `runId`, and `status`; subsequent checkpoints must use the new run identity. Old checkpoint ownership is cleared, so a resumed blocked/waiting goal can complete normally in this run. Neither resume tool calls nor their results count as observable progress.

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

Terminal checkpoints return a user-readable summary, including completion evidence, blocker intervention, or waiting reference, but do not terminate the tool turn. Pi makes one more model request so the assistant can give a normal final reply that carries useful conversation details beyond the checkpoint fields. A terminal checkpoint must be the only tool call in its assistant batch. Pi preflights sibling calls before concurrent execution, so validating the finalized assistant batch prevents a terminal checkpoint from racing with sibling work.

A text-only assistant reply after the tool result leaves the terminal checkpoint intact. A later assistant tool call or non-controller tool work in the same low-level run invalidates it as fresh work. This invalidation cannot change a paused state and does not reopen a completed goal during a later unrelated run.

## Lifecycle integration

The controller follows Pi’s native lifecycle:

1. The `goal` tool activates within the existing run. `/goal` uses `sendUserMessage` with a uniquely identified controller envelope and records the matching in-memory pending identity. This preserves Pi's native input interception and prompt-startup hooks instead of bypassing them through `sendMessage`. Native busy-session follow-ups keep Pi's existing queue semantics.
2. For `/goal`, `message_start` activates the goal only when that exact kickoff identity is delivered; identical ordinary user text cannot activate it. Tool-created goals share the activation helper but do not need a kickoff.
3. `agent_start` binds or rotates the low-level run identity.
4. `context` removes transport envelopes, preserves the user-authored kickoff, and converts automatic continuation envelopes to custom context. Automatic continuation does not supply new user authorization. The hook also injects the current goal, identities, status, and checkpoint guidance.
5. assistant and tool events update checklist state, invalidate stale terminal checkpoints, and record bounded progress digests.
6. `agent_end` records the latest stop reason and pauses native aborts immediately.
7. `agent_settled` runs only after Pi has exhausted native retries, automatic compaction recovery, and queued continuations. Final provider failure or truncation pauses here; otherwise the controller may dispatch one correlated continuation through native prompt startup. This reapplies per-run policies that Pi clears at settlement.

Repeated `agent_settled` events for the same agent sequence are ignored. Pending messages, waiting state, terminal state, pause, failed dispatch, three no-progress runs, and the 20-continuation ceiling all suppress another follow-up.

`pi.sendUserMessage()` has a void extension API. Synchronous dispatch failures pause immediately. An outstanding dispatch that reaches another settled boundary without starting is also paused. Asynchronous preflight failures cannot be observed directly through this API; `/goal-pause` then `/goal-resume` provides recovery.

A user prompt or non-waking custom notification delivered after a terminal checkpoint retires that checkpoint's execution ownership, even when Pi drains the message in the same low-level run. Subsequent clarification replies cannot reopen a completed or blocked goal. Same-turn late tool work still invalidates terminal evidence, while the expected post-checkpoint assistant reply does not.

## Cancellation and waiting

Abort signals are captured from active lifecycle and compaction events. An already-aborted signal pauses immediately. Each observed goal/run identity has one listener per signal; the listener checks that identity before changing current state.

Explicit pause clears pending goal activations and marks their uniquely identified kickoff messages as canceled without clearing Pi’s unrelated message queue. Canceled kickoff and continuation envelopes are neutralized and filtered from model context. Continuations are accepted only while the matching goal/run remains runnable. If an asynchronous startup hook finishes after pause, a canceled standalone controller delivery requests native abort before model work; canceled deliveries within an unrelated queue do not abort that unrelated run. Explicit pause also requests native abort when its active goal is already running.

A waiting checkpoint suppresses automatic continuation. A later non-controller custom message starts a fresh assessment run. Pi exposes no generic independently verifiable job registry here, so custom notification content and stored `jobId` remain attestations; the wake means “reassess” rather than “job succeeded.”

## Observable progress and bounds

Checklist states and successful non-controller tool input/output are serialized in stable key order, hashed with SHA-256, and persisted only as bounded digests. Duplicate digests do not advance the progress revision. Neither checkpoint prose nor goal-creation or resume tool calls count as progress.

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

Native `AgentSession.prompt` and `sendUserMessage` methods are exercised with an in-memory transport to check input/startup hooks for kickoff and continuation. The native checkpoint fixture asserts a third model request for the final reply, with one agent run and no duplicate continuation. Native `SessionManager` verifies immutable branch snapshots. Set `PI_GOAL_TEST_RUNTIME` to a Pi runtime module file URL to repeat these tests against a different installed version. The lifecycle and state suites support repository Pi 0.84.2 and installed Pi 0.87.0. The text-only native startup fixture supplies the image-normalization hook required by Pi 0.87.0.

Agent-created goal regressions cover same-run activation without synthetic user messages, result identities and goal display, continuation and completion, identical-goal reuse, scope-replacement rejection, empty/malformed/oversized inputs, output preview bounds, sole-call enforcement, cancellation, queued user goal precedence, paused/blocked/waiting guards, reload/resume, fresh-request requirements, and label-only fallback.

Resume-tool regressions cover paused/blocked/waiting transitions within the current run, identity rotation and stale-checkpoint rejection, completion without duplicate dispatch, fresh-request requirements, notification and later-pause guards, running/completed rejection, sibling-call rejection, pending messages and queued goals, cancellation before and after resume, restoration, immutable snapshots, budget resets, progress exclusion, automatic continuation, and resume-intent guidance.

`tests/pi-087-compat.test.mjs` runs native sessions with a bounded fake provider from the selected SDK. It verifies that `goal_resume` resumes a restored goal, completes using the new identity, and produces no duplicate run or user message. It also checks that automatic continuation waits for all asynchronous settled handlers, and that pause cancels a deferred continuation. It also covers canonical session restoration, context-edit omission and replacement, tree navigation, expanded turn boundary fields, chained context previews, and `agent_before_settle`. These four tests skip on older SDKs without context-edit support; select Pi 0.87.0 through `PI_GOAL_TEST_RUNTIME` to run them.

The harness intentionally makes no live provider, network, TUI, or background-job calls.
