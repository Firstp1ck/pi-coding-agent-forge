# Technical reference: GUI Testing for Pi

Advanced user reference for commands, configuration, environments, storage, privacy, limitations, and troubleshooting.

[Back to README](README.md) · [Development guide](DEVELOPMENT.md)

> **Status:** in development. This page describes the planned behavior of the first release. Nothing here is implemented yet.

## Environments

You choose one environment ("backend") explicitly. The package never switches to another one on its own, and it never opens your app on your own desktop.

| Backend | Runs your app | Your computer | App platforms |
|---|---|---|---|
| `docker-linux` | in a Docker container on your computer | Linux, or macOS/Windows with Docker Desktop | Linux |
| `local-linux` | on a private virtual screen on your computer | Linux | Linux |
| `remote-linux` | on a private virtual screen on your own server | any computer with an SSH client | Linux, on the server's processor type |
| `remote-linux-docker` | in a Docker container on your own server | any computer with an SSH client | Linux, on the server's processor type |
| `cua` | in a Cua cloud sandbox | any | Linux, Windows, macOS |
| `docker-windows` | in a Windows virtual machine inside Docker | Linux with hardware virtualization (KVM) | Windows |
| `local-windows` | on a hidden Windows desktop | Windows 10 or 11 | Windows |

A server does not need a monitor, graphics card, or desktop environment. A Raspberry Pi 4 or 5 with a 64-bit OS, set up over SSH only, works.

## Commands

| Command | What it does |
|---|---|
| `/gui-setup [backend] [options]` | Checks everything the backend needs, proposes fixes, runs a short test, and saves the backend as ready. Without a backend, it shows the backends your computer supports. |
| `/gui-doctor [backend]` | Repeats all checks and the test without changing anything. Never asks questions. |
| `/gui-backend <backend> [--project]` | Switches to another backend that is already set up. |
| `/gui-usage [session]` | Shows activity and estimated cost for current and recent sessions. |
| `/gui-export` | Copies screenshots and logs from a session into a folder you choose. |
| `/gui-cleanup [backend \| --all] [--deps]` | Removes anything a session left behind, then shows what remains. `--deps` also clears the dependency cache. |
| `/gui-reset <backend>` | Removes a backend's settings and downloaded tooling. Lists system packages that setup installed so you can remove them yourself if you want. |

### `/gui-setup` options

Every question setup can ask has an option, so a complete command runs without questions.

| Option | Meaning |
|---|---|
| `--host <alias or user@host>` | The SSH server for `remote-*` backends. Without it, setup lists the hosts from your `~/.ssh/config`. |
| `--targets linux,windows,macos` | The platforms to prepare (`cua`). |
| `--api-key-env <VAR>` | The environment variable holding your Cua API key. Default: `CUA_API_KEY`. |
| `--accept-billing` | You accept that cloud sandboxes cost money and that your project files are uploaded for each session (`cua`). |
| `--accept-windows-license` | You confirm that you are responsible for Windows licensing (`docker-windows`). |
| `--fix` | Apply every proposed fix that needs no password, without asking. |
| `--no-fix` | Never apply fixes; only report. |
| `--project` | Save the backend and host for this project only, instead of for all projects. |
| `--purge-tooling` | For `remote-linux-docker`: remove the base image from the server after every session instead of keeping it. |

Passing `--fix` or an `--accept-*` option counts as your explicit approval.

### What setup never does for you

Some steps need a password or your judgment, so setup shows the exact command and stops:

- copying your SSH key to a server (asks for the server password once);
- trusting a server's host key the first time;
- anything that needs a `sudo` password;
- turning on hardware virtualization in your computer's firmware.

Run `/gui-setup` again afterwards. It continues from the checks.

## Using a server from your SSH config

Setup reads the `Host` entries of `~/.ssh/config` (including files added with `Include`) and shows each server with its status: `ready`, `auth needed`, `host key unknown`, `unreachable`, or `not Linux`. It stores only the alias, so later changes to the server's address or key in your SSH config apply automatically. The package only reads that file. It never changes it or sends it anywhere.

Before the first setup for a new server, do these two things once:

```bash
ssh-copy-id me@raspi5   # install your key; asks for the server password
ssh me@raspi5           # check and accept the host key, then exit
```

On Windows, where `ssh-copy-id` is missing, setup shows an equivalent PowerShell command.

Your computer needs an SSH client. `rsync` is optional: without it, each sync copies all project files instead of only the changes. Docker is never needed on your computer for remote backends.

## Configuration

Settings are read in this order, field by field: the project's personal file, then your global settings, then built-in defaults.

| File | Purpose | Commit it? |
|---|---|---|
| `.pi/gui.json` | How to set up and start this project's app | Yes |
| `.pi/gui.local.json` | Your backend, server, and limits for this project | No. Setup offers to add it to `.gitignore`. |
| `~/.pi/agent/gui/config.json` | Your default backend and the list of verified backends | — |

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
| `setup` | Commands that install the app's dependencies inside a container or on a server. They never run on your computer with `local-linux`. |
| `launch` | The default command that starts the app. |
| `workspaceMode` | `mount` (default): containers see your project read-only. `copy`: containers get a writable copy, for apps that write next to their own files. |
| `deps.keyFiles` | Files whose changes mean dependencies must be reinstalled. Default: the lockfiles and manifests found in the project. |
| `deps.env` | Extra environment variables for the installed dependencies. |
| `sync.deny` | Extra files never sent to servers or sandboxes. |
| `sync.allow` | Files sent even though they match the built-in secret list. Use with care. |
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
| `remote.host` | none | SSH alias or `user@host` for `remote-*` backends. |
| `keepSandbox` | `false` | Keep a stopped Cua sandbox between sessions. Faster, but your project files stay in the cloud. |
| `limits.maxConcurrentSessions` | `2` | Sessions that may run at the same time. |
| `limits.idleTimeoutMinutes` | `15` | A session without activity for this long is shut down and cleaned up. There is no maximum session length. |
| `usageCheck.warnSessionCostUsd` | `1` | Estimated Cua cost per session that triggers a warning. |
| `usageCheck.warnDailyCostUsd` | `5` | Estimated Cua cost per day that triggers a warning. |

### Environment variables

| Variable | Meaning |
|---|---|
| `CUA_API_KEY` | Cua API key, unless setup was given another variable with `--api-key-env`. |

## Where data is stored

Your project data stays on your computer. Servers, sandboxes, and virtual machines hold it only while a session runs.

| Location | Contents | Lifetime |
|---|---|---|
| Your system's temp folder, `pi-gui-testing-*` | Screenshots, accessibility dumps, logs, sync staging for one session | Deleted when the session ends. Leftovers from a crash are deleted the next time Pi starts. |
| `~/.cache/pi-extension-gui-testing/deps/` | Installed dependencies per project and platform, so later sessions start faster | Kept; up to 5 GB, oldest entries removed first. Clear with `/gui-cleanup --deps`. |
| `~/.pi/agent/gui/` | Settings, verified backends, pinned server host keys | Kept until `/gui-reset`. |
| On a server: `$XDG_RUNTIME_DIR/pi-gui-testing`, else `/tmp/pi-gui-testing-<uid>`, else `~/.cache/pi-gui-testing-tmp` | One folder per session with your synced project and the helper | Deleted when the session ends or the connection drops. |
| On a server: Docker base image (`remote-linux-docker`) | Tools only, no project files | Kept unless you use `--purge-tooling`. |
| Cua | One sandbox per session | Deleted when the session ends, unless `keepSandbox` is on. |

Screenshots that Pi already received are part of your Pi session history, not of this package's storage. Use `/gui-export` to keep files.

## Security and privacy

- **What is sent:** for remote and cloud backends, the files Git tracks plus new files that are not ignored. Outside Git, all files except common build and dependency folders.
- **What is never sent:** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `secrets*`, `.ssh/`, `.aws/`, `.gnupg/`, unless you list a file in `sync.allow`.
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
- On a Raspberry Pi, the app runs on ARM. Apps that ship only x86 programs do not work there.
- `docker-windows` needs about 80 GB of disk space, 8 GB of RAM, and a 15–30 minute Windows installation the first time.
- Screenshots are taken at 1280×800 and sent to Pi at most 1280 pixels wide.

## Troubleshooting

| Message or symptom | Fix |
|---|---|
| `backend "<id>" is not set up` | Run `/gui-setup <id>`. |
| Setup ends with `needs-user-action` | Run the listed commands yourself, then run `/gui-setup` again. |
| `auth needed` for a server | Install your key with `ssh-copy-id`, or the Windows command setup shows. |
| `host key unknown` | Connect once with `ssh <host>` and check the fingerprint. |
| Warning about output on SSH login | Your server prints text for non-interactive logins (for example from `.bashrc`). It still works; remove the output to silence the warning. |
| Docker permission denied | Add your user to the `docker` group or use rootless Docker, then log in again. |
| `Xvfb` missing (`local-linux`) | Let setup install it, or install `xorg-server-xvfb` (Arch), `xvfb` (Debian/Ubuntu), or `xorg-x11-server-Xvfb` (Fedora/openSUSE). |
| `app handed off to another instance` | The app is already running elsewhere and passed the request on. Close the other copy or start the app with its "new instance" option. |
| `stale ref, take a new snapshot` | Pi used an element from an older view. It takes a new snapshot automatically. |
| A usage warning appears | Pi may be stuck in a loop. Check what it is doing and interrupt if needed. |
| Leftovers reported after a session | Run `/gui-cleanup`. If anything remains, the message names it. |
