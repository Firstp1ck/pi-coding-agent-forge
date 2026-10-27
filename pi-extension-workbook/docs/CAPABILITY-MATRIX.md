# Workbook capability matrix

Date: 2026-07-14

Capabilities are selected per file and per requested operation. `supported` never means “best effort”: an operation is rejected before commit when its required OOXML parts are protected, structurally ambiguous, encrypted, ZIP64, oversized, or otherwise outside the declared boundary.

## Platform tiers

| Tier | Availability | Mutation posture |
|---|---|---|
| Tier 1 — `ooxml-safe` | Node.js 24+ on Windows, Linux, and macOS | Enabled for declared surgical operations on `.xlsx` and `.xlsm`; all baseline protected active-content parts remain byte-identical. |
| Tier 2 — native Excel | Controlled interactive Windows only | Disabled. The safety harness passed, but strict no-op `.xlsx` and `.xlsm` fidelity failed. It is not selected by public tools. |
| Tier 2b — VBA module editing | Interactive Windows with desktop Excel and user-enabled programmatic VBA project access | Separate `workbook_vba_read`/`workbook_vba_edit` tools. Off until the user allows it for the session or persistently; every commit needs its own approval dialog. Excel's full save is accepted and unrelated part changes are reported. Real-Excel acceptance pending. |
| Tier 3 — Aspose.Cells | Not provisioned | Explicitly deferred; no license or Java/native runtime is installed automatically. |

## Operation matrix

| Family | `.xlsx` | `.xlsm` | Important constraints |
|---|---|---|---|
| Values, formulas, clear, fill/copy | Bounded | Bounded | Cross-sheet `copyRange` provides range templates. External-data and DDE formulas are rejected; shared/array/data-table/spill regions are preservation-only; no recalculation. |
| Font, rich text, pattern fill, diagonal/all-edge borders, alignment, rotation, number format, cell protection | Bounded | Bounded | Exact Excel font metrics and locale rendering require independent Excel verification. |
| Row/column size, hide, outline, deterministic autofit, freeze panes | Bounded | Bounded | Autofit is text-length based and reports a warning. |
| Insert/delete rows/columns | Bounded | Bounded | Rejected when drawings, tables, controls, OLE, extension lists, shared/array formulas, external workbook references, or intersecting range metadata make reference rewriting unsafe. |
| Sheet create/delete | Bounded | Usually rejected | Adding/removing worksheet parts changes workbook relationships and content types. An `.xlsm` whose active-content graph protects those parts fails closed. |
| Sheet rename/reorder/state/tab/view | Bounded | Bounded | Keeps one visible sheet and rewrites bounded local references. |
| Conditional formatting and data validation | Bounded | Bounded | Exact-range replacement/append only; overlapping non-identical ranges are rejected. |
| Filters, sort state, defined names, hyperlinks | Bounded | Bounded | Hyperlinks are stored but never followed. External relationships are never refreshed. |
| Legacy comments/notes | Bounded | Existing-part edits only when protected package metadata need not change | Threaded comments are preservation-only. |
| Tables | Add/remove | Existing-part edits only when protected package metadata need not change | Part-adding/removal operations fail when `[Content_Types].xml` or sheet relationships are protected. |
| PNG images | Insert/replace | Replace an existing unprotected image; insertion usually rejected | PNG only; no SVG/EMF conversion. |
| Charts | Create/update source/title/style | Update an existing unprotected chart; creation usually rejected | Column, bar, line, pie, and area creation. Formula caches are not refreshed. |
| Print area/titles, margins, orientation, scaling, headers/footers, page breaks | Bounded | Bounded | Stored as OOXML; desktop pagination remains printer/font dependent. |
| Theme color slots | Existing theme only | Existing unprotected theme only | Adds no implicit theme. |
| Sheet/workbook protection | Bounded | Bounded | Passwords are legacy-hashed in memory, never returned/logged; disable operations emit destructive warnings. |
| Calculation settings | Bounded | Bounded | Formula caches are preserved; external data is never refreshed. |

## Preservation-only features

PivotTables, pivot caches, slicers, timelines, sparklines, arbitrary shapes, form controls, ActiveX, OLE embeddings, threaded comments, custom ribbons, external connections, and unsupported extension parts are inventory-only or preservation-only. The manifest and relationship graph make unexpected additions/removals/changes fail validation.

## Rendering and scale

- Focused semantic reads use bounded, lazy ZIP inflation and configurable archive/XML/shared-string/style/cell budgets.
- Formula inspection inventories function names, `_xlfn`/`_xlws` future-function markers, array/shared/dynamic counts, and cached-result coverage; the OOXML backend deliberately has no evaluator.
- Preview PNGs are deterministic and cached by workbook SHA-256, sheet, range, renderer version, and scale.
- The internal renderer does not claim Excel-equivalent chart, shape, rich-text, conditional-format, or font-metric rendering.
- Full structured output is written to a private temporary artifact whenever visible output is truncated.
