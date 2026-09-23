# Simplify Pi and WebUI updates

Status: blocked before implementation pending the decisions below and verification of delegated worker/reviewer capabilities. The current request authorizes plan revisions only.
Integration owner: this Pi session. Only the integration owner changes this plan or integrates handoffs.
Target: `pi-package-webui`
Report after completion: `../../reports/simplify-updates.html` (not yet created).

## Goal and acceptance

- Updating Pi from the WebUI launches the platform shell and runs `pi update`.
- Updating WebUI launches PowerShell on Windows or Bash on Linux. Update the npm-global installation using `npm update -g @firstpick/pi-package-webui`, the Pi-managed installation using the installed package's `pi update --extension <source>` form, and both when both are installed.
- Never silently update unrelated packages or run a duplicate update for the same installation. Show users which commands will run, signal shell-launch errors, and require a restart where applicable.
- Identify the selected Pi executable and every WebUI installation affected by the commands. Confirmation and version reporting must distinguish the active runtime from any separate PATH installation.
- Treat shell launch, command completion, update success, and restart readiness as different outcomes. Do not report success merely because a shell opened, or allow retries to race a still-running update.
- Preserve configured package pins and settings. Identify all affected Pi scopes before confirmation; report pinned or unsupported sources without silently unpinning them or claiming an update occurred.
- Preserve localhost-only mutation authorization; remote clients must not launch shell commands. Do not run actual updates during tests.
- Remove superseded exact-target staging, managed runtime switching, and rollback claims only after identifying all remaining consumers and a safe transition for existing managed-runtime pointers.

## Classification and evidence

Complex feature. It changes user-visible update behavior across `bin/pi-webui.mjs` (update routes, owner detection, execution, activation), `bin/pi-webui-launcher.mjs` and `index.ts` (different entry points), `public/app.js` (update UI), update modules, tests, and README/TECHNICAL/DEVELOPMENT documentation. Shell launch and installing over running code introduce security and reliability risk. The preliminary complex classification stands; no contrary evidence was found.

## Decisions and open questions

- Approved by request: use npm-global update for a global CLI installation, targeted Pi package update for a Pi installation, update both if present, and use `pi update` for Pi itself; use PowerShell on Windows and Bash on Linux.
- Invariant: do not pass user-controlled command strings to a shell; allow only fixed update targets. Never execute update commands as part of inspection or tests.
- Open: precise meaning of 'open a shell' for a detached `/webui-start` server or a headless Linux session; availability/error handling when no desktop terminal exists. Establish this before implementation.
- Open: existing managed-runtime pointers can override the package code loaded by `pi-webui`. Define non-destructive migration/compatibility behavior before removing the supervisor.
- Verified against the installed Pi CLI documentation and implementation: `pi update` defaults to updating Pi itself, and `pi update --extension <source>` is a supported targeted package-update alias. Use the configured source, typically `npm:@firstpick/pi-package-webui`; the supported Pi versions and settings-discovery behavior still need confirmation before coding.
- Resolve findings F1 through F3 below before implementation. F4 defines the corrected ownership boundary; record the exact test-file assignments before launching workers.
- Deferred: publishing, installing packages, executing live updates, and destructive cleanup are not authorized by this request.

## Review findings

### F1, high priority: bind the command to the intended Pi installation

`lib/update/resolver.mjs` selects an explicit `--pi` executable first, otherwise bundled Pi before PATH Pi. `bin/pi-webui.mjs` uses that identity for both tabs and update-version reporting. A bare `pi update` in a new shell can update a different installation while the WebUI continues to use and report the old one.

Required decision: specify whether the Pi update control targets PATH Pi or the active runtime, including explicit and bundled cases. Define how the shell resolves the selected executable and how the UI reports an active runtime left unchanged. Bind command execution to the confirmed working directory, agent directory, and npm prefix where applicable; shell startup must not silently select a different installation. Do not change runtime selection implicitly as part of this simplification.

### F2, high priority: define the detached update lifetime

The current updater holds an install lock through execution and transfers ownership to the activation process when needed, in `lib/update/journal.mjs` and `bin/pi-webui.mjs`. A desktop terminal can outlive the HTTP request or its launcher process. Launch success therefore proves neither command completion nor that it is safe to retry or restart.

Required decision: define completion observation, duplicate-request exclusion across browser tabs and server restarts, recovery after the terminal closes or the server exits, and when restart becomes safe. For both-installed updates, define command ordering and partial-failure reporting. If completion cannot be observed, expose that limitation and a safe recovery path instead of guessing success or automatically releasing exclusion when the terminal launcher exits.

### F3, medium priority: define Pi-managed scope and pinned-source behavior

The installed Pi package manager's `update(source)` matches package identity across both user and trusted project settings. One targeted command can therefore affect more than one installation. Its update path also skips exact-version npm pins and local sources, so a successful command exit does not necessarily mean WebUI changed.

Required decision: specify which Pi-managed scopes the control supports and how it discovers their configured sources and installation roots. Preview every affected installation, preserve pins, and deduplicate commands by their actual affected roots rather than declaration count. Refuse or provide manual guidance when the requested scope cannot be isolated safely. Cover user/project declarations, custom agent directories, pinned versions, local sources, and linked installations without adding broad package updates.

### F4, medium priority: assign shared consumers outside the update directory

The original worker boundaries omitted `index.ts`, `lib/component-update-state.mjs`, `lib/update-commands.mjs`, and update-related `package.json` scripts. These are existing consumers or contracts of the updater. In particular, `index.ts` imports `createRestoreFile` from `lib/update/supervisor.mjs` for ordinary WebUI restarts, and package checks reference the update supervisor executable.

Worker A owns these update-related changes as specified below. Preserve or relocate shared startup and tab-restoration helpers before removing obsolete supervisor code. Do not delete the update directory merely because managed activation is retired. Any additional shared-file changes require an explicit ownership assignment by the integration owner.

## Dependency order and workstream ownership

1. Resolve open decisions and findings F1 through F3, confirm supported Pi CLI semantics, and verify the required delegated capabilities. Record the chosen runtime, scope, shell-lifetime, and migration contracts plus exact test-file ownership before implementation. Establish a static baseline of the current update routes, package detection, and launcher pointer behavior.
2. Worker A, server/launcher owner: implement fixed-command shell launch, install detection, and the agreed update-lifetime contract; retire obsolete update execution/managed activation without breaking startup or tab restoration. Own update-related changes in `bin/`, `lib/update/`, `index.ts`, `lib/component-update-state.mjs`, `lib/update-commands.mjs`, `package.json` check scripts, and assigned server/launcher tests. No dependency changes or version bumps are included. Handoff: `handoffs/simplify-updates/server.md`.
3. Worker B, UI/docs owner: align browser flow, affected-installation confirmation, truthful launch/completion/partial-failure status, restart instructions, and documentation, with assigned UI tests. Own `public/`, `README.md`, `TECHNICAL.md`, `DEVELOPMENT.md`, and those UI tests. Handoff: `handoffs/simplify-updates/ui.md`. Start only after worker A has finished and its handoff has been inspected, so the API contract is stable and there is one writer in the shared working tree.
4. Integration owner examines both diffs and handoffs, runs affected and cross-workstream checks, then obtains two distinct fresh-context read-only reviewer runs; disposition findings, fix accepted findings, revalidate, and create `reports/simplify-updates.html` linked both ways.

Each handoff must record run identity/status, changed files, commands and exit codes, omitted tests, deviations, unresolved decisions, risks, and integration notes. Workers do not update this plan or overlap ownership.

## Validation and rollback

- Test global-only, Pi-only, both-installed, neither-installed, Windows PowerShell, Linux Bash, denied remote request, shell absence, launch failure, and repeated request. Stub process launches and package probes; do not touch real global/npm/Pi installs.
- F1: test distinct bundled, PATH, and explicit Pi installations, missing PATH Pi, and shell startup that changes command lookup. Assert that the confirmed executable, affected installation, working directory, agent directory, and npm prefix match execution and version reporting.
- F2: test simultaneous requests from separate browser tabs, a terminal launcher exiting before its update child, server restart during an update, terminal cancellation, command failure, and one of two installation updates failing. Assert that shell launch is not reported as update success, duplicate updates remain excluded for the agreed lifetime, and restart cannot race an active install.
- F3: test matching user and trusted project declarations, untrusted project settings, custom agent directories, pinned npm versions, local sources, and linked or aliased installation roots. Assert exact affected scopes, no duplicate mutation, no settings/pin rewriting, no unrelated package update, and truthful no-op/refusal reporting.
- F4 and migration: test CLI and `/webui-start` startup, ordinary restart/tab restoration, existing current/previous managed-runtime pointers, and the agreed migration path. Check all retained imports and package check-script targets after removing obsolete code.
- Run focused update/API/UI tests, including the component-update and reconnect browser tests, `npm test`, `npm run check`, and `git diff --check` from the package; record commands, exit codes, baseline failures, and tests not run. The browser suite is separate from `npm test` and `npm run check`.
- Review baseline: `node tests/update-resolver.test.mjs`, `node tests/update-owners.test.mjs`, and `node tests/update-package-layout.test.mjs` passed against the existing implementation. Full package and browser suites were not run during the plan review; these baseline passes do not validate the proposed behavior.
- Roll back only the bounded update-flow changes if installation detection, startup, or security checks fail. Keep existing installed package settings and prior managed runtime state intact until a verified migration path exists.

## Gate and progress

- [x] Inspect repository update paths and classify the change.
- [x] Record the four review findings and correct worker ownership.
- [ ] Resolve shell semantics, Pi runtime identity, Pi-managed scopes, detached-update lifetime, and managed-runtime migration.
- [ ] Obtain two distinct implementation-worker outcomes and integrate both.
- [ ] Validate integrated behavior and obtain two independent read-only reviews with finding dispositions.
- [ ] Revalidate accepted fixes and deliver a self-contained HTML report linked here.

The original drafting session reported unavailable delegated-worker/reviewer capabilities. Recheck executable roles in the implementation session rather than treating that historical blocker as current capability evidence. No implementation, worker outcomes, independent reviewer runs, or completion report have been delivered; only the baseline checks above have run. Do not silently replace the delegated gates with main-agent self-review. If those capabilities remain unavailable, request an explicit scoped waiver or approved alternative before implementation and record it here if granted. The current plan-update request does not grant such a waiver or authorize implementation.
