# Development guide: Workbook for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Development

```bash
npm install
npm run check
npm test
npm run test:excel       # controlled interactive Windows/Excel host only
npm run test:corpus      # rich legal corpus + UI-aware repair-dialog gate
npm run test:signed-vba -- C:\\path\\to\\signed.xlsm  # user-supplied legal fixture
npm run test:native      # controlled native feasibility bakeoff; public mutation remains disabled
npm run test:pi-modes    # TUI, print, JSON, and RPC harness
npm run pack:dry
```

See `skills/workbook-editor/SKILL.md` for the agent workflow, `docs/ADR-0001-primary-backend.md` for backend scope, and `docs/IMPLEMENTATION-STATUS.md` for passed and deferred release gates.

## Mock provider contract

`tests/pi/mock-provider.ts` accepts normalized `TranscriptContext` values. Before emitting a tool call, it requires a non-empty `PI_WORKBOOK_TEST_PATH`; missing or blank values produce a terminal error event instead of an `undefined` tool argument. Valid paths are preserved exactly. `tests/mock-provider.test.mjs` checks missing and blank values, JSON-compatible arguments, and completion after a tool result without calling a model or opening a workbook.

## Additional implementation details

The enabled engine is a bounded, cross-platform OOXML-surgical implementation with an explicit operation matrix. Native Excel mutation is disabled after strict no-op fidelity failures, and Aspose is an optional deferred tier. The declared implementation is complete, but publication remains blocked until a legally sourced signed-VBA fixture passes the supplied harness; see `docs/IMPLEMENTATION-STATUS.md`.

| Capability | Status |
|---|---|
| `.xlsx` inspect/read/render/validate/diff | Implemented |
| `.xlsm` inspect/read/render/validate/diff | Implemented with protected-part hashing |
| Values, formulas, rich formatting, dimensions, layout, and bounded structural edits | Implemented with fail-closed per-file checks |
| Conditional formats, validation, names, links, notes, tables, print/theme/protection settings | Implemented within documented OOXML mutability constraints |
| PNG insertion/replacement and chart creation/update | Implemented when required parts are mutable; controlled-Excel rendering verifies corpus charts |
| VBA preservation | Byte-identity gate; never executed or source-edited; signed fixture publication gate remains open |
| Pivots/caches, slicers, timelines, arbitrary shapes, controls, ActiveX, embeddings, threaded comments, custom UI | Inventory and preservation-only |
| Native Excel mutation | Disabled; candidate worker failed strict `.xlsx`/`.xlsm` no-op fidelity |
| Aspose.Cells mutation | Disabled; license/runtime not provisioned |
| ZIP64 or encrypted workbooks | Rejected |

## Preserved advanced implementation details

Fail-closed Pi tools for inspecting, reading, rendering, editing, diffing, and validating `.xlsx` and `.xlsm` workbooks.

## Safety contract

- Macros are preserved and hashed but never executed or edited.
- External links and data connections are never refreshed.
- Literal values and formulas are separate operations.
- Every commit requires the SHA-256 returned by inspection or dry-run.
- Editing defaults to a new file; overwrite is explicit, queued, validated, and recoverable.
- Unsupported operations are rejected before any destination is committed.

## Tools

- `workbook_inspect`
- `workbook_read`
- `workbook_render`
- `workbook_edit`
- `workbook_diff`
- `workbook_validate`
