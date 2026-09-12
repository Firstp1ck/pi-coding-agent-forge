# Full offline corpus evaluation

[Contributor guide](../DEVELOPMENT.md) · [Historical guide-only evaluation](evaluation.md)

## Result and scope

Version 0.2.0 downloads the newest published Quickshell guides and full published API together with core Qt UI references. The evaluated collection contains **992 pages**: 8 guides, 168 Quickshell API/module pages and 816 Qt pages.

Confidence is **94/100 for the documented acquisition and retrieval scope**. This is not a claim that every upstream member is fully explained, that all of Qt is mirrored, or that an arbitrary desktop shell has been runtime-tested.

## Corpus profile

| Property | Observed value |
| --- | --- |
| Evaluation date | 2026-09-12 |
| Quickshell discovery | Official `sitemap-index.xml` and `sitemap-0.xml` |
| Selected newest published release | `v0.3.1` |
| Latest mode | Numeric highest published stable version, not source-repository default |
| Selected Quickshell guide/API inventory | 176 URLs, all downloaded and parsed |
| Quickshell guide count | 8 |
| Quickshell API/module count | 168 |
| Qt discovery | Core QML/Quick/Controls/Layouts seeds and linked in-scope QML/Quick pages |
| Qt pages | 816 |
| Qt advertised versions | `6.11`, `6.11.2` |
| Received response data | 45,196,807 bytes in the first full download |
| Representation | Rendered HTML converted to text Markdown plus source/version/member-anchor metadata |
| Storage | Immutable snapshots in `<base>.offline`, active pointer and retained previous snapshot |
| Excluded | Images, video, styles, executable examples, unrelated Qt C++ modules and third-party manuals |
| Optional upstream dead links | One: `https://doc.qt.io/qt-6/qml-qtquick-timer.html`, HTTP 404 |
| Correct Timer reference | `https://doc.qt.io/qt-6/qml-qtqml-timer.html`, required and downloaded |

The source repository's metadata listed default `v0.3.0` and omitted v0.3.1. The live site's sitemap listed 177 URLs under v0.3.1, of which 176 were guide/API pages and one was the release landing page. The setup now discovers actual publication availability, correcting the earlier repository-only diagnosis.

## Parser and search evidence

Quickshell type pages put property/function/signal descriptions in `typedata-root` list elements rather than ordinary headings. The parser promotes those members to sections and preserves their original anchors. For example, `PwNodeAudio.volume` retains its `PwObjectTracker` binding warning and the difference between average volume and per-channel volumes.

Qt headings retain IDs such as `moved-signal` and `value-prop`. Slider's signal documentation states that `moved` represents interactive user movement and identifies `onMoved`. API code examples preserve indentation and rendered type names instead of source-only `@@Type` markup. Navigation, SVG icon titles and scripts are excluded.

Initial substring ranking placed RangeSlider and all-members pages above Slider. An exact type-name bonus moved the actual Slider reference to rank one. It also moved the SystemTray singleton above the SystemTray module listing. Broad `qt` and `qml` terms were downweighted after the expanded corpus showed they match most Qt titles; Quickshell's existing broad-term weight remains. Source filters prevent tutorial, API and Qt reference searches from competing unnecessarily.

## Seven realistic simulations

Each simulation ran search, listed headings, then extracted an exact section or member anchor. All canonical documents ranked **first**. Every listed section set and extract had **zero omissions** and **no truncation**. Scores are evidence judgments, not probabilities or live-model success rates.

Sizes below measure serialized JSON bytes; extract characters count only text. The test script contains each prompt, query, source, page, anchor and decisive text assertion.

| Level / task | Query and source | Selected document / anchor | Headings | Search bytes | Sections bytes | Extract chars / bytes | Accuracy / effectiveness / token output |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Novice installation | `installation Arch`, guide | Installation & Setup / Arch | 20 | 1038 | 2372 | 642 / 1509 | 95 / 94 / 96 |
| Beginner panel sizing | `PanelWindow anchors`, API | PanelWindow / anchors | 10 | 1506 | 1645 | 661 / 1588 | 95 / 94 / 96 |
| Intermediate audio | `PwNodeAudio volume`, API | PwNodeAudio / volume | 7 | 1567 | 1398 | 315 / 1235 | 96 / 95 / 96 |
| Advanced tray menu | `SystemTrayItem display`, API | SystemTrayItem / display | 20 | 1541 | 2756 | 319 / 1324 | 95 / 94 / 96 |
| Advanced battery state | `UPowerDevice percentage`, API | UPowerDevice / percentage | 20 | 1581 | 2812 | 315 / 1261 | 93 / 93 / 96 |
| Expert shell IPC | `IpcHandler`, API | IpcHandler / Example | 11 | 835 | 1660 | 1343 / 2279 | 95 / 94 / 96 |
| Qt control behavior | `Qt QML Slider`, Qt | Slider / moved-signal | 29 | 1575 | 3949 | 279 / 1235 | 95 / 94 / 96 |

### Top results

1. Installation: Installation & Setup 45; Usage Guide 1; Introduction 1. Only three matching guide pages.
2. Panel: PanelWindow 101; WlrLayershell 14; ExclusionMode 4; PersistentProperties 4; Quickshell Module Types 3.
3. Audio: PwNodeAudio 101; MprisPlayer 17; PwNode 9; Pipewire Module Types 2; PwAudioChannel 2.
4. Tray: SystemTrayItem 96; UPower 12; DesktopEntry 11; QsMenuEntry 11; Windowset 10.
5. Battery: UPowerDevice 100; UPowerDeviceState 44; UPowerDeviceType 44; UPower 12; UPower Module Types 6.
6. IPC: IpcHandler 84; Quickshell.Io Module Types 2. Only two matching API pages.
7. Slider: Slider 117.5; RangeSlider 77.5; Qt singleton 67.5; RangeSlider all-members 66.3; Slider all-members 66.3.

Page source URLs are retained in the snapshot and evaluation script output. Numeric citation filenames are snapshot-local; use the returned path and source URL rather than assuming a stable filename across updates.

## Integration and recovery evidence

- A fresh Python setup produced all 992 documents and passed the 17-check full-corpus smoke test.
- The actual TypeScript `executeSetup` wrapper downloaded the same 992-page corpus beside an existing guide clone. Git status before and after was unchanged.
- A pinned `v0.3.0` setup produced 991 pages: 8 guides, 167 Quickshell API pages and the same 816 Qt pages.
- The actual rollback command restored the retained v0.3.1 snapshot and its 992 pages without a download.
- Unit fixtures cover failed required downloads, optional Qt 404s, malformed HTML, invalid URLs, unpublished versions, concurrent setup locks, page budgets, corrupt snapshots and pointer/citation traversal.
- Lookup tests disable the JavaScript fetch seam while exercising search, sections, extraction and cross-source related links. Retrieval does not invoke the Python downloader or any network helper.
- Required Quickshell types cover panels, clock, process/IPC, audio/tracking, media, tray, battery, notifications and Hyprland. Required Qt types include Item, MouseArea, Timer, Button, Slider, Popup and RowLayout.

## Checks and review disposition

The validation suite consists of 27 TypeScript/Bun tests and 11 Python tests. The feature also has a real-corpus evaluation, no-emit TypeScript check, Bun build, package dry-run, wiki validation and documentation checks. Results are recorded in the implementation plan/report.

The user explicitly waived delegated implementation and the independent-review quorum. There were no independent reviewer runs. Main-agent self-review found and addressed:

| Finding | Disposition and evidence |
| --- | --- |
| Repository release metadata did not reflect the published site | Accepted. Sitemap-based discovery selected v0.3.1; pinning and rollback exercised both published releases. |
| Generic HTML headings would omit API members | Accepted. Type-member sections and original anchors added; PipeWire warning and Qt moved signal extracted exactly. |
| Slider/RangeSlider/all-members substring ties | Accepted. Exact-type bonus added and ranking regression test passes. |
| Metadata could claim source counts inconsistent with records | Accepted. Source-kind, version, uniqueness and counts are validated; inconsistent-count fixture is rejected. |
| A post-publication error could remove a newly active snapshot | Accepted. Cleanup checks publication state and never removes an already published directory. |
| Upstream Qt Window module seed was nonexistent | Accepted. Replaced the invalid module-index seed with the current Window type page after verifying it. |
| Optional obsolete Timer link | Explicitly reported, not rewritten silently. The correct required Timer reference is present. |

## Remaining caveats

- All sitemap-listed selected Quickshell guides/API pages were downloaded. This does not prove that the upstream sitemap exposes every unpublished or hidden document.
- Qt is a bounded core UI/reference closure, not every module or every external protocol manual.
- Upstream API gaps remain visible. In particular, `MprisPlayer.canControl` says "No details provided"; the evaluator explicitly checks that this is preserved.
- These are deterministic retrieval simulations, not autonomous model coding trials. No widgets were launched, and no complete shell was runtime-tested.
- Latest Qt documentation may be newer than installed Qt. `sourceVersion` and installed `.qmltypes` provide separate checks, not automatic compatibility guarantees.
- Live setup and offline retrieval were tested through the implementation functions. Interactive TUI rendering, npm-installed sessions and non-Linux platforms were not exercised.
- The collection preserves source URLs and text but omits multimedia and browser presentation. Upstream copyright/licensing still applies to downloaded content.
- Repeated snapshots consume disk space; no automatic pruning is implemented. Abrupt termination can leave a lock requiring inspection.

Final scoped scores: **accuracy 95/100, effectiveness 94/100, token output 96/100**. Overall confidence: **94/100**.
