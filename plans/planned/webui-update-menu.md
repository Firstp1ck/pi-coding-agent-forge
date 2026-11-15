# Sidebar update actions

Authorized 2026-11-15. Baseline 6c582291. Parent owns integration and acceptance. One Sol/high worker and one fresh reviewer for each task: A update commands, B menu. No extra review rounds. This remains complex because it crosses backend command execution and browser controls.

## Current contract

The user explicitly simplified the scope after work began: detect where WebUI is installed and run the matching update commands, with no additional version, ownership, idle or health checks. This supersedes the original native-job expansion in commit 3f43b45. The same running A worker was steered; no replacement or duplicate worker was launched.

Add an Update icon beside the retained sidebar Settings gear, reachable in Classic and focused navigation. Choices are `all` (Pi and extensions + WebUI), `webui` (WebUI only), and `pi` (Pi only). Show the commands, confirm, then show command output and exit results. Opening or cancelling the preview does not update packages.

Use PATH Pi without version/help/provenance gates. Pi-only runs `pi update`. Detect existing WebUI package manifests in `npm root -g` and the Pi agent's `npm/node_modules`. WebUI-only runs `npm update -g @firstpick/pi-package-webui` for its global installation and `pi update --extension npm:@firstpick/pi-package-webui` for its Pi-managed installation. Update each distinct installed location and report absent locations. Do not install missing copies or retry failed commands with alternate syntax. All runs `pi update --all` plus the separate global WebUI command, with Pi-managed WebUI already covered by --all. Run the global WebUI command before replacing Pi. No automatic restart; tell the user to restart WebUI to load updated code.

Keep normal localhost route authorization, fixed target/argv input validation, one command job at a time per server, bounded output and command timeout. These are execution mechanics, not eligibility preflights. No executable/context hashing, ownership checks, idle admission, effect-lock coordination, health probes or managed restart orchestration in this new flow. Preserve unrelated historical journal/recovery code instead of deleting records. Command exit status is the result; do not claim installed-version or post-update health verification.

No real package updates, installs, production configuration changes or merge during implementation/testing. All command tests use disposable fakes. No new dependencies expected.

## Ownership and integration

A worker owns new pi-package-webui/lib/package-updates.mjs and tests/package-updates.test.mjs, bin/pi-webui.mjs only update plan/apply/transaction/status routing, and lib/component-update-state.mjs validateUpdatePlanRequest only. May adjust previously assigned native update/API tests where the authorized route contract changes. No public files/docs/plans/package metadata/unrelated backend. Revert its unfinished original native-internals expansion. Ask before other file expansion. Handoff handoffs/update-menu-native.md.

B worker owns only new public/sidebar-update-menu.mjs, public/sidebar-update-menu.css and tests/browser/sidebar-update-menu.spec.mjs. API createSidebarUpdateMenu({button,onSelect}) returns update({busy=false,disabledReason='',statusText='',statusTone=''}), close({restoreFocus=true}={}), dispose(). Calls onSelect('all'|'webui'|'pi') once after closing. Owns themed popup, keyboard/focus/outside dismissal and viewport placement. No network or command behavior. Handoff handoffs/update-menu-ui.md.

Parent owns app.js, canonical button/index/cache/styles, Settings shortcuts as needed, actual-app tests, shared fixture migration, docs and inventory. Backend keeps the plan/apply/job-status shape used by existing browser code, with no misleading health/restart promises. Frontend progress covers all three choices and displays failures beside the action.

## Verification and completion

A tests both/either/neither WebUI installations, deduplication, fixed argv, all-mode avoiding duplicate Pi-managed update, no version gate, no busy-session preflight, normal missing-command and exit failures, bounded execution/output and duplicate-click prevention. B tests choices, disabled/status states, pointer/keyboard/focus, Classic/focused and narrow/dark/light geometry. Parent captures/inspects/shows actual-app screenshots and verifies cancel creates no apply, modes route correctly, progress/errors persist for the current server and no commands run in real installs.

One fresh A reviewer checks installation/command routing and HTTP ownership; one fresh B reviewer checks rendered menu and actual-app state. Parent dispositions and fixes findings. Run package check and affected browsers, assets/cache/payload and inventory. Keep legacy standalone tests if their modules are unchanged; update obsolete route assertions to the new explicit behavior. Final handoffs/update-menu-acceptance.html links this plan. Archive after verified completion; prior authorization permits updating PR38. No automatic dependency or live installation changes.
