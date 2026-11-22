---
name: gui-testing
description: Launch, inspect, operate, and screenshot desktop GUI apps in an isolated environment with the gui_* tools, so you can check your own UI work without touching the user's desktop. Use for native Linux desktop apps (GTK, Qt/PySide, Electron, Tk) and, in preview, Windows desktop apps (WinForms, WPF, Qt, Electron, Tk). Prefer unit tests or browser tools for web UIs.
license: MIT
compatibility: Requires @firstpick/pi-extension-gui-testing and a backend the user has set up with /gui-setup (Linux apps - docker-linux, local-linux, remote-linux, remote-linux-docker, cua; Windows apps, preview - local-windows, docker-windows, cua where Cua offers Windows).
---

# GUI testing

## Choose the narrowest tool first

1. If automated tests (unit, integration, widget tests) can answer the question, use them.
2. For web UIs, use Playwright or a browser tool instead of this package.
3. Use the `gui_*` tools when you must see or operate a real desktop app window.

## Required loop

1. `gui_launch` — starts the app on the backend the user configured. Without arguments it uses `launch` from `.pi/gui.json`. Read the result: it names the backend, the `arch` the app runs on, where the workspace is and whether the app can write to it, the dependency cache result, and any backend warnings.
2. `gui_wait` — wait for a `window`, `text`, `ref`, or `idle` instead of sleeping.
3. `gui_snapshot` — read the accessibility tree and its `coverage` (`full`, `partial`, or `none`).
4. `gui_act` — act on a `ref` from the latest snapshot (`click`, `double_click`, `right_click`, `type`, `key`, `set_value`, `scroll`). Pass `screenshot: true` to get the result image in the same call.
5. `gui_screenshot` — look at the result and judge it against the user's request.
6. Fix the code, then `gui_stop` and relaunch to verify the fix.
7. `gui_stop` when done. Report any leftovers it lists.

## Rules

- Use `ref`s from the most recent snapshot. On a `STALE_REF` error, take a new snapshot (or screenshot, for coordinates) and retry once.
- Use `x`,`y` coordinates only when the tree has no node for the target. Coordinates are in the pixels of the latest screenshot image and are bound to that capture.
- When `coverage` is `none` (always for Tk/Tkinter apps on Linux, and on hosts without accessibility support), work from screenshots and coordinates and say so in your report.
- Never switch backends, never suggest another backend as a workaround on your own, and never try to run the app on the user's desktop. If the backend reports an error or "not set up", tell the user and suggest `/gui-setup <backend>` or `/gui-doctor <backend>` with the backend named in the message.
- The app may run on another machine. On a remote server the `arch` can differ from the user's computer (for example `aarch64` on a Raspberry Pi), and files the app writes there never come back. Fix code in the project, not in the session's copy.
- `local-linux` with `workspaceMode: "mount"` (the usual setting) runs the app in the user's real project folder, which the app can change: the `gui_launch` result says "the project directory itself (writable)". Do not let the app write test data into the project unless the user asked for it, and mention any files it created. With `"copy"` the app runs in a filtered copy in a temporary folder, so its changes are lost when the session stops, and dependency folders such as `node_modules` or `.venv` are missing from the copy. `local-linux` never runs `setup`; if dependencies are missing, tell the user instead of installing them yourself.
- **Windows apps** (`local-windows`, `docker-windows`, Windows sandboxes in `cua`; a preview that has not run on real Windows yet, so report odd behaviour plainly):
  - Pass `target: "windows"` to `gui_launch` unless the project's `targets` in `.pi/gui.json` already starts with `windows`. A backend refuses a target it does not run; do not retry on another backend.
  - Window screenshots include the title bar and borders. `x`,`y` coordinates are in that full-window image, as for every capture: take them from the latest screenshot, not from the window's client area.
  - A screenshot result marked `allBlack` means the app draws with the graphics card and the capture could not see it, not that the window is empty. Work from `gui_snapshot` (UI Automation) and `gui_wait` for text instead; mention in your report that screenshots were black. Do not keep retaking screenshots hoping for a change.
  - `local-windows` runs the app as the user in the real project folder (mount mode) and with the user's real profile and registry. Avoid actions that change the user's app settings, and say which files the app created. It never runs `setup`.
  - On `docker-windows` and Windows sandboxes, each `setup` command is a Windows PowerShell 5.1 script, not `sh`: a failing cmdlet stops it, but a failing program such as `pip` or `npm` does not, and the last program's exit code counts. When you propose `setup` entries for a Windows project, add `if ($LASTEXITCODE) { exit $LASTEXITCODE }` after each program that must succeed, and use PowerShell syntax (`;`, `$env:NAME`, backslash paths). Setup runs in every Windows session (no dependency cache), and apps there run as the guest's administrator.
  - Session starts are slow on Windows (local: 10–20 s; `docker-windows`: Windows boots, a minute or more; `cua`: minutes). Start once and reuse the session while you test; do not stop and relaunch for every small check.
- `cua` bills the user's cloud account for as long as the sandbox exists. Keep sessions short, call `gui_stop` as soon as you have your answer, and do not leave a session idle while you edit code for a long time.
- A `HANDOFF` error means the app passed the launch to another running instance. Tell the user; do not retry in a loop.
- If a result carries a `usageWarning`, stop and reassess what you are doing before the next call. Do not repeat the same action on an unchanged screen.
- Every result names the backend that ran. Mention it in your report.
- Use `gui_logs` when the app crashes, the window never appears, or behaviour is unexpected.
- Use `gui_export` only when the user wants to keep screenshots, dumps, or logs. Run it before `gui_stop`: session files are deleted when the session ends.

## After a working run

If `.pi/gui.json` has no `setup` or `launch` entry yet, propose the entries you used, show them to the user, and save them only after the user agrees. Example:

```json
{
  "setup": ["pip install -r requirements.txt"],
  "launch": { "cmd": "python3", "args": ["app.py"] }
}
```

## Report

Summarise what you launched, the steps you took, what the screenshots showed, whether the result matches the request, the backend that ran, and the `coverage` you worked with.
