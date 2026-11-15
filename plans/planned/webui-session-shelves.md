# Compact session sidebar shelves

Status: implementing. Parent owns integration. Base: `2fb06440`.

## Outcome and decisions

User requested T3-style sidebar organization: idle/done/input at the top, Working in the middle, Settled at the bottom collapsed by default. User explicitly chose Settle / Restore, with new work or input automatically bringing a session out of Settled.

This is complex because local lifecycle/persistence and accessible DOM rendering are independent slices, with integration into existing tab/group ownership. Use two isolated Sol/high workers and two fresh Sol/high reviewers. At most two review rounds; parent verifies and fixes findings. No Anthropic, new dependencies, backend changes or production configuration writes.

Apply shelves to the compact left session sidebar. Classic, mobile navigation and optional top-tab presentation retain their existing layouts. Keep Pi theme tokens and controls; borrow T3's thin section headers, counts, disclosure arrows and bottom collapsed shelf. User additionally requested no visible vertical sidebar scrollbar; retain wheel, touch and keyboard scrolling for overflow. Top label is Inbox, with idle/done/input rows; middle Working; bottom Settled. Inbox and Working start expanded. All three headers are keyboard-accessible; expansion is remembered in this browser. No snooze/pinning feature is added.

Settlement is a browser-local organization choice, not process shutdown, tab close, cancellation or a backend session mutation. It survives reload on the same origin. Only idle/done/stopped real Pi tabs can be settled. Working or input-waiting tabs explain why Settle is unavailable. Restore removes the choice. Selecting an already settled conversation does not silently restore it. A new run, blocker, changed session identity or newer completion serial clears settlement, including a run completed while this browser was away. This does not consume unseen-completion state.

Use opaque identity from the tab's creation and session-file metadata, with current lifetime checks for click callbacks. In-memory generation alone is not a durable identity. Bound records and validate storage; errors leave the UI usable without automatic replacement of unsupported stored data. No change to saved workspace/layout schemas.

Partition real tabs individually. Existing custom/CWD groups may have a fragment in more than one shelf, preserving each member exactly once. Render keys are shelf-qualified; custom group IDs and original membership remain unchanged. Group close/add/drag still use the correct subset and scope, with shelf-specific close wording. No duplicate DOM IDs. Saved workspace membership remains intact. Read-only agent projections remain in Inbox/Working according to activity, retain their existing close/detach semantics, and gain no process-mutation action.

## Execution DAG and exclusive scopes

Seed plan commit → A/B in isolated worktrees → parent integration and actual-app checks → two independent reviews → parent dispositions and any fixes → optional second round → acceptance/report/archive.

| Owner | Exclusive writes | Deliverable |
| --- | --- | --- |
| A | `pi-package-webui/public/session-shelf-state.mjs`, `pi-package-webui/tests/session-shelf-state.test.mjs` | Validated bounded local state, explicit settlement/restoration and authoritative activity reconciliation |
| B | `pi-package-webui/public/session-shelves.mjs`, `pi-package-webui/public/session-shelves.css`, `pi-package-webui/tests/browser/session-shelves.spec.mjs` | Accessible three-shelf DOM host, counters, disclosure and compact theme-based presentation |
| Parent | Other files, app integration, asset/cache tuple, actual-app regressions, docs/inventory and this plan | Preserve canonical session/group operations and verify transitions |

Workers may read source but must not edit app.js, shared CSS/index, existing tests, dependencies, plan or production data. Unique ignored handoffs only. No children or reviews by workers. Stop and report incompatible contracts rather than widening ownership.

### A interface

Export `createSessionShelfState({ storage })`. Own key `pi-webui-session-shelves-v1`, schema v1. Return `{ reconcile, settle, restore, setExpanded, snapshot }`.

Caller records are `{ id, identity, state: 'idle'|'done'|'input'|'working', completionSerial }`; do not mutate them. `reconcile(records, { pruneMissing = false } = {})` returns `{ inbox, working, settled, expanded }` with original records in input order. Input has priority over work; caller resolves that precedence. Clear settled records when identity changes, state is input/working, or completionSerial increases. Persist only actual changes. Prune missing IDs only on explicit complete-catalog reconciliation, never just on initialization with an empty list.

`settle(record)` records eligible identity/serial and returns `{ ok, reason }`; reject active work/input and invalid records. `restore(id)` removes a mark. `setExpanded(section, bool)` validates one of inbox/working/settled. `snapshot()` returns detached serializable state. Defaults expanded inbox/working and collapsed settled. Maximum 512 settled records; reject excess explicitly, do not silently evict unrelated rows. Storage acquisition handled by parent; null/denied storage works in memory with structured failure reason. Invalid/future records are not automatically rewritten. Explicit methods may update in memory but report inability to persist. No DOM, timers, network or global listener ownership.

Worker may choose internal serialized shape and specific failure-reason strings, documenting them in handoff. Public methods above must stay fixed. Tests cover reload, new work/input, offline completion, identity replacement, missing-ID prune opt-in, input ordering, limits, corrupt/future/denied storage, defensive snapshots and unchanged no-write reconciliation.

### B interface

Export `createSessionShelves({ document, onToggle })`, return `{ element, slots: { inbox, working, settled }, update, dispose }`. Parent exclusively owns nodes inside the three slots; renderer must never clone/remove their rows in update/dispose. `update({ counts: { inbox, working, settled }, expanded: { inbox, working, settled } })` sets labels/counts/hidden state without replacing buttons or slots. Header click/Enter/Space calls `onToggle(section, nextExpanded)`; parent owns state and rerenders. Defaults same as A. Header labels Inbox, Working, Settled, each with count and chevron. Unique aria-controls, aria-expanded and labeled sections. Expose each header's `data-session-shelf-toggle` and slot's `data-session-shelf-body` value for continuity/testing. `element` class `session-shelves`.

Use existing color/type tokens; bounded narrow layout. Working follows Inbox; Settled occupies the bottom when space permits and scrolls naturally when content exceeds the sidebar. No own persistence, tab actions, polling or resource disposal. If collapsing hides focused row content, move focus to that section header; otherwise preserve focus across updates. Disposal removes only owned listeners/wrapper and detaches parent-owned nodes without mutating them, documenting how parent should reclaim slots before disposal. One canonical instance, no recreations on routine updates. Tests exercise counters, collapsed default, callbacks, focus, repeated update/disposal, parent row identity, long labels, dark/light narrow desktop and populated shelves; screenshots inspected/displayed.

## Parent integration and acceptance

1. Real active metadata maps input first, then working, then unseen done/idle. App runners/workflow runs must remain visibly working where their existing indicators establish active work. New work/input wakes settled items before presentation; no hidden approval.
2. Store reconciliation must run after complete metadata updates even while the sidebar is unmounted; no stale snapshot resurrection or destructive pruning from partial loading. Same-tab session replacement and new/completed runs restore the correct item. No new transport/polling.
3. Settle/Restore controls capture and revalidate tab lifetime and identity. No close/abort request occurs. Counts represent actual tabs/projections, not group headers. A closed tab cannot be revived by a stale action.
4. Shelf/group re-render preserves focus/tooltip/scroll where feasible; disclosure headers have stable keys. Scope/counts are correct for mixed groups, drag membership and close confirmation. New-session affordance remains reachable above shelves; existing tablist ARIA remains valid with collapsed content.
5. Actual-app tests: idle/input/working/done placement; explicit settlement and collapsed default; restore/reload; background blocker and completed-run wake; preserved drafts; group fragment singleton ownership; Classic/top/mobile rollback. Component/Node tests plus affected existing suites. Use disposable actual app and fake Pi; no provider or production settings mutation.
6. Inspect/display desktop, narrow and light screenshots. Verify keyboard disclosure/focus, clipped labels and action hit targets. Cache/static assertions and packaged assets stay coherent. Update README/TECHNICAL/DEVELOPMENT and inventory. Run package check and relevant browser suites; broaden only for new failures/risks.

## Rollback, review and evidence

Rollback is source revert or Classic/top layout selection. Unused browser-local shelf data may remain; no destructive migration. Keep unsupported persisted records intact. No backend/state path changes.

Unique handoffs: `handoffs/session-shelves-a.md`, `session-shelves-b.md`, `session-shelves-review-a-r1.md`, `session-shelves-review-b-r1.md`, optional `session-shelves-review-r2.md`. Final self-contained [acceptance report](../../handoffs/session-shelves-acceptance.html) links back to this plan; archive after verified completion.

All fixtures use parent `bash handoffs/run-ui-polish-command.sh`, isolated HOME/XDG/Pi/Git, system `/usr/bin/chromium` and existing dependencies. Child dependency symlink may point at `/home/firstpick/npm-packages/pi-package-webui/node_modules`; no install. T3's local source was consulted only for organization and explicit settlement; its backend semantics are not copied.

## Progress and review ledger

- User confirmed explicit Settle / Restore and automatic wake for work/input.
- Current tab metadata already exposes sessionFile, creation identity, activity completionSerial and pending input count. Existing supervisor/HTTP/SSE contracts need no change.
- Sol/Codex availability established in this thread; retain user-selected high reasoning. Parent owns group-fragment integration and scope checks.

- Slice A integrated from `1c800861` as `7cfe292d`: 17 state contracts passed. Parent adapter adds eight checks for runner/workflow precedence and stale settle/restore actions; all passed.
- Parent app wiring, docs and actual-app scenarios are prepared. Slice B and combined browser verification remain pending.

- Slice B integrated from `83417c0f` as `cf2fe3a3`. Its ten component cases passed. Parent added hidden scrollbar tracks, three-action sizing, readable full-width row titles and inner-scroll continuity.
- Initial actual-app checks exposed Settle/Close overlap (fixed by explicit action-grid sizing and correct selector specificity), replacement wake latency (fixed at confirmed session invalidation and metadata render identity), and one tablet-mode fixture expectation (fixture now verifies top desktop at desktop width). The 253-file package check passed before the final replacement hook; its eleven affected ownership checks passed afterward.
- Combined candidate browser checks and independent round-one reviews remain pending.

- Round 1 A: no actionable findings; independently passed 36 Node and three actual-app cases. Accepted scoped result.
- Round 1 B: accepted P2 B-R1-001, a retained focused row moved below the viewport because scroll restoration overrode focus reveal. Parent now preserves the old offset for ordinary updates but reveals a clipped retained focused control after a shelf transition. A regression covers both Inbox→Working and Working→Inbox. Round-two verification pending.
- Latest user screenshot clarified that inspector topic tabs must also hide their horizontal scrollbar. Parent applied a CSS-only change, preserving overflow and arrow/Home/End navigation. Two viewport cases and nine adjacent focused-shell cases pass (11 total); cache advanced to PWA177 and workspace CSS3.
- Central candidate verification passed all 253 package files and 54 browser cases; package payload, ten inventory tests and offline caching also passed. Post-fix gates remain in progress.
