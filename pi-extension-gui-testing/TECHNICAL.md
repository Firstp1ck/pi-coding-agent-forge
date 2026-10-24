# Technical reference: GUI Testing for Pi

Advanced user reference for commands, configuration, environments, storage, privacy, limitations, and troubleshooting.

[Back to README](README.md) · [Development guide](DEVELOPMENT.md)

> **Status:** early release. Only the `docker-linux` environment on a Linux computer is available. Everything marked *planned* on this page describes later releases and does not work yet.

## Environments

You choose one environment ("backend") explicitly. The package never switches to another one on its own, and it never opens your app on your own desktop.

| Backend | Available | Runs your app | Your computer | App platforms |
|---|---|---|---|---|
| `docker-linux` | yes (Linux computers; Docker Desktop on macOS/Windows is planned) | in a Docker container on your computer | Linux | Linux, on your computer's processor type (x86-64 or ARM64) |
| `local-linux` | planned | on a private virtual screen on your computer | Linux | Linux |
| `remote-linux` | planned | on a private virtual screen on your own server | any computer with an SSH client | Linux, on the server's processor type |
| `remote-linux-docker` | planned | in a Docker container on your own server | any computer with an SSH client | Linux, on the server's processor type |
| `cua` | planned | in a Cua cloud sandbox | any | Linux, Windows, macOS |
| `docker-windows` | planned | in a Windows virtual machine inside Docker | Linux with hardware virtualization (KVM) | Windows |
| `local-windows` | planned | on a hidden Windows desktop | Windows 10 or 11 | Windows |

When you have not chosen a backend, the tools and `/gui-doctor` use `docker-linux`, the only one available. A backend you chose that is not available yet is refused, never replaced.

The planned server backends will not need a monitor, graphics card, or desktop environment on the server. A Raspberry Pi 4 or 5 with a 64-bit OS, set up over SSH only, is a planned target.

## Requirements

All backends need Pi 1.4.0 or newer. Setup checks each requirement and tells you which one is missing.

| Backend | Requirements |
|---|---|
| `docker-linux` | A Linux computer. Docker server 29.0 or newer, running rootful (the standard install), reachable through a local Unix socket (`DOCKER_HOST` or the current `docker context`). Rootless Docker and remote Docker hosts are not supported yet. Your user must be able to run `docker` without `sudo`. At least 5 GB of free disk space in your temp folder's file system. Network access the first time, to build the base image (about 0.5 GB of downloads). |

### What setup checks for `docker-linux`

`/gui-setup` and `/gui-doctor` run these checks in order and show each result as `pass`, `warn`, `fail`, or `blocked` (skipped because an earlier check failed), together with what they found and how to fix it.

| Check | What it confirms |
|---|---|
| `pi.version` | Pi is 1.4.0 or newer. |
| `host.os` | Your computer runs Linux. |
| `config.writable` | Pi's agent folder can store the package's settings. |
| `disk.free` | At least 5 GB are free. |
| `docker.cli` | The `docker` command is installed. |
| `docker.endpoint` | Docker is reached through a local Unix socket. |
| `docker.daemon` | The Docker service is running. |
| `docker.permission` | You can use Docker without `sudo`. |
| `docker.rootless` | Docker runs in rootful mode. |
| `docker.version` | The Docker server is 29.0 or newer. A newer major version only warns. |
| `docker.ostype` | Docker runs Linux containers. |
| `docker.arch` | Docker's processor type is supported. |
| `image.base` | The base image exists and matches this package version. Setup builds it when it is missing or outdated. |
| `docker.bind-uid` | Files in your project keep your user ID inside the container. |
| `isolation.inspect` | A test container gets every security restriction. It is created but never started, then removed. |

After the checks, setup starts a small test app in a container, finds its button by name, clicks it, checks that a label changed, takes a screenshot, and confirms nothing is left behind.

## Commands

| Command | What it does |
|---|---|
| `/gui-setup [backend] [options]` | Checks everything the backend needs, proposes fixes, runs a short test, and saves the backend as ready. Without a backend, it shows the backends your computer supports; `/gui-cleanup` or quitting Pi also cancels that choice. |
| `/gui-doctor [backend]` | Repeats all checks and the test, then lists anything earlier sessions left behind. Never asks questions, never applies fixes, and never changes your backend choice or project files. It only updates the record of whether the backend is ready. It may start short-lived test containers and removes them before it finishes. Afterwards, the backend is marked ready again, or not ready if a check failed. |
| `/gui-backend <backend> [--project]` | Switches to another backend that is already set up. |
| `/gui-usage [session]` | Shows activity and estimated cost for current and recent sessions. |
| `/gui-export <session> <folder>` | Copies screenshots, accessibility dumps, and logs from a running session into a folder you choose. Existing files are never overwritten. |
| `/gui-cleanup [backend \| --all] [--deps]` | Cancels a running `/gui-setup` or `/gui-doctor`, stops this Pi's sessions (retrying any whose cleanup failed earlier), removes anything ended sessions left behind, then shows what remains. It also works when `.pi/gui.json` cannot be read: it warns and, without a backend, cleans every backend. `--deps` is reserved for the planned dependency cache. |
| `/gui-reset <backend>` | Asks once, then removes the backend's base images, its ready status, and the backend choice. Lists system packages that setup installed so you can remove them yourself if you want. Works only where Pi can ask you: the interactive screen or an RPC client. |

### Keeping your personal settings out of Git

`/gui-setup --project` and `/gui-backend --project` write `.pi/gui.local.json`. When your project is a Git repository and that file is not ignored yet, Pi offers once to add it to `.gitignore`. With `--fix` it adds the line without asking. With `--no-fix`, or in print or JSON mode without `--fix`, the report only warns you. Pi never writes through a `.gitignore` that is a symbolic link or not a regular file; it warns instead.

### Running commands from scripts

Commands never ask questions in print mode (`pi -p`) or JSON mode (`pi --mode json`). There the report goes to standard error (print) or arrives as a message (JSON), and the exit code is 1 when a required check fails. In RPC mode the connected client can answer questions, so commands behave as in the interactive screen: setup may ask, the report arrives as a message, and the exit code is not changed. Close standard input when you script print mode (`pi -p "…" </dev/null`), because Pi otherwise waits for input.

### `/gui-setup` options

Every question setup can ask has an option, so a complete command runs without questions.

| Option | Meaning |
|---|---|
| `--host <alias or user@host>` | *Planned.* The SSH server for `remote-*` backends. Without it, setup lists the hosts from your `~/.ssh/config`. |
| `--targets linux,windows,macos` | *Planned.* The platforms to prepare (`cua`). |
| `--api-key-env <VAR>` | *Planned.* The environment variable holding your Cua API key. Default: `CUA_API_KEY`. |
| `--accept-billing` | *Planned.* You accept that cloud sandboxes cost money and that your project files are uploaded for each session (`cua`). |
| `--accept-windows-license` | *Planned.* You confirm that you are responsible for Windows licensing (`docker-windows`). |
| `--fix` | Apply every proposed fix that needs no password, without asking. |
| `--no-fix` | Never apply fixes; only report. |
| `--project` | Save the backend and host for this project only, instead of for all projects. |
| `--purge-tooling` | *Planned.* For `remote-linux-docker`: remove the base image from the server after every session instead of keeping it. |

Passing `--fix` or an `--accept-*` option counts as your explicit approval.

### What setup never does for you

Some steps need a password or your judgment, so setup shows the exact command and stops:

- copying your SSH key to a server (asks for the server password once);
- trusting a server's host key the first time;
- anything that needs a `sudo` password;
- turning on hardware virtualization in your computer's firmware.

Run `/gui-setup` again afterwards. It continues from the checks.

## Using a server from your SSH config (planned)

This section describes the planned `remote-*` backends.

Setup reads the `Host` entries of `~/.ssh/config` (including files added with `Include`) and shows each server with its status: `ready`, `auth needed`, `host key unknown`, `unreachable`, or `not Linux`. It stores only the alias, so later changes to the server's address or key in your SSH config apply automatically. The package only reads that file. It never changes it or sends it anywhere.

Before the first setup for a new server, do these two things once:

```bash
ssh-copy-id me@raspi5   # install your key; asks for the server password
ssh me@raspi5           # check and accept the host key, then exit
```

On Windows, where `ssh-copy-id` is missing, setup shows an equivalent PowerShell command.

Your computer needs an SSH client. `rsync` is optional: without it, each sync copies all project files instead of only the changes. Docker is never needed on your computer for remote backends.

## Configuration

Settings are read in this order, field by field: options you pass to a command, then the project's personal file, then your global settings, then built-in defaults. The shared `.pi/gui.json` only holds how to set up and start the app; a backend, server, or limits written there are ignored with a warning.

| File | Purpose | Commit it? |
|---|---|---|
| `.pi/gui.json` | How to set up and start this project's app | Yes |
| `.pi/gui.local.json` | Your backend, server, and limits for this project | No. Setup offers to add it to `.gitignore`. |
| `~/.pi/agent/gui/config.json` (inside Pi's agent folder; see `PI_CODING_AGENT_DIR` below) | Your default backend and the list of verified backends | — |

### `.pi/gui.json`

```json
{
  "targets": ["linux"],
  "setup": ["pip install -r requirements.txt"],
  "launch": { "cmd": "python", "args": ["app.py"] },
  "workspaceMode": "mount",
  "deps": { "keyFiles": ["requirements.txt"], "env": {} },
  "sync": { "allow": [], "deny": [] },
  "network": "default"
}
```

| Field | Meaning |
|---|---|
| `targets` | Platforms the app should be tested on. |
| `setup` | Commands that install the app's dependencies inside a container or on a server. In `docker-linux` they run inside the container at the start of every session, from the project folder, with up to 15 minutes per command. A failing command stops the session and shows its last output. They never run on your computer with `local-linux`. |
| `launch` | The default command that starts the app. |
| `workspaceMode` | `mount` (default): containers see your whole project read-only, including files such as `.env` and keys. `copy`: containers get a writable copy that leaves out secret files, for apps that write next to their own files or when you want secrets kept out. |
| `deps.keyFiles` | *Planned, for the dependency cache.* Files whose changes mean dependencies must be reinstalled. Default: the lockfiles and manifests found in the project. |
| `deps.env` | Extra environment variables for the `setup` commands. |
| `sync.deny` | Extra files never sent to servers or sandboxes, or into the `copy`-mode workspace. |
| `sync.allow` | Files sent or copied even though they match the built-in secret list. Use with care. |
| `network` | `default`, or `none` to run the app without network access. |

Pi proposes `setup` and `launch` after its first working run and shows them to you before saving.

### `.pi/gui.local.json`

```json
{
  "backend": "remote-linux-docker",
  "remote": { "host": "raspi5" },
  "keepSandbox": false,
  "limits": { "maxConcurrentSessions": 2, "idleTimeoutMinutes": 15 },
  "usageCheck": { "warnSessionCostUsd": 1, "warnDailyCostUsd": 5 }
}
```

| Field | Default | Meaning |
|---|---|---|
| `backend` | none | The backend for this project. |
| `remote.host` (planned) | none | SSH alias or `user@host` for `remote-*` backends. |
| `keepSandbox` (planned) | `false` | Keep a stopped Cua sandbox between sessions. Faster, but your project files stay in the cloud. |
| `limits.maxConcurrentSessions` | `2` | Sessions that may run at the same time. |
| `limits.idleTimeoutMinutes` | `15` | A session without activity for this long is shut down and cleaned up. There is no maximum session length. |
| `usageCheck.warnSessionCostUsd` (planned) | `1` | Estimated Cua cost per session that triggers a warning. |
| `usageCheck.warnDailyCostUsd` (planned) | `5` | Estimated Cua cost per day that triggers a warning. |

### Environment variables

| Variable | Meaning |
|---|---|
| `CUA_API_KEY` (planned) | Cua API key, unless setup was given another variable with `--api-key-env`. |
| `PI_CODING_AGENT_DIR` | Pi's agent folder. The package keeps its settings in a `gui` folder inside it. Default: `~/.pi/agent`. |

## What Pi can do in a session

Pi uses these tools. You don't call them yourself, but their names appear in Pi's output.

| Tool | What it does |
|---|---|
| `gui_launch` | Starts a session and the app. Without arguments it uses `launch` from `.pi/gui.json`. |
| `gui_wait` | Waits for a window, a text, an element, or a still screen, instead of guessing a delay. |
| `gui_snapshot` | Reads the app's accessibility tree: the names, roles, and values of its controls. |
| `gui_screenshot` | Takes a screenshot that Pi can see, at most 1280 pixels on the longest side by default. |
| `gui_act` | Clicks, double-clicks, right-clicks, types, presses keys, sets values, or scrolls, by element or by position on the latest screenshot. |
| `gui_logs` | Shows what the app printed. |
| `gui_stop` | Stops the session and reports anything left behind. |
| `gui_export` | Copies the session's screenshots, dumps, and logs to a folder before the session ends. |

Every result names the backend that ran it. Sessions are called `gui-` followed by eight characters, for example `gui-1a2b3c4d`. Screenshots and accessibility dumps are saved in the session's temp folder as `screenshot-001.png`, `snapshot-001.json`, and so on.

### Session rules

- **Limits:** at most `limits.maxConcurrentSessions` sessions run at once. A session with no tool call for `limits.idleTimeoutMinutes` is stopped; a call that is still waiting or running counts as activity, so a long `gui_wait` is never cut off.
- **After an update:** before each new session, the package compares the package, Pi, Docker, and base image versions with the ones recorded at setup. If anything changed, new sessions are refused until you run `/gui-doctor docker-linux`. Sessions that are already running continue. The first session after updating this package always asks for `/gui-doctor` once.
- **Failed cleanup:** if stopping a session, or a failed start, leaves something behind, the message says what and names the session. The session stays listed and refuses other tools until `gui_stop` again, `/gui-cleanup`, or Pi's shutdown removes everything. It no longer counts against the session limit.
- **Quitting Pi:** Pi cancels a running setup or session start, waits up to 20 seconds for it, then stops every session.
- **Exports:** `gui_export` and `/gui-export` can be cancelled and stop after 2 minutes, even in the middle of a file. Files copied completely until then stay in the folder; a partly copied file is removed. A destination inside the session's temp folder, also through a symbolic link, is refused because it would be deleted with the session.
- **Logs:** `gui_logs` keeps the last 10 000 output chunks or about 1 MiB of output in memory. The session's `app.log` stops at 64 MiB and notes when lines were dropped.
- **Snapshots:** very long names or values are cut at about 64 000 characters, and an element whose position is unusable is listed without one.
- **Warnings:** configuration warnings (unknown fields, or a backend or limits in the shared `.pi/gui.json`) appear in every command report and in the `gui_launch` result, also when the launch fails. Usage warnings count failed launches too.

## Where data is stored

Your project data stays on your computer. Servers, sandboxes, and virtual machines hold it only while a session runs.

| Location | Contents | Lifetime |
|---|---|---|
| Your system's temp folder, `pi-gui-testing-*` | Screenshots, accessibility dumps, logs, sync staging for one session | Deleted when the session ends. Leftovers from a crash are deleted the next time Pi starts. |
| Docker image `pi-gui-testing-base:<package version>` | Tools only: the virtual screen, accessibility libraries, app runtimes, and the test app. No project files. | Kept so later sessions start fast. Removed by `/gui-reset docker-linux`. |
| Docker container `pi-gui-testing-<session>` | The running session | Removed when the session ends, when Pi exits or crashes (the container stops by itself within about a minute), or by the next startup cleanup. The startup cleanup and `/gui-cleanup` look for leftover containers whenever a `docker` command is installed, even if setup never finished. |
| *Planned:* `~/.cache/pi-extension-gui-testing/deps/` | Installed dependencies per project and platform, so later sessions start faster | Kept; up to 5 GB, oldest entries removed first. Clear with `/gui-cleanup --deps`. |
| `~/.pi/agent/gui/` (or `gui/` inside `PI_CODING_AGENT_DIR`) | Settings, verified backends, pinned server host keys | Kept until `/gui-reset`. |
| On a server: `$XDG_RUNTIME_DIR/pi-gui-testing`, else `/tmp/pi-gui-testing-<uid>`, else `~/.cache/pi-gui-testing-tmp` | One folder per session with your synced project and the helper | Deleted when the session ends or the connection drops. |
| On a server: Docker base image (`remote-linux-docker`) | Tools only, no project files | Kept unless you use `--purge-tooling`. |
| Cua | One sandbox per session | Deleted when the session ends, unless `keepSandbox` is on. |

Screenshots that Pi already received are part of your Pi session history, not of this package's storage. Use `/gui-export` to keep files.

## Security and privacy

- **Docker on your computer (`mount` mode):** the container can read every file in your project, including `.env` files and keys, and setup commands run with network access by default. The container cannot change your project files. The secret list below does not apply here. Use `workspaceMode: "copy"` to keep secret files out, or `network: "none"` when setup runs install scripts you don't trust.
- **What mount mode refuses:** the file system root, your home folder or a folder above it, and system folders such as `/run/user`, `/run/dbus`, `/var/run`, or folders above `/tmp/.X11-unix`. It also refuses a project that contains a socket file anywhere, including inside `.git`, `node_modules`, or virtual environments, because the container could connect to it. If the full-folder check takes longer than 20 seconds or a folder cannot be read, the session is refused too. Each refusal suggests `copy` mode.
- **Mount check:** in mount mode the package mounts the resolved project folder and confirms inside the container that `/workspace` is exactly the folder it checked, before setup or the app runs. If not, the session stops.
- **Docker on your computer (`copy` mode):** the container gets a writable copy of the selected files in your session's temp folder. Your project itself is not mounted. Files inside a folder that is a symbolic link are never copied. If a file or folder changes into a link or another file during the copy, the session stops with `changed while the workspace was being copied`; try again.
- **Git:** to list your project's files, the package runs Git with file-system monitor programs and hooks turned off, so a repository's own configuration cannot run programs on your computer.
- **Container restrictions:** containers run as your own user ID, with no extra privileges, no access to your display, session bus, or Docker socket, and a read-only system. `isolation.inspect` confirms these restrictions before every session; a session that does not meet them is refused.
- **What is sent or copied:** for `copy` mode and the planned remote and cloud backends, the files Git tracks plus new files that are not ignored. Outside Git, all files except common build and dependency folders. Symbolic links that point outside the project or to a left-out file are skipped.
- **What is left out by default:** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `secrets*`, `.ssh/`, `.aws/`, `.gnupg/`, in any folder of your project. A file you list in `sync.allow` is sent anyway; `sync.deny` always wins over `sync.allow`.
- **Passwords:** the package never asks for, stores, or sends SSH or `sudo` passwords. It uses your existing SSH keys and agent.
- **Servers:** no network ports are opened on your server. Everything runs through your SSH connection.
- **Isolation:** apps run on their own virtual screen or in a container. They cannot open windows on your desktop or on a server's own screen.
- **Cleanup check:** after every session, the package checks your computer and the server for leftovers and reports anything it finds.
- **Costs:** Cua bills for sandbox time. The package has no spending cap; set one in your Cua account. It warns you when estimated cost passes your thresholds, or when Pi repeats the same action, the screen stops changing, or the app is restarted unusually often. These warnings never stop Pi; you decide whether to interrupt.

## Limitations

- **Tkinter apps** have no accessibility information, so Pi finds controls by screenshot and position instead of by name. This is slower and less precise.
- Java Swing apps expose names only with the Java ATK wrapper installed in the environment.
- **macOS apps** can only be tested with `cua`.
- **Windows apps** need `cua`, `docker-windows` (Linux computer with KVM), or `local-windows`.
- `local-windows` may show black screenshots for apps that draw with the graphics card, and some antivirus tools may flag its hidden desktop.
- `local-windows` starts apps without administrator rights and never shows a UAC prompt. If Pi runs as administrator, it only starts an elevated app when you explicitly allow it. Screenshots that come out completely black are marked as such.
- On a Raspberry Pi, the app runs on ARM. Apps that ship only x86 programs do not work there.
- `docker-windows` needs about 80 GB of disk space, 8 GB of RAM, and a 15–30 minute Windows installation the first time.
- Screenshots are taken at 1280×800 and sent to Pi at most 1280 pixels wide.
- In this release, `setup` commands run again at the start of every session, because the dependency cache is not available yet.
- Electron and Chromium apps get a larger shared-memory area only when `launch` starts `electron`, `npx electron`, or a Chromium browser directly. An app started through `npm start` may crash on load; call `electron` directly in `launch`.
- The base image is built for your computer's processor type. x86-64 and ARM64 Linux computers are supported.
- `/gui-setup` measures free space in your temp folder, not in Docker's own storage folder.

## Troubleshooting

| Message or symptom | Fix |
|---|---|
| `backend "<id>" is not set up` | Run `/gui-setup <id>`. |
| Setup ends with `needs-user-action` | Run the listed commands yourself, then run `/gui-setup` again. |
| `auth needed` for a server | Install your key with `ssh-copy-id`, or the Windows command setup shows. |
| `host key unknown` | Connect once with `ssh <host>` and check the fingerprint. |
| Warning about output on SSH login | Your server prints text for non-interactive logins (for example from `.bashrc`). It still works; remove the output to silence the warning. |
| Docker permission denied | Add your user to the `docker` group, then log in again. |
| `rootless Docker is not supported` | Use the standard (rootful) Docker daemon for now. |
| Docker reached over TCP or SSH | Point `DOCKER_HOST` or your `docker context` at the local Unix socket. Remote Docker hosts are planned. |
| `Pi is shutting down (or restarted this extension); run the command again` | Pi quit or reloaded while the command was starting. Run it again. |
| `the workspace contains Unix socket(s)` | Move the listed sockets out of the project, or use `workspaceMode: "copy"`. |
| `cleanup did not finish; run gui_stop or /gui-cleanup to retry` | A container or file could not be removed. Retry; if it persists, the message names what remains. |
| `changed while the workspace was being copied` | Something changed your project during a `copy`-mode start. Start the session again. |
| `the directory mounted at /workspace is not the one that was checked` or `was replaced while it was scanned` | The project folder was moved or replaced while the session started. Start again; if it repeats on your file system, use `workspaceMode: "copy"`. |
| `the workspace socket scan did not finish within 20 s` | Your project folder is very large. Use `workspaceMode: "copy"`. |
| A `setup` command failed | The error shows the command's last output. Fix the command in `.pi/gui.json`, then start again. In mount mode the project is read-only: install into the environment, not into the project folder, or use `copy` mode. |
| `backend "docker-linux" changed since setup` | The package or Docker changed. Run `/gui-doctor docker-linux`. |
| `at most N GUI sessions can run at once` | Stop a session first, or raise `limits.maxConcurrentSessions` in `.pi/gui.local.json`. |
| `Xvfb` missing (`local-linux`) | Let setup install it, or install `xorg-server-xvfb` (Arch), `xvfb` (Debian/Ubuntu), or `xorg-x11-server-Xvfb` (Fedora/openSUSE). |
| `app handed off to another instance` | The app is already running elsewhere and passed the request on. Close the other copy or start the app with its "new instance" option. |
| `stale ref, take a new snapshot` | Pi used an element from an older view. It takes a new snapshot automatically. |
| A usage warning appears | Pi may be stuck in a loop. Check what it is doing and interrupt if needed. |
| Leftovers reported after a session | Run `/gui-cleanup`. If anything remains, the message names it. |
