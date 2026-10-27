# Technical reference: Workbook for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Supported files

The package inspects and edits `.xlsx` and `.xlsm` workbooks. It can read sheets, render previews, update selected content, compare files, and validate the saved result.

## Safe editing flow

1. Ask Pi to inspect the workbook.
2. Read the relevant sheets and render previews when formatting matters.
3. Ask for a dry-run preview of the intended changes.
4. Review formulas, literal values, and target cells carefully.
5. Save to a new workbook.
6. Compare and validate the result before replacing any original file.

Source changes, destination changes, and unsupported edits stop the operation instead of silently overwriting newer work.

## Safety behavior

- Macros are never executed. Ordinary edits preserve them unchanged; only the separate VBA editing tool (below) can change them, and only with your approval.
- External links and data connections are not refreshed.
- Formula changes and literal-value changes are treated separately.
- Editing creates a new file by default.
- Overwriting requires `overwrite: true` and the current `expectedSha256`; in-place overwrite creates a recovery copy before committing.
- Unsupported workbook features or lossy changes are refused.

## VBA macro editing

### Requirements

- Windows with desktop Excel, running in an interactive, logged-in user session. Linux and macOS report the capability as unavailable.
- **Trust access to the VBA project object model** enabled by you in Excel: *File > Options > Trust Center > Trust Center Settings > Macro Settings*. Without it, reading and editing fail with a message naming this setting. The extension never changes Trust Center, registry, or certificate settings.
- The tool starts its own hidden Excel instance and never takes over an Excel window you already have open.
- Fixed timeouts are 30 seconds for the availability probe, 60 seconds for listing/reading modules, and 120 seconds for editing. A timeout fails the operation and triggers cleanup of the owned Excel instance.

### Permission

| Control | Effect |
| --- | --- |
| `/workbook-vba status` | Shows whether editing is allowed. |
| `/workbook-vba enable` | After a confirmation, saves `PI_WORKBOOK_VBA_EDITING=1` in your Pi global `.env`, so every session may edit. |
| `/workbook-vba disable` | After a confirmation, saves `PI_WORKBOOK_VBA_EDITING=0` and clears any session permission. |
| `PI_WORKBOOK_VBA_EDITING` in the process environment | Takes precedence over the saved value. If it is set to `1`, `/workbook-vba disable` cannot turn editing off. |
| Session dialog | When editing is not enabled, the first commit in a session asks whether to allow VBA editing for this session only. |

Permission only makes editing *possible*. **Every commit shows its own approval dialog** listing the source file and SHA-256, the new output file, each module with its kind, line counts before and after, the SHA-256 of the new code, and up to 20 lines of each new module. Declining any dialog writes nothing. Print mode has no dialog UI, so commits fail with `AUTHORIZATION_REQUIRED`. In RPC mode, the host application answers dialogs and must show them to a person; a host that automatically approves them breaks this trust boundary. The agent cannot approve on your behalf.

### What the tools do

- `workbook_vba_read` lists modules (name, kind, line count, code hash) and, on request, a bounded amount of source (default 20,000 characters, maximum 200,000). If you supply `modules`, give at least one module name; omit it to list all modules. Returned source is untrusted content.
- `workbook_vba_edit` supports:
  - `addModule`: a new standard or class module;
  - `replaceModuleCode`: the code of a standard, class, or document module such as `ThisWorkbook` or `Sheet1`;
  - `removeModule`: a standard or class module.

  It runs as a dry run by default and returns the full submitted code for each operation. If the dialog preview is shortened, run the dry run to inspect the full code (large results are saved in a complete temporary artifact). Commits need the current `expectedSha256`.

### Rules and limits

- Output is always a **new `.xlsm` file**. The default is `<name>.vba-edited.xlsm` next to the source. The tool never overwrites the source or an existing file. An `.xlsx` source produces a macro-enabled copy.
- UserForms and other component types are read-only. Document modules cannot be removed.
- Password-protected VBA projects are refused; the tool never asks for or bypasses project passwords.
- Both VBA tools refuse Excel 4.0 macro sheets and workbooks with connections, pivot caches, or query tables set to refresh on opening. These checks run before Excel opens the source, including for reads and dry runs.
- Signed projects are refused unless you pass `allowSignatureRemoval: true` *and* approve a dialog that states the signature will be lost. Any signature parts left in the output are reported as unverified.
- Code must be plain ASCII (letters, digits, punctuation, tabs, line breaks), at most 256 KiB per module, with no `Attribute VB_` lines. A request has at most 50 operations.
- Module names start with a letter and use only letters, digits, and underscores (31 characters at most).
- If the approval details would exceed 6,000 characters, the edit is refused with `LIMIT_EXCEEDED` rather than hiding part of the change; split it into smaller edits.

### Integrity checks and side effects

- Excel opens the source read-only with macros force-disabled, events off, links not updated, and manual calculation. The source SHA-256 is checked before the dialog, after approval, before saving, and after the run.
- After saving, the tool reopens the new file with macros disabled and checks the saved code against what Excel stored before saving. Untouched modules must remain unchanged. Limited differences from approved code—letter case, spacing/tabs, blank leading/trailing lines, or one leading `Option Explicit`—are accepted with a formatting warning and both approved and stored hashes. Other differences fail without publishing an output. Formatting tolerance is not VBA semantic analysis; review warnings and stored code carefully.
- **Excel rewrites the whole workbook.** Changes to parts other than the VBA project are listed in `unrelatedChangedParts` and as warnings. Earlier testing showed Excel can change formatting details during a save. Review the diff before relying on the result.
- Editing never runs macros, refreshes data, or recalculates formulas.

### Verification status

Macro editing has been tested only with a simulated Excel backend. A real Windows Excel acceptance run is pending; until then, treat Excel-specific behaviour (such as code formatting, non-English module names, and cleanup after timeouts) as unverified and work on copies.

## Compatibility

Visual previews may differ slightly from desktop Excel. Signed macro workbooks receive extra preservation checks, and active macro content is never run.

Use the contributor guide for exact operation support, preservation checks, and document-engine internals.

## Troubleshooting

- `BACKEND_UNAVAILABLE` from a VBA tool: you are not on Windows, Excel is not installed, or *Trust access to the VBA project object model* is off.
- `AUTHORIZATION_REQUIRED`: a dialog was declined, or the session cannot show dialogs.
- `OUTPUT_EXISTS` for a VBA edit: choose a new `outputPath`; VBA edits never overwrite files.
- Reinspect the source when Pi reports that it changed.
- Render the affected sheet when formatting or merged cells matter.
- Prefer a new destination when overwrite checks fail.
- Treat validation warnings as unresolved until the saved workbook is reopened and compared successfully.
