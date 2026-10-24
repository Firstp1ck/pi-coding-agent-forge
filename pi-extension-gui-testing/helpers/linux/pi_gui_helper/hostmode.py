"""Host mode: the helper outside a container (``local-linux``, ``remote-linux``).

Contract (fixed; the clients rely on it)
----------------------------------------

The helper runs in host mode when it starts with ``PI_GUI_HELPER_MODE=host``.
Without the variable, or with ``container``, it runs exactly as in the
``docker-linux`` image. The client sets:

``PI_GUI_HELPER_MODE=host``
    Selects host mode. Any other value than ``host``/``container`` fails startup.
``PI_GUI_WORKSPACE=<abs dir>``
    Default ``cwd`` of ``launch`` and ``exec`` (the project, or its copy).
``PI_GUI_RUNTIME_DIR=<abs dir>``
    Private directory created by the client: a real directory (not a
    symlink), owned by the helper's user, no group/other permission bits
    (mode 0700). The helper creates ``home/``, ``tmp/``, ``xdg/`` (the
    children's ``XDG_RUNTIME_DIR``, holding the private bus socket), and
    ``Xauthority`` in it and removes them on teardown. The client removes
    the directory itself.
``PI_GUI_DISPLAY_LOCK_DIR=<abs dir>``
    Shared lock directory of this user (same ownership rules, no group/other
    write bit). Display numbers are claimed here.
``PI_GUI_ALLOW_EXEC=1`` (optional)
    Allows ``exec``. Default off: ``exec`` answers ``BAD_REQUEST`` because
    ``local-linux`` never runs ``setup``.
``PI_GUI_TESTING_TOKEN``, ``PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS``
    As in container mode.

The client must not pass the desktop's ``DISPLAY``, ``WAYLAND_DISPLAY``,
``WAYLAND_SOCKET``, ``DBUS_SESSION_BUS_ADDRESS``, ``XDG_RUNTIME_DIR``,
``XAUTHORITY``, or ``SESSION_MANAGER``; the helper drops or replaces them anyway.

Startup in host mode:

1. Validate the three directories (failure → stderr diagnostic, exit 1, no READY).
2. Claim a display ``:N`` with ``N`` in 90..599: write the lock record to a
   temp file and ``link()`` it to ``<lock dir>/display-<N>.lock`` (atomic, fails
   when the lock exists; the lock is never empty). Skip ``N`` when
   ``/tmp/.X11-unix/X<N>`` or ``/tmp/.X<N>-lock`` exists. ``:0`` and any display
   in use are never chosen.
3. Start ``Xvfb :N -displayfd <fd> -auth <runtime>/Xauthority -nolisten tcp``
   with a fresh MIT-MAGIC-COOKIE-1 (so other local users cannot connect). If it
   fails, release the lock and try the next free number (5 attempts).
4. Start a private ``dbus-daemon --session`` (what ``dbus-run-session`` runs)
   on ``unix:path=<runtime>/xdg/pi-gui-bus``, then ``at-spi-bus-launcher`` and
   ``openbox`` when installed. Both are optional in host mode, and a failure of
   either degrades instead of failing startup: without AT-SPI, ``snapshot``
   reports ``coverage: "none"`` and ``hello`` omits ``a11y-atspi``; without a
   window manager, windows are the mapped, non-override-redirect root children.
   The client keeps ``<runtime>/xdg/at-spi/bus_599`` within the 107-byte Unix
   socket path limit.
5. Print READY.

Every child (Xvfb, buses, window manager, apps, ``exec``) gets the forced
environment: ``WAYLAND_DISPLAY``, ``WAYLAND_SOCKET``, ``NO_AT_BRIDGE``,
``SESSION_MANAGER`` removed; ``DISPLAY=:N``, ``XAUTHORITY``,
``DBUS_SESSION_BUS_ADDRESS`` (private), ``XDG_RUNTIME_DIR`` (private),
``XDG_SESSION_TYPE=x11``, ``GDK_BACKEND=x11``, ``QT_QPA_PLATFORM=xcb``,
``SDL_VIDEODRIVER=x11``, ``ELECTRON_OZONE_PLATFORM_HINT=x11``,
``QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1``, ``QT_ACCESSIBILITY=1``, a private
``HOME`` with ``XDG_CONFIG_HOME``/``XDG_CACHE_HOME``/``XDG_DATA_HOME``/
``XDG_STATE_HOME`` below it, ``TMPDIR=<runtime>/tmp``, and
``PI_GUI_TAG=<16 hex>``, the session tag. The request's ``env`` cannot
override any of these. ``PATH`` is the client's (no ``/deps`` prefix);
``/deps/venv`` is never created. Chromium/Electron get
``--force-renderer-accessibility`` as in container mode.

Lock record (JSON, ``version: 1``): ``display`` (int), ``helper``
(``"<pid>:<starttime>"``, ``/proc/<pid>/stat`` field 22), ``bootId``,
``tag``, ``runtimeDir``, ``workspace``, ``createdAt`` (ISO 8601 UTC),
``xvfbPid`` (int or null), ``infra`` (``{name: "<pid>:<starttime>"}`` for
``xvfb``, ``dbus``, ``atspi``, ``openbox``). It is rewritten atomically
(temp file + ``rename``) after each infrastructure process starts.

Teardown (``stop``, stdin EOF, signals, heartbeat): kill app and ``exec``
process groups, openbox, AT-SPI, every process of this user whose initial
environment carries ``PI_GUI_TAG=<tag>`` (except the bus and Xvfb), then the
bus and Xvfb, then tagged processes again; remove ``/tmp/.X<N>-lock`` and
``/tmp/.X11-unix/X<N>`` only when that lock names this session's Xvfb and it
is gone; remove the display lock; remove ``home/``, ``tmp/``, ``xdg/``, and
``Xauthority``. Host mode never runs the container-wide process sweep.

A client that finds a lock whose ``helper`` is dead (different boot, PID
gone, or a different start time) may clean up after it the same way: kill
processes tagged with ``tag`` and the ``infra`` entries whose start time
still matches, remove the X files under the same condition, and delete the
lock. Locks of live helpers are never touched.

Probes (client checks; no READY, no protocol): ``helper --probe display``
starts and stops a private Xvfb through the same lock dir and prints one JSON
line; ``helper --probe env`` prints which desktop variables a child would see.
"""

import datetime
import json
import os
import signal
import stat
import struct
import time

MODE_ENV = "PI_GUI_HELPER_MODE"
WORKSPACE_ENV = "PI_GUI_WORKSPACE"
RUNTIME_ENV = "PI_GUI_RUNTIME_DIR"
LOCK_DIR_ENV = "PI_GUI_DISPLAY_LOCK_DIR"
ALLOW_EXEC_ENV = "PI_GUI_ALLOW_EXEC"
TAG_ENV = "PI_GUI_TAG"
# Contract variables never reach a child.
CONTRACT_ENV = (MODE_ENV, WORKSPACE_ENV, RUNTIME_ENV, LOCK_DIR_ENV, ALLOW_EXEC_ENV)
# Variables that would connect a child to the user's desktop session.
DESKTOP_ENV = ("DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS",
               "XDG_RUNTIME_DIR", "XAUTHORITY", "SESSION_MANAGER")
REMOVED_ENV = ("WAYLAND_DISPLAY", "WAYLAND_SOCKET", "NO_AT_BRIDGE", "SESSION_MANAGER")

FIRST_DISPLAY = 90
LAST_DISPLAY = 599
X11_SOCKET_DIR = "/tmp/.X11-unix"
X_LOCK_DIR = "/tmp"
LOCK_PREFIX = "display-"
LOCK_SUFFIX = ".lock"
RECORD_VERSION = 1
DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class HostModeError(Exception):
    """Host-mode setup cannot continue (bad contract input, no free display, ...)."""


def helper_mode(environ):
    """``"container"`` (default) or ``"host"``; raises HostModeError for anything else."""
    value = environ.get(MODE_ENV, "")
    if value in ("", "container"):
        return "container"
    if value == "host":
        return "host"
    raise HostModeError("%s must be 'host' or 'container', not %r" % (MODE_ENV, value))


def mode_name(environ):
    """Like :func:`helper_mode`, but ``"invalid"`` instead of raising."""
    try:
        return helper_mode(environ)
    except HostModeError:
        return "invalid"


def check_private_dir(path, what, forbidden_bits=0o077, uid=None):
    """Require ``path`` to be an absolute real directory owned by ``uid`` without ``forbidden_bits``."""
    uid = os.getuid() if uid is None else uid
    if not path or not os.path.isabs(path):
        raise HostModeError("%s must be an absolute path, not %r" % (what, path))
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise HostModeError("%s %s: %s" % (what, path, exc.strerror or exc)) from None
    if stat.S_ISLNK(info.st_mode):
        raise HostModeError("%s %s is a symlink" % (what, path))
    if not stat.S_ISDIR(info.st_mode):
        raise HostModeError("%s %s is not a directory" % (what, path))
    if info.st_uid != uid:
        raise HostModeError("%s %s is owned by uid %d, not %d" % (what, path, info.st_uid, uid))
    if info.st_mode & forbidden_bits:
        raise HostModeError("%s %s has mode %o; it must not grant %o" % (what, path, stat.S_IMODE(info.st_mode), forbidden_bits))
    return path


class HostConfig:
    """The validated contract input of one host-mode helper."""

    def __init__(self, workspace, runtime_dir, lock_dir, allow_exec):
        self.workspace = workspace
        self.runtime_dir = runtime_dir
        self.lock_dir = lock_dir
        self.allow_exec = allow_exec

    @classmethod
    def from_environ(cls, environ, uid=None):
        workspace = environ.get(WORKSPACE_ENV, "")
        if not workspace or not os.path.isabs(workspace) or not os.path.isdir(workspace):
            raise HostModeError("%s must name an existing absolute directory, not %r" % (WORKSPACE_ENV, workspace))
        runtime_dir = check_private_dir(environ.get(RUNTIME_ENV, ""), RUNTIME_ENV, 0o077, uid)
        lock_dir = check_private_dir(environ.get(LOCK_DIR_ENV, ""), LOCK_DIR_ENV, 0o022, uid)
        return cls(os.path.realpath(workspace), runtime_dir, lock_dir, environ.get(ALLOW_EXEC_ENV) == "1")


# ----- process identity ----------------------------------------------------

def proc_start_time(pid, proc_root="/proc"):
    """Field 22 of ``/proc/<pid>/stat`` as a string, or None when unreadable/gone."""
    try:
        with open(os.path.join(proc_root, str(pid), "stat"), "rb") as handle:
            text = handle.read().decode("utf-8", "replace")
    except OSError:
        return None
    fields = text.rsplit(")", 1)[-1].split()
    value = fields[19] if len(fields) > 19 else None
    return value if value and value.isdigit() else None


def process_id(pid, proc_root="/proc"):
    """``"<pid>:<starttime>"`` or None when the process is gone."""
    start = proc_start_time(pid, proc_root)
    return "%d:%s" % (pid, start) if start else None


def boot_id(proc_root="/proc"):
    try:
        with open(os.path.join(proc_root, "sys", "kernel", "random", "boot_id")) as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def is_alive(pid, start_time, proc_root="/proc"):
    return start_time is not None and proc_start_time(pid, proc_root) == start_time


# ----- display locks -------------------------------------------------------

def lock_path(lock_dir, number):
    return os.path.join(lock_dir, "%s%d%s" % (LOCK_PREFIX, number, LOCK_SUFFIX))


def x_files(number, x11_dir=X11_SOCKET_DIR, x_lock_dir=X_LOCK_DIR):
    """``(socket, lock)`` paths an X server for display ``number`` creates."""
    return os.path.join(x11_dir, "X%d" % number), os.path.join(x_lock_dir, ".X%d-lock" % number)


def display_in_use(number, x11_dir=X11_SOCKET_DIR, x_lock_dir=X_LOCK_DIR):
    return any(os.path.lexists(p) for p in x_files(number, x11_dir, x_lock_dir))


def _write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _temp_name(directory):
    return os.path.join(directory, ".tmp-%d-%s" % (os.getpid(), os.urandom(6).hex()))


def _encode(record):
    return (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")


class DisplayLock:
    """A claimed display number, held as ``<lock dir>/display-<N>.lock``."""

    def __init__(self, lock_dir, number, record):
        self.lock_dir = lock_dir
        self.number = number
        self.path = lock_path(lock_dir, number)
        self.record = record
        self.released = False

    @classmethod
    def claim(cls, lock_dir, record, first=FIRST_DISPLAY, last=LAST_DISPLAY, skip=(),
              x11_dir=X11_SOCKET_DIR, x_lock_dir=X_LOCK_DIR):
        """Atomically claim the lowest free display in ``first..last`` (``skip`` excluded)."""
        for number in range(max(first, 1), last + 1):
            if number in skip or display_in_use(number, x11_dir, x_lock_dir):
                continue
            full = dict(record, display=number)
            tmp = _temp_name(lock_dir)
            _write_private(tmp, _encode(full))
            try:
                os.link(tmp, lock_path(lock_dir, number))
            except FileExistsError:
                continue
            finally:
                os.unlink(tmp)
            # An X server that appeared between the check and the link wins.
            lock = cls(lock_dir, number, full)
            if display_in_use(number, x11_dir, x_lock_dir):
                lock.release()
                continue
            return lock
        raise HostModeError("no free display between :%d and :%d (locks in %s)" % (first, last, lock_dir))

    def update(self, **fields):
        """Rewrites the record atomically with ``fields`` merged in."""
        if self.released:
            return
        self.record = dict(self.record, **fields)
        tmp = _temp_name(self.lock_dir)
        _write_private(tmp, _encode(self.record))
        os.replace(tmp, self.path)

    def release(self):
        self.released = True
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def new_record(tag, runtime_dir, workspace, proc_root="/proc"):
    return {
        "version": RECORD_VERSION,
        "helper": process_id(os.getpid(), proc_root),
        "bootId": boot_id(proc_root),
        "tag": tag,
        "runtimeDir": runtime_dir,
        "workspace": workspace,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "xvfbPid": None,
        "infra": {},
    }


def read_x_lock_pid(path):
    """PID written by the X server into ``/tmp/.X<N>-lock`` (ASCII), or None."""
    try:
        with open(path, "rb") as handle:
            text = handle.read(64).decode("ascii", "replace").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


def remove_x_files(number, xvfb_pid, xvfb_start, uid=None, proc_root="/proc",
                   x11_dir=X11_SOCKET_DIR, x_lock_dir=X_LOCK_DIR):
    """Remove the X socket and lock of ``number`` when they belong to our dead Xvfb.

    Files of any other X server (another PID in the lock, a live process, another
    owner) stay untouched. Returns leftovers.
    """
    uid = os.getuid() if uid is None else uid
    socket_path, xlock = x_files(number, x11_dir, x_lock_dir)
    if not os.path.lexists(xlock) and not os.path.lexists(socket_path):
        return []
    if xvfb_pid is None:
        return []
    pid = read_x_lock_pid(xlock) if os.path.lexists(xlock) else xvfb_pid
    if pid != xvfb_pid:
        return []  # another X server owns :N now
    if is_alive(xvfb_pid, xvfb_start, proc_root):
        return [{"kind": "display", "id": ":%d" % number, "detail": "Xvfb %d still running" % xvfb_pid}]
    leftovers = []
    for path in (xlock, socket_path):
        try:
            if os.lstat(path).st_uid == uid:
                os.unlink(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            leftovers.append({"kind": "display", "id": path, "detail": "remove failed: %s" % exc})
    return leftovers


def write_xauthority(path, number, cookie):
    """Write an Xauthority file with one FamilyWild MIT-MAGIC-COOKIE-1 entry for ``number``."""
    def field(data):
        return struct.pack(">H", len(data)) + data
    entry = struct.pack(">H", 0xFFFF) + field(b"") + field(str(number).encode("ascii")) \
        + field(b"MIT-MAGIC-COOKIE-1") + field(cookie)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    _write_private(path, entry)


# ----- tagged processes ----------------------------------------------------

def tagged_processes(tag, proc_root="/proc", uid=None, exclude=()):
    """PIDs of this user's processes whose initial environment holds ``PI_GUI_TAG=<tag>``."""
    uid = os.getuid() if uid is None else uid
    needle = ("%s=%s" % (TAG_ENV, tag)).encode("ascii")
    found = []
    try:
        names = os.listdir(proc_root)
    except OSError:
        return found
    for name in names:
        if not name.isdigit() or int(name) in exclude:
            continue
        base = os.path.join(proc_root, name)
        try:
            if os.stat(base).st_uid != uid:
                continue
            with open(os.path.join(base, "environ"), "rb") as handle:
                data = handle.read()
        except OSError:
            continue
        if needle in data.split(b"\0"):
            found.append(int(name))
    return found


def kill_tagged(tag, exclude=(), grace=1.5, proc_root="/proc"):
    """SIGTERM, then SIGKILL, every tagged process except ``exclude``. Returns the PIDs still alive."""
    exclude = set(exclude) | {os.getpid()}
    targets = tagged_processes(tag, proc_root, exclude=exclude)
    for sig, wait_s in ((signal.SIGTERM, grace), (signal.SIGKILL, 1.0)):
        if not targets:
            return []
        for pid in targets:
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            # Zombies keep a /proc entry with an empty environ, so they drop out here.
            targets = [p for p in tagged_processes(tag, proc_root, exclude=exclude) if p in targets]
            if not targets:
                return []
            time.sleep(0.05)
    return targets


# ----- environment ---------------------------------------------------------

def strip_env(base, private_prefix):
    """``base`` without helper-private, contract, and desktop variables."""
    env = {}
    for key, value in base.items():
        if key.startswith(private_prefix) or key in CONTRACT_ENV or key in DESKTOP_ENV or key in REMOVED_ENV:
            continue
        if key == TAG_ENV:
            continue
        env[key] = value
    return env


def build_host_env(base, request_env, session_env, private_prefix):
    """Child environment in host mode: the forced block always wins over the request."""
    env = strip_env(base, private_prefix)
    for key, value in (request_env or {}).items():
        env[str(key)] = str(value)
    path = env.get("PATH") or base.get("PATH") or DEFAULT_PATH
    env.update(session_env)
    env["PATH"] = path
    for key in REMOVED_ENV:
        env.pop(key, None)
    for key in CONTRACT_ENV:
        env.pop(key, None)
    for key in [k for k in env if k.startswith(private_prefix)]:
        env.pop(key, None)
    return env


# Keys the env probe reports (values of private paths are reported as-is; nothing secret).
PROBE_KEYS = DESKTOP_ENV + ("NO_AT_BRIDGE", "GDK_BACKEND", "QT_QPA_PLATFORM", "SDL_VIDEODRIVER",
                            "ELECTRON_OZONE_PLATFORM_HINT", "XDG_SESSION_TYPE", "HOME", "TMPDIR",
                            "QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "QT_ACCESSIBILITY", TAG_ENV)
