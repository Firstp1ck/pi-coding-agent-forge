# Compact WebUI implementation and acceptance

Contributor record for the compact workspace overhaul. [Development guide](../../DEVELOPMENT.md) · [Feature destinations](feature-destinations.md) · [Capability ledger](capability-ledger.md)

Status: implementation accepted on 2026-11-15. W0-W7 are complete, both W7 review rounds are closed, and all applicable central checks pass. Production source candidate: `d0a6a25`.

## Delivered behavior

The compact shell separates session navigation, conversation, a single contextual inspector, and searchable Settings. All tools provides categorized search and up to twenty pins. Contextual controls retain their original scopes, confirmations and availability reasons. Existing Pi colors, backgrounds, typography and message treatment remain.

Fresh installations use compact desktop only when the server can prove no previous WebUI state exists. Established, custom or unknown installations retain Classic. Explicit browser choices take precedence. Classic recovery preserves saved layout data; phone and tablet choices remain independent.

## Screenshots

Verified captures use disposable test sessions and the existing Pi theme. Open the [desktop workspace](screenshots/desktop.png), [All tools](screenshots/all-tools.png), [Settings](screenshots/settings.png), or [mobile conversation](screenshots/mobile.png) at full size.

## Implementation boundaries

| Area | Owners and preserved behavior |
| --- | --- |
| Shell | Native modules own action discovery, navigation, preferences, canonical views and surface focus. No framework migration. |
| Session | Originating tab/session generations guard asynchronous work. Drafts, attachments, extension requests and streams keep their lifetimes across views. Resume creates a new tab and retains the source. |
| Project | Files retain dirty buffers; Git preserves review and confirmation; runners survive hidden views; documents retain their canonical viewer. |
| Activity | Queue edits, agents, conversations, Events and provider usage have focused owners. Dismissing a view does not cancel work. |
| Settings | Category/search navigation reuses scoped controls. Session, Global and exact Model resource defaults remain distinct. |
| Server | Cohesive settings, Files, Git, runner, companion, RPC, SSE and helper services retain existing routes and guards. Supervisor continuity, replay, backpressure, atomic settings and revision checks remain. |

## Verification boundaries

The frozen W0 reference remains unchanged. W7 compares the same eleven viewport/mode identities, three states each, and seven repeated samples per performance metric. It rejects incompatible or incomplete captures. The static inventory maps thirty-four capability families and existing optional-package identities, but does not by itself prove runtime parity.

Integrated browser checks cover real disposable application/server interactions. Companion catalogs and provider responses are controlled fixtures. Native 200% Chromium zoom is measured through DPR and layout viewport changes with an unchanged outer window; it is not viewport emulation.

The package check completed with exit 0 in `/tmp/webui-w7-r2-check.log`. The complete Chromium run passed all 479 cases in 8.7 minutes with exit 0 in `/tmp/webui-w7-r2-browser.log`. The matching-runtime measurement run passed all 16 checks with exit 0 in `/tmp/webui-w7-r2-measurements.log`. Its 33 captures and seven samples per repeated metric are complete; all frozen budgets pass and no final stream output was lost. Historical failing captures and reviewer dispositions are retained in the local execution archive and HTML report. W0-W7 are accepted for the implemented scope, with the platform limits below.

## Independent review

The user selected Sol/high for isolated workers and reviewers and waived Anthropic. Every wave uses at most two review rounds. Each first round has two independent read-only perspectives; the final round checks accepted repairs. Parent integration owns every finding disposition.

W7 accepted corrections include the offline-cache assertion, horizontal session-action geometry, and cleanup of a retired summary request's own busy state. Additional complete-suite repairs cover startup readiness and delayed mobile paste-field focus capture. Newer summary content and requests are preserved during stale completion. Final reviewer `webui-overhaul-w7-review-r2-20261115` independently passed five browser cases, six ownership cases, boot diagnostics and ten inventory checks at `d0a6a25`. All three original findings and the separate whitespace observation are resolved; no qualifying regression was found. The parent inspected the report and the replacement-summary screenshot and accepted those dispositions. Both review rounds are closed.

## Final evidence

| Gate | Result |
| --- | --- |
| Package check | 250/250 Node, static and harness test files pass |
| Chromium integration | 479/479 cases pass, zero retries or skips |
| Remote companion | 20 checks pass; no later shared-contract changes |
| Frozen measurements | 16/16 checks pass; identical machine and fixture identity |
| Inventory and payload | Deterministic inventory current; required shell and backend assets packaged; internal evidence excluded |
| Review | Two first-round Sol perspectives and one final fix-only Sol review; all accepted findings resolved |
| Documentation | Local links and whitespace checked; completed execution plan archived locally |

| Measurement | Current p95 | Frozen limit |
| --- | ---: | ---: |
| Cold useful render | 342.4 ms | 365.3 ms |
| Warm useful render | 228.7 ms | 244.8 ms |
| Input to paint | 30.1 ms | 46.9 ms |
| Tab switch to content | 65.4 ms | 85.4 ms |
| Stream render gap | 500.1 ms | 550.11 ms |
| Retained heap after cycles | 10,079,116 bytes | 19,683,948 bytes |

Desktop secondary controls decrease from 29 to 18 when idle and from 31 to 20 while streaming. That is a 37.9% and 35.5% reduction against a 30% target. Duplicate expanded summaries remain zero; phone and tablet counts do not increase. These fixture measurements establish bounded regression checks, not general hardware performance guarantees.

Raw local artifacts are under `test-results/overhaul-w7/run-2026-11-15T04-24-51-961Z-3920029/`. Historical failed and interrupted runs remain evidence, but do not replace the completed results above. The three frozen baseline JSON files are unchanged from the W7 starting revision.

The complete Chromium command used a local wrapper of `playwright.config.mjs` selecting `/usr/bin/chromium`, disabling video and retaining every base project/test. Its command was `node node_modules/@playwright/test/cli.js test --config=playwright.w1-local.config.mjs --project=chromium --workers=2 --retries=0`. The wrapper is retained with local handoffs. Normal provisioned environments use the package's documented `test:browser` command. Measurements use the tracked `playwright.overhaul-w7.config.mjs` with the original Node 22.23.5 runtime. No browser or global package installation was required.

## Operational limits

### Terra live polish pass

The follow-up pass uses GPT-6.1 Terra at high reasoning effort, with isolated fake-Pi servers and disposable Git repositories. The original W0-W7 measurements above are historical. Follow-up acceptance passed at code commit `a8a118a6`: all 250 package Node/static/harness test files and all 529 Chromium cases, with zero retries or skips. The four complete shards passed 133, 133, 132 and 131 cases.

| Live finding | Correction |
| --- | --- |
| New-tab choices opened above the viewport | The compact menu chooses an available direction and stays within the viewport during scrolling and resizing. |
| Feature summaries claimed everything was registered despite registration-needed cards | Summary, accessible labels and tooltips explain excluded states. Installation eligibility and confirmation remain unchanged. |
| The phone Control Deck button covered a file action | File actions wrap beneath the title, with room reserved for the deck control. |
| Directory-picker cancellation lost focus or let an earlier response reach a reopened picker | Loading has an enabled focus target; cancellation aborts the read and restores a valid caller. Picker identity rejects late results, including after reopen. Footer callers retain their control key through redraws. |
| Tag confirmation omitted the selected repository | Confirmation uses the authoritative root already loaded for that section, preserving the captured request target. |
| A nested directory picker returned to a hidden launcher button | All tools retains the visible rail/header opener for the picker and returns focus after cancellation. |
| Error notifications covered mobile failed-send Retry | While recovery is visible, notices stay beneath the mobile app bar. The original request ID survives manual retry. |

Seven browser specs retain the live regressions and workflow checks. These exercise real disposable Git staging, stash, tag, branch and worktree operations, runner configuration and stdin, queue behavior, session actions, menu reachability and picker keyboard/error handling. The background decision fixture emits through fake Pi and the real server so attention discovery and response targeting are tested together. Fork, tree and export responses are simulated where fake Pi lacks upstream behavior; a synthetic decision title does not establish real workflow-provider integration.

Audits distinguish direct preview checks, automated browser scenarios and source-only inspection. They do not establish exhaustive coverage of every control and state. Live installed companions, remote/PIN combinations, browser notification permission/click behavior, provider account changes, voice downloads and hardware, real updates and publishing remain unverified. No production install or configuration mutation is needed for the delivered fixes.

Both Terra review rounds are complete. Round one reported no concrete scoped defect. After parent acceptance found a launcher return-focus regression, round two independently passed all four rail/header and pointer/keyboard return paths and 59 controller/action checks without a qualifying finding. The later mobile-notice CSS repair was verified by the parent through two real failed-fetch cases and the complete combined suite; it did not receive a third review round.

The full-suite repairs also retain the original assertions while making fixture setup deterministic: a held fake stream is explicitly aborted after geometry sampling, mobile paste selection is set on the current connected field in one browser task, and serial visibility tests await final settings durability. No source behavior was changed to hide these fixture races.

Inventory regeneration, required packaged assets, local documentation links and whitespace checks pass. The 504-file npm dry run excludes internal evidence. The frozen baseline JSON files are unchanged. Package validation used `npm --prefix pi-package-webui run check`; Chromium used the package configuration with a local system-browser wrapper, two workers, zero retries and four disjoint shards. These acceptance commands ran with isolated outer HOME, XDG, agent and update paths. An initial worker fixture exception, before that isolation was applied, remains recorded in the audit handoff; those scenarios were rerun in isolation. No evidence establishes a production configuration mutation.

Screenshots from the follow-up pass show [mobile file actions](screenshots/polish/mobile-file-actions.png) and the [repository-specific tag confirmation](screenshots/polish/git-confirmation.png).

### Interaction improvements

The compact composer now has one submission action, labeled Send, Steer run or Queue message according to the visible behavior choice. Model and effort controls show the effective session value and open immediate-apply pickers. Busy effort changes remain labeled for the next prompt. Picker failures stay inline, and late responses cannot repaint a replacement session or dialog.

All tools and Ctrl/Cmd+K share the same catalog, search and pins. Session and Project menus present six relevant actions, with More actions opening the full catalog. The separate Attention button opens decisions, running work and unseen completions. Selecting a decision switches to its originating conversation and uses authoritative dialog replay; merely opening the inbox does not mark finished work seen.

Three isolated Sol/high workers implemented the components. Two independent Sol/high reviewers examined the combined implementation at `eb1c84ea` and reported no actionable findings. Their checks passed 41 unit/adapter cases and 71 browser cases across the two reviews. No second review round was needed. Parent fixes after review changed only obsolete browser selectors and evidence documents.

Central validation passed all 251 package Node/static/harness files and all 51 new browser cases. The full Chromium run completed 580 cases with 572 passes and eight failures. Seven cases still targeted the deliberately hidden Classic model/effort controls; after retargeting them to the compact pickers, all seven passed with their original geometry, request-target, effective-state and navigation-budget assertions retained. The unchanged Classic deck-overlay case passed the isolated rerun and three further repetitions. Its initial failure remains unexplained and is retained as intermittent-test evidence, not claimed fixed. No test was skipped or given automatic retries.

The corrected responsive/Classic suite passed 44 cases, model/effort reachability passed two, and the session-effort case passed one. Together with the unchanged cases in the full run, every browser case has passing evidence on the final production code. This is combined full-run and targeted-recheck evidence, not a claim that one full run was green. Genuine browser zoom, mobile modes, draft/attachment ownership and offline cache checks remain covered. Provider-side steering timing, installed companions, hardware and non-Chromium platforms were not newly verified.

Inventory, package/cache coherence, documentation links and whitespace checks pass. No dependencies, backend contracts, settings schemas or installed configuration changed. The original crowding/performance figures above were not recaptured for this interaction pass.

Current fixture screenshots show the [busy composer](screenshots/interaction/busy-composer.png), [attention inbox](screenshots/interaction/attention-inbox.png) and [model picker](screenshots/interaction/model-picker.png).

### Composer More layout repair

The compact More disclosure inherited the customizable action grid, so its entire panel occupied one narrow cell and stretched More and Send from 34px to about 227px tall. The expanded actions now span a separate grid row and retain their existing action order. Visible overflow lets nested menus remain clickable above the composer. No JavaScript behavior or saved layout changed.

The regression reproduced at 1100px and 1440px before the fix. Three browser cases now cover an open Project inspector, a normal desktop and a 500px-high window, including nested action access, compact primary-button geometry and draft preservation. The combined regression/composer suite passed 15 cases; 25 affected static test files passed. The cache identity advances to PWA175 with adapter CSS5 so existing previews receive the stylesheet. See the [expanded More screenshot](screenshots/interaction/more-expanded.png).

### Session shelves and scrollbar controls

Compact left navigation now separates Inbox (idle, completed and input-needed sessions), Working and Settled. Settled starts collapsed. Settle and Restore change browser-local organization without closing sessions or discarding drafts. New work, pending input, session replacement and newer completion restore the session automatically. Group fragments retain their original group identity while close actions target only the displayed members. Classic, top navigation and phone modes keep their existing organization.

The sidebar and inspector topic strip hide their scrollbar tracks while retaining native scrolling. Inspector tabs retain arrow, Home and End navigation. The Documents empty state no longer allocates a second full-height viewer beneath its message; loaded pages scroll inside the viewer, including short windows. When a keyboard-focused session moves between shelves, the inner list reveals its retained control; ordinary updates preserve the scroll offset.

The combined candidate passed 54 Chromium cases and all 253 package test files. Ten inventory checks, packaged-asset assertions and offline-cache recovery also passed. A round-one Sol review found a focused session could move offscreen; the parent accepted and repaired it, with a strict full-visibility regression for both directions. The initial repair exposed fractional clipping, corrected with rounded scrolling and a focus-outline margin. The final shelf candidate passed eleven integration cases. Six additional Documents cases pass for empty states, loaded-page scrolling, canonical viewer continuity and Classic fallback. The second Sol review confirmed transition visibility and found a routine refresh could override deliberate wheel scrolling. The parent accepted that regression and restricted reveal to controls displaced by rendering. All ten shelf integration cases and fourteen affected Node checks pass after this correction. Both review rounds are closed; parent acceptance covers this bounded change, with the platform limits below.

Captures: [Working and collapsed Settled](screenshots/session-shelves/working-and-settled.png), [expanded Settled](screenshots/session-shelves/settled-expanded.png), [Light theme](screenshots/session-shelves/light.png), [scrolling without a track](screenshots/session-shelves/scrolling.png), and [inspector topics without a track](screenshots/session-shelves/inspector-tabs.png).

### Activity navigation and scoped model access

Activity replaces its horizontal topic strip with a full-width View selector. Options are grouped by Work, Conversations, and Usage & diagnostics. The selected section remains visible at narrow inspector widths. Project retains its shorter tab row. Native selection drives the existing navigation callback, preserving canonical content, filters, queues, drafts and browser history.

A Scoped models button beside Model opens the existing saved-scope picker directly. It retains provider columns, simple layout, ordering and keyboard selection; Model still opens the full catalog. Escape returns to Scoped models. Alt+Up inside a model option reorders it without also invoking global queue restoration.

The affected browser run passed 74 cases; the final shortcut correction passed all four scoped-model cases. PWA179 offline recovery passed. Independent review passed 40 browser cases and found 24 stale app-revision assertions. Those were corrected; all 28 affected static cases pass. The final combined package check passed all 254 test files with exit 0. PWA180 offline/online recovery also passed. See [Activity picker](screenshots/navigation/activity-picker.png) and [scoped models](screenshots/navigation/scoped-models.png).

### Settings, model catalog, composer and sidebar controls

The bottom-left Settings gear opens the existing searchable page. Six configuration homes now use their original controls or dialogs: Sampling, Codex speed, Summary Setup, runner configuration, Git-footer Visibility, and saved tool-output expansion. Resource navigation performs reads without changing preferences. Dialogs retain their originating session or project through asynchronous work. Footer context-menu Hide remains available independently of the Settings dialog.

The full model picker groups models by provider. Valid explicit release dates sort newest first; undated models follow alphabetically. Current selection stays inside its provider group. Search, keyboard selection, and saved scoped-model order retain their existing behavior. Provider headings remain in normal flow so wrapped names cannot cover keyboard-highlighted options.

The composer has a compact primary row and a separate More action grid. Short windows permit vertical focus recovery without horizontal conversation scrolling. Minimized workflow controls occupy two cells. The session sidebar supports pointer dragging, keyboard resizing, cancellation and browser-local width persistence; viewport clamping does not overwrite the saved width.

Candidate `04dc31f` passed 60 combined Chromium cases, 27 composer cases and the service-worker offline/online case. Model hierarchy also passed three focused cases. Inventory and package payload checks passed. The full package check passed all 254 test files with exit 0. Settings review found no confirmed defects, with 16 independent browser cases and six VM/static test files passing. All validation used isolated state; initial read-only instruction/Git inspection preceded the reviewer isolation wrapper. Parent accepts the Settings unit. Model round one found a wrapped-heading overlap at 320px. Parent reproduced and fixed it, and eight affected browser cases passed. Final model recheck is pending. Composer round two verified both reachability/overlap fixes with four selected cases and two independent probes; no eligible regression remained. Parent accepts the composer unit. Sidebar round two also resolved both findings. Earlier failed runs exposed missing test-fixture dependencies and composer overflow, which were corrected without removing assertions.

Inspected captures: [compact composer](screenshots/controls/composer.png), [provider-grouped models](screenshots/controls/model-providers.png), and [canonical Sampling controls in Settings](screenshots/controls/settings-sampling.png). These use disposable fake-Pi fixtures and do not demonstrate installed provider behavior.

### Platform limits

Linux Chromium is the verified browser environment. Physical Android/iOS keyboards, IME, microphones, Windows/macOS behavior, WebKit and installed live-provider/companion combinations remain unmeasured. Existing platform-specific behavior is preserved in code and focused contracts, not claimed as device-tested.

No production installation, package publication, deployment or merge is part of this implementation. The implementation is submitted through PR #38. Use the user documents for layout selection and recovery. Runtime ownership/protocol downgrades retain their documented drain and explicit shutdown requirements.
