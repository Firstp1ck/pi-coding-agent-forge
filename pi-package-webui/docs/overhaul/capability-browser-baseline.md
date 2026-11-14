# Supplemental capability browser baseline

[Original browser baseline](browser-baseline.md) · [Scenario evidence](capability-browser-baseline.json) · [Contributor guide](../../DEVELOPMENT.md) · [Canonical plan](../../../plans/planned/webui-design-architecture-overhaul.md)

W0-D supplements the unchanged production UI at `06351edae0d87829dfa8c747d31a061825568b0e`, from integration base `ad514adba3f4e57c10c72b26eec0dce570eab30e`. It adds feature evidence before production edits. The original 42 screenshots, nine-workflow JSON and frozen numerical budgets remain unchanged. These scenarios do not measure performance or establish complete overhaul acceptance.

## Reproduce it

From `pi-package-webui`, using the existing development dependencies and `/usr/bin/chromium`:

```bash
node node_modules/@playwright/test/cli.js test --config playwright.overhaul-capability.config.mjs
```

The 20 scenarios use a dedicated config that selects only the supplemental spec under `scripts/browser/`, with one worker, no retries, a 60-second test bound and the system Chromium executable. It installs nothing and does not change ordinary browser-suite discovery. A normal run writes raw scenario JSON, screenshots and a report under an ignored `test-results/overhaul-baseline/capability-*` directory. It leaves both committed reference files unchanged.

To record this separate capability reference, the owner runs:

```bash
PI_OVERHAUL_UPDATE_CAPABILITY_BASELINE=1 node node_modules/@playwright/test/cli.js test --config playwright.overhaul-capability.config.mjs
```

Recording requires every supplemental scenario to finish without unexpected failures. The source guard verifies that browser, server and library source still matches the original production revision. Partial model evidence and exact known-defect characterizations retain their status in JSON. A green characterization test confirms the recorded defect, not working product behavior. Unexpected assertions and browser script errors fail the test and prevent a complete reference write.

## Isolation and simulation boundaries

Every scenario starts `startFixture()` unchanged, in its own temporary HOME, XDG, agent, settings and Git project directories. The three-session fixture contains a modified README, 120 numbered files and its existing runner. Browser contexts are nonpersistent. Teardown closes the browser context, terminates only the fixture's process group with bounded cleanup and removes temporary files.

The existing fake Pi supplies deterministic transcript and extension events. The tests never install a companion, launch a real inference provider, publish Git changes or change the running user server. The ignored `node_modules` symlink only reads the existing development dependencies.

| Evidence family | Controlled input | What remains real | What this does not prove |
| --- | --- | --- | --- |
| Alternative model selection | Per-page HTTP model catalog adds `fake/z-capability-alternative` | Controls UI selection and Apply, session-scoped POST, server validation/dispatch and fake-Pi RPC acknowledgment | Durable provider/model state, authentication or inference |
| Tools and Skills | Per-page HTTP command catalog adds `/tools` and `/skills`; fake Pi already supports the helper operations | Resource dialog, session tool mutations, exact-model/global HTTP persistence and inherited-default reset | Installed native resource companion behavior or every provider |
| Guided Git | Existing `FAKE_PI_GUIDED_GIT_ACTIVATION=1` and temporary generation preferences | Command availability, button activation, workflow panel, draft and attachment preservation | Generation, staging approval, commit or publication |
| Stats and prompt resources | Existing `FAKE_PI_STATS_PROMPT_CONTEXT=1`; simulated catalog also advertises `/stats` | Common Options navigation, dashboard activation and structured prompt/tool/skill inventory rendering | Installed stats collection, billing accuracy or live provider usage |
| Agents, workflow and gate | Existing `fixture subagents running` and `fixture subagents workflow` prompts | Canonical event parsing, roster, gate attempts, output overlay and nested workflow display | Actual agents/providers, all companion implementations or agent-session isolation |
| Background approval | Existing `fixture mobile blocker` against the second session | Pending request storage, metadata refresh, replay, confirmation POST targeting and return draft restoration | Browser notification permissions or native push delivery |
| Long transcript | Existing `FAKE_PI_TRANSCRIPT_JSON` with 200 fixed messages | Application find, CSS highlights, browser Range, manual scroll and real streaming/finalization handlers | Arbitrary transcript sizes, all tool/media content or native browser find |
| Expanded file tree | Existing fixture's 120 numbered files | Real listing, search and file editor loading | Filesystem performance at larger scales |

All mocked catalog responses are scoped to the test page. The tests retain real server catalogs when adding commands. No model-change POST, tool/skill write API, settings file response or approval response is intercepted.

The fake model acknowledges `set_model`, but its `get_state` always returns `fake/fake-model`. Therefore the model scenarios are explicitly partial. They prove that the UI selects the alternative and sends the correct model to the correct session, and that fake Pi accepts it. They cannot prove a durable model change. Substituting a successful state response would conceal that limitation.

All fake processes also report `sessionId=fake-session`. Canonical agent identity grouping consequently projects the two fixture instances into three terminal groups. The recorded aggregate of six rows is not six executed agents. The active group, gate and workflow checks use the originating terminal group; the raw canonical snapshot preserves the identity ambiguity. No agent-session isolation claim follows from this fixture. Tools isolation and approval response targeting are checked separately by tab ID.

## Observed paths and counts

Counts describe completed deliberate actions in each recorded scenario. A dropdown selection is one action, hovering a submenu is one action, and choosing a file is separate from opening its chooser. Fixture API triggers, screenshot capture and verification reads are excluded. JSON records every selector, action description and completion flag. The paths start with fresh default browser state; these are observed paths, not asserted minimum-action budgets.

| Recorded path | Desktop Classic | Legacy phone | Phone v2 |
| --- | --- | --- | --- |
| Choose and apply alternative model, partial fixture evidence | 3 | 4 | 4 |
| First saved model tool profile, including session mutation/reset | 6 | 7 | 7 |
| Full Tools/Skills scope exercise, including clear/close actions | 17 | 19 | 17 |
| Reach background approval, including metadata recovery | 2 | 3 | 3 |
| Approval response and return, including access actions | 4 | 6 | 6 |
| Switch to another session, before return | Original baseline | 2 | 2 |
| Apply High effort | Original baseline | 4 | 4 |
| Attach fixed text file and return to its tray | Original baseline | 2 | 4 |

The phone counts use Chromium emulation. Transcript Range creation and scroll sampling are test probes, not counted user workflows. Other scenario counts cover only the described recorded actions; companion fixture setup is excluded.

Model selection runs in desktop Classic at 1440×900 and in both Legacy and v2 phone shells at 390×844. Desktop opens Controls, chooses the alternative and applies it. Legacy first opens the Control Deck. Phone v2 opens More, then Settings, and uses the same model handler.

Resource scenarios start with Tools Setup, disable bash only in the originating session and verify that the other session retains bash. They restore inherited session tools, save an exact-model default, clear it, save a global default and clear it. They then open Skills Setup, save an exact-model skill default and clear it. The recorded `configurationActionCount` ends at the first saved model tool profile and includes the preceding session exercise. Later cleanup and Skills actions remain in the complete action list. Phone v2 reaches Setup through More → Extensions; Legacy uses the composer overflow menu.

Approval access starts with the first session in front, with its unsent draft. The blocker originates in the second session. The test confirms that it does not incorrectly open over the foreground session. It captures stale discovery, explicitly reconciles metadata, opens the correct pending dialog, approves it and verifies the request ID and response tab. It then returns to the first session and verifies the unchanged draft. `accessActionCount` stops when the correct dialog opens; the complete action list includes the response and return.

Phone Legacy and v2 also record common session switching, effort changes and file attachment from fresh fixtures. Session switching verifies draft restoration on return; High effort is applied through the UI and remains Off in the other session. Legacy opens a file chooser directly. Phone v2 opens Add Context, then Files, chooses the attachment and closes the sheet to return to its visible tray. Playwright supplies a fixed text file to the real chooser handler. It does not verify the operating system's native picker.

## Long transcript and file tree

The transcript has exactly 200 deterministic messages with alternating user and assistant roles, fixed timestamps and unique numbered text. The test searches for message 101, verifies one CSS-highlighted match, creates a browser Range in that message and scrolls manually. During five bounded samples and after settlement, the selection string, find query/count and scroll position must remain unchanged within one CSS pixel. Final output must contain the complete existing slow-stream answer. A missing final answer fails the test.

The file scenario expands Files and verifies all 120 `context-000.txt` through `context-119.txt` nodes. It captures the expanded tree, searches for the final file, opens it and verifies the editor value is `Fixed context 119` followed by a newline. A screenshot of the expanded tree does not imply all rows fit simultaneously in the viewport.

## Existing product findings

The identifiers below are local to W0-D. The integration owner assigns canonical bug numbers. Parent BUG-002 remains the existing tablet-v2 attachment clipping report; this work does not fix it or replace its original evidence.

| Finding | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| CAP-001 | Major | Session activity discovery | Open, characterized | An idle client misses a new background approval until metadata reconciliation |
| CAP-002 | Minor | Phone notification layout | Open, characterized | Recovery notifications cover the bottom Sessions navigation target |

### CAP-001: Idle foreground clients do not discover a background approval

**Severity:** Major

**Module:** Session activity discovery, existing server SSE and browser tab polling

**Spec Reference:** Plan constraint 3, preserving session isolation and explicit approval access; supplemental W0 background approval evidence.

**Found During:** `background approval targeting` in desktop Classic, Legacy phone and v2 phone scenarios.

#### Reproduction Steps

**Preconditions:** Unchanged production revision, three idle fixture sessions, first session in front, existing system Chromium.

1. Enter an unsent draft in the first session.
2. Send `fixture mobile blocker` through the real prompt API to the second session.
3. Confirm that the server reports one pending extension UI request for the second session.
4. Wait one second while the browser stays on the first session.
5. Inspect the target session status, then reload on Classic/Legacy or open Activity and Refresh on phone v2.

#### Expected Result

The background session signals that it needs input, and its approval is discoverable without manually reconciling metadata. The foreground draft remains isolated.

#### Actual Result

The browser retains an Idle label although the server has one pending request. Phone v2 Activity initially has no blocked item. Reload or Activity Refresh reveals the correct blocker. After recovery, the confirmation response targets the originating session and returning restores the foreground draft.

**Evidence:** Each `approval-*` JSON record includes the pending count, stale label, reproduction, access actions, response target and return result. Its `stale-discovery`, `discovery` and `dialog` screenshot paths are preserved in the separate capability JSON. Exact failed-test experiments were harness development, not successful product assertions.

#### Environment

Linux, Node v22.23.5, system Chromium 157.0.8103.38. Viewports 1440×900 and 390×844, isolated real server, existing fake-Pi confirmation event, service workers blocked.

#### Analysis

**Likely root cause:** `attachRpcToTab()` forwards the event to that tab's SSE clients. The idle foreground client listens to its active tab and only schedules tab polling when it already knows work is active. This explains the observed stale metadata; no production change was made.

**Related bugs:** Parent BUG-002 is separate tablet layout clipping.

**Workaround:** Reload the browser, or use Activity → Refresh in phone v2, then open the pending session.

### CAP-002: Approval recovery notifications cover phone navigation

**Severity:** Minor

**Module:** Existing phone v2 notification layout

**Spec Reference:** Plan constraint 6, keeping narrow-screen navigation usable.

**Found During:** Phone-v2 background approval recovery, after responding to the pending confirmation.

#### Reproduction Steps

**Preconditions:** The phone-v2 approval scenario above, at 390×844, with approval recovery notifications visible.

1. Open Activity and Refresh, then Review the second session's pending confirmation.
2. Choose Yes.
3. Inspect the center of the bottom Sessions navigation control while the notification toasts remain visible.

#### Expected Result

Visible navigation controls accept pointer input without a notification covering them.

#### Actual Result

The center-point hit target belongs to `notice-toast warn`, rather than the Sessions button. An earlier pointer attempt timed out while the toast intercepted it. The top Open Sessions control remains available and returns to the correct foreground draft.

**Evidence:** `approval-phone-v2.bottomNavigationObstruction` records the hit class and toast text. The same scenario's `after-response` screenshot shows the overlap. The final scenario records this as an additional known defect rather than forcing a pointer click through the toast.

#### Environment

Linux, Node v22.23.5, Chromium 157.0.8103.38, 390×844 phone-v2 emulation, unchanged production source.

#### Analysis

**Likely root cause:** Existing toast placement overlaps the bottom navigation. Pointer entry also pauses the toast expiry timer, which can prolong the obstruction during a click retry. No layout change was made.

**Related bugs:** CAP-001 causes the metadata recovery path that produces these notifications. Parent BUG-002 is separate tablet attachment clipping.

**Workaround:** Use Open Sessions in the app bar, or dismiss the notification before using the bottom navigation.

## Limits and readiness

This supplement retains the original native-device, installed-companion and performance limitations. Chromium phone emulation does not establish native browser engines, OS keyboard behavior, physical touch usability or push permissions. It does not test every companion, provider or resource combination. The unchanged package Node suite is owned by W0-P and was not rerun here.

Screenshots and raw artifacts are ignored local files. Preserve the captured `capability-*` directory separately when integrating the commit. The committed JSON stores relative artifact paths; the worker handoff supplies representative absolute paths.

The scoped acceptance gate is evidence completeness, isolation, source preservation, focused checks and honest defect/fixture classification. It is not release approval. CAP-001 remains open, durable model switching remains unverified, and the integration owner must combine this evidence with W0-C and the original baseline before deciding whether W0 is sufficient for W1.

## Scoped acceptance record

The final capture completed 20 tests in 46.4 seconds, with zero browser page errors and 38 supplemental screenshots. Fourteen scenarios verify the exercised behavior, three retain the fake-model state limitation, and three characterize CAP-001 while verifying recovered approval targeting and return. CAP-002 is an additional observed defect in the phone-v2 approval case.

The worker inspected representative final images for the chosen desktop model, phone skill profile, visible gate and workflow rows, expanded stats resource inventory, phone notification obstruction, long-transcript selection and opened final file. The captures show the existing crowded labels and notification overlap without altering production layout. The original 42-image JSON is byte-identical to the integration base.

| Gate | Result |
| --- | --- |
| Focused capability suite | 20/20 passed, including explicit partial and known-defect cases |
| JavaScript syntax | Both owned modules passed `node --check` |
| Documentation and artifacts | Local links and code fences valid; all 38 referenced images exist |
| Whitespace and ownership | Diff checks passed; exactly four owned tracked files |
| Source and frozen reference | Original production source, shared harness, original JSON and budgets unchanged |
| Omitted wider checks | Full unchanged Node suite, native devices, installed companions and provider inference remain outside W0-D |

Verdict: the supplemental evidence is ready for integration review. The entire W0 gate and the production UI remain unaccepted here; CAP-001, CAP-002 and the stated evidence limits need the integration owner's disposition.
