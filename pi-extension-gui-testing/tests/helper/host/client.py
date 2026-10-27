"""Minimal host-side protocol client that runs the image exactly as production does.

Used by the entrypoint and sample-app tests. It never starts anything on the
host display: the container gets no host socket, bus, or display variable.
"""

import json
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

IMAGE = os.environ.get("PI_GUI_TESTING_IMAGE", "pi-gui-testing-base:dev")
READY_PREFIX = "PI-GUI-TESTING-READY"
SESSION_LABEL = "pi-gui-testing.session"


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


def docker_run_argv(session_dir, token, session_id, network="none", shm_size=None, extra_env=None, mounts=()):
    """The validated production ``docker run`` command line."""
    uid, gid = os.getuid(), os.getgid()
    argv = ["docker", "run", "-i", "--rm"]
    argv += ["--network", network] if network else []
    argv += [
        "--user", "%d:%d" % (uid, gid), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:mode=1777",
        "--tmpfs", "/scratch:uid=%d,gid=%d,mode=0700" % (uid, gid),
        "--tmpfs", "/home/app:uid=%d,gid=%d,mode=0700" % (uid, gid),
        "--tmpfs", "/deps:uid=%d,gid=%d,mode=0755,exec" % (uid, gid),
        "--tmpfs", "/run/user/%d:uid=%d,gid=%d,mode=0700" % (uid, uid, gid),
        "-v", "%s:/etc/passwd:ro" % os.path.join(session_dir, "passwd"),
        "-v", "%s:/etc/group:ro" % os.path.join(session_dir, "group"),
        "-e", "HOME=/home/app", "-e", "XDG_RUNTIME_DIR=/run/user/%d" % uid,
        "-e", "PI_GUI_TESTING_TOKEN=%s" % token,
        "--label", "%s=%s" % (SESSION_LABEL, session_id),
        "--label", "pi-gui-testing.owner=w2test:%d:0:host" % os.getpid(),
    ]
    if shm_size:
        argv += ["--shm-size", shm_size]
    for key, value in (extra_env or {}).items():
        argv += ["-e", "%s=%s" % (key, value)]
    for src, dst, mode in mounts:
        argv += ["-v", "%s:%s:%s" % (src, dst, mode)]
    return argv + [IMAGE]


def write_identity(session_dir):
    uid, gid = os.getuid(), os.getgid()
    with open(os.path.join(session_dir, "passwd"), "w") as handle:
        handle.write("root:x:0:0:root:/root:/usr/sbin/nologin\napp:x:%d:%d:app:/home/app:/bin/sh\n" % (uid, gid))
    with open(os.path.join(session_dir, "group"), "w") as handle:
        handle.write("root:x:0:\napp:x:%d:\n" % gid)


class Helper:
    """One container session. Use as a context manager; ``close()`` always removes the container."""

    def __init__(self, session_id, network="none", shm_size=None, extra_env=None, mounts=(), ready_timeout=10.0):
        self.session_id = session_id
        self.token = secrets.token_hex(16)
        self.session_dir = tempfile.mkdtemp(prefix="w2-session-")
        write_identity(self.session_dir)
        self.argv = docker_run_argv(self.session_dir, self.token, session_id, network, shm_size, extra_env, mounts)
        self.proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.events = []
        self.diagnostics = []
        self.stderr_lines = []
        self._responses = {}
        self._cond = threading.Condition()
        self._next_id = 1
        self._ready = threading.Event()
        self.started = time.monotonic()
        self.ready_after = None
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        if not self._ready.wait(ready_timeout):
            self.close()
            raise RuntimeError("no ready line within %.0f s; stderr: %s" % (ready_timeout, "".join(self.stderr_lines)[-2000:]))
        self.ready_after = time.monotonic() - self.started

    def _read_stdout(self):
        prefix = self.token + " "
        for raw in self._lines(self.proc.stdout):
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line == "%s %s" % (READY_PREFIX, self.token):
                self._ready.set()
                continue
            if not line.startswith(prefix):
                self.diagnostics.append(line)
                continue
            message = json.loads(line[len(prefix):])
            with self._cond:
                if "id" in message:
                    self._responses[message["id"]] = message
                else:
                    self.events.append(message)
                self._cond.notify_all()
        with self._cond:
            self._cond.notify_all()

    @staticmethod
    def _lines(stream):
        """Yield lines until EOF or until ``close()`` closes the pipe under us."""
        while True:
            try:
                raw = stream.readline()
            except (OSError, ValueError):
                return
            if not raw:
                return
            yield raw

    def _read_stderr(self):
        for raw in self._lines(self.proc.stderr):
            self.stderr_lines.append(raw.decode("utf-8", "replace"))

    def send(self, method, params=None):
        with self._cond:
            request_id = self._next_id
            self._next_id += 1
        line = "%s %s\n" % (self.token, json.dumps({"id": request_id, "method": method, "params": params or {}}))
        self.proc.stdin.write(line.encode("utf-8"))
        self.proc.stdin.flush()
        return request_id

    def response(self, request_id, timeout=60.0):
        deadline = time.monotonic() + timeout
        with self._cond:
            while request_id not in self._responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("no response to request %d" % request_id)
                if self.proc.poll() is not None and request_id not in self._responses:
                    self._cond.wait(0.5)
                    if request_id not in self._responses:
                        raise RuntimeError("helper exited (%s) before answering %d" % (self.proc.returncode, request_id))
                self._cond.wait(min(remaining, 0.5))
            return self._responses.pop(request_id)

    def call(self, method, params=None, timeout=60.0):
        message = self.response(self.send(method, params), timeout)
        if not message["ok"]:
            raise HelperError(message["error"]["code"], message["error"]["message"])
        return message["result"]

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass

    def close(self):
        self.close_stdin()
        try:
            self.proc.wait(20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        leftovers = container_ids(self.session_id)
        if leftovers:
            subprocess.run(["docker", "rm", "-f"] + leftovers, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
        shutil.rmtree(self.session_dir, ignore_errors=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def container_ids(session_id):
    out = subprocess.run(["docker", "ps", "-aq", "--filter", "label=%s=%s" % (SESSION_LABEL, session_id)],
                         stdout=subprocess.PIPE, check=False).stdout.decode().split()
    return out


def wait_container_gone(session_id, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not container_ids(session_id):
            return time.monotonic()
        time.sleep(0.25)
    return None
