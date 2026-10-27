# Workbook Extension Implementation Status

Date: 2026-07-14
Release posture: **declared bounded implementation complete; do not publish until the external signed-VBA fixture gate passes**

`@firstpick/pi-extension-workbook` implements the cross-platform OOXML-safe P0-P3 scope and the P4 safety boundary. The canonical task tracker remains `docs/planned/spreadsheet-agent/PLAN.md`; this file records evidence, constraints, and the one remaining externally gated fixture.

## Implemented

- Six strict Pi tools: inspect, read, render, edit, diff, and validate.
- Backend-neutral versioned contracts, per-operation capability reporting, and fail-closed backend selection.
- Bounded lazy ZIP intake with traversal, encryption, ZIP64, entry-count, size, compression-ratio, XML, shared-string, style, and cell limits.
- Content-type and relationship-graph manifests, non-canonical VBA-part discovery, and protected-part SHA-256 gates.
- Literal/formula separation, external-data and DDE rejection, formula-function inventory, cached-result reporting, and preservation-only safeguards for shared/array/data-table/spill formula regions.
- Transactional values, formulas, clear, fill/copy, cross-sheet range templates, rich text, copy-format, full declared style patches, dimensions, outlines, deterministic autofit, structural row/column changes, merges, freeze panes, and sheet lifecycle/view operations.
- Conditional formatting, validation, filters, sort state, names, hyperlinks, legacy notes, tables, PNG images, chart creation/update, print settings, theme colors, calculation settings, and redacted sheet/workbook protection.
- Explicit preservation-only inventory for pivots/caches, slicers, timelines, sparklines, arbitrary shapes, form controls, ActiveX, embeddings, threaded comments, custom UI, and external connections.
- Deterministic bounded PNG previews and preview caching keyed by workbook hash, sheet/range, renderer version, and options.
- Mandatory commit hashes, destination mutation queueing, private staging, durable sibling writes, overwrite guards, and in-place recovery copies.
- A companion skill, `/workbook-doctor`, capability matrix, migration notes, package diagnostics, and VBA threat-model boundary.
- A disabled native Excel feasibility worker with forced macro security, source immutability checks, exact process ownership, abort/timeout cleanup, and no public mutation route.

## Verification evidence

| Check | Result |
|---|---|
| `npm run check` | PASS: strict TypeScript plus package/skill/tool/worker safety checks |
| `npm test` | PASS: 24 unit/integration/semantic/golden tests |
| `npm run test:pi-modes` | PASS: TUI, print, JSON, and RPC mode harnesses using a local mock provider |
| `npm run test:excel` | PASS on controlled interactive Windows/Excel |
| `npm run test:corpus` | `PASS_WITH_SIGNED_VBA_BLOCKER`: rich legal corpus and UI-aware repair-dialog gate passed |
| `npm run test:signed-vba` | `SKIP`: harness passed startup, but no legally sourced signed fixture was supplied |
| `npm run test:native` | PASS as a fail-closed harness; native failed strict no-op fidelity and remains disabled |
| `npm run pack:dry` | PASS: 46 runtime files, including workers, skill, and docs |
| `git diff --check` | PASS |

The controlled rich-corpus run generated `.xlsx` and real `.xlsm` files containing styles, themes, merges, formulas, tables, charts, a PivotTable/cache, images, shapes, form controls, ActiveX, an OLE embedding, custom ribbon XML, protection, hidden/very-hidden sheets, external links/connections, unsigned VBA, and macro/connection sentinels. OOXML no-op and bounded edits passed integrity checks for both formats. The UI-aware monitor detected zero modal repair windows, all six source/no-op/edited files opened read-only, no macro sentinel executed, source hashes stayed unchanged, and the local HTTP connection sentinel received zero requests. Excel chart exports and deterministic internal range renders were captured for visual comparison. Machine-readable evidence is in `tests/corpus/LAST-CORPUS-BAKEOFF.json`.

The ordinary controlled Excel run also passed for source/edited `.xlsx` and `.xlsm` with `AutomationSecurity=ForceDisable`, events and link updates disabled, and manual calculation. Evidence is in `tests/corpus/LAST-EXCEL-HOST-REPORT.json`.

The Pi mode harness loaded the package and observed tool/doctor behavior in TUI, print, JSON, and RPC without external model traffic or TUI-only dialog dependencies. Evidence is in `tests/corpus/LAST-PI-MODES.json`.

## Remaining external gate

A legally sourced signed-VBA `.xlsm` has not been supplied. Creating or importing a signing certificate and interacting with Office signing settings requires explicit user approval, so the implementation does not do that automatically and does not fabricate coverage.

The completed non-mutating harness accepts a user-supplied fixture:

```bash
npm run test:signed-vba -- C:\path\to\legally-sourced-signed.xlsm
# or set PI_WORKBOOK_SIGNED_XLSM_FIXTURE
```

It requires a discovered signature part, performs no-op and bounded-edit package checks, verifies protected-part byte identity and source immutability, and runs the UI-aware repair-dialog/macro-nonexecution monitor on controlled interactive Windows. A run without a fixture writes `LAST-SIGNED-VBA-REPORT.json` with `SKIP`, not a false pass.

Production publication remains blocked on this evidence. Additional representative enterprise workbooks remain desirable non-blocking corpus expansion.

## Intentional backend and VBA deferrals

- Native Excel mutation remains disabled. Its `.xlsx` no-op serialization changed merged-cell styles, and its `.xlsm` no-op serialization changed `xl/vbaProject.bin`; safety-harness success does not waive fidelity failure. See `tests/corpus/LAST-NATIVE-BAKEOFF.json`.
- Aspose.Cells remains an optional deferred capability tier. No license or Java/native runtime is installed automatically; the selected OOXML-safe backend and documented tiers satisfy the current cross-platform deliverable.
- VBA execution remains absent. OOXML-safe still reports only project/signature part metadata and hashes. Since 0.2.0, separate Windows-only `workbook_vba_*` tools list and edit modules through desktop Excel under the boundary in `docs/VBA-THREAT-MODEL.md`. Their real-Excel acceptance run (`npm run test:vba`) has not been performed; the user waived it for 0.2.0 on 2026-10-16.

## Bounded-fidelity constraints

The OOXML engine rewrites only parts declared by each operation and requires every protected active-content part to remain byte-identical after decompression. ZIP container metadata and compression bytes may change. ZIP64 and encrypted workbooks are rejected. Part-adding operations can fail for `.xlsm` when active-content preservation makes content-type or relationship parts immutable. Structural edits reject ambiguous objects/references. The internal renderer deliberately does not reproduce Excel charts/shapes, conditional-format evaluation, rich-text runs, or exact font metrics; controlled desktop Excel remains the independent repair/visual gate.
