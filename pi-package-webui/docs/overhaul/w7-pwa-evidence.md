# W7-P PWA and update evidence

Parent integration checkpoint: all ten PWA/update cases pass in the 37-case run recorded at `/tmp/webui-w7-repaired-workflows.log` (its two failures are unrelated legacy fixtures). The earlier 26-case recovery/Settings run also passed. BUG-W7-P-001/002/003 are fixed: Classic boot recovery preserves query/hash and explicit preference, partial outcomes block another plan, and same-target reconnect retains the Project filter. This supersedes the worker failure status below; the original failures and limitations remain historical evidence. Whole W7 acceptance is pending.

This is contributor evidence for the fixed W7-P contract in the [canonical plan](../../../plans/planned/webui-design-architecture-overhaul.md). W0-W6 were accepted before this work. W7 remains unaccepted, with zero reviews used by this worker. The parent owns production fixes, integration and the postintegration rerun.

The worker changes only [PWA browser checks](../../tests/browser/overhaul-w7-pwa.spec.mjs), [update browser checks](../../tests/browser/overhaul-w7-update.spec.mjs) and this document. Existing fixtures, production files, assets, plans, ledgers, package manifests and lockfiles are unchanged.

## Environment and execution

Observed on Linux with Node v26.13.1 and `/usr/bin/chromium`, Chromium 157.0.8103.38. Dependencies resolve through an ignored symlink to the existing checkout's `node_modules`; no dependencies were installed or modified. Each case uses the unchanged session fixture with fake Pi, disposable HOME/XDG/agent/settings/update-coordination roots, a random loopback port and a fresh Playwright browser context. PWA cases add a disposable HTTP proxy and register workers only on its temporary loopback origin. No production browser profile or service-worker state is touched.

The ignored runner is `test-results/w7-p.config.mjs`, relative to `pi-package-webui`. Its reproducible contents are:

```js
import { defineConfig } from '../node_modules/@playwright/test/index.mjs';
export default defineConfig({
  testDir: '../tests/browser',
  testMatch: /overhaul-w7-(pwa|update)\.spec\.mjs/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: './w7-p-run1',
  reporter: [['list']],
  use: {
    browserName: 'chromium', headless: true, locale: 'en-US', timezoneId: 'UTC',
    launchOptions: { executablePath: '/usr/bin/chromium' },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
```

From `pi-package-webui`, run:

```bash
node node_modules/playwright/cli.js test --config test-results/w7-p.config.mjs --output test-results/w7-p-final
```

The final complete run exited 1: seven cases passed and three failed in 59.3 seconds. Each failure maps to an open finding below. The reconnect case still completed its subsequent exact-job, receipt, draft/node and stream-target checks after its soft filter assertion failed. No `test.fail`, skipped scenario, inherited accessibility exemption or automatic test retry masks a failing requirement. Soft assertions keep collecting evidence and still fail the case.

Both new specs pass `node --check`, and the scoped Markdown whitespace check passes. The scoped readiness verdict is FAIL for the fixed W7-P behavior contract, with the three active failures handed to the parent. This is a test/evidence delivery, not W7 acceptance or release readiness.

## What is exercised

| Scenario | Actual browser/server behavior | Simulation boundary |
| --- | --- | --- |
| Complete asset graph | Recursively reads entry imports, linked styles, CSS resources and manifest icons independently of the worker list; asserts every graph asset is precached, fetches every precache entry, checks Settings and absence of API cache entries | Current checked-in source; no historical release inferred |
| Old cache to current worker | Real registration, update, install, activation, cache retirement and controller change; checks complete new cache and existing document/prompt identity | Old worker is current source with a distinct fixture cache name and Settings entries removed; this models a missing-module cache, not a historical binary |
| Stale open client | Same live document navigates to Settings/System and returns to its original prompt node and draft after worker takeover; then reloads successfully | Does not prove compatibility between arbitrary historical app implementations |
| Offline Focused reload | Real Chromium offline mode; cached entry and graph load; Settings renders; `/api/tabs` rejects, APIs stay uncached; online reload restores backend access | Cached shell availability only; no offline conversation, send, provider, file or Git functionality claim |
| Missing Settings module | Proxy returns real HTTP 404 for the actual static import; boot diagnostics name it; selected WCAG A/AA axe scan has no exclusions; keyboard activates Reload page after asset restoration | Deliberate asset omission; no production allowlist change |
| Classic recovery | Tests a named link in the boot-failure panel and separately verifies manual `?shell=classic` recovery after restoring the asset without overwriting saved Focused choice | Classic cannot repair a missing shared import; asset restoration remains a precondition for successful boot |
| System update across destinations | Real System select and confirmation, Project navigation/filter, one active-tab stream, browser offline/online, Retry connection, same transaction receipts and return to the original draft node | All update endpoints and receipts are mocked; no updater command or lifecycle script runs |
| Unknown/partial recovery | Real reload and job rediscovery, receipts, disabled-button assertion, System attempt and exact mutation-request assertion | Mock host allows partial retry so the client must enforce the W7 recovery gate independently |
| Changed-boot handshake | Real System restart controls and production reconnect loop reject repeated old boot IDs, accept a changed ID and restore the live draft | Restart endpoint and health identity change are mocked; no server process is restarted |

The asset graph and cache identity are derived from the actual entry and [service worker](../../public/service-worker.js). The independent graph has 60 assets, all covered by the 63-entry precache list. At the tested base they resolve to app195/PWA166, focused adapter CSS2 and base styles156. These are observed source versions, not assertions embedded in the tests. Raw graph, cache-transition, request/stream and boot-handshake JSON files accompany the screenshots.

The disconnect case makes mocked update reads fail during the offline/retry window. Otherwise Playwright route fulfillment can report successful status while Chromium is offline and incorrectly hide the real retry panel. Files Refresh triggers a real failed API request; Retry connection performs real health/tab/session reads and reopens the stream. The case tests the explicit retry path, not a promise of automatic reconnection.

Only text-draft retention within the same document is asserted. Reload cases establish shell/receipt recovery. They do not assert that reload retains unsent in-memory attachments, dirty file buffers, attachment editors, selection, or other in-memory state. No such preservation promise follows from these results.

## Findings for the parent

| Bug | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| BUG-W7-P-001 | Major | Boot recovery | Open | Boot-failure panel has no accessible Classic startup escape |
| BUG-W7-P-002 | Major | Native update UI | Open | Partial receipts allow another update plan |
| BUG-W7-P-003 | Minor | Same-tab reconnect | Open | Retry connection clears the Project search filter |

## BUG-W7-P-001: Missing Classic startup escape

**Severity:** Major
**Module:** Boot recovery
**Spec Reference:** Canonical plan capability map and W7-P, accessible retry/Classic startup escape
**Found During:** `boot failure provides an accessible Classic startup escape`

### Reproduction Steps

**Preconditions:** Fresh disposable browser context with an explicit Focused preference.

**Steps:**
1. Return HTTP 404 for `/settings-workspace.mjs` on the disposable proxy.
2. Open the real entry page and wait for the startup-failure alert.
3. Look for a named Classic link in the boot-failure panel.

### Expected Result

A keyboard-accessible Classic startup escape is available alongside retry.

### Actual Result

Only Copy troubleshooting report and Reload page are present. The active `toBeVisible` assertion for the Classic link fails with `element(s) not found`.

**Evidence:** The missing-module screenshot and failed-case trace below. [Boot markup](../../public/index.html) defines the two existing actions; the corresponding startup code binds only those actions.

### Environment

Linux, Node v26.13.1, Chromium 157, fresh loopback-origin context and fake Pi. No production cache or settings.

### Analysis

**Likely root cause:** The standalone HTML recovery panel lacks the Classic navigation action. A link also needs honest behavior when a shared import is missing; selecting Classic does not itself restore that asset.
**Related bugs:** None identified.
**Workaround:** Restore the missing asset and manually navigate to `?shell=classic`. The separate positive case verifies this path.

## BUG-W7-P-002: Partial receipts permit another plan

**Severity:** Major
**Module:** Native update UI
**Spec Reference:** W7-P, unknown/partial state prevents a new plan
**Found During:** `partial job survives reload and blocks a new plan from both version dialog and System`

### Reproduction Steps

**Preconditions:** Mock discovery returns the same partial Web UI job, one changed/healthy receipt and one failed receipt; `canRunUpdate` is true and no job is running.

**Steps:**
1. Open the actual Web UI version dialog, reload, and rediscover the same job.
2. Observe the enabled Update Web UI button.
3. Close the dialog, select Update Web UI in Settings/System, and activate Run action.

### Expected Result

Partial recovery blocks a new plan through both entry points.

### Actual Result

The disabled-button assertion fails. System opens another confirmation and sends `POST /api/update/plan` with `{"targets":["webui"]}`. The zero-write assertion remains active. Nothing confirms or applies this second plan.

**Evidence:** `partial-recovered-job.png`, `update-mutation-requests.json` and the failed-case trace below. [Application update guards](../../public/app.js) classify partial as settled in `nativeUpdateUnsettled` and omit partial from `componentUpdateButtonState`'s refusal conditions. This is a mismatch with the fixed W7-P contract, not evidence that an installer ran.

### Environment

Linux, Node v26.13.1, Chromium 157; all update API routes mocked, ordinary tabs/session API real against fake Pi.

### Analysis

**Likely root cause:** The client relies on host eligibility for partial outcomes and has an explicit unknown gate only. Parent must reconcile the fixed recovery contract with the existing host/client behavior.
**Related bugs:** None identified. Unknown-state recovery passes.
**Workaround:** Inspect receipts and recover manually before attempting another update.

## BUG-W7-P-003: Reconnect clears Project search

**Severity:** Minor
**Module:** Same-tab reconnect
**Spec Reference:** W7-P System-to-other-destination update/reconnect continuity; canonical navigation preservation contract
**Found During:** `System update keeps its job through destination changes and a real browser disconnect/reconnect`

### Reproduction Steps

**Preconditions:** Active original session, simulated running update, real Project destination.

**Steps:**
1. Enter `retained project filter` in the actual Project search input.
2. Put Chromium offline and activate Files Refresh.
3. Restore the network and activate Retry connection.

### Expected Result

Reconnecting the same tab preserves the Project filter.

### Actual Result

The search input becomes empty. The active soft assertion reports expected `retained project filter`, received `""` and permits later job/draft checks to run.

**Evidence:** Final reconnect-case trace and screenshot below. In [application coordination](../../public/app.js), `retryServerConnection` calls `initializeTabs`, which calls `resetActiveTabUi`, which calls `resetFileTreeState` and clears the input. `refreshFileTreeRoot` itself retains and reruns a nonempty query.

### Environment

Linux, Node v26.13.1, Chromium 157; real browser network loss and explicit retry, mocked update reads fail during the outage.

### Analysis

**Likely root cause:** Same-tab connection recovery reuses the full tab-reset path.
**Related bugs:** None identified.
**Workaround:** Re-enter the search filter after reconnect. This finding does not establish loss of dirty file contents or attachments.

## Artifacts and handoff limits

The final artifacts are under ignored `pi-package-webui/test-results/w7-p-final/`. Each failed case retains its screenshot, trace and error context. Representative screenshots were opened, inspected and displayed in chat. The offline image shows the rendered Focused Settings shell behind the explicit backend-unavailable panel. The boot image names the missing Settings import and shows the two existing actions. The partial-result image shows both receipts and the enabled update action.

Useful final artifact paths, relative to this document:

- [Current Settings and cache](../../test-results/w7-p-final/overhaul-w7-pwa-complete-c-e50b7-tings-and-never-caches-APIs/current-settings-cache.png)
- [Current graph JSON](../../test-results/w7-p-final/overhaul-w7-pwa-complete-c-e50b7-tings-and-never-caches-APIs/current-asset-graph.json)
- [Stale client after worker takeover](../../test-results/w7-p-final/overhaul-w7-pwa-old-cache--3ffc7-retains-its-draft-and-nodes/stale-client-after-worker-update.png)
- [Cache transition JSON](../../test-results/w7-p-final/overhaul-w7-pwa-old-cache--3ffc7-retains-its-draft-and-nodes/cache-transition.json)
- [Offline Focused shell](../../test-results/w7-p-final/overhaul-w7-pwa-offline-re-a0013-aiming-working-offline-APIs/offline-focused-shell.png)
- [Missing Settings boot failure](../../test-results/w7-p-final/overhaul-w7-pwa-missing-Se-fb3ee-vers-when-the-asset-returns/missing-settings-boot-failure.png)
- [Partial job recovered after reload](../../test-results/w7-p-final/overhaul-w7-update-partial-a4744-h-version-dialog-and-System/partial-recovered-job.png)
- [Reconnect receipts](../../test-results/w7-p-final/overhaul-w7-update-System--57e4d-rowser-disconnect-reconnect/system-update-reconnected-receipts.png)

These ignored artifacts must be copied separately when integrating the commit. Exact base/result commits, command exits and initial test-authoring corrections belong in the worker's ignored `handoffs/webui-overhaul-w7-p.md`.

No real installation, package update, publication, provider inference, deployment or production service-worker operation occurred. Installed-PWA lifecycle, operating-system integration, native devices, WebKit/Safari, Firefox, Windows/macOS, arbitrary historical releases, storage eviction/quota failures and offline API functionality remain unmeasured. The full package/browser suite, reviews and post-fix integration rerun belong to the parent. This evidence makes no W7 acceptance claim.
