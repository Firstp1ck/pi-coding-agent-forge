# Spec: `@firstpick/pi-extension-gui-testing` — background GUI testing for Pi

Status: approved for implementation · 2026-10-23 · target: Pi 1.4.0 (`@earendil-works/pi-coding-agent`)

Scope: the complete spec is the v1 release. Milestones (§11) define the build
order, not separate releases.

## 1. Goal

One installable Pi package that lets the agent launch a GUI app, navigate it, take
screenshots, and judge its own work, without the app ever appearing on the user's
desktop.

## 2. Requirements

| ID | Requirement |
|---|---|
| R1 | Installs as one Pi package (`pi install <pkg>`). |
| R2 | Targets Linux, Windows, and macOS apps (coverage depends on backend, §4). |
| R3 | GUI-framework-independent: Tk, Qt, GTK, wx, Electron, WinForms, native, etc. |
| R4 | Launch, inspect (accessibility tree), interact, screenshot, stop. |
| R5 | **Never foreground**: the app never appears on, takes focus from, or injects input into the user's desktop. |
| R6 | The user picks the backend explicitly. **No automatic fallback** between backends. |
| R7 | A first-time setup command configures the chosen backend, checks every required tool, and verifies the result with a smoke test. |
| R8 | Tools refuse to run on a backend that is not set up and verified; they never degrade to the host desktop. |
| R9 | Nothing is installed, downloaded, uploaded, or billed without explicit user confirmation. Passing `--fix` or an `--accept-*` flag to `/gui-setup` counts as explicit confirmation. |
| R10 | Project data lives only on the client; remotes keep nothing after a session (§7a). |

## 3. Non-goals

- Pixel-perfect cross-backend screenshot parity (fonts/DPI differ per backend).
- macOS targets on non-Apple hardware (licensing).
- Controlling apps on the user's real desktop (that is "computer use", explicitly out of scope).
- Browser-only testing (use Playwright/Chrome DevTools MCP instead; the skill says so).

## 4. Backends

| Backend id | Host | Target | Isolation mechanism | Priority |
|---|---|---|---|---|
| `docker-linux` | Linux, Windows, macOS (any Docker host with Linux containers) | Linux | Container with Xvfb | M1 |
| `local-linux` | Linux | Linux | Private Xvfb display + private D-Bus | M2 |
| `remote-linux` | any with OpenSSH client | Linux (on the remote's arch) | Private Xvfb on a user-owned SSH host | M2b |
| `remote-linux-docker` | any with OpenSSH client | Linux (on the remote's arch) | Container with Xvfb on a user-owned SSH host | M2b |
| `cua` | any | Linux, Windows, macOS | Cua cloud sandbox | M3 |
| `docker-windows` | Linux with KVM | Windows | Windows VM in a container (dockur/windows) | M4 |
| `local-windows` | Windows 10/11 | Windows | Hidden desktop (`CreateDesktop`) | M5 (after spike) |

### 4.1 `docker-linux`

- Base image shipped as a Dockerfile in the package and built locally on setup (no
  registry dependency): Debian slim + `xvfb`, `xdotool`, `imagemagick` (or `xwd`),
  `dbus`, `at-spi2-core`, `python3-pyatspi`, a minimal WM (`openbox`), common fonts,
  and the in-container helper (§6).
- **No project data in images.** The project is never `COPY`'d into an image or a
  build context, so no image layer or build cache contains project files. The
  project's `setup` commands (§7) run inside the session container at session
  start; their results live in the container's writable layer and disappear
  with it (`--rm`). This trades a slower session start for a clean host (§7a).
- **Workspace (default `workspaceMode: "mount"`)**: the project directory is
  bind-mounted **read-only** at `/workspace`. The app gets writable tmpfs mounts
  for `/scratch`, `$HOME`, and `/tmp`. Apps that must write next to their own
  files use `workspaceMode: "copy"`: the sync file set (§4.7) is copied into the
  session temp dir (§7a.2) and mounted read-write. Containers run as host UID/GID
  (`--user`) so files are not root-owned.
- **Dependencies** come from the client-side dependency cache (§4.8), mounted at
  `/deps`; `setup` commands run only on a cache miss.
- Every container, network, and volume is created with
  `--label pi-gui-testing.session=<id>` so cleanup and sweeps can find it.
- Hard rules, verified at setup and on every session start via `docker inspect`:
  no `--privileged`, no host Docker socket, no host X11/Wayland sockets, no host
  D-Bus mount, no host network namespace.
- Network on by default (dependency installs); `network: "none"` option for runs.

### 4.2 `local-linux`

- Per session: `Xvfb :N` (free display number from a lock dir), `dbus-run-session`,
  `at-spi-bus-launcher` on that bus, optional `openbox`.
- Environment forced on every launched process (prevents Wayland leaks to the host):
  `unset WAYLAND_DISPLAY`, `DISPLAY=:N`, `GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`,
  `SDL_VIDEODRIVER=x11`, `ELECTRON_OZONE_PLATFORM_HINT=x11`,
  `DBUS_SESSION_BUS_ADDRESS=<private>`, `XDG_RUNTIME_DIR=<private tmp>`.
- Single-instance hand-off detection: if the launched PID exits within the grace
  period and no window appears on `:N`, fail with "app handed off to another
  instance" instead of reporting success.
- **Dependencies**: `local-linux` runs the app in the project's existing
  environment (its venv, `node_modules`, system libraries). It **never runs the
  project's `setup` commands** on the client and never installs project
  dependencies; those run only in containers and on remotes.
- **Accessibility enablement** on the private bus (§4.6): `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`,
  `QT_ACCESSIBILITY=1`, `NO_AT_BRIDGE` unset, `--force-renderer-accessibility`
  appended for Chromium/Electron apps, and the helper sets `org.a11y.Status`
  `IsEnabled=true` and `ScreenReaderEnabled=true` on the private bus so toolkits
  that only expose a tree when a screen reader is present do so. These apply to
  every Linux backend.

### 4.2a `remote-linux` and `remote-linux-docker`

A user-owned Linux machine reached over SSH: a server, VPS, or Raspberry Pi. No
monitor, GPU, or desktop environment is needed; Xvfb renders in RAM.

- **Connection**: the user's own OpenSSH client and `~/.ssh/config` (host alias,
  keys, agent, jump hosts). The package never stores SSH passwords or keys. All
  calls use `BatchMode=yes` and a `ControlMaster` socket for one persistent
  connection per session; each call has a connect timeout.
- **Host selection from `~/.ssh/config`**: when no `--host` is given, setup offers
  the user's existing SSH hosts in a `ctx.ui.select()`:
  - Candidates: every alias in `Host` lines of `~/.ssh/config`, following
    `Include` directives (relative paths resolve against `~/.ssh`, globs expanded).
    Patterns containing `*`, `?`, or `!` are skipped; they are defaults, not hosts.
  - Each candidate is resolved with `ssh -G <alias>` so `Match` blocks, `Include`,
    and wildcard defaults are applied exactly as OpenSSH applies them. The list
    shows `alias — user@hostname:port` and `via <ProxyJump>` when set.
  - Candidates are probed in parallel (`ssh -o BatchMode=yes -o ConnectTimeout=3
    <alias> uname -sm`, bounded to 8 concurrent, 5 s total) and labelled
    `ready (Linux aarch64)`, `auth needed`, `host key unknown`, `unreachable`, or
    `not Linux`. Unusable hosts stay selectable so the user gets the specific
    remediation from the checks.
  - Extra entry: `Other host…` → `ctx.ui.input()` for `user@host[:port]`; setup then
    shows a `Host` block template to add to `~/.ssh/config`.
  - The chosen alias is stored, never the resolved values, so later edits to
    `~/.ssh/config` (new IP, key, jump host) apply automatically. `/gui-doctor`
    reports when the alias no longer resolves.
  - The package only reads `~/.ssh/config`; it never writes to it and never sends
    its contents anywhere.
- **Helper transport**: the helper (§6) runs on the remote and speaks JSON-lines
  over `ssh <host> -- <helper>` stdio. No extra ports are opened on the remote.
- **Workspace sync**: `rsync` over SSH into the remote **session dir** (§7a), created
  fresh per session and deleted at the end; nothing persists on the remote between
  sessions. Within one session re-syncs are incremental. File set and exclusions
  per §4.7. If `rsync` is missing on
  the client (e.g. stock Windows), the transport switches to `tar` piped over SSH
  (full copy of the filtered file set; `tar` ships with Windows 10+, macOS, and
  Linux). This is a transport detail, not a backend switch. The remote is
  user-owned, so syncs never prompt: setup's summary states the sync rules and
  remote path, and every sync result reports file count and bytes sent.
- **`remote-linux`**: identical to `local-linux` (§4.2) but executed on the remote.
  It always starts its own private `Xvfb :N` and never uses the remote's `:0`, even
  if that host has a desktop session.
- **`remote-linux-docker`**: identical to `docker-linux` (§4.1), with every
  `docker` command executed on the remote through `ssh <host> -- docker ...`, so
  the client needs no Docker CLI. Bind mounts refer to the synced directory on the
  remote. Images must be multi-arch (the base Dockerfile builds natively on
  amd64 and arm64).
- **Architecture**: the app runs on the remote's architecture. Every tool result
  reports it. Pure Python/Tk/Qt/GTK apps and Electron (arm64 builds) work on a
  Raspberry Pi; x86-only binaries do not.
- **Remote sudo**: remediation that needs root on the remote is shown as an exact
  command for the user to run, unless passwordless sudo is detected and the user
  confirms. The package never handles a sudo password.

### 4.3 `cua`

- Uses the Cua cloud sandbox API. **One sandbox per session, deleted by `gui_stop`**
  and by every cleanup path (§7a). Keeping a stopped sandbox between sessions
  (faster, but project data stays in the cloud) is opt-in only:
  `keepSandbox: true` in `.pi/gui.json`.
- Workspace sync: file set and exclusions per §4.7. Upload consent is given once at setup, together with the
  billing acknowledgement (`--accept-billing`); later syncs do not prompt.
- API key read from `CUA_API_KEY` or entered at setup via `ctx.ui.input()` and stored
  with file mode 0600 (see open question Q1).

### 4.4 `docker-windows`

- Runs `dockurr/windows` with `--device /dev/kvm`, ports bound to `127.0.0.1` only.
  The installed Windows base disk is client-side tooling (no project data) and is
  kept. **Each session runs on a copy-on-write overlay of that disk, discarded at
  session end**, so nothing from a session survives in the guest (mechanism to
  verify during M4; fallback: delete the guest session dir and revert a snapshot).
- Dependencies for Windows targets use the dependency cache (§4.8) keyed by
  `windows-<arch>`.
- Helper (§6) installed into the guest during the unattended install (OEM script
  mechanism; verify during M4).
- Workspace shared into the guest via the container's shared-folder mechanism
  (verify during M4); otherwise synced like `cua`.
- Inside the VM the app runs on a real interactive session, so `SendInput`, GPU
  rendering, and focus behave normally.
- Setup requires an explicit acknowledgement that the user is responsible for
  Windows licensing.

### 4.5 `local-windows`

- Signed helper `.exe` creates a private desktop and launches itself and the app on
  it (`STARTUPINFO.lpDesktop`).
- Interaction via UI Automation patterns; `PostMessage` mouse/keyboard fallback.
  `SendInput` is forbidden (it reaches the user's input desktop).
- Screenshots via `PrintWindow(PW_RENDERFULLCONTENT)`.
- Software rendering forced where a framework allows it: Chromium/Electron
  `--disable-gpu`, `QT_OPENGL=software`, `QT_QUICK_BACKEND=software`, Flutter
  `--enable-software-rendering`. WPF: warn, do not touch the per-user registry.
- **Gated by spike S1** (§11). Known risks: black screenshots for GPU apps, AV/EDR
  flagging hidden-desktop behaviour.

### 4.6 Accessibility coverage

The accessibility tree is the primary navigation channel; screenshots and
coordinates are the fallback. Coverage differs by toolkit:

| Toolkit | Linux tree | Notes |
|---|---|---|
| GTK 3 / GTK 4 | yes | via at-spi2 on the private bus |
| Qt 5 / Qt 6 | yes | needs the env vars in §4.2 |
| Chromium / Electron | yes | needs `--force-renderer-accessibility` or the screen-reader flag |
| wxPython / wxWidgets | yes | through its GTK backend |
| Java Swing | partial | only with `java-atk-wrapper` in the environment |
| **Tk / Tkinter** | **no** | Treated as having no accessibility tree. Arch ships Tk 8.6.16 and Python 3.14's `tkinter` binds to it (checked 2026-10-23); Tk 8.6 has no accessibility layer. **Design assumption: Tk 9.1 is not installed**, so no backend, check, or image depends on it. Tk apps are always driven by screenshots + coordinates. If a Tk build with accessibility appears later, `gui_snapshot` simply reports the higher coverage it finds. |
| Windows (UIA) | mostly | Win32, WinForms, WPF, Qt, Electron expose UIA; custom-drawn widgets may not |

`gui_snapshot` reports `coverage: "full" | "partial" | "none"` so the model knows
when to switch to coordinates. The skill (§9) teaches that switch.

### 4.7 Sync rules (all remote backends and `copy` mode)

- **File set**: in a Git repository, `git ls-files --cached --others --exclude-standard`
  (tracked plus untracked-but-not-ignored). Outside Git, all files minus the
  default ignore list (`.git`, `node_modules`, `.venv`, `venv`, `__pycache__`,
  `target`, `dist`, `build`).
- **Always excluded** (even if tracked): `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `id_*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*`, `secrets*`,
  `.ssh/`, `.aws/`, `.gnupg/`. The user can override only through an explicit
  `sync.allow` list in `.pi/gui.json`.
- `sync.deny` adds project-specific exclusions.
- Dependency directories are never synced; they come from the dependency cache (§4.8).
- Every sync result reports file count, bytes sent, and excluded-file count.

### 4.8 Dependency cache (client-side)

Clean remotes would otherwise reinstall dependencies every session. The cache
keeps installed dependencies **on the client** and ships them to the session.

- **Location**: `~/.cache/pi-extension-gui-testing/deps/<project-hash>/<target-os>-<arch>/<key>.tar.zst`
  with a `.sha256` next to it. This is persistent client data (§7a.1).
- **Key**: SHA-256 over the contents of the declared key files (default:
  lockfiles and manifests found in the project: `requirements*.txt`,
  `pyproject.toml`, `uv.lock`, `poetry.lock`, `package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`), the `setup` commands, the base
  image version, and the target arch.
- **Fixed install path**: dependencies are installed into `/deps` (containers)
  or `<session-dir>/deps` exposed through stable env vars (`VIRTUAL_ENV`,
  `PATH`, `PYTHONPATH`, `NODE_PATH`) so cached trees stay valid even though the
  remote session dir is random. Python uses `/deps/venv` in containers; on
  `remote-linux`, Python dependencies use `pip install --target` + `PYTHONPATH`
  instead of a venv, because venvs embed absolute paths.
- **Miss**: run the `setup` commands in the session; on success, the helper packs
  the deps dir, streams it to the client, the client verifies the hash and stores
  it.
- **Hit**: the client streams the archive to the session and the helper unpacks
  it; the remote copy is deleted with the session (§7a.3).
- **Bounds**: size limit (default 5 GB total, configurable), LRU eviction,
  per-entry `lastUsed`. `/gui-cleanup --deps` clears it.
- `.pi/gui.json` may set `deps.keyFiles` and `deps.env` to override defaults.
- `local-linux` does not use the cache (§4.2).

## 5. Setup command

### 5.1 Commands

| Command | Purpose |
|---|---|
| `/gui-setup [backend] [flags]` | First-time setup. Without a backend, shows a `ctx.ui.select()` of backends supported on this host, with a one-line description each. |
| `/gui-doctor [backend]` | Re-runs all checks and the smoke test without changing anything. Never prompts. |
| `/gui-backend <id> [--project]` | Switches the active backend (must already be verified). Writes the global config, or `.pi/gui.local.json` with `--project`. |
| `/gui-usage [session]` | Shows the usage/cost check (§8.1) for current and recent sessions. |
| `/gui-reset <backend>` | Removes that backend's config, images, sandboxes, and VM volumes after confirmation. |

`/gui-setup` flags. Every prompt has a flag equivalent, so a fully specified call
never prompts:

| Flag | Replaces prompt |
|---|---|
| `--host <ssh-alias-or-user@host>` | host picker from `~/.ssh/config` (`remote-*`, §4.2a) |
| `--targets linux,windows,macos` | target selection (`cua`) |
| `--api-key-env <VAR>` | API key input (`cua`; default `CUA_API_KEY`) |
| `--accept-billing` | billing + upload acknowledgement (`cua`) |
| `--accept-windows-license` | licensing acknowledgement (`docker-windows`) |
| `--fix` | approves every remediation that needs no password: package installs via passwordless sudo, image builds, key generation, VM install |
| `--no-fix` | never remediate; report and stop |
| `--project` | write the backend choice and host to `.pi/gui.local.json` instead of the global config |

Setup and doctor are commands, not tools: the model cannot install or provision
anything itself. A tool call on an unverified backend fails with
`backend "<id>" is not set up; ask the user to run /gui-setup <id>`.

### 5.2 Setup flow

**Principle: verify everything, ask nothing that is already known.** A prompt
appears only when a decision or secret is genuinely missing. If every check
passes and every required acknowledgement is given by flag or already recorded,
setup runs start to finish with **zero prompts** and ends with one summary.

1. **Resolve inputs** in this order: flags → project `.pi/gui.json` → global
   config → environment (`CUA_API_KEY`, `~/.ssh/config`) → prompt. Prompt only
   for what is still missing.
2. **Host detection**: OS, arch, distro/package manager, Pi version.
3. **Checks**: run every check for the backend (§5.4) in dependency order
   (client → connection → remote/runtime); independent checks run in parallel.
   Each returns `pass | warn | fail` with the observed value. A failed check skips
   the checks that depend on it and marks them `blocked`.
4. **All required checks pass** → go straight to step 7, no prompts.
5. **Remediation**, only for failures that have one:
   - Collect all fixable failures into **one** plan: exact commands, sudo needs,
     download sizes, durations, cost.
   - `--fix` → apply without asking. Otherwise **one** `ctx.ui.confirm()` for the
     whole plan, with an option to review items individually.
   - Steps that need a password or human judgement (remote password for key
     install, host-key fingerprint, sudo password, firmware virtualization) are
     never automated. Setup lists the exact commands and stops with
     `status: needs-user-action`. Re-running `/gui-setup` resumes from checks.
6. **Re-check** everything after remediation.
7. **Smoke test** (§5.5). Setup succeeds only if it passes.
8. **Persist** the verified state (§7): backend, resolved inputs, tool versions,
   check results, timestamp.
9. **Summary**: one message with backend, target arch, warnings and the
   capabilities they degrade, sync rules (remote/cloud), and duration.

Long steps (image build, Windows install, cloud provisioning) report progress via
`ctx.ui.setStatus` and are cancellable; cancellation leaves no half-registered
backend.

**Modes.** Interactive and RPC mode may prompt. In print/JSON mode setup runs only
when no prompt is needed (all inputs resolved and nothing to fix, or `--fix` /
`--no-fix` given); otherwise it fails and lists the missing flags. Verify during
M1 that Pi 1.4.0 executes extension commands in print mode; if it does not,
document RPC as the scripted path.

### 5.3 Check definition

```ts
interface Check {
  id: string;                 // e.g. "linux.xvfb"
  description: string;
  required: boolean;          // false → "warn" and a degraded capability
  run(ctx): Promise<{ status: "pass" | "fail" | "warn"; observed: string }>;
  remediation?: {
    summary: string;          // shown to the user
    command?: string[];       // exact command, shown before confirmation
    needsSudo?: boolean;
    downloadBytes?: number;
    estimatedSeconds?: number;
  };
  degrades?: string;          // capability lost when an optional check fails
}
```

Every check has a timeout (default 15 s; long-running remediations have their own
bounds) and runs without side effects.

### 5.4 Checks per backend

**Common**

| Check | Required | Pass when |
|---|---|---|
| `pi.version` | yes | Pi ≥ 1.4.0 |
| `host.os` | yes | backend supported on this host (§4 table) |
| `config.writable` | yes | config dir writable |
| `disk.free` | yes | free space ≥ backend minimum |

**`docker-linux`**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `docker.cli` | yes | `docker` on PATH | link to install docs (no auto-install) |
| `docker.daemon` | yes | `docker info` succeeds within timeout | "start Docker" hint |
| `docker.permission` | yes | `docker info` works without sudo | docker group / rootless hint |
| `docker.version` | yes | server ≥ minimum tested version | — |
| `docker.ostype` | yes | `OSType` is `linux` | switch Docker Desktop to Linux containers |
| `docker.arch` | yes | amd64 or arm64 | — |
| `disk.free` | yes | ≥ 5 GB | — |
| `image.base` | yes | base image present and label version matches | build image (confirm) |
| `isolation.inspect` | yes | test container has none of the forbidden mounts/flags (§4.1) | — (bug if fails) |

**`local-linux`**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `linux.xvfb` | yes | `Xvfb` on PATH and starts on a free display | package install (pacman `xorg-server-xvfb`, apt `xvfb`, dnf `xorg-x11-server-Xvfb`, zypper `xorg-x11-server-Xvfb`) |
| `linux.xdotool` | yes | `xdotool version` works | package install |
| `linux.screenshot` | yes | `import` or `xwd` + converter present | package install |
| `linux.dbus` | yes | `dbus-run-session` present | package install |
| `linux.atspi` | no | `at-spi-bus-launcher` present | package install; degrades: no accessibility tree |
| `linux.pyatspi` | no | `python3 -c "import pyatspi"` works | package install; degrades: no accessibility tree |
| `linux.wm` | no | `openbox` present | package install; degrades: dialog placement |
| `linux.fonts` | no | `fc-list` returns ≥ 1 font | package install |
| `linux.python` | yes | `python3` ≥ 3.9 (runs the helper) | package install |
| `linux.gtk-introspection` | yes | `python3 -c "import gi; gi.require_version('Gtk','3.0')"` works (smoke-test app) | package install (`python-gobject`+`gtk3`, apt `python3-gi gir1.2-gtk-3.0`) |
| `linux.wayland-scrub` | yes | test child sees no `WAYLAND_DISPLAY` and the correct `DISPLAY` | — (bug if fails) |

**`remote-linux` / `remote-linux-docker` (connection checks, run first)**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `local.ssh` | yes | `ssh` client on PATH | install OpenSSH client |
| `local.rsync` | no | `rsync` on PATH | package install; degrades: full `tar` copy per sync instead of deltas |
| `local.tar` | yes if `local.rsync` warns | `tar` on PATH and supports `-c`/`-x` over a pipe | — (built into Windows 10+, macOS, Linux) |
| `local.sshkey` | yes | at least one usable key in the agent or `~/.ssh` | generate `ssh-keygen -t ed25519` (confirm) |
| `ssh.config` | yes | `~/.ssh/config` (and its `Include`s) parses; `ssh -G <host>` resolves user, hostname, port, identity, ProxyJump | optional `Host` alias; setup shows a template |
| `ssh.jump` | yes if ProxyJump set | every jump host passes `ssh.hostkey` and `ssh.auth` | as for the target host |
| `ssh.hostkey` | yes | host key already in `known_hosts` (`ssh-keygen -F`), and a connection with `StrictHostKeyChecking=yes` succeeds | user connects once manually to verify the fingerprint |
| `ssh.auth` | yes | `ssh -o BatchMode=yes <host> true` succeeds within 10 s | user installs the public key once: setup shows `ssh-copy-id <host>`, or on Windows the equivalent `type $env:USERPROFILE\.ssh\id_ed25519.pub \| ssh <host> "cat >> ~/.ssh/authorized_keys"`. The package never asks for the SSH password |
| `ssh.multiplex` | no | ControlMaster socket works | degrades: slower per-call latency |
| `ssh.clean-stdout` | no | `ssh <host> true` writes nothing to stdout (no MOTD/`.bashrc` echo) | the protocol tolerates noise (§6 framing), so this only warns; suggest fixing the remote shell rc |
| `ssh.latency` | no | median of 5 round trips < 300 ms | degrades: slow interaction (warn with measured value) |

**Remote verification (must pass before setup completes)**

Run over the verified connection, in this order. Results and observed versions are
persisted so `/gui-doctor` can detect drift.

*Platform*

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `remote.os` | yes | `uname -s` is `Linux` | — |
| `remote.arch` | yes | `x86_64` or `aarch64` (warn on `armv7l`: 32-bit, limited app support) | use a 64-bit OS image |
| `remote.distro` | yes | `/etc/os-release` read; package manager detected (pacman, apt, dnf, zypper, apk) | unknown → remediation shown as package names only |
| `remote.path` | yes | non-interactive SSH `PATH` finds every tool found in a login shell | print the missing directories; suggest `~/.ssh/environment` or rc fix |
| `remote.hostkey-pinned` | yes | host key fingerprint recorded; later runs fail if it changes | — |
| `remote.sudo` | no | passwordless sudo available (`sudo -n true`) | degrades: remote installs shown as commands for the user to run |

*Resources*

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `remote.mem` | yes | ≥ 2 GB total (warn below 4 GB) | — |
| `remote.cpu` | no | ≥ 2 cores | degrades: slow builds |
| `remote.disk` | yes | free space at the session root ≥ 2 GB (`remote-linux`) / ≥ 5 GB at Docker's data root (`remote-linux-docker`) | — |
| `remote.limits` | no | `ulimit -n` ≥ 1024, `ulimit -u` not tiny | degrades: Electron/Chromium may fail |

*Filesystem and sync*

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `remote.session-root` | yes | session root (§7a) can be created, owned by the SSH user, mode 0700, and removed again | — |
| `remote.exec` | yes | a script written to the session root can execute (not `noexec`) | choose the next candidate root (§7a) or set `remote.sessionRoot` |
| `remote.rsync` | no | `rsync` on the remote (only when the client has rsync) | remote package install; degrades: `tar` transport |
| `sync.roundtrip` | yes | a test tree (incl. a symlink, unicode name, executable bit) syncs and checksums match on both ends | — |
| `sync.exclusions` | yes | a dry-run sync of the real project lists no file matching the secret patterns (§4.3) | — (bug if fails) |

*Runtime: `remote-linux`*

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `remote.python` | yes | `python3` ≥ 3.9 | remote package install |
| all `local-linux` checks (§5.4) | as listed | run on the remote | remote package install |
| `xvfb.start` | yes | `Xvfb :N -screen 0 1280x800x24` starts on a free display, lock file created, `xdpyinfo` lists `XTEST` | — |
| `xvfb.not-host` | yes | `:N` ≠ any display in use on the remote (`/tmp/.X11-unix/X*` owners checked); `:0` never chosen | — |
| `helper.deploy` | yes | helper copied into a session dir; `hello` handshake returns matching protocol + package version | redeploy |

*Runtime: `remote-linux-docker`*

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| all `docker-linux` checks (§5.4) | as listed | run via `ssh <host> -- docker ...` | as listed |
| `docker.rootless` | no | detects rootless vs rootful; recorded | — |
| `docker.egress` | no | the remote can reach the base image's package mirrors during build | degrades: offline build needs a pre-pulled image |
| `docker.image-arch` | yes | built base image arch equals `remote.arch` | rebuild |
| `docker.bind-uid` | yes | a file created in a container on the bind-mounted session dir is owned by the SSH user on the remote | adjust `--user` / userns mapping |
| `helper.deploy` | yes | helper inside the image answers the handshake | rebuild image |

*Lifecycle and isolation (both remote backends, part of the smoke test)*

| Check | Required | Pass when |
|---|---|---|
| `smoke.e2e` | yes | §5.5 passes on the remote: launch → snapshot → act → screenshot |
| `smoke.timing` | no | launch-to-first-screenshot and per-action round trip recorded; warn above 10 s / 1 s |
| `isolation.no-listen` | yes | no new listening sockets on the remote during the session (`ss -ltn` before/after) |
| `isolation.private-display` | yes | the test app's windows exist only on `:N` / inside the container |
| `cleanup.stop` | yes | after `gui_stop`, the remote footprint audit (§7a.4) is empty |
| `cleanup.disconnect` | yes | killing the SSH connection mid-session makes the helper tear down everything within 10 s (helper exits when stdin closes; processes run in its own process group) |
| `cleanup.sweep` | yes | a deliberately orphaned session (dir, process, labelled container) is removed by the next session start |
| `concurrency.lock` | yes | two simultaneous sessions get different displays/containers and do not interfere |

**`cua`**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `cua.network` | yes | API endpoint reachable | — |
| `cua.key` | yes | key present | prompt via `ctx.ui.input()` |
| `cua.auth` | yes | authenticated API call succeeds | re-enter key |
| `cua.targets` | yes | each requested target OS available on the account | — (report which are missing) |
| `cua.cost-ack` | yes | user acknowledged billing at setup | confirm dialog |

**`docker-windows`**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| all `docker-linux` docker checks | yes | as above | as above |
| `host.linux` | yes | host is Linux | — |
| `kvm.device` | yes | `/dev/kvm` exists and is read/writable | kvm group hint |
| `kvm.cpu` | yes | CPU virtualization flags present | enable VT-x/AMD-V in firmware |
| `mem.available` | yes | ≥ 8 GB RAM total, ≥ 4 GB assignable | — |
| `disk.free` | yes | ≥ 80 GB | — |
| `ports.free` | yes | chosen localhost ports free | pick other ports |
| `license.ack` | yes | user acknowledged Windows licensing | confirm dialog |
| `vm.installed` | yes | VM volume exists and the guest helper responds | run unattended install (confirm: size, ~15–30 min) |

**`local-windows`**

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `win.version` | yes | Windows 10 1809+ or 11 | — |
| `win.arch` | yes | x64 or arm64 | — |
| `helper.present` | yes | helper exe present, signature valid | reinstall package |
| `helper.desktop` | yes | helper can create and destroy a private desktop | — |
| `helper.uia` | yes | UI Automation reachable on the private desktop | — |
| `helper.av` | no | helper not quarantined or blocked during the smoke test | warn with AV allowlist guidance |

### 5.5 Smoke test (all backends)

1. Start a session on the backend.
2. Launch the bundled test app (a tiny GTK 3 app via PyGObject on Linux, chosen
   because Tk 8.6 has no accessibility tree; a tiny WinForms app on Windows;
   TextEdit on macOS via `cua`) showing a known label and button.
3. `gui_snapshot`: the button must be found by name (skipped if the accessibility
   checks were `warn`, which is reported).
4. `gui_act`: click the button; the label must change.
5. `gui_screenshot`: PNG decodes, has the expected size, and is not uniform colour.
6. **Isolation assertion**:
   - `local-linux`: no new toplevel window appeared on the host session; the test
     app's windows exist on `:N` (`xdotool search --pid`).
   - `local-windows`: `GetForegroundWindow()` on the user's desktop is unchanged
     before vs after; the app's windows belong to the private desktop.
   - container/cloud backends: guaranteed by construction, plus the `isolation.inspect`
     check.
7. Stop the session; the footprint audit (§7a.4) must be empty.

## 6. Helper process

Each backend runs one helper inside the isolated environment. All helpers speak the
same JSON-lines protocol over stdio (`docker exec -i`, local spawn, SSH) or a
localhost-only socket (VM guests).

**Framing**: the client sends a random 128-bit token when starting the helper;
the helper prints `PI-GUI-TESTING-READY <token>` and only lines prefixed with that token
are protocol messages. Anything before or between them (MOTD, rc output) is
captured as diagnostics and ignored.

```
hello {protocol, packageVersion} → {protocol, helperVersion, os, arch, capabilities}
ping {} → {ok}                                   # heartbeat, every 15 s
launch {cmd, args, env, cwd} → {pid, windows[]}
wait {for: window|text|ref|idle, value?, timeoutMs} → {matched, elapsedMs}
snapshot {maxNodes} → {snapshotId, coverage, tree: [{ref, role, name, value, bounds, states}]}
screenshot {window?: ref, maxEdge?} → {png_base64, width, height, sha256}
act {ref? | x,y, action: click|double_click|right_click|type|key|scroll|set_value, text?} → {ok}
windows {} → [{ref, title, bounds}]
stop {} → {ok, leftovers[]}
```

- **Refs** are `<snapshotId>:<n>` and valid only until the next `snapshot`; an
  older ref is rejected with `stale ref, take a new snapshot`.
- **Screenshots**: default virtual screen 1280×800×24; images returned to the
  model are downscaled to at most 1280 px on the long edge (`maxEdge` overrides).
- **Heartbeat**: the client pings every 15 s regardless of running operations, so
  long `setup` commands never trigger the 60 s teardown (§7a.3).

- Linux helper: Python (AT-SPI via `pyatspi`, input via `xdotool`/XTEST, capture
  via XGetImage/`import`).
- Windows helper: small native exe (UI Automation, `PostMessage`, `PrintWindow`);
  inside `docker-windows` it may also use `SendInput` because the whole session is
  isolated.
- `cua`: maps the same protocol onto the Cua API.

## 7. Configuration and state

- Global: `~/.pi/agent/gui/config.json`: active backend, verified backends with
  `{verifiedAt, toolVersions, checksPassed}`.
- Project, shared: `.pi/gui.json` (committed):

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

- Project, personal: `.pi/gui.local.json` (gitignored; setup adds it to the
  project's `.gitignore` after confirmation):

```json
{
  "backend": "remote-linux-docker",
  "remote": { "host": "raspi5" },
  "keepSandbox": false,
  "limits": { "maxConcurrentSessions": 2, "idleTimeoutMinutes": 15 },
  "usageCheck": { "warnSessionCostUsd": 1, "warnDailyCostUsd": 5 }
}
```

- **Precedence** (each field independently): `.pi/gui.local.json` → global
  config → built-in default. `.pi/gui.json` holds only shared project fields;
  backend, host, and limits there are ignored with a warning.

- `setup` is written by the agent after a working build and shown to the user
  before it is saved.
- A verified backend becomes stale when a checked tool version changes; tools then
  ask the user to run `/gui-doctor`.

## 7a. Data lifecycle and cleanup

**Principle: project data lives only on the client.** Remotes (SSH hosts, cloud
sandboxes, VM guests, containers) hold data only for the duration of a session.
On the client, runtime data lives in temporary directories that are removed
after use, or at the next startup if removal after use was not possible.

### 7a.1 What may persist

| Where | Persists | Never persists |
|---|---|---|
| Client | global/project config (§7), verified-setup state, pinned host-key fingerprints, Cua API key (Q1), tooling images without project data (`docker-linux` base image, `docker-windows` base disk), the dependency cache (§4.8) | screenshots, accessibility dumps, logs, synced copies, sockets, session state |
| Remote SSH host | system packages installed at setup with user consent (tooling); the base image for `remote-linux-docker` (tooling, kept by default; `--purge-tooling` removes it after each session) | session dirs, helper copies, app processes, Xvfb displays/locks, containers, volumes, networks, project images, build cache, logs |
| Cua | nothing (unless `keepSandbox: true`) | sandboxes, uploaded files |
| VM guest (`docker-windows`) | base disk (tooling) | session overlay, guest session dir |

Tool output that the model already received (images and text in the transcript)
is part of the Pi session, not of this package's data.

### 7a.2 Client side

- **Session temp dir**: `fs.mkdtemp(join(os.tmpdir(), "pi-gui-testing-"))`, mode 0700.
  Holds screenshots, full accessibility dumps, logs, sync staging, the SSH
  `ControlPath` socket, and Xvfb/D-Bus runtime dirs for `local-linux`.
- Contains `owner.json` = `{pid, processStartTime, piSessionId, createdAt}`.
- **Removed after use** by `gui_stop`, by the idempotent `session_shutdown` handler,
  and by `exit`/`SIGINT`/`SIGTERM` handlers.
- **Startup sweep** (covers crashes, `SIGKILL`, power loss): on `session_start`,
  every `os.tmpdir()/pi-gui-testing-*` dir whose owner process is gone (PID missing, or PID
  reused with a different start time) is removed, together with the processes and
  labelled containers it recorded. Dirs of live owners are never touched.
- **Exporting**: artifacts leave the temp dir only through an explicit
  `gui_export {session, dest}` tool call or `/gui-export`, into a user-chosen
  directory. Tool results that mention a temp path say that it is temporary.

### 7a.3 Remote side

- **Session root** candidates, first that passes `remote.session-root` and
  `remote.exec`: `$XDG_RUNTIME_DIR/pi-gui-testing` (tmpfs, wiped on logout/reboot) →
  `/tmp/pi-gui-testing-$UID` → `~/.cache/pi-gui-testing-tmp`. Session dir = `mktemp -d` inside it.
- The session dir holds the helper, the synced workspace, and runtime files. App
  stdout/stderr stream to the client; nothing is logged on the remote.
- All remote processes run in one process group under the helper (`setsid`). The
  helper owns teardown and runs it on `stop`, on stdin EOF (SSH dropped), on
  `SIGTERM`/`SIGHUP`, and on a heartbeat timeout (no client message for 60 s):
  kill the process group → stop Xvfb and remove its lock/socket → `docker rm -f`,
  remove labelled volumes/networks/images, prune labelled build cache → remove the
  session dir → remove the session root if empty.
- **Remote startup sweep**: each session start first removes session dirs whose
  helper is gone and every container/volume/network/image labelled `pi-gui-testing.session`
  without a live helper. Then it creates its own.
- The client does not trust the helper alone: after `stop`, it runs the footprint
  audit (§7a.4) over a fresh SSH call and repeats teardown for anything left.

### 7a.4 Footprint audit

A read-only check that reports anything this package left behind. It runs at the
end of the smoke test, after every `gui_stop`, and in `/gui-doctor`.

| Scope | Must be empty |
|---|---|
| Client | `os.tmpdir()/pi-gui-testing-*` except live sessions; processes started by the package; Xvfb sockets/locks for displays the package started (`local-linux`); containers/volumes/networks/images labelled `pi-gui-testing.session` |
| SSH remote | session root contents; processes owned by the user whose cmdline or env carries the session tag; `/tmp/.X11-unix/X<N>` and `/tmp/.X<N>-lock` for displays the package started; labelled Docker objects; labelled build cache |
| Cua | sandboxes tagged with this client's id (unless `keepSandbox`) |
| `docker-windows` | session overlays; running session containers |

A non-empty audit makes `gui_stop` return an error naming each leftover, and
setup does not complete.

### 7a.5 Commands

- `/gui-cleanup [backend|--all] [--deps]`: runs teardown and the sweep now, then the audit; `--deps` also clears the dependency cache.
- `/gui-reset <backend>`: also deletes that backend's tooling (base images, base
  disk) and config; lists system packages installed at setup for manual removal
  (never uninstalled automatically, since other software may depend on them).

## 8. Tools (model-facing)

| Tool | Parameters | Result |
|---|---|---|
| `gui_launch` | `target?`, `cmd?`, `args?`, `env?` (defaults from `.pi/gui.json`) | session id, backend id, arch, windows, sync summary |
| `gui_wait` | `session`, `for` (`window`/`text`/`ref`/`idle`), `value?`, `timeoutMs?` | matched + elapsed; replaces guessed sleeps |
| `gui_snapshot` | `session`, `maxNodes?` | accessibility tree with `coverage` (truncated, full tree saved in the session temp dir, §7a.2) |
| `gui_screenshot` | `session`, `window?` | image content block + `details` with path, size |
| `gui_act` | `session`, `ref` or `x,y`, `action`, `text?` | ok + optional auto-screenshot |
| `gui_logs` | `session`, `tail?` | app stdout/stderr |
| `gui_stop` | `session` | ok + footprint audit result (§7a.4) |
| `gui_export` | `session`, `dest` | copies screenshots/dumps/logs out of the temp dir |

- Every result names the backend that ran.
- Execution is sequential per session (shared mutable state).
- Each tool call has a timeout and honours `ctx.signal`.
- Sessions are cleaned up per §7a in an idempotent `session_shutdown` handler;
  nothing is started in the extension factory. The startup sweep runs on
  `session_start`.
- **Limits**: at most `maxConcurrentSessions` (default 2) per client; a session
  with no tool call for `idleTimeoutMinutes` (default 15) is torn down. There is
  no maximum session duration.

### 8.1 Usage and loop check

There is no hard cost cap (Cua enforces spending limits through its own account
settings). Instead, a usage check detects unintended behaviour and never blocks:

- **Tracked per session**: tool calls by type, actions, screenshots, bytes
  synced, wall time; for `cua`, sandbox runtime × rate (from the API when
  available, otherwise the rate entered at setup) as an estimated cost.
- **Loop signals**: the same action on the same ref/coordinates more than 5 times
  in a row; more than 8 consecutive actions whose screenshots have identical
  hashes (UI not changing); more than 20 `gui_launch` calls in 10 minutes.
- **Thresholds**: `usageCheck.warnSessionCostUsd` / `warnDailyCostUsd` (cua).
- **On a signal**: the tool result carries a `usageWarning` telling the model to
  stop and reassess, and the user gets a notification. The model is not
  blocked; the user decides whether to interrupt. `/gui-usage` shows the
  numbers.

## 9. Bundled skill

`skills/gui-testing/SKILL.md` teaches:

1. Prefer the narrowest tool: tests → Playwright/browser MCP for web UIs → this package.
2. Loop: launch → snapshot → act by `ref` → screenshot → judge → fix code → relaunch.
3. Use `ref`s from the snapshot; use coordinates only when the tree has no node.
4. Never switch backends; report backend errors to the user.
5. When `coverage` is `none` (always the case for Tk/Tkinter apps), use screenshots + coordinates and
   say so in the report.
6. Use `gui_wait` instead of sleeping; stop and reassess on a `usageWarning`.
7. After a working run, propose the `setup`/`launch` entries for `.pi/gui.json`.

## 10. Package layout

Location: `/home/firstpick/npm-packages/pi-extension-gui-testing` in the
`pi-coding-agent-forge` repository, published as
`@firstpick/pi-extension-gui-testing`. Follows the repository `AGENTS.md`
(README / TECHNICAL / DEVELOPMENT layers, first-party dependency ranges).

```
pi-extension-gui-testing/
├── package.json              # "pi": { extensions, skills }, keywords: ["pi-package"]
├── index.ts                  # extension entry: registers tools + commands
├── src/
│   ├── setup/                # checks, remediation plan, smoke test, host picker
│   ├── backends/{docker-linux,local-linux,remote-linux,remote-linux-docker,cua,docker-windows,local-windows}.ts
│   ├── transport/            # local spawn, docker exec, ssh (ControlMaster), framing
│   ├── sync/                 # file set, exclusions, rsync/tar transports
│   ├── deps/                 # dependency cache
│   ├── cleanup/              # temp dirs, sweeps, footprint audit
│   ├── usage/                # usage and loop check
│   └── protocol.ts           # helper JSON-lines protocol
├── helpers/
│   ├── linux/                # Python helper (deployed per session to remotes) + Dockerfile
│   └── windows/              # native helper source + signed build artifact
├── testapps/                 # GTK 3 and WinForms smoke-test apps
├── skills/gui-testing/SKILL.md
├── plans/planned/            # this spec + implementation plan
├── README.md · TECHNICAL.md · DEVELOPMENT.md · LICENSE
└── tests/
```

Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`, …) go in
`peerDependencies` with `"*"`, per Pi's package docs.

## 11. Milestones

| ID | Deliverable | Exit criteria |
|---|---|---|
| M1 | Tool interface + `docker-linux` (Linux hosts) + setup/doctor framework + cleanup + usage check | Smoke test passes on EndeavourOS with Docker 29.x; GTK4, PySide6, and Electron sample apps snapshot/act/screenshot correctly; a Tk 8.6 app works by coordinates with `coverage: none` |
| M1b | Dependency cache | Second session of the same project starts without running `setup`; cache key changes when a lockfile changes |
| M1c | `docker-linux` on Docker Desktop (macOS, Windows hosts) | Smoke test passes on both |
| M2 | `local-linux` | Same app matrix; Wayland-leak test passes on a Wayland host session |
| M2b | `remote-linux` + `remote-linux-docker` | Smoke test passes against an amd64 server and a Raspberry Pi 5 (64-bit OS, no monitor, SSH-only); no ports opened on the remote; sync excludes secrets |
| M3 | `cua` (Linux, Windows; macOS behind a flag) | Smoke test on each available target; sync excludes secrets; stop leaves no running billable sandbox |
| M4 | `docker-windows` | Unattended install from `/gui-setup` with no manual steps; smoke test passes; ports bound to localhost only |
| S1 | Spike: hidden-desktop fidelity | Tk, PySide6, WinForms, Electron, WPF tested; per-framework screenshot/UIA results recorded |
| M5 | `local-windows` (only if S1 is acceptable) | Smoke test passes; foreground-unchanged assertion passes; AV behaviour documented |

## 12. Acceptance criteria

- A fresh user can go from `pi install` to a passing smoke test using only
  `/gui-setup` and confirmation dialogs.
- Every required check failure produces a specific message and, where possible, an
  exact remediation.
- When every check passes and required acknowledgements are given by flag or
  already recorded, `/gui-setup` completes with zero prompts.
- Client-side remote setup never requires Docker on the client and never handles
  an SSH or sudo password.
- No tool call ever launches an app on the host desktop, under any failure path.
- No backend switch happens without a user command.
- Cancelling setup or a session leaves no orphan processes, displays, containers,
  sandboxes, or VMs.
- After every session, the footprint audit (§7a.4) is empty on client and remote;
  no project data remains on any remote.
- After a client crash (`SIGKILL`) or a dropped SSH connection, everything is
  removed by the helper's teardown or, at the latest, by the next startup sweep.

## 13. Open questions

| ID | Question |
|---|---|
| Q1 | Where should the Cua API key live: Pi's own credential store (if extensions can use it) or a 0600 file? Verify Pi 1.4.0 APIs. |
| Q2 | Cua pricing and macOS availability: confirm current terms before M3. |
| Q3 | dockur/windows: confirm the OEM install hook and shared-folder mechanism versions before M4. |
| Q4 | Windows helper code signing: who owns the certificate? |
| Q5 | ~~Docker Desktop hosts in M1?~~ Resolved: Linux hosts in M1, Docker Desktop hosts in M1c. |
| Q6 | ~~Remote host scope?~~ Resolved: global config or `.pi/gui.local.json`; never the committed file. |
| Q7 | ~~Remote tooling retention?~~ Resolved: keep the base image by default; `--purge-tooling` opts out. |
