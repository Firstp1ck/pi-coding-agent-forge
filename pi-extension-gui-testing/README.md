# GUI Testing for Pi

Let Pi start your desktop app somewhere out of sight, click through it, and look at screenshots to check its own work.

> **Status:** early release. The Docker environment on a Linux computer (`docker-linux`) works today. SSH servers, cloud sandboxes, Windows, and macOS are planned and described in [TECHNICAL.md](TECHNICAL.md#environments).

## What you can do

- Run your Linux desktop app inside a Docker container on your computer. It never opens on your desktop.
- Let Pi find buttons and fields by name, click and type, and take screenshots to judge the result.
- Test GTK, Qt (PySide), and Electron apps by name, and Tkinter apps by screenshot and position.
- Set everything up with one command that checks your system and fixes what it can.
- Get a warning when Pi seems stuck repeating the same action, and a check that nothing is left behind after each session.

## Install

```bash
pi install npm:@firstpick/pi-extension-gui-testing
```

## How to use it

1. Run `/gui-setup docker-linux`. Setup checks Docker, builds a small base image, and runs a short test app. Add `--fix` to apply the proposed fixes without being asked.
2. Approve any fixes setup proposes. When everything is already in place, setup finishes without questions.
3. Ask Pi to check your app, for example: "Start the app, open the settings dialog, and make sure the Save button works."
4. After the first working run, Pi suggests how to install and start your app next time and saves it to `.pi/gui.json` once you agree.

Other useful commands:

- `/gui-doctor` repeats every check and the test without applying fixes, then marks the environment ready or not ready.
- `/gui-usage` shows what Pi did in its GUI sessions and any warnings.
- `/gui-cleanup` stops sessions and removes anything a crash left behind.
- `/gui-export <session> <folder>` keeps screenshots and logs from a running session.

## Before you start

- **Your project is visible to the container.** By default the container can read your whole project, including `.env` files and keys, and setup commands (such as `pip install`) run with network access. If you don't want that, set `"workspaceMode": "copy"` to leave secret files out, or `"network": "none"` to cut network access (see [TECHNICAL.md](TECHNICAL.md#security-and-privacy)).
- You need Docker 29 or newer in its standard (rootful) mode, usable without `sudo`. Rootless Docker is not supported yet.
- You need Pi 1.4.0 or newer.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for all commands and options, configuration files, where data is stored, privacy rules, limitations, and troubleshooting.
