# Workbook for Pi

Lets Pi inspect and carefully edit `.xlsx` and `.xlsm` Excel workbooks with visual checks and validation.

## What you can do

- Inspects `.xlsx` and `.xlsm` workbooks without changing them.
- Renders sheets so formatting can be checked visually.
- Edits selected cells and workbook content through a guarded workflow.
- Checks workbook structure and compares the saved result before it is accepted.
- On Windows with desktop Excel, adds, replaces, or removes VBA macro modules after you approve each change.

## Install

Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-workbook
```

Requires Node.js 24 or newer. Restart Pi if the package does not appear in your current session.

## How to use it

Attach or reference the `.xlsx` or `.xlsm` file, then describe the result you want.

> Inspect this workbook, correct the totals in the Summary sheet, preserve the formatting, and show me the validation result.

Start with inspection or rendering, review the proposed cell changes, and keep the edited file only after the final comparison and validation are satisfactory.

### Editing macros (Windows only)

Macro editing is off by default. To use it on Windows with desktop Excel:

1. In Excel, turn on **File > Options > Trust Center > Trust Center Settings > Macro Settings > Trust access to the VBA project object model**. The extension never changes this setting for you.
2. Ask Pi for the macro change:

   > Add a module to Budget.xlsm with a macro that clears the Input sheet, and save it as a new file.

3. Pi shows a dry-run preview first. When it commits, a dialog asks you to allow macro editing for the session (unless you ran `/workbook-vba enable`), then a second dialog shows the proposed modules and code previews. Use the dry run to inspect the full code if a preview is shortened. Nothing is written unless you approve; Excel formatting changes are reported as warnings.

Run `/workbook-vba status` to see whether editing is allowed, `/workbook-vba enable` to allow it in every session, and `/workbook-vba disable` to turn it off again. Every edit still needs its own approval.

## Before you start

- **Macros are never run**, even while editing them. Review new macro code yourself before you enable macros in Excel.
- Macro edits always go to a new `.xlsm` file; your original stays unchanged.
- VBA tools refuse Excel 4.0 macro sheets and workbooks set to refresh connections, pivot caches, or query tables on opening.
- Excel saves the whole workbook, so a macro edit can also change unrelated parts of the file. Pi lists every such change; check them before you replace the original.
- Editing a digitally signed macro project removes its signature. Pi refuses unless you ask for this and approve it.
- Macro editing has not yet been tested against a real Excel installation. Try it on a copy first.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-workbook/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
