# Sidebar update actions

Authorized 2026-11-15. Baseline6c582291. Parent owns integration, review dispositions and acceptance. Use Sol/high with one isolated implementation worker and one fresh reviewer for each of two tasks: native update behavior and menu presentation. No extra review rounds. This is complex because combined native updates cross executable discovery, durable job/restart contracts and browser controls.

## Outcomes and decisions

Add an Update icon beside the retained sidebar Settings gear, reachable in Classic and focused navigation. Its menu offers `all` (Pi and extensions + WebUI), `webui` (WebUI only), and `pi` (Pi only). Explain each scope, preserve keyboard/focus/outside dismissal and narrow-screen reachability. Selecting prepares an exact installation/command preview; only its explicit existing confirmation launches a job. Cancelling or merely opening the menu makes no package changes. Reuse canonical update machinery and expose progress/errors/recovery.

Pi-only uses verified PATH Pi `update`. WebUI-only discovers existing npm-global and Pi user npm-managed installations, updates each eligible distinct root, and preserves manual guidance for unproven/linked/pinned/project sources. Either equivalent targeted Pi syntax is acceptable; use one verified form, not fallbacks after arbitrary command failures. Installed Pi1.5.2 docs/cli.md establishes `update`, `update --all`, `update <source>` and `--extension <source>` alias. Existing resolver only accepts0.87.1 and needs compatible discovery. Use bounded read-only version/help capability probes with npm ownership/shim checks; do not blindly trust all versions or drop provenance checks. Support verified0.87.1 behavior and1.5.2 at minimum.

All mode runs Pi plus user extensions via `pi update --all --no-approve` and updates detected separate npm-global WebUI. Pi-managed WebUI is covered by the all-extensions command; avoid duplicate update commands and retain explicit before/after installation verification for active WebUI. Run commands in an order that does not knowingly reuse a replaced Pi driver. Include npm-prefix and agent/package effect roots in update exclusion; retain context/digest binding, local-only authorization, idle admission, bounded logs, durable receipts, partial/unknown outcomes, restart only after verified active health, and failed/ambiguous retry fences. Project-local trust stays excluded as in existing native updates; preview states that scope. No fallback installs or automatic elevation. Missing/unproven targets are reported explicitly, not treated as successful updates.

No actual installed package updates, network package installs, production configuration changes, deployment or merge during implementation/testing. Disposable fixture scripts simulate commands and filesystem effects. No new dependencies expected.

## DAG and exact ownership

A native worker: pi-package-webui/lib/update/{path-pi,native-targets,native-jobs,discovery,verification,coordination}.mjs as required; lib/update-commands.mjs; bin/pi-webui.mjs ONLY native-update context/plan/apply/status/routes; bin/pi-webui-native-update-runner.mjs and bin/pi-webui-update-context.mjs as required; existing tests/{native-update-*,update-commands,update-api-harness,component-update-api-static}.test.mjs and new tests/native-update-all.test.mjs. No public files, docs, plans, package metadata or unrelated backend seams. Escalate outside ownership. Handoff handoffs/update-menu-native.md.

B menu worker in parallel: new public/sidebar-update-menu.mjs, public/sidebar-update-menu.css, tests/browser/sidebar-update-menu.spec.mjs only. API createSidebarUpdateMenu({button,onSelect}), returns {update({busy=false,disabledReason='',statusText='',statusTone=''}),close({restoreFocus=true}={}),dispose()}. Call onSelect('all'|'webui'|'pi') once after closing. Parent supplies canonical button; controller owns themed popup and accessibility, no network/install behavior. Presentation tests verify all actions and status/error states, focus, Escape/outside click, light/dark and narrow geometry. Handoff handoffs/update-menu-ui.md.

Parent integrates A/B; owns app.js update-status/three-mode routing, index button/style/module/cache wiring, Settings shortcuts if needed, shared fixture migrations, real-app menu tests, docs and inventory. Then one reviewer per task examines integrated candidate: A command/effect/restart ownership; B menu and actual UI action/status behavior. Parent verifies/fixes findings without extra reviews.

## Acceptance and rollback

Native tests cover current/legacy capability discovery; installed both/either/neither WebUI locations; deduplication and no installation of missing copies; command order; all-mode extension effects/active WebUI verification; cancellation/stale plans, permissions, failed/partial/unknown and restart recovery. Browser tests use fake Pi with isolated HOME/XDG/Pi/npm/Git, system Chromium, no unasked preview tools. Capture/inspect/show rendered screenshots. Run full package check once integrated plus affected browsers, cache/pack payload and inventory. Existing commands/session lifetimes remain intact. No shared remote contract changes without remote companion check.

Rollback removes UI shortcut/new plan creation while retaining durable job records and recovery; never replay or delete uncertain jobs. Final self-contained handoffs/update-menu-acceptance.html links this plan. Archive only after verified completion. Provider choice remains user-selected Sol. No real update execution is authorized by this feature implementation.

## Progress

Plan seeded before writers. Existing update flow has pi/webui modes, confirmed plans, fixed argv, effect locks and status dialogs; native version gate is obsolete for installed Pi1.5.2. No new scope questions remain. Prior PR authorization permits updating PR38 after acceptance.
