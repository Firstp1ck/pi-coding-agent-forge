# Supplemental layout baseline

[Contributor guide](../../DEVELOPMENT.md) · [Original browser baseline](browser-baseline.md) · [Layout evidence](layout-baseline.json) · [Canonical plan](../../../plans/planned/webui-design-architecture-overhaul.md)

W0-C adds layout observations against unchanged production revision `06351edae0d87829dfa8c747d31a061825568b0e`, from integration base `ad514adba3f4e57c10c72b26eec0dce570eab30e`. It does not replace the original 42 images, crowding denominator, performance samples, or frozen budgets. No production code or shared fixture changed.

## Reproduce the capture

From `pi-package-webui`, using the existing development dependencies and `/usr/bin/chromium`:

```bash
node node_modules/@playwright/test/cli.js test --config playwright.overhaul-layout.config.mjs
```

Only the evidence owner should replace this supplement's committed JSON after inspecting a complete run:

```bash
PI_OVERHAUL_LAYOUT_UPDATE=1 node node_modules/@playwright/test/cli.js test --config playwright.overhaul-layout.config.mjs
```

The dedicated config runs 13 tests with one worker, no retries, bounded action/test timeouts, and no browser installation. It leaves ordinary browser discovery/configuration alone. Each scenario uses the existing isolated fixture's temporary server, fake Pi, three source sessions, short transcript, and local Git project. Each nonpersistent context uses UTC, English labels, reduced motion, and blocked service workers. Fixture teardown terminates only its process group and deletes only its temporary root.

Artifacts live in ignored `test-results/overhaul-baseline/layout-<timestamp>/`. Each screenshot has a raw measurement JSON; each scenario has its own JSON; `layout-report.json` combines the complete run. The committed JSON records screenshot references, source revision, setup, actions, control geometry, script errors, persistence checks, defects, and missing checks. Successful trial-click results are included in the combined report. Raw snapshots precede those click trials. Playwright failure artifacts use the separate ignored `layout-playwright/` directory.

## Coverage and meaning

| Scenario | Setup and checks |
| --- | --- |
| Top tabs, Right deck | Actual layout selects; Files reorder; persisted settings after reload; expanded Controls and collapsed sections; deck collapse and recovery control |
| Top tabs, Left deck | Same checks in Catppuccin Latte, covering the changed left-side region in a light theme |
| Top tabs, Both decks | Files moves into the left deck using Alt+Left; custom theme and normal one-pixel background upload; reload and collapse checks |
| Left tabs, Right and Left decks | Actual selects and persisted customization; rail and opposite deck arrangements; collapsed deck recovery |
| Populated groups | Six isolated sessions in two named groups of three, persisted through the real preferences API; each real group menu expands and every session remains present |
| Explicit split | Actual Split action creates an independent fourth session; distinct source/split drafts; 1920×1080, 1200×768, 1024×768, and 720×450; closing the split presentation retains all four sessions |
| 200% reflow stress | Bounded browser zoom shortcut attempt; measured fallback at 720×450 if actual zoom is unavailable |
| Keyboard-constrained phone | Legacy and v2 separately; 390×844 reduced to 390×500 and 844×390 reduced to 844×220; focused draft and attachment before, during, and after constraint |
| Parent BUG-002 | Tablet v2 at 768×1024; initial clipping, then separate geometry after trial-click automatic scrolling |

Left session tabs with Both decks is an existing unsupported combination: the current app disables Both while tabs are at the left. The harness does not force that state. The split iframe uses the app's existing `embed=split` route and independently created session; the transcript is the fake Pi's ordinary short transcript, not cloned source history.

Every required control is measured by rectangle, viewport containment, ancestor clipping, center-point hit test, disabled/inert state, and a Playwright trial click. Trial clicks test actionability without sending a prompt or opening a file picker. Split iframe measurements include translated outer-page rectangles and outer-page hit testing, so fitting the iframe's own viewport cannot hide clipping in its host. Desktop expanded Controls also measures model and effort selectors. Successful screenshots alone do not establish reachability. Document horizontal overflow is retained only as supplemental evidence.

Default dark, light Left, and custom Both appearances cover changed regions. This supplement does not repeat the original idle/streaming/blocker matrix. No catalog response is simulated and no installed companion is verified here.

## Zoom and keyboard limits

The actual zoom attempt resets with Ctrl+0, sends five Ctrl++ shortcuts, and compares `devicePixelRatio`, `innerWidth`, and `visualViewport` before and after. On this headless Chromium run, DPR and viewport dimensions did not change, so **true 200% browser zoom remains missing**. The fallback halves a 1440×900 CSS viewport to 720×450, while DPR and visual viewport scale stay 1. This provides reproducible reflow stress. It does not emulate browser chrome zoom, CSS `zoom`, pinch zoom, or a higher device scale.

The phone test focuses the real composer and reduces the layout viewport height without changing width. Chromium reports the same reduced layout and visual viewport heights, visual scale 1, and keyboard inset 0. The app's remembered maximum-height heuristic activates `mobile-keyboard-open`; no JavaScript override fakes that class or viewport API. This checks resize-driven constrained layout. It does not establish visual-viewport-only keyboard occlusion, real OS keyboard behavior, native input methods, browser toolbar movement, safe areas, or native mobile engines. Those remain W7 device checks.

## Recorded product failures

Passing tests below mean that the recorded failure was reproduced. They do not mean these layouts pass product acceptance. Local W0-C identifiers are distinct from the parent's bug numbering.

| Bug | Severity | Module | Status | Summary |
| --- | --- | --- | --- | --- |
| W0-C-001 | Major | Classic split/narrow layout | Open | Split disappears at 1050px and below while primary chat retains half the workspace |
| W0-C-002 | Major | Phone v2 constrained landscape | Open | Status strip intercepts prompt and attachment control |
| BUG-002 | Major | Existing tablet v2 | Open, parent-owned | Rail offset places the attachment control beyond the viewport |
| W0-C-003 | Major | Classic sidebar layout | Open | Sidebar tabs with Right deck leave less than 500px for the transcript at 1920px |

## W0-C-001: Hidden split leaves half the narrow workspace unused

**Severity:** Major
**Module:** Classic split/narrow layout
**Spec Reference:** W0 explicit split/narrow baseline; W3 layout and W7 resize regression targets.
**Found During:** `explicit split at wide and narrow widths retains source sessions`.

### Reproduction Steps

**Preconditions:** Unchanged source, isolated fixture, Chromium, desktop context at 1920×1080 with `tabletShell=legacy`.

1. Type a source draft and click that session's actual Split button.
2. Type a different draft inside the independent split session.
3. Resize to 1024×768, then 720×450.

### Expected Result

The explicit split stays reachable, or the primary conversation reclaims the hidden pane's space. Original sessions and drafts remain available.

### Actual Result

At both narrow widths, `.terminal-split-shell` has `display: none` and the close-split control has a zero rectangle. The primary chat remains in approximately half the workspace. Both drafts and all session IDs survive; restoring 1920px restores the split.

**Evidence:** `layout-split` in [layout-baseline.json](layout-baseline.json), including screenshots, primary rectangles, hidden control geometry, source IDs, final IDs, and reproduction steps. No browser script error accompanies the failure.

### Environment

Linux x64, Node and Chromium versions recorded in the JSON; temporary fixture settings and nonpersistent browser context. No optional companions.

### Analysis

**Likely root cause:** Existing CSS hides the split at widths up to 1050px while the split-open workspace still uses two columns. No production fix was attempted.
**Related bugs:** Parent BUG-002 concerns a separate tablet-v2 offset.
**Workaround:** Return to a width above 1050px, close the split, then resize. W3 owns the layout correction; W7 should verify transitions and session retention.

## W0-C-002: Phone v2 status strip covers constrained composer controls

**Severity:** Major
**Module:** Phone v2 constrained landscape
**Spec Reference:** W0 keyboard-open baseline; mandatory composer and attachment reachability; W3/W7 regression targets.
**Found During:** `keyboard-constrained phone v2 landscape`.

### Reproduction Steps

**Preconditions:** Unchanged source, isolated fixture, mobile Chromium emulation, `mobileShell=v2`, 844×390 viewport.

1. Type a draft and attach `layout-context.txt` through the real file input.
2. Keep the prompt focused.
3. Reduce viewport height to 220px without changing width.

### Expected Result

Prompt and attachment controls remain visible and can receive pointer input with the draft and attachment preserved.

### Actual Result

Prompt and attachment rectangles lie within the viewport, but their center-point hit target is `mobileShellIndicators`. Bounded trial clicks fail because that strip intercepts pointer events. The send button and attachment tray remain reachable. The draft and attachment survive restoration to 844×390. Legacy landscape and both portrait presentations pass this constraint.

**Evidence:** `layout-keyboard-v2-landscape` in [layout-baseline.json](layout-baseline.json), including exact rectangles, screenshot and both failed click traces. Document overflow is zero, which misses this obstruction.

### Environment

Same recorded machine/browser as other scenarios; touch/mobile viewport emulation, visual scale 1, no native keyboard.

### Analysis

**Likely root cause:** Existing app-bar/status geometry overlaps the composer under short landscape height. The exact CSS correction was not investigated here.
**Related bugs:** Parent BUG-002 is another narrow-layout mandatory-control failure.
**Workaround:** Restore available height, rotate to portrait, or use Legacy for this constrained case. W3 owns the layout fix; W7 should repeat it with real keyboards and devices.

## BUG-002: Parent tablet attachment clipping remains reproducible

**Severity:** Major
**Module:** Existing tablet v2
**Spec Reference:** Parent Execution record BUG-002; W3 layout fix and W7 narrow-screen regression.
**Found During:** `parent BUG-002 tablet-v2 attachment clipping characterization`.

### Reproduction Steps

**Preconditions:** Unchanged source and isolated fixture.

1. Open `tabletShell=v2` at 768×1024.
2. Measure the attachment button and attempt a bounded trial click.

### Expected Result

The attachment button fits inside the viewport and can receive a click.

### Actual Result

The button begins beyond the 768px right edge. Playwright's trial click automatically scrolls the layout sideways and then succeeds. The initial clipped geometry and the separate screenshot/geometry after that scroll remain recorded under `layout-tablet-v2-bug-002` in the JSON. That automation-induced movement does not establish that the initial layout fits, or that a native user can recover it. This repeats the parent's existing defect without fixing or renumbering it.

**Evidence:** [layout-baseline.json](layout-baseline.json). The original browser baseline explains why document overflow alone missed it.

### Environment

Same recorded machine/browser, desktop tablet viewport, explicit tablet-v2 opt-in.

### Analysis

**Likely root cause:** Existing full-width layout retains the tablet rail's horizontal offset.
**Related bugs:** Parent BUG-002 is the canonical finding.
**Workaround:** Existing Legacy tablet presentation. Production correction belongs to W3, with W7 regression coverage.

## W0-C-003: Sidebar tabs with Right deck consume most conversation space

**Severity:** Major
**Module:** Classic sidebar layout
**Spec Reference:** W0 top/left and deck baseline; compact workspace constraint; W3 layout and W7 placement regression targets.
**Found During:** Final screenshot inspection of `layout-classic-left-right`, followed by region measurement.

### Reproduction Steps

**Preconditions:** Unchanged source and isolated fixture, 1920×1080 desktop viewport, default sidebar width.

1. Expand Controls and choose the Right deck.
2. Choose Sidebar for tab placement.
3. Reload after persistence and inspect the session rail and conversation.

### Expected Result

The session sidebar keeps a compact width, leaving most available space to the conversation.

### Actual Result

The session rail exceeds 900px while the transcript is less than 500px wide, despite the 1920px viewport. Mandatory composer/model/effort controls remain reachable. Collapsing the deck leaves the rail oversized. This is a layout defect even though mandatory-control geometry passes.

**Evidence:** `layout-classic-left-right` in [layout-baseline.json](layout-baseline.json), with exact rail/transcript rectangles, computed grid columns, sidebar width property and customized/collapsed screenshots.

### Environment

Same recorded Chromium/Linux environment; persisted tab placement; no custom sidebar resize and no companions.

### Analysis

**Likely root cause:** Existing sidebar-start grid sizing differs from the compact rail used with a Left deck. No production cause or correction was isolated.
**Related bugs:** W0-C-001 also leaves disproportionate space outside the primary conversation.
**Workaround:** Use top tabs or a Left deck. W3 owns the layout correction; W7 should cover deck placement and collapse transitions.

## Handoff limits

This supplement is ready for parent inspection after the focused suite and integrity checks pass. It is not whole-W0 acceptance, a production release gate, or a reviewer pass. The full Node suite, capability/companion coverage, long transcripts, and native device checks belong to their existing owners. No manifests or first-party dependency ranges changed.

Screenshots and raw artifacts are ignored and must be copied separately to the integration worktree while preserving their directory names. Original W0-B screenshot artifacts are absent from this isolated checkout; their committed reference JSON remains intact. The unique ignored handoff lists unavailable original artifact paths and records validation commands, result revision, representative images, and integration notes.
