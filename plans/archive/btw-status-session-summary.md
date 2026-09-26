# `/btw-status` session summary feature plan

Status: approved for implementation by the user's explicit feature request  
Integration owner: parent Pi session  
Final report: [../../reports/btw-status-session-summary.html](../../reports/btw-status-session-summary.html)

## Goal

Make `/btw-status` ask the selected agent for a concise summary of the current session, goal, and todo progress, then display the streamed response through the existing BTW overlay surfaces.

## Classification

**Complex (validated preliminary classification).** Although the change is confined to `pi-extension-btw`, it has two meaningful slices: (1) model-request/overlay command behavior and (2) independently owned contract tests plus user-facing command documentation. It also changes an existing public command whose current diagnostic behavior must be replaced, and it must remain correct in both TUI overlay and Web UI RPC widget modes. The existing `/btw` request pipeline provides the implementation seam and materially reduces architecture risk, but does not remove the cross-contract and validation work.

## Success criteria

1. `/btw-status` takes no required arguments and starts a model request using the current main-session transcript.
2. The request asks for a concise status covering the current goal, completed work, active work, remaining todos/next step, and blockers or uncertainty without inventing state.
3. TUI mode opens the existing centered BTW overlay and streams the status response there.
4. RPC mode uses the existing BTW output/footer widget protocol so the Web UI opens/updates its BTW output surface.
5. Each `/btw-status` invocation snapshots the current main transcript rather than inheriting a stale `/btw` side-thread snapshot.
6. `/btw <question>` continuous-side-thread behavior and `/btw-transfer` behavior remain unchanged.
7. Focused automated tests and package documentation describe the new command.

## Scope

- `pi-extension-btw/index.ts`
- One small status-request helper module if needed for a testable contract
- Focused tests under `pi-extension-btw/tests/`
- `pi-extension-btw/README.md`, `pi-extension-btw/TECHNICAL.md`, and package file inclusion if a helper module is added

## Non-goals

- Exposing tools to the side request
- Adding status persistence or a new todo storage system
- Changing the main agent transcript
- Redesigning the BTW overlay or Web UI card
- Changing `/btw-transfer`
- Supporting custom `/btw-status` prompt arguments in this feature

## Approved decisions and invariants

- Replace the existing diagnostic `/btw-status` notification; the user explicitly assigned that command name to session/goal/todo status.
- Reuse the existing `handleBtw` request and display pipeline rather than introduce a second overlay protocol.
- Use a fresh side-thread state per status invocation so the model receives the latest main-session transcript every time.
- Keep tools unavailable and preserve the existing selected-model/authentication behavior.
- Use a stable, explicit status question/prompt that requests concise, evidence-bounded output.
- Keep one writer active in the shared checkout at a time.

## Execution DAG and ownership

### Wave 0 — baseline (integration owner)

- Run the existing package tests.
- Confirm relevant paths are clean.

### Wave 1 — WS1 command behavior (implementation worker 1)

Prerequisite: Wave 0 passes.  
Owns: `pi-extension-btw/index.ts`, optional `pi-extension-btw/status-request.ts`, and `pi-extension-btw/package.json` only if needed to publish the helper.  
Forbidden: tests, README/TECHNICAL, canonical plan, final report, unrelated packages.  
Deliverable: `/btw-status` routes a fresh, fixed status request through the existing BTW overlay/widget pipeline while preserving `/btw`.  
Validation: package tests plus a direct source/type/runtime-compatible check available in the package.  
Handoff: `plans/handoffs/btw-status-command.md`.

### Wave 2 — WS2 tests and documentation (implementation worker 2)

Prerequisite: WS1 integrated and inspected.  
Owns: `pi-extension-btw/tests/status-request.test.mjs`, `pi-extension-btw/README.md`, and `pi-extension-btw/TECHNICAL.md`.  
Forbidden: runtime source, package metadata, canonical plan, final report, unrelated files.  
Deliverable: focused status-prompt/fresh-invocation contract tests and accurate first-use/advanced documentation.  
Validation: `npm test` from `pi-extension-btw` and Markdown diff checks.  
Handoff: `plans/handoffs/btw-status-tests-docs.md`.

### Wave 3 — central integration and validation (integration owner)

- Inspect both actual diffs and handoffs for ownership compliance.
- Run package tests, package dry-run, repository Markdown diff check, and relevant TypeScript validation available in the repository.
- Verify the command registration and status request use a fresh side thread.

### Wave 4 — independent review quorum

Two fresh, read-only reviewers from distinct provider families when available:

- Correctness/architecture/security/edge-case review
- Tests/docs/user-flow/maintainability review

Each finding receives `accepted`, `rejected`, `deferred`, or `needs verification` with evidence in this plan. Accepted fixes are applied by one writer and revalidated.

### Wave 5 — report and acceptance

- Create `reports/btw-status-session-summary.html` with design, implementation, checks, review dispositions, risks, and usage.
- Run the HTML report validator.
- Run the acceptance-tester gate.
- Archive this plan under `plans/archive/` only after all completion checks pass.

## Acceptance checks

- `cd pi-extension-btw && npm test`
- `cd pi-extension-btw && npm pack --dry-run --json`
- Relevant TypeScript check discovered from repository/package configuration, or an explicit recorded omission if none exists
- `git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'`
- Source inspection proving `/btw-status` uses fresh side-thread state and `handleBtw`
- Strict HTML report validation using the enabled `html-report` skill validator

## Integration and rollback

Integration is sequential in the active checkout. The parent inspects WS1 before WS2 starts. If validation fails, revert only the bounded feature edits or send accepted, evidence-backed fixes to one writer. Rollback restores the prior diagnostic `/btw-status` handler and removes the added helper/test/doc references; `/btw` and `/btw-transfer` remain untouched.

## Risks

- **Stale context:** reusing the continuous `/btw` side thread would omit main-session changes after its first snapshot. Mitigation: fresh thread per `/btw-status` invocation.
- **Ambiguous status:** transcript evidence may not contain an explicit goal/todo list. Mitigation: prompt the model to mark missing/uncertain items rather than invent them.
- **Command compatibility:** existing users may rely on the diagnostic notification. This behavior is intentionally replaced by the user's requested public semantics; documentation will be updated.
- **UI mode divergence:** TUI and RPC use different presentation mechanisms. Mitigation: route both through the existing `handleBtw` implementation.
- **Token cost/privacy:** the command makes a separate provider request containing current session context, matching `/btw` behavior. Keep this visible in technical notes.

## Decision record

- 2026-08-13: User explicitly requested `/btw-status` to summarize session/goal/todos in the BTW overlay.
- 2026-08-13: Existing code already registered `/btw-status` as a diagnostic notification; replacement is required, not a second command.
- 2026-08-13: Existing `handleBtw` supplies the correct TUI overlay and RPC widget streaming behavior.
- 2026-08-13: Fresh per-invocation side-thread state selected to ensure current transcript capture.

## Progress and evidence record

- 2026-08-13: Repository exploration found `handleBtw`, `BtwOverlayComponent`, `createWebuiPublisher`, command registration, side-thread queueing, focused tests, and user docs in `pi-extension-btw/`.
- 2026-08-13: No relevant pre-existing changes were reported by `git status --short -- pi-extension-btw plans/planned reports` before plan creation.
- 2026-08-13: Baseline package suite passed 3/3 tests.
- 2026-08-13: WS1 qualifying implementation run `9b29c26f` added the fixed status request and fresh-thread command routing. A prior non-writing attempt `7ac7fbed` was acceptance-rejected after incorrectly treating an already-satisfied parent preflight as unavailable; repository inspection proved it changed no project files before the bounded replacement.
- 2026-08-13: WS2 run `c6f19690` added focused tests and layered user documentation.
- 2026-08-13: Central integration passed 6/6 tests before review, then 9/9 after accepted fixes; `npm pack --dry-run --json`, package/repository diff checks, and no-staged-file checks passed. No package-local TypeScript check exists, so static typechecking remains an explicit omission.
- 2026-08-13: Accepted-fix run `2fddf75b` corrected status-thread shutdown lifecycle, separated the internal model prompt from public overlay/widget/transfer labels, and strengthened behavioral test coverage.
- 2026-08-13: Provider-diverse follow-up reviewers `93b5a6a5` (Anthropic Claude) and `ce3ca00d` (Moonshot Kimi) independently reported no blockers and no remaining fix-now items.
- 2026-08-13: Final report written to [../../reports/btw-status-session-summary.html](../../reports/btw-status-session-summary.html) and passed strict validation with no warnings.
- 2026-08-13: Final acceptance run `a4ebde33` returned **CONDITIONAL PASS** and **GO for integration/merge**. The only material condition is a provider-backed smoke pass in both TUI and Web UI RPC modes before claiming production-validated UI behavior. The plan remains in `plans/planned/` rather than being archived until that runtime evidence is recorded.

## Reviewer findings and dispositions

Initial provider-diverse reviews: `c8157d97` (Anthropic Claude) and `71fef361` (Moonshot Kimi). Follow-up reviews after accepted fixes: `93b5a6a5` and `ce3ca00d`.

| Finding | Disposition | Evidence and rationale |
| --- | --- | --- |
| Fresh status threads were not cancelled on `session_shutdown`. | `accepted` → fixed | Tracked live status threads, cancellation on shutdown, and settlement cleanup added; both follow-up reviewers traced every exit path and verified the fix. |
| The internal `STATUS_REQUEST` and continuous-`/btw` copy appeared in the status overlay/card/transfer payload. | `accepted` → fixed | Added one presentation descriptor consumed by the existing shared pipeline; public status label, title, footer, transfer question, and errors now match status semantics. |
| Status tests were exact-expression coupled and lacked fresh-transcript behavior coverage. | `accepted` → fixed | Registration checks were loosened and a behavioral two-thread transcript-isolation test was added; 9/9 package tests pass. |
| Extra `/btw-status` arguments are silently ignored. | `deferred` | Custom status prompt arguments are an explicit non-goal; no-argument invocation satisfies the requested interface. |
| `/btw-status` and persistent `/btw` requests can compete for the single RPC card. | `deferred` | Existing newest-card-wins semantics are documented; a serialization/card redesign would broaden scope. |
| Web UI command discovery still hides the historical diagnostic command and the BTW card composer does not special-case it. | `deferred` | Main-composer invocation works and `pi-package-webui` is outside the approved package boundary; treat as a separate follow-up feature. |
| Package description/version do not advertise the feature. | `deferred` | Release/version metadata changes were not requested; handle during an authorized publication change. |
| Residual regex formatting sensitivity and the latent hardcoded empty-question usage string. | `rejected` for this scope | Non-blocking maintainability polish with no demonstrated behavior failure; current tests and reviews pass. |

No finding remains `needs verification` at the code-review gate. Runtime visual/provider behavior remains a disclosed acceptance limitation rather than an open reviewer finding.
