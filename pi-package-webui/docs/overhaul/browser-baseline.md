# Browser baseline for the Web UI overhaul

[Contributor guide](../../DEVELOPMENT.md) · [Implementation record](implementation-record.md) · [Recorded evidence](browser-baseline.json)

W0-B captures the unchanged production UI at `06351edae0d87829dfa8c747d31a061825568b0e`, using integration seed `cff3432ee63131ebb6150a906d9c06594ca2c401`. This is a rendered baseline and a comparison harness. It does not establish whole-wave acceptance or functional parity for the future focused shell.

## Run it

From `pi-package-webui`, with the existing package development dependencies available:

```bash
node node_modules/@playwright/test/cli.js test --config playwright.overhaul.config.mjs
```

The dedicated config selects `/usr/bin/chromium` when present. Set `PI_OVERHAUL_CHROMIUM` to another existing executable if needed. It never installs a browser or changes the normal browser config. One worker runs the 17 tests without retries, including an input-probe regression test. Allow about three minutes on the capture machine.

Each run saves screenshots, raw measurements, workflow observations, and `report.json` under an ignored `test-results/overhaul-baseline/run-*` directory. A normal run also writes `comparison.json` when the committed reference exists. It leaves the reference JSON unchanged. The Playwright output subdirectory contains failure screenshots and traces and may be replaced by the next run.

Only the baseline owner should regenerate the committed reference:

```bash
PI_OVERHAUL_UPDATE_BASELINE=1 node node_modules/@playwright/test/cli.js test --config playwright.overhaul.config.mjs
```

Regeneration requires the exact view/state and nine-workflow identities, completed actions, repeated performance observations, final stream output and no browser script errors. Failed or missing workflow evidence cannot replace the reference. Explicit partial and unsupported observations require an explanation and remain visible without invented counts. The capture also checks that production browser, server and library source still matches the production baseline.

Run `node --test pi-package-webui/scripts/tests/overhaul-reference.test.mjs` from the repository root to verify the write guard. Its failure cases assert that the previous reference bytes survive unchanged. Normal non-update runs retain diagnostic artifacts but fail on unexpected workflow errors.

Later workers can pass an approved preview query through `PI_OVERHAUL_QUERY`. The harness forwards the query without defining a new application interface. Per-view phone/tablet rollback or opt-in queries take precedence. Record the query in comparisons and keep companion availability and input data fixed. The Classic-to-Classic comparison will normally miss the focused shell's 30% density target; that is expected and is not a benchmark assertion failure.

## Isolation and fixed data

Each visual case starts the existing server and existing fake Pi in a new temporary directory. Each workflow and each performance sample also gets a fresh server, so saved UI preferences and accumulated transcript messages cannot contaminate the next observation.

The fixture creates a local Git repository with three Pi tabs, one modified `README.md`, 120 fixed text files, and a short Node runner that prints `BASELINE RUNNER OUTPUT`. Each tab starts with the existing fake Pi transcript, `fake prompt`, `fake answer`, and `fake follow-up`. The runner configuration is fixture setup and is excluded from workflow action counts.

The server receives temporary HOME, XDG directories, agent directory, settings file, and update coordination root. It disables the RPC supervisor and uses no installed server. Git ignores the user's global configuration. Each server owns a separate process group; teardown sends SIGTERM, waits at most three seconds, then kills any remaining descendants and removes temporary state. No real credentials, model provider, optional companion installation, or user settings are needed.

Browser contexts are nonpersistent. Screenshots use Chromium, UTC, English labels, dark OS preference, reduced motion, and blocked service workers. The browser waits for fonts before capture. System font availability and the complete browser/machine details are recorded in the JSON. Temporary paths, tab UUIDs, process IDs, and scripted event timestamps vary across runs. The harness fixes content and event order; it does not claim pixel-identical screenshot goldens.

## Captured views and states

Every row captures idle, streaming, and an explicit confirmation blocker, for 42 screenshots total.

| Presentation | Viewports in CSS pixels |
| --- | --- |
| Existing phone Legacy and opt-in v2, separately | 360×800, 390×844, 844×390 |
| Existing tablet Legacy and opt-in v2, separately | 768×1024, 1024×768 |
| Default Classic desktop, Catppuccin Mocha | 1440×900, 1920×1080 |
| Classic light, Catppuccin Latte | 1440×900 |
| Classic custom theme and uploaded PNG background | 1440×900 |

Streaming reuses `voice test slow`: five chunks spaced 500ms apart, ending with `This is a long streaming answer that keeps going.` The visual streaming capture waits for the first chunk. Blocked state reuses `fixture mobile blocker` and waits for the real `Fixture blocker` confirmation dialog. It then resolves the confirmation through the UI. Each case records browser script errors and horizontal overflow.

The custom theme copies the repository's Catppuccin Mocha tokens, changes the name and accent, and loads through the normal custom-theme catalog. The PNG is a fixed one-pixel image uploaded through the normal background file input. Theme and background state are verified before screenshots. This exercises custom theme/background plumbing, not the readability of a photographic background.

## Counting rules

The JSON stores every counted selector and label, each exclusion and its reason, visible disabled controls, unavailable controls, offscreen controls, and the number of hidden controls. Counting checks rendered geometry, viewport intersection, and clipping by scroll containers. An offscreen Control Deck control does not enter the denominator until visible.

Exclude transcript content, individual session roster items and their local actions, primary prompt input, and mandatory send, stop, attachment, model, effort, and confirmation controls. Shared header actions such as New tab, Save workspace, command palette and workspace overview remain secondary controls. Hidden disabled controls are recorded as unavailable. Visible controls behind a modal are unavailable even if they lack an explicit DOM `inert` attribute. Required confirmation actions remain excluded from the secondary count.

Expanded summary counts use a recorded registry for model, queue, and Git summaries in the Control Deck, status bar and workspace dashboard. Expanded auxiliary regions include Control Deck content sections, workspace overview, mobile sheets, file viewer, session summary and runner widgets. A closed section heading is a secondary control, not an open auxiliary region. An active mandatory approval dialog is not an auxiliary inspector.

The current default has collapsed deck sections and no installed Git-footer companion. Its density evidence therefore cannot establish duplicate-summary behavior with that companion or user-expanded layouts. Future hosts must extend the summary/region registry for their actual DOM, while preserving these semantic counting rules and the recorded Classic denominator. A missing selector is not evidence that a capability remains reachable.

## Workflow evidence

Counts measure completed deliberate actions on desktop Classic, beginning with fresh default state. Opening a native file chooser and choosing a file are separate actions. Selecting a dropdown value is one action. Setup API calls are excluded. Labels and selectors are recorded alongside each step and its verified result.

| Workflow | Observation |
| --- | --- |
| Switch session | Click the target tab; verify its selected state |
| Change model | Reach the selector; actual change remains partial because fake Pi provides one model |
| Change effort | Expand Controls, choose High, Apply; verify backend thinking level |
| Attach file | Open chooser, choose fixed text file; verify attachment tray |
| Find changed file | Expand Git, expand repository, open changed README; verify file viewer |
| Open runner output | Open runner menu, start Baseline runner; verify printed output |
| Find approval | Active-session blocker appears automatically; fixture trigger is not a user action |
| Configure tool profile | Unsupported; the real resource menu is hidden and disabled without advertised `/tools` or `/skills` |
| Change theme | Expand Controls, choose Dracula; verify selected and persisted theme |

The JSON holds actual counts and any failed step. A partial path is not a successful configuration workflow. Automatic approval display does not establish background-session approval discovery.

## Performance observations

Seven independent samples use the same 1440×900 browser context settings and fresh three-session server fixture. Raw samples are retained. p95 uses the nearest-rank method; with seven samples, it is the maximum, not a statistical confidence bound.

- First useful render starts at the browser navigation time origin and ends two animation frames after an enabled visible composer and fixture transcript appear. Cold means a fresh browser context with an empty HTTP cache. Warm means a reload in that same context. The server has already started in both cases; OS filesystem cache is not flushed.
- Input-to-paint version 2 starts in capture phase for the actual `input` event generated by Playwright `insertText`, before application bubble handlers, and ends at the second animation frame. It includes synchronous input-handler work, excludes driver dispatch and does not claim physical display latency. A browser regression test registers an 80ms application handler first and verifies that the measured interval includes it. The previous method started too late; comparisons reject those superseded samples.
- Tab-switch-to-content starts at the actual target-tab click and waits for selected target tab, restored unique session draft and visible transcript, then two animation frames. The transcripts are identical across tabs, so distinct drafts establish which session content was restored.
- Stream-render gaps measure changed streaming transcript text at animation frames, followed by the next rendering opportunity. They include the deliberate 500ms producer cadence. Every sample requires an additional finalized assistant message containing the complete expected output. No server-event-to-paint latency is claimed because the existing log has no browser-correlated event timestamp.
- Retained heap measures the main page's JS used heap through Chromium CDP after explicit GC, before and after ten fixed first/second-tab cycles, or 20 switches. Comparisons use the p95 post-cycle heap across seven samples. DOM native allocation, workers, renderer process RSS and GPU memory are not measured.

The frozen budgets are copied unchanged from the plan's Execution record into the metrics module and recorded JSON. Comparison output reports `within-budget`, `over-budget`, or `missing-evidence`. Platform timings are evidence, not golden test assertions. Changed browser/runtime/machine identity or fixture content marks performance comparisons as missing evidence. No aggregate acceptance pass is inferred.

### Input measurement correction

Review finding `BUG-W0-B-R1-001` supersedes only the original input samples. The corrected seven-sample capture at `2026-11-14T21:04:19.332Z` uses unchanged production source, the same machine/browser and fixture, and the capture-phase timer. Input p50 is 22.1ms and p95 is 30.9ms. This is a measurement correction, not an application speed improvement. The frozen budget remains baseline plus max(10%, 16ms).

The JSON's `corrections` record preserves the previous input definition/samples and points to the new raw report. All other original measurements, workflows, 42 screenshots and budgets are unchanged. The original ignored `run-2026-11-14T20-17-31-610Z/report.json` remains intact; it matches the reference before this explicit input correction. Corrected raw evidence is in `test-results/overhaul-baseline/run-2026-11-14T21-04-19-332Z/report.json`. Preserve both artifact directories.

Parent verification reran the input-probe regression, all seven performance samples and all nine workflow paths. The three tests passed. The completion guard also accepted the combined original view evidence and newly captured performance/workflows without writing over the historical reference. Fourteen separate guard/comparison tests passed.

## Missing evidence and handoff limits

- Real software-keyboard behavior and true browser 200% zoom are unmeasured. Headless viewport or device-scale emulation would not prove either behavior.
- No installed optional companion matrix, busy multi-agent session, split conversation, top/left session alternative, or Classic Left/Both deck arrangement is captured. These remain parity checks for later waves.
- No long-transcript selection, find, or manual-scroll preservation check runs. The large file fixture exists, but visual cases leave it collapsed.
- No native mobile device/engine, accessibility audit, process-cold startup, filesystem-cache flush, or physical input/display measurement runs.
- Actual model changes, complete tool-profile setup, background approval discovery and phone/tablet workflow action counts remain missing.
- Screenshots and raw artifacts are ignored local files. Their paths are recorded in the committed JSON, but the image files must be preserved or copied separately during integration.

The package's full unchanged Node suite belongs to W0-P and was not run by this worker. W0-B tests cover fixture and evidence generation only. The parent must inspect representative screenshots, assess these omissions, integrate the evidence, and decide whether W0 meets the plan before W1.

## Existing product finding

| Bug | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| BUG-001 | Major | Existing tablet v2 shell | Open, outside worker ownership | Composer and attachment control extend beyond the right viewport edge |

### BUG-001: Tablet v2 clips the composer after applying its rail offset

**Severity:** Major

**Module:** Existing tablet v2 shell

**Spec Reference:** Plan constraints 3 and 6, preserving attachment access and keeping conversation/composer useful on narrow screens.

**Found During:** W0-B screenshot inspection of `tablet-v2-768x1024-idle.png`.

#### Reproduction Steps

**Preconditions:** Unchanged production source at the baseline revision, Chromium 157.0.8103.38, the isolated three-session fixture, 768×1024 viewport.

1. Run the dedicated config with `--grep tablet-v2-768x1024`.
2. Open its idle screenshot, captured with `tabletShell=v2`.
3. Inspect the prompt's right edge and attachment control.

#### Expected Result

The tablet rail and workspace share the viewport width. The composer and attachment button remain inside the viewport and usable.

#### Actual Result

The layout begins at x=112 and retains width=768, ending at x=880. The prompt ends at x=818.53. The attachment button occupies x=823 through x=863, entirely beyond the 768px viewport. Document overflow still reports zero, so that scalar alone cannot establish that controls are visible.

**Evidence:**

- Screenshot: `test-results/overhaul-baseline/run-2026-11-14T20-17-31-610Z/tablet-v2-768x1024-idle.png`.
- Element rectangles: `test-results/overhaul-baseline/run-2026-11-14T20-17-31-610Z/tablet-v2-clipping-evidence.json`.
- No browser script error or failed fixture assertion accompanies the clipping. Screenshot capture success is not a layout acceptance pass.

#### Environment

Linux x64, kernel 7.2.14-zen1-1-zen, Node v22.23.5, Chromium 157.0.8103.38. Tablet v2 is explicitly opted in. No optional companions are installed.

#### Analysis

**Likely root cause:** Geometry retains the full viewport width after the 112px rail offset. The underlying CSS cause was not isolated or changed by W0-B.

**Related bugs:** None identified in this pass.

**Workaround:** The separately captured `tabletShell=legacy` presentation fits the same viewport. The parent should assign any production fix to its layout owner.


## Parent integration adjustments

The three baseline harness modules live under `scripts/browser/`, with the dedicated config pointing there. They require repository source history and a sibling theme fixture, so they are intentionally excluded from npm packaging and normal browser-suite discovery. The focused feature regression tests added in later waves still belong to the ordinary browser suite.

The fixture removes inherited `PI_*` and `FAKE_PI_*` variables before setting its explicit temporary-state overrides. This prevents unrelated caller settings/workspace/fixture paths from escaping isolation. Only the owned fixture process group and temporary root are cleaned up.

The worker's local tablet clipping report is tracked as parent **BUG-002** (BUG-001 in its original report). The original W0 screenshots and numerical reference remain unchanged. Correct the tablet layout in the owning shell wave and compare against this captured baseline; do not alter baseline evidence to conceal the defect.
