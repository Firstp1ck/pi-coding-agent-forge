"""Protocol method handlers (docs/protocol.md "Methods").

Each handler takes ``(ctx, params)`` and returns the result object or raises
``ProtocolError``. Handlers run on the sequential queue, so they may keep
per-session state (latest snapshot, latest capture) without locking.
"""

import os
import platform
import time

from . import HELPER_VERSION, PROTOCOL_VERSION, capture, deps, inputs, procs, x11
from .dispatch import ProtocolError

ACTIONS = ("click", "double_click", "right_click", "type", "key", "scroll", "set_value")
WAIT_KINDS = ("window", "text", "ref", "idle")
CAPABILITIES = ["launch", "wait", "snapshot", "snapshotFull", "screenshot", "act", "windows", "exec", "deps", "a11y-atspi"]

DEFAULT_CWD = "/workspace"
LAUNCH_WINDOW_WAIT_S = 20.0
# A single-instance app hands off and exits fast; a window from a slow app may
# still arrive shortly after its launcher process exits.
HANDOFF_GRACE_S = 2.0
DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000
DEFAULT_WAIT_TIMEOUT_MS = 10000
MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000
DEFAULT_MAX_NODES = 500
_POLL_S = 0.25
_IDLE_STABLE_SAMPLES = 3

_CHROMIUM_NAMES = {"electron", "chromium", "chromium-browser", "chrome", "google-chrome", "google-chrome-stable"}
_A11Y_FLAG = "--force-renderer-accessibility"


def _str(params, key, required=False, default=None):
    value = params.get(key, default)
    if value is None:
        if required:
            raise ProtocolError("BAD_REQUEST", "%s is required" % key)
        return default
    if not isinstance(value, str):
        raise ProtocolError("BAD_REQUEST", "%s must be a string" % key)
    return value


def _int(params, key, default=None, minimum=None, maximum=None):
    value = params.get(key, default)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError("BAD_REQUEST", "%s must be a number" % key)
    value = int(value)
    if minimum is not None and value < minimum:
        raise ProtocolError("BAD_REQUEST", "%s must be at least %d" % (key, minimum))
    if maximum is not None and value > maximum:
        value = maximum
    return value


def _env(params):
    env = params.get("env") or {}
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ProtocolError("BAD_REQUEST", "env must be an object of strings")
    return env


def _cwd(params, default=DEFAULT_CWD):
    cwd = _str(params, "cwd", default=default) or default
    if not os.path.isdir(cwd):
        raise ProtocolError("NOT_FOUND", "cwd %s does not exist in the session" % cwd)
    return cwd


def _os_release():
    """``ID VERSION_ID`` from ``/etc/os-release`` (empty when unreadable)."""
    values = {}
    try:
        with open("/etc/os-release", encoding="utf-8", errors="replace") as handle:
            for line in handle.read(16384).splitlines():
                key, sep, value = line.partition("=")
                if sep and key in ("ID", "VERSION_ID"):
                    values[key] = value.strip().strip('"')[:64]
    except OSError:
        pass
    return " ".join(v for v in (values.get("ID"), values.get("VERSION_ID")) if v)


def platform_fingerprint():
    """What installed dependencies depend on: OS, machine, libc, distribution, Python (bounded)."""
    libc = " ".join(v for v in platform.libc_ver() if v)
    parts = ["%s %s" % (platform.system(), platform.machine()), libc, _os_release(), "python %s" % platform.python_version()]
    return "; ".join(p for p in parts if p)[:256]


def is_chromium_like(cmd, args):
    """True for Electron/Chromium binaries, including ``npx electron`` / ``node …/electron``."""
    if os.path.basename(cmd) in _CHROMIUM_NAMES:
        return True
    if os.path.basename(cmd) in ("npx", "node") and args:
        return os.path.basename(args[0]) in _CHROMIUM_NAMES or args[0].endswith("/electron/cli.js")
    return False


def launch_args(cmd, args):
    """Arguments for ``launch``: Chromium/Electron get ``--force-renderer-accessibility`` once."""
    args = list(args)
    if is_chromium_like(cmd, args) and _A11Y_FLAG not in args:
        args.append(_A11Y_FLAG)
    return args


class Handlers:
    """Binds protocol methods to one ``Session``."""

    def __init__(self, session, request_exit):
        self.session = session
        self._request_exit = request_exit
        self._snapshots = None
        self._capture_counter = 0
        self._capture = None
        self._deps = deps.Transfers(
            getattr(session, "deps_root", lambda: None),
            tmp_dir=getattr(session, "transfer_tmp_dir", None),
            on_unpacked=getattr(session, "deps_unpacked", None),
        )

    @property
    def env(self):
        return self.session.tool_env()

    def table(self):
        return {
            "hello": self.hello,
            "ping": self.ping,
            "launch": self.launch,
            "wait": self.wait,
            "snapshot": self.snapshot,
            "snapshotFull": self.snapshot_full,
            "screenshot": self.screenshot,
            "act": self.act,
            "windows": self.windows,
            "exec": self.exec_,
            "depsPack": self._deps.pack,
            "depsRead": self._deps.read,
            "depsReceive": self._deps.receive,
            "depsWrite": self._deps.write,
            "depsUnpack": self._deps.unpack,
            "depsDiscard": self._deps.discard,
            "stop": self.stop,
        }

    def _store(self):
        if self._snapshots is None:
            if not getattr(self.session, "a11y_available", True):
                self._snapshots = NoA11yStore()
                return self._snapshots
            from . import a11y  # needs the private bus in the environment first

            self._snapshots = a11y.SnapshotStore()
        return self._snapshots

    @property
    def _default_cwd(self):
        return getattr(self.session, "default_cwd", DEFAULT_CWD)

    # ----- session -------------------------------------------------------

    def hello(self, ctx, params):
        protocol = params.get("protocol")
        if protocol != PROTOCOL_VERSION:
            ctx.after = lambda: self._request_exit("protocol mismatch")
            raise ProtocolError("PROTOCOL_MISMATCH", "helper speaks protocol %d, client sent %r" % (PROTOCOL_VERSION, protocol))
        return {
            "protocol": PROTOCOL_VERSION,
            "helperVersion": HELPER_VERSION,
            "os": "linux",
            "arch": platform.machine(),
            "capabilities": [c for c in CAPABILITIES if self._has_capability(c)],
            "platform": platform_fingerprint(),
        }

    def _has_capability(self, name):
        if name == "a11y-atspi":
            return getattr(self.session, "a11y_available", True)
        if name == "deps":
            return bool(getattr(self.session, "deps_root", lambda: None)())
        return True

    def ping(self, ctx, params):
        return {"ok": True}

    def stop(self, ctx, params):
        self._deps.close()
        leftovers = self.session.teardown()
        ctx.after = lambda: self._request_exit("stop")
        return {"ok": not leftovers, "leftovers": leftovers}

    # ----- processes -----------------------------------------------------

    def exec_(self, ctx, params):
        host = getattr(self.session, "host", None)
        if host is not None and not host.allow_exec:
            raise ProtocolError("BAD_REQUEST", "exec is disabled in host mode: this backend never runs setup commands "
                                "(the client did not set PI_GUI_ALLOW_EXEC=1)")
        cmd = _str(params, "cmd", required=True)
        timeout_ms = _int(params, "timeoutMs", default=DEFAULT_EXEC_TIMEOUT_MS, minimum=1)
        env = _env(params)
        cwd = _cwd(params, self._default_cwd)
        self.session.ensure_venv()
        start = time.monotonic()
        child = self.session.spawn_child(["sh", "-c", cmd], env, cwd, "setup")
        try:
            deadline = start + timeout_ms / 1000.0
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    child.kill_group()
                    child.drain()
                    raise ProtocolError("TIMEOUT", "setup command exceeded %d ms" % timeout_ms)
                try:
                    ctx.sleep(0.05)
                except ProtocolError:
                    child.kill_group()
                    child.drain()
                    raise
            # The shell may have left background jobs in its group; they must
            # not outlive the setup step.
            child.kill_group(grace=0.5)
            child.drain()
        finally:
            self.session.forget_child(child)
        return {"exitCode": procs.exit_code(child.popen.returncode), "elapsedMs": int((time.monotonic() - start) * 1000)}

    def launch(self, ctx, params):
        cmd = _str(params, "cmd", required=True)
        args = params.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            raise ProtocolError("BAD_REQUEST", "args must be an array of strings")
        env = _env(params)
        cwd = _cwd(params, self._default_cwd)
        try:
            self.session.ensure_venv()
        except ProtocolError:
            pass  # launch still works with system Python; exec reports venv failures
        before = set(x11.client_window_ids(self.env))
        try:
            child = self.session.spawn_child([cmd] + launch_args(cmd, args), env, cwd, "app")
        except FileNotFoundError:
            raise ProtocolError("NOT_FOUND", "command not found: %s" % cmd) from None
        except PermissionError:
            raise ProtocolError("BAD_REQUEST", "command is not executable: %s" % cmd) from None
        deadline = time.monotonic() + LAUNCH_WINDOW_WAIT_S
        exited_at = None
        while time.monotonic() < deadline:
            new = [xid for xid in x11.client_window_ids(self.env) if xid not in before]
            windows = [w for w in (x11.window_info(xid, self.env) for xid in new) if w is not None]
            if windows:
                return {"pid": child.pid, "windows": windows}
            if child.poll() is not None:
                if exited_at is None:
                    exited_at = time.monotonic()
                elif time.monotonic() - exited_at >= HANDOFF_GRACE_S:
                    code = procs.exit_code(child.popen.returncode)
                    child.drain()
                    self.session.forget_child(child)
                    if code == 0:
                        raise ProtocolError("HANDOFF", "app exited without opening a window; it probably handed off to another instance")
                    raise ProtocolError("INTERNAL", "app exited with code %d before opening a window; output tail:\n%s"
                                        % (code, child.output_tail(1000)))
            ctx.sleep(0.1)
        # Still running without a window: report it and let the client wait.
        return {"pid": child.pid, "windows": []}

    # ----- inspection ----------------------------------------------------

    def windows(self, ctx, params):
        return {"windows": x11.list_windows(self.env)}

    def snapshot(self, ctx, params):
        max_nodes = _int(params, "maxNodes", default=DEFAULT_MAX_NODES, minimum=0)
        return self._store().take(max_nodes, x11.list_windows(self.env), check=ctx.check)

    def snapshot_full(self, ctx, params):
        return self._store().full(_str(params, "snapshotId", required=True))

    def _target_rect(self, ref):
        """Screen rectangle for a window ref or snapshot ref."""
        xid = x11.parse_window_ref(ref)
        if xid is not None:
            info = x11.window_info(xid, self.env)
            if info is None:
                raise ProtocolError("NOT_FOUND", "window %s is gone or not visible" % ref)
            return info["bounds"]
        acc, _, offset = self._store().resolve(ref)  # NOT_FOUND first on a host without AT-SPI
        from . import a11y

        bounds = a11y.live_bounds(acc, offset)
        if bounds is None:
            raise ProtocolError("NOT_FOUND", "element %s has no on-screen bounds" % ref)
        return bounds

    def screenshot(self, ctx, params):
        ref = _str(params, "window")
        max_edge = _int(params, "maxEdge", default=capture.DEFAULT_MAX_EDGE, minimum=16)
        env = self.env
        screen_w, screen_h = x11.screen_size(env)
        rgb = capture.grab_root_rgb(env, screen_w, screen_h)
        rect = {"x": 0, "y": 0, "width": screen_w, "height": screen_h}
        target = "screen"
        if ref:
            rect = capture.clip_bounds(self._target_rect(ref), screen_w, screen_h)
            if rect is None:
                raise ProtocolError("NOT_FOUND", "%s is entirely off screen" % ref)
            rgb = capture.crop_rgb(rgb, screen_w, rect)
            target = ref
        result = capture.build_capture(rgb, rect["width"], rect["height"], max_edge, env)
        self._capture_counter += 1
        capture_id = "c%d" % self._capture_counter
        self._capture = {"id": capture_id, "origin": {"x": rect["x"], "y": rect["y"]},
                         "width": rect["width"], "height": rect["height"]}
        result.update({"captureId": capture_id, "target": target, "origin": dict(self._capture["origin"])})
        return result

    # ----- actions -------------------------------------------------------

    def _capture_point(self, params):
        capture_id = _str(params, "captureId")
        if self._capture is None or capture_id != self._capture["id"]:
            raise ProtocolError("STALE_REF", "stale captureId, take a new screenshot")
        x, y = params.get("x"), params.get("y")
        for value in (x, y):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ProtocolError("BAD_REQUEST", "x and y must be numbers")
        if not (0 <= x < self._capture["width"] and 0 <= y < self._capture["height"]):
            raise ProtocolError("BAD_REQUEST", "x,y outside the %dx%d capture" % (self._capture["width"], self._capture["height"]))
        return self._capture["origin"]["x"] + int(x), self._capture["origin"]["y"] + int(y)

    def act(self, ctx, params):
        action = _str(params, "action", required=True)
        if action not in ACTIONS:
            raise ProtocolError("BAD_REQUEST", "unknown action %r" % action)
        text = _str(params, "text", default="")
        ref = _str(params, "ref")
        env = self.env
        if ref is None and params.get("captureId") is not None:
            point = self._capture_point(params)
            return self._act_at(action, point, text, env)
        if ref is None:
            if action in ("type", "key"):
                return self._keyboard(action, text, env)
            raise ProtocolError("BAD_REQUEST", "act needs ref, or captureId with x and y")
        xid = x11.parse_window_ref(ref)
        if xid is not None:
            bounds = self._target_rect(ref)
            x11.activate(xid, env)
            return self._act_at(action, _center(bounds), text, env)
        return self._act_element(action, ref, text, env)

    def _keyboard(self, action, text, env):
        if action == "type":
            inputs.type_text(text, env)
        else:
            inputs.key(text, env)
        return {"ok": True}

    def _act_at(self, action, point, text, env):
        if action in ("click", "double_click", "right_click"):
            inputs.pointer(action, point[0], point[1], env)
        elif action in ("type", "key"):
            inputs.pointer("click", point[0], point[1], env)
            self._keyboard(action, text, env)
        elif action == "scroll":
            inputs.move(point[0], point[1], env)
            inputs.scroll(text, env)
        else:
            raise ProtocolError("BAD_REQUEST", "set_value needs an element ref, not coordinates")
        return {"ok": True}

    def _act_element(self, action, ref, text, env):
        acc, _, offset = self._store().resolve(ref)
        from . import a11y

        bounds = a11y.live_bounds(acc, offset)
        point = _center(bounds) if bounds is not None else None
        if action == "set_value":
            a11y.set_value(acc, text)
            return {"ok": True}
        if action == "click" and a11y.do_named_action(acc, ("click", "press", "activate", "toggle", "jump", "open")):
            return {"ok": True}
        if action in ("type", "key"):
            if not a11y.grab_focus(acc) and point is not None:
                inputs.pointer("click", point[0], point[1], env)
            return self._keyboard(action, text, env)
        if point is None:
            raise ProtocolError("NOT_FOUND", "element %s has no usable action and no on-screen bounds" % ref)
        return self._act_at(action, point, text, env)

    # ----- waiting -------------------------------------------------------

    def wait(self, ctx, params):
        kind = _str(params, "for", required=True)
        if kind not in WAIT_KINDS:
            raise ProtocolError("BAD_REQUEST", "for must be one of %s" % ", ".join(WAIT_KINDS))
        value = _str(params, "value")
        if kind in ("text", "ref") and not value:
            raise ProtocolError("BAD_REQUEST", "wait for %s needs value" % kind)
        timeout_ms = _int(params, "timeoutMs", default=DEFAULT_WAIT_TIMEOUT_MS, minimum=0, maximum=MAX_WAIT_TIMEOUT_MS)
        start = time.monotonic()
        deadline = start + timeout_ms / 1000.0
        probe = self._wait_probe(kind, value, ctx)
        while True:
            if probe():
                return {"matched": True, "elapsedMs": int((time.monotonic() - start) * 1000)}
            if time.monotonic() >= deadline:
                return {"matched": False, "elapsedMs": int((time.monotonic() - start) * 1000)}
            ctx.sleep(min(_POLL_S, max(0.0, deadline - time.monotonic())))

    def _wait_probe(self, kind, value, ctx):
        env = self.env
        if kind == "window":
            def window_probe():
                for info in x11.list_windows(env):
                    if not value or value == info["ref"] or value.lower() in info["title"].lower():
                        return True
                return False
            return window_probe
        if kind == "text":
            if not getattr(self.session, "a11y_available", True):
                return lambda: False
            from . import a11y

            return lambda: a11y.find_text(value, check=ctx.check)
        if kind == "ref":
            store = self._store()

            def ref_probe():
                if x11.parse_window_ref(value) is not None:
                    return x11.window_info(x11.parse_window_ref(value), env) is not None
                acc, _, offset = store.resolve(value)
                from . import a11y

                states = a11y.describe(acc, offset)["states"]
                return "showing" in states
            return ref_probe
        hashes = []

        def idle_probe():
            import hashlib

            width, height = x11.screen_size(env)
            hashes.append(hashlib.sha256(capture.grab_root_rgb(env, width, height)).digest())
            recent = hashes[-_IDLE_STABLE_SAMPLES:]
            return len(recent) == _IDLE_STABLE_SAMPLES and len(set(recent)) == 1
        return idle_probe


class NoA11yStore:
    """Snapshots on a host without AT-SPI: always ``coverage: "none"`` and no nodes."""

    def __init__(self):
        self._counter = 0
        self._latest = None

    def take(self, max_nodes, windows, check=None):
        self._counter += 1
        self._latest = "s%d" % self._counter
        return {"snapshotId": self._latest, "coverage": "none", "tree": [], "truncated": False}

    def full(self, snapshot_id):
        import base64
        import gzip

        if snapshot_id != self._latest:
            raise ProtocolError("STALE_REF", "unknown or stale snapshotId %r, take a new snapshot" % snapshot_id)
        return {"tree_gz_base64": base64.b64encode(gzip.compress(b"[]", mtime=0)).decode("ascii")}

    def resolve(self, ref):
        raise ProtocolError("NOT_FOUND", "no accessibility tree on this host (AT-SPI is not installed); use screenshots and coordinates")


def _center(bounds):
    return bounds["x"] + bounds["width"] // 2, bounds["y"] + bounds["height"] // 2
