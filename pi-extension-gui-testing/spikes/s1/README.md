# Spike S1: hidden-desktop fidelity on Windows

Contributor-only. This spike measures how well GUI apps work on a private
Windows desktop, so the project can decide whether the Windows helper stays a
PowerShell 5.1 script with C# compiled at start (spec Q4) or becomes a signed
`.exe`. It is not part of the published package.

The harness runs the same sample apps through two tools and writes one JSON
and one Markdown report:

1. [`@iiwate/pi-silent-gui`](https://www.npmjs.com/package/@iiwate/pi-silent-gui)
   0.2.0, the reference design, unchanged (its Python backend command line).
2. This package's Windows helper, `helpers/windows/helper.ps1`, over its stdio
   protocol, exactly as a backend would start it.

## What it measures

Per framework and tool, for each run:

| Measure | How |
|---|---|
| Launch ok | the tool starts the app and reports a window |
| Click delivered | a click at 50 % width, 70 % height of the window capture (the app's large button) makes the app write its marker file; the helper also clicks the button by its UI Automation ref |
| Non-black captures | three window captures; the share without the all-black flag. The helper also captures the composed screen once |
| UI Automation reachability | the button named "Press me" is found on the private desktop: for the reference with a minimal probe (a thread attached to its desktop), for the helper through `snapshot`, which also reports `coverage` |
| Foreground unchanged | the user's foreground window is the same before and after the run |
| Helper startup | time until the helper's ready line (Add-Type compiles the C# sources at every start; the client allows 10 s) |

Frameworks: Tk, PySide6, WinForms, WPF, Electron with `--disable-gpu`, and
Electron without it (for the helper: `PI_GUI_WIN_SOFTWARE_RENDERING=0`).

## Before you start

- Windows 10 1809 or later, or Windows 11, x64 or arm64, signed in to a normal
  desktop session. Use a machine or VM you may run test apps on; the apps stay
  on hidden desktops, but they run as your user.
- Windows PowerShell 5.1 (`powershell.exe`, included in Windows).
- For the reference tool and the Python apps: Python 3.10 or later from
  python.org (includes Tk) on `PATH`, then:

  ```powershell
  pip install pycaw==20260927 PySide6==6.12.0
  ```

- For the Electron apps and to download the reference tool: Node.js 20 or
  later with npm, then:

  ```powershell
  cd spikes\s1\apps\electron
  npm install
  ```

- Leave antivirus on: whether it blocks `csc.exe` (used by `Add-Type`), hidden
  desktops, or window messages is part of what S1 measures. Write down the
  product and version if it is not Microsoft Defender (the report records
  Defender's state when available).

Anything missing is skipped and listed in the report; the rest still runs.

## Run it

From the repository's `pi-extension-gui-testing` directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File spikes\s1\run-s1.ps1
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `-Runs N` | `3` | runs per framework and tool |
| `-Tools both\|reference\|helper` | `both` | which tools to run |
| `-Frameworks list` | all six | comma-separated subset, e.g. `winforms,electron-gpu` |
| `-OutDir dir` | `spikes\s1\results` | where the reports go |
| `-SilentGuiDir dir` | download | an already extracted `package` directory of the reference tool |
| `-Python path` | `python.exe`, then `py -3` | Python interpreter |

The harness downloads the reference tool with `npm pack` into a temporary
directory and refuses it unless its SHA-512 matches the pinned 0.2.0 tarball.
It never installs anything globally and removes its temporary files at the end.

Keep using the machine lightly while it runs: the foreground check compares
the foreground window before and after each run, so switching windows yourself
shows up as "changed".

## Reading the results

`results/s1-<time>.md` has one row per framework and tool; the JSON file has
every run, error text, and the helper's `hello.platform`.

Decision rules for Q4 (proposed; the owner decides):

- **Keep the PowerShell helper** when its median startup stays under 6 s and
  never exceeds 9 s, antivirus never blocks or quarantines it, and for every
  framework its launch, click, and non-black rates are at least the
  reference's.
- **Move to a signed `.exe`** (same C# sources) when startup is too slow or
  antivirus interferes with runtime compilation.
- **Revisit the input or capture design** for any framework where both tools
  fail the same way (for example Electron without `--disable-gpu` capturing
  black, or clicks not reaching WPF): that is a property of hidden desktops,
  not of the helper's form.

Record the outcome, the report file, and the machine in the Windows plan
(`plans/planned/gui-testing-windows-plan.md`) and spec Q4.
