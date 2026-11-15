# WebUI interaction improvements

Status: implementation. Integration owner: parent Codex thread. Baseline: `0941054231a6f2dd13f2018828f516b3c16d3ae3`.

## Outcome and scope

Implement the first four recommendations from the interaction-design assessment: one composer submission action, one searchable action catalog, an actionable attention inbox, and consistent effective model/effort selection. Preserve Pi's visual tokens and all capabilities. This is complex work because three independently testable UI components meet shared application state, asynchronous identities and native modal lifetimes.

The user requested Sol workers and reviewers. Use Codex `gpt-6.1-sol`, high reasoning, isolated worktrees. Two fresh reviewers in round one; at most one further round for accepted fixes and resulting regressions. Same-provider review is intentional user selection. No child delegation.

## Decisions and invariants

- Focused layout receives the new composer controls. Classic and existing phone/tablet mode precedence remain available. No settings schema or backend protocol changes.
- Idle submission says Send. During a run the sole primary button says Steer run or Queue message, matching Enter and a single explicit selector. Explain that steering reaches Pi during the run and queueing follows it; do not promise immediate interruption. Keep Stop/Abort separate and reachable through every dialog. Keep direct keyboard actions and request-ID, attachment, draft and target-generation semantics.
- Focused All tools and Ctrl/Cmd+K open the same complete catalog. Session/Project context buttons open short contextual actions with More actions leading to that catalog's category. Full search must still reach all records. Pins and server-authoritative availability remain intact. Classic palette behavior stays compatible.
- Attention opens an inbox with separate Needs your decision, Running, and Finished sections. Only decisions produce the urgent count. Selecting an item uses its originating tab and existing dialog replay or conversation path. Do not auto-open background approvals, invent missing request details, mark work seen merely by opening the inbox, or add polling. Revalidate identity and availability at invocation.
- Focused composer displays effective model and effort with Session scope. Model opens the existing native immediate-apply picker; effort uses a similarly explicit applied-value choice. Show errors in the picker. Preserve asynchronous dialog/target guards and reject duplicate in-flight selection. Server timing is authoritative; inspect upstream behavior before wording any mid-run timing promise. No speculative auto-revert.
- All new controls support keyboard, Escape, focus return, narrow viewports, dark/light tokens and canonical run controls. No duplicate resource owners or global listeners without disposal.
- No dependency additions, theme redesign, broad noun replacement, Home/navigation reorganization, provider integration or installed configuration changes. Those later proposals remain deferred.

## Execution DAG and exact ownership

Seed plan commit → A/B/C in parallel → parent integration and actual-app scenarios → two round-one reviewers → parent dispositions/fixes → optional bounded round two → central acceptance, documentation and report.

| Workstream | Exclusive write scope | Contract |
| --- | --- | --- |
| A, composer controls | `pi-package-webui/public/focused-composer-controls.mjs`, `public/focused-composer-controls.css`, `tests/browser/interaction-composer-controls.spec.mjs` within that package | Standalone compact component and submission presentation projection. Parent wires existing Send/tag/model/effort owners. |
| B, attention inbox | `pi-package-webui/public/shell-attention-inbox.mjs`, `public/shell-attention-inbox.css`, `tests/browser/interaction-attention-inbox.spec.mjs` within that package | Native dialog rendering caller-owned item snapshots; parent owns activity state and dispatch. |
| C, action discovery | `pi-package-webui/public/shell-tools-launcher.mjs`, `public/shell-context-actions.mjs`, `public/shell-context-actions.css`, `tests/browser/interaction-action-discovery.spec.mjs` within that package | Add initial category to full launcher; contextual short menu backed by same action records. Parent routes entrypoints. |
| Parent | All other paths, including `app.js`, adapter/workspace, index/cache manifest, integration tests, docs, inventory, plan | Integrate components, model/effort picker guards, actual-app journeys, release coherence and acceptance. |

Paths in each row are relative to package root after the first fully qualified path. Workers may read any relevant source, but may edit only their owned paths plus their unique ignored handoff. They must not edit shared files, dependencies, plan, old tests or production configuration. Parent resolves integration issues. Stop and report if an approved interface cannot support source behavior; do not invent an alternate contract.

### A interface

Export `composerSubmissionPresentation({ runActive, behavior })` returning `{ label, description }` for Send / Steer run / Queue message. Export `createFocusedComposerControls({ document, onBehaviorChange, onModel, onEffort })` returning `{ element, update, dispose }`. `update({ runActive, behavior, modelLabel, effortLabel, modelDisabled, effortDisabled, modelReason, effortReason })` displays effective values, Session scope, a busy-only native select labeled During this run with steer/followUp values, and explanation. Callbacks receive the selected behavior or triggering button. No network, storage, hidden app state, existing-node relocation or Send/Stop duplication. DOM remains stable across updates, including keyboard focus.

### B interface

Export `createAttentionInbox({ document, onSelect, onClose })` returning `{ element, slots: { runControls }, open, update, close, dispose }`. Snapshot `{ items }`; each caller-owned item `{ id, tabId, title, detail, state: 'blocked'|'working'|'done', decisionCount, target }`. Pass the original record unchanged to onSelect; never mutate it or infer resource scope. Empty state, stable ordering within three named sections, full count labels, native dialog focus, bounded text wrapping, preserved focused item across updates. Disabled/removed records must not dispatch from stale DOM. `open(snapshot, trigger)` and close restore a still-visible trigger, compatible with nested native dialogs. Parent handles target revalidation, stale-target explanation and seen state.

### C interface

Preserve `createToolsLauncher` API; add optional `initialCategory` in open snapshot. Do not filter out other actions; typing searches whole catalog. Export `createContextActions({ document, onInvoke, onMore, onClose })` returning `{ element, slots: { runControls }, open, update, close, dispose }`. Snapshot `{ title, actions, contextLabel, category }`, parent supplies bounded relevant records in desired order. `open(snapshot, trigger)` preserves original action identity, presents available/unavailable reasons and More actions callback(category), supports native dialog focus/Escape/return. No second catalog or pin persistence. Parent closes before nested action and retains originating trigger.

## Acceptance

1. At idle and while streaming, focused composer exposes one submission button and its label matches Enter dispatch. Change behavior without losing text, attachments or selection. Abort remains reachable.
2. Rail All tools and Ctrl/Cmd+K have identical catalog, categories, pins and full-search results. Context actions retain availability and stale-target checks; More actions exposes the full catalog with the requested initial category. Escape and nested dialog return focus correctly.
3. A background approval is reachable by selecting its labeled inbox item. Running and finished work are distinguishable; mere inbox opening does not consume completion state. Closed/replaced tabs do not receive stale actions; background replay stays authoritative.
4. Focused model/effort controls show effective values. One picker selection applies once, reports failure inline and permits retry without misleading success. Switching tabs or replacing the session during pending requests cannot update a different target or close a newer dialog. Busy-state wording matches verified behavior.
5. Check representative desktop dark/light and phone/tablet/200% layouts using disposable fixtures. Inspect and display screenshots. Assert focus, draft preservation, action reachability and no page errors.
6. Run affected existing browser suites, new component and actual-app tests, package `check`, packaging/cache coherence, inventory generation/check and whitespace checks. Do not count historical 529 browser passes as current evidence. Broaden to the full Chromium suite after combined changes; use zero retries and isolated HOME/XDG/Pi/Git state. Remote package check only if shared contract changes.

## Integration, rollback and evidence

Cherry-pick each owned commit after inspecting diff and handoff; app wiring remains single-writer. New assets must be shipped and PWA-cached together, with coherent app/style/cache versions and static assertions. No persistent migration, so rollback is a source revert preserving user layout and pins. User preview uses copied private state; never mutate installed settings during validation.

Use `/usr/bin/chromium` and existing dependencies, no installation. Parent helper `handoffs/run-ui-polish-command.sh` isolates HOME/XDG/Pi/Git. Child checkouts can use an equivalent ignored wrapper and temporary dependency symlink to the existing root node_modules; document both. No real provider calls, remote Git pushes, native updates or production server launches.

Handoffs: `handoffs/interaction-a.md`, `interaction-b.md`, `interaction-c.md`; unique review reports `interaction-review-a-r1.md`, `interaction-review-b-r1.md`, optional `interaction-review-r2.md`. Each records base/result, owned changes, exact checks/exits, screenshots, omissions, assumptions and integration notes. Commit only owned files.

Final self-contained report: [interaction acceptance](../../handoffs/webui-interaction-acceptance.html). Archive this plan only after verified completion, and update reciprocal report link then.

## Risks and progress

- Existing source-position/static tests may need owner-aware updates, without removing assertions.
- Native model dialog currently has fewer generation guards than append-system; integration must cover close/reopen and same-tab session replacement.
- Existing background metadata exposes counts rather than all request bodies; inbox must be honest about that limit.
- Scope after first four improvements is deferred, not implicitly authorized architectural churn.
- 2026-11-15: source seams verified; baseline clean; Sol/Codex availability confirmed.
- Three isolated Sol/high outcomes inspected and integrated: A `b6f2f398` → `123e8db2` with 11 component cases; B `3a667a39` → `aaf3ea6b` with 21 component cases; C `676a7a63` → `c0edced0` with 10 new and 10 unchanged launcher cases. Handoffs remain in their tool-managed worktrees, under the unique paths specified above.
- Parent model ownership and canonical alias/pin changes committed `6465b40`. Five ownership cases and seven existing action-adapter cases pass. Native model source supports session-local selection without restarting the active response; server effort changes explicitly return a pending-next-prompt value while busy.
- Central integration: 51 new browser cases passed, zero retries, log `/tmp/webui-interaction-new-all.log`. Adjacent run passed 36/37; its sole stale Activity badge assertion was updated to verify the distinct Attention callback, then all 12 workspace cases passed in `/tmp/webui-interaction-workspace-final.log`. Existing model shortcut tests now verify the replacement effective-model trigger and focus return.
- Initial package check passed 250/251 files; `mobile-static.test.mjs` had two stale source-shape assertions for focused hidden buttons and captured model requests. Both retargeted while preserving behavior, and the whole static file passes. Exact final package rerun pending.
- Browser fixture corrections: explicit Focused preference, selector scoping to native dialog, opaque 16+ character fixture request IDs, correct `extensionDialog` ID. No approval product defect was established. Busy normal delivery uses `/api/prompt` plus `streamingBehavior`, rather than direct `/api/steer`; the integration test now verifies that actual contract, with bounded dispatch mocks because fake Pi lacks upstream busy delivery.
- Parent inspected and displayed integrated busy-composer and background-decision screenshots from `test-results/interaction-new-all`. Header Attention is separate from Activity navigation; decisions are urgent, completion count is separate. No destination reorganization.
- App202 / focused adapter CSS4 / PWA174, new component styles1. Inventory regenerated and current. Full browser suite, package rerun, packaging, independent reviews and final report remain pending.

## Review ledger

Pending. Record run identity, finding, evidence, accepted/rejected/deferred disposition, parent verification and recheck results here.
