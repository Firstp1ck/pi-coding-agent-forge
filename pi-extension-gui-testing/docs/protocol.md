# Helper protocol (version 1)

Contributor contract between the TypeScript client and the helper. The source of truth for types is [`src/protocol.ts`](../src/protocol.ts); this page explains the same contract for the Python helper. At the end of M1 this content moves into `DEVELOPMENT.md`.

## Process and transport

- `docker-linux`: the image is built from a staged tar context streamed to `docker build -` that contains only the helper files and the GTK 3 smoke app (no buildx needed, no project data). The helper is the container entrypoint, `ENTRYPOINT ["tini", "--", "/opt/pi-gui-testing/helper"]`, with no `CMD`. The client starts it with `docker run -i --rm …` and talks over the container's stdin/stdout. The helper runs on the image's system `python3`.
- The client treats the helper as an opaque executable with stdio. Nothing in the client assumes Python.
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

Error codes: `STALE_REF`, `NOT_FOUND`, `TIMEOUT`, `HANDOFF`, `PROTOCOL_MISMATCH`, `CANCELLED`, `BAD_REQUEST`, `INTERNAL`.

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
| `hello` | `protocol`, `packageVersion` | `protocol`, `helperVersion`, `os`, `arch`, `capabilities[]`. If `protocol` differs from the helper's, answer `PROTOCOL_MISMATCH` and exit. |
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
