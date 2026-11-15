# Workspace selection before first prompt

Authorized bug repair, 2026-11-15. Parent base d29594ea. One Sol/high implementation worker, then one fresh Sol/high reviewer. Parent owns integration and any supported review fixes; no extra review rounds.

## Contract

On an empty No Project/client-draft conversation, Open workspace and its recent-workspace shortcuts select a folder without creating a Pi terminal, process or new No Project directory. The selected folder is visible in the empty screen. First nonempty prompt creates one real project terminal using the selected cwd and dispatches to that captured identity. Changing destination while selection or creation is pending cannot redirect text or steal another conversation. Preserve typed text and the selected folder when leaving and reopening a saved browser Draft, including browser reload. Drafts remain un-settleable. Creation/send failure preserves recovery and does not silently allocate another terminal on retry.

Use the existing draft-conversations store and promotion flow, adding an optional bounded cwd to draft records with backward-compatible version-1 reads. Blank selection may remain browser-local without adding an Inbox terminal until text is saved or submitted. Selecting a folder from the empty screen must retain the current draft's text. Keep explicit existing real-session workspace operations, split, resume, restore and worktree behavior intact. Open workspace from the empty client screen and recent-workspace shortcuts must share the deferred path. Other createTerminalTab callers remain eager unless the worker reports a requirement for parent disposition.

Path fast-pick save must succeed with zero tabs. Folder creation in that same empty picker must also work. Preserve validation, containment and existing authorization/Natural Conversation restrictions whenever a real tab is supplied or selected. Explicit stale/unknown tab IDs must still fail rather than falling back. Do not create a tab merely to satisfy either shared folder route.

## Worker ownership

Owned source: pi-package-webui/public/app.js, public/draft-conversations.mjs and bin/pi-webui.mjs. Owned tests: tests/draft-conversations.test.mjs; existing browser draft-conversations, empty-startup and folder-picker tests/fixtures as necessary; new tests/browser/workspace-draft-selection.spec.mjs and new tests/workspace-draft-routes.test.mjs if needed. All paths relative to pi-package-webui. Report exact altered test paths. No styles, index/service-worker assets, dependency/config changes, documentation or shared plan edits. Parent handles cache, docs, inventory and integration.

Inspect current code before writing. Apply code-quality. Use disposable HOME/XDG/Pi/npm settings, fake Pi and temporary repositories only. Existing parent handoffs/run-ui-polish-command.sh and playwright.ui-polish.config.mjs may be copied. A temporary dependency symlink to /home/firstpick/npm-packages/pi-package-webui/node_modules is allowed; remove only your symlink before handoff. No real providers, installations, updates, user-directory mutations, live preview restart, push or children.

Deliver owned commit and ignored handoffs/workspace-draft-worker.md with base/result, APIs/metadata, exact commands/exits, screenshots, omissions and risks. Verify zero-tab pin/unpin persistence without warnings; empty-folder choice produces no POST tabs/child; text/folder survive navigation and reload; first prompt creates once in the selected folder; selection cancellation and delayed selection/creation preserve owners; existing No Project allocation remains separate and correct. Exercise directory creation without a tab plus explicit invalid-tab and Natural Conversation restrictions using bounded fixtures. Capture/inspect screenshots of selected workspace before first send and saved Draft. Run focused tests and syntax/diff checks. Escalate before unrelated writes or behavior expansion.

## Evidence and disposition

User reported path-fast-picks POST throwing No Pi tabs are available at getRequestedTab, then Open workspace immediately created a terminal. Source confirms mandatory getRequestedTab in shared preference POST and eager createTerminalTabFromChosenDirectory from the empty-screen action. Parent will verify the integrated candidate, record reviewer findings individually, fix accepted defects, update cache/inventory/docs, archive this plan and push PR38. Full-suite omissions and live-provider limits must be stated.

## Integration

Worker 479c4aaa changes only three approved source files and two tests. Parent inspected the diff and exact handoff. Optional cwd is backward-compatible and bounded; no dependency changes. Worker passed 54 unit cases, 43 browser/API cases and the direct/supervised No Project HTTP lifecycle harness. Parent owns combined verification and one fresh review.
