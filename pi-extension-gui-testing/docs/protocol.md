# Helper protocol (version 2)

Contributor contract between the TypeScript client and the helper. The source of truth for types is [`src/protocol.ts`](../src/protocol.ts); this page explains the same contract for the Python helper. It stays a separate document because helper and client source comments cite it; [DEVELOPMENT.md](../DEVELOPMENT.md) links here.

## Process and transport

- `docker-linux`: the image is built from a staged tar context streamed to `docker build -` that contains only the helper files and the GTK 3 smoke app (no buildx needed, no project data). The helper is the container entrypoint, `ENTRYPOINT ["tini", "--", "/opt/pi-gui-testing/helper"]`, with no `CMD`. The client starts it with `docker run -i --rm …` and talks over the container's stdin/stdout. The helper runs on the image's system `python3`.
- The client treats the helper as an opaque executable with stdio. Nothing in the client assumes Python.
- Other backends use the same helper and framing over other stdio transports:
  - `local-linux`: the helper runs on the client in host mode (`PI_GUI_HELPER_MODE=host`), started directly with `python3 -I -B helper` and an allow-listed environment.
  - `remote-linux`: the helper runs on the SSH host in host mode under `env -i`, over the session's ControlMaster connection. The token is written on stdin before the helper starts reading frames, never in argv.
  - `remote-linux-docker`: `docker run -i --rm …` on the SSH host, as in `docker-linux`.
  - `cua`: `cua sandbox exec -i <ref> -- sh -c '<preamble>exec "$@"' sh python3 -I <dir>/tools/helper`. The preamble holds one `IFS= read -r <NAME> && export <NAME> && ` per variable of the helper's environment, in sorted name order: `PI_GUI_ALLOW_EXEC`, `PI_GUI_DEPS_DIR`, `PI_GUI_DISPLAY_LOCK_DIR`, `PI_GUI_HELPER_MODE`, `PI_GUI_RUNTIME_DIR`, `PI_GUI_TESTING_TOKEN`, `PI_GUI_WORKSPACE`. The client writes the values, one per line in the same order, as the first stdin lines, so no value is ever in an argv (a value with a line break is refused). The helper runs in host mode inside the sandbox.
- Host mode (directories, display locks, forced environment, teardown, probes) is specified in the docstring of `helpers/linux/pi_gui_helper/hostmode.py` and summarised in [DEVELOPMENT.md](../DEVELOPMENT.md#helper-host-mode-contract). In host mode `exec` answers `BAD_REQUEST` unless the client sets `PI_GUI_ALLOW_EXEC=1` (`local-linux` never does), `/deps/venv` is never created, and the `/deps` environment below is replaced by the `PI_GUI_DEPS_DIR` variables.
- The helper starts Xvfb, the private D-Bus session bus, `at-spi-bus-launcher`, and `openbox` itself, then sets `org.a11y.Status` `IsEnabled=true` and `ScreenReaderEnabled=true` on its private bus.

## Framing

1. The client passes a 32-hex-character token in the environment variable `PI_GUI_TESTING_TOKEN`.
2. Within 10 s of start, the helper prints `PI-GUI-TESTING-READY <token>\n` on stdout.
3. After that, every protocol line in either direction is `<token> <json>\n`: the token, one space, one JSON object, LF. One line holds at most 64 MiB.
4. Any stdout line without the token prefix is a diagnostic. The client keeps it for error messages and ignores it otherwise. The helper writes its own diagnostics to stderr.
5. App and setup output never goes to the helper's stdout directly. The helper captures it and forwards it as `log` events.

## Requests and responses

Request (client → helper):

```json
{"id": 7, "method": "screenshot", "params": {"maxEdge": 1280}}
```

Success response (helper → client), same `id`:

```json
{"id": 7, "ok": true, "result": {"captureId": "c3", "target": "screen", "origin": {"x": 0, "y": 0}, "width": 1280, "height": 800, "scale": 1, "png_base64": "iVBOR…", "sha256": "9f2c…"}}
```

Error response:

```json
{"id": 8, "ok": false, "error": {"code": "STALE_REF", "message": "stale ref, take a new snapshot"}}
```

Error codes: `STALE_REF`, `NOT_FOUND`, `TIMEOUT`, `HANDOFF`, `PROTOCOL_MISMATCH`, `CANCELLED`, `BAD_REQUEST`, `INTERNAL`, and since version 2 `ARCHIVE_REJECTED` (a dependency archive failed verification; the deps dir was emptied) and `TOO_LARGE` (a deps dir or archive exceeds the request's bound).

Version history: version 1 (M1); version 2 (M1b) adds the dependency-cache methods below, the two error codes, `hello.platform`, the `deps` capability, and the host-mode variable `PI_GUI_DEPS_DIR`. The image label `pi-gui-testing.protocol` carries the version, so `image.base` asks for a rebuild after an upgrade.

Event (helper → client, no `id`):

```json
{"event": "log", "stream": "stderr", "source": "app", "data": "Gtk-WARNING: …"}
```

`data` holds at most 64 KiB per event; longer output is split into several events.

## Ordering

- Requests on one session run one at a time, in arrival order.
- `ping` and `cancel` bypass that queue and are answered immediately, even while another request runs.
- `cancel {targetId}` aborts the running or queued request with that id; the cancelled request answers with `CANCELLED`.

## Methods

| Method | Params | Result |
|---|---|---|
| `hello` | `protocol`, `packageVersion` | `protocol`, `helperVersion`, `os`, `arch`, `capabilities[]`, `platform?` (version 2: e.g. `Linux x86_64; glibc 2.36; debian 12; python 3.11.2`, at most 256 characters; part of the dependency-cache key). `capabilities` holds `deps` when the session has a deps dir. If `protocol` differs from the helper's, answer `PROTOCOL_MISMATCH` and exit. |
| `ping` | — | `{ok: true}` |
| `launch` | `cmd`, `args[]`, `env{}`, `cwd` (default `/workspace`) | `pid`, `windows[]`. The app runs in its own process group under the helper, with the private `DISPLAY` and bus; teardown kills that group. Waits up to 20 s for a new window and returns `windows: []` if the app runs without one. A missing `cwd` or unknown command → `NOT_FOUND`; exit within the grace period without a window → `HANDOFF`. |
| `wait` | `for` (`window`/`text`/`ref`/`idle`), `value?`, `timeoutMs` (default 10 s, max 10 min) | `matched`, `elapsedMs`. A timeout returns `matched: false`, not an error. `window`: a window whose title contains `value` (case-insensitive) or equals a window ref, or any window without `value`; `text`: any accessible name or value contains `value`; `ref`: the ref resolves and is showing; `idle`: three identical screen hashes 250 ms apart. |
| `snapshot` | `maxNodes` | `snapshotId`, `coverage` (`full`/`partial`/`none`), `tree[]` (truncated to `maxNodes`), `truncated` |
| `snapshotFull` | `snapshotId` | `tree_gz_base64`: gzip of the JSON array of all nodes, base64 |
| `screenshot` | `window?` (ref), `maxEdge?` (default 1280) | `captureId`, `target` (`"screen"` or the window ref), `origin`, unscaled `width`/`height`, `scale`, `png_base64`, `sha256` of the unscaled capture, `allBlack?` |
| `act` | `ref`, or `captureId` + `x`,`y`; `action`; `text?` | `{ok: true}` |
| `windows` | — | `windows[]` |
| `exec` | `cmd`, `cwd`, `env{}`, `timeoutMs` | `exitCode`, `elapsedMs`. Runs `sh -c cmd`; output arrives as `log` events with `source: "setup"`. |
| `cancel` | `targetId` | `{ok: true}`, also for unknown or finished ids (a late cancel cannot be told from an early one). |
| `depsPack` | `maxBytes` | `transfer`, `size`, `sha256`, `entries`, `skipped`. See "Dependency cache". |
| `depsRead` | `transfer`, `offset`, `length` (≤ 4 MiB) | `data_base64`, `eof` |
| `depsReceive` | `size`, `sha256` | `transfer` |
| `depsWrite` | `transfer`, `offset` (= bytes received so far), `data_base64` (≤ 4 MiB decoded) | `received` |
| `depsUnpack` | `transfer`, `maxUnpackedBytes`, `maxEntries` | `entries`, `bytes` |
| `depsDiscard` | `transfer` | `{ok: true}` (idempotent) |
| `stop` | — | `ok` (false when leftovers remain), `leftovers[]` (`{kind, id, detail?}`; in containers, `kind: "process"` for any process still alive besides tini and the helper) |

Tree nodes: `{ref, role, name, value?, bounds?, states[], parent?}`. Refs are `<snapshotId>:<n>` and valid only until the next `snapshot`; older refs fail with `STALE_REF`.

`act` actions: `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `set_value`.

- `click` by ref tries the AT-SPI actions `click`, `press`, `activate`, `toggle`, `jump`, `open`, then a pointer click at the element centre.
- `type` and `key` by ref focus the element first; without a target they go to the focused window; with coordinates they click there first.
- `key` text uses xdotool key syntax separated by spaces, e.g. `ctrl+a BackSpace`. `scroll` text is `up|down|left|right [1-100]` (default `down 1`).
- `set_value` needs a ref whose element supports EditableText or Value.

Window refs are `win:0x<X window id>`. They come from `windows`, `launch`, and `screenshot.target`, are accepted wherever a ref is, and do not go stale on `snapshot`; a vanished window → `NOT_FOUND`.

`screenshot.sha256` is the SHA-256 of the unscaled raw RGB pixels (row-major, 3 bytes per pixel, no header), so identical screens hash the same regardless of PNG encoding. A window screenshot crops the screen to the window's bounds without raising it, so overlapping windows appear in the crop.

## Coordinates

`x`,`y` are pixels in the unscaled space of the capture named by `captureId`: the whole screen, or the window when the screenshot targeted one. `origin` is that capture's top-left corner on the screen, so the screen point is `origin + (x, y)`. `scale` is the factor applied to the returned PNG (returned size = unscaled size × scale). Only the most recent capture is valid; an older `captureId` fails with `STALE_REF`.

## Heartbeat and teardown

- The client sends `ping` every 15 s.
- When the helper receives no client message for 60 s (or the value of `PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS`, which only tests set), it tears down and exits.
- It also tears down on `stop`, on stdin EOF, and on `SIGTERM`/`SIGHUP`: kill the app process group, stop `openbox`, the bus, and Xvfb, then exit. In `docker-linux`, `--rm` then removes the container.

## `/deps` and `setup`

Before the first `exec`, the helper creates `/deps/venv` with `python3 -m venv --system-site-packages`. `exec` and `launch` get this environment on top of the request's `env`:

```text
VIRTUAL_ENV=/deps/venv
PATH=/deps/venv/bin:/deps/node/bin:$PATH
npm_config_prefix=/deps/node
PYTHONUSERBASE=/deps/python
HOME=/home/app
XDG_RUNTIME_DIR=/run/user/<uid>
DISPLAY=:<n>
DBUS_SESSION_BUS_ADDRESS=<private bus>
GDK_BACKEND=x11
QT_QPA_PLATFORM=xcb
SDL_VIDEODRIVER=x11
ELECTRON_OZONE_PLATFORM_HINT=x11
QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
QT_ACCESSIBILITY=1
```

`WAYLAND_DISPLAY` and `NO_AT_BRIDGE` are removed.

## Dependency cache (version 2)

The client keeps installed dependencies between sessions (spec §4.8). The archive format is a gzip-compressed tar (PAX). The client treats archives as opaque bytes: it hashes, stores, and forwards them and never unpacks them.

Deps dir: `/deps` in containers (docker-linux, remote-linux-docker); in host mode the directory named by `PI_GUI_DEPS_DIR` (remote-linux sets `<session dir>/deps`; local-linux sets none, so the deps methods answer `BAD_REQUEST` and `hello` omits `deps`).

Miss (after a successful `setup`):

```text
depsPack {maxBytes}            → {transfer, size, sha256, entries, skipped}
depsRead {transfer, offset, length} … until eof   (client hashes while it stores)
depsDiscard {transfer}
```

Hit (before any `setup`, instead of it):

```text
depsReceive {size, sha256}     → {transfer}
depsWrite {transfer, offset, data_base64} …
depsUnpack {transfer, maxUnpackedBytes, maxEntries} → {entries, bytes}
```

Packing walks the deps dir in name order without following symlinks. It adds directories, regular files (opened with `O_NOFOLLOW`), and symlinks whose target stays inside the deps dir, also when resolved through the dir's other symlinks (an absolute target inside it becomes relative). It skips and counts everything else: symlinks out of the deps dir, directly or through other links, (a venv's `bin/python` → `/usr/bin/python3`, recreated by the venv step before the next `exec`/`launch`), sockets, FIFOs, devices. Owners are never stored; modes keep `0755` plus owner read/write. A compressed size over `maxBytes` answers `TOO_LARGE`.

Unpacking first checks that the upload has exactly the announced size and SHA-256, then empties the deps dir and extracts. It refuses, with `ARCHIVE_REJECTED`:

- absolute names, `..` components, NUL, names over 4096 bytes or components over 255 bytes, nesting over 128 levels;
- members below a symlink or a file (every parent is opened with `O_NOFOLLOW` relative to the previous one), and members that collide with an existing entry;
- hardlinks, character and block devices, FIFOs, contiguous files, and sparse files in every encoding (old GNU `S` members and PAX `GNU.sparse.*` attributes of versions 0.0, 0.1, and 1.0), refused before their sparse maps are read;
- symlinks with an absolute target or a target that leaves the deps dir, also when resolved the way the kernel will through the archive's other symlinks (`b -> .` then `a -> b/..`), and symlink loops or chains of more than 40 links;
- a second archive root entry, or more than 4 metadata records (PAX, GNU long name or link) before one member;
- data that is not gzip or tar, or ends early.

More than `maxUnpackedBytes` of file data or `maxEntries` entries answers `TOO_LARGE`, and so do a metadata record over 64 KiB (refused before its payload is read), more than `(maxEntries + 1) × 5` header records of any kind, and a decompressed stream longer than the file data allowed plus the records' own blocks. Every failure (also `CANCELLED`) leaves the deps dir empty. Owners are never applied; setuid, setgid, and sticky bits are dropped; file mtimes are kept. Transfers live in unlinked temp files (at most four at a time) and end with the helper.

Host mode with `PI_GUI_DEPS_DIR` also gives every child `PIP_TARGET=<dir>/python`, `PYTHONPATH=<dir>/python`, `npm_config_prefix=<dir>/node`, `NODE_PATH=<dir>/node/lib/node_modules` (defaults the request's `env` may override) and `PATH` prefixed with `<dir>/python/bin:<dir>/node/bin`, so installs stay valid at another session path.

## Windows helper

`helpers/windows/` speaks this same protocol version 2 on Windows 10 1809+ and Windows 11. It is a Windows PowerShell 5.1 script that compiles the C# sources next to it with `Add-Type` (in memory, no network) at every start and then runs them; the sources stay plain C# 5 so they can later be built into a signed `.exe` without changes (spec Q4). Status: tested only with a fake platform in place of the Win32 layer; it has not run on Windows yet, and spike S1 ([`spikes/s1/`](../spikes/s1/README.md)) is its first live check.

### Process and transport

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\helper.ps1 [-StdinEnv NAME,NAME,...]
```

- Deploy `helper.ps1`, `THIRD_PARTY_NOTICES.md`, and `src\` with its `win\` subdirectory unchanged. The script compiles only its fixed list of 15 files.
- The script refuses (stderr diagnostic, exit 1, no ready line) when it is not on Windows, not Windows PowerShell 5.1 (`pwsh` is refused), or PowerShell runs in Constrained Language mode (AppLocker/WDAC block `Add-Type`). A failed compile (for example antivirus blocking `csc.exe`) also exits 1.
- The ready line comes only after the compile, so the compile must fit in the client's 10 s ready timeout; spike S1 measures how long it takes.
- The helper keeps the real stdout for protocol lines and points the process's stdout handle and `Console.Out` at stderr before anything else runs, so stray output cannot reach the protocol stream. Apps never inherit the helper's stdio: each child gets only its own output pipes and `NUL` as stdin.
- `-StdinEnv`: for transports without an environment (`cua sandbox exec`), the client passes the variable names, comma-separated, in argv and writes their values as the first stdin lines in the same order, before any protocol line. Allowed names: `PI_GUI_HELPER_MODE`, `PI_GUI_WORKSPACE`, `PI_GUI_RUNTIME_DIR`, `PI_GUI_ALLOW_EXEC`, `PI_GUI_ALLOW_ELEVATED`, `PI_GUI_WIN_DESKTOP`, `PI_GUI_WIN_INPUT`, `PI_GUI_WIN_SOFTWARE_RENDERING`, `PI_GUI_DEPS_DIR`, `PI_GUI_WIN_TAG`, `PI_GUI_TESTING_TOKEN`, `PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS`. An unknown or repeated name, a missing line, or a value with CR or NUL exits 2.
- `-Probe NAME` prints one JSON line (`{probe, ok, ...}`) on stdout and exits (0 when `ok`), without the protocol: `env` (build, arch, elevation, session, window station), `desktop` (create and destroy a private desktop), `job` (a process in a kill-on-close job dies when the job handle closes), `nonelevated` (a non-elevated token is available), `uia` (UI Automation reads a window on a private desktop), `foreground` (the user's foreground window, for the isolation assertion before and after a session).
- Teardown runs on `stop`, stdin EOF, heartbeat timeout, Ctrl+C, a mismatched `hello`, and after a fatal error: an `INTERNAL` error the helper marks fatal (more than two desktop operations stuck in a hung app) is answered first, then the helper tears down and exits 0, so the client sees the session closed. If the helper process is killed instead, its Job Object handles close and Windows ends every app; the client's sweep removes the runtime dir.

### Environment contract

| Variable | Meaning |
|---|---|
| `PI_GUI_TESTING_TOKEN` | as on Linux (required) |
| `PI_GUI_HELPER_MODE` | `local` (default): on the user's machine, apps always run on a private desktop. `guest`: inside a dedicated VM or sandbox session (`docker-windows`, `cua`); same containment, and the options below may use the guest's own desktop. Anything else exits 1. |
| `PI_GUI_WORKSPACE` | absolute local path (`C:\...`), default `cwd` of `launch` and `exec` (required) |
| `PI_GUI_RUNTIME_DIR` | session dir the client created, named `pi-gui-testing-<session>`; in `local` mode directly under `%LOCALAPPDATA%\Temp` (required). It must be a real directory reached without junctions or symlinks, owned by the user, Administrators, or SYSTEM, and not writable by Everyone, Users, Authenticated Users, INTERACTIVE, or ANONYMOUS LOGON. The helper creates `tmp\` (the apps' `TEMP`/`TMP`) and `session.json` in it, removes `tmp\` on teardown, and leaves the dir to the client. |
| `PI_GUI_ALLOW_EXEC=1` | allows `exec` (default off: `BAD_REQUEST`) |
| `PI_GUI_ALLOW_ELEVATED=1` | apps run with the helper's elevated token; valid only when the helper is elevated (exits 1 otherwise) |
| `PI_GUI_WIN_DESKTOP` | `private` (default) or `interactive`; `interactive` only in `guest` mode, and only in an interactive session (window station `WinSta0`, session > 0). An SSH or service session is session 0, so it must use `private`. |
| `PI_GUI_WIN_INPUT` | `messages` (default) or `sendinput`; `sendinput` only with `PI_GUI_WIN_DESKTOP=interactive` |
| `PI_GUI_WIN_SOFTWARE_RENDERING` | `1` (default) or `0`; see "Launching" |
| `PI_GUI_WIN_TAG` | the session tag, 16 lower-case hex digits (anything else exits 1); default random. Every job and the private desktop carry it, so a client that recorded the tag before the start can tell the session's objects from others (`local-windows` uses its runtime dir's own digits). |
| `PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS` | tests only, as on Linux |
| `PI_GUI_DEPS_DIR` | ignored with a diagnostic: the Windows helper has no dependency cache |

`PI_GUI_DISPLAY_LOCK_DIR` and the other Linux host-mode variables are not used.

### Elevation

In `local` mode an elevated helper without `PI_GUI_ALLOW_ELEVATED=1` (and without `-StdinEnv`) restarts itself before reading stdin: a copy runs with the Explorer shell's token (`CreateProcessWithTokenW`), created suspended inside a kill-on-close Job Object without UI limits (the apps' jobs nest in it), with the same stdio and environment, and the first process only waits and returns the copy's exit code. The copy must be non-elevated and belong to the same user, otherwise startup fails. No `runas`, no UAC prompt. A `local` helper that is still elevated at startup (for example with `-StdinEnv`) exits 1. In `guest` mode the helper's token is used as is.

### Launching

- One named Job Object (`Local\pi-gui-testing-<tag>-job-<random>`) per `launch` and per `exec`, with kill-on-close, die-on-unhandled-exception (no error dialog blocking a crashed app), no breakaway, and no UI limits (a job with UI limits cannot be nested, and the app's job is nested whenever the helper itself runs in a job). A join refused because of the helper's own job is reported as such. The process joins it atomically at creation (`PROC_THREAD_ATTRIBUTE_JOB_LIST`) and starts suspended. Before it resumes, the helper checks the job membership and, unless elevation is allowed, that the process token is not elevated, starts the output pumps, and records the process in `session.json`. Any failure terminates the job.
- Apps start on the session desktop: a private desktop `pi-gui-testing-<tag>-<random>` in the helper's window station, created at startup with a name the caller cannot choose. The helper never calls `SwitchDesktop` or clipboard functions, and `SendInput` only with `PI_GUI_WIN_INPUT=sendinput` in guest mode.
- `cmd` resolution: a path (with `\`, `/`, or `:`) is taken relative to `cwd`; a bare name is searched only in the absolute directories of the child's `PATH`, never in `cwd`, with the `PATHEXT` extensions. `.cmd`/`.bat` files run through `cmd.exe /d /s /c`; their arguments must not contain `"`, `%`, `!`, or line breaks (`BAD_REQUEST`), because `cmd.exe` would expand or reinterpret them. Other arguments are quoted for `CommandLineToArgvW`.
- `exec` runs `cmd.exe /d /s /c "<cmd>"` (the counterpart of `sh -c`) on the session desktop. Exit codes outside -1000..1000 (Windows status codes such as `0xC0000005`) are reported as `1000`, with the real code in a `setup` log event.
- Child environment: the helper's environment without any `PI_GUI_*` variable; `PYTHONIOENCODING=utf-8` as a default the request may override; then the request's `env`; then forced values it cannot override: `TEMP` and `TMP` (`<runtime>\tmp`), `PI_GUI_TAG` (session tag), and with software rendering `QT_OPENGL=software`, `QT_QUICK_BACKEND=software`, `FLUTTER_ENGINE_SWITCHES=1` + `FLUTTER_ENGINE_SWITCH_1=enable-software-rendering` (unless the request sets Flutter switches itself; release engines ignore them). Names are case-insensitive; a name with `=` or a value with NUL is `BAD_REQUEST`.
- Chromium/Electron (`electron`, `chrome`, `chromium`, `msedge`, or `npx`/`node` running Electron) get `--force-renderer-accessibility` and, with software rendering, `--disable-gpu`. WPF cannot be switched to software rendering without a per-user registry change, which the helper never makes; when a WPF window appears it sends one `log` event warning that captures may be black.
- App output arrives as `log` events (`source: "app"` or `"setup"`), decoded as UTF-8; the helper keeps only an 8 KiB tail per process for error messages.

### Differences in results

- `hello`: `os: "windows"`, `arch` `x64`, `arm64`, or `x86`, `platform` like `Windows 10.0.22631 x64; .NET Framework 4.0.30319.42000; PowerShell 5.1.22621.4391`. `capabilities`: `launch`, `wait`, `snapshot`, `snapshotFull`, `screenshot`, `act`, `windows`, `exec` (only with `PI_GUI_ALLOW_EXEC=1`), `a11y-uia`, and `desktop-private` or `desktop-interactive`. Never `deps`: the six deps methods answer `BAD_REQUEST`.
- Window refs are `win:0x<HWND in lowercase hex>`. Only windows of the session are listed or accepted: on a private desktop every visible top-level window on it; on a guest's interactive desktop only windows of the session's own processes. A ref to any other window is `NOT_FOUND`. Minimized, cloaked, and empty windows, menus, tooltips, IME windows, and untitled tool windows are not listed.
- `screenshot` of a window: `PrintWindow(PW_RENDERFULLCONTENT)` of the full window rectangle (title bar and borders included), without raising it; `origin` is the window's top-left corner. `screen` on a private desktop, which has no framebuffer: the virtual screen composed from `PrintWindow` captures of the session's windows, bottom of the z-order first, on black. `screen` on an interactive desktop: `BitBlt` of the virtual screen. Coordinates are physical pixels (the capture threads are per-monitor DPI aware for the operation). `sha256` and `allBlack` mean the same as on Linux; GPU-rendered apps can capture all black and are returned flagged, not retried.
- Bounds: a `launch` or `windows` result holds at most 1 000 windows, titles of at most 65 536 characters, and at most 16 MiB of encoded JSON; when a window or a title was cut, the result has `truncated: true` (absent otherwise; clients that do not know the field ignore it). `snapshot`: the walk stops at the first node beyond 20 000 nodes or 128 MiB of tree JSON; the inline `tree` stops at `maxNodes` or 32 MiB; `truncated` is `true` when either the walk or the inline tree was cut. `snapshotFull` answers `TOO_LARGE` when its gzip would exceed 48 MiB of base64. `screenshot`: a PNG whose base64 would exceed 48 MiB (`pngBase64Chars`) is downscaled further, and `scale` reports the scale actually used; after six encodings that do not fit, `TOO_LARGE`.
- `snapshot`: UI Automation control view of every listed window, breadth first, at most 20 000 nodes per walk. Roles use the Linux names (`Button` → `push button`, `Edit` → `text`, `Text` → `label`, `Window` → `frame`, `Pane` → `panel`, …; unknown control types become their lowercase name). States: `enabled`/`sensitive`, `showing`/`visible`, `focusable`, `focused`, `checkable`/`checked`/`indeterminate`, `selected`, `expanded`/`collapsed`, `editable`. `value` comes from the Value or RangeValue pattern. `coverage` counts a window as covered when its tree holds an element that is not a container (`panel`, `frame`, `unknown`), scroll bar, thumb, or part of the title bar UI Automation adds to every standard window: no covered window is `none` (Tk), some is `partial`, all is `full`.
- `wait for text` searches names and values of up to 5 000 nodes, case-sensitive as on Linux.
- `act` by ref: `click` tries the Invoke, Toggle, SelectionItem, and ExpandCollapse patterns in that order (an action still running after 5 s, such as a button that opened a modal dialog, counts as delivered), then a pointer click at the element's centre. `set_value` uses Value or RangeValue (a number) and is `BAD_REQUEST` for read-only elements. `type` and `key` focus the element first.
- `act` by coordinates: `WM_NCHITTEST` decides client or non-client. Client hits go to the deepest visible child window as `WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/`WM_LBUTTONUP` (right and double clicks accordingly) with `SendMessageTimeoutW` (2 s; a timeout counts as delivered). Non-client hits are posted with `PostMessageW`; close, minimize, and maximize buttons become `WM_SYSCOMMAND`. The hit window is made active on the session desktop.
- `key` accepts the Linux key syntax (`ctrl+a BackSpace`, `Return`, `Page_Up`, `F1`–`F24`, punctuation names like `comma`, single characters). Keys are posted as `WM_KEYDOWN`/`WM_KEYUP` to the focused control of the target window; for chords with modifiers the helper sets the modifier state of the target's input queue around the chord (best effort: apps that read raw input or `GetAsyncKeyState` may not see modifiers). `type` posts `WM_CHAR` per UTF-16 unit, line breaks as Return. Without a target, keys go to the window clicked or activated last, else the topmost session window. `scroll` posts wheel messages (120 per step) to the window under the point.
- `stop` leftover kinds: `job` (id: job name), `process` (id: `<pid>:<creation time as FILETIME>`), `desktop` (id: desktop name), `tempdir` (id: path, detail: what could not be deleted). Deletion opens every entry without following reparse points and removes junctions and symlinks as links.

### Session record

`<PI_GUI_RUNTIME_DIR>\session.json` (written atomically, rewritten before every app resumes and at teardown) lets the client audit and sweep after a crash: `version: 1`, `helper` (`pid`, `created`), `tag`, `mode`, `windowStation`, `desktop`, `privateDesktop`, `jobs[]`, `processes[]` (`pid`, `created`, the newest 256), `tmpDir`, `status` (`running`/`stopped`), `leftovers` (after teardown), `updatedAt`. `created` values are process creation times as FILETIME decimal strings; a PID counts as the same process only when its creation time matches. Like every helper output, the record is untrusted input for the client.
