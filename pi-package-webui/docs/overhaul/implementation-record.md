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

The follow-up pass uses GPT-6.1 Terra at high reasoning effort, with isolated fake-Pi servers and disposable Git repositories. The original W0-W7 results above are historical; follow-up acceptance is still in progress.

| Live finding | Correction |
| --- | --- |
| New-tab choices opened above the viewport | The compact menu chooses an available direction and stays within the viewport during scrolling and resizing. |
| Feature summaries claimed everything was registered despite registration-needed cards | Summary, accessible labels and tooltips explain excluded states. Installation eligibility and confirmation remain unchanged. |
| The phone Control Deck button covered a file action | File actions wrap beneath the title, with room reserved for the deck control. |
| Directory-picker cancellation lost focus or let an earlier response reach a reopened picker | Loading has an enabled focus target; cancellation aborts the read and restores a valid caller. Picker identity rejects late results, including after reopen. Footer callers retain their control key through redraws. |
| Tag confirmation omitted the selected repository | Confirmation uses the authoritative root already loaded for that section, preserving the captured request target. |

Six browser specs retain the live regressions and workflow checks. These exercise real disposable Git staging, stash, tag, branch and worktree operations, runner configuration and stdin, queue behavior, session actions, menu reachability and picker keyboard/error handling. The background decision fixture emits through fake Pi and the real server so attention discovery and response targeting are tested together. Fork, tree and export responses are simulated where fake Pi lacks upstream behavior; a synthetic decision title does not establish real workflow-provider integration.

Audits distinguish direct preview checks, automated browser scenarios and source-only inspection. They do not establish exhaustive coverage of every control and state. Live installed companions, remote/PIN combinations, browser notification permission/click behavior, provider account changes, voice downloads and hardware, real updates and publishing remain unverified. No production install or configuration mutation is needed for the delivered fixes.

### Platform limits

Linux Chromium is the verified browser environment. Physical Android/iOS keyboards, IME, microphones, Windows/macOS behavior, WebKit and installed live-provider/companion combinations remain unmeasured. Existing platform-specific behavior is preserved in code and focused contracts, not claimed as device-tested.

No production installation, package publication, deployment, push or merge is part of this implementation. Use the user documents for layout selection and recovery. Runtime ownership/protocol downgrades retain their documented drain and explicit shutdown requirements.
