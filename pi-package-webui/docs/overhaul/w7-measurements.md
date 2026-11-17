# W7 frozen measurements

Final parent acceptance: all 479 Chromium cases, all 250 package test files, all 16 frozen measurement checks and the final Sol review pass at `d0a6a25`. See the [implementation record](implementation-record.md) for results and platform limits. Earlier checkpoints below remain historical evidence.

Contributor evidence for the W7-M contract in the [implementation record](implementation-record.md). See the [development guide](../../DEVELOPMENT.md) for application implementation contracts and the [W0 browser reference](browser-baseline.md) for the original measurement definitions.

This runner measures default Conversation density and performance. Its verdict does not accept W7 or establish capability, reachability, accessibility, rollout or PWA parity. Production corrections belong to the integration owner.

## Run it

From `pi-package-webui`, with the existing development dependencies available:

```bash
node node_modules/@playwright/test/cli.js test --config playwright.overhaul-w7.config.mjs
node --test scripts/tests/overhaul-reference.test.mjs
```

Use disposable HOME, XDG, agent and settings roots for the Node command. The Playwright configuration creates those roots for its runner and workers; the unchanged W0 fixture creates a further isolated root for each server. Chromium is fixed to `/usr/bin/chromium`. No installation, actual provider, deployment or production state is involved. A missing browser/dependency is a failed prerequisite.

The runner rejects `PI_OVERHAUL_QUERY` and reference-update mode. It seeds the valid browser-local `pi-webui-shell-preferences-v1` record `{v:1,desktopLayout:"focused"}`. Phone/tablet use only the existing `mobileShell`/`tabletShell` overrides from W0; there is no focused URL opt-in.

Each invocation writes a unique directory beneath ignored `test-results/overhaul-w7/`, including:

- `report.json`: identities, machine/browser details, view records, performance and exclusions.
- `comparison.json`: explicit view mapping, completeness, missing-evidence reasons and frozen budget verdicts.
- Per-view and per-state JSON: counted controls, source selectors, disabled/unavailable/excluded/offscreen controls, summaries, auxiliary candidates, fonts and overflow.
- Idle/streaming/blocked PNGs and Playwright failure diagnostics.
- `performance.json`: raw sample sequences, stream paints/gaps/final-output counts and per-cycle heap observations, written after each independent sample and on failure.

Captures survive Playwright worker replacement: report assembly reads completed per-view/performance files. Missing views or states still produce missing-evidence rows. The final test fails on any missing or over-budget result. Failed captures cannot write the W0 reference: this runner has no reference-writing call. The original reference writer's completeness guard remains covered by its existing tests, including failed workflows; a focused W7 capture cannot satisfy the W0 view identity contract.

## Frozen denominator and counting

The unchanged W0 fixture identities are source `06351edae0d87829dfa8c747d31a061825568b0e` and seed `cff3432ee63131ebb6150a906d9c06594ca2c401`. They identify the historical baseline and deterministic fixture, not the current application revision; the report records that revision separately.

Every capture uses three sessions with the original identical short transcript, one modified README, 120 fixed context files, and no installed companions. Five streaming chunks arrive at 500ms intervals. Companion-populated observations must be kept outside this denominator.

| Current view | Frozen baseline | Rule |
| --- | --- | --- |
| `focused-1440x900` | `classic-1440x900` | Idle/streaming/blocked counts at most 70% of 29/31/0; zero duplicated expanded model/queue/Git summaries; at most one default auxiliary inspector |
| `phone-legacy-{360x800,390x844,844x390}` | Same named W0 view | No increase over 4/6/0; zero duplicated summaries |
| `phone-v2-{360x800,390x844,844x390}` | Same named W0 view | No increase over 7/7/0; zero duplicated summaries |
| `tablet-legacy-{768x1024,1024x768}` | Same named W0 view | No increase over 4/6/0; zero duplicated summaries |
| `tablet-v2-{768x1024,1024x768}` | Same named W0 view | No increase over 7/7/0; zero duplicated summaries |

Classic/customized/split arrangements and 1920px/theme fidelity are outside this default density target. Their coverage belongs to the other W7 assignments.

The original visibility, clipping, control candidates and semantic exclusions remain in use: transcript and session roster items, prompt, required send/stop/attachment/model/effort/approval controls. Disabled, hidden and inert-behind-modal controls remain separately reported. Required approval actions are excluded; they are exercised and dismissed after the blocked screenshot.

The semantic host registry adds focused selectors for the moved canonical model row, queue and Git content, plus the focused inspector. Selector unions deduplicate by actual DOM node, preserving the old Classic denominator. Nested auxiliary candidates inside the single focused inspector count as one inspector; all candidates remain available in the raw record. The CWD header and attention badge do not claim to be expanded Git or queue summaries. Real-browser synthetic coverage verifies moved model/queue/Git content, duplicate model detection, required-control exclusions, disabled controls and a single enclosing inspector.

The original summary selectors remain: model control row, footer model variants and dashboard model metric; queue box and dashboard queue metric; Git panel groups and footer Git state. Their visible text remains counted even behind a blocker, matching W0. No new exception removes a visible duplicate.

## Performance and missing evidence

All six budgets are read from the unchanged frozen constants and compared with `browser-baseline.json` in the focused Node tests. Cold and warm each retain seven independent samples and use nearest-rank p95 (the largest of seven). Input timing remains capture-phase v2, before application bubble handlers and through two animation frames; the earlier synchronous-handler probe remains exercised.

Cold means a fresh nonpersistent context and empty HTTP cache, with warm server/OS caches. Warm means reload in that same context. Service workers are blocked. Tab timing checks the actual click, selected tab, unique restored draft and transcript, followed by two frames. Stream gap measures rendering opportunities and includes producer cadence; it is not server-event latency. Seven stream runs retain all 28 gaps and exact final-text counts. A missing final output fails independently of timing.

Heap uses CDP `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage`, before and after ten first/second navigation cycles (20 switches), repeated seven times. It measures main-page JS used heap only.

| Metric | Frozen p95 | Frozen upper limit |
| --- | --- | --- |
| First useful render, cold | 315.3ms | 365.3ms |
| First useful render, warm | 194.8ms | 244.8ms |
| Capture-phase input to paint | 30.9ms | 46.9ms |
| Tab switch to content | 69.4ms | 85.4ms |
| Stream render gap | 500.1ms | 550.11ms |
| Post-cycle JS heap | 9,198,188 bytes | 19,683,948 bytes |

The raw JSON preserves full numeric precision. Missing/invalid raw samples, inconsistent summary statistics, incomplete stream/heap runs and page errors cannot inherit a numeric pass. Performance requires matching platform, kernel release, architecture, CPU model/count, Node and Chromium versions. A mismatch records the raw measurements and limits but classifies performance as missing evidence. Density can still be compared when machine speed differs, provided fixture identities match. Missing or incompatible evidence is distinct from a measured budget failure.

## Parent integrated result

At `af88d9c`, the complete matching-runtime run passed **16/16 cases**, exit 0. Artifacts: `test-results/overhaul-w7/run-2026-11-15T03-49-01-627Z-3064119/`; log: `/tmp/webui-w7-final-measurements.log`. All 33 view/state captures and seven samples per repeated metric are complete. Machine and fixture identities match; frozen references and thresholds are unchanged.

Desktop secondary controls are 18 idle and 20 streaming (37.9% and 35.5% reductions), with zero duplicate summaries. Mobile/tablet counts do not increase. Cold/warm useful-render p95 are 352.8/224.4ms, input 28.6ms, tab switching 64.1ms, stream gap 500.1ms, and retained heap 10,044,144 bytes. All six budgets pass and no final output is lost. This supersedes the historical failed run below; it does not alone accept W7.

## Historical worker run

Final full run: `test-results/overhaul-w7/run-2026-11-15T02-36-51-312Z-1665299/`, using the complete browser command above. Exit **1**: 14 tests passed and the final frozen-gate test failed. All 33 view/state records and screenshots, seven samples per repeated metric, seven stream runs/28 gaps and seven heap runs were retained. Browser page errors: zero. Final outputs: seven exact matches, zero losses.

| Observed density | Idle / streaming / blocked | Duplicates | Default auxiliary regions | Verdict |
| --- | --- | --- | --- | --- |
| Focused desktop | 18 / 20 / 0 | 1 / 1 / 1 | 0 / 0 / 0 | Reduction passes (37.9% idle, 35.5% streaming); duplicate-summary gate fails |
| Every phone/tablet Legacy view | 4 / 6 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | No increase |
| Every phone/tablet v2 view | 7 / 7 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | No increase |

The duplicate is visible in the desktop screenshot: the composer model row and footer model both show the same active model. Raw selectors resolve to `#composer > div:nth-of-type(5) > div:nth-of-type(1)` and `#statusBar > div:nth-of-type(1) > button:nth-of-type(2)`. Both remain counted behind the modal, matching W0's visibility rule. Production fixes belong to the parent; this runner does not exempt either summary.

| Final raw p95 | Observed | Comparison classification |
| --- | --- | --- |
| First useful render, cold | 383.1ms | Missing evidence: Node mismatch |
| First useful render, warm | 252.2ms | Missing evidence: Node mismatch |
| Capture-phase input | 30.7ms | Missing evidence: Node mismatch |
| Tab switch | 68.6ms | Missing evidence: Node mismatch |
| Stream render gap | 500.2ms | Missing evidence: Node mismatch |
| Post-cycle JS heap | 10,243,048 bytes | Missing evidence: Node mismatch |

Actual Node is v26.13.1; W0 used v22.23.5. Kernel `7.2.14-zen1-1-zen`, Linux/x64, AMD Ryzen 9 9950X3D/32 logical CPUs and Chromium 157.0.8103.38 match the frozen comparison keys. Fixture/source identities match. Cold/warm raw values exceed the nominal limits; the runtime mismatch prevents claiming a comparable performance regression or pass. Every metric retains the frozen limit in `comparison.json`.

Earlier evidence is preserved separately:

- Initial full run `run-2026-11-15T02-31-38-392Z-1591551`: exit 1, 13 passed/2 failed. All density states captured, but the seventh heap run timed out in the fixed tab/draft-restoration wait (`page.waitForFunction: Timeout 5000ms exceeded`), leaving six heap samples. Its trace and screenshot remain available; no sample was invented.
- Bounded affected-case repeat `run-2026-11-15T02-35-13-786Z-1637793`, using the same command with `--grep 'W7 repeated rendering and retained heap'`: exit 0, one case passed with seven samples for every metric. Its comparison correctly marks density missing, and it is not a full-spec gate pass. The initial timeout did not reproduce in this repeat or the final complete run; its cause remains unassigned between application restoration and the inherited click-event probe.

The focused Node reference/comparator suite passed 36/36 (exit 0). Syntax, whitespace, local links and frozen-reference byte checks also passed. All three W0 JSON references remain unchanged. No dependencies or first-party dependency imports changed.

Representative screenshots were captured, inspected and displayed inline: desktop idle and blocked, phone v2 390×844 idle and tablet v2 768×1024 streaming. The initial heap-failure screenshot and final desktop screenshot were also inspected. This is not an all-image visual audit or accessibility result.

The frozen measurement verdict is **FAIL**, with missing compatible performance evidence. Parent action is required for the duplicate summary and a compatible-runtime recapture; the original intermittent timeout remains recorded. Native Android/iOS/Safari/WebKit, physical keyboard/touch/safe-area behavior, OS push, installed companions, real provider operations, complete workflow access and PWA behavior remain unmeasured here. No W7 acceptance is claimed.
