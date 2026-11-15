# Web UI live polish pass

Base: `135936a979d18fe43fa6ba1ca6f342faa95f28fa`, PR #38, branch `feat/webui-compact-workspace`.

The user requested Terra models to inspect every UI element live and fix unusual or unfriendly behavior. Preserve Pi's visual identity and all existing capabilities, scopes, configuration and process lifetimes. This is a usability and defect pass, not another architecture rewrite. Work only in isolated development state.

## Execution

1. Three independent GPT-6.1 Terra/high audit workstreams exercise the real rendered application with disposable fake-Pi servers. Each inventories controls and states, records reproducible defects, screenshots, limitations and checked scenarios. Existing feature-destinations.md and capability-ledger.md bound coverage. No production files change during discovery.
2. Parent verifies and dispositions findings, assigns confirmed fixes with exact non-overlapping paths to isolated Terra workers, and owns shared-file integration. No new dependencies or backend/API behavior changes without a demonstrated defect.
3. Rerun original reproductions and adjacent integration checks, inspect screenshots, then run package and browser acceptance against combined code.
4. Fresh-context Terra review, maximum two rounds for this fix unit. Parent verifies and fixes accepted findings. The second round checks fixes and regressions only.
5. Update user-facing documentation if behavior changes, record final coverage and limitations, and update the already-authorized PR. Archive this plan only after verification.

## Discovery contracts

- NAV: rail, session navigation/Home, tab groups/workspaces, conversation/transcript/message actions, composer/model/effort/attachments, All tools/pins/search, split view and session menus.
- TOOLS: Project files/editor/artifacts, Changes/advanced Git/releases, runners, Activity queues/agents/workflows/gates/Intercom/usage/events, notification and extension approval routing.
- SETTINGS: every Settings category and scope, search/deep links/history, companion availability/setup, voice/account/connection/system/help, Classic compatibility and phone/tablet/keyboard/zoom/error/offline behavior.

Each worker owns only its unique ignored `handoffs/ui-polish-<id>.md` plus disposable diagnostics. Each uses its own preview tab and server; no shared UI profile or real credentials. Reports distinguish exercised controls from source-only coverage, simulation from installed services, and functional defects from cosmetic preferences. Findings include reproduction, expected/actual behavior, source location, screenshot and minimal correction. Unavailable native hardware is explicitly unverified. No child delegation.

## Status

Discovery pending. No findings accepted or fixes implemented yet.

### Discovery disposition

Settings BUG-001 accepted. Source verification confirms that unregistered packages intentionally receive the conservative `unknown` migration state and stay outside bulk installation eligibility. Fix the misleading bulk status and accessible labels without weakening classification or installation guards. Terra SETTINGS-FIX owns only the optional-feature display symbols in app.js and its new focused tests; it also completes the initial audit's documented Settings interaction gaps. NAV and TOOLS discovery remain independent and read-only. Responsive and individual-control coverage remains pending.
