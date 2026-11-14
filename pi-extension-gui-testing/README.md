# GUI Testing for Pi

Let Pi start your desktop app somewhere out of sight, click through it, and look at screenshots to check its own work.

> **Status:** early release. Linux apps work in five environments. Windows apps are new in this release and **not yet tested on real Windows machines**: expect rough edges.

## What you can do

- Run your Linux desktop app where it never opens on your desktop: in a Docker container, on a private virtual screen on your computer, on your own SSH server (a Raspberry Pi works too), or in a cloud sandbox in your own cloud account.
- Run your Windows desktop app on a hidden desktop of your Windows computer, or in a throwaway Windows virtual machine on your Linux computer.
- Let Pi find buttons and fields by name, click and type, and take screenshots to judge the result.
- Test GTK, Qt (PySide), and Electron apps by name, and Tkinter apps by screenshot and position.
- Set everything up with one command that checks your system and fixes what it can.
- Start later sessions faster: installed dependencies are kept on your computer and reused, so your `setup` commands don't run every time.

## Choose where your app runs

You pick one environment (Pi calls it a "backend") during setup. Pi never switches to another one on its own.

For Linux apps:

| Backend | Your app runs | Good when |
|---|---|---|
| `docker-linux` | in a Docker container on your computer | You have Docker on Linux, or Docker Desktop on macOS or Windows. The safest default. |
| `local-linux` | on a private virtual screen on your Linux computer, in your project's own environment | You don't want Docker and your app already runs from your project folder. |
| `remote-linux` | on a private virtual screen on your own SSH server | You want the app off your computer, or on another processor type, such as a Raspberry Pi. |
| `remote-linux-docker` | in a Docker container on your own SSH server | As above, with the server's Docker for extra isolation. You don't need Docker on your computer. |
| `cua` | in a fresh cloud sandbox in your own AWS, Google Cloud, Hetzner, or Modal account | You want a throwaway machine in the cloud. **Costs money.** |

For Windows apps (early release, not yet tested on real Windows machines):

| Backend | Your app runs | Good when |
|---|---|---|
| `local-windows` | on a hidden desktop of your Windows 10 or 11 computer | You work on Windows and want no virtual machine. |
| `docker-windows` | in a Windows virtual machine that runs in Docker on your Linux computer | You work on Linux. Needs hardware virtualization (KVM), about 80 GB of free disk, and 8 GB of RAM. |
| `cua` | in a Windows sandbox in your own cloud account | Only once Cua offers Windows for your cloud. As of `cua` 0.9 it offers Windows on none of AWS, Google Cloud, Hetzner, or Modal; setup says why. **Costs money.** |

Testing macOS apps is planned. To test Windows apps, add `"targets": ["windows"]` to your project's `.pi/gui.json`.

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
- **`cua`:** install the `cua` command-line tool, run `cua auth login` and `cua cloud connect aws --default` (or `gcp`, `hetzner`, `modal`), then run `/gui-setup cua`. Setup asks you once to accept the billing and the upload of your project files. Add `--targets linux,windows` to check whether Windows sandboxes are offered too.
- **`local-windows`:** on Windows 10 (1809 or newer) or 11, start Pi normally (not "as administrator") and run `/gui-setup local-windows`. Nothing is installed; setup checks that Windows PowerShell may run the package's helper.
- **`docker-windows`:** on Linux with Docker and KVM, run `/gui-setup docker-windows`. Setup asks you once to confirm that you are responsible for the Windows license (or pass `--accept-windows-license`), then installs Windows into a Docker volume unattended. This first install takes 15–30 minutes and downloads about 6 GB; each later session boots a fresh copy of it, which should take a minute or two.

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
- **Windows licensing is your responsibility.** `docker-windows` downloads Windows from Microsoft and installs it without a license key; neither this package nor dockurr/windows gives you a license. Windows images in `cua` come without a license too.
- **Windows apps in a VM or sandbox run as the administrator** of that throwaway Windows. With `docker-windows`, each session's changes are thrown away; the VM has internet access, and `"network": "none"` is refused.
- **`local-windows` runs the app as you, on a hidden desktop.** The app can change files in your project and use your Windows profile (settings, registry) and network. Security software may flag the helper, because it compiles itself at start and uses hidden desktops. It never runs `setup` commands.
- **Screenshots of Windows apps can be black** for apps drawn by the graphics card (some WPF, Electron, or games); Pi then works from the accessibility tree and says so.
- You need Pi 1.4.0 or newer. Each backend has its own requirements; setup checks them all and tells you what is missing.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for every command and option, the requirements and checks of each backend, configuration files, where data is stored, privacy rules, limitations, and troubleshooting.
