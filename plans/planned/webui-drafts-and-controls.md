# Draft conversations and control repairs

Authorized 2026-11-15, baseline 89c311f8. Parent owns integration and acceptance. User requests exactly one Sol/high implementation worker and one fresh Sol/high reviewer per each of seven tasks. Parent verifies and fixes review findings, with no extra review passes. No Anthropic, installs, real providers, live user configuration, merge or deployment. Existing PR38 may be updated after acceptance.

The draft lifecycle is a complex feature crossing navigation, composer persistence and roster ownership. Other items are bounded UI repairs. Apply feature-development-workflow, code-quality, subagent-governance and final acceptance-tester. Seven independent task reviewers satisfy the overall independent review requirement; task-level review count is one as explicitly requested.

## Outcomes and decisions

1. More: one horizontal row on desktop; each existing action and nested dropdown remains reachable, correctly anchored, keyboard accessible and above overlays. Preserve stable composer geometry and action order. Constrained screens may use a bounded horizontal row with accessible scrolling, never clipping menus or hiding controls.
2. No Project drafts: Pi/Home and No Project open a blank client conversation, with no server tab, child or owned directory until first submission. Untouched blanks never appear in the roster. Leaving a blank conversation with non-whitespace text saves it as a Draft entry in Inbox. Drafts are reopenable and persistent in browser-local storage, separate from server sessions and server snapshots. Drafts cannot settle or run server actions; closing discards only that draft. First submission promotes one draft to one real No Project session, preserving exact target, concurrent edits, attachments feedback, failure recovery and other conversations. Do not invent backend sessions for drafts or include draft IDs in RPC/SSE/restore payloads. Preserve explicit project sessions and owned-directory retention. Never silently drop stored drafts when storage is denied or malformed; report errors and retain memory state.
3. Remove only the duplicate far-left rail Settings icon. Keep the gear alongside Save/Load/Home and existing Settings search/shortcut access.
4. Last real Inbox terminal can close, leaving the empty No Project composer. Preserve running-work confirmation, source identity, Undo where supported, and existing backend allowEmpty contract. Do not create a replacement automatically or delete working directories. Draft close behavior belongs to task 2.
5. Cancel GitHub username setup must end the initiating Git setup flow without opening repository setup or mutating Git/settings. Preserve successful setup, validation errors and preexisting workflow state; avoid clearing unrelated workflows.
6. Folder picker: clear title and current location, straightforward location navigation and list, secondary pinned folders and folder creation, primary choose-folder action. Keep canonical node IDs, Windows roots, direct paths, search, pin/create actions, async identity, Escape/focus and cancellation contracts. Use existing theme and concise wording.
7. + Tab: only the visible button opens the menu; empty row area does not. Menu anchors and sizes to its contents/trigger, not the full stretched sidebar row. Preserve pointer bridging, keyboard navigation, dismissal and narrow/top-layout reachability.

## Ownership and dependency order

All writers use isolated tool-managed worktrees from the current committed integration base. Never overlap active file writers.

- T1: public/focused-composer-disclosure.mjs, public/focused-shell-adapter.css, new tests/browser/more-row-menus.spec.mjs. Existing disclosure tests may be updated only when their old geometry explicitly contradicts this request.
- T2: public/app.js, new public/draft-conversations.mjs and tests/draft-conversations.test.mjs, public/session-shelves.mjs and public/session-shelves.css if needed, new tests/browser/draft-conversations.spec.mjs plus dedicated fixture if needed. May update empty-startup and no-project browser tests for changed explicit-opening semantics. No backend changes by default; escalate a necessary contract change.
- T3: public/shell-workspace.mjs, tests/browser/shell-workspace.spec.mjs, new tests/browser/settings-entrypoint.spec.mjs. Parent migrates other shared fixtures after integration.
- T4: after T2, public/app.js close-control/close-dispatch seams and new tests/browser/last-terminal-close.spec.mjs. Backend only if existing allowEmpty contract proves insufficient, then escalate.
- T5: after T4, public/app.js Git username/setup flow and new tests/browser/git-setup-cancel.spec.mjs.
- T6: public/index.html folder-picker markup, public/styles.css folder-picker selectors, new tests/browser/folder-picker-layout.spec.mjs. Parent owns any required dynamic title/label adapters in app.js while T2/T4/T5 write it. No other index/style edits.
- T7: after T5 and T6, public/app.js new-tab positioning/events, public/styles.css new-tab selectors, new tests/browser/new-tab-hit-target.spec.mjs.

Start T1/T2/T3 in parallel. Launch dependency-ready work as slots free. Each has one separate reviewer after parent integration and targeted checks. Parent owns shared fixtures, cache versions, inventory, docs, screenshots, final report and review fixes. No child delegation. Keep active task IDs and do not poll running delegates.

## Verification and completion

Use disposable HOME/XDG/Pi/npm/Git, fake Pi and system Chromium. Copy the existing ignored isolation wrapper/config; reuse installed dependencies without installs. No preview tools for own-edit checks. Capture, inspect and show relevant screenshots. Verify requested desktop/narrow states, exact action targets, failed/late responses, draft persistence/promotion, and normal project behavior. Central package check and affected integrated browser suite follow integration. Do not weaken security, ownership or assertions merely to pass.

Reviewers report concrete violations of their task contract and direct regressions with reproductions, severity and minimal fixes. Parent records accepted/rejected/deferred/needs-verification and rechecks repairs. One reviewer per task, no additional rounds without a new user instruction. Final self-contained HTML evidence report links back to this plan. Archive only after all seven outcomes, reviews and checks are complete. Rollback preserves owned directories and never silently removes persisted drafts.

## Execution record

Plan committed before delegation. All seven tasks pending. No acceptance claim.

T1, T2 and T3 workers are running from 3749f78, using isolated worktrees and Sol/high. Their client request IDs are `webui-drafts-controls-t1-worker-20261115`, `webui-drafts-controls-t2-worker-20261115` and `webui-drafts-controls-t3-worker-20261115`. Each returns its own `handoffs/drafts-controls-tN.md`. No reviewers launched yet. T4/T5/T7 wait for shared app.js ownership; T6 is independent of these and can start when an execution slot frees.

Parent seam notes for queued workers: last-tab close UI is conditional on `tabs.length > 1` and the close API already accepts `allowEmpty`. +Tab positioning measures the stretched menu container and its hover CSS includes the wrapper; fix both hit area and width. Username cancellation returns null from `configureGitFooterStatusSetup`; inspect its callers before touching workflow state. Folder picker markup is one canonical dialog in index.html; dynamic titles/root labels are app.js-owned and can be wired by the parent after the active app writer finishes.
