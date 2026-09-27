# Qt WebUI UX remediation plan

Status: in progress (uncommitted working tree, 2026-09-27).

- Done earlier in `7da10b5`: W1, plus parts of W3, W4, and W7.
- Implemented and reviewed on 2026-09-27: W2, W3, the attachment part of W4 (tasks 3, 5, and 6, including a `prompt.settled` event for timed-out prompts), and W6. Each change had one independent gpt-6-sol review with fixes applied until it passed. The second (Claude Fable) reviewer was unavailable, so the supervisor did that pass. The full suite passes with 312 tests, and the live smoke suite passes 10/10 on three runs.
- Still open: W4 tasks 7–10 (Restore prompt, full timeout reconciliation, durable pending records, and disabling send during compaction), W5, W7–W13, and the native pointer, keyboard, and assistive-technology checks for W6.
- Accepted limitations:
  - A temporary draft replaces an older draft stored under the same saved-file path. Pi session file names contain a timestamp and a UUID, so this only happens if that exact path is reused.
  - Timed-out prompts release locked attachments only through `prompt.settled` or a backend restart. QML and the backend always ship in the same package.

Source: [Qt WebUI UX review](../reviews/qt-webui-ux-review.md), directly re-reviewed on 2026-09-04 at `786ec7f`.

Related documents: [Contributor guide](../../DEVELOPMENT.md), [technical reference](../../TECHNICAL.md), [README](../../README.md), and [architecture refactor plan](qt-webui-architecture-refactor.md).

## Goal

Protect unsent work and conversation identity, prevent dialog cancellation from terminating the shared backend, and make essential actions and search results reachable. Then consider the review's proposed history, identity-preview, and text-size improvements as separate product decisions.

This document plans the work. It does not authorize implementation, publication, dependency installation, or changes to user settings.

## Evidence and scope

The planning pass read the review, package documentation, test runner, and the relevant backend and QML code at `786ec7f`. The source still contains the immediate prompt-dispatch refusal, unconditional attachment-list clearing, draft transition, dialog cancellation, dialog submission, completion, and unbounded-dialog paths described in the review. No application tests or native-input probes were rerun while writing this plan.

Treat the review's results as a baseline to reproduce, not as new validation:

- Its focused run reported 81 passing tests and one reproducible failure, `pending dialogs are cancelled when Pi exits and cannot be answered afterwards`.
- Pending dialogs during Pi exit caused `backend.fatal` and exit 70. Exit without dialogs separately lost the tab's saved resume target.
- Isolated normal and 200% QML smoke scenarios passed. The default smoke environment lacked per-scenario `PI_WEBUI_SETTINGS_FILE` isolation.
- Component probes measured a 626-pixel dialog in a 520-pixel parent and an Abort right edge at 300 pixels in a 260-pixel composer.
- Extracted-function probes covered findings 1, 2, 7, and 8, but did not exercise native input.

Temporary `/tmp` probes are not regression tests and need not still exist. Recreate their essential cases in maintained tests. The source review is currently local and ignored by Git; this plan retains a finding summary and acceptance criteria so execution does not depend on those temporary artifacts.

### Included work

All ten confirmed defects are in the remediation scope: findings 1 through 9 and 13. Findings 10 through 12 remain optional design opportunities, with implementation proposals and explicit approval gates below. Shared-settings test isolation is a prerequisite even though it has no numbered finding.

### Exclusions and constraints

- Do not start the architecture refactor, introduce tab actors, or extract a shared package as a prerequisite. Apply narrow ownership fixes to the current implementation. Coordinate file moves if the refactor starts separately.
- Keep Quickshell, one local backend, one Pi child per tab, the eight-tab bound, and process-tree cleanup. Add no network listener.
- Preserve protocol/frame bounds, attachment confinement, private atomic storage, untrusted-text rendering, and confirmed link opening.
- Preserve explicit Send/Steer/Follow-up behavior, busy-tab close confirmation, Latest/follow-output separation, focus styling, and reduced motion.
- A timeout is not proof of rejection. Neither a prompt nor an extension answer may be automatically resent because an acknowledgement was lost.
- Do not confuse the bounded transcript with deletion of Pi's saved history.
- Do not claim screen-reader compatibility from accessible properties alone. Native-input and assistive-technology results must be reported separately.
- Leave existing `.gitignore` changes and deleted handoff/review files untouched. `plans/archive/` is already ignored; `plans/planned/` must remain trackable.

## Finding coverage and execution order

| Finding | Problem | Priority | Work package | Required outcome |
| --- | --- | --- | --- | --- |
| 13 | Dialog cancellation exposes inconsistent state and crashes the backend | P1 | W1 | Consistent state before every event; unaffected tabs survive |
| 3 | Child exit erases the saved conversation identity | P1 | W2 | Restart resumes the last confirmed session |
| 2 | In-place replacement carries A's draft into B | P1 | W3 | Explicit draft ownership and race-safe restore |
| 1 | Rejected prompts disappear from composer and saved draft | P1 | W4 | Definite refusal retains or restores work without overwriting newer typing |
| 7 | Acknowledging attachment A hides newly attached B | P2 | W4 | Only authoritatively consumed attachment IDs disappear |
| 4 | Rejected extension answers close and lose edits | P1 | W5 | Validation and acknowledgement-aware dialog lifecycle |
| 9 | Dialog actions and run controls can be offscreen | P1 for essential actions | W6 | Bounded dialogs and usable controls at minimum size |
| 5 | Search counts hidden results without revealing them | P2 | W7 | Current result is visible and marked |
| 6 | Mounted session rail omits external unread state | P2 | W8 | Orthogonal unread marker in the actual rail |
| 8 | Mid-token path completion leaves the old suffix | P2 | W9 | Prefix matching, whole-token replacement |
| 10 | No explicit full-history/full-content route | Design opportunity | W10 | Approved bounded read-only history route, or recorded deferral |
| 11 | Duplicate session names lack inspectable identity | Design opportunity | W11 | Approved keyboard/hover identity preview, or recorded deferral |
| 12 | Text size depends only on desktop scaling | Design opportunity | W12 | Approved app text-size setting with reflow coverage, or recorded deferral |

Recommended sequence:

1. W0 test isolation, then W1 shared-backend crash fix. These unblock trustworthy testing.
2. W2 conversation identity, W3 drafts, W4 prompt and attachment acknowledgement, W5 extension answers.
3. W6 responsive controls, W7 search reveal, W8 unread state, W9 path completion.
4. Decide W10 through W12 individually. Do not delay confirmed-defect fixes for these proposals.
5. W13 integration verification and documentation closure.

W2 precedes W3 because temporary runtime clearing must not look like a new draft owner. W3 precedes W4 because pending submissions need a stable owner. W4's attachment fix belongs in the same change series as prompt settlement, rather than adding another independent callback rule. W5 follows W1 and should reuse the operation-correlation conventions agreed in W4 without forcing a general protocol rewrite. W6 and W5 both change `ExtensionDialog.qml`; land the lifecycle change first. W7 through W9 can proceed independently after W0, but coordinate changes to the shell, bridge, composer, and smoke driver. W12 requires W6's reflow policy.

## Shared implementation rules

### Separate session identity from runtime readiness

Use a stable owner containing the tab identity and a logical session generation. A saved filename is durable identity once confirmed, but it is not sufficient for unsaved sessions or for distinguishing a late response after A-to-B-to-A replacement. Restarting the same conversation must not look like replacing it. Acquiring a first saved filename must migrate the existing draft owner rather than clear the editor.

The backend remains authoritative for confirmed conversation identity, prompt delivery state, attachment consumption, and pending extension requests. QML owns editor text, edit revision, focus, and pending presentation. A delayed callback can settle its originating record without gaining permission to change the current composer.

### Distinguish three acknowledgement boundaries

| Boundary | Meaning | UI consequence |
| --- | --- | --- |
| Local dispatch refused | `request()` did not write a frame and returned no request ID | Keep text, draft, and attachments unchanged |
| Backend outcome confirmed | Backend reports accepted delivery, definite rejection, or authoritative dialog completion | Settle only the originating submission/request |
| Outcome uncertain | Client/backend timeout, connection loss, or missing terminal evidence | Retain recoverable text, show uncertainty, reconcile without resending |

A `message.user` event is not Pi acceptance: `pi-session.prompt()` emits it before awaiting Pi. Extension responses have a different boundary: the current implementation writes `extension_ui_response` without waiting for a Pi acknowledgement. Document that boundary honestly instead of promising remote exactly-once delivery that the Pi transport does not provide.

Any added operation IDs, status queries, terminal records, or revisions must be bounded, tab/session-scoped, validated in `protocol.mjs`, and documented in `DEVELOPMENT.md`. Use additive protocol changes when existing semantics remain intact. Explicitly review a version change if they do not. Unknown, expired, and previous-backend records remain unknown, never implicitly rejected.

## W0. Isolate tests and capture a repeatable baseline

Primary files: `tests/qml-smoke.test.mjs`, `tests/helpers/backend-client.mjs`, `tests/fixtures/fake-pi-rpc.mjs`, `tests/run-all.mjs`, `DEVELOPMENT.md`.

Implementation tasks:

1. Give every `runLiveSmoke()` invocation its own temporary shared-settings file alongside its existing isolated config, state, and agent roots. Cover normal, scaled, model-order, theme-only, and future focused scenarios.
2. Ensure inherited `PI_WEBUI_SETTINGS_FILE` cannot redirect a smoke run to host settings. An explicit test override, if needed, must belong to the test's temporary fixture root.
3. Add an isolation regression using a temporary sentinel file as the inherited host setting. Assert its bytes remain unchanged and each scenario uses its own settings file. Do not test against the real user's file.
4. Audit other test launch paths for shared-settings reads and migration. Keep intentionally shared fixture state explicit and temporary.
5. Prefer deterministic fixture release signals for delayed acknowledgements. Keep waits bounded, capture stderr and events on failure, and sweep all fixture descendants during teardown.
6. Record revision, Node/Qt/Quickshell versions, available Wayland session, focused test results, and skipped checks before changing product behavior.

Acceptance gate:

- Normal and 200% scenarios can run sequentially without affecting one another or the sentinel setting.
- The known pending-dialog failure is captured before W1, or any baseline change is explained.
- No product behavior is changed in the isolation commit. Do not run the unsafe default smoke suite before this gate.

## W1. Make dialog cancellation state consistent before publication

Finding 13. Primary files: `lib/backend/pi-session.mjs`, `lib/backend/tabs.mjs`, `tests/backend-session.test.mjs`, `tests/backend-tabs.test.mjs`, `tests/backend-lifecycle.test.mjs`.

Implementation tasks:

1. Snapshot the dialogs to cancel, then update both `session.dialogs` and `session.dialogOrder` before emitting the first `extension.cancelled` event. Event listeners may synchronously call `snapshot()` through tab-summary publication.
2. Preserve deterministic cancellation ordering and one cancellation per outstanding request. Repeated cleanup calls must be harmless.
3. Audit all map/order mutation paths, including answer, timeout, session switch, new session, restart, close, and shutdown. Apply the same publication invariant to each.
4. Do not use `snapshot().filter(...)` as the sole fix. Optional defensive handling must not hide an invariant violation from tests.
5. Add a direct synchronous observer test that reads a snapshot during each cancellation event, plus real-backend fixture tests.

Regression cases and acceptance:

- Pi exits with zero, one, several, and the maximum pending dialogs. The backend emits normal exit/error evidence, not `backend.fatal`.
- Explicit restart, successful session replacement, new session, tab close, and shutdown with pending dialogs all complete without duplicate cancellation or snapshot exceptions.
- With a second live tab, exit/restart/replacement in the first tab preserves the second child's PID and its ability to answer a prompt. Whole-backend shutdown still terminates both intentionally.
- Answering a cancelled request returns stale without reviving it. An answer racing with cancellation has at most one terminal outcome.
- The previously failing named test passes repeatedly in isolation and in the focused suite.

## W2. Preserve the last confirmed conversation across child failure

Finding 3. Primary files: `lib/backend/pi-session.mjs`, `lib/backend/tabs.mjs`, `lib/backend/state.mjs`, `lib/backend/session-sync.mjs`, `tests/backend-tabs.test.mjs`, `tests/session-sync-integration.test.mjs`.

Implementation tasks:

1. Separate last confirmed session identity from volatile process/model state. Prefer registry-owned identity because the registry already owns restart targets and saved tabs; avoid adding competing fallback filenames in QML.
2. Make runtime invalidation explicit so an empty startup/exit runtime cannot overwrite the confirmed resume identity. Continue clearing stale readiness, model, queue, helper, and process status.
3. Change identity only after a confirmed switch/new-session transition or persisted-session discovery. A failed or cancelled switch keeps the old identity; successful new session may deliberately clear the old file.
4. Keep `pendingResume`, external-session watcher registration, and stale-child rebind behavior consistent with that identity. Do not expose a retained file as proof the restarted Pi child has resumed successfully.
5. Retain an unavailable resume target as recovery context with an actionable warning. Never silently claim a fresh session is the original conversation. Reconcile this behavior with existing missing-file restore guidance.

Regression cases and acceptance:

- Explicit restart while alive and restart after unexpected exit both issue `switch_session` for the original saved file before further mutation.
- Repeat with pending dialogs after W1 and with backend restart from saved tab state.
- Failed readiness reads clear model/readiness but retain the resume target. A successful new session does not resume its predecessor later.
- Cancelled switch, missing/deleted target, fresh unsaved session, and external-session refresh preserve the correct ownership boundary.
- The saved session file remains unchanged by the recovery bookkeeping.

## W3. Make drafts belong to a session, not the current callback

Finding 2. Primary files: `qml/shell.qml`, `qml/BackendBridge.qml`, `lib/backend/state.mjs`, `tests/backend-composer.test.mjs`, `tests/qml-contract.test.mjs`, `qml/SmokeDriver.qml`.

Implementation tasks:

1. Introduce one explicit composer owner and an edit revision. Capture owner, draft key, revision, and text when scheduling the debounce; do not look up a different current key when the timer fires.
2. On confirmed replacement, stop the old timer, flush the old text to the old key including intentional empty text, invalidate stale loads/completions, clear the editor, and request the incoming draft.
3. Apply a loaded draft only if its owner and load generation still match and no newer typing occurred. A nonempty-editor guard alone is insufficient.
4. Distinguish tab selection, confirmed in-place replacement, first filename assignment, same-session synchronization, and restart. First filename assignment migrates the draft; temporary runtime clearing does not initiate a replacement.
5. Define separate temporary ownership for two unsaved tabs in the same folder. Keep existing saved-file draft keys readable and specify migration for workspace-key drafts without copying one legacy draft into every new tab.
6. Route restored text and programmatic editor clears through the same revision rules without creating spurious saves. Surface draft persistence failures rather than claiming the text was saved.

Regression cases and acceptance:

- A-to-B-to-A in one tab restores different nonempty drafts exactly, with an A debounce pending during replacement.
- A late A draft response cannot populate B, or an A session reopened under a newer generation.
- Typing in B while its draft request is pending survives the response. Explicitly clearing B removes its saved draft.
- Two unsaved tabs in one workspace do not overwrite each other. First save, restart, and same-session external refresh do not erase an unsent draft.
- Failed/cancelled session replacement leaves the original editor and owner intact.

## W4. Protect pending prompts and reconcile attachment consumption

Findings 1 and 7. Primary files: `qml/BackendBridge.qml`, `qml/shell.qml`, `qml/components/Composer.qml`, `lib/backend/main.mjs`, `lib/backend/pi-session.mjs`, `lib/backend/attachments.mjs`, `lib/backend/protocol.mjs`, and composer/session tests.

Implementation tasks:

1. Make `sendPrompt()` report immediate dispatch refusal correctly. Account for `request()` invoking a refusal callback synchronously before returning its empty ID.
2. Create the pending-submission record before dispatch. Capture original editor text, transmitted text, mode, submitted attachment IDs, owner, edit revision, and correlation ID. Retain a recoverable copy until the outcome is settled or explicitly dismissed.
3. On successful local dispatch, allow writing the next prompt, but clear only the submitted editor revision. Do not delete the only recoverable saved text before acceptance. Prevent a second send from reusing unresolved attachment IDs.
4. Handle settlement for inactive owners through a narrowly scoped operation handler, not by disabling stale-view callback protection for all requests. An A response may update A's pending record but never clear B's composer or attachments.
5. Define authoritative prompt disposition and consumed-ID reporting at the backend's actual preflight, attachment-take, Pi-write, and acceptance boundaries. A Pi rejection may follow attachment consumption and a transcript row. Remove the current error-code allowlist inference.
6. Apply consumed IDs as a revision-safe delta or reconcile an authoritative attachment snapshot with ordering protection. A snapshot taken before B was added must not overwrite B. Document the treatment of submitted-attachment edits/removals while a send is pending, preferably disabling changes to those IDs until settlement.
7. Offer Restore prompt after definite rejection. Restore into an empty matching editor; otherwise offer a non-destructive preview/copy action or explicit replacement confirmation. Preserve newer typing and do not move rejected A text into session B.
8. Treat timeout/disconnect as outcome unknown. Add a bounded status-reconciliation path if existing correlated evidence is insufficient. Preserve late terminal evidence after a client timeout; do not rely only on the request callback, which has already been removed.
9. Retain recoverable text across a local backend restart. If durable pending-record storage is added, keep it within private state budgets with explicit eviction and migration tests. At capacity, refuse a new submission instead of evicting unresolved user work silently.
10. Disable Send, Steer, Queue, and keyboard submission during compaction while allowing draft editing. Keep backend exclusion authoritative for races and non-UI callers.

Required behavior matrix:

| Scenario | Text and draft | Attachments | Delivery action |
| --- | --- | --- | --- |
| Backend stopped or 64 client requests pending | Never clear | Unchanged | No request sent |
| Compaction/exclusive-operation refusal | Retain or offer safe restore | Retain IDs not consumed | No automatic retry |
| Pi rejection after user-row emission | Recovery remains available; row is not acceptance | Use confirmed consumed IDs | Show rejection |
| Accepted A while newer text/B exists | Settle A only | Remove A, keep B | Never resend A |
| Tab switch or in-place replacement before response | Settle originating record | Update originating owner only | Current session unchanged |
| Timeout followed by late acceptance | Keep uncertainty until reconciled | Use authoritative outcome | No second send |
| Backend exits after dispatch | Keep recovery text and unknown status | Explain loss of in-memory payload if applicable | User reviews before any resend |

Acceptance gate:

Run deterministic delayed-response tests for every matrix row, including A and B attachments, simultaneous background outcomes, and A-to-B-to-A ownership. Assert actual captured Pi command counts and attachment IDs, not just notice text. Also test prompt limit boundaries and Send/Steer/Follow-up behavior. No recovery action may imply that consumed or process-lost attachment bytes remain available when they do not.

## W5. Keep extension answers editable until a confirmed terminal outcome

Finding 4. Primary files: `qml/dialogs/ExtensionDialog.qml`, `qml/BackendBridge.qml`, `lib/backend/pi-session.mjs`, `lib/backend/protocol.mjs`, `tests/backend-session.test.mjs`, `tests/qml-contract.test.mjs`, `qml/SmokeDriver.qml`.

Implementation tasks:

1. Expose the existing 16,384-character answer limit through the bridge's canonical limits. Add a count, inline validation, and disabled submit state to input/editor methods. Count with the same string-length semantics as backend validation and test non-ASCII input.
2. Replace the optimistic `answered` boolean lifecycle with explicit editable, submitting, uncertain, and terminal presentation states. Keep text and dialog visible while submitting; disable repeated submission.
3. Finish on confirmed acceptance, cancellation, or staleness. Definite rejection returns to editable state with its text intact. Immediate dispatch refusal must not close the dialog.
4. Separate visual close, explicit user cancellation, tab-switch hiding, and backend cancellation so `onClosed` cannot send an unintended second response.
5. Retain edits by tab/session/request identity while switching views. Clear them after a confirmed terminal outcome, not merely because the tab became inactive.
6. On timeout, reconcile the exact request against authoritative pending and terminal state before enabling retry. A missing request means no retry; it does not prove Pi consumed the answer. Retain uncertain text for inspection/copy when remote delivery cannot be established.
7. Review `pi-session.answerDialog()`, which currently removes the request before `writeRaw()`. Define consistent behavior for immediate write failure while preserving W1's map/order invariant. Do not claim a successful write is a Pi-side acknowledgement.

Regression cases and acceptance:

- 16,383 and 16,384 characters submit; 16,385 stays editable with a clear error and no frame sent. Oversized prefill/paste remains correctable rather than silently truncated.
- Backend validation rejection, stale request, immediate refusal, delayed response, timeout, late answered event, tab switch, Pi exit, and cancellation all preserve the right text and terminal state.
- Rapid double activation and Escape while submitting do not produce two answers. The next queued dialog opens only after the previous request's disposition permits it.
- Keyboard focus remains usable after rejection and returns correctly after terminal closure.

## W6. Bound dialogs and keep essential run controls reachable

Finding 9. Primary files: `qml/dialogs/AppDialog.qml`, all derived dialogs, `qml/components/Composer.qml`, `qml/shell.qml`, geometry coverage, `tests/qml-contract.test.mjs`.

Implementation tasks:

1. Give `AppDialog` a total-height cap based on its actual overlay dimensions and margins. Separate a scrollable question/body from a persistent action area. Migrate derived dialogs deliberately; merely wrapping the current body would scroll action buttons offscreen.
2. Make full title/question text inspectable without silent elision. Keep untrusted text plain and retain protocol length limits.
3. Bound selection/editor viewports within the remaining body height. Preserve keyboard navigation and scroll the focused option/control into view. Avoid competing nested scroll regions where one body scroll is sufficient.
4. Replace the composer's fixed action row with width-aware wrapping or a compact layout that keeps Abort directly visible. Secondary actions may move to an overflow menu, but Abort must not require opening it.
5. Replace the 148-pixel main-workspace reserve with a measured usable minimum. If rail plus workspace cannot fit, use a keyboard-accessible collapsible rail. Derive the final threshold from real component geometry including margins, not window width alone.
6. Preserve the supported 560-by-520 window minimum. Do not hide the defect by increasing minimum size without a separate product decision.
7. Add a maintained real-QML geometry test with long questions, maximum choices, long labels, validation messages, attachments, and busy controls. Store numeric assertions rather than screenshot-only evidence.

Acceptance gate:

- At 560-by-520 logical pixels, dialogs stay within the overlay and action hit rectangles remain visible and reachable. Every valid question and choice can be inspected by scrolling.
- At a 260-pixel component width, Abort remains within composer bounds. At the full-window minimum, rail resizing cannot make essential actions unreachable.
- Check default and 200% desktop scaling, both densities, and light/dark themes. Repeat larger in-app text scales if W12 is approved.
- Native pointer/keyboard checks cover rail resize/collapse, dialog traversal, long-choice selection, Cancel, and Abort. Handler-driven smoke alone does not satisfy this gate.

## W7. Reveal the current search result without changing saved preferences

Finding 5. Primary files: `qml/shell.qml`, `qml/components/TranscriptRow.qml`, `qml/components/ToolCard.qml`, search smoke/behavior tests.

Implementation tasks:

1. Track the current result by stable row identity, not only an index that changes as the bounded transcript evicts rows.
2. Pass a temporary current-result reveal flag to hidden thinking and tool output. Keep user expansion preference separate from search-forced expansion.
3. Mark matching tool cards and the current match visibly; do not depend on the parent row styling that tools currently suppress. The first fix may highlight the card/row rather than add substring rendering to Markdown.
4. Wait for delegate visibility and height changes before positioning the list. For long tool output, ensure the actual matching output region can be seen, not just the tool header.
5. Clear search overrides when query/search closes or ownership changes. Moving to a new result restores the prior row's user-controlled state. Explicit user preference changes during search remain authoritative.
6. Keep search limited to loaded content until W10 provides another scope. Search navigation pauses follow-output; closing search does not silently jump to Latest.

Acceptance gate:

Test hidden thinking, collapsed tool output, compact-hidden summaries, tool errors, no matches, repeated Next/Previous, streaming updates, row eviction, and tab replacement. The counter must never advance to an invisible current result. Closing search restores visibility/expansion preferences without writing temporary search state to settings.

## W8. Show external unread state in the mounted rail

Finding 6. Primary files: `qml/components/SessionList.qml`, `tests/session-sync-integration.test.mjs`, `tests/tab-activity-state.test.mjs`, QML smoke/contract tests.

Implementation tasks:

1. Propagate registry unread values into enriched catalog rows and temporary open-only rows. Render a compact dot or bounded count in both Working and Settled rows when the associated open tab has unread updates.
2. Include unread state in accessible descriptions and tooltips independently of activity, process error, and pending-input status. Call it unread updates rather than assuming every increment represents one message.
3. Keep existing backend acknowledgement on tab selection. Do not invent a QML counter or infer running/done from unread values.
4. Preserve deferred activity sorting, workspace filtering, current-row highlighting, and Settled desktop-notification suppression.

Acceptance gate:

An external persisted update to an inactive idle tab produces a visible unread marker in the mounted `SessionList` without changing idle to working. Selecting it clears the marker. Repeat for Settled and open-only rows, large counts, filtering, and background completion; verify no extra desktop notification for Settled sessions.

## W9. Replace the whole path token during completion

Finding 8. Primary files: `qml/components/Composer.qml`, composer behavior tests, `tests/qml-contract.test.mjs`, `qml/SmokeDriver.qml`.

Implementation tasks:

1. Keep matching against the prefix between `@` and the cursor, but scan forward to the token's actual whitespace boundary for replacement.
2. Define delimiter insertion once: avoid duplicate spaces when the following text already has a separator, and keep exactly one directory slash where appropriate.
3. Preserve following text and place the cursor after the inserted path. Retain command-completion behavior, stale-result checks, and completion-before-send key handling.

Acceptance gate:

For `inspect @src/main.ts later`, accepting `src/main.ts` with the cursor after `@src/ma` yields `inspect @src/main.ts later`, never the old `in.ts` suffix. Test the beginning, middle, and end of a token; bare `@`; directories; multiple tokens; newline boundaries; existing separators; Unicode; and dismissed/stale suggestions. Acceptance edits only and never sends.

## W10. Optional bounded full-history and full-content access

Finding 10. Decision required before implementation. Primary areas: transcript/history backend services, protocol, shell, a read-only viewer, and persisted-session fixtures.

Recommended product scope:

Offer a separate read-only full-session viewer rather than expanding the live 80-row mirror without limit. First label the live transcript/search as recent loaded output and make shortened Copy behavior explicit. Do not imply an unavailable source can reconstruct missing original content.

Design tasks:

1. Inspect the bundled Pi public session APIs and relevant installed documentation before choosing the persisted-history reader. Define whether the viewer shows the selected conversation branch, compaction context, or all saved entries; label the choice explicitly.
2. Reuse managed-session path validation and persisted-message conversion where appropriate. Do not accept arbitrary paths from QML or reinterpret raw JSONL there.
3. Specify page size, per-response byte/text bounds, session/revision identity, stale-page handling, and cancellation. Chunk oversized content rather than bypassing frame limits.
4. Give shortened messages/tool output an action to inspect full persisted content where stable source IDs support it. If row IDs cannot be mapped reliably, open the session viewer without pretending to target the exact original block.
5. Define search scope and Copy actions separately for live loaded text, a viewer page, and complete persisted content. Avoid loading an entire large conversation merely to copy one shortened part.
6. Keep files read-only. Report missing, corrupt, concurrent-change, ephemeral, and unavailable-original cases without clearing the live transcript or launching an external application automatically.

Acceptance gate if approved:

A saved conversation exceeding 80 rows and the message/tool text caps remains inspectable through bounded pages/chunks. Tests cover branch/compaction semantics, stable navigation during external writes, missing data, escaped symlinks, limits, and zero file mutation. Explicitly report any public API that still materializes the full session in backend memory; bounded output alone is not bounded input processing.

Decision record must name the chosen branch/history scope and resource budgets, or record deferral with the live-view limitations left truthful in documentation.

## W11. Optional full session identity preview

Finding 11. Decision required before implementation. Primary files: `qml/components/SessionList.qml`, `qml/dialogs/PickerDialog.qml`, `qml/shell.qml`.

Recommended scope:

Keep rail rows compact. Add a non-selecting details action accessible from keyboard focus and pointer hover, showing full available title, folder, and session ID. Reuse the same identity formatting for catalog rows and the folder-scoped Resume picker without inventing cross-workspace ambiguity in that picker.

Implementation tasks and acceptance:

- Make preview opening distinct from open/resume/restore. Escape dismisses it and returns focus; keyboard traversal never opens a session implicitly.
- Wrap/scroll details rather than eliding them again. Show an honest fallback for metadata shortened or absent at its source.
- Keep identifying paths local and plain text. Hover must not be the only way to inspect them.
- Test duplicate titles in different folders and different IDs in one folder, very long paths, unnamed sessions, filtering, and minimum-size geometry.

Record approval or deferral separately from the defect milestone.

## W12. Optional application text-size setting

Finding 12. Decision required before implementation. Primary files: `qml/Theme.qml`, typography consumers, `lib/backend/settings.mjs`, `lib/backend/protocol.mjs`, `qml/BackendBridge.qml`, `qml/shell.qml`, settings and geometry tests.

Recommended scope:

Start with one application text-size preference, independent of OS scaling and color-theme selection. Suggested presets are 100%, 125%, 150%, and 200%, with 100% preserving today's sizes. Confirm this range and a menu/palette entry before implementation; separate reading and control scales can wait for evidence that one setting is inadequate.

Implementation tasks:

1. Store and validate the setting through the existing private settings path. Older files default to 100%; invalid values are rejected rather than partially applied. Saving must preserve unrelated settings.
2. Route UI, transcript, code, tool, and dialog font sizes through Theme-owned tokens. Audit literal sizes and offsets so scaling is applied once.
3. Derive control/list heights and wrapping from font metrics or implicit content height. Avoid multiplying every desktop geometry token, which would duplicate OS scaling.
4. Provide an obvious reset action and keep it reachable at the largest size. Do not write Pi's theme setting or shared tool/skill preferences.
5. Recheck menus, dialogs, rail, completion popup, composer actions, transcript selection/copy, and persisted restoration after restart.

Acceptance gate if approved:

Run minimum-window geometry at each supported text preset and at desktop scale factors 1 and 2. No clipped essential action, unreachable reset, font-size literal bypass, or double-applied scale. Test both densities, built-in light/dark, one external theme, reduced motion, and invalid/legacy settings.

## W13. Integration, documentation, and completion

### Documentation changes belong with their work package

| Document | Required updates |
| --- | --- |
| `README.md` | Short practical guidance for prompt recovery, crash restart, corrected unread behavior, and newly approved user controls. Keep safety warnings prominent. |
| `TECHNICAL.md` | Accurate draft ownership, uncertain delivery/retry behavior, attachment recovery limits, extension validation, responsive rail behavior, search scope, and any approved history/text-size controls. Correct existing claims that Copy always returns original unbounded text. |
| `DEVELOPMENT.md` | Operation/identity contracts, cancellation invariants, authoritative consumed IDs, any status queries or state migrations, safe test isolation, regression commands, and known native-input/assistive-technology gaps. |

Do not add internal endpoints, schemas, or implementation file maps to user documentation. Update docs-contract expectations for changed behavior, and preserve useful information by moving it to the correct layer rather than deleting it.

### Automated validation commands

Run from `pi-package-qt-webui/` after W0. The names below are existing test files. New focused behavior/geometry tests must also be discovered by `tests/run-all.mjs`.

Focused defect suite:

```bash
node --test --test-concurrency=1 \
  tests/backend-session.test.mjs \
  tests/backend-tabs.test.mjs \
  tests/backend-composer.test.mjs \
  tests/backend-lifecycle.test.mjs \
  tests/backend-units.test.mjs \
  tests/session-sync-integration.test.mjs \
  tests/tab-activity-state.test.mjs \
  tests/qml-contract.test.mjs
```

Known-crash regression:

```bash
node --test --test-name-pattern='pending dialogs are cancelled' \
  tests/backend-session.test.mjs
```

QML and full package validation:

```bash
node --test --test-concurrency=1 tests/qml-smoke.test.mjs
qmllint -I /usr/lib/qt6/qml qml/*.qml qml/components/*.qml qml/dialogs/*.qml
npm run check
```

`npm run check` already runs the package test runner after Node syntax checks. It includes packed-install coverage that may need package availability; report environmental failures instead of installing globally or claiming success. QML lint may need local import-path adjustment; record pre-existing warnings separately from new errors. Skipped Wayland/Quickshell tests are not geometry or input verification.

From the repository root:

```bash
git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'
git diff --check
```

Also validate links and fenced blocks in new/changed Markdown, including newly created untracked plan files that `git diff` does not inspect.

### Native interaction checks

Use only fake Pi sessions and temporary config/state/shared-settings roots. Record environment and pass/fail evidence for:

1. Send a delayed prompt, type the next one, add another attachment, switch tab, then return. Repeat with rejection and compaction.
2. Switch A-to-B-to-A with real typing and a pending draft debounce. Restart Pi during a drafted saved conversation.
3. Paste an oversized extension answer, correct it, submit, and test Escape during submission and after rejection.
4. Resize to 560-by-520, expand the rail, navigate a long question, and activate Abort with pointer and keyboard.
5. Search hidden thinking and collapsed tool output, navigate matches, close search, and verify previous display preferences.
6. Observe and acknowledge an external unread update in the real rail. Complete a path with the cursor in its middle.

Record screen-reader testing separately if available. Do not treat native Qt geometry, handler invocation, synthesized key input, and real pointer input as interchangeable evidence.

### Delivery and rollback

- Prefer one reviewable commit per work package; W4 may use separate backend-contract, client-lifecycle, and regression commits that land together. Keep W1 independent so it can be reviewed or reverted without later UX work.
- Each change records the reproduced failure, fix, regression result, documentation update, and remaining limitations. Do not add unrelated refactor or formatting changes.
- Test storage changes with old-format fixtures and downgrade behavior. Preserve confirmed session identity and recovery text; a rollback must not silently discard new pending-work records.
- Keep new settings additive. Optional W10 through W12 changes should be independently revertible without reverting confirmed-defect fixes.
- No publication, global install, real-session mutation, or new dependency is part of this plan's validation authorization.

### Completion criteria

The confirmed-defect milestone is complete when W0 through W9 and W13 have verified evidence, every P1/P2 acceptance case passes, and any unavailable native/assistive checks are explicitly recorded rather than represented as passes. A skipped critical geometry/native-action check leaves that acceptance gate open.

The overall plan is complete when the defect milestone is complete and each of W10 through W12 is either implemented and verified or explicitly deferred by the user with a recorded reason. Optional proposals are not release blockers solely because the review listed them. Release approval remains a separate decision.

Keep this file in `plans/planned/` while work is planned or executing. Record results here as the packages land. Move it to `plans/archive/` only after execution and verification are complete and optional decisions are recorded. Preserve the archived plan and review evidence; do not delete them.
