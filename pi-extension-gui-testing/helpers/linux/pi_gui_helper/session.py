"""Session runtime: private display, buses, window manager, environment, teardown.

Start order (spec §4.1, §4.2): Xvfb on a free display → private
``dbus-daemon --session`` → ``at-spi-bus-launcher`` → ``openbox`` → set
``org.a11y.Status`` ``IsEnabled`` and ``ScreenReaderEnabled``. Nothing is
written to ``/etc``; ``/etc/passwd`` and ``/etc/group`` are mounted by the client.

Teardown reverses that: app and setup process groups, openbox, the AT-SPI
launcher, then (inside a container only) every remaining process except PID 1,
then the session bus and Xvfb.
"""

import os
import select
import subprocess
import sys
import tempfile
import threading
import time

from . import procs
from .dispatch import ProtocolError, diag

SCREEN = "1280x800x24"
VENV_DIR = "/deps/venv"
DEFAULT_HOME = "/home/app"
_STEP_TIMEOUT_S = 6.0

_REMOVED_ENV = ("WAYLAND_DISPLAY", "NO_AT_BRIDGE")
# Helper-private variables never reach apps or setup commands.
_PRIVATE_ENV_PREFIX = "PI_GUI_TESTING_"

_ATSPI_LAUNCHER_CANDIDATES = (
    "/usr/libexec/at-spi-bus-launcher",
    "/usr/lib/at-spi2-core/at-spi-bus-launcher",
    "/usr/lib/at-spi-bus-launcher",
)


class StartupError(Exception):
    pass


def _read_fd_line(fd, timeout_s, what):
    """Read one line from ``fd`` within ``timeout_s``; raise StartupError otherwise."""
    deadline = time.monotonic() + timeout_s
    data = b""
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StartupError("%s did not report readiness within %.0f s" % (what, timeout_s))
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            raise StartupError("%s exited before reporting readiness" % what)
        data += chunk
    return data.split(b"\n", 1)[0].decode("utf-8", "replace").strip()


def build_env(base, request_env, session_env):
    """Environment for ``exec`` and ``launch`` (docs/protocol.md "/deps and setup").

    ``base`` is the helper's own environment, ``request_env`` the client's
    ``env``, and ``session_env`` the fixed block (DISPLAY, bus, HOME, ...).
    The fixed block wins over the request; ``PATH`` is prefixed rather than
    replaced so a request may still add its own entries.
    """
    env = {k: v for k, v in base.items() if not k.startswith(_PRIVATE_ENV_PREFIX)}
    for key, value in (request_env or {}).items():
        env[str(key)] = str(value)
    path = env.get("PATH") or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    env.update(session_env)
    env["PATH"] = "%s/bin:/deps/node/bin:%s" % (VENV_DIR, path)
    for key in _REMOVED_ENV:
        env.pop(key, None)
    return env


def venv_argv(python, venv_dir):
    """Command that creates the app venv without importing anything from the cwd."""
    return [python, "-I", "-m", "venv", "--system-site-packages", venv_dir]


_VENV_ENV_KEYS = ("LANG", "LC_ALL", "LC_CTYPE", "TZ")


def venv_env(base):
    """Minimal environment for venv creation: no token, no ``PYTHON*``, fixed PATH."""
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent"}
    for key in _VENV_ENV_KEYS:
        if key in base:
            env[key] = base[key]
    return env


def in_container():
    """True when the helper is PID 1's child in a container PID namespace.

    The final teardown sweep kills every other visible process; that is only
    safe when the PID namespace belongs to this session.
    """
    return os.getppid() == 1 and os.path.exists("/.dockerenv")


class Session:
    """Owns the private display stack and every process the session starts."""

    def __init__(self, writer, environ=None):
        self.writer = writer
        self.environ = dict(os.environ if environ is None else environ)
        self.display = None
        self.bus_address = None
        self.runtime_dir = None
        self._infra = {}
        self._children = []
        self._lock = threading.Lock()
        self._torn_down = False
        self._venv_ready = False
        self.timings = {}

    # ----- startup -------------------------------------------------------

    def _spawn(self, name, argv, env, pass_fds=()):
        proc = subprocess.Popen(
            argv,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=sys.stderr.fileno(),
            stderr=sys.stderr.fileno(),
            pass_fds=pass_fds,
            start_new_session=True,
            close_fds=True,
        )
        self._infra[name] = proc
        return proc

    def _runtime_dir(self):
        wanted = self.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
        try:
            os.makedirs(wanted, mode=0o700, exist_ok=True)
            if os.access(wanted, os.W_OK):
                return wanted
        except OSError:
            pass
        # Without the client's tmpfs (e.g. a diagnostic run) fall back to /tmp.
        return tempfile.mkdtemp(prefix="pi-gui-runtime-")

    def start(self):
        """Bring up Xvfb, the bus, AT-SPI, and openbox. Raises StartupError."""
        t0 = time.monotonic()
        self.runtime_dir = self._runtime_dir()
        home = self.environ.get("HOME") or DEFAULT_HOME
        base = {k: v for k, v in self.environ.items() if not k.startswith(_PRIVATE_ENV_PREFIX)}
        for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS") + _REMOVED_ENV:
            base.pop(key, None)
        base["XDG_RUNTIME_DIR"] = self.runtime_dir
        base["HOME"] = home

        read_fd, write_fd = os.pipe()
        try:
            self._spawn("xvfb", ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", SCREEN,
                                 "-nolisten", "tcp", "-noreset", "+extension", "XTEST"], base, (write_fd,))
            os.close(write_fd)
            number = _read_fd_line(read_fd, _STEP_TIMEOUT_S, "Xvfb")
        finally:
            os.close(read_fd)
        if not number.isdigit():
            raise StartupError("Xvfb reported display %r" % number)
        self.display = ":" + number
        self.timings["xvfb"] = time.monotonic() - t0

        socket_path = os.path.join(self.runtime_dir, "pi-gui-bus")
        read_fd, write_fd = os.pipe()
        try:
            self._spawn("dbus", ["dbus-daemon", "--session", "--nofork", "--nopidfile",
                                 "--address=unix:path=%s" % socket_path,
                                 "--print-address=%d" % write_fd], base, (write_fd,))
            os.close(write_fd)
            self.bus_address = _read_fd_line(read_fd, _STEP_TIMEOUT_S, "dbus-daemon")
        finally:
            os.close(read_fd)
        self.timings["dbus"] = time.monotonic() - t0

        os.environ["DISPLAY"] = self.display
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = self.bus_address
        os.environ["XDG_RUNTIME_DIR"] = self.runtime_dir
        os.environ["HOME"] = home
        for key in _REMOVED_ENV:
            os.environ.pop(key, None)
        infra_env = dict(base, DISPLAY=self.display, DBUS_SESSION_BUS_ADDRESS=self.bus_address)

        launcher = next((p for p in _ATSPI_LAUNCHER_CANDIDATES if os.path.exists(p)), None)
        if launcher is None:
            raise StartupError("at-spi-bus-launcher not found")
        self._spawn("atspi", [launcher, "--launch-immediately"], infra_env)
        self._enable_a11y()
        self.timings["atspi"] = time.monotonic() - t0

        self._spawn("openbox", ["openbox", "--sm-disable"], infra_env)
        self._wait_for_wm(infra_env)
        self.timings["openbox"] = time.monotonic() - t0

    def _enable_a11y(self):
        from gi.repository import Gio, GLib

        conn = Gio.DBusConnection.new_for_address_sync(
            self.bus_address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None,
            None,
        )
        deadline = time.monotonic() + _STEP_TIMEOUT_S
        while True:
            owned = conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                   "NameHasOwner", GLib.Variant("(s)", ("org.a11y.Bus",)),
                                   GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
            if owned:
                break
            if time.monotonic() > deadline:
                raise StartupError("org.a11y.Bus did not appear on the private bus")
            time.sleep(0.05)
        for prop in ("IsEnabled", "ScreenReaderEnabled"):
            conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                           GLib.Variant("(ssv)", ("org.a11y.Status", prop, GLib.Variant("b", True))),
                           None, Gio.DBusCallFlags.NONE, 2000, None)
        # Make sure the accessibility bus itself is up before any app starts,
        # so toolkits find it on their first lookup.
        conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
                       GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 4000, None)
        conn.close_sync(None)

    def _wait_for_wm(self, env):
        deadline = time.monotonic() + _STEP_TIMEOUT_S
        while time.monotonic() < deadline:
            proc = subprocess.run(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=3)
            if b"window id" in proc.stdout:
                return
            if self._infra["openbox"].poll() is not None:
                raise StartupError("openbox exited during startup")
            time.sleep(0.05)
        raise StartupError("openbox did not become ready")

    # ----- environment ---------------------------------------------------

    def session_env(self):
        return {
            "VIRTUAL_ENV": VENV_DIR,
            "npm_config_prefix": "/deps/node",
            "PYTHONUSERBASE": "/deps/python",
            "HOME": self.environ.get("HOME") or DEFAULT_HOME,
            "XDG_RUNTIME_DIR": self.runtime_dir,
            "DISPLAY": self.display,
            "DBUS_SESSION_BUS_ADDRESS": self.bus_address,
            "GDK_BACKEND": "x11",
            "QT_QPA_PLATFORM": "xcb",
            "SDL_VIDEODRIVER": "x11",
            "ELECTRON_OZONE_PLATFORM_HINT": "x11",
            "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1",
            "QT_ACCESSIBILITY": "1",
        }

    def child_env(self, request_env):
        return build_env(self.environ, request_env, self.session_env())

    def tool_env(self):
        """Environment for the helper's own X tools (xdotool, xprop, import)."""
        return build_env(self.environ, {}, self.session_env())

    def ensure_venv(self):
        """Create ``/deps/venv`` with ``--system-site-packages`` once (before the first exec).

        Runs before any project code, often with ``/workspace`` holding
        untrusted files, so the interpreter is isolated (``-I``: no cwd or
        script dir on ``sys.path``, no ``PYTHON*`` variables, no user site),
        starts in ``/``, and gets a minimal environment without the session
        token.
        """
        if self._venv_ready or os.path.exists(os.path.join(VENV_DIR, "bin", "python")):
            self._venv_ready = True
            return
        proc = subprocess.run(venv_argv(sys.executable, VENV_DIR), cwd="/", env=venv_env(self.environ),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=120, check=False)
        if proc.returncode != 0:
            raise ProtocolError("INTERNAL", "creating %s failed: %s" % (
                VENV_DIR, proc.stdout.decode("utf-8", "replace").strip()[-500:]))
        self._venv_ready = True

    # ----- children ------------------------------------------------------

    def spawn_child(self, argv, request_env, cwd, source):
        with self._lock:
            if self._torn_down:
                raise ProtocolError("CANCELLED", "session is shutting down")
            child = procs.Child(argv, self.child_env(request_env), cwd, source, self.writer)
            self._children.append(child)
            return child

    def forget_child(self, child):
        with self._lock:
            if child in self._children:
                self._children.remove(child)

    # ----- teardown ------------------------------------------------------

    def teardown(self):
        """Stop everything this session started. Idempotent; returns leftovers."""
        with self._lock:
            already = self._torn_down
            self._torn_down = True
            children = list(self._children)
            self._children = []
        if not already:
            for child in children:
                child.kill_group(grace=2.0)
            for name in ("openbox", "atspi"):
                self._stop_infra(name)
            if in_container():
                self._sweep(keep={self._pid("dbus"), self._pid("xvfb")})
            for name in ("dbus", "xvfb"):
                self._stop_infra(name)
            if in_container():
                self._sweep(keep=set())
        return self.leftovers()

    def _pid(self, name):
        proc = self._infra.get(name)
        return proc.pid if proc is not None else None

    def _stop_infra(self, name):
        proc = self._infra.get(name)
        if proc is not None and proc.poll() is None:
            procs.kill_group(proc.pid, grace=1.5, popen=proc)

    def _sweep(self, keep):
        import signal

        targets = [pid for pid, _ in procs.other_processes() if pid not in keep]
        for sig, wait_s in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 0.5)):
            for pid in targets:
                try:
                    os.kill(pid, sig)
                except (ProcessLookupError, PermissionError):
                    pass
            deadline = time.monotonic() + wait_s
            while time.monotonic() < deadline:
                alive = {pid for pid, _ in procs.other_processes()}
                targets = [pid for pid in targets if pid in alive]
                if not targets:
                    return
                time.sleep(0.05)

    def leftovers(self):
        found = []
        for name, proc in self._infra.items():
            if proc.poll() is None:
                found.append({"kind": "process", "id": str(proc.pid), "detail": name})
        known = {int(item["id"]) for item in found}
        if in_container():
            for pid, cmdline in procs.other_processes():
                if pid not in known:
                    found.append({"kind": "process", "id": str(pid), "detail": cmdline[:200]})
        return found
