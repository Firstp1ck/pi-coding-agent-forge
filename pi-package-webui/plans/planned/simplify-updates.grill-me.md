# Grill Me results: simplify Pi and WebUI updates

Interview date: 2026-09-23.

[Implementation plan](simplify-updates.md)

## Shared understanding

The design interview is complete. No user decision remains postponed. Implementation and live updates are not authorized by this interview.

Use separate Pi and WebUI update buttons. Run native update commands in background PowerShell on Windows and Bash on Linux. Show command output/status and a small loading indicator in WebUI, backed by persistent job tracking that survives reconnects and server restarts.

Both Pi commands use the verified PATH Pi, not silently the bundled or explicitly selected runtime. WebUI updates cover proven npm-global and Pi user-managed installations only. Project installations stay manual. Automatically restart successfully changed, healthy active components once all commands finish and affected work is idle. Automatically migrate old managed runtimes only after validation, without downgrading or deleting recovery data.

Questions 3 and 4 were open after the first round. Questions 14 and 13 resolved them. Their original answers and historical statuses remain below; they are not outstanding decisions.

## Agreed decisions

1. Provide separate Pi and WebUI actions. Remove the combined action and its optional-companion updates.
2. Update only the verified PATH Pi with `pi update`. Preview and bind the exact executable, installation, environment, working directory, and npm prefix where relevant. A different active bundled or explicit Pi remains unchanged; do not change runtime selection.
3. Launch background PowerShell on Windows and Bash on Linux. No desktop terminal is required. Show bounded, sanitized output/status with a small spinner, not invented percentage progress.
4. Keep persistent job identity, per-command results, and exclusion against overlapping updates across browser reconnects and server restarts. Resume observation of the same job. Missing completion evidence means status unknown, not success or permission to retry/restart.
5. Update proven npm-global WebUI with `npm -g update @firstpick/pi-package-webui`. Update proven Pi user-managed WebUI with `pi update --extension npm:@firstpick/pi-package-webui --no-approve`, using the configured npm source when it includes a range or tag. The bare scoped name is not an npm source in inspected Pi 0.87.1.
6. Preserve the configured agent directory, including `PI_CODING_AGENT_DIR`. Explicitly exclude project settings. Do not grant trust or rewrite settings and pins.
7. Support known npm WebUI sources only. Honor ranges and skip exact pins. Provide manual guidance for project, Git, local, linked, unsupported-manager, or unproven installations. Deduplicate actual affected roots. Do not deliberately update unrelated packages.
8. Use verified PATH Pi for the targeted WebUI update too. Missing or incompatible PATH Pi does not authorize fallback to bundled/explicit Pi or a broad extension update. An independently supported npm-global update may still proceed.
9. Attempt eligible WebUI installations sequentially. After one failure, attempt the other when it remains safely identifiable. Report per-installation outcomes and partial success; do not automatically roll back successful native updates.
10. Require affected known Pi tabs and managed jobs to be idle before mutation. Prevent new affected work from racing the update/restart. Do not terminate or claim control over unrelated external sessions.
11. After all commands finish, automatically restart/reload successfully changed, healthy active components once idle, even if another installation failed. Do not automatically restart unchanged, failed, unverified, or unowned external processes. Keep partial failure visible after reconnect.
12. Use native package-manager lifecycle-script behavior, honor existing user configuration, and warn before execution. Do not automatically elevate permissions.
13. Automatically migrate legacy pointers only to a validated, compatible, equal-or-newer installed WebUI. Retain old runtimes and pointer backups. Failed validation, incompatibility, or a downgrade retains the legacy launch path with manual guidance. No destructive cleanup.
14. Preserve localhost-only mutation authorization, fixed validated targets and commands, and affected-installation confirmation. Distinguish launch, completion, verified success, and restart readiness. Tests must not execute actual updates.
15. Worker and reviewer roles are discoverable now. Actual provider execution and the plan's required worker/reviewer outcomes remain unverified. No implementation or review waiver was granted.

## Questions and answers

The question and recommendation text below records what was shown, including recommendations the user declined.

### 1. Pi installation

Question: Which Pi installation should the Pi update button target? Recommendation: the active runtime, but only when its own update command is proven to update that installation. Bundled Pi should instead get WebUI-update guidance, not silently update a different global Pi.

Recommended answer: The active runtime, but only when its own update command is proven to update that installation. Bundled Pi should instead get WebUI-update guidance, not silently update a different global Pi.

User answer: PATH Pi only, clearly labeled.

Status: resolved. Bind execution to PATH Pi; distinguish it from the active runtime.

### 2. Shell and headless hosts

Question: What should 'open a shell' mean? Recommendation: open a visible host terminal running PowerShell or Bash; when no desktop terminal is available, show manual commands without launching a hidden update. This keeps the behavior close to the original request.

Recommended answer: Open a visible host terminal running PowerShell or Bash; when no desktop terminal is available, show manual commands without launching a hidden update. This keeps the behavior close to the original request.

User answer: Background shell with output and status in WebUI.

Status: resolved. A desktop terminal is not required.

### 3. Update lifetime

Question: How much update tracking should survive the simplification? Recommendation: keep a small durable job record, completion receipts, and cross-process exclusion. Remove staging and activation, but retain truthful status across terminal closure and server restart.

Recommended answer: Keep a small durable job record, completion receipts, and cross-process exclusion. Remove staging and activation, but retain truthful status across terminal closure and server restart.

User answer, Other: show a small update progress loading, until updates are done.

Status at recording: open. Resolved by question 14.

### 4. Pi package scopes

Question: Which Pi-managed installations should a WebUI update cover? Recommendation: the configured user scope plus the active tab's already-trusted project, all previewed together. Pi's targeted command can update both; do not scan unrelated projects or grant trust automatically.

Recommended answer: The configured user scope plus the active tab's already-trusted project, all previewed together. Pi's targeted command can update both; do not scan unrelated projects or grant trust automatically.

User answer, Other: update with "npm -g update @firstpick/pi-package-webui" and via "pi update --extension @firstpick/pi-package-webui"

Status at recording: open. Source spelling was established in question 12; question 13 resolved scope.

### 5. Supported package sources

Question: Which Pi-managed WebUI sources should support automatic updates? Recommendation: known npm WebUI sources only, honoring configured ranges and skipping exact pins. Git, local, linked, or unproven installations receive manual guidance to keep detection narrow.

Recommended answer: Known npm WebUI sources only, honoring configured ranges and skipping exact pins. Git, local, linked, or unproven installations receive manual guidance to keep detection narrow.

User answer: Known npm WebUI sources only.

Status: resolved.

### 6. Existing managed runtimes

Question: How should existing managed-runtime pointers be retired? Recommendation: require an explicit migration confirmation, validate the installed replacement, back up pointer state, then switch without deleting old runtimes. Silently ignoring pointers could change versions or break startup.

Recommended answer: Require an explicit migration confirmation, validate the installed replacement, back up pointer state, then switch without deleting old runtimes. Silently ignoring pointers could change versions or break startup.

User answer, Other: Automatic migration after validation.

Status: resolved. Question 17 adds downgrade and recovery conditions.

### 7. Partial failures

Question: If both npm-global and Pi-managed WebUI installations are present and one update fails, should the other still be attempted? Recommendation: attempt both sequentially when their targets remain safely identifiable, report each result, and never roll back a successful native package update automatically.

Recommended answer: Attempt both sequentially when their targets remain safely identifiable, report each result, and never roll back a successful native package update automatically.

User answer: Attempt the other installation and report partial success.

Status: resolved.

### 8. Updates during active work

Question: Should in-place updates be allowed while known Pi tabs or managed jobs are working? Recommendation: block updates that affect their installation until that work is idle. Native updates replace files in use, unlike the current side-by-side updater.

Recommended answer: Block updates that affect their installation until that work is idle. Native updates replace files in use, unlike the current side-by-side updater.

User answer: Require affected known work to be idle.

Status: resolved.

### 9. Restart after updates

Question: Who should initiate restart after an update finishes? Recommendation: show a separate Restart/Reload action only after completion is verified, and explain which WebUI or Pi processes still run old code. Do not interrupt sessions automatically.

Recommended answer: Show a separate Restart/Reload action only after completion is verified, and explain which WebUI or Pi processes still run old code. Do not interrupt sessions automatically.

User answer: Automatically restart affected components once idle.

Status: resolved. Question 16 establishes partial-failure behavior.

### 10. Package install scripts

Question: The old WebUI staging command suppresses package lifecycle scripts; normal native update commands may run them. Which policy should replace it? Recommendation: use normal package-manager behavior and honor existing user configuration, with a clear warning before execution. This avoids silently changing how standard updates work.

Recommended answer: Use normal package-manager behavior and honor existing user configuration, with a clear warning before execution. This avoids silently changing how standard updates work.

User answer: Use native package-manager behavior with a visible warning.

Status: resolved. No automatic elevation or live update is authorized by this interview.

### 11. Combined update control

Question: Should the existing combined update action remain? Recommendation: keep it but label it 'Update Pi and WebUI' and restrict it to those confirmed installations. Optional companion packages must no longer be swept into it.

Recommended answer: Keep it but label it 'Update Pi and WebUI' and restrict it to those confirmed installations. Optional companion packages must no longer be swept into it.

User answer: Offer separate Pi and WebUI actions only.

Status: resolved.

### 12. Discovered command syntax

Question: What source spelling must the Pi-managed WebUI update command use with the inspected Pi CLI?

Recommended answer: Use the configured npm source, normally npm:@firstpick/pi-package-webui, rather than a bare scoped npm name.

Discovered answer: Discovered from installed Pi 0.87.1: parseSource recognizes npm sources only with the npm: prefix, and --extension forwards its source unchanged to identity matching. Use pi update --extension npm:@firstpick/pi-package-webui, preserving any configured source specification; exact npm pins remain skipped.

Status: resolved from code, not a user choice. Evidence: installed Pi `dist/core/package-manager.js`, `parseSource` and `update`; `dist/package-manager-cli.js`, targeted source parsing and execution. No update was executed.

### 13. Project scope

Question: The two commands are settled; which Pi settings should the package update affect? Recommendation: user scope only for this simple app-wide flow, with project settings explicitly excluded. Otherwise the same targeted command can also update a project installation depending on its working directory.

Recommended answer: User scope only for this simple app-wide flow, with project settings explicitly excluded. Otherwise the same targeted command can also update a project installation depending on its working directory.

User clarification request: what do you mean which settings?

Clarification given: Settings means Pi's package installation declarations, not changing preferences. User settings list the Pi user installation; a repository's `.pi/settings.json` can list a separate project installation. A targeted update in a trusted project can affect both. The recommendation was npm-global plus Pi user-managed WebUI, leaving project copies alone and preserving settings/pins. The same questionnaire was resumed with its exact ID and revision.

User answer: Pi user installation only; project installations stay manual.

Status: resolved. Resolves question 4.

### 14. Loading and recovery

Question: What should happen to the loading indicator if the browser reconnects or WebUI restarts during an update? Recommendation: resume the same tracked job, retain its result, and prevent another update from starting. If completion cannot be established, show 'status unknown' and require safe recovery rather than guessing.

Recommended answer: Resume the same tracked job, retain its result, and prevent another update from starting. If completion cannot be established, show 'status unknown' and require safe recovery rather than guessing.

User answer: Small spinner backed by persistent, reconnectable job status.

Status: resolved. Resolves question 3.

### 15. Pi command for WebUI updates

Question: Which Pi executable should run the targeted WebUI package update? Recommendation: use the same verified PATH Pi as the Pi update button. If it is missing or incompatible, give manual guidance for the Pi-managed installation while still allowing an independently verified npm-global update.

Recommended answer: Use the same verified PATH Pi as the Pi update button. If it is missing or incompatible, give manual guidance for the Pi-managed installation while still allowing an independently verified npm-global update.

User answer: Use PATH Pi only; no silent fallback.

Status: resolved.

### 16. Restart after partial success

Question: If one WebUI installation updates successfully and the other fails, when should automatic restart happen? Recommendation: after all commands finish, restart only successfully updated, healthy active components once idle. If the active installation failed verification, keep automatic restart blocked and show repair guidance.

Recommended answer: After all commands finish, restart only successfully updated, healthy active components once idle. If the active installation failed verification, keep automatic restart blocked and show repair guidance.

User answer: Restart verified successful active components despite other failures.

Status: resolved. Keep the overall partial failure visible.

### 17. Migration version safety

Question: For the automatic validated migration you chose, may an older installed WebUI replace a newer managed runtime? Recommendation: never downgrade automatically. Migrate only to an equal-or-newer compatible installation, retain old runtime and pointer backups, and keep the old launch path if validation fails.

Recommended answer: Never downgrade automatically. Migrate only to an equal-or-newer compatible installation, retain old runtime and pointer backups, and keep the old launch path if validation fails.

User answer: No automatic downgrade; retain recovery files and old runtime.

Status: resolved.

## Evidence and remaining implementation risks

- `lib/update/resolver.mjs` currently selects explicit Pi, then bundled Pi, then PATH Pi. Updating PATH must not be reported as changing a different active runtime.
- `package.json` declares Pi `^0.87.0`; installed Pi 0.87.1 was inspected. Verify supported-version semantics, `--no-approve`, custom npm-command settings, and affected-root resolution before enabling commands. Do not assume older versions mean the same thing by `pi update`.
- Installed Pi's package manager matches npm identity across user and trusted-project declarations, skips exact pins, and ignores local sources during updates. Its CLI can print an update message without proving a version changed. Verify installed versions independently.
- Native updates may change the selected package's dependency tree and execute lifecycle scripts. They are not atomic and provide no automatic rollback guarantee. Do not intentionally include unrelated top-level packages.
- Persistent jobs must remain observable if the server package is overwritten. Implement and test process ownership, completion receipts, cross-instance locks on affected installations, and conservative crash recovery. An HTTP request ending or a parent process exiting does not prove installation finished.
- `bin/pi-webui-launcher.mjs` honors legacy pointers before starting the server. Migration must be reachable from the updated bootstrap, not only from new server code that an old pointer might bypass.
- `index.ts` imports `createRestoreFile` from the update supervisor for ordinary restart. Preserve startup and tab restoration when retiring activation code.
- Ordinary WebUI restart can preserve Pi processes. Updating Pi or bundled dependencies may require reloading affected idle tabs separately, while preserving sessions. Do not restart unchanged or unowned external processes.
- Worker/reviewer discovery succeeded; authentication, provider availability, child execution, implementation, full tests, two independent reviews, and the HTML completion report have not been demonstrated by this interview.

## Next step

No further user decision is identified. Review the aligned plan and authorize implementation separately. Then verify execution capabilities, establish baselines, implement the bounded workstreams, validate the integrated result, and complete independent review/report gates.

## Recording and save status

Both completed questionnaire rounds were recorded once with `grill_record_turns`, preserving answer order and all Other text. One code-established decision was recorded separately. The 17 records are retained in project interview state.

`grill_save_results` was called with the completed shared understanding, decisions, risks, and this project-relative output path. It failed with `Refusing to write outside project directory`. Inspection found a Windows separator bug in `safeOutputPath`: native `resolve` produces backslashes, but the descendant check appends `/` to the root. The same completed results were saved to this in-project Markdown file with the normal write tool. The extension and its path guard were not modified.
