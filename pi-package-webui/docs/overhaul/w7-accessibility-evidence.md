# W7 accessibility and responsive evidence

Parent integration checkpoint: collection roles and notification naming are repaired. The native-dialog check now distinguishes browser chrome from background application focus. Both customization uses top navigation because Sidebar explicitly excludes Both; the corrected case passes. Transcript continuity uses a real wheel gesture and waits for its exact scroll target before measuring; selection/search/scroll/draft retention passes. Settings return-focus and More containment are repaired: 35 integrated focus/ownership cases and 28 boundary/resize cases pass. CSS target-size/stacking/landscape repairs remain in progress. Genuine 200% browser zoom now passes both compact and Classic cases after correcting false software-keyboard detection; DPR doubles, layout width halves, visual scale stays 1 and the outer window stays unchanged. Draft, canonical controls, navigation, reset and cleanup pass. The historical worker results below are not a current whole-suite verdict.

[Contributor guide](../../DEVELOPMENT.md) · [Canonical plan](../../../plans/planned/webui-design-architecture-overhaul.md) · [Frozen layout reference](layout-baseline.md) · [Frozen capability reference](capability-browser-baseline.md)

This is W7-A11Y implementation evidence at base `3aaf11e70287a00b987c73ee0ffba9065f2d0969`. W0-W6 are accepted. W7 remains unaccepted, with zero review rounds used by this worker. The parent owns product repairs, reruns and acceptance. These tests preserve failing assertions and do not exempt baseline defects.

## Run the tests

The two new specs use the unchanged [session fixture](../../tests/browser/session-fixture.mjs). The worker ran them through an ignored `handoffs/w7-a11y/playwright.config.mjs` with one worker, zero retries, `/usr/bin/chromium`, a disposable HOME/XDG/agent root, blocked service workers, and JSON/trace/screenshot output below `test-results/w7-a11y/`. No dependency installation, live server, provider, companion, review or production change was involved. An ignored `node_modules` symlink reads the original checkout's dependencies.

From the repository root, with that ignored runner present:

```bash
node pi-package-webui/node_modules/@playwright/test/cli.js test --config handoffs/w7-a11y/playwright.config.mjs
```

The ignored runner is an execution artifact, not a package prerequisite. The specs also follow ordinary browser discovery. An integration runner must select the two files, use system Chromium when bundled browsers are unavailable, and retain failure artifacts. The handoff records exact commands, exits and artifact paths.

## What is covered

| Requirement | New checks | Earlier evidence retained |
| --- | --- | --- |
| Seven sizes | Classic, explicit Focused and independent compact v2 at 360×800, 390×844, 844×390, 768×1024, 1024×768, 1440×900 and 1920×1080 | W0 layout geometry and frozen screenshots |
| Layout ownership | Rotation, independent phone/tablet overrides, Classic recovery, one canonical composer/model/effort node, per-session drafts | Focused integration and mobile foundation specs |
| Navigation | Left/top session placement, eight sessions, long names, a persisted custom group, real session selection and source draft return | W0 group and deck recipes |
| Customized layout | Classic Left/Right/Both decks, keyboard section move, left tabs, persisted section order, reload, Focused entry and Classic rollback | Existing persistent-layout and deck suites |
| Split | Independent source/embedded drafts, real iframe controls, compact width release, restoration and session membership | W0-C-001 remains a failure recipe, not an exemption |
| Keyboard | Tab entry, Settings arrows/Home/End/search/Escape, inspector tab arrows/Home/End, All tools entry/arrows/Home/End, modal Tab/Shift+Tab, Escape and exact return focus | Existing controller tests are retained |
| Accessibility | WCAG 2 A/AA, 2.1 A/AA and 2.2 AA tags on changed destinations, every Settings category, launcher, directory dialog, matrix shells and compact sheets | Earlier scoped axe passes do not establish whole-shell conformance |
| Required controls | Viewport rectangles, center-point `elementFromPoint`, enabled/inert checks and real Playwright trial clicks; embedded controls also check the top-level iframe hit; seven streaming cases activate real hold-to-abort and verify its session target | No forced clicks, CSS repair or inherited axe rule disabling |
| Long content | 200 seeded history messages plus the fixture's real history, find count/highlight, exact Range, five streaming samples and settlement, scroll drift ≤1 CSS px; 120 real files, long names and retained dirty editor state | W0 long-content recipes and existing buffer/stream tests |
| Attention | Background approval discovery, exact request/tab response, toast-time navigation hits, foreground draft return; DOM lifecycle announcements separated from token output | W0 CAP-001/CAP-002 remain regression recipes |
| User preferences | Forced colors, visible keyboard focus, reduced-motion computed durations, genuine browser-zoom probe and separately labeled viewport reflow | No visual/performance threshold is invented |

The matrix's explicit Focused seed selects a browser preference. The session fixture prewrites settings and does not prove a new installation. Fresh/established cohort initialization and cross-origin rollout acceptance belong to W7-A/B/C.

## Real and simulated evidence

The server, routing, application DOM, keyboard events, CSS, hit tests, settings persistence, file listing/editor, streaming reconciliation and approval dispatch are real. Pi execution uses the existing fake process. Browser contexts and the server's projects/settings are disposable. Session API setup creates additional fixture sessions; it does not use real provider accounts.

The 200-message history is explicitly simulated at the existing `/api/messages` read boundary. The unchanged session fixture has no transcript option. The route prepends fixed history, preserves real fake-Pi messages, and provides consistent overlap/count metadata for delta reads. It does not intercept prompts, SSE, settlement or approval responses. This verifies renderer/selection/scroll behavior, not native provider history loading or durable storage of those 200 messages.

The files are written only under the fixture-provided temporary project directory. The long file is 180 lines. File loading, edits and retained selection/scroll use canonical controls. Unsaved content is not written to a user project.

Phone/touch contexts, forced colors, reduced motion and software-keyboard height reductions are Chromium emulation. The 390×500 and 844×220 cases resize the layout viewport while the composer is focused. They do not reproduce a native OS keyboard, visual-viewport-only occlusion, IME, physical touch, hardware safe areas or a screen reader. DOM live-region mutations establish announcement content, not spoken output.

The original worker browser-zoom probe dispatches Control+0 and five Control++ shortcuts, then measures DPR, inner width and visual viewport scale. A successful genuine 200% result requires both doubled DPR and halved CSS viewport width. An unchanged DPR/width is recorded as missing zoom evidence. The subsequent 720×450 case is viewport reflow only, never a browser-zoom pass. No CSS zoom, device-scale override or pinch emulation substitutes for it. The later [native zoom spec](../../tests/browser/overhaul-w7-zoom.spec.mjs) uses a disposable extension/profile with chrome.tabs.setZoom, verifies actual DPR/layout/outer-window behavior, and now supplies the genuine 200% evidence missing from that original shortcut probe. Both integrated cases pass in /tmp/webui-w7-native-zoom-fixed2.log.

Linux system Chromium is the only engine measured here. Native Android/iOS, Safari/WebKit, Firefox, Windows/macOS, physical keyboards/touch, installed companions, provider authentication, OS file pickers, microphone access and native PWA behavior remain unmeasured. Density, frozen performance budgets and duplicated summary measurement belong to W7-M. This work does not alter its denominator or thresholds.

## Result and readiness

Environment: Linux 7.2.14-zen1-1-zen, Node v26.13.1, system Chromium 157.0.8103.38, Playwright 1.62.1 and axe adapter 4.12.1. This is not a compatible performance comparison with W0's Node v22 capture, and no performance claim follows.

| Verification | Result |
| --- | --- |
| Last complete 43-case invocation | Exit 1; 14 passed, 29 failed, zero skips/retries |
| Three affected navigation/approval cases after final test corrections | Exit 1; 2 passed, 1 failed |
| Seven added streaming Stop cases | Exit 0; 7 passed at all planned sizes |
| Latest result for each of the 50 cases | 23 passed, 27 active failures; combined from those three invocations, not one clean suite run |
| JavaScript syntax, Markdown whitespace, relative links and fences | Passed |
| Production/shared fixtures/frozen reference changes | None |
| Genuine browser 200% zoom | Missing; DPR stayed 1 and viewport stayed 1440×900 |
| Native platforms and physical devices | Unmeasured |

The final corrections account for canonical session activation returning focus to the composer and use the actual `extensionDialog` element for the approval audit. The affected three cases were rerun. The passing approval case verifies blocked-session discovery, zero selected dialog axe violations, exact response request/tab identity, visible notification toasts, unobstructed bottom/top session navigation and foreground draft restoration. The left session/group case passes; the top group still fails its hit test.

Nine local finding groups remain for the parent. These identifiers belong to this workstream and do not replace the parent's existing bug numbers. Raw axe results retain every target and failure summary.

| Local finding | Severity | Observed failure | Source to investigate |
| --- | --- | --- | --- |
| BUG-001 | Major | `aria-required-children` on terminal tablist and empty Files/directory collections | `public/index.html`, `public/app.js` tab/file/directory renderers |
| BUG-002 | Minor | `target-size` on terminal action buttons and narrow legacy footer controls | Terminal action layout in `public/styles.css` |
| BUG-003 | Minor | `aria-prohibited-attr` on the generically marked `noticeToastStack` | `public/index.html` notification container |
| BUG-004 | Major | Returning from Settings by keyboard leaves the retained composer unfocused | `public/shell-workspace.mjs` focus restoration |
| BUG-005 | Major | Compact More sheet Shift+Tab moves to another document button outside the sheet | `public/shell-surfaces.mjs` and mobile surface integration |
| BUG-006 | Major | A top-navigation group item center hits `stickyUserPromptButton` | Session group menu and sticky prompt stacking |
| BUG-007 | Major | Classic Both deck setup reads back as Right after section keyboard movement | Control Deck layout/persistence integration in `public/app.js` |
| BUG-008 | Major | At 844×220 with attachment, the app bar covers prompt/attach hit targets | Mobile constrained-height styles; relates to W0-C-002 |
| BUG-009 | Major | With long history and find active, streaming moves manual scroll by 80 CSS px | Transcript find/scroll reconciliation in `public/app.js` |

The directory dialog also fails the strict Tab containment assertion when Chromium moves focus to browser chrome. Its samples show `documentFocused:false` and active BODY. This is recorded separately as a browser-boundary limitation requiring parent disposition. Compact sheet failures instead show `documentFocused:true` and an outside BUTTON. Neither assertion is exempted or marked expected failure.

The worker inspected and displayed representative launcher, forced-colors, phone, landscape-overlap, Classic layout, top-group and approval-toast screenshots. The launcher retains a visible keyboard outline; forced colors uses system colors; approval toasts leave the tested session navigation targets available. The constrained landscape image shows the composer under the app bar. These observations do not establish pixel equivalence with frozen screenshots or whole-product contrast compliance.

Artifacts are under ignored `test-results/w7-a11y/verified/`, `test-results/w7-a11y/navigation-approval/` and `test-results/w7-a11y/streaming/`; `latest-per-case.json` names the invocation supplying each case's current result. Preserve these directories before rerunning. Earlier harness-development runs remain in separate directories and are not acceptance evidence. The ignored handoff gives absolute paths, exact commands/exits and detailed repros.

Scoped verdict: FAIL for accessibility/responsive acceptance. The test implementation is ready for parent integration and repair reruns. The full package check, full Chromium suite and whole-W7 acceptance remain with the parent. No failed scenario was converted to an expected failure, no axe rule was disabled, and no production source, dependency range, frozen threshold or reference JSON changed.
