# One Settings home

User request: all configuration should be reachable from the existing searchable Settings page, with a Settings gear beside Save / Command palette / Home at the bottom of compact left navigation.

This is a bounded placement/access repair using existing configuration owners. Do not remove model/scoped-model/effort composer shortcuts the user explicitly requested. Quick controls and contextual Setup links may remain, but they must share the same underlying settings and scope. Runtime operations and read-only inspection are not configuration.

## Contract and ownership

- Parent adds one gear in `.terminal-sidebar-actions`, directly after Home. It opens the canonical Settings Appearance destination, supports keyboard activation/history, indicates the current page, preserves drafts, and hides in Classic/top navigation. Existing rail Settings remains available when session navigation is collapsed.
- Sol coverage scout identifies settings lacking a Settings destination, distinguishing entries already reachable through Runtime settings or feature Setup dialogs. Parent checks its findings and records accepted placements before implementation.
- Reuse canonical nodes and action IDs; do not clone stateful controls or change persistence, server scope, explicit confirmations or target-lifetime checks. Scope and disabled reasons remain visible. Search must reach every added entry. Existing Classic/phone controls restore without duplicate nodes.
- Parent owns integration, tests, cache/inventory/docs and acceptance. Sol worker/reviewer settings remain high reasoning; at most two review rounds for this bounded unit. The preceding Activity/scoped-model review remains separate.

## Verification

Disposable actual-app Chromium with fake Pi, isolated HOME/XDG/Pi/Git configuration and existing dependencies. Check gear placement at1100/1440, Enter and Back, top/Classic rollback and draft retention. Check every accepted configuration destination/search path, its original control/dialog and unchanged scope. Run relevant Settings/feature/resource contracts plus package checks after integration. Capture and inspect screenshots. No installed configuration changes or real provider mutations.

## Progress

- Gear implementation prepared in focused-shell-adapter.mjs/css. Both real-app geometry/navigation/fallback cases passed, zero retries.
- Coverage scout completed; six accepted gaps are recorded below. Sol implementation runs in an isolated worktree; comprehensive Settings coverage is not yet claimed.

### Accepted coverage additions

Source audit at 2e9af8e found six missing homes: Sampling and Codex speed canonical controls in Models and resources; Summary Setup in Models and resources; project runner configuration in System; Git-footer Visibility and persisted tool-output expansion in Appearance. Runtime and Features Setup already cover the remaining audited configuration. Preserve direct quick controls. Add aliases for Runtime preferences without claiming individual field search.

Sol Settings worker owns only public/app.js, public/settings-workspace.mjs and a new tests/browser/settings-complete-home.spec.mjs. Composer worker owns separate CSS and its test; parent owns assets, docs, generated inventory and existing test updates. Bind new dialog entry paths to their original session/project through awaits and existing confirmation flows. No navigation-triggered mutations. Test all six homes and canonical restoration, search, scope, unavailable states and target switches using isolated fake Pi. Parent integrates and reviews.
