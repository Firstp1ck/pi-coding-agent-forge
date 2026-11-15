# Update feedback repairs

Authorized 2026-11-15. Base 06cd8c8e. Bug fixes and interaction simplification, not a new updater architecture. One Sol/high implementation worker and one fresh Sol/high reviewer for this cohesive UI task. Parent owns diagnosis, integration, cache/inventory/docs and finding disposition.

## Contract

Selecting any update scope starts discovery and applies its valid plan once, without a confirmation dialog. Preserve validation, localhost authorization, concurrency and uncertain-outcome protections. Add no version, ownership, health or writable-location eligibility checks. No actual installed updates during testing.

Details must show the selected job's commands, per-step outcomes and bounded output rather than reopening update choices. Provide Back to progress and sensible Escape/focus return. Keep polling active and preserve job identity while details are open. New snapshots must not reset the user's details choice; selecting a later job must not leak prior output. The Updates button still opens scope choices, with an explicit route back to current progress where applicable.

Already up to date must be minimal: heading, component name, Details and Dismiss. Hide repeated status prose, command output, step counts, elapsed time and completed bar in its compact card. Keep those facts available in Details. Avoid duplicate failure logs in the compact card; show a concise result with detailed output only in Details. EROFS command failures should explain that the installation is read-only and the update must run outside the preview/sandbox. Derive this message from an actual failed receipt, without a preflight check or retry.

## Isolation diagnosis

The existing preview script uses bwrap --ro-bind / / and makes only its temporary directory and runtime state writable. Pi-managed resources are copied there; npm-global discovery points at the real read-only installation. The user's extension update changed the disposable copy, while global WebUI rename returned EROFS. Preserve this isolation and current configuration. Do not mount the real npm prefix writable or run actual updates. Advise updating the installed package from a normal terminal outside the preview. No backend command changes are required.

## Worker ownership

Worker may edit public/app.js, public/sidebar-update-menu.mjs, public/sidebar-update-menu.css and the affected update tests under pi-package-webui/tests: browser/sidebar-update-menu.spec.mjs, browser/sidebar-update-progress.spec.mjs, browser/sidebar-update-integration.spec.mjs, browser/control-deck-component-updates.spec.mjs, control-deck-component-updates-static.test.mjs and component-update-state.test.mjs. All paths are under pi-package-webui. Stop and report before modifying any other source or test. Parent handles docs, asset revisions, inventory and shared fixtures. Worker creates ignored handoffs/update-feedback-worker.md with commit, exact checks/exits, screenshots and omissions. No children, push, PR action or acceptance claim.

Use disposable HOME/XDG/Pi/npm/Git, executable pi/npm guards and fake command fixtures. Parent handoffs/run-ui-polish-command.sh, playwright.ui-polish.config.mjs and update-test-bin can be copied to child handoffs. Temporary node_modules symlink to /home/firstpick/npm-packages/pi-package-webui/node_modules permitted, remove only the child's symlink afterward. Do not install dependencies. Use system Chromium via existing Playwright fixtures; capture, inspect and display changed screens. Verify all scopes start once without confirmation, rejected/invalid discovery never applies, delayed replies preserve ownership, Details/back/Escape and closed/reopened menu work while running and terminal, minimal unchanged, partial/EROFS output, keyboard and narrow/short layouts. No live provider calls or real updates.

## Integration and acceptance

Parent inspects and integrates the worker result, updates docs/cache/inventory, runs affected checks, then launches one read-only Sol/high reviewer against this contract. Accept only supported scoped findings; parent fixes and rechecks without extra review rounds. Final package gate uses setsid --wait and guarded commands. Record evidence in handoffs/update-feedback-acceptance.html, archive this plan when verified, then push and link PR38. Real installation updates and Windows/macOS remain untested.
