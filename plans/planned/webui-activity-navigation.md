# Activity navigation redesign

User-authorized presentation repair: Activity's horizontal list hides destinations and requires sideways scrolling. Replace it with one full-width, visibly labeled native section select and grouped options. This changes navigation presentation, not capabilities, routes, stored preferences or controller ownership. Existing Project tabs remain.

## Contract

- Activity section picker accessible name: `Activity section`. Visible label: `View`. Current selected section always visible. Native select preserves platform keyboard, touch and menu dismissal behavior.
- Group known IDs: Work (`subagents`, `queue`, `progress`); Conversations (`conversations`, `extensions`); Usage & diagnostics (`codex-usage`, `claude-usage`, `events`); Session (`session`, `sampling`, `commands`). Unknown future topics remain reachable in More. No duplicate workflow or extra navigation hierarchy.
- Call existing onInspectorSelect(id) once per user selection. No callback on snapshot updates. Preserve disabled options/reasons, latest selected ID, stable picker identity/focus through updates, canonical inspector content, parent history and session target checks. No horizontal navigation overflow at 240px inspector width.
- Activity content is a labeled region, not a tabpanel referencing hidden tabs. Project keeps its existing tablist semantics and keyboard behavior. Switching destination restores appropriate control and content semantics. Disposal cleans listeners.

## Ownership

Sol worker owns only public/shell-workspace.mjs, public/shell-workspace.css and tests/browser/activity-section-picker.spec.mjs under pi-package-webui. Parent owns app integration if required, legacy browser fixture adaptation, cache/static assertions, inventory, docs, screenshots and this plan. No parallel shared writers. No backend, dependencies, user settings or feature removal.

## Checks and review

Worker: component browser checks for all groups, selection/callback, disabled options, unknown topic, keyboard/focus and update continuity, Project switch and empty catalog, widths240/320 and light/dark screenshots. Parent: actual app section switching, retained queues/events/usage state, Back/Forward, Project rollback and drafts; relevant existing tests and package coherence. Use disposable fake Pi settings and existing system Chromium; no installation/live config changes.

One fresh Sol/high read-only review after integration, optional second limited to accepted fixes. At most two rounds for this bounded repair. Shelf final review is separate and must not be restarted or expanded. Parent verifies and fixes findings. Archive after verified completion; update existing PR38 under prior authorization, no merge.

## Additional reported access regression: scoped models

User supplied the provider-grouped picker screenshot and reported its absence in compact UI. Parent repair adds a direct Scoped models button alongside Model, reusing the existing canonical picker. Full Model catalog remains accessible. Preserve saved flat/advanced layout, within-provider ordering, keyboard selection and Escape return to the actual opener, session-bound application and draft. Parent owns focused-composer-controls.mjs, focused-shell-adapter.mjs, app.js and focused-model-shortcuts.spec.mjs; no overlap with Activity worker. Combined review includes this bounded access repair; no backend or scope semantics change.

## Integration evidence

Sol worker `3866ef63` integrated as `2a7a1d93`, exactly three owned files, eleven component cases passed. Parent adapted existing Activity tab locators to select labels while retaining controller assertions; added two actual-app cases traversing every section, Back/Forward, no horizontal overflow, draft and Project rollback. Combined affected browser run: 74 passed, zero retries. The scoped picker initially exposed a capture-phase global Alt+Up collision with queue restore; parent excludes model options from that global branch. Four scoped actual-app cases passed after the correction, with draft/no-queue-warning assertions. Offline PWA179 passed. Whole-package check and round-one review remain pending.

## Review disposition

Sol round one reviewed b8d8fd1 and passed 40 independent browser cases. Accepted BUG-001: 24 static assertions retained app203 after the entry moved to app204. Parent corrected them in 2e9af8e; all 28 test cases across those 24 files passed (exit0, /tmp/activity-revision-fixes.log). No runtime finding remained. Final combined package verification is deferred until the concurrent Settings and composer changes are integrated; no second review round is needed for the literal assertion repair.
