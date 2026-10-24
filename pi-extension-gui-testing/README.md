# GUI Testing for Pi

Let Pi start your desktop app somewhere out of sight, click through it, and look at screenshots to check its own work.

> **Status:** early release. Linux apps work in five environments today. Testing Windows apps is planned.

## What you can do

- Run your Linux desktop app where it never opens on your desktop: in a Docker container, on a private virtual screen on your computer, on your own SSH server (a Raspberry Pi works too), or in a cloud sandbox in your own cloud account.
- Let Pi find buttons and fields by name, click and type, and take screenshots to judge the result.
- Test GTK, Qt (PySide), and Electron apps by name, and Tkinter apps by screenshot and position.
- Set everything up with one command that checks your system and fixes what it can.
- Start later sessions faster: installed dependencies are kept on your computer and reused, so your `setup` commands don't run every time.

## Choose where your app runs

You pick one environment (Pi calls it a "backend") during setup. Pi never switches to another one on its own.

| Backend | Your app runs | Good when |
|---|---|---|
| `docker-linux` | in a Docker container on your computer | You have Docker on Linux, or Docker Desktop on macOS or Windows. The safest default. |
| `local-linux` | on a private virtual screen on your Linux computer, in your project's own environment | You don't want Docker and your app already runs from your project folder. |
| `remote-linux` | on a private virtual screen on your own SSH server | You want the app off your computer, or on another processor type, such as a Raspberry Pi. |
| `remote-linux-docker` | in a Docker container on your own SSH server | As above, with the server's Docker for extra isolation. You don't need Docker on your computer. |
| `cua` | in a fresh cloud sandbox in your own AWS, Google Cloud, Hetzner, or Modal account | You want a throwaway machine in the cloud. **Costs money.** |

All five run Linux apps. Testing Windows apps (`docker-windows`, `local-windows`, and Windows or macOS sandboxes with `cua`) is planned.

## Install

```bash
pi install npm:@firstpick/pi-extension-gui-testing
```

## How to use it

1. Run `/gui-setup` and pick a backend, or name it directly, for example `/gui-setup docker-linux`. Setup checks what the backend needs, proposes fixes, and runs a short test app. Add `--fix` to apply the proposed fixes without being asked.
2. Approve any fixes setup proposes. When everything is already in place, setup finishes without questions.
3. Ask Pi to check your app, for example: "Start the app, open the settings dialog, and make sure the Save button works."
4. After the first working run, Pi suggests how to install and start your app next time and saves it to `.pi/gui.json` once you agree.

First setup for each backend:

- **`docker-linux`:** `/gui-setup docker-linux`. Setup builds a small base image the first time. On macOS or Windows, start Docker Desktop first.
- **`local-linux`:** `/gui-setup local-linux`. Setup lists the system tools to install, such as Xvfb and xdotool, with the exact command for your distribution.
- **`remote-linux` or `remote-linux-docker`:** first make sure `ssh myserver` logs in with your SSH key, without a password. Then run `/gui-setup remote-linux --host myserver`, or leave out `--host` to pick a server from your `~/.ssh/config`.
- **`cua`:** install the `cua` command-line tool, run `cua auth login` and `cua cloud connect aws --default` (or `gcp`, `hetzner`, `modal`), then run `/gui-setup cua`. Setup asks you once to accept the billing and the upload of your project files.

Other useful commands:

- `/gui-doctor` repeats every check and the test without applying fixes, then marks the backend ready or not ready.
- `/gui-backend <backend>` switches to another backend you have already set up.
- `/gui-usage` shows what Pi did in its GUI sessions, the estimated cloud cost, and any warnings.
- `/gui-cleanup` stops sessions and removes anything a crash left behind. `/gui-cleanup --deps` empties the dependency cache.
- `/gui-export <session> <folder>` keeps screenshots and logs from a running session.

## Before you start

- **Your project is visible to the app.** With `docker-linux`, the container can read your whole project by default, including `.env` files and keys, and setup commands run with network access. Set `"workspaceMode": "copy"` to leave secret files out, or `"network": "none"` to cut network access.
- **`local-linux` runs the app as you, on your computer.** The app can change files in your project and reach the network; it cannot be cut off. It never runs `setup` commands. Use `"workspaceMode": "copy"` to run it on a copy, or `docker-linux` for an offline run.
- **Remote and cloud backends get a copy of your project.** Secret files such as `.env`, keys, and credentials are never sent. Changes the app makes there never come back to your computer. Everything is deleted from the server when the session ends; only the `remote-linux-docker` base image stays, unless you turn that off with `--purge-tooling`.
- **`cua` bills your own cloud account** while a sandbox exists. Pi deletes the sandbox when the session stops, but a crash can leave one running until the next Pi start. Pi only warns about the estimated cost; it never stops at a limit. Set a budget in your cloud account.
- **The dependency cache keeps your projects' installed dependencies on your computer**, in `~/.cache/pi-extension-gui-testing/deps` (up to 5 GB). It may include private packages. Turn it off with `"depsCache": { "enabled": false }` in `.pi/gui.local.json`.
- You need Pi 1.4.0 or newer. Each backend has its own requirements; setup checks them all and tells you what is missing.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for every command and option, the requirements and checks of each backend, configuration files, where data is stored, privacy rules, limitations, and troubleshooting.
