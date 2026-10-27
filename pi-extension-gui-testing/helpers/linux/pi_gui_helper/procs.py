"""Child process management: app/setup processes, output pumps, and kills.

Every child runs in its own session (process group) so teardown can signal
the whole tree it spawned with one ``killpg``. App and setup output is never
inherited onto the helper's stdout; pumps forward it as ``log`` events.
"""

import codecs
import os
import signal
import subprocess
import threading
import time


_TAIL_CHARS = 2000


def _pump(fd, stream, source, writer, tail):
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    try:
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                writer.log(stream, source, text)
                tail.append(text)
                while len(tail) > 1 and sum(len(t) for t in tail) > _TAIL_CHARS:
                    tail.pop(0)
        tail = decoder.decode(b"", final=True)
        if tail:
            writer.log(stream, source, tail)
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


class Child:
    """A spawned process group whose stdout/stderr become ``log`` events."""

    def __init__(self, argv, env, cwd, source, writer):
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        try:
            self.popen = subprocess.Popen(
                argv,
                env=env,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=out_w,
                stderr=err_w,
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            for fd in (out_r, out_w, err_r, err_w):
                os.close(fd)
            raise
        os.close(out_w)
        os.close(err_w)
        self.pid = self.popen.pid
        self.started = time.monotonic()
        self._tail = []
        self._pumps = [
            threading.Thread(target=_pump, args=(out_r, "stdout", source, writer, self._tail), daemon=True),
            threading.Thread(target=_pump, args=(err_r, "stderr", source, writer, self._tail), daemon=True),
        ]
        for pump in self._pumps:
            pump.start()

    def poll(self):
        return self.popen.poll()

    def output_tail(self, limit=_TAIL_CHARS):
        """Last ``limit`` characters of combined output, for error messages."""
        return "".join(self._tail)[-limit:]

    def drain(self, timeout=2.0):
        """Wait briefly for the pumps so the last output precedes the response."""
        deadline = time.monotonic() + timeout
        for pump in self._pumps:
            pump.join(max(0.0, deadline - time.monotonic()))

    def kill_group(self, grace=2.0):
        kill_group(self.pid, grace, self.popen)


def exit_code(returncode):
    """Shell-style exit code: a signal death N maps to 128+N."""
    if returncode is None:
        return None
    if returncode < 0:
        return 128 - returncode
    return returncode


def _read_stat(pid):
    with open("/proc/%d/stat" % pid, "rb") as handle:
        stat = handle.read().decode("utf-8", "replace")
    # Fields after the parenthesised command: state, ppid, pgrp, ...
    return stat.rsplit(")", 1)[1].split()


def group_members(pgid):
    """Live (non-zombie) PIDs in process group ``pgid``."""
    members = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            fields = _read_stat(int(name))
        except (OSError, IndexError):
            continue
        if fields[0] not in ("Z", "X") and int(fields[2]) == pgid:
            members.append(int(name))
    return members


def kill_group(pgid, grace=2.0, popen=None):
    """SIGTERM the process group, then SIGKILL whatever is left after ``grace`` seconds.

    ``popen`` (the group leader, when we spawned it) is polled so it does not
    linger as a zombie that would look alive.
    """
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if popen is not None:
            popen.poll()
        if not group_members(pgid):
            return
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    if popen is not None:
        try:
            popen.wait(timeout=1.0)
        except Exception:  # noqa: BLE001 - best effort during teardown
            pass


def other_processes():
    """List ``(pid, cmdline)`` of every visible process except PID 1 and the helper itself.

    Inside the container this is the session's complete process footprint.
    """
    me = os.getpid()
    found = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid in (1, me):
            continue
        try:
            if _read_stat(pid)[0] in ("Z", "X"):
                continue
            with open("/proc/%d/cmdline" % pid, "rb") as handle:
                cmdline = handle.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
        except (OSError, IndexError):
            continue
        found.append((pid, cmdline))
    return found
