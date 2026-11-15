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

NAV BUG-001 accepted after inspecting the forced upward dropdown rule. Terra NAV-FIX owns only the new-tab placement CSS/functions and new navigation tests, disjoint from SETTINGS-FIX display functions. Its live follow-up covers the initial navigation audit gaps and diagnoses two repeated but unconfirmed continuity test failures. No existing assertion may be weakened to hide them.

TOOLS initial discovery has no confirmed defect and remains partial. Terra TOOLS-DEEP owns only the ten Project/Activity controller modules and new domain tests. It exercises the initial audit's unchecked workflows using disposable repositories and mocked external services, fixes only locally reproduced controller defects, and reports shared app/CSS problems to the parent. No child owns backend code or existing test files. The three initial audits are evidence, not acceptance or a full-coverage claim.

### Integrated fixes and verification in progress

- SETTINGS BUG-001 integrated from Terra commit c9090fdd as 3575eca8. Parent checked the exact display-only diff; all 16 new and adjacent browser cases pass. Installation classification, guards and confirmation remain unchanged.
- NAV BUG-001 integrated from Terra commit 761b74f0 as 748d2083. Parent checked exact new-tab placement symbols and CSS, with integration retest pending.
- TOOLS mobile observation accepted as POLISH-003 after screenshot inspection and actual pointer hit-test failures at 320px and 390px. Parent fixed the phone file header layout in ba1a792; both hit-test/action/dismissal cases pass. The header now places wrapping actions below the title, preserving room for the floating Control Deck button.
- Browser asset tuple advanced coherently in a322b11, including pinned asset assertions and installed-PWA expectation.
- The two continuity failures remain unconfirmed as product defects. Parent reran the unchanged original six-line and live-edge cases three times each with isolated outer HOME/XDG; all six pass. No assertions or production behavior were changed to hide them. Combined acceptance will rerun the complete suite.
- Initial TOOLS-DEEP test isolation exception is recorded in its handoff; two legacy test fixtures inherited HOME/XDG. Subsequent parent and child commands explicitly isolate the outer environment as well as per-test state. No evidence establishes an actual production configuration mutation; do not claim hashes that were not measured.
- Remaining live controls now have narrow Terra test-only assignments for session/message actions, local Git/worktrees, and runners/queues/gates/notification targets. Each owns one unique new spec; parent retains production ownership.

### Later live findings

- POLISH-004 accepted: Choose Directory returns focus to a hidden menu item/body, and immediate Escape failed in two Terra runs. Terra PICKER-FIX owns only picker lifecycle symbols and its session-action regression spec; it must establish loading/cancel focus and late-response behavior without changing CWD mutation contracts.
- POLISH-005 accepted: annotated-tag confirmation omits the selected repository path. Parent used the already-scoped section cache's authoritative root for confirmation display, leaving the captured target/guards intact. All 43 controller checks and 11 live local Git cases pass. Terra's original failing assertion remains active.
- Activity's synthetic background-decision failure was a fixture delivery defect, not a product finding. Parent replaced the inactive-tab SSE interception with an explicit fake-Pi decision command going through actual server pending-request/attention/replay behavior. The exact selected value, request ID and tab-ID reply assertions remain. All eight live Activity cases pass. This verifies extension decision routing; it does not claim a real workflow/model provider or browser notification permission/click integration.
- Parent full Chromium invocation was interrupted by termination of its outer shell; its child continued briefly, then stopped after 278 reported passes without a final report. It is not a full-suite pass. Final acceptance will use bounded shards after the picker fix, with zero retries and isolated outer HOME/XDG/agent/update paths.
