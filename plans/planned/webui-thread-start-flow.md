# WebUI thread start flow

Authorized feature, 2026-11-15, branch `feat/webui-compact-workspace` (PR #38). Base: babf9b94. Classification: complex. It has two slices (visible rename, new start flow), touches server, markup, client and tests, and the start flow has ownership races already covered by the draft-conversation contract.

Integration owner: the parent Claude Opus session. Only the parent edits this plan, the docs, cache versions, the capability inventory, and pushes. Report: [pi-package-webui/reports/webui-thread-start-flow.html](../../pi-package-webui/reports/webui-thread-start-flow.html).

## Goal

Copy T3 Code's way of starting threads. A new thread starts as an empty draft in a chosen folder. No Pi process or tab exists until the first prompt. The user calls tabs and terminals "Threads".

T3 reference (user screenshots): sidebar compose icon, then a searchable project palette ("Current" first), "No project" allowed, an empty screen with a clickable project label that opens a searchable dropdown, and choosing a project there changes the folder without creating a thread. In the WebUI, folders replace projects.

## Approved decisions

1. Rename visible text only. Labels, titles, tooltips, aria text, placeholders, event log lines and default names say Thread/Threads. Internal identifiers, CSS classes, element IDs, API routes (`/api/tabs`), storage keys and saved data stay unchanged. No migration.
2. The sidebar `+ Tab ▾` menu becomes a single icon button (compose/pencil icon, aria-label "New thread"). Clicking it opens a searchable folder palette. Picking an entry opens an empty draft with that folder. Nothing is created until the first prompt.
3. The empty draft screen keeps the current "Start a conversation" card and its tiles. The Workspace value in the card's "Current" footer becomes a button that opens a searchable folder dropdown anchored to it. Choosing an entry only changes the draft's folder.
4. Process: Opus implementation workers (medium effort), Sol reviewers at high effort, at most two review rounds.

## Invariants (carried from the workspace-draft repair)

- Choosing or changing a folder never calls `POST /api/tabs`, starts Pi, or allocates a No Project directory.
- The first nonempty prompt creates exactly one thread in the draft's captured folder (or a No Project thread when the draft has no folder) and sends to that identity. Retry after failure must not allocate a second thread.
- A selection that resolves after the user navigated away or after first send still belongs to the opening draft and must not redirect text or touch another conversation.
- Draft text and folder survive navigation and reload (`draft-conversations.mjs`, version-1 reads stay compatible).
- Branch worktree stays eager: it creates a real tab, as today.
- Existing real-tab operations (split, resume, restore, workspace load, cwd change of a live tab) are unchanged.
- Visual design stays the same: existing tokens, colors, fonts, radii and the command-palette/menu styling. New UI reuses existing classes where possible.

## Scope

### W1: visible rename (Opus worker 1)

- `public/index.html`, `public/app.js`, `public/*.mjs` shell modules, `bin/pi-webui.mjs`.
- "Tab"/"Tabs"/"Terminal"/"Terminals" as the name of a Pi conversation becomes "Thread"/"Threads": e.g. "Close all Tabs" → "Close all Threads", "Pi terminal tabs" → "Pi threads", "Terminal navigation" → "Thread navigation", "Resize terminal sidebar width" → "Resize thread sidebar width", "created isolated terminal X" → "created thread X", tooltips such as "Captures all open tabs" → "open threads", palette placeholder "Search actions, tabs, …" → "threads".
- Server `defaultTabTitle` returns `Thread N` (the `options.name` override is unchanged). Client fallbacks `Terminal ${n}` become `Thread ${n}`.
- Legacy titles: the client displays a stored title that exactly matches `^Terminal (\d+)$` as `Thread $1`. It does not rewrite stored data. Custom titles are untouched.
- Do not rename text where "terminal" means something else: subagent "view only" terminal view may stay "Subagent" wording but its hint "send messages from the parent terminal" becomes "parent thread"; real shell terminals, `/webui-start` server-offline note ("existing Pi terminal" means the CLI), app runner terminals, and git/command output stay as they are. Worker lists every borderline string it left unchanged.
- Settings/visibility labels (`data-visibility-key` text shown in settings) follow the rename; keys stay.
- Update tests that assert renamed strings. Do not weaken assertions.

### W2: new thread start flow (Opus worker 2, after W1 is integrated)

- New pure module `public/workspace-choices.mjs`: builds and filters the folder choice list. Inputs: current folder (active tab cwd, or the last real tab's cwd when on a draft), pinned folders (path fast picks), recent folders (distinct cwds of open threads, most recent first), the draft's selected folder. Output entries, in order: "Current" folder (if any), "No project", pinned, recent, then actions "Browse…" and, in the palette only, "Branch worktree…". Dedupe by normalized path, cap the list (e.g. 12 folders), case-insensitive substring filter on label and path. Unit tests in `tests/workspace-choices.test.mjs`.
- Sidebar: replace the `+ Tab ▾` button and its menu with one icon button. Keep `id="newTabButton"` so mobile shell, keyboard and existing hooks keep working; remove the dropdown panel and its four items, and route callers (`mobileNewWorktreeButton`, command palette core items, keyboard handlers, focused-shell adapter) to the new palette or directly to `openBranchWorktreePicker()`. Add a "New thread" command-palette action.
- Folder palette: a `<dialog>` that reuses command-palette structure and classes (search input, listbox, hint row "↑↓ Navigate · Enter Select · Esc Close"), titled "New thread". Each row shows the folder name and path, with a "Current" or "Pinned" tag. Keyboard: arrows, Enter, Escape, Home/End. Choosing:
  - a folder → `openClientDraft()` then set that draft's cwd (same path as `chooseClientDraftWorkspace({ cwd })`), focus the composer;
  - "No project" → new draft with no cwd;
  - "Browse…" → close palette, open `pickCwd`, then as a folder;
  - "Branch worktree…" → `openBranchWorktreePicker()`.
  If the active view is already an empty draft with no text, reuse it instead of creating another draft.
- Card dropdown: in `renderEmptyStartState()` for drafts (`!tab`), render the footer Workspace value as a button (shows the path or "No Project", underline on hover like T3) with `aria-haspopup="listbox"`. It opens an anchored popover with the same list (no worktree entry), a search input, keyboard support, outside-click and Escape close, and focus return. Choosing an entry calls `chooseClientDraftWorkspace({ cwd })`, or clears the draft cwd for "No project" (add `draftConversations.setCwd(id, "")` support if missing). Real empty tabs keep the static value.
- Mobile: the mobile shell's new-thread entry opens the same palette; the popover fits a 360px viewport.
- Tests: extend `tests/browser/draft-conversations.spec.mjs` or add `tests/browser/thread-start-flow.spec.mjs` covering: palette opens from the sidebar button; choosing Current/pinned/No project/Browse produces a draft with the right folder and zero `POST /api/tabs`; card dropdown changes folder with zero `POST /api/tabs`; first prompt creates one thread in the chosen folder; dropdown selection during a pending first send does not redirect; keyboard navigation; Branch worktree still opens its picker. Update existing tests that used the removed menu items (`new-tab-hit-target`, `folder-picker-layout`, `mobile-foundation`, `ui-polish-*`, `terminal-cwd-grouping-static`, etc.).

## Non-goals

Renaming code or routes, server-side project registry, project icons/colors, Ctrl+digit shortcuts (browser-reserved), changing a live thread's folder from the card, changing the Branch worktree or Load workspace flows.

## Execution order

1. W1 worker (Opus) → handoff `handoffs/thread-rename-worker.md`, one commit.
2. Parent inspects W1 diff and evidence, runs focused tests.
3. W2 worker (Opus) on the W1 result → handoff `handoffs/thread-start-worker.md`, one commit.
4. Parent integration: cache bump (`CACHE_NAME` and app asset version, with the static tests that pin them), `scripts/overhaul-inventory.mjs` refresh, README/TECHNICAL/DEVELOPMENT and `docs/overhaul/implementation-record.md`, screenshots under `docs/overhaul/screenshots/thread-start/`, combined browser run, package run.
5. Review round 1: two fresh Sol/high reviewers in parallel (quorum), read-only, against this plan.
6. Parent verifies each finding, fixes accepted ones, revalidates.
7. Review round 2 (only if round 1 had accepted fixes): one fresh Sol/high reviewer checks only the fixes and regressions.
8. HTML report, archive plan, push.

## Worker rules

- Work in this worktree, one writer at a time. Stay inside the listed files plus the tests you must update. No style rewrite, no dependency or config changes, no cache/inventory/docs edits, no push, no child agents.
- Use disposable HOME/XDG/Pi settings, fake Pi and temporary folders, as in existing browser fixtures (`handoffs/run-ui-polish-command.sh`, `playwright.ui-polish.config.mjs` may be copied). A temporary symlink to `/home/firstpick/npm-packages/pi-package-webui/node_modules` is allowed; remove it before handoff. Never touch `~/.t3/userdata`, the user's real Pi settings, or a running preview.
- Apply the `code-quality` skill. Comments explain why, never what.
- Handoff file records: base and result commit, changed files, commands with exit codes, skipped checks, deviations, borderline decisions, risks.

## Acceptance checks

- `node --check` on changed JS, `git diff --check`.
- `node tests/run-all.mjs` (package suite) passes, or every failure is explained and passes in isolation.
- Focused Playwright specs for drafts, start flow, folder picker, mobile foundation and new-tab hit target pass in Chromium.
- Screenshots (desktop and 390px mobile): sidebar button, folder palette, card dropdown open, draft with selected folder. Inspected and shown to the user.
- No `Terminal N`, `+ Tab`, `Close all Tabs` text visible in the default desktop and mobile views.

## Rollback

Each worker produces one commit; parent integration is a separate commit. Revert W2 to restore the `+ Tab ▾` menu; revert W1 to restore the old wording. No data migration is involved.

## Risks

- `app.js` is about 51k lines; hidden callers of the removed menu items. Mitigation: grep for `newTab*` IDs and `setNewTabMenuOpen`, keep `newTabButton`.
- Rename false positives (shell terminals). Mitigation: worker's borderline list, reviewer check.
- Popover inside the chat card could be clipped by scroll containers. Mitigation: position it in a top-layer element or `position: fixed`.

## Progress record

- 2026-11-15: decisions approved by the user (rename visible text only, folder palette first, keep card with dropdown, Opus workers and Sol reviews, max two rounds). Plan written.
- W1 done (Opus/medium worker): commit 1df752cf, 41 files. `node tests/run-all.mjs` 262/262 files pass. Focused Chromium: 8 failures (mobile-foundation:761, control-deck-side-panels:179, overhaul-w7-accessibility:61/78/107/143, user-noticeable-fixes:96, windows-drive-parent:87), all reproduced by the worker on an untouched base copy, so pre-existing. Parent inspected the server diff and `threadDisplayTitle()`. Accepted worker wording choices: subagent open mode "Thread view", search keywords keep "tabs", an exact custom title "Terminal 7" displays as "Thread 7". Handoff: handoffs/thread-rename-worker.md.
