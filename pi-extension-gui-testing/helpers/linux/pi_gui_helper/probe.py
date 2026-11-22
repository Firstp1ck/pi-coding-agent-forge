"""Host-mode probes for client checks: ``helper --probe display|env``.

Each probe prints one JSON object on stdout and exits; there is no READY line
and no protocol. Both use the host-mode contract variables (``hostmode``):

``display``
    Needs ``PI_GUI_DISPLAY_LOCK_DIR`` and ``PI_GUI_RUNTIME_DIR``. Claims a free
    display through the shared lock dir, starts ``Xvfb`` on it with a private
    cookie, waits until it is ready, stops it, and removes the lock, the X
    files, and the cookie. Prints ``{"ok", "display", "xvfb", "elapsedMs"}``
    or ``{"ok": false, "error"}`` (exit 1).
``env``
    Needs the session contract variables (``PI_GUI_HELPER_MODE=host``,
    ``PI_GUI_WORKSPACE``, ``PI_GUI_RUNTIME_DIR``, ``PI_GUI_DISPLAY_LOCK_DIR``). Builds a child environment exactly as ``launch``
    does (with a request that tries to set ``DISPLAY=:0`` and
    ``WAYLAND_DISPLAY``), starts a real child with it, and prints what the
    child saw: ``{"ok": true, "seen": {...}, "expected": {...},
    "tokenPresent", "contractKeys": [...]}``. No display starts.
"""

import json
import os
import shutil
import subprocess
import sys
import time

from . import hostmode
from .session import SCREEN, Session, StartupError, _read_fd_line

_REQUEST_ENV = {"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0", "GDK_BACKEND": "wayland",
                "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent/bus", "XAUTHORITY": "/nonexistent/Xauthority"}
_CHILD = "import json, os, sys; sys.stdout.write(json.dumps(dict(os.environ)))"


def _emit(payload):
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    sys.stdout.flush()


def probe_display(environ):
    started = time.monotonic()
    lock_dir = hostmode.check_private_dir(environ.get(hostmode.LOCK_DIR_ENV, ""), hostmode.LOCK_DIR_ENV, 0o022)
    runtime = hostmode.check_private_dir(environ.get(hostmode.RUNTIME_ENV, ""), hostmode.RUNTIME_ENV, 0o077)
    path = environ.get("PATH") or hostmode.DEFAULT_PATH
    xvfb = shutil.which("Xvfb", path=path)
    if xvfb is None:
        return {"ok": False, "error": "Xvfb not found on PATH"}
    tag = "probe" + os.urandom(6).hex()
    base = hostmode.strip_env(environ, "PI_GUI_TESTING_")
    base.update({"PATH": path, hostmode.TAG_ENV: tag})
    xauth = os.path.join(runtime, "Xauthority")
    lock = hostmode.DisplayLock.claim(lock_dir, hostmode.new_record(tag, runtime, runtime))
    proc = None
    try:
        hostmode.write_xauthority(xauth, lock.number, os.urandom(16))
        read_fd, write_fd = os.pipe()
        try:
            proc = subprocess.Popen([xvfb, ":%d" % lock.number, "-displayfd", str(write_fd), "-auth", xauth,
                                     "-screen", "0", SCREEN, "-nolisten", "tcp", "+extension", "XTEST"],
                                    env=base, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, pass_fds=(write_fd,), start_new_session=True, close_fds=True)
            os.close(write_fd)
            write_fd = None
            lock.update(xvfbPid=proc.pid, infra={"xvfb": hostmode.process_id(proc.pid)})
            number = _read_fd_line(read_fd, 10.0, "Xvfb")
        finally:
            if write_fd is not None:
                os.close(write_fd)
            os.close(read_fd)
        if number != str(lock.number):
            return {"ok": False, "error": "Xvfb reported display %r instead of :%d" % (number, lock.number)}
        return {"ok": True, "display": ":%d" % lock.number, "xvfb": xvfb,
                "elapsedMs": int((time.monotonic() - started) * 1000)}
    except StartupError as exc:
        tail = b""
        if proc is not None and proc.poll() is not None and proc.stderr is not None:
            tail = proc.stderr.read()[-500:]
        return {"ok": False, "error": "%s%s" % (exc, ("; " + tail.decode("utf-8", "replace").strip()) if tail.strip() else "")}
    finally:
        start = None
        if proc is not None:
            start = hostmode.proc_start_time(proc.pid)
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
            if proc.stderr is not None:
                proc.stderr.close()
            hostmode.remove_x_files(lock.number, proc.pid, start)
        lock.release()
        try:
            os.unlink(xauth)
        except FileNotFoundError:
            pass


def probe_env(environ):
    session = Session(writer=None, environ=environ)
    if session.mode != "host":
        return {"ok": False, "error": "%s=host is required" % hostmode.MODE_ENV}
    session.prepare_host()
    try:
        session.display = ":%d" % hostmode.LAST_DISPLAY
        session.bus_address = "unix:path=%s" % os.path.join(session.runtime_dir, "pi-gui-bus")
        env = session.child_env(_REQUEST_ENV)
        proc = subprocess.run([sys.executable, "-I", "-c", _CHILD], env=env, cwd=session.default_cwd,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=20, check=False)
        if proc.returncode != 0:
            return {"ok": False, "error": "probe child exited %d: %s" % (proc.returncode, proc.stderr.decode("utf-8", "replace")[-300:])}
        seen = json.loads(proc.stdout.decode("utf-8"))
        return {
            "ok": True,
            "seen": {k: seen[k] for k in hostmode.PROBE_KEYS if k in seen},
            "expected": {"DISPLAY": session.display, "DBUS_SESSION_BUS_ADDRESS": session.bus_address,
                         "XDG_RUNTIME_DIR": session.runtime_dir, "XAUTHORITY": session.xauthority, "HOME": session.home},
            "tokenPresent": any(k.startswith("PI_GUI_TESTING_") for k in seen),
            "contractKeys": sorted(k for k in seen if k in hostmode.CONTRACT_ENV),
        }
    finally:
        session.teardown()


PROBES = {"display": probe_display, "env": probe_env}


def run(name, environ=None):
    environ = dict(os.environ if environ is None else environ)
    probe = PROBES.get(name)
    if probe is None:
        _emit({"ok": False, "error": "unknown probe %r (known: %s)" % (name, ", ".join(sorted(PROBES)))})
        return 2
    try:
        result = probe(environ)
    except (hostmode.HostModeError, StartupError, OSError) as exc:
        result = {"ok": False, "error": str(exc)}
    _emit(result)
    return 0 if result.get("ok") else 1
