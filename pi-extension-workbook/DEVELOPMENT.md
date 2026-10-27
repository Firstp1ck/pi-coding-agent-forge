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
npm run test:vba         # controlled interactive Windows/Excel host only; VBA add/replace/remove acceptance
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
| VBA preservation | Byte-identity gate for every `workbook_edit`; never executed; signed fixture publication gate remains open |
| VBA module editing | Separate `workbook_vba_*` tools on Windows Excel; user-approved, read-back verified; real-Excel acceptance pending (`npm run test:vba`) |
| Pivots/caches, slicers, timelines, arbitrary shapes, controls, ActiveX, embeddings, threaded comments, custom UI | Inventory and preservation-only |
| Native Excel mutation | Disabled; candidate worker failed strict `.xlsx`/`.xlsm` no-op fidelity |
| Aspose.Cells mutation | Disabled; license/runtime not provisioned |
| ZIP64 or encrypted workbooks | Rejected |

## Preserved advanced implementation details

Fail-closed Pi tools for inspecting, reading, rendering, editing, diffing, and validating `.xlsx` and `.xlsm` workbooks.

## Safety contract

- Macros are never executed. `workbook_edit` preserves and hashes them; only `workbook_vba_edit` changes VBA, behind per-call user dialogs.
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
- `workbook_vba_read`
- `workbook_vba_edit`

Commands: `/workbook-doctor`, `/workbook-vba [status|enable|disable]`.

## VBA editing implementation

User decisions and the full design record are in the repository plan `plans/planned/workbook-authorized-vba-editing.md` (archived to `plans/archive/` after completion). Summary of the contract:

### Layers

| File | Responsibility |
| --- | --- |
| `workers/excel-vba.ps1` | PowerShell 5.1 worker: `probe`, `list`, `edit`. Same harness as `excel-native.ps1` (owned Excel PID via `Hwnd`, control file, `AutomationSecurity=3` before any open, events/links/alerts off, manual calculation, read-only opens, sentinel check, source hash before/after). Edits use `VBComponents.Add`/`Remove` and `CodeModule.DeleteLines`/`AddFromString`, `SaveAs(staged, 52)`, then reopen the staged file read-only and list every module. |
| `src/vba/limits.ts` | Pure operation types, `VBA_LIMITS`, `vbaCodeSha256`, `validateVbaOperations`; no subprocess imports. Schemas import limits directly. |
| `src/vba/preflight.ts` | Pure source-package checks before any backend call in read/edit: reject XLM macro-sheet relationship/content types and refresh-on-load declarations in connections, pivot cache, or query table XML. XML parsing uses the archive's per-part limit; archive entry and uncompressed-byte limits bound the scan. |
| `src/backends/excel-vba.ts` | Frozen `VbaBackend` interface and `createExcelVbaBackend`; re-exports pure limits/validation/hash/operation type for compatibility. Spawn/timeout/abort reuse the exported `excel-native.ts` cleanup helpers (PID + start-time verified). Defaults: probe 30 s, list 60 s, edit 120 s. Non-`win32` rejects `BACKEND_UNAVAILABLE`. |
| `src/vba/service.ts` | `VbaService.read/edit`: path and extension rules, hash binding, signature detection (relationship last-segment `vbaProjectSignature` prefix and content types, case-insensitive, plus `xl/vbaProjectSignature*.bin` fallback), shared by output reporting and related-part filtering, plan against the listed project, dialogs, mutation queue on the output path, staged edit in a private temp dir, read-back and untouched-module verification, `validatePackage`, `compareIntegrity` for `changedParts`/`unrelatedChangedParts`, exclusive publish with `COPYFILE_EXCL` + fsync. |
| `src/vba/approval.ts` | Pure dialog text. Required metadata never truncated; over 6000 chars → `LIMIT_EXCEEDED`. Previews show complete lines only, with “Showing N of M lines; run the dry run to see the full code.” Dry runs return full validated submitted code; commit operation summaries omit code. |
| `src/vba/settings.ts` | `PI_WORKBOOK_VBA_EDITING` via `resolveEnvValue` (process env, then Pi global `.env`); in-memory session flag reset on `session_start`. |

### Invariants

- Approval comes only from `ctx.ui.confirm` inside the tool call; schemas have no approval or overwrite field. `ctx.hasUI === false` (print mode) → `AUTHORIZATION_REQUIRED` once preflight/backend planning succeeds. RPC hosts answer dialogs and must present them to a person; the host is part of the trusted UI boundary.
- The extension factory optionally accepts a VBA backend factory, defaulting to `createExcelVbaBackend`; tool-wiring tests inject a fake backend and never launch Excel.
- Source SHA-256 is checked at request, before planning, after approval, inside the queue, by the worker before open and before save, and after the worker returns.
- Code hash normalization: CRLF/CR → LF, strip trailing newlines, SHA-256 of UTF-8, lowercase hex. After each add/replace the worker captures the in-memory stored code hash; reopened output must match it exactly. The worker does not compare against approved text. Its `after` inventory includes full code for edited modules (16,777,216-character total read budget, with existing stdout bound still enforced).
- Service `verifyAfter` requires nontruncated code consistent with its reported hash for every added/replaced module, even on an exact approved-hash match. Otherwise it accepts only formatting equivalence: per-line trim, collapse runs of spaces/tabs, lowercase, ignore blank leading/trailing lines and one leading `Option Explicit`. This is a textual rule, not semantic validation. A tolerated difference adds a warning containing `approvedCodeSha256` and `storedCodeSha256`; both hashes also appear in the operation summary. Other differences fail `VALIDATION_FAILED` before publication.
- Worker default error code is `BACKEND_UNAVAILABLE` during Excel startup, `INVALID_ARGUMENT` while validating/applying operations, and `VALIDATION_FAILED` while saving/reopening/reading back. Explicit failures retain their specific codes. `Get-VbaProject` translates only “not trusted” / “Programmatic access” or HRESULT `0x800A03EC` into the Trust Center guidance and rethrows other errors.
- `workbook_edit` and `src/ooxml/package-edit.ts` protected-part checks are unchanged. The VBA path reports, but does not enforce, `compareIntegrity` differences (user decision: keep Excel's full save).
- `scripts/check.mjs` keeps the native worker's `VBProject|CodeModule` ban and bans `Application.Run`, `.Run(`, `RefreshAll`, `Calculate`, registry/certificate cmdlets, `AccessVBOM`, and `VBE.MainWindow` in the VBA worker.
- Worker-internal read bounds: 10,000 modules, 1,000,000 lines and 16,777,216 characters per module; stdout bounded at 4,194,304 characters.

### Tests

- `tests/vba-backend.test.mjs`: hash normalization, operation validation matrix, pure-module export compatibility, non-Windows rejection, worker source safety and phase/trust/read-back guards.
- `tests/extension.test.mjs`: registered-tool no-UI authorization with a fake backend/confirm, nonempty read filters, and warning-only bad command usage.
- `tests/vba-authorization.test.mjs`: fake-backend service tests (dialogs, hashes, relocated signatures including Agile/V3, refresh-on-load/XLM preflight, protection, exact/formatting/semantic/missing-code read-back, full-code dry runs, cancellation, exclusive outputs, unrelated-part warnings, persistent setting with a temporary `PI_CODING_AGENT_DIR`).
- `tests/corpus/vba-host-test.mjs` (`npm run test:vba`): Windows-only acceptance, intentionally submitting lowercase keywords and tabs through the service first and requiring a formatting warning. Writes `tests/corpus/LAST-VBA-HOST-REPORT.json`. **Not yet run**; the requirement was waived for 0.2.0 by the user on 2026-10-16.
