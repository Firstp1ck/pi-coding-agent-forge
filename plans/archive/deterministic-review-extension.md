# Deterministic review extension

Status: complete for local delivery. Not installed, enabled, committed or published.
Integration owner: parent Pi session.
Package: `@firstpick/pi-extension-review` in `pi-extension-review/`.
Report: [implementation report](../../reports/deterministic-review-extension.html), to be created after validation.

## Goal and classification

Build `/review`, `/review-setup`, and `/review-status` for session work, Git changes, and complete files/directories. An extension-owned coverage ledger must prevent a model's completion claim from ending an incomplete review.

Classification: complex. Snapshot capture, Git old/new line mapping, returned-read evidence, persistent continuation, isolated SDK execution, and independently accessible TUI status cross multiple contracts. Core coverage and runtime/UI are distinct implementation slices. Parent inspected installed Pi extension, SDK, and TUI documentation and the `pi-extension-git-guided-workflow` package conventions.

Initial checkout: clean `main` at `02cc073cf97e36874b0f97c3d0f9b95478244c82`. No peer workspace session summaries were available.

## User-approved decisions

- Separate read-only review agent with a configurable model, leaving the main agent's model and tools unchanged.
- Work review uses session-recorded changes plus task/conversation context. Flag changes that cannot be attributed reliably.
- Git review requires changed hunks with context on both old and new sides, including deleted lines.
- Ordinary Pi `read` results count only when exact returned ranges and source versions are verified. A dedicated tracked reader is also available. Search snippets, shell output, and model assertions never confer coverage.
- Freeze source snapshots. Report subsequent source drift instead of silently crediting different versions.
- Continue incomplete reviews while progress is made; configurable time/turn/no-progress limits pause as incomplete, preserving resumable state.

## Scope and defaults

Implement a standalone TypeScript Pi extension package, not a pi-subagents dependency. Use Pi's public `pi-agent-core` Agent for isolated reviewer state with explicitly supplied tools and no ambient extensions, executable project configuration, or write/shell tools. Feed its stream function through the main session's public ModelRegistry provider/auth methods. Do not create a replacement ModelRuntime or access private fields. Keep the reviewer provider/model configurable through the authenticated/scoped Pi model registry; default to the current model at review creation. No installation, enablement, global settings edits, publication, commits, pushes, or paid live-provider smoke tests are authorized by this implementation task.

Commands:
- `/review` starts from saved settings. Support explicit `git`, `work`, and `paths` selections, plus `resume` and `cancel` subcommands so a paused run remains operable without extra slash commands. Document exact grammar.
- `/review-setup` edits review-only settings through native UI. Persist only after explicit setup confirmation. Include mode/targets, model/thinking, context lines, exclusions, and continuation limits.
- `/review-status` shows extension-owned current status in a live TUI overlay without waiting for agent idle, sending an agent message, or aborting the agent. Closing it only closes the overlay. Provide a textual non-TUI fallback.

Suggested defaults: Git mode, current model, 3 context lines, 100 total turns per attempt, 15-minute attempt timeout, 3 consecutive no-progress completions. Settings must validate finite bounds. Resume uses the same immutable snapshot and persisted evidence, not a fresh enumeration disguised as continuation.

Review output: deterministic JSON ledger plus Markdown report and short user summary. Report findings with severity, file/version/line location and evidence; enumerate covered, pending, blocked and excluded items. Never claim absence of defects from full read coverage. Coverage proves content delivery, not comprehension.

## Invariants and acceptance criteria

1. Persist an initial manifest before any model call. Each target has canonical identity, snapshot version/hash, required 1-based inclusive ranges, and immutable content. Empty files and metadata-only changes have explicit handling, not fabricated lines.
2. Coverage is an interval union derived from successful finalized read evidence for the exact snapshot. Duplicate/overlapping reads cannot inflate counts. Enforce output byte/line limits and count only complete returned lines. Failed, aborted, malformed, out-of-range or partially truncated lines do not earn coverage.
3. A normal `read` adapter uses Pi's native read implementation against immutable snapshot content and validates actual returned output/ranges. Do not override the main agent's tools. If the native result cannot be proved, leave ranges pending and direct the reviewer to the tracked tool.
4. Git inputs are argument arrays, no shell interpolation or external diff/textconv execution. Handle staged, unstaged, untracked, additions, deletions, renames, spaces/non-ASCII names and an unborn repository. Old and new versions remain separate targets. Resolve Git refs to immutable object IDs. Bound subprocess output and errors; no filesystem writes through Git.
5. Paths remain inside the selected project boundary. Reject traversal, symlink escapes, binary/unsupported/oversized content explicitly. Respect default generated/vendor/secret exclusions and Git ignore where applicable. Exclusions remain visible. Do not claim excluded content was read.
6. Model/tool inputs cannot alter required ranges, forged hashes, evidence or completion flags. Context expansion may add requirements but never remove existing ones. Treat source comments/content as untrusted review data.
7. On each reviewer completion, feed the latest deterministic list back to the agent. If pending/blocked entries remain, continue or pause incomplete at a limit. If coverage is complete, require a final report-generation/confirmation phase; coverage alone is not a findings report.
8. Persist snapshots, ledger, findings and resumable reviewer context locally with validated versioned state, bounded sizes, atomic writes and private permissions where supported. Do not store credentials. Survive reload/restart without automatic model spending. Restore in-flight work as paused. Keep separate review IDs/session ownership and prevent duplicate live starts/resumes.
9. Main session lifecycle changes cancel/dispose the isolated reviewer safely, preserve incomplete evidence, and clean up subscriptions/timers/overlays. Provider failures, missing auth, unsupported model, cancellation and storage errors never become successful completion.
10. Status reads extension state without mutating review progress or invoking the model. UI sanitizes control characters and handles narrow terminal dimensions and scrollable long lists.
11. Unit and integration tests use temporary repositories and fake SDK agents, without network/model calls. Test continuation, no-progress limits, cancellation, restart, drift, evidence forgery, truncation, exact old/new ranges and status independence.
12. README/TECHNICAL/DEVELOPMENT follow root AGENTS.md layers. Root README catalog gains the package. Package check/test and pack dry-run pass; no unrelated changes.

## Workstreams and execution order

One async workflow, sequential shared-checkout writers. Parent does not edit while a worker holds write ownership.

### S0: SDK reconnaissance

Role: scout, strictly read-only. Verify installed APIs for isolated resource loading, model runtime reuse, native `read` operations/truncation, session serialization, cancellation and non-blocking overlay. Inspect relevant installed docs/examples completely and implementation types as needed. Identify package test/import conventions. Output a bounded API handoff through runtime-bound `review/scout.md`. If an invariant cannot be met, contact the parent before any worker starts. No implementation or plan edits.

### W1: deterministic core

Role: worker. Prerequisite: parent acceptance of S0 via supervisor checkpoint before writes.
Write boundary: `pi-extension-review/src/core.ts`, `src/snapshot.ts`, `src/storage.ts`, `src/git.ts`, `src/read-evidence.ts`, `src/report.ts`, and `pi-extension-review/tests/core*.test.mjs`, `snapshot*.test.mjs`, `storage*.test.mjs`, `git*.test.mjs`, `read-evidence*.test.mjs`, `report*.test.mjs` only. May create only these source/test files; no plan, package manifest or root changes.
Deliverables: independent, testable manifest/range/evidence/state/snapshot/Git/storage/report helpers. Exports documented in the handoff for W2. No Pi UI or live model calls.
Validation: Node built-in tests with type stripping where needed, temporary Git fixtures, syntax checks. No new runtime dependencies without parent approval.
Handoff binding: `review/core.md`, report actual mapped output path, changed files, revisions, commands/exit codes, omitted checks, API seam, risks. Contact parent before finishing for core inspection and W2 prerequisite acceptance.

### W2: isolated execution and user interface

Role: worker. Prerequisite: W1 settled and parent acceptance of W1 evidence before writes. Read actual W1 files and handoff, do not infer the API.
Write boundary: `pi-extension-review/index.ts`, `src/runner.ts`, `src/settings.ts`, `src/tui.ts`, `src/session-work.ts`, `tests/runner*.test.mjs`, `tests/settings*.test.mjs`, `tests/tui*.test.mjs`, `tests/session-work*.test.mjs`, `tests/package*.test.mjs`, package `package.json`, `README.md`, `TECHNICAL.md`, `DEVELOPMENT.md`, `LICENSE`. W1 files and root files are forbidden unless parent explicitly revises ownership after inspecting a needed seam correction.
Deliverables: three commands, isolated read-only SDK adapter, exact read-result observation, bounded continuation/report loop, settings UI, status overlay, session work extraction, restart/cancel behavior, package metadata/docs/tests. Use standard Pi peers and installed TypeBox variant, no speculative dependencies. Do not claim a read-only OS sandbox; describe actual tool/resource restrictions.
Validation: `npm test`, `npm run check`, `npm pack --dry-run --json`, fake-agent lifecycle and UI tests. Verify genuine SDK API compatibility without making a paid model call.
Handoff binding: `review/runtime.md`. Report same evidence fields as W1. Ask parent for integrated inspection after writing, then freeze writes while parent runs integration checks.

### Parent integration

Inspect actual changes and test evidence at each barrier. Own canonical plan, root README catalog, seam corrections, accepted reviewer fixes and final report. Run combined checks, documentation diff check, local links and package contents. Retain only task files; no cleanups of unrelated files.

### Independent review

After integrated checks, two fresh-context read-only reviewers assess the complete package against this plan, with distinct emphasis on coverage/Git/security and SDK/lifecycle/UI/tests. Use model-author families distinct from one another and OpenAI implementation where available. Prefer eligible subscription routes; consult the generated OpenRouter selection file for API routes. Use the native review success gate for bounded read-only retries. Record each actual run/model/output and each finding disposition before fixes. If reviewer capability/quorum fails, stop at that gate and request a scoped waiver or alternative.

Role-fit preflight: scout supplies missing installed API facts; two workers own independently testable core and runtime slices; reviewers supply independent integrated critique. Parent owns planning and local evidence synthesis. No external researcher is needed for installed API facts; no oracle/advisor or generic delegate adds a distinct necessary outcome at this point.

## Integration and rollback

This is a new inert package. No migration of user data or settings is performed. Rollback before installation is removal of only task-created package/plan/report files and reversal of the task-owned catalog entry, with user approval for deletion. Runtime state uses a versioned schema and refuses unknown versions rather than silently discarding evidence.

## Risks and open verification

- S0 confirmed that createAgentSession cannot reuse the extension-visible ModelRegistry. Parent verified public Agent/StreamFn and ModelRegistry/provider signatures and approved a standalone Agent with a public provider/auth bridge. This preserves the approved isolation and authentication behavior without private APIs. W2 must test failed/aborted stream translation and cancellation during asynchronous auth resolution.
- Native read truncation includes ambiguous edge cases; use conservative evidence and tracked rereads.
- Work attribution for shell/custom tools is inherently incomplete and must be disclosed, not guessed.
- Frozen snapshots contain source code and task excerpts. Document storage/privacy and bounded retention; do not silently copy secrets or unrelated conversation history.
- Automated tests cannot prove review reasoning quality or all real-terminal behavior. Report manual/live-provider checks not run.

## Progress and evidence

- User decisions resolved through questionnaire `dd373554-d73e-4d3d-9a33-79a6f10a085c`.
- Initial native exploration reports are in the installed repo-explorer skill directory, dated 2026-09-18.
- S0 accepted. Handoff: `C:/Users/hdlea/.pi/agent/sessions/--C--Users-hdlea-Documents-GitHub-npm-packages--/subagent-artifacts/outputs/bc160175-5d15-42a3-a029-d9b1f68efde2/review/scout.md`. Child `ecc8e19a-863c-442e-8c55-09a8385b9e07`, OpenAI GPT-5.6 Terra.
- Parent directly checked installed model-registry.d.ts:1-42, pi-agent-core agent.d.ts:1-115 and types.d.ts:1-35, and pi-ai models.d.ts:45-109. Approved standalone Agent adapter, not AgentSession; read-only capability isolation is not an OS sandbox.
- Status overlay must not await reviewer/main-agent idle or affect either run. Pi custom UI emits ui_prompt lifecycle events even for an unfocused overlay; document/test this host-status limitation rather than claiming it is absent.
- W1 authorized after S0 verification. Parent reran its initial 18 tests successfully, then rejected the first integration checkpoint with reproduced findings: renamed+edited old-side coverage missing, directory selection reading Git internals/ignored files, unchecked version/content identity, incomplete enumeration bounds, and no monotonic context-expansion API. All five accepted for correction within W1.
- W1 attempt 1 (`3db6e4e4-f445-47eb-a09a-257fa91547ba`, GPT-5.6 Terra xhigh) timed out at 1,800,000 ms. Workflow `bc160175-5d15-42a3-a029-d9b1f68efde2` failed; S0 complete, W1 failed, W2 unstarted, no live children. Repository remains main at `02cc073cf97e36874b0f97c3d0f9b95478244c82`, with only the new package and this plan untracked.
- Recovery inspection found partial corrections and 19 passing tests, but missing focused regressions and final W1 handoff. Parent captured all new package content as `C:/Users/hdlea/AppData/Local/Temp/review-w1-timeout-fn5ewL/partial-package.patch`, 120315 bytes. The retained W1 child is resumable; approve one same-protocol retained resume, preserving scope/model and a two-attempt W1 budget. No fallback execution mode or duplicate scout.
- W1 recovery `89c94cd0-5707-43e8-ab4c-e955782b8936` reached a frozen checkpoint. Parent inspected revised version validation, Git rename mapping, ignore handling, bounds and monotonic expansion, plus focused regression tests. Parent reran all 21 tests successfully and `git diff --check` passed. W1 accepted as the core integration prerequisite, subject to integrated runtime tests and independent review. TypeScript typechecking remains unverified; worker reports tsc unavailable. Git drift regression covers mutation during capture, not all possible concurrent race schedules.
- W1 recovery settled successfully; parent read the final API handoff at the original managed `review/core.md` output path. W2 is authorized as the original workflow's unstarted workstream, continued through the same native subagent protocol after the failed composite settled. This is not a replacement W1, parallel writer, or execution-mode fallback. W2 owns only its declared boundary; parent freezes repository writes until its inspection checkpoint.
- W2 initial inspection: parent reran 46 tests and syntax checks successfully. Integration is not accepted yet. Parent verified multiline task context is rejected by runtime validation, Git mode does not apply configured exclusions, final notification lacks requested file/range and findings summary, drift checks confuse Git old versions with post-capture edits, and reporting-phase restart is not resumable. Source also shows saved-model scope bypass, hardcoded workstation paths in tests, report documents left in reporting phase, and unresolved task-owned strict TypeScript diagnostics.
- W2 ownership was extended for focused core.ts/snapshot.ts type-narrowing corrections and portable test/typecheck files. Follow-up also changed git.ts and report.ts plus their tests for pre-content exclusion and final report/drift contracts. These changes exceeded the explicitly granted seam boundary without a separate visible approval checkpoint. Parent inspected the actual changes and now explicitly accepts those narrow seams as required integration corrections; no general W1 ownership transfer is granted. Parent retains plan/root README/report ownership.
- W2 follow-up parent validation: all 52 tests pass, syntax checks pass, strict TypeScript 5.9.3 using installed compiler/public Pi declaration roots has zero diagnostics, and npm pack dry-run passes with 17 entries and no generated state. First parent typecheck command had a PowerShell quoting error before execution; corrected invocation passed. Parent inspected corrected runtime/context validation, exclusions, report persistence/recovery and drift behavior. Integrated implementation is accepted for independent review, not final completion.
- W2 finalized successfully; package writes are frozen pending review disposition. Independent review gate returned 1/2 qualifying outputs. DeepSeek V4 Flash reviewer `00ec6614-2a6c-4c6c-8806-a3aefd270040` completed with BLOCK and findings requiring parent verification. Artifact: managed `outputs/00ec6614-2a6c-4c6c-8806-a3aefd270040/review/runtime-review.md`.
- Anthropic Claude Opus 5 reviewer `34e204d9-da5f-468f-8ab5-9e5e688ceece` failed before producing a review: OpenRouter HTTP 404, all endpoints excluded by configured model/provider guardrails. This is a policy/configuration failure, despite the gate labeling it transient-provider. No bypass or automatic model substitution authorized. All review runs terminal; no live children.
- User explicitly approved `gpt-6-astra` as the second reviewer. Scoped waiver: the second fresh-context read-only review may use the OpenAI Codex family also used for implementation. Astra reviewer `fecfb26a-3181-4359-8c1a-3d03b543a631` completed independently with BLOCK. Artifact: managed `outputs/fecfb26a-3181-4359-8c1a-3d03b543a631/review/astra-review.md`. Together with DeepSeek, the two-output review quorum is satisfied under that waiver; findings still require fixes/revalidation.
- Parent independently reproduced R1, R2 and R3 in disposable repositories: `.gitattributes -diff` gave two covered text targets with zero required lines and zero reads; an unresolved merge gave only metadata; a subdirectory Git capture included a parent file. Parent also verified plural secret names bypass the heuristic. Remaining accepted findings below are verified from the exact control flow and need regression tests during remediation.
- Approved fix owner: retained W2 worker, sole writer across `pi-extension-review/**` for accepted findings only. No root README, plan or HTML-report writes; no dependency installs, settings changes, live-provider tests or publication. This explicit ownership replaces earlier W1/W2 boundaries for this bounded integration fix pass. Stop on new product/security/dependency decisions.

## Independent finding dispositions

Astra findings, source: run `fecfb26a-3181-4359-8c1a-3d03b543a631`, OpenAI GPT-6 Astra high.

| ID | Disposition | Evidence and authorized correction |
| --- | --- | --- |
| R1 binary-classified text falsely covered | accepted | Parent reproduced empty requirements and `reviewReadyForReport=true` without reads under `*.txt -diff`. Block binary-classified changes explicitly; never pass empty hunk requirements as proof. |
| R2 unmerged changes downgraded | accepted | Parent reproduced metadata-only merge-conflict target. Block U/unsupported changes before hunk interpretation. Unknown no-hunk text changes must not become metadata. |
| R3 subdirectory scope expansion | accepted | Parent reproduced repo-root capture from child cwd. Fail closed with guidance when Git project cwd is not repository root for this release; document restriction rather than silently widening. |
| R4 second capture hides drift | accepted | currentBaselines rereads after immutable targets. Derive path/work baselines directly from the capture; return Git current-side/absence baselines tied to validated Git capture. Do not compare historical old blobs to the live worktree. |
| R5 cancellation during launch | accepted | index controller is checked before asynchronous launch; launch does not receive it. Carry lifecycle cancellation through start and every asynchronous initialization boundary. |
| R6 report recovery resurrects cancellation | accepted | reporting recovery has starting=true but no active Agent, so cancel takes disk-only branch. Include report-only work in lifecycle ownership/token and serialized terminal commitments. |
| R7 status replaces execution state | accepted | loadStatus assigns disk state after await with no generation check. Status must format local read snapshots only, never assign execution state. |
| R8 final submission overrides errors | accepted | shouldPause is guarded by !finalReady and Agent only terminates all-terminating batches. Errors/timeouts win; stop after accepted submission with supported turn-stop hook. |
| R9 reload loses user-shell warnings | accepted | collector ignores bashExecution roles. Reconstruct active-branch warnings from persisted user shell messages, including excluded-from-context commands. |
| R10 reread counts inflate progress | accepted | evidence.length is not interval coverage. Measure newly covered required lines, independent of record count or changing findings. |
| R11 runtime ID/schema holes | accepted | record read does not compare filename ID; ID coercion and nullable runtime model pass. Require exact strings/model, filename equality and paired identity checks. |
| R12 loader assumes nested dependencies | accepted | normalRoot still forces peers below coding-agent/node_modules. Resolve every peer normally first, root-based resolution only as fallback. |
| R13 catalog missing | accepted | Parent-owned root catalog addition remains pending and will be completed after package fixes. |

DeepSeek findings, source: run `00ec6614-2a6c-4c6c-8806-a3aefd270040`, DeepSeek V4 Flash high, IDs D1-D10 follow report order.

| ID | Disposition | Evidence and authorized correction |
| --- | --- | --- |
| D1 blocked content produces no report | accepted in part | Missing partial report is real. REJECT suggested relaxation of completion readiness because user-approved completeness gate must remain strict. Write explicitly incomplete ledger/report on pause/cancel when storage works, with pending/blocked findings; never mark complete. |
| D2 unparsed/unmerged diff | accepted | Duplicate of R2, same remediation. |
| D3 rejected-read fallback not directed | accepted | observer drops finalizer.reason. Retain bounded rejection reason and explicit tracked-read guidance for next continuation. |
| D4 storage failure becomes terminal failed | accepted | mutation persists state before record and catch can overwrite recoverable state. Classify/reconcile persistence failures conservatively, preserve evidence and resumable incomplete state when structurally valid. |
| D5 orphaned frozen record on pointer error | accepted | pointer pair is nontransactional and failure hides ID. Include exact review ID/recovery path in freeze failure; avoid unbounded recovery scanning. |
| D6 context exhaustion repeats on resume | accepted for disclosure | No context compaction is implemented. Document bounded-context limitation and actionable narrower-scope recovery; do not invent automatic semantic compaction or silently drop evidence. Preserve incomplete status on context-cap failure. |
| D7 unbounded peer compatibility | accepted | APIs verified with installed Pi 0.85.1, not arbitrary historical versions. Declare tested Pi package floor 0.85.1 and user requirements; no claim of earlier support. |
| D8 plural secret names | accepted | Parent verified secrets.json not excluded. Extend heuristic to plural secrets/credentials/private keys with regressions and state it is not secret scanning. |
| D9 compare baseline with staged version | rejected as proposed | Current-path drift should not compare historical Git blobs with live content, which creates known false warnings. R4 fixes actual separate-capture race while preserving current-worktree baseline semantics; clarify warning wording. |
| D10 tests/docs/dead helpers | accepted in part | Add setup confirmation/cancel, timeout/shutdown and accepted lifecycle race tests; fix root catalog and user storage docs. Parent/worker already ran explicit untracked whitespace/fence/link checks, so tracked diff check was not sole evidence. Defer preference-only removal of harmless exported helpers; tracker clears at shutdown/new extension instance, document precise behavior. |

## Focused recheck and final parent repair

Both focused reviewers returned BLOCK after the first fix pass. Astra recheck `f4edbe9e-d77a-4837-bc0a-09162ef3d65a` and DeepSeek recheck `b7213e52-631b-459d-9573-9fba900ab8e5` confirmed most original findings resolved. Parent reran 65 tests and syntax checks successfully, but accepts the following remaining findings from source inspection: R4 untracked baseline reread; R5 ownership before first await and stale launch writes; R6 report artifacts outside terminal serialization; R8 timeout during reporting and exact-turn-limit regression; R11 paired status/cancel ownership; D1 shutdown partial report; D3 missing fallback guidance on reconstruction/failure; D6 context cap becoming terminal failed; mode-only metadata regression; blocked-Git recovery docs and missing focused tests. These are corrections to previously accepted requirements, not new features. The misleading handoff claim that all findings were fixed is not accepted.

Parent now owns package fixes directly; all child writers are terminal. Use one lifecycle owner from command/resume entry, one serialized persistence boundary for initial writes, artifacts and terminal states, and fault-injection regressions. Keep strict coverage completion, do not auto-compact evidence, and preserve no-install/no-publication scope. R13 root catalog entry has been added.

Parent repair evidence: 81 tests pass, syntax checks pass, and the delayed-status regression passed five consecutive targeted runs. New regressions cover early settings/resume cancellation, delayed launch writes, delayed final artifact rename under cancel/shutdown/timeout, report-only recovery cancellation/shutdown, context-cap pause/resume, exact final-turn completion, paired status/cancel ownership, unverified-read guidance, mode-only Git changes, untracked baseline reuse and setup validation. Parent also reproduced a Windows EPERM during atomic state rename under concurrent status reading; added bounded retries for EPERM/EACCES/EBUSY, preserving old state without delete-before-rename, and a deterministic fault test. An earlier 77-test run failed on that sharing violation; it was diagnosed, not silently rerun away.

All remaining Astra/DeepSeek recheck findings above were addressed in the parent repair. Final Astra review `8f49d9d1-35dd-4f82-981f-4c4ad1d4b6be` returned OK with no issues. Final DeepSeek review `27f78105-252c-455d-99ac-028d5a15c727` returned OK with notes and confirmed every named residual resolved. Output references: managed `review/astra-final.md` and `review/deepseek-final.md` under those run IDs. Both reviewers inspected final source/tests read-only; parent ran the actual validation. Completeness still requires no pending/blocked ranges; incomplete artifacts are not a success waiver.

Final DeepSeek notes are dispositioned individually:
- Exported failReview/failed phase unused: deferred as previously agreed preference-only cleanup. Retain the validated terminal phase for core callers and persisted-state compatibility; current runtime chooses resumable pauses.
- Staged-only drift wording: rejected as a behavioral defect. The message accurately describes the current working-tree baseline, not the staged blob. Technical documentation explicitly states that distinction.
- Incomplete frozen report after shutdown before model start: rejected as a defect. It truthfully records frozen scope with zero review progress and does not claim success; resumability is preserved.

Final artifact checks passed: strict TypeScript 5.9.3 against installed public declarations has zero diagnostics; npm package dry-run contains 17 entries, 55,966 bytes; tracked Markdown diff and explicit untracked whitespace/fence/relative-link checks pass. The mutually linked HTML report exists and its strict validator returns PASS with no errors/warnings. No live-provider smoke test, real terminal rendering session, Linux/macOS execution, install, enablement, commit, or publication has been performed.

A verified troubleshooting note `windows-review-state-atomic-rename-sharing.md` was saved through LEARNINGS. Archive summary/index regeneration failed because the configured archive lacks its README, index, manifest and maintenance scripts; this external archive setup was not changed. That bookkeeping failure does not affect extension tests or report validation.

Final completion gates: two distinct implementation outcomes accepted; parent integration and revalidation recorded; two independent final reviewer outputs current; all findings dispositioned; provider-diversity waiver explicit; final HTML report validated and linked. Implementation missions closed as completed.
