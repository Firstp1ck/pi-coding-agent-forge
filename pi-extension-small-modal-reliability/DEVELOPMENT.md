# Development guide: Small Model Reliability for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Development setup and checks

For an explicitly authorized fresh checkout, run `npm ci --ignore-scripts` in this package to install its pinned local test dependencies. Routine verification reuses that setup; it must not publish, change active Pi settings, install globally, or invoke real providers.

```bash
cd pi-extension-small-modal-reliability
npm run typecheck
npm test
node scripts/coverage.mjs
for f in skills/*/tests/test_skill_contract.py; do python3 "$f"; done
npm pack --dry-run
```

The Node suite covers isolated state, receipts, scope, evidence, coding, checkpoint, output, advisor, evaluation, and installed `AgentSession` lifecycle cases. The Python suites verify each packaged skill's frontmatter, routing, and contract shape. Package-install behavior needs a separate actual-tarball isolated-fixture smoke; a dry run is not a substitute. `scripts/package-smoke.mjs <fixture-directory>` exercises the installed artifact using Pi's package manager, resource loader and bound AgentSession. The fixture must be under `dev/handoffs/`, with the tarball installed at `install/node_modules/@firstpick/pi-extension-small-modal-reliability`. Use offline installation with lifecycle scripts disabled when the required dependencies are already cached. It writes `smoke-results.json` and never changes active Pi settings.

`scripts/coverage.mjs` runs the same test cases against an isolated TypeScript-to-CommonJS build under `dev/handoffs/`. It adapts module references and the fixture entry point, preloads existing peers through Jiti, then measures native emitted JavaScript with Node V8. It records source hashes, drift, test totals and coverage without installing anything. Compiler helpers are included; this is not source-mapped TypeScript line coverage. Keep the original `npm test` and strict typecheck as separate gates. The fixture and logs are retained for inspection. Direct V8 coverage of Jiti-transformed TypeScript has unreliable line mapping, even with source maps enabled.

Use `tests/fixtures/legacy-task-v1.json` for historical migration checks. Removing top-level v2 fields from a modern task can leave modern nested plan fields behind and falsely validate a broken migration. The static fixture intentionally contains only historical fields; migration must add the new exit-condition and evidence arrays.

## Runtime surface and task state

`index.ts` registers the reliability command plus ten model-facing tools: `reliability_status`, `reliability_scope`, `reliability_evidence`, `reliability_gate`, `reliability_suggest_verification`, `reliability_set_plan`, `reliability_record_progress`, `reliability_supervisor_decision`, `reliability_submit_worker_result`, and `reliability_verify_completion`. Commands retain authority-sensitive UI flows; tool schemas are deliberately separate from command parsing. Complete input contracts are exported by [evidence-contracts.ts](src/evidence-contracts.ts), [scope-contracts.ts](src/scope-contracts.ts), and [quality-gate.ts](src/quality-gate.ts); [types.ts](src/types.ts) defines stored records. The root registration schemas in [index.ts](index.ts) are revalidated by those action-specific parsers before mutation.

`TaskState` is schema version 2. It combines the original task/plan/scratchpad fields with lanes, criteria, trusted mappings, execution receipts, criterion results, completion gates, coding baseline state, evidence summaries, structured-output state, advisor accounting, context checkpoints, recovery episodes, durable counters, and branch/session identity. IDs are monotonic task-local counters. Model statements, cited passages, structural validation, and fluent worker output are audit input, never completion authority.

The state store writes task-local files beneath `.pi/tasks/<task-id>/`, keeps task artifacts outside Git by default, validates artifact paths and ancestors, and rejects symlink escapes. State identity binds the task, workspace revision, Pi session, and persisted branch anchors where the host exposes them. Missing lifecycle identity fails closed for authoritative completion.

## Scope, normalization, and provenance

`reliability_scope` accepts a bounded lane, tools, read/write paths, budgets, validation commands, stop/escalation conditions, approval requests, and preflight checks. Scope normalization canonicalizes paths and shell effects before evaluation. Existing-file writes require receipt-bound current reads: a partial read permits only a unique exact edit inside the read span; a full overwrite needs a full current read.

A native-confirmed scope receipt is required for mutating authority. `bash` and `powershell` additionally require a current, exact, single-use native approval of the normalized effect. Criterion/check mappings only associate an observed command with coverage; they cannot grant shell authority. Tool-result normalization records host provenance, outcome, exit status, touched resources, workspace revisions, and batch settlement before a result can be used as execution evidence.

Verification rechecks current task, branch, scope, session, workspace revision, receipt anchors, and declared criterion mappings. Receipt retention is bounded; retired support makes prior criterion results unknown and requires a fresh check. A completion gate reports pass, fail, or escalate rather than promoting model claims.

## Evidence, coding, and microplans

Evidence packs are versioned task/branch artifacts with sources, exact passages, claims, conflicts, freshness policy, dependency records, and package-owned receipts. Retrieval assessment validates deterministic reference coverage and explicit freshness/conflict requirements; it does not establish semantic truth.

Dependency records bind an exact installed version to current full reads of the installed manifest, optional supported lockfile, source passage, and—when relevant—the project declaration. The coding completion guard independently parses changed code for static external imports. Each detected external package needs current verified dependency evidence even if no declared acceptance criterion named it. Dynamic, alias, unreadable, deleted, or non-code changes cannot silently claim a local-only exemption; they add an exact-diff local-only review requirement.

Coding state records an immutable baseline before mutation, scoped actual changes, exact-diff review dispositions, and repair cycles. Test-integrity, security-path, and local-only reviews become current host criteria and need native user attestation for the exact current diff. Both coding and final gates require current user verification, not just a retained `attested` disposition: branch removal or reaffirmation requires a fresh attestation. Retiring an exact-diff host criterion removes its active mappings while preserving receipt/claim history and consumed counters. Two failed repair cycles following a failed trusted validation block a third repair mutation. Coding phase gates consume current mapped native validation, including optional per-receipt `validation_status`; manual-only coding validation is refused. Historical missing validation metadata is treated conservatively.

Every declared coding command must have its own current receipt, even when commands share a criterion. `receiptFollowsCurrentInstructions` in `src/verification-state.ts` checks persisted native branch order: the result anchor must follow every current authoritative instruction anchor. Native reaffirmation requires settled tools, so a check cannot straddle an accepted correction. Wall-clock timestamps and unchanged workspace bytes cannot establish this ordering. Parsed historical outcomes remain unchanged; missing native ordering proof stays unknown. Reaffirming identical text with a new native receipt requires fresh checks again, including after reload.

Executable microplans have explicit allowed scope and exit conditions. A step becomes complete only through `reliability_record_progress` or `reliability_submit_worker_result` with matching current receipts or artifacts; Markdown checklists are audit context only. Step completion checks the current contract, scope, workspace and branch. Completed historical stages retain their immutable exit-contract evidence through planned downstream edits; final behavioral criteria still require fresh verification. New authoritative requirements invalidate affected completed proofs.

## Input authority and retained-session plan artifacts

Pi 0.85.1 exposes no ingress/admission/delivery correlation. `input` handlers observe progressively transformed text; queued steering/follow-up delivery can skip `before_agent_start`, and direct queue APIs can bypass the input hook. `src/input-authority.ts` therefore consumes only current persisted command/native-confirmation receipts. Historical interactive/RPC queue guesses remain untrusted history. `message_start` user events detect ambiguity without reconstructing raw text. Reliability continuations use custom messages, not synthetic user instructions; internal continuation commands explicitly enable command dispatch.

The optional v2 `input_pause` stores an observation UUID, SHA-256, and session/branch anchor without raw text. Pending candidate text is live-only, bounded to 8,192 bytes. `/reliability input confirm [text]` requires native UI and rechecks candidate/task/session/branch after awaiting it. Its `native-confirmation` receipt is new authority, never an ingress attestation. Exact duplicate text with a new receipt is a new correction; reusing the same receipt does not invalidate proof twice. Persist/reopen confirmation before clearing the pause. Missing live text after reload requires explicit new input. Command-origin instructions, including `/reliability on <goal>`, have real branch receipts as well.

Plan phases retain session identity and native receipts. The existing continuation nonce, iteration ceiling, cancellation controls, and shared completion gate remain in use. Final task completion belongs to the report continuation; intermediate `markComplete` requests cannot finalize a plan run.

`reliability_status` accepts optional `artifact: { run_id, phase, slot, failure_index? }`. `reliability_record_progress` accepts the same artifact object plus `expected_sha256` and `content`; an artifact write cannot be combined with canonical progress fields. Slots are `exploration`, `plan`, `summary`, `verification`, `failure`, and `final-report`. Failure indices are 1–12. Read returns content/SHA-256; write returns the new SHA-256. The 32,768-byte limit, current run/phase/task/session anchors, derived paths, symlink rejection, per-slot exclusive lock and compare-before-replace protect this narrow channel. Caller paths, state, checkpoints, policy, and receipt slots are not accepted.

Writes are phase-bound: explore→exploration; plan→plan; implement→plan/failure; summarize→summary; verify→verification/failure/plan; report→final-report. Artifact text remains untrusted; it cannot alter scope or satisfy verification. Applicable active scope budgets count artifact accesses. Generic protected-directory denial is unchanged. Workspace revision inventory excludes these artifacts, so a final report does not invalidate checked code.

`tests/rf2b-native-lifecycle.test.mjs` exercises actual faux-provider streaming queues, direct steering/follow-up bypass, both transformer positions, real templates/skills, handled/rejected input, queue clearing and native UI decisions. `tests/rf2b-plan-native.test.mjs` drives all retained phases through actual registered tool execution and native receipts, including verify→report→completion. Registered recovery/slot negatives are in `tests/reliability-harness.test.mjs`; coordinator durability and schema negatives are in `tests/rf2b-boundaries.test.mjs`.

## Structured output and quality gates

A structured-output contract is a bounded declarative JSON file for JSON, CSV, enum, bounded-string, or Markdown-checklist validation. Contract activation rereads the file after native confirmation, binds raw and canonical hashes to a Pi receipt, and rejects symlinks, oversized files, unknown schema fields, executable content, or unsupported schema features. Candidate validation is bounded to the original candidate plus two repairs.

Structural success says only that a candidate matches the declared contract. Factual, extraction, interpretation, and behavioral claims remain subject to evidence or human review. Quality-gate claims and escalations record their own native resolutions and cannot resolve unrelated permissions or criteria.

Native quality decisions disclose the task and exact target. Before awaiting confirmation, `captureQualityGateDecisionBinding` captures target contents, task/session/branch identity, instructions and the latest decision. Registration rechecks the same active owner and binding before appending a receipt; canceled, changed or superseded dialogs mint no authority. An escalation whose prior receipt left the current branch may receive a new decision, preserving the old resolution as history. Already-current escalation decisions are refused before append; sequential semantic-review decisions retain their existing latest-decision semantics.

## Checkpoints, advisor, orchestration, and evaluation

Checkpoint artifacts contain immutable handoff, snapshot, request, and receipt material. The coordinator validates state/evidence/scope continuity and freezes mutation on invalid or recovery-required transitions. The installed production host has no verified curator transport, so a checkpoint is recorded as checkpoint-only; it cannot replace or compress the active chat. Any future reset transport must prove provider reset, exact provider-visible continuation, session/branch continuity, rollback, and timeout handling before it can change the context epoch.

The coordinator's live pre-transform recovery witness is a `WeakMap` keyed by the original task object, bound to checkpoint/snapshot identity, pre-reset epoch and native session/branch. It is created only at the initial validated-state durability failure, before discovery/reset/restore. Recovery validates actual workspace content and sealed artifacts; only the workspace observation timestamp refreshed by UI/scratchpad probes is normalized to its witnessed value. It saves a fresh unique recovery transition and rereads it before clearing the latch. Reloaded in-flight states freeze conservatively, and session navigation/compaction/shutdown invalidate the live witness. Neither editable persisted flags, absent receipts, error-message matching, generic resume nor a restore response can establish recovery eligibility.

Automatic advisor calls are a separate bounded path. The configuration must admit one exact authenticated model, `diagnostic-summary` scope, and positive call, token, and cost limits. A durable reservation precedes dispatch; reported usage is reconciled after it. The request is a redacted data-only diagnostic packet triggered only by a current observed failure, unresolved conflict, or exhausted repair episode. It can recommend a next action but cannot modify scope, criteria, permissions, or verification.

Manual separate-model orchestration uses direct native Pi data-only completions for supervisor, worker, and verifier roles. There are no subprocesses, role tools, extensions, or child continuations. It requires native confirmation, exact configured roles, bounded packets, trusted usage metadata, and per-role/cumulative resource limits. Role outputs are parsed as bounded JSON and applied only after current-state checks.

Live evaluation runs frozen sanitized cases through an exact authenticated adapter only after native confirmation. Expected outcomes and independent oracles remain host-only. The evaluator bounds cases, output, timeout, cancellation, duplicate IDs, and result shape; it records unavailable or simulated execution honestly and never substitutes a provider or model.

Redaction of diagnostics, summaries and optional logs is pattern-limited best effort. Do not describe it as preventing all secret storage or transmission. Confirmed instruction text is intentionally lossless; checkpoint snapshot creation refuses recognized unsafe credential copies rather than inventing a lossless redaction guarantee.

## Migration and maintenance

Well-formed v1 state migrates in memory to v2 and is backed up byte-for-byte to `state.v1.backup.json` before the v2 replacement is committed. Legacy completion is converted to blocked/unproven state and must receive current v2 receipts. Migration events are append-only and retryable. Malformed, unsupported, failed, or identity-mismatched state returns `recovery-required`; callers must preserve the file and block mutation/completion instead of overwriting it.

Historical v2 recognizers must reject later-wave markers before supplying absent fields. Both absent and early pre-advisor shapes reject modern `input_pause` and `current_session.input_authority_receipts`, including paired advisor/counter omissions. Recovery preserves the original bytes rather than silently resetting advisor spending. Genuine historical/v1 migration remains supported without changing schema version 2.

RF3 cases in `tests/scope-guard.test.mjs` exercise registered native commands and installed `SessionManager` branches for delayed quality decisions, re-resolution, review currency, per-command reaffirmation and mapping retirement. Coding result events in those fixtures are simulated host observations, not real shell executions. `tests/integration-release.test.mjs` covers mixed-modern advisor recovery and genuine historical spending preservation.

Keep user commands, compatibility, and safe configuration in `TECHNICAL.md`; keep user outcomes and first-use guidance in `README.md`; keep state schemas, tool contracts, runtime algorithms, and test guidance here. Update the six packaged skill contracts with behavior changes. Package publication, dependency upgrades, schema migrations, global settings, and live-provider runs require separate authorization.
