# Workbook workers

`excel-vba.ps1` is the Windows worker behind `workbook_vba_read` and `workbook_vba_edit`. It uses the same safety harness listed below, plus `VBProject`/`CodeModule` access for module listing and editing only. It refuses locked projects, never calls `Application.Run`, `RefreshAll`, `Calculate`, registry, certificate, or VBE window APIs, saves only to a staged `.xlsm`, and re-opens that file with macros disabled to read back every module. It requires the user to have enabled *Trust access to the VBA project object model*; it never changes that setting.

The rest of this file describes `excel-native.ps1`.

`excel-native.ps1` is a **disabled feasibility worker**, not a public mutation backend. The registered workbook tools continue to select only `ooxml-safe`.

The worker enforces:

- interactive Windows only;
- `AutomationSecurity=ForceDisable` before opening targets;
- disabled events, link updates, alerts, and screen updating;
- manual calculation;
- source SHA-256 checks before and after;
- a new Excel PID resolved from `Application.Hwnd`;
- refusal when COM attaches to a pre-existing Excel process;
- PID/start-time-verified cleanup on cancellation or timeout.

It never edits certificate stores or Trust Center settings and never calls VBA execution, refresh, or `VBProject` APIs.

The bounded bakeoff rejected native mutation because `.xlsx` no-op serialization changed merged-cell styles and `.xlsm` no-op serialization changed `xl/vbaProject.bin`. See `docs/ADR-0001-primary-backend.md` and `tests/corpus/LAST-NATIVE-BAKEOFF.json`. Do not enable the worker without a new reviewed fidelity decision.
