---
name: gui-testing
description: Launch, inspect, operate, and screenshot desktop GUI apps in an isolated environment with the gui_* tools, so you can check your own UI work without touching the user's desktop. Use for native Linux desktop apps (GTK, Qt/PySide, Electron, Tk). Prefer unit tests or browser tools for web UIs.
license: MIT
compatibility: Requires @firstpick/pi-extension-gui-testing and a backend the user has set up with /gui-setup (docker-linux, local-linux, remote-linux, remote-linux-docker, or cua; Linux apps only).
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
- When `coverage` is `none` (always for Tk/Tkinter apps, and on hosts without accessibility support), work from screenshots and coordinates and say so in your report.
- Never switch backends, never suggest another backend as a workaround on your own, and never try to run the app on the user's desktop. If the backend reports an error or "not set up", tell the user and suggest `/gui-setup <backend>` or `/gui-doctor <backend>` with the backend named in the message.
- The app may run on another machine. On a remote server the `arch` can differ from the user's computer (for example `aarch64` on a Raspberry Pi), and files the app writes there never come back. Fix code in the project, not in the session's copy.
- `local-linux` runs the app in the user's real project folder, which the app can change. Do not let the app write test data into the project unless the user asked for it, and mention any files it created. `local-linux` never runs `setup`; if dependencies are missing, tell the user instead of installing them yourself.
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
