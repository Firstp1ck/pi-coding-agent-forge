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

## 3a. Decision record

Decisions approved by the user during planning. Implementation plans cite them by ID.

| ID | Decision (approved 2026-10-23) | Spec location |
|---|---|---|
| D1 | local-linux uses the project's existing environment; never runs setup commands on the client | §4.2 Dependencies |
| D2 | docker-linux mounts the project read-only with writable tmpfs; optional workspaceMode "copy" | §4.1 Workspace |
| D3 | Config split: .pi/gui.json (committed) and .pi/gui.local.json (personal, gitignored); precedence local → global → default | §7 |
| D4 | Client-side dependency cache from the start | §4.8, M1b |
| D5 | No cost cap; non-blocking usage/loop check; idle timeout 15 min; no max session length; max 2 concurrent sessions | §8 Limits, §8.1 |
| D6 | Complete spec is v1; milestones are build order | header Scope, §11 |
| D7 | Package @firstpick/pi-extension-gui-testing in the npm-packages repo following AGENTS.md | §10 |
| Q5–Q7 | Docker Desktop hosts in M1c; remote host global or .pi/gui.local.json; remote base image kept by default | §13 |
| T1 | Tk 9.1 assumed not installed; Tk apps use coordinates only | §4.6 |
| D8 | local-windows uses @iiwate/pi-silent-gui as reference design and S1 test vehicle, not a dependency | §4.5, plan §11 |

Changes adopted from the pre-implementation reviews (round 2 fixes X1–X26,
approved 2026-10-23; round 3 fixes Y1–Y19, approved 2026-10-24) are recorded in
the M1 plan §13.1. D8 was first recorded as "W1" and renamed to avoid a clash
with workstream IDs.

## 4. Backends

| Backend id | Host | Target | Isolation mechanism | Priority |
|---|---|---|---|---|
| `docker-linux` | Linux, Windows, macOS (any Docker host with Linux containers) | Linux | Container with Xvfb | M1 |
| `local-linux` | Linux | Linux | Private Xvfb display + private D-Bus | M2 |
| `remote-linux` | any with OpenSSH client | Linux (on the remote's arch) | Private Xvfb on a user-owned SSH host | M2b |
| `remote-linux-docker` | any with OpenSSH client | Linux (on the remote's arch) | Container with Xvfb on a user-owned SSH host | M2b |
| `cua` | Linux (macOS, Windows planned) | Linux (Windows, macOS after S1) | Cua sandbox in the user's own cloud account, via the open-source `cua` CLI | M3 |
| `docker-windows` | Linux with KVM | Windows | Windows VM in a container (dockur/windows) | M4 |
| `local-windows` | Windows 10/11 | Windows | Hidden desktop (`CreateDesktop`) | M5 (after spike) |

### 4.1 `docker-linux`

- Base image shipped as a Dockerfile in the package and built locally on setup (no
  registry dependency) from a pinned Debian slim tag: `xvfb`, `xdotool`,
  `imagemagick` (or `xwd`), `dbus`, `at-spi2-core`, `python3-pyatspi`, `tini`, a
  minimal WM (`openbox`), common fonts, the `setup` toolchain (`python3-pip`,
  `python3-venv`, `nodejs`, `npm`), and the in-container helper (§6). The
  image also carries the toolkit runtimes the smoke test and sample apps need:
  PyGObject with GTK 3 and GTK 4 introspection, the Qt `xcb` platform libraries,
  and the Chromium/Electron runtime libraries. The exact package list lives in
  the Dockerfile and is documented in `DEVELOPMENT.md`; an image contract test
  checks it. The build context is a staged tar stream piped to `docker build -`
  that contains only the helper, the Dockerfile, and the bundled GTK 3 smoke app,
  so the build needs no buildx plugin and never sees project files.
- **Image labels**: `pi-gui-testing.base=true`, `pi-gui-testing.version=<package
  version>`, `pi-gui-testing.protocol=<protocol version>`. The base image never
  carries a session label. `image.base` compares these labels.
- **No project data in images.** The project is never `COPY`'d into an image or a
  build context, so no image layer or build cache contains project files. The
  project's `setup` commands (§7) run inside the session container at session
  start; their results live in container tmpfs mounts and disappear with the
  container (`--rm`). This trades a slower session start for a clean host (§7a).
- **Container lifetime**: the helper is the container's entrypoint
  (`ENTRYPOINT ["tini", "--", "/opt/pi-gui-testing/helper"]`, no `CMD`), started
  with `docker run -i --rm`, and speaks the protocol (§6) over that stdio. The
  helper runs on the image's system `python3` and starts Xvfb, the private D-Bus,
  `at-spi-bus-launcher`, and `openbox` itself. When stdin closes or the heartbeat
  times out (§6), the helper tears down and exits, and `--rm` removes the
  container without any client action. `docker exec` is used only for
  diagnostics. Electron and Chromium apps get `--shm-size=512m`.
- **Workspace (default `workspaceMode: "mount"`)**: the project directory is
  bind-mounted **read-only** at `/workspace`. Apps that must write next to their
  own files use `workspaceMode: "copy"`: the sync file set (§4.7) is copied into
  the session temp dir (§7a.2) and mounted read-write. Containers run as host
  UID/GID (`--user`) so files are not root-owned. The client generates `passwd`
  and `group` files for that UID/GID in the session temp dir and bind-mounts them
  read-only at `/etc/passwd` and `/etc/group`, so the UID resolves to a user with
  home `/home/app`. There is no root entrypoint and no `LD_PRELOAD`.
- **Writable mounts**: uid-owned tmpfs mounts with explicit `uid`, `gid`, and
  `mode` for `/scratch`, `$HOME` (`/home/app`), `/tmp`, `/deps`, and
  `XDG_RUNTIME_DIR=/run/user/<uid>` (mode 0700). The §4.2 environment block
  applies inside the container (`DISPLAY` = the container's Xvfb,
  `DBUS_SESSION_BUS_ADDRESS` = the container's private bus).
- **Mount-mode privacy**: in `mount` mode the container can read every file in the
  project, including `.env*` files and keys, while `setup` and the app run with
  network access. The §4.7 exclusions apply only to `copy` mode and remotes. Use
  `copy` mode or `network: "none"` when `setup` runs untrusted install scripts.
  Before start, a scan of the whole mounted tree (including `.git`,
  `node_modules`, and virtualenvs; bounded to 20 s) refuses a workspace that
  contains Unix sockets, because the container runs as the host UID and could
  connect to them. A timeout or an unreadable directory also refuses the
  session, with a message pointing to `copy` mode. A project root that
  is `/`, the user's home directory, or an ancestor of a forbidden path below is
  refused.
- **Dependencies (M1)**: `/deps` is a uid-owned tmpfs. Before the first `setup`
  command the helper creates `/deps/venv` with
  `python3 -m venv --system-site-packages`, so the image's `gi` and `pyatspi`
  stay importable. `setup` runs as the host UID via `sh -c` with cwd `/workspace`
  and a fixed environment that the launched app also gets: `VIRTUAL_ENV=/deps/venv`,
  `PATH=/deps/venv/bin:/deps/node/bin:$PATH`, `npm_config_prefix=/deps/node`,
  `PYTHONUSERBASE=/deps/python`. `setup` that must write into the project tree
  (for example `npm install` creating `node_modules`) needs `copy` mode. From
  M1b the dependency cache (§4.8) fills `/deps` at the same paths, and `setup`
  runs only on a cache miss.
- **Labels**: every container, network, and volume gets
  `pi-gui-testing.session=<id>` and
  `pi-gui-testing.owner=<clientId>:<pid>:<processStartTime>:<bootId>` so cleanup
  and sweeps can find it and check its owner (§7a.2), even without the temp dir.
- **Docker endpoint**: only a local daemon is supported. The active context's
  endpoint must be a `unix://` socket; a remote context or a remote `DOCKER_HOST`
  is rejected. The endpoint is resolved once per session and passed explicitly to
  every `docker` call of that session. M1 requires a rootful daemon: rootless
  Docker maps container UIDs to subordinate host UIDs, which breaks file
  ownership and access to the session temp dir. Rootless support is planned for
  M1c.
- **Hard rules**, one list shared by the unit tests and `isolation.inspect`,
  verified at setup and on every session start via `docker inspect`:
  `Privileged=false`; `NetworkMode`, `IpcMode`, `PidMode`, and `UsernsMode` not
  `host`; capabilities dropped (`--cap-drop ALL`) and none added;
  `no-new-privileges`; no devices; no bind source (after resolving symlinks) that
  equals or is an ancestor of `/tmp/.X11-unix`, `/run/user`, `/run/dbus`,
  `/var/run`, or any `docker.sock`; `Env` contains no `WAYLAND_DISPLAY` and no
  `DBUS_SESSION_BUS_ADDRESS`, and `Env.DISPLAY`, when set, matches `^:[0-9]+$`
  (the helper's own Xvfb, which is reachable only because no X11 socket
  directory is mounted).
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

> **Revised 2026-10-24.** Cua Cloud (the hosted sandbox API billed by Cua and
> authenticated with `CUA_API_KEY`) ended on 2026-10-18 (cua.ai migration guide
> "Cua Cloud ended"). This section describes the successor surface the backend
> now targets; see the M1b–M3 plan §6a and `plans/handoffs/post-m1-C.md`.

- Uses the open-source `cua` CLI, version 0.7 or newer (the `cua.cli` check
  refuses older or unparseable versions), which creates sandboxes
  **in the user's own cloud account** (`--on aws|gcp|hetzner|modal`). The user's
  cloud bills for them. Each sandbox joins Cua's relay (`relay.cua.ai`) under the
  user's cua.ai sign-in, so nothing listens on the internet.
- All Cua access goes through one interface (`CuaApi`) with a single production
  adapter on the CLI (argv only, timeouts and abort signals, bounded output,
  shape-validated JSON, redacted errors). There is no REST control plane; the
  only direct network call is a credential-free reachability probe.
- **No credential is stored, read, or sent by the package.** The cua.ai sign-in
  (`cua auth login`) and the cloud credentials stay in the `cua` CLI's and the
  cloud's own stores. `--api-key-env` is obsolete and refused with an
  explanation. `CUA_API_KEY` is no longer used by the backend; like every
  `CUA_*` variable in Pi's environment it is passed through, unread and
  unstored, to the `cua` CLI's own environment, and it never appears in an argv
  (the exit handler's `env` prefix carries only an allowlist of non-secret
  settings).
- **One sandbox per session, deleted by `gui_stop`** and by every cleanup path
  (§7a): stop, failed start, idle timeout, shutdown, `/gui-cleanup`, a bounded
  synchronous delete at process exit, the next Pi start's sweep (from a local
  ledger of created sandboxes, written before each create), and finally the
  cloud's own expiry (`cua cloud connect --ttl-hours`, default 8 h). Keeping a
  stopped sandbox between sessions (faster, but it keeps billing and project data
  stays in the cloud) is opt-in only: `keepSandbox: true` in `.pi/gui.local.json`
  or the global config. A kept sandbox is reused only by the same project, in the
  same cloud, created from the configured image (`--image`); one kept without an
  image record is never reused and is reported until `/gui-reset cua` deletes it.
  Ledger transitions are serialised across Pi processes.
- The Linux helper is deployed into the sandbox and spoken to over
  `cua sandbox exec -i` (a documented stdio stream); a guest shell preamble reads
  the helper's environment (the session token and the host-mode directories),
  one value per line, from the first stdin lines and exports it, so no value is
  ever in an argv. Protocol coverage is identical to Linux. Missing helper
  packages are installed inside the sandbox only.
- Workspace sync: file set and exclusions per §4.7, uploaded once per session as
  a tar. Upload consent is given once at setup, together with the billing
  acknowledgement (`--accept-billing` or one confirm dialog, recorded per cloud);
  later syncs do not prompt.
- `network: "none"` is refused (sandboxes always have egress).
- Linux targets only until the Windows helper exists (S1); macOS sandboxes are
  planned with it. Client: Linux in this version.

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

- **Reference design**: [`@iiwate/pi-silent-gui`](https://www.npmjs.com/package/@iiwate/pi-silent-gui)
  (MIT, v0.2.0, Windows-only Pi extension; reviewed 2026-10-23 from its README and
  source layout, not executed). It is used as a blueprint and for spike S1, **not as
  a runtime dependency**: it exposes its own tools instead of our `gui_*` interface,
  has no UI Automation, no text typing (single key actions only), and requires Python plus a manual
  `pip install pycaw`. Reused code keeps its MIT attribution.
- Signed helper `.exe` (see Q4) creates a private desktop with a session-unique name
  the caller cannot choose and launches itself and the app on it
  (`STARTUPINFO.lpDesktop`). Never calls `SwitchDesktop`, `SendInput`, or clipboard
  APIs.
- **Process containment (adopted from the reference)**:
  - every app process joins a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
    atomically at creation (`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_JOB_LIST`), so
    a helper crash kills the whole process tree;
  - the app starts suspended and is resumed only after the desktop, job, and
    monitoring are in place; if any guard fails, the job is closed (fail closed);
  - the app runs non-elevated by default using the user's Explorer token; no
    `runas`, no UAC prompt; elevated targets only when Pi itself is elevated and
    the call opts in;
  - kill and audit operate only on registered jobs and PID + creation-time
    identities, never on executable names or parent PIDs.
- **Interaction**: UI Automation patterns first (Invoke, Value, Toggle,
  ExpandCollapse, SelectionItem) for `gui_snapshot` refs and `set_value`/`type`.
  Fallback for coordinates: `WM_NCHITTEST` decides client vs non-client hits;
  client hits go to the deepest visible child window via `SendMessageTimeoutW`,
  non-client hits are posted asynchronously with `PostMessageW` so title-bar and
  menu modal loops cannot block the helper. Coordinates are in the full-window
  screenshot space. Per-thread DPI awareness is set only for the operation and
  restored afterwards.
- **Screenshots**: `PrintWindow(PW_RENDERFULLCONTENT)` of the full window rect,
  lossless PNG, with an `allBlack` flag in the result. An all-black capture is
  returned as evidence, flagged, and counted by the usage check instead of being
  silently retried.
- **Temp files** under `%LOCALAPPDATA%\Temp\pi-gui-testing-<session>`; deletion holds
  directory handles and refuses junctions, symlinks, and other reparse points.
- Audio muting (present in the reference) is out of scope.
- Software rendering forced where a framework allows it: Chromium/Electron
  `--disable-gpu`, `QT_OPENGL=software`, `QT_QUICK_BACKEND=software`, Flutter
  `--enable-software-rendering`. WPF: warn, do not touch the per-user registry.
- **Gated by spike S1** (§11), which runs the reference package on a Windows
  machine before any helper code is written. Known risks: black screenshots for
  GPU apps, AV/EDR flagging hidden-desktop behaviour.

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
- **Matching and precedence**: built-in secret patterns match a file or directory
  name at any depth (`services/api/.env` and `fixtures/.ssh/key` are excluded);
  a matching directory excludes everything below it. `sync.allow` and
  `sync.deny` use gitignore-style patterns relative to the project root. A path
  is synced when it is in
  the file set, not a dependency directory, not matched by `sync.deny`, and either
  not always-excluded or explicitly listed in `sync.allow`. `sync.deny` beats
  `sync.allow`; nothing re-includes a dependency directory.
- **Links and special files**: traversal never follows symlinks. A symlink is
  copied as a link only when its target resolves inside the project root and is
  itself synced; otherwise it is dropped and counted as excluded. Sockets, FIFOs,
  and device files are always dropped.
- Every sync result reports file count, bytes sent, and excluded-file count.

### 4.8 Dependency cache (client-side)

Clean remotes would otherwise reinstall dependencies every session. The cache
keeps installed dependencies **on the client** and ships them to the session.

- **Location**: `~/.cache/pi-extension-gui-testing/deps/<project-hash>/<target-os>-<arch>/<key>.tar.gz` (gzip, because the helper packs and unpacks archives and its Python has no zstd; the client never opens an archive)
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
| `/gui-doctor [backend] [--host <host>]` | Re-runs all checks and the smoke test. Never prompts, never remediates, and never changes configuration choices. It may create labelled temporary test resources, which it removes and audits before finishing. On success it refreshes the verified state; on failure it marks the backend unverified. `--host` (remote backends only) checks another host without touching the verified state. |
| `/gui-backend <id> [--project]` | Switches the active backend (must already be verified). Writes the global config, or `.pi/gui.local.json` with `--project`. |
| `/gui-usage [session]` | Shows the usage/cost check (§8.1) for current and recent sessions. |
| `/gui-reset <backend>` | Removes that backend's config, images, sandboxes, and VM volumes after confirmation. |
| `/gui-cleanup [backend\|--all] [--deps]` | Runs teardown and the sweep now, then the audit (§7a.5). Also cancels a running setup. |
| `/gui-export <session> <dest>` | Copies a session's screenshots, dumps, and logs out of the temp dir (§7a.2). |

`/gui-setup` flags. Every prompt has a flag equivalent, so a fully specified call
never prompts:

| Flag | Replaces prompt |
|---|---|
| `--host <ssh-alias-or-user@host>` | host picker from `~/.ssh/config` (`remote-*`, §4.2a) |
| `--targets linux,windows,macos` | target selection (`cua`; only `linux` passes until S1) |
| ~~`--api-key-env <VAR>`~~ | obsolete since Cua Cloud ended (§4.3); refused with an explanation |
| `--accept-billing` | billing + upload acknowledgement for the chosen cloud (`cua`) |
| `--cloud aws\|gcp\|hetzner\|modal` | cloud for sandboxes (`cua`; default: the `cua cloud connect --default` cloud) |
| `--rate-usd-per-hour <n>` | hourly price for the cost estimate when `cua cloud status` reports none (`cua`) |
| `--image <image>` | sandbox image, a Cua image alias or registry reference (`cua`; default Cua's `linux` image); a changed image is drift until `/gui-doctor` |
| `--accept-windows-license` | licensing acknowledgement (`docker-windows`) |
| `--fix` | approves every remediation that needs no password: package installs via passwordless sudo, image builds, key generation, VM install |
| `--no-fix` | never remediate; report and stop |
| `--project` | write the backend choice and host to `.pi/gui.local.json` instead of the global config |
| `--purge-tooling` | `remote-linux-docker`: remove the base image from the remote after every session (§7a.1, Q7) |

Setup and doctor are commands, not tools: the model cannot install or provision
anything itself. A tool call on an unverified backend fails with
`backend "<id>" is not set up; ask the user to run /gui-setup <id>`.

### 5.2 Setup flow

**Principle: verify everything, ask nothing that is already known.** A prompt
appears only when a decision or secret is genuinely missing. If every check
passes and every required acknowledgement is given by flag or already recorded,
setup runs start to finish with **zero prompts** and ends with one summary.

1. **Resolve inputs** per field in this order: flags → `.pi/gui.local.json` →
   global config → environment (`~/.ssh/config`) → prompt. Prompt
   only for what is still missing. `.pi/gui.json` contributes only the shared
   fields listed in §7. Setup and launch use the same resolution.
2. **Host detection**: OS, arch, distro/package manager, Pi version.
3. **Checks**: run every check for the backend (§5.4) in dependency order
   (client → connection → remote/runtime); independent checks run in parallel.
   Each returns `pass | warn | fail` with the observed value. A failed check skips
   the checks that depend on it and marks them `blocked`.
4. **All required checks pass** → go straight to step 7, no prompts.
5. **Remediation**, only for failures that have one:
   - Collect all fixable failures into **one** plan: exact commands, sudo needs,
     download sizes, durations, cost.
   - `--fix` → apply without asking. Otherwise **one** prompt for the whole plan
     (`ctx.ui.select`: apply all, review each item, cancel). Setup bounds every
     dialog with its own timer (default 10 minutes) because Pi reports a timed-out
     confirm the same as "no"; a timeout cancels setup.
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
backend. Commands have no Pi abort signal while the agent is idle, so setup owns
its own abort controller. It is aborted by `session_shutdown`, by the timeout or
signal of each dialog, and by `/gui-cleanup` (whether a second command can run
while setup is running is verified in M1). An aborted image build leaves no
labelled image or build container.

**Modes.** Commands check `ctx.hasUI`. Interactive and RPC mode may prompt. In
print/JSON mode there is no UI: setup runs only when no prompt is needed (all
inputs resolved and nothing to fix, or `--fix` / `--no-fix` given); otherwise it
fails and lists the missing flags. Pi 1.4.0 runs extension commands in print
mode, but in print and JSON mode it redirects extension writes to stdout onto
stderr and reserves stdout for its own output. Without a UI, commands therefore
report as follows: print mode writes the report to stderr; JSON and RPC mode
emit it as a custom message (`pi.sendMessage`), never as plain text on stdout.
When a required check fails without a UI (print/JSON), the command sets
`process.exitCode = 1`, because Pi does not turn command errors into an exit
code. With a UI the exit code is left alone, so a failed setup followed by a
successful retry does not make Pi exit with an error later. M1 verifies all three
paths with a live run.

### 5.3 Check definition

```ts
interface Check {
  id: string;                 // e.g. "linux.xvfb"
  description: string;
  kind: "observe" | "probe";  // probe creates temporary labelled resources
  dependsOn?: string[];       // failed dependency → this check is "blocked"
  required: boolean;          // false → "warn" and a degraded capability
  run(ctx): Promise<{ status: "pass" | "fail" | "warn" | "blocked"; observed: string }>;
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
bounds). `observe` checks have no side effects. `probe` checks may create only
labelled temporary resources and remove them before returning.

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
| `docker.permission` | yes | `docker info` works without sudo | docker group hint |
| `docker.rootless` | yes | daemon is rootful (`docker info` security options have no `rootless`); rootless fails in M1 with a clear message (§4.1) | — (rootless support planned for M1c) |
| `docker.bind-uid` | yes | probe: a file a container creates on a bind of a session temp dir is owned by the host user | — (bug if fails) |
| `docker.endpoint` | yes | active context endpoint is a local `unix://` socket; no remote context or `DOCKER_HOST` (§4.1) | switch to the local context |
| `docker.version` | yes | server ≥ 29.0 (lowest tested major); newer untested majors warn | — |
| `docker.ostype` | yes | `OSType` is `linux` | switch Docker Desktop to Linux containers |
| `docker.arch` | yes | amd64 or arm64 | — |
| `disk.free` | yes | ≥ 5 GB | — |
| `image.base` | yes | base image present and its `pi-gui-testing.version` and `.protocol` labels match (§4.1) | build image (confirm) |
| `isolation.inspect` | yes | probe: a labelled test container violates none of the §4.1 hard rules | — (bug if fails) |

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
| `sync.exclusions` | yes | a dry-run sync of the real project lists no file matching the secret patterns (§4.7) | — (bug if fails) |

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

**`cua`** (revised 2026-10-24 for the `cua` CLI, §4.3; every check is read-only and creates nothing)

| Check | Required | Pass when | Remediation |
|---|---|---|---|
| `cua.cli` | yes | `cua --version` reports 0.7 or newer | install or update the `cua` CLI |
| `cua.network` | yes | the Cua API host answers a credential-free request | network/proxy hint |
| `cua.signin` | yes | `cua auth status` reports signed in (replaces `cua.key`) | `cua auth login` (manual) |
| `cua.auth` | yes | an authenticated read-only call (`auth whoami`) succeeds | `cua auth login` (manual) |
| `cua.cloud` | yes | a cloud account is connected and its credentials are found | `cua cloud connect <cloud> --default` (manual) |
| `cua.quota` | yes | `cua cloud test <cloud>` passes | fix what it reports (manual) |
| `cua.targets` | yes | each requested target OS is available (Windows, macOS refused until S1) | — (report which are missing) |
| `cua.ttl` | no | sandboxes expire on their own | `cua cloud connect <cloud> --ttl-hours 8` |
| `cua.rate` | no | an hourly price is known (from Cua or `--rate-usd-per-hour`) | `--rate-usd-per-hour` |
| `cua.cost-ack` | yes | billing and upload acknowledged at setup for this cloud | confirm dialog or `--accept-billing` |

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
| `helper.job` | yes | a test process in a kill-on-close Job Object dies when the job handle closes | — |
| `helper.nonelevated` | yes | a non-elevated Explorer token is obtainable; refuse otherwise | run Pi from a normal user session |
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
same JSON-lines protocol over stdio (container entrypoint via `docker run -i`,
local spawn, SSH) or a localhost-only socket (VM guests).

**Framing**: the client passes a random 128-bit token (32 hex characters) in the
`PI_GUI_TESTING_TOKEN` environment variable, not in argv. The helper prints
`PI-GUI-TESTING-READY <token>` within 10 s, or the session fails with the
captured output as diagnostics. Only lines prefixed with that token are protocol
messages. Anything before or between them (MOTD, rc output, app output) is
captured as diagnostics and ignored. The token separates protocol lines from
noise; it is not a secret.

**Envelope**: every request carries an `id`; every response carries the same
`id` and either `ok: true` with a result or `ok: false` with
`error: {code, message}`. Events (`log`) carry no `id`. Requests on one session
run sequentially, except `ping` and `cancel`, which bypass the queue. The exact
types are frozen in `src/protocol.ts`.

```
hello {protocol, packageVersion} → {protocol, helperVersion, os, arch, capabilities}
ping {} → {ok}                                   # heartbeat, every 15 s
launch {cmd, args, env, cwd} → {pid, windows[]}
wait {for: window|text|ref|idle, value?, timeoutMs} → {matched, elapsedMs}
snapshot {maxNodes} → {snapshotId, coverage, tree: [{ref, role, name, value, bounds, states}]}
screenshot {window?: ref, maxEdge?} → {captureId, target, origin, width, height, scale, png_base64, sha256, allBlack?}
act {ref? | captureId + x,y, action: click|double_click|right_click|type|key|scroll|set_value, text?} → {ok}
windows {} → [{ref, title, bounds}]
exec {cmd, cwd, env, timeoutMs} → {exitCode, elapsedMs}  # setup commands
cancel {targetId} → {ok}                         # aborts a running request
snapshotFull {snapshotId} → {tree_gz_base64}     # full tree for the temp-dir dump
stop {} → {ok, leftovers: Leftover[]}             # Leftover = {kind: string, id: string, detail?}
event log {stream: stdout|stderr, source: app|setup, data}  # bounded, app output
```

- **Refs** are `<snapshotId>:<n>` and valid only until the next `snapshot`; an
  older ref is rejected with `stale ref, take a new snapshot`.
- **Coordinates**: `x,y` in `act` are pixels in the unscaled space of the capture
  named by `captureId`: the screen, or the window when the screenshot targeted
  one. `origin` gives that capture's top-left corner on the screen and `scale`
  the downscale factor of the returned PNG. Only the most recent capture is
  valid; an older `captureId` is rejected with `STALE_REF`.
- **`allBlack`**: set when a capture is entirely black (expected on some Windows
  GPU apps, §4.5). The image is still returned as evidence and counted by the
  usage check.
- **Leftover `kind`** is an open string (for example `container`, `process`,
  `tempdir`, `job`, `desktop`) so later backends add kinds without a protocol
  change.
- **Helper executable**: clients start the helper as an opaque executable with
  stdio; nothing assumes it is written in Python.
- **Screenshots**: default virtual screen 1280×800×24; images returned to the
  model are downscaled to at most 1280 px on the long edge (`maxEdge` overrides).
- **Heartbeat**: the client pings every 15 s regardless of running operations.
  A helper that receives no client message for 60 s tears down and exits
  (§4.1, §7a.3), so long `setup` commands never trigger it.

- Linux helper: Python (AT-SPI via `pyatspi`, input via `xdotool`/XTEST, capture
  via XGetImage/`import`).
- Windows helper: small native exe (UI Automation, `PostMessage`, `PrintWindow`);
  inside `docker-windows` it may also use `SendInput` because the whole session is
  isolated.
- `cua`: runs the Linux helper inside the sandbox over `cua sandbox exec -i` (§4.3); no protocol mapping is needed.

## 7. Configuration and state

- Global: `<agent dir>/gui/config.json`, where the agent dir comes from Pi's
  `getAgentDir()` (default `~/.pi/agent`; honours `PI_CODING_AGENT_DIR`): active
  backend, verified backends with `{verifiedAt, toolVersions, checksPassed}`.
  `pi.version` reads Pi's exported `VERSION`.
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
| Client | global/project config (§7), verified-setup state, pinned host-key fingerprints, `cua` settings (`cua.json`: acknowledgement, cloud, image, rate; no credential, Q1) and the sandbox ledger (`cua-sandboxes/`), tooling images without project data (`docker-linux` base image, `docker-windows` base disk), the dependency cache (§4.8) | screenshots, accessibility dumps, logs, synced copies, sockets, session state |
| Remote SSH host | system packages installed at setup with user consent (tooling); the base image for `remote-linux-docker` (tooling, kept by default; `--purge-tooling` removes it after each session) | session dirs, helper copies, app processes, Xvfb displays/locks, containers, volumes, networks, project images, build cache, logs |
| Cua (user's cloud) | nothing (unless `keepSandbox: true`, which keeps billing) | sandboxes, uploaded files |
| VM guest (`docker-windows`) | base disk (tooling) | session overlay, guest session dir |

Tool output that the model already received (images and text in the transcript)
is part of the Pi session, not of this package's data.

### 7a.2 Client side

- **Session temp dir**: `fs.mkdtemp(join(os.tmpdir(), "pi-gui-testing-"))`, mode 0700.
  Holds screenshots, full accessibility dumps, logs, sync staging, the SSH
  `ControlPath` socket, and Xvfb/D-Bus runtime dirs for `local-linux`.
- Contains `owner.json` = `{pid, processStartTime, bootId, clientId, piSessionId,
  backend, createdAt, resources[]}`, written atomically (temp file + rename) and
  updated before each resource is created. `bootId` comes from
  `/proc/sys/kernel/random/boot_id`.
- **Removed after use** by `gui_stop` and by the idempotent `session_shutdown`
  handler, which is the primary path. A process `exit` handler does only bounded
  synchronous work (`docker rm -f`, at most 5 s per container). The extension
  installs no `SIGINT` handler; Pi owns Ctrl-C and its own signal handling.
- **Startup sweep** (covers crashes, `SIGKILL`, power loss): on `session_start`,
  every `os.tmpdir()/pi-gui-testing-*` dir whose owner is gone (different boot,
  PID missing, or PID reused with a different start time) is removed, together
  with the processes and labelled containers it recorded. Docker objects whose
  `pi-gui-testing.owner` label names a dead owner are removed even when no temp
  dir exists. A missing or malformed `owner.json` is reported and never treated
  as dead. Resources of live owners are never touched.
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
| Cua | sandboxes in this client's ledger, named with this client's host tag (unless `keepSandbox`) |
| `docker-windows` | session overlays; running session containers |
| `local-windows` | session Job Objects and their processes; session private desktops; session temp dir |

The audit after `gui_stop` and at the end of the smoke test covers only that
session's resources. The audit in `/gui-doctor`, `/gui-cleanup`, and the startup
sweep reports only orphans: resources of every type whose owner is gone. Live
sessions are exempt everywhere.

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

There is no hard cost cap (the user's cloud account enforces budgets and spending limits
settings). Instead, a usage check detects unintended behaviour and never blocks:

- **Tracked per session**: tool calls by type, actions, screenshots, bytes
  synced, wall time; for `cua`, sandbox runtime × rate (from `cua cloud status` when
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
| M3 | `cua` (Linux, Windows; macOS behind a flag). Since Cua Cloud ended (§4.3): the user's own cloud via the `cua` CLI; Linux first, Windows/macOS after S1 | Smoke test on each available target; sync excludes secrets; stop leaves no running billable sandbox |
| M4 | `docker-windows` | Unattended install from `/gui-setup` with no manual steps; smoke test passes; ports bound to localhost only |
| S1 | Spike: hidden-desktop fidelity, using `@iiwate/pi-silent-gui` as-is on a Windows machine | Tk, PySide6, WinForms, Electron (with and without `--disable-gpu`), WPF launched, clicked, and captured; per-framework `all_black` rate and click delivery recorded; UIA reachability on the private desktop measured separately with a minimal UIA probe; result decides helper language (Q4) |
| M5 | `local-windows` (only if S1 is acceptable) | Smoke test passes; foreground-unchanged assertion passes; AV behaviour documented |

**Status (2026-10-24).** M1, M1b, M1c, M2, M2b, and M3 for the Linux target
are implemented on branch `feat/gui-testing-milestones` and covered by unit,
contract, and host-runnable helper tests with fakes. **Live verification is
pending for every one of them**: no exit criterion above has been met on real
Docker, Docker Desktop, an X server, an SSH server, or a Cua account yet (see
`DEVELOPMENT.md` "Before publishing" and the M1b–M3 plan §8). S1, M4, M5, and
the Windows/macOS targets of M3 are blocked on a Windows machine (S1 decides
Q4). Recorded deviations: the dependency cache stores `.tar.gz`, not `.tar.zst`
(§4.8; the helper's Python has no zstd), and M3 targets the `cua` CLI (§4.3).

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
| Q1 | ~~Where should the Cua API key live?~~ Resolved 2026-10-24: nothing to store. Cua Cloud and its API keys ended; the `cua` CLI keeps the cua.ai sign-in and the cloud credentials, and the package stores, reads, and sends none. |
| Q2 | ~~Cua pricing and macOS availability?~~ Resolved 2026-10-24: pricing is the user's own cloud's (`usd_per_hour` per machine kind from `cua cloud status`, or `--rate-usd-per-hour`); billing is by that cloud. macOS sandboxes wait for the Windows/macOS helper work after S1. |
| Q3 | dockur/windows: confirm the OEM install hook and shared-folder mechanism versions before M4. |
| Q4 | Windows helper form: (a) native `.exe` (recommended; needs a code-signing certificate, owner to be decided) or (b) Python helper like the reference (no signing, but setup must download an embeddable Python automatically to keep install-and-use). Decide after S1. |
| Q5 | ~~Docker Desktop hosts in M1?~~ Resolved: Linux hosts in M1, Docker Desktop hosts in M1c. |
| Q6 | ~~Remote host scope?~~ Resolved: global config or `.pi/gui.local.json`; never the committed file. |
| Q7 | ~~Remote tooling retention?~~ Resolved: keep the base image by default; `--purge-tooling` opts out. |
