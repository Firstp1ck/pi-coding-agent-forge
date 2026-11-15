# W7 capability access evidence

W7-CAP adds browser checks for remaining access gaps. It does not accept W7. The parent owns production fixes, shared fixtures, the ledger, the canonical plan and the final acceptance run.

[Capability ledger](capability-ledger.md) · [Source inventory](capability-inventory.json) · [Canonical plan](../../../plans/planned/webui-design-architecture-overhaul.md)

## Scope and provenance

Base revision: `928090f76c5558cbe8c4c559b48363de51e6a27f`. W0-W6 were accepted before this unit; W7 has used zero reviews. Only the two new specs and this document belong to this unit:

- [Capability workflows](../../tests/browser/overhaul-w7-capabilities.spec.mjs)
- [Companion presentation and identity](../../tests/browser/overhaul-w7-companions.spec.mjs)

Both specs reuse the unchanged [session fixture](../../tests/browser/session-fixture.mjs). Companion identities come directly from the unchanged [canonical catalog](../../lib/optional-feature-catalog.mjs). The fixture starts disposable servers with isolated HOME, XDG, agent/settings/session/update paths and fake Pi, with supervisor disabled. Its prewritten settings file cannot establish a fresh-install cohort.

The source inventory assigns owners to 34 families, identifies 15 dynamic families and reconciles 20 companion IDs. Those are source mappings, not runtime parity claims. Existing dependencies are consumed through an ignored symlink to the original checkout's node_modules. No dependency, production source, shared fixture, package version, ledger or plan changed. No installation, real provider/auth/microphone action, publication or update was performed.

## Local verification

Environment: Linux, Node `v26.13.1`, system Chromium `157.0.8103.38`, Playwright from the original checkout. Desktop tests use 1440×900; Essential/Detailed uses a 390×844 Chromium viewport. Service workers and video are disabled. Retries are zero.

The local run uses an ignored config at `test-results/w7-cap.config.mjs`, one worker and the existing Playwright installation:

```bash
cd pi-package-webui
/home/firstpick/npm-packages/pi-package-webui/node_modules/.bin/playwright test \
  --config test-results/w7-cap.config.mjs
node --check tests/browser/overhaul-w7-capabilities.spec.mjs
node --check tests/browser/overhaul-w7-companions.spec.mjs
```

The complete 25-case run reports **22 passed, 3 failed**, exit 1. All three findings remain ordinary failing assertions. There are no skip, fixme or expected-failure exemptions. A focused runner probe also fails at the browser control after its real server discovery precondition succeeds. Syntax checks and `git diff --check` pass. The inherited suites below were read and mapped, not rerun or accepted by this unit. Full Chromium, density, performance, PWA, accessibility and rollout acceptance remain parent-owned.

Ignored artifacts live under `test-results/w7-cap/`. The handoff records exact commands, exit codes, result hashes and final artifact paths. Screenshots, traces, disposable-server logs and navigation-action attachments preserve individual evidence. A JSON reporter writes under `test-results/test-results/w7-cap/results.json` with the local config.

## Nine frozen reachability workflows

Navigation counts stop when the relevant control or choice is reached, before editing a value. The selected value, file opening, runner launch and approval reply are then exercised separately. Fixture setup through the API is excluded. Search is not required for any of these nine paths.

| W0 workflow | Canonical focused path | Navigation / budget | Result and evidence boundary |
| --- | --- | ---: | --- |
| Switch session | Session rail → original peer tab | 1 / 2 | Selected tab ID verified against the fixture |
| Change model | Visible composer Model select | 0 / 2 | Real fake-Pi model POST and state change; original tab verified |
| Change effort | Visible composer Thinking effort select | 0 / 2 | Real fake-Pi effort change and state reconciliation |
| Attach file | Attach → native chooser | 1 / 2 | Chooser reached and in-memory text file selected |
| Find changed file | Project → Changes → expand repository | 3 / 2 | **FAIL**, file opens correctly but exceeds the navigation budget |
| Open runner output | Project → Runners | 2 / 2 | **FAIL**, script detected by server but browser command list empty; output not measured |
| Find approval | Native blocker appears automatically | 0 / 2 | Real fake-Pi request/reply, exact tab and request ID, explicit No |
| Configure tool profile | Settings → Models and resources → Tools | 3 / 3 | Setup reached; command availability mocked, resource read uses fake helper; profile editing inherited |
| Change theme | Settings → Appearance | 2 / 3 | Dracula selected and browser preference verified |

The changed-file assertion expands a repository only when it is collapsed. A parent fix that makes the changed file reachable in two actions can pass without relaxing the budget. Runner discovery is asserted through the real disposable server before checking the browser; it is not invented by a route mock.

## New state and identity checks

| Capability | Real browser controls and local behavior | Narrow fixture/mock boundary | Unmeasured |
| --- | --- | --- | --- |
| File annotation | Open real temporary file, keyboard selection, comment, Settings/Project return, exact path/text/comment/tab/request ID | Prompt POST captured and acknowledged | Actual model interpretation of selected text |
| Image preview | Attach repository PNG, assert decoded image, Escape/Close, peer-tab isolation and same dynamic dialog node on return | No HTTP replacement | Physical touch, every image format, external image URLs |
| Feedback | Keyboard question reaction, source/peer isolation, 503 preserves queue, identical retry body clears queue | Dedicated feedback POST only | Actual LEARNING creation; pointer access has an active finding |
| Workspace/group | Seed real two-tab group preference, real server save and group membership, failed listing/Retry, populated Load dialog, cancel replacement preserves IDs | Listing GET fails once; save/list otherwise real | Loading/replacing an entire constellation, crash recovery, deleted sessions |
| Hidden controls | Real Attach context menu Hide, All tools Show all controls, Settings Reset visibility remains reachable | No replacement | Every customized visibility combination |
| Presentation | Mobile More → Detailed/Essential, browser attribute changes, no output-mode POST or SSE renegotiation, server processing metadata unchanged | No replacement | Streaming processing mode cross-product; inherited transport suites remain separate |
| Companion administration | All 20 actual feature rows, installed-but-unloaded, registration needed, conflict, missing, browser-disabled, failed and busy controls | Read-only optional-feature snapshots and selected command catalogs | Installed package execution, actual installer, updates and restarts |
| Disabled Setup | Tools/Skills Setup remains actionable despite browser disablement; ordinary release commands stay hidden; release empty state points to Settings | Command availability and audit mocked; resource reads use fake helper | Companion-specific implementation behind Setup |
| Release progress | Project Release hosts npm/AUR output, navigation sends no command, explicit Toggle/Abort use original tab and exact command | Finite SSE widget payloads and prompt acknowledgments | Installer/publisher/job lifecycle, actual release, reconnect replay |
| Native questionnaire | Single/multi-select grammar, selected markers, Other, Change Other, free text and Enter; exact original native option/request/tab transported | Prequeued SSE select/input requests; response POST acknowledged | Real questionnaire runtime transition from Other to input, clarification/resume persistence |
| Workflow progress | Real fake-Pi run replay into Activity Progress; peer has no run; return retains running state; exact Pause run/tab/request ID | Only explicit Pause POST acknowledged by mock | Actual workflow engine pause/resume and downstream jobs |
| Trust-dependent administration | Real theme customizer; project destination disabled with accurate trust reason, Global selected, Cancel | Theme catalog retains real theme data but marks project untrusted | Real trusted project save, filesystem enforcement and auth |

Companion presentation tests block unexpected mutations. Disposable interface-preference writes remain real. Startup's automatic unavailable Fast-mode disable receives a local `normal`, `statusKnown` acknowledgment; it is not evidence of a provider mutation. Finite mocked SSE responses deliberately end and can show a disconnected/retrying notice. They exercise the real browser consumer, not a persistent transport, native extension engine or replay guarantee. Real fake-Pi SSE remains in use for approval and workflow-run tests.

## Family reconciliation

“New” means exercised here. “Inherited” names existing scenario files read for this unit; it is not a new passing result. Every row retains its ledger owner. No source owner is promoted to a parity claim.

| Ledger family | New evidence | Inherited evidence / remaining limit |
| --- | --- | --- |
| sessions | Session reachability; saved group and cancel replacement | session-ownership; focused-shell-integration; full workspace load unmeasured |
| session-actions | None | session-ownership; session-summary |
| split | None | focused-shell-integration; mobile-foundation |
| directories | None | windows-drive-parent; project-git-tools-integration |
| transcript | Presentation separation | interaction-continuity; stream-output-isolation; search-match-highlighting |
| presentation | Essential/Detailed without processing mutation | mobile-foundation |
| composer | Attachment chooser and image isolation | session-ownership; optimistic-prompt; interaction-continuity |
| model-runtime | Actual model/effort changes from composer | model-search-focus; sampling-tooltip; footer-model-advanced-layout |
| queues | None | activity-owner-integration; activity-queue-controller |
| agent-work | Workflow run survives destinations | activity-owner-integration; subagent-observability |
| intercom-btw | None | activity-owner-integration; intercom-conversation-viewer; BTW installed execution unmeasured |
| files | Real selection/context annotation | project-file-buffer-integration; file-tree-git-ignored |
| annotations | Selected text/comment/request identity; dynamic image preview | project-file-buffer-integration; project-artifact-integration |
| artifacts | None | project-artifact-integration; project-artifact-controller |
| git | Changed file reachable with budget failure | guided-git-extension-command; guided-git-fallback |
| git-tools | None | project-git-tools-integration |
| runners | Server discovery succeeds; new-host access fails | focused-project-activity covers existing launched-run continuity |
| usage | None | activity-owner-integration; stats-overlay |
| compaction | None | session-ownership; interaction-continuity; actual native compaction remains separate |
| resources | Three-action Setup access; disabled Setup | settings-resource-lifetime; resource-profiles; settings-navigation-integration |
| appearance | Theme change; hidden-control recovery; untrusted customizer | settings-workspace-integration; persistent-ui-layout |
| companions | Twenty-ID reconciliation; representative status matrix | settings-workspace-integration; installed companion matrix unmeasured |
| releases | Mocked npm/AUR progress and exact controls | No actual publication or installed release parity |
| accounts | None | settings-workspace-integration covers visible cards; real authentication unmeasured |
| voice | None | settings-workspace-integration; focused-shell-integration; no microphone/provider execution |
| connection | None | mobile-foundation; no real remote exposure/auth changes |
| system | None | update-reconnect; control-deck-component-updates; W7-P owns final update evidence |
| diagnostics | Feedback failure shown in real transcript | events-tree-context-menu; activity-owner-integration |
| extensions | Real approval correlation; mocked native questionnaire replies | session-ownership; reconnect/transport tests remain separate |
| responses | Other/free text, selected markers, feedback retry; pointer failure | feature-decision-output-popup |
| workflow | Fake-Pi run in Activity Progress with exact Pause identity | subagent-observability; engine execution unmeasured |
| projections | None | activity-owner-integration; subagent-observability |
| recovery | Feedback/listing Retry; Show all controls | mobile-foundation; update-reconnect; W7-P owns boot/offline recovery |
| help | None | settings-workspace-integration; actual issue publication unmeasured |

## Dynamic families

| Inventory family | Evidence classification |
| --- | --- |
| agent-projections | Inherited subagent-observability and activity-owner-integration |
| artifact-dialog | Inherited project-artifact-controller/integration |
| computed-footer-controls | Inherited footer-model-advanced-layout and sampling-tooltip; composer model/effort used here |
| extension-requests | New real blocker and mocked questionnaire requests; exact IDs preserved |
| feature-controls | New twenty-row/status checks; no installed execution claim |
| file-and-git-rows | New real selected-file annotation and changed-file reachability failure |
| image-dialog | New real attachment image and retained dynamic dialog node |
| message-actions | New keyboard feedback/retry and active pointer finding |
| native-selectors | New Tools/Skills Setup access; inherited resource lifetime tests |
| palette-models | Inherited model-search-focus; current tests use composer controls |
| palette-tabs | Inherited session/shell launcher tests; new direct session reachability |
| questionnaire-responses | New single/multi/Other/free-text presentation and exact replies |
| shared-dom-primitives | Exercised through canonical controls; no independent capability/parity count |
| skills-catalog | Disabled Skills Setup checked; inherited settings-resource-lifetime |
| slash-catalog | Narrow catalogs drive release/Setup availability; inherited guided-git and session catalog tests |

## Companion identity checklist

All twenty rows are reconciled against the imported catalog in one browser assertion. The additional evidence below remains representative and does not assert installed package parity.

| Catalog ID | Additional evidence or explicit limit |
| --- | --- |
| bangCommandAutocomplete | Missing status only; installed shell completion unmeasured |
| fishUserBash | Row identity only; actual shell choice unmeasured |
| btwCommand | Row identity; inherited conversations/BTW views, no installed runtime claim |
| gitWorkflow | Row identity; inherited guided-git scenarios |
| releaseNpm | Installed-but-unloaded distinction, browser-disabled state, mocked progress/Toggle |
| releaseAur | Registration needed, failed/busy administration, mocked progress/Abort |
| aurReview | Duplicate conflict; real repository review decision/report payload unmeasured here |
| workflows | Real fake-Pi Progress run and exact mocked Pause command |
| featureSystemPrompt | Row identity; inherited classifier decision output |
| safetyGuard | Row identity; no real safety policy mutation |
| tuiSkillsCommand | Browser-disabled Setup remains reachable |
| todoProgressWidget | Row identity; inherited activity-todo-view and derived-output tests |
| tuiToolsCommand | Browser-disabled Setup and three-action resource access |
| remoteWebui | Row identity; no remote exposure or auth change |
| questionnaire | Mocked native presentation/replies; actual tool runtime unmeasured |
| naturalConversation | Row identity; inherited End-conversation continuity; no microphone |
| gitFooterStatus | Row identity; inherited footer behavior; no installed footer parity claim |
| statsCommand | Row identity; inherited stats/usage rendering |
| codexFastMode | Row identity; startup disable acknowledged locally; provider execution unmeasured |
| themeBundle | Real browser theme selection, mocked project trust; no published theme write |

## Active findings

| Bug | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| BUG-W7-CAP-001 | Major | Project Git access | OPEN | Changed files need three navigation actions against a two-action budget |
| BUG-W7-CAP-002 | Major | Project runner access | OPEN | Detected runner is absent from the browser's canonical command list |
| BUG-W7-CAP-003 | Major | Transcript feedback | OPEN | Copy button intercepts the question-feedback pointer target |

All reproductions use the environment above and the unchanged disposable session fixture. Production repair is outside this unit.

## BUG-W7-CAP-001: Changed-file navigation exceeds the frozen budget

**Severity:** Major

**Module:** Project Git access

**Spec Reference:** Canonical plan, W0 reachability targets and W7-CAP contract

**Found During:** `W7 reachability: find changed file`

### Reproduction Steps

**Preconditions:** Focused desktop, disposable repository containing one untracked file, repository initially collapsed.

1. Click Project.
2. Click Changes.
3. Expand the repository to see the changed file.

### Expected Result

The common Project control is reachable in at most two navigation actions.

### Actual Result

Three actions are required before the file row is shown. Opening the file succeeds. **Evidence:** `Expected: <= 2; Received: 3`; navigation attachment records all three labels.

### Environment

Linux, Node 26.13.1, Chromium 157, 1440×900, fake Pi, isolated settings.

### Analysis

**Likely root cause:** Repository expansion remains a separate action after destination/topic navigation. See [repository card](../../public/app.js#L16919) and [topic selection](../../public/app.js#L2281).

**Related bugs:** None established.

**Workaround:** Expand the repository manually. Parent decides how to satisfy the frozen budget.

## BUG-W7-CAP-002: Project runner list loses a detected script

**Severity:** Major

**Module:** Project runner access

**Spec Reference:** W7-CAP nine workflows; W4 canonical Runners host

**Found During:** `W7 reachability: open runner output`

### Reproduction Steps

**Preconditions:** Focused desktop; real disposable `w7-runner.sh`; `/api/app-runners` confirms its runner label before browser navigation.

1. Open the focused app and wait for model/transcript hydration.
2. Click Project, then Runners.
3. Inspect the detected command list.

### Expected Result

The detected script is selectable, and launching it shows `W7_RUNNER_OUTPUT` in the canonical Runners host.

### Actual Result

`#appRunnerMenuPanel` has no child command and no visible box. Help says no runners were detected. **Evidence:** `Expected: visible; Received: hidden`; attached server discovery payload contains `w7-runner.sh`. Output remains unmeasured.

### Environment

Same isolated Linux/Chromium fixture; no HTTP runner mock and no real external command.

### Analysis

**Likely root cause:** Unknown. Check initial result lifetime/admission and repaint before changing detection: [refresh adapter](../../public/app.js#L28759), [controller request](../../public/project-runners-controller.mjs#L124), [target admission](../../public/app.js#L12412), [menu render](../../public/app.js#L29492). The server probe distinguishes this from an unsupported script.

**Related bugs:** None established.

**Workaround:** Existing launched-run continuity is covered elsewhere; no workaround is asserted by this failing path.

## BUG-W7-CAP-003: Copy button covers question feedback

**Severity:** Major

**Module:** Transcript feedback

**Spec Reference:** W7-CAP capability access and real canonical controls

**Found During:** `final-output question feedback accepts a pointer click without copy-button interception`

### Reproduction Steps

**Preconditions:** Focused desktop with the fixture's short final answer visible.

1. Move the pointer to the final-output question reaction.
2. Click the `Explain this in the final output` button.

### Expected Result

The question reaction queues feedback and reveals the feedback tray.

### Actual Result

The copy-message button intercepts the pointer. **Evidence:** Playwright reports `<span class="message-copy-icon">` from `.message-copy-button` intercepting pointer events until the five-second action timeout.

### Environment

Same Linux/Chromium desktop fixture, reduced motion.

### Analysis

**Likely root cause:** Overlapping absolute controls on the short final-answer card. Copy uses z-index 9 and feedback uses 8. See [copy positioning](../../public/styles.css#L8768), [feedback positioning](../../public/styles.css#L9017) and [feedback renderer](../../public/app.js#L35509).

**Related bugs:** None established.

**Workaround:** Focus the reaction and press Enter. The separate keyboard path verifies failure, retained queue and successful retry without a force-click exemption.

## Parent integration verification

Parent integrated this unit as 32229cd5 and independently reproduced all three failures. Project Changes now expands the active repository on its first Focused visit, retaining later manual collapse and one expanded repository. Opening Runners requests current discovery through the existing guarded owner. Feedback reserves horizontal space beside Copy, reveals on message hover/focus and remains visible for touch input; its buttons no longer require a prior hover before accepting a click. The feedback container has group semantics.

All 25 actual-app cases pass in the parent run, exit 0, including all nine reachability targets. Log: `/tmp/webui-w7-cap-integrated.log`. All 75 focused Git-render/runner checks pass in `/tmp/webui-w7-cap-focused-node.log`. Parent captured, inspected and displayed runner output and pointer-feedback screenshots under `test-results/w7-cap-integrated/`. The historical reproductions above remain evidence of the repaired defects. Companion payloads retain their documented mocks; this is not installed-provider coverage. Whole-W7 acceptance, accessibility, performance and PWA gates remain separate.

## Missing fixture seams and remaining limits

- The unchanged fake Pi can emit the real blocker and workflow-inspector run, but has no questionnaire select/input, npm/AUR output or repository-review trigger. The new specs use finite HTTP SSE payloads for the first two. Repository-review decisions and report opening remain unmeasured here; a source mapping or conflict row cannot replace them.
- Fake Pi does not advertise `/tools` or `/skills`. Setup access uses a narrow command-catalog mock while retaining the existing helper-backed resource reads. This does not prove those companions are installed.
- The shared fixture has two same-directory tabs. It can verify a saved group's exact IDs, server persistence and cancelled replacement. It does not establish full saved-workspace reload, missing-session restoration, large group sets or many-session behavior.
- Project trust is controlled through the read-only theme response because this unit cannot change shared fixture trust setup or production state. The browser's disabled destination/reason is measured; server trust enforcement is inherited and not rerun.
- Borrowed node_modules can contain companion package files. The real fixture's package audit is not a clean “nothing installed” environment. Mocked audit rows distinguish registration/loading/enablement/failure explicitly, without promoting package-file presence to installed parity.
- Physical devices, native TUI execution, all sixty native parity definitions, browser engines other than Chromium, real provider failures and all twenty installed companion runtimes remain outside this unit's measured evidence.
