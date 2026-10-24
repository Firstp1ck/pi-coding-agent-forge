# Technical reference: GUI Testing for Pi

Advanced user reference for commands, configuration, environments, storage, privacy, limitations, and troubleshooting.

[Back to README](README.md) · [Development guide](DEVELOPMENT.md)

> **Status:** early release. Five backends for Linux apps are available. The Windows backends (`local-windows`, `docker-windows`, and Windows sandboxes in `cua`) are available but **have not run on a real Windows machine, Docker with KVM, or Cua yet**; treat them as a preview. Everything marked *planned* on this page describes later releases and does not work yet.

## Environments

You choose one environment ("backend") explicitly. The package never switches to another one on its own, and it never opens your app on your own desktop.

| Backend | Available | Runs your app | Your computer | App platforms |
|---|---|---|---|---|
| `docker-linux` | yes | in a Docker container on your computer | Linux with Docker Engine; macOS or Windows with Docker Desktop | Linux, on your Docker's processor type (x86-64 or ARM64) |
| `local-linux` | yes | on a private virtual screen on your computer | Linux | Linux |
| `remote-linux` | yes | on a private virtual screen on your own server | Linux or macOS with an OpenSSH client | Linux, on the server's processor type |
| `remote-linux-docker` | yes | in a Docker container on your own server | Linux or macOS with an OpenSSH client | Linux, on the server's processor type |
| `cua` | yes; Windows unverified | in a Cua sandbox in your own cloud account | Linux | Linux; Windows where Cua offers it for your cloud (as of `cua` 0.9: none). macOS sandboxes are planned. |
| `local-windows` | yes, unverified | on a hidden desktop of your computer | Windows 10 1809 or newer, or Windows 11 (x64 or ARM64) | Windows |
| `docker-windows` | yes, unverified | in a throwaway Windows virtual machine inside Docker on your computer | Linux (x86-64 or ARM64) with hardware virtualization (KVM) | Windows (Windows on ARM on ARM64 computers) |

When you have not chosen a backend, the tools and `/gui-doctor` use `docker-linux`. A backend you chose that does not exist in your installed version is refused, never replaced. Windows clients for the remote backends are planned.

Which platform a session runs is decided by `gui_launch`'s `target`, else the first entry of `targets` in `.pi/gui.json` (default `["linux"]`). A backend refuses a target it does not run: set `"targets": ["windows"]` for `local-windows` and `docker-windows`. With `cua`, `"targets": ["windows", "linux"]` makes Windows the default and still allows Linux.

The server backends need no monitor, graphics card, or desktop environment on the server. A Raspberry Pi 4 or 5 with a 64-bit OS, set up over SSH only, works as a server.

## Requirements

All backends need Pi 1.4.0 or newer. Setup checks each requirement and tells you which one is missing.

| Backend | Requirements |
|---|---|
| `docker-linux` | **On Linux:** Docker Engine 29.0 or newer, running rootful (the standard install), reachable through a local Unix socket (`DOCKER_HOST` or the current `docker context`). Your user must be able to run `docker` without `sudo`. **On macOS or Windows:** Docker Desktop running with Linux containers, Docker 29.0 or newer, and the `desktop-linux` (or default) context. Desktop's file sharing must cover your project and your temp folder. On Windows, your account must be in the `docker-users` group. **Everywhere:** at least 5 GB of free disk space in your temp folder's file system, and network access the first time to build the base image (about 0.5 GB of downloads). |
| `local-linux` | A Linux computer with Python 3.9 or newer, Xvfb, xdotool, xprop and xwininfo, ImageMagick, the D-Bus daemon, and PyGObject with GTK 3. Recommended: AT-SPI (`at-spi2-core`) and pyatspi for the accessibility tree, openbox as window manager, and fonts. At least 1 GB free in your temp folder. |
| `remote-linux` | **Your computer:** Linux or macOS with the OpenSSH client, an SSH key in your agent or `~/.ssh`, and key login to the server (`ssh -o BatchMode=yes myserver true` works). `rsync` is optional. **Server:** 64-bit Linux (x86-64 or ARM64; 32-bit ARM only warns), a POSIX login shell or fish (not csh or tcsh), `tar`, `sha256sum`, `mktemp`, and `stat` (GNU coreutils or BusyBox), at least 2 GB of memory and 2 GB free at the session folder, Python 3.9 or newer, Xvfb, xdotool, ImageMagick, `dbus-run-session`, and PyGObject with GTK 3. Recommended: AT-SPI and pyatspi, openbox, fonts. |
| `remote-linux-docker` | **Your computer:** as for `remote-linux`; Docker is not needed. **Server:** the same basics as for `remote-linux` (64-bit Linux, shell, file tools, 2 GB of memory), plus Docker Engine 29.0 or newer that the SSH user can use without `sudo`, and at least 5 GB free where Docker stores its data. The base image is built on the server (about 0.5 GB of downloads). |
| `cua` | A Linux computer with at least 1 GB free in the temp folder. The open-source `cua` command-line tool (this release was written against version 0.7; the Windows target against 0.9), a cua.ai account you are signed in to (`cua auth login`), and one of your own cloud accounts connected for sandboxes: AWS, Google Cloud, Hetzner, or Modal (`cua cloud connect <cloud> --default`), with that cloud's credentials on your computer. **Windows sandboxes** additionally need a cloud for which `cua cloud status` lists a supported Windows image, and an image with Windows PowerShell 5.1, Windows 10 1809 / Server 2019 (build 17763) or newer, and the system `tar.exe`. Nothing is installed in a Windows sandbox. |
| `local-windows` | Windows 10 1809 (build 17763) or newer, or Windows 11, on x64 or ARM64. Windows PowerShell 5.1 (part of Windows) in full language mode, with no Group Policy that sets the execution policy to `AllSigned` or `Restricted` (`RemoteSigned` is fine). Pi runs in your own, non-elevated session with Explorer running and UAC on. At least 1 GB free in `%LOCALAPPDATA%\Temp`. Nothing is installed. |
| `docker-windows` | A Linux computer (x86-64 or ARM64) with KVM: `/dev/kvm` readable and writable by you (usually through the `kvm` group), and VT-x or AMD-V turned on in the firmware (or nested virtualization when Linux itself runs in a VM). Docker Engine 29.0 or newer, rootful, on a local Unix socket, usable without `sudo`. At least 8 GB of RAM (4 GB go to the VM by default) and 80 GB free where Docker stores its data before the install (16 GB once Windows is installed). The OpenSSH client (`ssh`, `ssh-keygen`). Internet access during the install: about 6 GB of Windows from Microsoft, the dockurr/windows image (about 240 MB), and OpenSSH Server from Windows Update. |

## What setup checks

`/gui-setup` and `/gui-doctor` run the checks of a backend in order and show each result as `pass`, `warn`, `fail`, or `blocked` (skipped because an earlier check failed), together with what they found and how to fix it. Checks marked *optional* never stop setup; when they fail, the report says what works less well.

### Checks every backend runs

| Check | What it confirms |
|---|---|
| `pi.version` | Pi is 1.4.0 or newer. |
| `host.os` | Your computer's operating system can run this backend. |
| `config.writable` | Pi's agent folder can store the package's settings. |
| `disk.free` | Enough space is free in your temp folder: 5 GB for `docker-linux`, 1 GB for the other backends. `docker-windows` measures Docker's data folder instead (see below). |

### `docker-linux`

| Check | What it confirms |
|---|---|
| `docker.cli` | The `docker` command is installed. |
| `docker.endpoint` | Docker is reached through a local Unix socket, or on Windows through a local named pipe. |
| `docker.daemon` | The Docker service or Docker Desktop is running. |
| `docker.permission` | You can use Docker without `sudo`. |
| `docker.rootless` | Docker runs in rootful mode. Docker Desktop passes with a note, because its engine is rootful inside its own Linux virtual machine. |
| `docker.version` | The Docker server is 29.0 or newer. A newer major version only warns. |
| `docker.ostype` | Docker runs Linux containers. |
| `docker.arch` | Docker's processor type is supported. |
| `image.base` | The base image exists and matches this package version. Setup builds it when it is missing or outdated. |
| `docker.bind-uid` | Files in your project keep your user inside the container. On Docker Desktop, this confirms that its file sharing reaches the folder. |
| `isolation.inspect` | A test container gets every security restriction. It is created but never started, then removed. |

### `local-linux`

Missing tools need `sudo`, so setup shows the exact install command for pacman, apt, dnf, or zypper and lets you run it.

| Check | What it confirms |
|---|---|
| `linux.python` | Python 3.9 or newer is installed. |
| `linux.xvfb` | Xvfb starts and stops on a free private display. |
| `linux.xdotool` | xdotool is installed, for clicks and typing. |
| `linux.xutils` | xprop and xwininfo are installed, for window queries. |
| `linux.screenshot` | ImageMagick is installed (`magick`, or `import` and `convert`). |
| `linux.dbus` | The D-Bus daemon is installed, for the private session bus. |
| `linux.atspi` | *Optional.* `at-spi-bus-launcher` is installed. Without it, Pi gets no accessibility tree. |
| `linux.pyatspi` | *Optional.* Python can import pyatspi. Without it, Pi gets no accessibility tree. |
| `linux.wm` | *Optional.* openbox is installed. Without it, dialogs may open at the top-left corner and window activation may not work. |
| `linux.fonts` | *Optional.* At least one font is installed. Without fonts, text may render as boxes. |
| `linux.gtk-introspection` | PyGObject with GTK 3 works (the helper and the test app need it). |
| `linux.wayland-scrub` | Apps started by the package see only the private display and bus, never your desktop's. A failure here is a bug; please report it. |

### `remote-linux` and `remote-linux-docker`

Both remote backends run these checks first.

| Check | What it confirms |
|---|---|
| `local.ssh` | The OpenSSH client is installed on your computer. |
| `local.rsync` | *Optional.* rsync is installed on your computer. Without it, every sync is a full copy. |
| `ssh.config` | A server is chosen and `ssh -G` can resolve it. |
| `local.sshkey` | An SSH key is in your agent or in `~/.ssh`. |
| `ssh.hostkey` | The server's host key is already known. |
| `ssh.auth` | Key login works without a password. |
| `ssh.jump` | Every jump host (`ProxyJump`) is reachable. |
| `ssh.multiplex` | *Optional.* SSH connection sharing works. Without it, every call opens its own connection. |
| `ssh.clean-stdout` | *Optional.* The server prints nothing extra for non-interactive logins. |
| `ssh.latency` | *Optional.* The median round trip is under 300 ms. |
| `remote.os` | The server runs Linux. |
| `remote.arch` | The server is x86-64 or ARM64. 32-bit ARM only warns. |
| `remote.distro` | The distribution and its package manager are detected. |
| `remote.path` | Tools are found on the PATH of non-interactive SSH sessions, not only in a login shell. |
| `remote.hostkey-pinned` | The server's host key is recorded, so a changed key is noticed. |
| `remote.sudo` | *Optional.* `sudo` works on the server without a password. Without it, package installs are shown as commands for you to run. |
| `remote.mem` | The server has at least 2 GB of memory. Below 4 GB it warns. |
| `remote.cpu` | *Optional.* The server has at least 2 CPU cores. |
| `remote.limits` | *Optional.* The open-file and process limits are not tiny. |
| `remote.coreutils` | `tar`, `sha256sum`, `mktemp`, and `stat` are installed on the server. |
| `remote.session-root` | A private session folder can be created and removed on the server. |
| `remote.exec` | Programs can run from that folder (it is not mounted `noexec`). |
| `remote.rsync` | *Optional.* rsync is installed on the server. |
| `sync.roundtrip` | A test folder with a link, a non-ASCII name, and an executable file arrives intact. |
| `sync.exclusions` | A dry run of your project's sync contains no secret files. |
| `remote.disk` | Enough space is free: 2 GB at the session folder for `remote-linux`, 5 GB where Docker stores its data for `remote-linux-docker`. |

`remote-linux` then checks the server's tools:

| Check | What it confirms |
|---|---|
| `remote.python` | Python 3.9 or newer is installed. |
| `linux.xvfb`, `linux.xdotool`, `linux.screenshot`, `linux.dbus`, `linux.gtk-introspection` | Xvfb, xdotool, ImageMagick, `dbus-run-session`, and PyGObject with GTK 3 are installed. |
| `linux.atspi`, `linux.pyatspi`, `linux.wm`, `linux.fonts` | *Optional.* As for `local-linux`. |
| `xvfb.start` | A private virtual screen starts on a free display. |
| `xvfb.not-host` | That display is never one in use, and never `:0`. |
| `helper.deploy` | The package's helper copies to a session folder intact and starts. |

`remote-linux-docker` then checks the server's Docker: `docker.cli`, `docker.endpoint`, `docker.daemon`, `docker.permission`, `docker.version`, `docker.ostype`, `docker.arch`, `image.base`, `docker.bind-uid`, and `isolation.inspect` work as for `docker-linux`, but on the server. In addition:

| Check | What it confirms |
|---|---|
| `docker.rootless` | *Optional.* Records whether the server's Docker is rootful or rootless. `docker.bind-uid` decides whether sessions can work. |
| `docker.image-arch` | The base image matches the server's processor type. |
| `docker.egress` | *Optional.* The server can reach the base image's package mirror. Without it, the image cannot be built there. |

### `cua`

All `cua` checks only read. They create no sandbox and cost nothing.

| Check | What it confirms |
|---|---|
| `cua.cli` | The `cua` command-line tool, version 0.7 or newer, is installed. The report shows the version found. |
| `cua.network` | The Cua service (`api.cua.ai`) is reachable. No credentials are sent. |
| `cua.signin` | You are signed in to cua.ai. |
| `cua.auth` | A signed-in, read-only Cua call works. |
| `cua.cloud` | One of your cloud accounts is connected for sandboxes, and its credentials are on your computer. |
| `cua.quota` | The cloud account passes Cua's own read-only test: credentials, permissions, quota, and region. |
| `cua.targets` | Every platform you asked for (`--targets`, else the project's `targets`) is available. Windows passes only when `cua cloud status` lists a supported Windows image for the chosen cloud; otherwise it fails with Cua's reason, for example that the cloud offers no nested virtualization. macOS is refused in this release. |
| `cua.ttl` | *Optional.* Sandboxes in your cloud expire on their own, so one left by a crash stops billing eventually. |
| `cua.rate` | *Optional.* An hourly price is known for the cost estimate, from Cua or from `--rate-usd-per-hour`; for Windows sandboxes, from Cua or from `--windows-rate-usd-per-hour`. |
| `cua.cost-ack` | You accepted the billing and the upload of project files for this cloud. |

### `local-windows`

Setup installs nothing for this backend; every fix is a step for you or your administrator. Each helper check starts the helper once, which compiles it first, so these checks take seconds each.

| Check | What it confirms |
|---|---|
| `win.powershell` | Windows PowerShell 5.1 (not PowerShell 7) is in `%SystemRoot%\System32\WindowsPowerShell\v1.0` and runs in full language mode. Constrained language mode, set by an AppLocker or WDAC policy, blocks the helper. |
| `win.execution-policy` | No Group Policy sets PowerShell's execution policy to `AllSigned` or `Restricted`. The helper starts with `-ExecutionPolicy Bypass`, which a Group Policy overrides. |
| `helper.present` | The package's 17 helper files are installed. The helper is an unsigned PowerShell script, so there is no signature to check. |
| `win.version` | Windows 10 1809 (build 17763) or newer. The report also says whether Pi runs elevated. |
| `win.arch` | Windows runs on x64 or ARM64. |
| `helper.desktop` | The helper can create a private, hidden desktop. |
| `helper.job` | The helper can contain apps in a Windows job, so they all end with the session. |
| `helper.nonelevated` | Apps start without administrator rights, as the same user as your Explorer, even when Pi itself runs elevated. |
| `helper.uia` | UI Automation (Windows' accessibility interface) works on the private desktop. |
| `helper.av` | *Optional.* Security software did not block or kill the helper while it compiled itself. A warning names what happened. |

### `docker-windows`

| Check | What it confirms |
|---|---|
| `host.linux` | Your computer runs Linux. |
| `docker.cli`, `docker.endpoint`, `docker.daemon`, `docker.permission`, `docker.rootless`, `docker.version`, `docker.ostype`, `docker.arch` | As for `docker-linux`: a local, rootful Docker Engine 29.0 or newer that you can use without `sudo`. |
| `kvm.device` | `/dev/kvm` exists and you can read and write it. |
| `kvm.cpu` | The processor offers hardware virtualization (VT-x or AMD-V on x86-64; on ARM64, `/dev/kvm` is enough). |
| `mem.available` | At least 8 GB of RAM in total, and enough available for the VM (at least 4 GB, or the size you chose). |
| `disk.free` | Free space where Docker stores its data: 80 GB before Windows is installed, 16 GB afterwards. |
| `ports.free` | Programs can listen on `127.0.0.1`, where the VM's SSH port is published. |
| `license.ack` | You confirmed that you are responsible for Windows licensing. |
| `image.base` | The pinned dockurr/windows image (version 6.06, about 240 MB, without Windows) is present. Setup downloads it. |
| `isolation.inspect` | A test container shaped like a session gets every restriction: no privileged mode, all capabilities dropped except the few the VM needs, only the KVM and network-tunnel devices, only the Windows volume, and every port on `127.0.0.1`. It is created but never started, then removed. |
| `vm.installed` | Windows is installed in this computer's Windows volume, and the VM's keys are present. Setup installs it unattended (15–30 minutes, about 6 GB of downloads, up to 2 hours) and shows its progress. |

### `cua` with Windows

The same `cua` checks run. Ask for Windows with `/gui-setup cua --targets linux,windows` (or set `targets` in `.pi/gui.json`): `cua.targets` then also checks the Windows image, and `cua.rate` warns when no Windows price is known.

### The test after the checks

After the checks, setup starts a small test app in the backend (GTK 3 for Linux, WinForms for the Windows backends), finds its button by name, clicks it, checks that a label changed, takes a screenshot, and confirms nothing is left behind. With `local-windows`, it also confirms that your own foreground window did not change. For `cua`, the test runs a Linux sandbox.

## Commands

| Command | What it does |
|---|---|
| `/gui-setup [backend] [options]` | Checks everything the backend needs, proposes fixes, runs a short test, and saves the backend as ready. Without a backend, it lists the backends that run on your computer's operating system to choose from; you can still name another backend, and its `host.os` check then tells you why it cannot run here. `/gui-cleanup` or quitting Pi also cancels that choice. |
| `/gui-doctor [backend] [--host <server>]` | Repeats all checks and the test, then lists anything earlier sessions left behind. Never asks questions, never applies fixes, and never changes your backend choice or project files. It only updates the record of whether the backend is ready. It may start short-lived test resources and removes them before it finishes. |
| `/gui-backend <backend> [--project]` | Switches to another backend that is already set up. |
| `/gui-usage [session]` | Shows activity and estimated cost for current and recent sessions. |
| `/gui-export <session> <folder>` | Copies screenshots, accessibility dumps, and logs from a running session into a folder you choose. Existing files are never overwritten. |
| `/gui-cleanup [backend \| --all] [--deps]` | Cancels a running `/gui-setup` or `/gui-doctor`, stops this Pi's sessions (retrying any whose cleanup failed earlier), removes anything ended sessions left behind, then shows what remains. Remote backends act on the configured server. It also works when `.pi/gui.json` cannot be read: it warns and, without a backend, cleans every backend. `--deps` also empties the whole dependency cache, for every project. |
| `/gui-reset <backend>` | Asks once, then removes the backend's setup data, its ready status, and the backend choice. See the table below. Its report lists only what is still left after the reset. When the final check itself fails (for example the cloud listing), the report says so, keeps everything found before, and may be incomplete. Works only where Pi can ask you: the interactive screen or an RPC client. |

What `/gui-reset` removes:

| Backend | Removed | Stays |
|---|---|---|
| `docker-linux` | Base images | Docker itself |
| `local-linux` | Only the ready status and backend choice | The system tools you installed |
| `remote-linux` | Orphaned session folders on the server | Packages installed on the server |
| `remote-linux-docker` | Base images and orphaned session folders on the server | Docker on the server |
| `cua` | Sandboxes kept by `keepSandbox` (Linux and Windows), sandboxes whose deletion did not finish (`pending deletion`), the billing acceptance, and the `cua` settings | The `cua` tool, your cua.ai sign-in, and your cloud connection. Use `cua auth logout` and `cua cloud disconnect` to remove them. |
| `local-windows` | Only the ready status and backend choice | Windows PowerShell and the .NET Framework, which are part of Windows |
| `docker-windows` | The installed Windows disk (Docker volume `pi-gui-testing-windows-base`), a running install, the dockurr/windows image, this computer's VM keys, the licensing confirmation, and the VM size settings. The keys and settings are removed only when the volume is gone. | Docker and KVM |

### Keeping your personal settings out of Git

`/gui-setup --project` and `/gui-backend --project` write `.pi/gui.local.json`. When your project is a Git repository and that file is not ignored yet, Pi offers once to add it to `.gitignore`. With `--fix` it adds the line without asking. With `--no-fix`, or in print or JSON mode without `--fix`, the report only warns you. Pi never writes through a `.gitignore` that is a symbolic link or not a regular file; it warns instead.

### Running commands from scripts

Commands never ask questions in print mode (`pi -p`) or JSON mode (`pi --mode json`). There the report goes to standard error (print) or arrives as a message (JSON), and the exit code is 1 when a required check fails. In RPC mode the connected client can answer questions, so commands behave as in the interactive screen: setup may ask, the report arrives as a message, and the exit code is not changed. Close standard input when you script print mode (`pi -p "…" </dev/null`), because Pi otherwise waits for input.

A setup that needs a decision without a way to ask stops with the option that would answer it, for example `re-run with /gui-setup cua --accept-billing`.

### `/gui-setup` options

Every question setup can ask has an option, so a complete command runs without questions.

| Option | Backends | Meaning |
|---|---|---|
| `--fix` | all | Apply every proposed fix that needs no password, without asking. |
| `--no-fix` | all | Never apply fixes; only report. |
| `--project` | all | Save the backend, server, and related settings for this project only (`.pi/gui.local.json`), instead of for all projects. |
| `--host <alias or user@host>` | `remote-linux`, `remote-linux-docker` | The SSH server. Without it, setup uses `remote.host` from `.pi/gui.local.json`, then from your global settings, then lists the hosts in your `~/.ssh/config` (interactive screen only). Setup stores what you give, never the resolved address. |
| `--purge-tooling` | `remote-linux-docker` | Remove the base image from the server after every session instead of keeping it. Stored as `remote.purgeTooling: true`. Running setup again without the option keeps the stored value; set the field to `false` or remove it to turn it off. |
| `--accept-billing` | `cua` | You accept that each session creates a sandbox that bills your cloud account, and that the project files allowed by the sync rules are uploaded into it. Without it, the interactive screen asks once. |
| `--cloud aws\|gcp\|hetzner\|modal` | `cua` | The cloud for sandboxes. Default: the cloud you chose with `cua cloud connect … --default`. |
| `--rate-usd-per-hour <n>` | `cua` | Your cloud's price per sandbox hour, from 0 to 1000. Used for the cost estimate only when Cua reports no price. |
| `--image <image>` | `cua` | The sandbox image: a Cua image alias or a registry reference. Default: Cua's `linux` image. Your own image needs the helper's packages, or `apt-get` as root or with passwordless sudo. Changing the image later blocks new sessions until you run `/gui-doctor cua`. |
| `--targets linux,windows,macos` | `cua` | The platforms to check. `windows` passes only where Cua offers Windows for your cloud; `macos` is refused in this release. |
| `--windows-image <image>` | `cua` | The image of Windows sandboxes: a Cua image alias or a registry reference. Default: Cua's `windows` image (Windows Server 2022, without a license). Changing it later blocks new sessions until you run `/gui-doctor cua`. |
| `--windows-rate-usd-per-hour <n>` | `cua` | Your cloud's price per Windows sandbox hour, from 0 to 1000, for the estimate when Cua reports none. The Linux price is never used for Windows. |
| `--accept-windows-license` | `docker-windows` | You confirm that you are responsible for licensing the Windows that setup downloads and installs. Without it, the interactive screen asks once; in print or JSON mode setup stops with `needs-user-action`. |
| `--windows-version <v>` | `docker-windows` | The Windows version dockurr/windows installs, for example `11` (default), `10`, or `2025` (letters, digits, `.`, `_`, `-`). Applies to the next install. |
| `--vm-ram-gb <n>` | `docker-windows` | RAM of each VM in GB, 2 to 512 (default 4). Applies to every new session. |
| `--vm-cpus <n>` | `docker-windows` | CPU cores of each VM, 1 to 128 (default 2). Applies to every new session. |
| `--vm-disk-gb <n>` | `docker-windows` | Size of the Windows disk in GB, 64 to 4096 (default 64). Applies to the next install. |

The VM options are stored when setup runs, even if a later check fails. To change the version or disk size of an installed Windows, run `/gui-reset docker-windows`, then `/gui-setup docker-windows` with the options again: the reset also removes the stored VM settings.

An option that does not fit the chosen backend is refused with a message naming the backend it belongs to; it is never silently ignored. `--api-key-env` is always refused: for `cua` because it uses your `cua auth login` session and needs no API key, and for every other backend because it is not one of its options.

Without a backend name, the interactive screen lists only the backends that run on your computer's operating system.

Passing `--fix`, `--accept-billing`, or `--accept-windows-license` counts as your explicit approval.

### `/gui-doctor` options

| Option | Meaning |
|---|---|
| `--host <alias or user@host>` | Remote backends only. Without it, doctor checks the configured server: `remote.host`, else the server recorded at setup. With a different server, doctor only checks it and leaves the ready status alone; the report says how to switch with `/gui-setup <backend> --host <server>`. |

### What setup never does for you

Some steps need a password or your judgment, so setup shows the exact command and stops:

- copying your SSH key to a server (asks for the server password once);
- trusting a server's host key the first time;
- anything that needs a `sudo` password, on your computer or on a server;
- signing in to cua.ai or connecting a cloud account;
- turning on hardware virtualization in your computer's firmware.

Run `/gui-setup` again afterwards. It continues from the checks.

## Using a server from your SSH config

The remote backends use your own `~/.ssh/config`: aliases, keys, agent, and jump hosts all work as they do for `ssh`.

Without `--host`, setup reads the `Host` entries of `~/.ssh/config` (including files added with `Include`) and shows each server with its status: `ready`, `auth needed`, `host key unknown`, `host key changed`, `unreachable`, or `not Linux`. "Other host…" lets you type `user@host` or `ssh://user@host:port`, and the report shows a `Host` block you can add to your SSH config yourself. The package only reads that file. It never changes it or sends it anywhere.

Before the first setup for a new server, do these two things once:

```bash
ssh-copy-id me@raspi5   # install your key; asks for the server password
ssh me@raspi5           # check and accept the host key, then exit
```

Every connection runs without password prompts (`BatchMode`), refuses unknown or changed host keys, adds nothing to `known_hosts`, and forwards no agent, X11, or ports. One shared connection serves each session and ends itself one minute after its last use, even if Pi crashes. Pi never connects to a server when it starts; leftovers on a server are removed by the next session start there or by `/gui-cleanup`.

Package installs on the server run automatically only when `sudo` works there without a password and you approve the fix. Otherwise setup shows a command such as `ssh -t myserver sudo apt-get install …` for you to run. Package names are known for pacman, apt, dnf, zypper, and apk.

### How your project gets to the server

- Each session start copies the project files allowed by the sync rules (see [Security and privacy](#security-and-privacy)) to a session folder on the server. The status line says how many files were sent, how many bytes, and how.
- With rsync on both ends and an alias or `user@host` server, only changes are sent. Otherwise, and for `ssh://…:port` servers, a full copy is sent each time.
- The copy on the server is the app's workspace. With `remote-linux` the app can write in it; with `remote-linux-docker` it is mounted read-only unless you use `"workspaceMode": "copy"`. Changes never come back to your computer.
- `setup` commands run on the server: in the session folder for `remote-linux`, inside the container for `remote-linux-docker`. They never run on your computer.
- With `remote-linux`, `setup` installs into the session's dependency folder: `pip install` works without a virtual environment, and `npm install -g` lands there too. `pip install --user` fails there; set your own `PIP_TARGET` in `deps.env` if you need a different location.

## Cloud sandboxes with `cua`

`cua` runs each session in a fresh sandbox that the `cua` tool creates in your own cloud account. Cua's hosted cloud service (and its API keys) ended on 18 October 2026; this backend uses the open-source `cua` tool with your own cloud instead.

Set up once in a terminal, outside Pi:

```bash
cua auth login                                     # browser sign-in to cua.ai
cua cloud connect aws --region us-west-2 --default # or gcp, hetzner, modal
cua cloud test aws                                 # optional; creates nothing
```

Then run `/gui-setup cua`, or `/gui-setup cua --accept-billing` to accept billing and the upload without a question.

What happens in each session:

1. The sandbox is created in your cloud. Billing starts here. The first launch takes a few minutes.
2. The package's helper is copied into the sandbox. Missing helper packages are installed inside the sandbox with `apt-get`, never on your computer; when a `setup` command uses `pip`, `python3-pip` is installed too. The helper runs as the sandbox user and keeps its files, and what `setup` installs, in the session's own folder, so the image needs no writable `/deps` and no `python3-venv`.
3. Your project files, without secrets, are uploaded once. Changes the app makes stay in the sandbox.
4. `setup` commands run in the sandbox, then the app starts.
5. When the session stops, the sandbox is deleted, unless `keepSandbox` is on.

**Cost.** The estimate is sandbox time multiplied by the hourly price that `cua cloud status` reports for your cloud, or the price you gave with `--rate-usd-per-hour`. A sandbox kept by `keepSandbox` keeps counting toward the daily estimate between sessions, until it is deleted; reusing it never counts it twice. `/gui-usage` shows the estimate for each session and for today. It counts only sandboxes this Pi process has used. When a session reuses a sandbox kept by an earlier Pi run, that session's estimate starts at the reuse, but the daily estimate counts the sandbox from when it was created (its kept time included, from local midnight on). When it passes `usageCheck.warnSessionCostUsd` or `usageCheck.warnDailyCostUsd`, Pi gets a warning; it is never stopped. Your cloud's bill is what counts: minimum charges, disks, and network traffic are not in the estimate. Set a budget in your cloud account.

**Cleanup.** The sandbox is deleted on `gui_stop`, a failed start, the idle timeout, quitting Pi, and `/gui-cleanup`. If Pi is killed, the next Pi start deletes it. At the latest, your cloud's expiry deletes it (`cua cloud connect <cloud> --ttl-hours 8`; 8 hours by default). `cua cloud sweep --delete` removes anything Cua itself recorded and left behind.

**`keepSandbox`.** With `"keepSandbox": true` in `.pi/gui.local.json`, a stopped session keeps its sandbox, and the next session of the same project in the same cloud reuses it after clearing it and uploading the project again. It is reused only when it was made from the image you have configured now (`--image`); after you change the image, a new sandbox is created and the old one stays kept, and `gui_launch` names it. A sandbox kept by an earlier version of this package, which did not record its image, is never reused; `gui_launch`, `/gui-cleanup`, and `/gui-doctor` list it. Delete such sandboxes with `/gui-reset cua`. Reuse saves creating the sandbox and installing the helper's system packages, but `setup` still runs every session. A kept sandbox **keeps billing**, your project files stay in your cloud, and it still expires with your cloud's expiry time. An expired one is replaced automatically. If Cua cannot say whether the kept sandbox still exists (for example a network error), the start fails and the sandbox stays recorded, so no second sandbox is created; try again, or delete it with `/gui-reset cua`. `/gui-reset cua` deletes kept sandboxes, and any sandbox whose deletion did not finish.

## Windows apps

The Windows backends are new and have not run on real Windows yet. They work like the Linux ones: Pi finds controls through UI Automation (Windows' accessibility interface), clicks and types, and takes screenshots, without anything appearing on your own desktop.

### `local-windows` sessions

- The app runs on a private desktop that the package creates for the session. It is never shown on your screen and its windows are not on your taskbar. Clicks and typing go to the app's windows directly, not through your mouse and keyboard.
- Each session start takes about 10–20 seconds: the helper compiles itself with Windows' built-in C# compiler before it answers (Pi waits up to 45 seconds).
- In `mount` mode (default) the app runs in your project folder and can change files there. In `copy` mode it runs in a filtered copy without secrets and without dependency folders such as `node_modules` or `.venv`.
- `setup` commands never run; the app uses what is already installed on your computer. `"network": "none"` is refused.
- Before Pi gets the session, the package checks that the app is on the private desktop and that your foreground window did not change during the start. If you switched windows yourself during those seconds, the start is refused; start it again.
- Session files live in `%LOCALAPPDATA%\Temp\pi-gui-testing-win-<id>`, readable only by you, and are removed when the session ends. If a junction or link replaces a folder in there while it is being removed, the package stops at that folder and reports it instead of following it.
- When the session ends, Windows ends the session's jobs and every app in them. A process the session recorded that is still running outside those jobs is reported, never ended by the package; end it yourself if you want it gone.
- If Pi exits without stopping the session, it ends the helper only after checking that the process ID still belongs to the helper it started (same start time).

### `docker-windows` install and sessions

`/gui-setup docker-windows` installs Windows once:

1. You confirm the licensing notice (or pass `--accept-windows-license`).
2. Setup downloads the dockurr/windows image and creates the Docker volume `pi-gui-testing-windows-base`.
3. dockurr/windows downloads Windows from Microsoft and installs it unattended. The package adds OpenSSH Server, this computer's key, and the GUI helper. The status line shows `Windows install (N min): …`. This takes 15–30 minutes, with a limit of 2 hours.
4. Setup checks the helper files in the VM, shuts Windows down, and keeps the disk.

If the install is cancelled or Pi stops, run `/gui-setup docker-windows` again: it continues on the same volume. A timeout, a wrong VM host key, or helper files that do not match discard the attempt, and the next setup starts over.

Each session:

- starts a new container from the installed disk. Everything the session changes in Windows, including your project copy, is written to a temporary layer and thrown away with the container. After the session, the package checks that the installed disk did not change.
- copies the project files allowed by the sync rules into the VM. File names Windows cannot store (for example with `:` or `?`, a trailing dot, or `CON`) are skipped and named in the `gui_launch` result. Changes never come back.
- boots Windows (expected to take one or two minutes; Pi waits up to 6 minutes), then starts the helper (up to 90 seconds).
- runs the app on a private desktop inside the VM, as the VM's administrator account.
- runs `setup` commands in the VM in every session, up to 15 minutes each. There is no dependency cache for Windows yet.

Only one `docker-windows` session runs at a time on this computer, also across several Pi windows that share the same settings folder. A start waits up to 30 seconds while another Pi window admits its session. A session left by a Pi that is no longer running is removed when the next session starts. `workspaceMode` has no effect: the app always gets a writable copy.

### Windows sandboxes with `cua`

- Windows sandboxes start only on a cloud for which `cua cloud status` lists a supported Windows image. As of `cua` 0.9, none of AWS, Google Cloud, Hetzner, or Modal does; setup and `gui_launch` then refuse Windows with Cua's reason, before anything is created or billed.
- The default image is Cua's `windows` image (Windows Server 2022, no license). Choose another with `--windows-image`.
- Session files live in `C:\pi-gui-testing\<session>\` in the sandbox, readable only by the sandbox user and administrators. Nothing is installed in the sandbox. The helper's files are checked against this package before the project is uploaded.
- The first launch takes minutes: Windows boots, then the helper compiles itself (Pi waits up to 3 minutes for it).
- Apps run on a private desktop in the sandbox, with administrator rights: Cua's Windows image runs every command elevated.
- Cost uses the Windows price Cua reports, else `--windows-rate-usd-per-hour`, else no estimate; never the Linux price. Windows licensing costs of your cloud are not in the estimate.
- `keepSandbox` reuses a kept sandbox only for the same platform.

### `setup` commands on Windows

With `docker-windows` and Windows sandboxes in `cua`, each `setup` command runs as a Windows PowerShell 5.1 script in the workspace folder:

- A failing PowerShell command (cmdlet) stops the script with exit code 1.
- A failing program, such as `pip` or `npm`, does **not** stop it. The exit code is that of the last program. Add `if ($LASTEXITCODE) { exit $LASTEXITCODE }` after a program to stop on its failure.
- One command can be about 2 900 characters at most; a longer one is refused before a sandbox or VM starts.
- A project that tests both Linux and Windows needs commands that work in both `sh` and PowerShell, because `setup` has no per-platform list.

## Dependency cache

When `.pi/gui.json` has `setup` commands, the first session runs them and stores what they installed on your computer. Later sessions of the same project restore it and skip `setup`.

- **Backends:** `docker-linux`, `remote-linux`, and `remote-linux-docker`. `local-linux` and `local-windows` never run `setup`; `docker-windows` and Windows sandboxes run it every session (no cache for Windows yet); and `cua` does not use the cache in this release: `setup` runs and installs your project's dependencies in every `cua` session, also in a sandbox reused with `keepSandbox` (reuse only skips reinstalling the helper's system packages).
- **What is cached:** only the session's dependency folder: `/deps` in containers, the session's dependency folder on a `remote-linux` server. Changes `setup` makes in the home folder or `/tmp` are not restored on a later session.
- **Writable workspaces:** when `setup` changes the project folder itself (for example `npm install` creating `node_modules` in `copy` mode or on `remote-linux`), the run is not stored, because restoring the cache could not repeat that change. The result says `not stored: setup changed the workspace, and only the deps dir is cached`.
- **When a new entry is needed:** the cache key covers your lockfiles and manifests (`requirements*.txt`, `pyproject.toml`, `uv.lock`, `poetry.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock` in any folder), the `setup` commands, `deps.env`, the backend, the base image or helper version, the processor type, and the target's operating system, C library, and Python version. Changing any of them creates a new entry. Use `deps.keyFiles` (gitignore-style patterns) to choose the files yourself. Key files behind symbolic links, or inside `.git`, `node_modules`, virtual environments, or build folders, are not counted.
- **What the result shows:** `gui_launch` prints a line such as `dependency cache: hit: restored 812 entries (143.2 MB) from the cache; setup skipped (key …)` or `dependency cache: miss: setup ran; …`.
- **Size:** 5 GB in total for all projects by default (`depsCache.maxSizeGB`). The least recently used entries are removed first. An entry larger than the whole limit is not stored.
- **Safety:** each entry is checked against its checksum before use. Your computer only stores and forwards the archives; they are unpacked inside the session under strict rules (nothing outside the dependency folder, no links out of it, no devices, no owners or setuid bits). A damaged or rejected entry is deleted and `setup` runs again.
- **Problems never stop a session:** if the cache cannot be used, `setup` simply runs and the result says why.
- **Turn it off** with `"depsCache": { "enabled": false }`. **Empty it** with `/gui-cleanup --deps`.

## Configuration

Settings are read in this order, field by field: options you pass to a command, then the project's personal file, then your global settings, then built-in defaults. The shared `.pi/gui.json` only holds how to set up and start the app; a backend, server, or limits written there are ignored with a warning.

| File | Purpose | Commit it? |
|---|---|---|
| `.pi/gui.json` | How to set up and start this project's app | Yes |
| `.pi/gui.local.json` | Your backend, server, cache, and limits for this project | No. Setup offers to add it to `.gitignore`. |
| `~/.pi/agent/gui/config.json` (inside Pi's agent folder; see `PI_CODING_AGENT_DIR` below) | Your default backend and settings, and the list of verified backends | — |
| `~/.pi/agent/gui/cua.json` | Written by `/gui-setup cua`: when and for which cloud you accepted billing, the chosen cloud, the Linux and Windows sandbox images, and the prices you entered. Contains no credentials. | — |
| `~/.pi/agent/gui/docker-windows/settings.json` | Written by `/gui-setup docker-windows`: when you confirmed the licensing notice, the VM size settings, and the install record. Contains no password. | — |

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
| `targets` | Platforms the app should be tested on: `linux` (default), `windows`. The first one is the default target of `gui_launch`. `macos` is planned. |
| `setup` | Commands that install the app's dependencies in the session: inside the container, on the server, or in the sandbox. They run from the project folder, with up to 15 minutes per command. A failing command stops the session and shows its last output. With the dependency cache, they run only when the cache has no matching entry. `local-linux` never runs them and warns that they were skipped. |
| `launch` | The default command that starts the app. |
| `workspaceMode` | `mount` (default) or `copy`. What each one means depends on the backend; see [Security and privacy](#security-and-privacy). |
| `deps.keyFiles` | Files whose changes mean dependencies must be reinstalled, as gitignore-style patterns. Default: the lockfiles and manifests listed under [Dependency cache](#dependency-cache). |
| `deps.env` | Extra environment variables for the `setup` commands. They are part of the cache key. |
| `sync.deny` | Extra files never sent to servers or sandboxes, or into the `copy`-mode workspace. |
| `sync.allow` | Files sent or copied even though they match the built-in secret list. Use with care. |
| `network` | `default`, or `none` to run the app without network access. `none` works with `docker-linux` and `remote-linux-docker`. `local-linux`, `remote-linux`, `cua`, `local-windows`, and `docker-windows` refuse it, because they cannot enforce it; a session never starts with a network setting it does not apply. |

Pi proposes `setup` and `launch` after its first working run and shows them to you before saving.

### `.pi/gui.local.json` and the global settings

```json
{
  "backend": "remote-linux-docker",
  "remote": { "host": "raspi5", "purgeTooling": false },
  "depsCache": { "enabled": true, "maxSizeGB": 5 },
  "keepSandbox": false,
  "limits": { "maxConcurrentSessions": 2, "idleTimeoutMinutes": 15 },
  "usageCheck": { "warnSessionCostUsd": 1, "warnDailyCostUsd": 5 }
}
```

| Field | Default | Meaning |
|---|---|---|
| `backend` | none | The backend for this project. |
| `remote.host` | none | SSH alias or `user@host` for the remote backends. Changing it after setup blocks new sessions until you run `/gui-doctor`. |
| `remote.purgeTooling` | `false` | `remote-linux-docker`: remove the base image from the server after the last session ends. The next session rebuilds it, which takes several minutes. |
| `depsCache.enabled` | `true` | `false`: `setup` runs every session, and nothing is read from or stored in the cache. |
| `depsCache.maxSizeGB` | `5` | Size limit of the whole cache, for all projects, in GB (1024³ bytes). Above 0 and at most 10000. |
| `keepSandbox` | `false` | `cua`: keep the sandbox after a session and reuse it. Faster, but it keeps billing and your project files stay in your cloud. |
| `limits.maxConcurrentSessions` | `2` | Sessions that may run at the same time. `docker-windows` runs at most one session at a time regardless. |
| `limits.idleTimeoutMinutes` | `15` | A session without activity for this long is shut down and cleaned up. There is no maximum session length. |
| `usageCheck.warnSessionCostUsd` | `1` | Estimated `cua` cost per session that triggers a warning. |
| `usageCheck.warnDailyCostUsd` | `5` | Estimated `cua` cost per day (since local midnight) that triggers a warning. |

### Environment variables

| Variable | Meaning |
|---|---|
| `PI_CODING_AGENT_DIR` | Pi's agent folder. The package keeps its settings in a `gui` folder inside it. Default: `~/.pi/agent`. |
| `XDG_CACHE_HOME` | Moves the dependency cache to `$XDG_CACHE_HOME/pi-extension-gui-testing/deps`. |
| `TMPDIR` | Where session folders are created. `local-linux` needs a short path here; see [Troubleshooting](#troubleshooting). |
| `DOCKER_HOST` | Which Docker `docker-linux` uses, instead of the current `docker context`. |

The `cua` tool reads its own variables and your cloud's credentials. The package passes `CUA_*` variables, your cloud's standard variables (`AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `HCLOUD_*`, `MODAL_*`), and proxy settings through to it, and never stores them. `CUA_API_KEY` is no longer used.

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

The `gui_launch` result also shows:

- the processor type the app runs on (`arch:`), which on a server can differ from your computer's;
- where the workspace is and whether the app can write to it, for example `the project directory itself (writable)` for `local-linux` or `read-only mount of the copy synced to raspi5` for `remote-linux-docker`;
- the network mode;
- the dependency cache result;
- backend warnings, such as `setup` commands that `local-linux` skipped, in a list headed `<backend> warnings:`.

### Session rules

- **Limits:** at most `limits.maxConcurrentSessions` sessions run at once. A session with no tool call for `limits.idleTimeoutMinutes` is stopped; a call that is still waiting or running counts as activity, so a long `gui_wait` is never cut off.
- **After an update or a change:** before each new session, the package compares what setup recorded with what it finds now. That covers the package, Pi, and helper versions, and per backend the Docker versions and base image (`docker-linux`), the Python version (`local-linux`), the configured server (remote backends), the Docker versions, dockurr/windows image, and Windows install (`docker-windows`), or the `cua` tool version, cloud, region, and Linux and Windows sandbox images (`cua`). `local-windows` checks only the package, Pi, and helper versions; run `/gui-doctor local-windows` after a Windows feature update. If anything changed, new sessions are refused until you run `/gui-doctor <backend>`. Sessions that are already running continue. The first session after updating this package always asks for `/gui-doctor` once.
- **Failed cleanup:** if stopping a session, or a failed start, leaves something behind, the message says what and names the session. The session stays listed and refuses other tools until `gui_stop` again, `/gui-cleanup`, or Pi's shutdown removes everything. It no longer counts against the session limit.
- **Quitting Pi:** Pi cancels a running setup or session start, waits up to 20 seconds for it, then stops every session.
- **Exports:** `gui_export` and `/gui-export` can be cancelled and stop after 2 minutes, even in the middle of a file. Files copied completely until then stay in the folder; a partly copied file is removed. A destination inside the session's temp folder, also through a symbolic link, is refused because it would be deleted with the session.
- **Logs:** `gui_logs` keeps the last 10 000 output chunks or about 1 MiB of output in memory. The session's `app.log` stops at 64 MiB and notes when lines were dropped.
- **Snapshots:** very long names or values are cut at about 64 000 characters, and an element whose position is unusable is listed without one.
- **Warnings:** configuration warnings (unknown fields, or a backend or limits in the shared `.pi/gui.json`) appear in every command report and in the `gui_launch` result, also when the launch fails. Usage warnings count failed launches too.

## Where data is stored

Your project data stays on your computer. Servers, sandboxes, and containers hold it only while a session runs, except a `cua` sandbox you keep with `keepSandbox`.

| Location | Contents | Lifetime |
|---|---|---|
| Your system's temp folder, `pi-gui-testing-*` | Screenshots, accessibility dumps, logs, sync staging, and the SSH connection socket for one session. For `local-linux`, also the private screen's runtime files. | Deleted when the session ends. Leftovers from a crash are deleted the next time Pi starts. |
| Your system's temp folder, `pi-gui-displays-<uid>` (`local-linux`) | Locks for the private screen numbers in use | Each lock is removed with its session. An empty folder may remain; that is expected. |
| Docker image `pi-gui-testing-base:<package version>` | Tools only: the virtual screen, accessibility libraries, app runtimes, and the test app. No project files. | Kept so later sessions start fast. Removed by `/gui-reset docker-linux`. |
| Docker container `pi-gui-testing-<session>` | The running session | Removed when the session ends, when Pi exits or crashes (the container stops by itself within about a minute), or by the next startup cleanup. The startup cleanup and `/gui-cleanup` look for leftover containers whenever a `docker` command is installed, even if setup never finished. |
| `~/.cache/pi-extension-gui-testing/deps/` (or under `XDG_CACHE_HOME`) | Installed dependencies per project and processor type, as `.tar.gz` archives with checksums | Kept; up to `depsCache.maxSizeGB` (5 GB), oldest entries removed first. Removed by `/gui-cleanup --deps`. |
| `~/.pi/agent/gui/` (or `gui/` inside `PI_CODING_AGENT_DIR`) | Settings, verified backends, the recorded server host keys, `cua.json`, and `cua-sandboxes/` (one record per sandbox this computer created, so a crash can be cleaned up, and a `.lock` file that keeps two Pi processes from changing the records at once) | Kept until `/gui-reset`. A sandbox record is removed once its sandbox is deleted. |
| On a server: `$XDG_RUNTIME_DIR/pi-gui-testing`, else `/tmp/pi-gui-testing-<uid>`, else `~/.cache/pi-gui-testing-tmp` | One folder per session with your synced project, the helper, installed dependencies, and runtime files | Deleted when the session stops, fails to start, times out, or Pi exits. After a lost connection the server removes it by itself as soon as the session's helper (or container) ends. The parent folder is removed when no session is left. Anything still left is removed by the next session start there or `/gui-cleanup`. A session folder that is a symbolic link or not yours is reported and never followed. |
| On a server: Docker base image (`remote-linux-docker`) | Tools only, no project files | Kept unless you use `--purge-tooling`. |
| On a server: system packages | Tools you agreed to install at setup | Kept. Remove them yourself if nothing else needs them. |
| `cua`: one sandbox per session in your cloud | The helper, your synced project, installed dependencies | Deleted when the session ends, unless `keepSandbox` is on. |
| `local-windows`: `%LOCALAPPDATA%\Temp\pi-gui-testing-win-<id>` | The session's runtime files and, in `copy` mode, the project copy. Only you can open it. | Deleted when the session ends. Leftovers of a crashed Pi are removed by the next Pi start or `/gui-cleanup local-windows`, which first reads the session's record in the folder. A folder that could not be removed after a failed start stays listed and is retried. |
| `docker-windows`: `~/.pi/agent/gui/docker-windows/` (or inside `PI_CODING_AGENT_DIR`) | `settings.json`, this computer's key for the VM (`id_ed25519`, owner-only), the VM's public host key, and a `known_hosts` file used only for the VM. During the install, also the staged install files. While a session runs, `session-lease.json` names it, and `session-lock/` holds the short-lived lock around session starts. | Kept until `/gui-reset docker-windows`. The lease is removed when its session ends; a lease of a Pi that is gone is replaced by the next session start. |
| `docker-windows`: Docker volume `pi-gui-testing-windows-base` | The installed Windows disk with OpenSSH Server and the helper. Tools only, never project files. | Kept so later sessions start fast. Removed by `/gui-reset docker-windows`. |
| `docker-windows`: Docker image `dockurr/windows` (6.06, pinned) | The container that runs the VM. It does not contain Windows. | Kept. Removed by `/gui-reset docker-windows`. |
| `docker-windows`: containers `pi-gui-testing-win-<session>` and `pi-gui-testing-windows-install` | A running session's VM, or the running install | Removed when the session ends (with everything the session wrote) or the install finishes. Leftovers of a crashed Pi are removed by the next Pi start or `/gui-cleanup docker-windows`. |

Screenshots that Pi already received are part of your Pi session history, not of this package's storage. Use `/gui-export` to keep files.

## Security and privacy

### What each backend can see and change

| Backend | `mount` (default) | `copy` | Network |
|---|---|---|---|
| `docker-linux` | The container reads your whole project, including `.env` files and keys. It cannot change it. | The container gets a writable copy of the selected files, without secrets. | On; `"network": "none"` turns it off. |
| `local-linux` | The app runs in your project folder as you and **can change any file there** and anything else your user can. | The app runs on a writable copy of the selected files, without secrets. Dependency folders are not copied. | Always on; `"network": "none"` is refused. |
| `remote-linux` | The app gets a writable copy on the server, without secrets. | Same. | The server's network. `"network": "none"` is refused. |
| `remote-linux-docker` | The container reads the copy on the server without secrets. | The container gets a writable copy on the server. | On; `"network": "none"` turns it off. |
| `cua` | The app gets a writable copy in the sandbox, without secrets. | Same. | Always on; `"network": "none"` is refused. |
| `local-windows` | The app runs in your project folder as you and **can change any file there** and anything else your user can, including your Windows profile and registry. | The app runs on a writable copy of the selected files, without secrets. Dependency folders are not copied. | Always on; `"network": "none"` is refused. |
| `docker-windows` | The app gets a writable copy in the VM, without secrets, thrown away with the session. | Same. | On, through Docker's network; `"network": "none"` is refused. |

### Containers on your computer (`docker-linux`)

- **Mount mode** shows the container every file in your project, including `.env` files and keys, and setup commands run with network access by default. The secret list below does not apply. Use `workspaceMode: "copy"` to keep secret files out, or `network: "none"` when setup runs install scripts you don't trust.
- **What mount mode refuses:** the file system root, your home folder or a folder above it, and system folders such as `/run/user`, `/run/dbus`, `/var/run`, or folders above `/tmp/.X11-unix`. It also refuses a project that contains a socket file anywhere, including inside `.git`, `node_modules`, or virtual environments, because the container could connect to it. If the full-folder check takes longer than 20 seconds or a folder cannot be read, the session is refused too. Each refusal suggests `copy` mode.
- **Docker Desktop on macOS** also refuses Docker Desktop's own folders (`~/.docker`, `~/Library/Containers/com.docker.docker`, `~/Library/Group Containers/group.com.docker`) and `/var/run`.
- **Docker Desktop on Windows** refuses drive roots, network share roots, your user profile folder and the folders above it, Docker Desktop's folders (`%USERPROFILE%\.docker`, `%LOCALAPPDATA%\Docker`, `%APPDATA%\Docker`, `%APPDATA%\Docker Desktop`, `%ProgramData%\Docker`, `%ProgramData%\DockerDesktop`), and `C:\Windows`. Use copy mode, or open Pi in the project folder.
- **Mount check:** after the container starts, the package confirms that `/workspace` is exactly the folder it checked, before setup or the app runs. If not, the session stops. On Docker Desktop, this check compares the folder's listing, because file sharing changes the file identity Linux uses.
- **Copy mode** gives the container a writable copy of the selected files in your session's temp folder. Files inside a folder that is a symbolic link are never copied. If a file or folder changes into a link or another file during the copy, the session stops with `changed while the workspace was being copied`; try again.
- **Container restrictions:** containers run as your own user ID (on Windows, as user 1000), with no extra privileges, no access to your display, session bus, or Docker socket, and a read-only system. `isolation.inspect` confirms these restrictions before every session; a session that does not meet them is refused.

### Your computer without a container (`local-linux`)

- The app runs **as you**, with your file access and your network. It runs on a private virtual screen (`:90` or higher, never `:0` or a screen in use) with its own session bus and accessibility bus, so nothing appears on your desktop, on X11 or Wayland. Each private screen has its own access cookie, so other users on the computer cannot connect to it.
- The app sees a private, empty home folder and temp folder. It does not see your dotfiles, desktop settings, or `pip --user` packages, and single-instance apps cannot hand off to a copy running on your desktop.
- Toolkits are forced to X11 (`GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`, `SDL_VIDEODRIVER=x11`, `ELECTRON_OZONE_PLATFORM_HINT=x11`), and the desktop's `WAYLAND_DISPLAY` is removed. The `env` of a launch cannot override these.
- `setup` commands never run, and nothing is installed for your project. The app uses your project's existing virtual environment, `node_modules`, and system libraries.

### Servers (`remote-linux`, `remote-linux-docker`)

- **Passwords:** the package never asks for, stores, or sends SSH or `sudo` passwords. It uses your existing SSH keys and agent.
- **No open ports:** nothing listens on your server. Everything runs through your SSH connection.
- **No desktop leaks:** commands on the server never get your computer's display, Wayland, session bus, or `XAUTHORITY`. The helper starts with a clean environment, and its access token never appears on any command line.
- **Leftovers of other computers:** session folders and containers that another computer (or an earlier boot) left on the server are never removed while their programs run. A foreign folder with no running program is reported, and removed only after 24 hours.

### Cloud sandboxes (`cua`)

- **No credentials stored:** your cua.ai sign-in stays in the `cua` tool's own store or your system keychain, and your cloud credentials stay in your cloud's tool. The package stores, reads, and sends none of them.
- **Upload:** the project files allowed by the sync rules are uploaded for every session. Secrets are never uploaded.
- **Relay:** sandboxes connect to Cua's relay (`relay.cua.ai`) under your cua.ai account, so the sandbox opens no public port. The helper stream and uploaded files pass through that relay.
- **Sandbox names** contain a short hash of your machine ID, not the ID itself, so a cloud listing can tell your computers apart.
- **Costs:** your cloud bills sandbox time. The package has no spending cap; set a budget in your cloud account.

### Windows on your computer (`local-windows`)

- The app runs **as you**, without administrator rights, on a private desktop of the session. It cannot draw on your desktop or read your screen through the package.
- Unlike `local-linux`, the app sees your real user profile: `%APPDATA%`, `%LOCALAPPDATA%`, and the registry. Only `TEMP` and `TMP` point into the session folder. Settings an app saves, and data of Electron or Chromium apps, stay in your profile.
- Every app the session starts is contained in Windows jobs that end with the session. Programs Windows starts on the app's behalf outside those jobs (for example Store apps such as Windows 11 Notepad, or COM servers) may run outside the private desktop and survive the session; the package reports what it recorded and cannot see.
- Cleanup ends only the session's own jobs and the helper the package started. The app can write every file in the session folder, so a process named only there is reported and never ended: an app cannot make the package end another program. After a crash, cleanup ends the old helper only while Pi's own session record (in your temp folder, outside the session folder) still lists it; otherwise it reports it.
- The helper never runs elevated programs: when Pi itself runs as administrator, apps still start with your normal rights, and the helper refuses to start if that is not possible.
- No API keys or other variables from Pi's environment reach the helper or the apps; only Windows' own system variables are passed.
- Security software may react to the helper: it compiles itself with Windows' C# compiler into `%TEMP%` at every start, creates hidden desktops, and sends input to other windows. `helper.av` warns when it was blocked.

### Windows VMs (`docker-windows`)

- **Licensing:** dockurr/windows installs Windows with Microsoft's generic installation keys. Neither it nor this package gives you a license; you confirm at setup that you are responsible for it.
- **Isolation:** the VM runs in a container with all Linux capabilities dropped except the few the VM's network needs, no privileged mode, and only the KVM and network-tunnel devices. Each session's changes to Windows are discarded with its container; the installed disk is checked after every session, and a change is reported.
- **Network:** the VM's SSH port (and the optional web viewer) is published on `127.0.0.1` only, never on your network. The VM itself has internet access. The VM's SSH server accepts only this computer's key; passwords and forwarding are off. The VM account's password is random and never stored.
- **Administrator rights:** apps and `setup` commands run as the VM's administrator account. That is why `"network": "none"` cannot be enforced inside the VM.
- **Keys:** `id_ed25519` in the package's `docker-windows` folder lets this computer log in to the VM. Anyone who can read it, or who has Docker access on this computer, can reach a running VM. The VM's host key is created on your computer; its private half is deleted once the install finishes.

### Windows sandboxes (`cua`)

- Everything under [Cloud sandboxes](#cloud-sandboxes-cua) applies. In addition, apps and `setup` commands run elevated, because Cua's Windows image runs every command as an administrator.

### What is sent or copied

- **Which files:** for `copy` mode, the remote backends, and `cua`, the files Git tracks plus new files that are not ignored. Outside Git, all files except common build and dependency folders. Symbolic links that point outside the project or to a left-out file are skipped.
- **What is left out by default:** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `secrets*`, `.ssh/`, `.aws/`, `.gnupg/`, in any folder of your project. A file you list in `sync.allow` is sent anyway; `sync.deny` always wins over `sync.allow`.
- **Git:** to list your project's files, the package runs Git with file-system monitor programs and hooks turned off, so a repository's own configuration cannot run programs on your computer.

### For every backend

- **Isolation:** apps run on their own virtual screen or in a container. They cannot open windows on your desktop or on a server's own screen.
- **Cleanup check:** after every session, the package checks your computer, the server, or your cloud for leftovers and reports anything it finds.
- **Dependency cache:** it keeps what your `setup` commands installed, possibly including private packages, on your computer. It is only ever sent into your own sessions. A malicious `setup` could cache malicious packages for later sessions of the same project; that is the same trust as running `setup` itself.
- **Usage warnings:** Pi gets a warning when estimated `cua` cost passes your thresholds, or when it repeats the same action, the screen stops changing, or the app is restarted unusually often. These warnings never stop Pi; you decide whether to interrupt.

## Limitations

### All backends

- **Windows apps are a preview.** `local-windows`, `docker-windows`, and Windows sandboxes in `cua` have not run on real Windows yet. macOS apps need the planned macOS sandboxes with `cua`.
- **Tkinter apps** have no accessibility information, so Pi finds controls by screenshot and position instead of by name. This is slower and less precise.
- Java Swing apps expose names only with the Java ATK wrapper installed in the environment.
- Screenshots are taken at 1280×800 and sent to Pi at most 1280 pixels wide.
- Electron and Chromium apps get a larger shared-memory area in containers only when `launch` starts `electron`, `npx electron`, or a Chromium browser directly. An app started through `npm start` may crash on load; call `electron` directly in `launch`.

### `docker-linux`

- Rootless Docker is not supported yet. Docker on another machine is not supported; use `remote-linux-docker` for that.
- The base image is built for your Docker's processor type. x86-64 and ARM64 are supported.
- `/gui-setup` measures free space in your temp folder, not in Docker's own storage folder.
- **Docker Desktop on macOS:** the container runs as your user. Files outside the folders Docker Desktop shares by default (`/Users`, `/Volumes`, `/private`, `/tmp`, `/var/folders`) need to be added under Settings → Resources → File sharing.
- **Docker Desktop on Windows:** only a local named pipe works as the Docker endpoint. The container runs as user 1000; files it writes in copy mode appear as yours through Desktop's file sharing. With the Hyper-V engine, the drive with your project and temp folder must be shared. The first cleanup after Pi starts may take a second or two.
- **Several operating systems on one Docker Desktop** (for example Pi on Windows and Pi in WSL): each reports, but never removes, the other's leftover containers.

### `local-linux`

- No network isolation and no read-only view of your project.
- Linux computers only. The helper runs with your system Python.
- Without AT-SPI and pyatspi, `gui_snapshot` reports `coverage: none`; Pi then works from screenshots and positions. Without openbox, dialogs may open at the top-left corner and window activation may not work.
- `copy` mode does not copy dependency folders such as `node_modules` or virtual environments, so the app may not find them.

### Remote backends

- Your computer must run Linux or macOS. Windows clients are planned.
- On a Raspberry Pi or other ARM server, the app runs on ARM. Apps that ship only x86 programs do not work there. 32-bit ARM systems only get a warning and limited app support.
- Login shells csh and tcsh are not supported.
- Without rsync on both ends, every session start sends a full copy of the project.
- **`--purge-tooling` makes every session start slow:** the base image is rebuilt on the server each time (several minutes). Only the last session of this Pi on that server removes the image; another computer using the same server may see a removal fail while its container uses the image, which is reported as a leftover. The test at the end of setup never removes the image, so the first real session does.
- Pi never connects to a server at startup, so leftovers of a crashed Pi stay on the server until the next session start there or `/gui-cleanup <backend>`.
- `/gui-doctor --host` compares names as written: `raspi5` and `me@raspi5` count as different servers.

### Windows apps (all Windows backends)

- **Screenshots can be black** for apps drawn by the graphics card (some WPF, DirectX, or Electron apps without `--disable-gpu`). The result then marks the screenshot as all black; Pi works from the accessibility tree instead. The private desktop's "screen" is the app's windows on a black background.
- Positions for clicks are measured in the whole window, including its title bar and borders.
- Apps that read the keyboard directly (raw input, DirectInput, games) may not react to typed keys, because keys are sent to the window instead of the keyboard.
- Windows Store apps and programs started through COM may open outside the session's private desktop.
- The helper is an unsigned PowerShell script that compiles itself at every start. A Group Policy execution policy of `AllSigned` or `Restricted`, AppLocker or WDAC constrained language mode, or security software that blocks runtime compilation stops it. A signed helper program may follow.
- There is no dependency cache for Windows targets.

### `local-windows`

- No network isolation and no read-only view of your project. Apps share your Windows profile.
- Each session start takes 10–20 seconds (the helper compiles itself, twice when Pi runs elevated). Switching windows yourself during the start can make it fail; start again.
- When an app hangs, a screenshot, snapshot, or click can time out. After two such operations are still stuck, the next one ends the session (the hung app with it); start a new one.
- A `snapshot` holds at most 20 000 elements, and at most 1 000 windows are listed (fewer when their titles are very long; `gui_launch` then says the list was cut). A full tree larger than the transfer limit is refused; use the shorter snapshot or a screenshot.
- A screenshot that does not compress well (photos, noise, very large screens) is scaled down further to fit the transfer limit; the reported scale says how far.
- `setup` never runs.

### `docker-windows`

- One session at a time on this computer. The first install takes 15–30 minutes; each session boots Windows (one or two minutes expected, not yet measured).
- The helper runs in the VM's background service session over SSH, not on the logged-in Windows desktop. Apps therefore run on a private desktop without the desktop's graphics composition, so screenshots of GPU-drawn apps are more likely to be black than on a real desktop.
- The install needs Windows Update to install OpenSSH Server; offline or filtered networks make it time out after 2 hours.
- `setup` commands run in every session. File names Windows cannot store are skipped.
- `workspaceMode` has no effect; `"network": "none"` is refused.
- Only Linux computers with KVM. The VM size options change the next install (version, disk) or the next session (RAM, CPUs).

### `cua`

- Linux apps from a Linux computer; Windows apps only where Cua offers Windows for your cloud (as of `cua` 0.9: nowhere). macOS sandboxes, and macOS and Windows computers as clients, are planned.
- The test at the end of setup always runs a Linux sandbox, also when you set up Windows.
- Windows sandboxes: project files whose names Windows forbids, or links the sandbox user cannot create, make the upload fail; very deep paths can hit Windows' path limits.
- `"network": "none"` is refused: sandboxes always have outbound network.
- The sandbox image must contain the helper's packages or allow `apt-get` as root or with passwordless `sudo`; otherwise the start fails and names the missing packages.
- The project is uploaded in full once per session; there is no incremental sync.
- The first launch takes minutes: create, copy the helper, and upload.
- Deleting the sandbox when Pi exits is best effort: it may take longer than Pi waits, and cloud credentials that exist only as environment variables are not available at that moment. The next Pi start, `/gui-cleanup cua`, or your cloud's expiry removes it. Until then it keeps billing.
- If Pi's settings folder is deleted, the package can no longer tell which sandboxes it created; it reports them and never deletes them on its own. Your cloud's expiry and `cua cloud sweep --delete` still remove them.

### Dependency cache

- The key cannot see everything: system packages on a `remote-linux` server (for example after an `apt upgrade`), versions resolved without a lockfile (such as `pip install requests`), and files that `setup` reads but that are not key files. When dependencies look stale, run `/gui-cleanup --deps` or list the files in `deps.keyFiles`.
- On a cache hit, files `setup` wrote outside the dependency folder (home folder, `/tmp`) are missing. Projects that depend on that need `"depsCache": { "enabled": false }`.
- After a hit, the Python virtual environment in containers is recreated, which takes a few seconds.

## Troubleshooting

| Message or symptom | Fix |
|---|---|
| `backend "<id>" is not set up` | Run `/gui-setup <id>`. |
| `backend "<id>" is not available yet` | The backend is planned. Choose one of the listed backends. |
| Setup ends with `needs-user-action` | Run the listed commands yourself, then run `/gui-setup` again. |
| `backend "<id>" changed since setup (…)` | The package, a tool version, the server, the cloud, or the `cua` sandbox image changed. Run `/gui-doctor <id>`. |
| `at most N GUI sessions can run at once` | Stop a session first, or raise `limits.maxConcurrentSessions` in `.pi/gui.local.json`. |
| `Pi is shutting down (or restarted this extension); run the command again` | Pi quit or reloaded while the command was starting. Run it again. |
| `cleanup did not finish; run gui_stop or /gui-cleanup to retry` | A container, folder, or sandbox could not be removed. Retry; if it persists, the message names what remains. |
| A `setup` command failed | The error shows the command's last output. Fix the command in `.pi/gui.json`, then start again. In mount mode with `docker-linux` the project is read-only: install into the environment, not into the project folder, or use `copy` mode. |
| `app handed off to another instance` | The app is already running elsewhere and passed the request on. Close the other copy or start the app with its "new instance" option. |
| `stale ref, take a new snapshot` | Pi used an element from an older view. It takes a new snapshot automatically. |
| A usage warning appears | Pi may be stuck in a loop. Check what it is doing and interrupt if needed. |
| Leftovers reported after a session | Run `/gui-cleanup`. If anything remains, the message names it. |
| **`docker-linux`** | |
| Docker permission denied | On Linux, add your user to the `docker` group, then log in again. On macOS, restart Docker Desktop. On Windows, add your account to `docker-users`. |
| `rootless Docker daemon …; this version needs a rootful daemon` | Use the standard (rootful) Docker daemon for now. |
| Docker reached over TCP or SSH | Point `DOCKER_HOST` or your `docker context` at the local socket (on Windows, the local named pipe). For Docker on a server, use `remote-linux-docker`. |
| `docker.endpoint` fails on macOS or Windows | Run `docker context use desktop-linux`. |
| `docker.ostype` fails on Windows | In Docker Desktop, choose "Switch to Linux containers". |
| `docker.bind-uid` fails on Docker Desktop | Allow Docker Desktop's file sharing for your project and temp folder (Settings → Resources → File sharing). |
| `the workspace contains Unix socket(s)` | Move the listed sockets out of the project, or use `workspaceMode: "copy"`. |
| `changed while the workspace was being copied` | Something changed your project during a `copy`-mode start. Start the session again. |
| `the directory mounted at /workspace is not the one that was checked` or `was replaced while it was scanned` | The project folder was moved or replaced while the session started. Start again; if it repeats on your file system, use `workspaceMode: "copy"`. |
| `the workspace socket scan did not finish within 20 s` | Your project folder is very large. Use `workspaceMode: "copy"`. |
| **`local-linux`** | |
| `linux.xvfb` or another tool check fails | Install the listed package, for example `xorg-server-xvfb` (Arch), `xvfb` (Debian/Ubuntu), or `xorg-x11-server-Xvfb` (Fedora/openSUSE). The report shows the Xvfb error it saw. |
| `local-linux never runs setup commands; …` | Expected. Install the app's dependencies in your project yourself, or use another backend. |
| `local-linux cannot block the app's network` | Remove `"network": "none"`, or use `docker-linux` for an offline run. |
| `remote-linux cannot block the app's network` | Remove `"network": "none"` (or set `"network": "default"`), or use `remote-linux-docker` or `docker-linux` for an offline run. |
| `… is too deep for the private bus sockets; set TMPDIR to a shorter path` | Start Pi with a short `TMPDIR`, such as `/tmp`. |
| `display lock dir … belongs to uid …` | Another user created that folder. Remove it, or start Pi with a private `TMPDIR`. |
| A crashed session left a display or processes | Run `/gui-cleanup local-linux`. |
| **Remote backends** | |
| `/gui-setup <id> needs an SSH host when there is no interactive UI` | Add `--host <alias>`. |
| `no SSH host is configured for <id>` | Run `/gui-setup <id> --host <alias>`. |
| `auth needed` or `Permission denied` | Install your key: `ssh-copy-id <host>`. |
| `host key unknown` | Connect once with `ssh <host>` and check the fingerprint. |
| `host key changed` | Check the new fingerprint with the server's owner, then run `ssh-keygen -R <host>` and connect once. |
| `unreachable` | Check that the server is on and SSH runs. For jump hosts, `ssh.jump` names the failing hop. |
| `remote.path` fails | Tools are only on the login shell's PATH. Add the listed folders for non-interactive shells. |
| `ssh.clean-stdout` warns | Your server prints text for non-interactive logins (for example from `.bashrc`). It still works; remove the output to silence the warning. |
| `pip install --user` fails in `setup` on `remote-linux` | Use plain `pip install`, or set `PIP_TARGET` in `deps.env`. |
| Leftovers after a lost connection | Run `/gui-cleanup <id>` once the server is back. |
| `malformed display lock record … not acted on` | A display lock file on the server is damaged, contains unexpected bytes, or was not written by this package. Nothing is stopped or removed because of it. If no GUI session runs on that server, delete the named file yourself. |
| **`cua`** | |
| `cua.cli` fails | Install the `cua` tool, or update it to 0.7 or newer, then run `/gui-setup cua` again. |
| `a kept-sandbox claim may have been saved, but the sandbox records could not be read` | A disk or permission error hit Pi's sandbox records while a `cua` session was starting. Fix the cause (for example the permissions of the `gui/cua-sandboxes` folder in Pi's agent folder), then run `gui_stop` or `/gui-cleanup`: the kept sandbox goes back to the kept set. Quitting Pi and starting it again also settles it. |
| `the cua sandbox ledger … is locked by process …` | Another Pi process on this computer is changing the sandbox records and has held them for 30 seconds. Try again. If no Pi process runs, remove the named `.lock` file. A lock left by a process that ended is recovered automatically. If the process named is your current Pi (a disk error kept it from releasing the lock), its next change of the records releases it. When this happens while a `cua` session stops, `gui_stop` reports the sandbox ("kept, but moving its ledger record to the kept set failed" or "sandbox deleted, but removing its ledger record failed") and the session stays listed: a kept sandbox is not reused or cleaned up until then, and keeps billing. Run `gui_stop` again or `/gui-cleanup`; quitting Pi retries too, and the next Pi start finishes it. |
| `the kept sandbox … was not reused` (in a `gui_launch` result) | The kept sandbox was made from another image, or by an older version that did not record its image. A new sandbox was created; the old one keeps billing until it expires or you run `/gui-reset cua`. |
| `checking the kept sandbox … (kept; try again …)` | Cua could not say whether the kept sandbox still exists. Nothing new was created. Try again later, or delete kept sandboxes with `/gui-reset cua`. |
| `cua.signin` fails | Run `cua auth login` in a terminal. |
| `cua.cloud` fails | Connect a cloud: `cua cloud connect aws --region <region> --default` (or `gcp`, `hetzner`, `modal`). |
| `cua.quota` fails | Fix what `cua cloud test <cloud>` reports. |
| `re-run with /gui-setup cua --accept-billing` | Billing was not accepted. Run setup with `--accept-billing`, or accept in the interactive screen. |
| `billing was acknowledged for <cloud>, but sandboxes would run in <other cloud>` | Run `/gui-setup cua` again to accept billing for the new cloud. |
| `"network": "none" is not available on cua` | Remove it, or use `docker-linux`. |
| `windows on <cloud>: …` (`cua.targets` fails) | Cua offers no Windows sandboxes for that cloud; the text after the colon is Cua's reason. Remove `windows` from `--targets` and `targets`, or wait for Cua to offer it. |
| `the sandbox did not start the Windows helper (it reported …); check the Windows image chosen at /gui-setup cua` | The image is not Windows, or not one the helper supports. Choose another with `/gui-setup cua --windows-image <image>`. |
| `the Windows sandbox image lacks …` | The image misses Windows PowerShell 5.1, a recent enough Windows, or `tar.exe`. Choose another `--windows-image`. |
| `the Windows helper in the sandbox does not match this package (missing or changed: …)` | Security software in the image changed or removed helper files. Use another image, or allow the files. |
| **`local-windows`** | |
| `win.powershell` fails with `Add-Type is blocked outside FullLanguage mode` | An AppLocker or WDAC policy puts PowerShell in constrained language mode. Ask your administrator to allow full language mode for your user; otherwise use `docker-windows`. |
| `win.execution-policy` fails (`… blocks helper.ps1`) | A Group Policy sets `AllSigned` or `Restricted`. Ask your administrator to allow local scripts (`RemoteSigned` or less). |
| `helper.nonelevated` fails | Start Pi from a normal, non-elevated window of your own user, with Explorer running and UAC on. |
| `helper.av` warns, or checks fail with `not checked: the helper did not start (…)` | Security software blocked the helper. Allow `helper.ps1` and PowerShell's runtime compilation (`csc.exe` in `%TEMP%`) for the package's folder. |
| `the user's foreground window changed while the helper started (…)` | You or another program switched windows during the start. Start the session again. |
| `local-windows never runs setup commands; …` | Expected. Install the app's dependencies yourself, or use `docker-windows`. |
| `local-windows cannot block the app's network` | Remove `"network": "none"`. |
| `the Windows helper … is missing; reinstall the package` | Reinstall: `pi install npm:@firstpick/pi-extension-gui-testing`. |
| A crashed session left processes or a folder | Run `/gui-cleanup local-windows`. |
| `app process (…) still exists` after a stop or cleanup | A process outside the session's jobs is still running. The package never ends it; close it yourself, then run `/gui-cleanup local-windows` to remove the folder. |
| `… replaced while it was being removed (…); not entered` | Something replaced a folder in the session folder with a link during cleanup. Nothing behind the link was touched. Check the folder, then run `/gui-cleanup local-windows`. |
| `helper.job` fails, or a launch fails, with `the helper runs inside a Job Object that does not accept a nested job` | The terminal, IDE, or CI runner that started Pi puts it in a restricted Windows job. Start Pi from a plain terminal (Windows Terminal, `cmd.exe`, or PowerShell). |
| `… earlier operations are still stuck in a hung app` | The app stopped responding. The session ended; start a new one with `gui_launch`. |
| `the full accessibility tree is too large to transfer` | Use `snapshot` with a smaller `maxNodes`, or a screenshot. |
| `the screenshot does not fit the transfer limit` | Capture a single window or element, or pass a smaller `maxEdge`. |
| `GUI helper process (orphan) still exists` after `/gui-cleanup local-windows` | Pi could not confirm that it started this process, so it did not end it. The process number comes from a file the tested app can change, so check it first: in Task Manager's Details tab, add the Command line column and end the process only if it is `powershell.exe` running `helper.ps1` from this package. Otherwise leave it alone. Then run `/gui-cleanup local-windows` again. |
| **`docker-windows`** | |
| `kvm.device` fails | Run `sudo usermod -aG kvm $USER`, then log out and back in. If `/dev/kvm` is missing, turn on VT-x or AMD-V in the firmware (or nested virtualization in your VM). |
| `the Windows licensing acknowledgement is missing` or `The Windows licensing notice is not acknowledged; re-run with /gui-setup docker-windows --accept-windows-license` | Run `/gui-setup docker-windows --accept-windows-license`, or confirm in the interactive screen. |
| `Windows is not installed yet; run /gui-setup docker-windows` | Run setup; it installs Windows (15–30 minutes). |
| The install stops, or `… run /gui-setup docker-windows again to resume` | Run `/gui-setup docker-windows` again; it continues. |
| `the Windows install did not finish within 120 minutes` | Check that the computer reaches Windows Update; the next setup starts a fresh install. |
| `the Docker volume pi-gui-testing-windows-base exists but belongs to no install recorded here` | Another Pi configuration (another `PI_CODING_AGENT_DIR`) owns it, or the settings were deleted. Run `/gui-reset docker-windows`, then set up again. |
| `the installed Windows disk changed during the session` | Reinstall: `/gui-reset docker-windows`, then `/gui-setup docker-windows`. |
| `docker-windows runs one session at a time and … is still running` (or `… is still running or starting`) | Stop the other session with `gui_stop`, or `/gui-cleanup docker-windows` when its Pi is gone. |
| `docker-windows runs one session at a time and the owner of session … cannot be judged` | Run `/gui-cleanup docker-windows`. If no Pi window uses docker-windows, delete the named `session-lease.json`. |
| `the session lease … is not a valid lease` | The lease file is damaged. If no Pi window runs a docker-windows session, delete it and start again. |
| `the lease of ended session … names container …, but that container is …; it was not removed` | The container belongs to another session that may still run. Stop it with `gui_stop` in its Pi window, or run `/gui-cleanup docker-windows` when that Pi is gone. |
| `the session lock … could not be released (…); this start was given back` | Pi could not write in its `docker-windows` folder (disk full, permissions). Fix that, then start the session again. |
| `the docker-windows session lock … is locked by process …` | Another Pi window is starting a session. Try again; if no Pi runs, remove the named lock file. |
| `Windows did not answer over SSH within 360 s` | The computer is slow or short of memory. Close other programs, or lower the load; then start again. |
| `the Windows guest refused this machine's pinned SSH identity` | The VM's keys no longer match. Reinstall with `/gui-reset docker-windows` and `/gui-setup docker-windows`. |
| `docker-windows cannot run with "network": "none"` | Remove it, or use `docker-linux` for an offline Linux run. |
| Leftover containers after a crash | Run `/gui-cleanup docker-windows`. |
| A sandbox is reported as having `no record in the local ledger` | It looks like one of yours but the package has no record of it. If it is yours, delete it with `cua sandbox rm <ref> --force`. |
| A sandbox could not be deleted | Run `/gui-cleanup cua`. |
| `unreadable sandbox record` | A local sandbox record file (or the other copy of the same record) cannot be read or is damaged, so Pi cannot tell which session owns that sandbox. To be safe, Pi never reuses, keeps, or deletes that sandbox, and `/gui-cleanup cua` and `/gui-reset cua` leave it in place and keep reporting it. The sandbox may keep billing. If no Pi session is using it, delete it with `cua sandbox rm <location>:<name> --force` (`cua sandbox ls` shows its location), then remove the named record file and the sandbox's other record file, if there is one. If the file is only unreadable (for example its permissions changed), fixing the file is enough. |
| `stale copy of a sandbox record` | A change to the local sandbox records was saved, but the outdated copy it replaced could not be removed, for example because of a disk error. The outdated copy is ignored, nothing bills because of it, and the sandbox's next change (its next use, stop, or deletion) removes it. You can also delete the named file yourself. |
| A sandbox is reported as `pending deletion` | Its deletion started but did not finish, for example because Pi stopped in between. It is never reused. `/gui-cleanup cua` or the next Pi start deletes it. If the report says its owner process still runs, another Pi process on this computer started the deletion; `/gui-reset cua` deletes it now, or it is deleted after that process ends. It keeps billing until then. |
| **Dependency cache** | |
| `another Pi session is storing this entry right now` | Harmless; the next session uses the entry. |
| `not stored: larger than the cache limit` | Raise `depsCache.maxSizeGB`. |
| `not stored: setup changed the workspace, and only the deps dir is cached` | Expected when `setup` writes into the project, as `npm install` does. Install into the environment instead, or accept that `setup` runs each time. |
| Dependencies look outdated | Run `/gui-cleanup --deps`, or add the relevant files to `deps.keyFiles`. |
