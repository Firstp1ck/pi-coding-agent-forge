# Pi 1.6.0 test results

Run on 2026-11-26 against repository commit `d826eadebd928d0e13f5d647f4ceb14dbd92dbfb`, including the eight existing Explainer Video working-tree changes. This tests the current repository, rather than the separate PR #42 checkout.

The session tests expose two fixtures that do not work with the newer Pi SDK. Both also fail on Pi 1.5.2, so neither is a newly demonstrated 1.6.0 regression. Todo Progress's affected test passes on 0.87.1. These failures occur in hand-built session objects before reaching the behavior the tests intend to check. They do not demonstrate a failure in a real Pi session.

| Bug | Severity | Module | Status | Summary |
|---|---|---|---|---|
| BUG-001 | Major | Todo Progress tests | Open, predates 1.6.0 | Native-startup fixture lacks a method required by newer Pi |
| BUG-002 | Major | Setup Skills tests | Open, predates 1.6.0 | Preflight fixture lacks the same method |

## Run scope and method

- Linux `7.3.5-zen1-1-zen`, Node `26.13.1`, Bun `1.4.5`, Python `3.14.10`.
- An isolated source snapshot preserved the working tree. Product source, package manifests, lockfiles, and installed dependencies in the original checkout were left unchanged.
- The snapshot's direct `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, and `pi-tui` imports and `pi` executable resolved to an installed **1.6.0** runtime. Matching **1.5.2** modules provided the comparison runtime. The older comparison used installed **0.87.1** modules.
- Other installed dependencies were reused. This was a controlled SDK substitution, not a fresh dependency installation from every package's lockfile. Tests that create their own fake packages retain those fixtures. In particular, the Qt packed-install test bypasses the substituted runtime.
- Test and dependency-install processes ran through `t3-build`. Package suites ran with at most two concurrent processes and disposable Pi agent-state directories. Qt used `QT_QPA_PLATFORM=offscreen`; no foreground windows opened.
- The main inventory contains 52 package `test` scripts and NixOS Wiki's `test:mock`. Nine additional commands cover standalone Node/Python tests, DOCX corpus/engine checks, and DOCX/Workbook mode checks.
- The first main run set `PI_OFFLINE=1`. This caused an artificial WebUI release-notes failure. A complete WebUI rerun removed that variable. The initial failure is retained as audit evidence and must not be counted as an upgrade defect.

The [machine-readable results](pi-1.6.0-test-results.json) list every suite, its actual command, exit status, duration, and comparison. [Evidence excerpts](pi-1.6.0-test-evidence.txt) preserve the failure messages and comparison output. Suite totals describe commands, not a combined count of individual test cases. Some suites use mocks or static checks, and successful suites can contain skipped cases.

## Outcome

No failure unique to Pi 1.6.0 was confirmed against 1.5.2 in this audit.

| Run | Passed | Failed | Skipped | Interpretation |
|---|---:|---:|---:|---|
| Main package commands | 48 | 5 | 0 whole commands | Setup Skills, Todo Progress, Qt WebUI, Issue Bot Gateway, and WebUI exit nonzero. |
| Supplemental commands | 6 | 2 | 1 | Root installer and Repo Explorer fail; DOCX engine skips. |
| WebUI targeted repeats | 2 | 0 | 0 | The previously failing HTTP harness file passes alone on both 1.5.2 and 1.6.0. |

The corrected complete WebUI run passes **262 of 263 test files**, then reports its HTTP harness failure. That file first stops at the Python-runner `uv run` assertion after the release-notes check succeeds. Its subsequent isolated passes demonstrate an intermittent result. A fully clean complete WebUI suite was not observed. The main table retains the failed complete command rather than replacing it with a targeted pass.

Useful passing checks include:

- Safety Guard's current-main suite, **156/156 tests**. This differs from the **160/160** previously reported for PR #42.
- Small Modal Reliability, **258/258 tests**, including real SDK session creation and native verification checks.
- Workbook's real Pi 1.6.0 CLI in **TUI, print, JSON, and RPC** modes. A mock model provider supplies deterministic responses; TUI input runs through a pseudo-terminal.
- DOCX's seven synthetic corpus cases and feature-inventory matrix. Its mode test checks registration and refusal of non-interactive overwrite through mocked extension contexts; it does not launch real Pi sessions.

## BUG-001: Todo Progress's native-startup fixture breaks on newer Pi

**Severity:** Major
**Module:** Todo Progress tests
**Spec Reference:** Test contract, "native Pi startup preserves hooks and pause cancels a delayed continuation"
**Found During:** Default `npm test` on Pi 1.6.0 and targeted runtime comparisons

### Reproduction Steps

**Preconditions:**
- Install matching Pi SDK modules for the version under test. Point `PI_GOAL_TEST_RUNTIME` at that runtime's public `dist/index.js`.

**Steps:**
1. Enter `pi-extension-todo-progress`.
2. Run `t3-build node --test --test-name-pattern='native Pi startup preserves hooks and pause cancels a delayed continuation' tests/follow-up-delivery.test.mjs`.
3. Repeat with Pi 1.5.2 and 0.87.1, keeping the source unchanged.

### Expected Result

The test reaches its assertions about input hooks, policy preservation, and cancellation of delayed continuation.

### Actual Result

Pi 1.6.0 and 1.5.2 throw before those assertions. Pi 0.87.1 passes the same targeted test. The complete 1.6.0 suite has 77 passing tests and one failure.

**Evidence:**
- Error message: `TypeError: this._preparePrompt is not a function`.
- Test fixture: [follow-up-delivery.test.mjs](../../pi-extension-todo-progress/tests/follow-up-delivery.test.mjs), lines 1547-1616.
- The plain `native` object borrows `AgentSession.prototype.prompt` and provides `_preparePromptAndToolLoadout`, but omits `_preparePrompt`.

### Environment

- Linux, Node 26.13.1; unchanged fixture tested against matching Pi 0.87.1, 1.5.2, and 1.6.0 SDK modules.
- No real model request. The fixture replaces the model boundary.

### Analysis

**Likely root cause:** The fixture depends on Pi's private session implementation. Newer `prompt()` delegates to `_preparePrompt()`, which the fixture does not supply. This is confirmed incompatibility with an upgrade from 0.87.1, already present by 1.5.2. The first affected release was not bisected.

**Related bugs:** BUG-002.

**Workaround:** None applied. Replace the partial session with a real SDK-created session and a deterministic provider. Preserve the existing behavioral assertions.

## BUG-002: Setup Skills' preflight fixture omits the newer prompt method

**Severity:** Major
**Module:** Setup Skills tests
**Spec Reference:** T3 preflight regression script, ordinary prompt and concurrent input/model changes
**Found During:** Default `npm test` on Pi 1.6.0 and targeted runtime comparisons

### Reproduction Steps

**Preconditions:**
- Resolve `@earendil-works/pi-coding-agent` from matching Pi 1.6.0 modules.

**Steps:**
1. Enter `pi-extension-setup-skills`.
2. Run `t3-build node tests/t3-preflight-regression.mjs --no-skills`.
3. Repeat with Pi 1.5.2, keeping the source unchanged.

### Expected Result

The script reaches its preflight and concurrent-change assertions.

### Actual Result

Pi 1.6.0 and 1.5.2 throw the same missing-method error. The preceding Bun suite passes all 39 tests, but the combined package command fails. The 0.87.1 comparison also fails because `_toolRegistry` is missing, with `Cannot read properties of undefined (reading 'has')`. There is no passing older baseline for this script in this audit.

**Evidence:**
- Error message: `TypeError: this._preparePrompt is not a function`.
- Test fixture: [t3-preflight-regression.mjs](../../pi-extension-setup-skills/tests/t3-preflight-regression.mjs), lines 67-112.
- `AgentSession.prototype.prompt.call(session, ...)` receives a plain object that supplies `_preparePromptAndToolLoadout` but omits `_preparePrompt`.

### Environment

- Linux, Node 26.13.1, Bun 1.4.5; Pi 1.6.0 and 1.5.2 comparisons.
- The script stops at a replaced provider boundary rather than making a model request.

### Analysis

**Likely root cause:** The private-method fixture has fallen behind the SDK. The failure predates 1.6.0. The 0.87.1 result does not establish that the script previously worked.

**Related bugs:** BUG-001.

**Workaround:** None applied. Build the preflight check around a complete SDK session while retaining the race and policy assertions.

## Other failures and old-version fixtures

These observations must not be presented as confirmed Pi 1.6.0 product regressions.

| Check | Observed failure on the 1.6.0 test run | Attribution |
|---|---|---|
| Qt package contract | Expected Pi dependency `/^\^0\.84\./`, actual manifest `^1.5.2` | Stale assertion. The unchanged manifest already conflicts with the test. |
| Qt packed install | Offline npm install fails `ENOTCACHED` for `pi-mcp-1.6.1.tgz` | The fixture creates fake Pi `0.84.3` and fake WebUI `0.9.9`, which do not satisfy current dependency ranges. npm tries other packages. This test is not pinned to the intended 1.6.0 runtime. |
| Qt QML smoke | Four failures covering deterministic scenarios, model reorder, delayed dialog settlement, and 200% scaling | All four also fail with the 1.5.2 SDK selected. Real Quickshell renders offscreen against `fake-pi-rpc.mjs`. Missing theme/reorder markers and dialog-acceptance errors need separate investigation. This is not evidence of a failure in a real Pi 1.6.0 process. |
| Issue Bot Gateway | Catalog parity test cannot extract `OPTIONAL_FEATURES` labels | Same failure with 1.5.2 selected. Source-text extraction of WebUI's browser catalog fails. This assertion does not exercise the Pi SDK. Both default runs have 32 passes and one failure. |
| Root installer tests | Interactive "plain selection" exits 1 because npm latest version cannot be resolved for `@fixture/pi-extension-example` | Reproduced on a second run. This test uses fake npm/Pi commands and does not exercise the upgraded SDK. Exact shell cause remains unverified. |
| Repo Explorer | `33 not greater than or equal to 35` | Python-only corpus-count assertion at [test_bash_usage_benchmark.py](../../pi-skill-repo-explorer/skills/repo-explorer/tests/test_bash_usage_benchmark.py), line 41. The tracked snapshot contains 33 fixture files. No Pi SDK runs. Default Python discovery has 28 passes and one failure. |
| WebUI initial run | Release notes endpoint returns 503 instead of 200 | Audit configuration error caused by `PI_OFFLINE=1`. Corrected rerun determines the final suite outcome. |
| WebUI corrected run | `runner-tools/python-tool.py should expose uv run when uv is available`, at HTTP harness line 3275 | The same file passes in subsequent isolated runs with both 1.5.2 and 1.6.0 selected. The server runs a fake Pi CLI. Cause remains unresolved; the observed intermittency does not establish an SDK regression. |

All six Qt failures repeat with 1.5.2 selected. That baseline has one additional failure, `helper transport handles adverse ordering, both timeout legs, and Pi exit without killing the backend`, with `timed out waiting for pi.status event`. This case passes in the 1.6.0 run. Its version dependence or timing sensitivity was not isolated, so it is not counted as a 1.6.0 regression.

The Qt references are [package-contract.test.mjs](../../pi-package-qt-webui/tests/package-contract.test.mjs), line 15, [packed-install.test.mjs](../../pi-package-qt-webui/tests/packed-install.test.mjs), lines 59 and 142, and [qml-smoke.test.mjs](../../pi-package-qt-webui/tests/qml-smoke.test.mjs), lines 338, 393, 409, and 475. The other failures are in [shared-contracts.test.ts](../../services/issue-bot-gateway/test/shared-contracts.test.ts), line 19, and [install-pi-add.test.mjs](../scripts/install-pi-add.test.mjs), line 149.

Version literals in updater tests also include 0.84.x and 0.87.x. Those often represent an older installed version to upgrade, rather than the SDK used to execute a test. Changing every old literal to 1.6.0 would remove those upgrade scenarios. In contrast, Safety Guard still declares exact **0.85.1** development dependencies, and Small Modal Reliability declares **0.85.1** for `pi-ai` and **1.5.2** for `pi-coding-agent`. The isolated run substituted 1.6.0 without editing those declarations.

## Coverage limits

- The DOCX engine command exits zero after printing `SKIP: no .NET SDK is installed`. It is a missing check, not a passing engine validation. Real DOCX TUI/RPC confirmation remains untested.
- Workbook's Windows/Excel/VBA/native host and signed-VBA corpus checks were not run on this Linux host.
- Quickshell Wiki's optional full-corpus evaluation requires a configured documentation corpus and was not run.
- The separate WebUI Playwright browser suite, opt-in WebKit, live external model/provider checks, and manual terminal keyboard checks were not run.
- Code Quality's platform/tool-specific cases retain their own skip conditions. A successful suite command does not imply that every optional analyzer ran.
- Mocked version reports and fake RPC backends do not prove live Pi compatibility. The passing Workbook mode checks and real SDK session/tool checks provide stronger evidence within their tested behavior.

## Follow-up

Repair BUG-001 and BUG-002 before relying on these suites to validate newer Pi releases. Refresh the two Qt installation fixtures separately, then investigate its offscreen smoke failures. Keep those changes separate from any claim of a newly introduced 1.6.0 product bug. This audit changes documentation only.
