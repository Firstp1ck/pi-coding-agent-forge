"""Host mode (local-linux, remote-linux) without Xvfb: contract checks, display locks,
X file cleanup, Xauthority, session tags, the forced child environment, exec gating,
teardown that never sweeps the host, and the probes."""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import hostmode, methods, session
from pi_gui_helper.dispatch import ProtocolError

HELPER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "helpers", "linux", "helper"))
TOKEN = "0123456789abcdef0123456789abcdef"
DESKTOP = {
    "DISPLAY": ":0",
    "WAYLAND_DISPLAY": "wayland-0",
    "WAYLAND_SOCKET": "7",
    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
    "XDG_RUNTIME_DIR": "/run/user/1000",
    "XAUTHORITY": "/home/u/.Xauthority",
    "SESSION_MANAGER": "local/host:@/tmp/.ICE-unix/1",
    "NO_AT_BRIDGE": "1",
}


class Scratch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pi-gui-hostmode-")
        os.chmod(self.tmp, 0o700)
        self.workspace = self.mkdir("workspace", 0o755)
        self.runtime = self.mkdir("runtime", 0o700)
        self.locks = self.mkdir("locks", 0o700)
        self.x11 = self.mkdir("x11", 0o755)
        self.xlock = self.mkdir("xlock", 0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def mkdir(self, name, mode):
        path = os.path.join(self.tmp, name)
        os.mkdir(path)
        os.chmod(path, mode)
        return path

    def host_environ(self, **extra):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
               "PI_GUI_HELPER_MODE": "host", "PI_GUI_WORKSPACE": self.workspace,
               "PI_GUI_RUNTIME_DIR": self.runtime, "PI_GUI_DISPLAY_LOCK_DIR": self.locks,
               "PI_GUI_TESTING_TOKEN": TOKEN}
        env.update(extra)
        return env


class ContractTests(Scratch):
    def test_mode_parsing(self):
        self.assertEqual(hostmode.helper_mode({}), "container")
        self.assertEqual(hostmode.helper_mode({"PI_GUI_HELPER_MODE": "container"}), "container")
        self.assertEqual(hostmode.helper_mode({"PI_GUI_HELPER_MODE": "host"}), "host")
        with self.assertRaises(hostmode.HostModeError):
            hostmode.helper_mode({"PI_GUI_HELPER_MODE": "desktop"})
        self.assertEqual(hostmode.mode_name({"PI_GUI_HELPER_MODE": "desktop"}), "invalid")

    def test_config_requires_private_dirs(self):
        cfg = hostmode.HostConfig.from_environ(self.host_environ())
        self.assertEqual(cfg.workspace, os.path.realpath(self.workspace))
        self.assertFalse(cfg.allow_exec)
        self.assertTrue(hostmode.HostConfig.from_environ(self.host_environ(PI_GUI_ALLOW_EXEC="1")).allow_exec)
        os.chmod(self.runtime, 0o750)
        with self.assertRaisesRegex(hostmode.HostModeError, "must not grant"):
            hostmode.HostConfig.from_environ(self.host_environ())
        os.chmod(self.runtime, 0o700)
        os.chmod(self.locks, 0o777)
        with self.assertRaisesRegex(hostmode.HostModeError, "must not grant"):
            hostmode.HostConfig.from_environ(self.host_environ())
        os.chmod(self.locks, 0o700)
        link = os.path.join(self.tmp, "link")
        os.symlink(self.runtime, link)
        with self.assertRaisesRegex(hostmode.HostModeError, "symlink"):
            hostmode.HostConfig.from_environ(self.host_environ(PI_GUI_RUNTIME_DIR=link))
        with self.assertRaisesRegex(hostmode.HostModeError, "absolute"):
            hostmode.HostConfig.from_environ(self.host_environ(PI_GUI_DISPLAY_LOCK_DIR="relative"))
        with self.assertRaisesRegex(hostmode.HostModeError, "PI_GUI_WORKSPACE"):
            hostmode.HostConfig.from_environ(self.host_environ(PI_GUI_WORKSPACE="/nonexistent/x"))
        with self.assertRaisesRegex(hostmode.HostModeError, "owned by uid"):
            hostmode.check_private_dir(self.runtime, "x", uid=os.getuid() + 1)


class DisplayLockTests(Scratch):
    def claim(self, **kw):
        record = hostmode.new_record("t" * 16, self.runtime, self.workspace)
        return hostmode.DisplayLock.claim(self.locks, record, x11_dir=self.x11, x_lock_dir=self.xlock, **kw)

    def test_claims_from_90_and_skips_used_displays(self):
        open(os.path.join(self.x11, "X90"), "w").close()
        open(os.path.join(self.xlock, ".X91-lock"), "w").close()
        lock = self.claim()
        self.assertEqual(lock.number, 92)
        with open(lock.path) as handle:
            record = json.load(handle)
        self.assertEqual(record["display"], 92)
        self.assertEqual(record["helper"], hostmode.process_id(os.getpid()))
        self.assertEqual(record["version"], 1)
        self.assertEqual(os.stat(lock.path).st_mode & 0o777, 0o600)
        self.assertEqual(self.claim().number, 93)
        lock.update(xvfbPid=1234, infra={"xvfb": "1234:1"})
        with open(lock.path) as handle:
            self.assertEqual(json.load(handle)["xvfbPid"], 1234)
        lock.release()
        lock.release()
        self.assertFalse(os.path.exists(lock.path))
        self.assertEqual([n for n in os.listdir(self.locks) if n.startswith(".tmp")], [])

    def test_concurrent_claims_never_share_a_display(self):
        numbers, errors = [], []

        def worker():
            try:
                numbers.append(self.claim().number)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=worker) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(sorted(numbers), list(range(90, 102)))

    def test_no_free_display(self):
        with self.assertRaisesRegex(hostmode.HostModeError, "no free display"):
            self.claim(first=90, last=90, skip={90})

    def test_remove_x_files_only_for_our_dead_xvfb(self):
        sock, xl = hostmode.x_files(95, self.x11, self.xlock)
        for path, content in ((sock, ""), (xl, "%10d\n" % 999999)):
            with open(path, "w") as handle:
                handle.write(content)
        # Another server's PID in the lock: untouched.
        self.assertEqual(hostmode.remove_x_files(95, 123, "1", x11_dir=self.x11, x_lock_dir=self.xlock), [])
        self.assertTrue(os.path.exists(sock) and os.path.exists(xl))
        # Our PID, still alive (this test process): reported, untouched.
        with open(xl, "w") as handle:
            handle.write("%10d\n" % os.getpid())
        left = hostmode.remove_x_files(95, os.getpid(), hostmode.proc_start_time(os.getpid()), x11_dir=self.x11, x_lock_dir=self.xlock)
        self.assertEqual([item["kind"] for item in left], ["display"])
        self.assertTrue(os.path.exists(sock))
        # Our PID, gone: removed.
        with open(xl, "w") as handle:
            handle.write("%10d\n" % 999999)
        self.assertEqual(hostmode.remove_x_files(95, 999999, "1", x11_dir=self.x11, x_lock_dir=self.xlock), [])
        self.assertFalse(os.path.exists(sock) or os.path.exists(xl))

    def test_xauthority_format(self):
        path = os.path.join(self.runtime, "Xauthority")
        hostmode.write_xauthority(path, 93, b"\x01" * 16)
        with open(path, "rb") as handle:
            data = handle.read()
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        family, = struct.unpack(">H", data[:2])
        self.assertEqual(family, 0xFFFF)
        fields, offset = [], 2
        for _ in range(4):
            size, = struct.unpack(">H", data[offset:offset + 2])
            fields.append(data[offset + 2:offset + 2 + size])
            offset += 2 + size
        self.assertEqual(fields, [b"", b"93", b"MIT-MAGIC-COOKIE-1", b"\x01" * 16])
        hostmode.write_xauthority(path, 94, b"\x02" * 16)  # rewritten for the next display attempt


class TaggedProcessTests(unittest.TestCase):
    def test_tagged_children_are_found_and_killed_untagged_ones_are_not(self):
        tag = "a1b2c3d4e5f60718"
        env = dict(os.environ, PI_GUI_TAG=tag)
        tagged = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], env=env, start_new_session=True)
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], env=dict(os.environ, PI_GUI_TAG=tag + "0"))
        try:
            deadline = time.monotonic() + 5
            while tagged.pid not in hostmode.tagged_processes(tag) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(hostmode.tagged_processes(tag), [tagged.pid])
            reaper = threading.Thread(target=tagged.wait)
            reaper.start()
            self.assertEqual(hostmode.kill_tagged(tag, grace=1.0), [])
            reaper.join(5)
            self.assertIsNotNone(tagged.returncode)
            self.assertIsNone(other.poll())
        finally:
            for proc in (tagged, other):
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()


class HostSessionTests(Scratch):
    def session(self, **extra):
        environ = self.host_environ(**DESKTOP)
        environ.update(extra)
        sess = session.Session(writer=None, environ=environ)
        sess.prepare_host()
        sess.display = ":93"
        sess.xauthority = os.path.join(self.runtime, "Xauthority")
        sess.bus_address = "unix:path=%s" % os.path.join(sess.runtime_dir, "pi-gui-bus")
        return sess

    def test_child_env_is_forced_to_the_private_session(self):
        sess = self.session()
        env = sess.child_env({"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-1", "GDK_BACKEND": "wayland", "HOME": "/home/u",
                              "PI_GUI_TAG": "spoofed", "SESSION_MANAGER": "x", "FOO": "bar"})
        for key in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SESSION_MANAGER", "NO_AT_BRIDGE", "PI_GUI_TESTING_TOKEN",
                    "PI_GUI_HELPER_MODE", "PI_GUI_WORKSPACE", "PI_GUI_RUNTIME_DIR", "PI_GUI_DISPLAY_LOCK_DIR"):
            self.assertNotIn(key, env)
        self.assertEqual(env["DISPLAY"], ":93")
        self.assertEqual(env["XAUTHORITY"], os.path.join(self.runtime, "Xauthority"))
        self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], sess.bus_address)
        self.assertEqual(env["XDG_RUNTIME_DIR"], os.path.join(self.runtime, "xdg"))
        self.assertEqual(env["HOME"], os.path.join(self.runtime, "home"))
        self.assertEqual(env["XDG_CONFIG_HOME"], os.path.join(self.runtime, "home", ".config"))
        self.assertEqual(env["TMPDIR"], os.path.join(self.runtime, "tmp"))
        self.assertEqual(env["PI_GUI_TAG"], sess.tag)
        for key, value in (("GDK_BACKEND", "x11"), ("QT_QPA_PLATFORM", "xcb"), ("SDL_VIDEODRIVER", "x11"),
                           ("ELECTRON_OZONE_PLATFORM_HINT", "x11"), ("XDG_SESSION_TYPE", "x11"),
                           ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1"), ("QT_ACCESSIBILITY", "1")):
            self.assertEqual(env[key], value)
        self.assertEqual(env["FOO"], "bar")
        self.assertNotIn("/deps", env["PATH"])
        self.assertNotIn("VIRTUAL_ENV", env)
        self.assertEqual(sess.tool_env(), sess.child_env({}))
        infra = sess.host_base_env()
        for key in DESKTOP:
            self.assertNotIn(key, infra) if key != "XDG_RUNTIME_DIR" else self.assertEqual(infra[key], sess.runtime_dir)
        self.assertEqual(infra["PI_GUI_TAG"], sess.tag)

    def test_private_dirs_are_created_and_removed_and_nothing_else_is_swept(self):
        sess = self.session()
        for name in ("home", "tmp", "xdg"):
            path = os.path.join(self.runtime, name)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o700)
        with open(sess.xauthority, "wb") as handle:
            handle.write(b"x")
        sess.ensure_venv()  # no-op: host mode never creates /deps/venv
        self.assertFalse(sess._venv_ready)
        self.assertEqual(sess.default_cwd, os.path.realpath(self.workspace))
        original = (session.in_container, sess._sweep)
        session.in_container = lambda: True  # e.g. Pi itself running in a dev container
        sess._sweep = lambda keep: self.fail("host mode must never sweep every process")
        try:
            self.assertEqual(sess.teardown(), [])
            self.assertEqual(sess.teardown(), [])
        finally:
            session.in_container = original[0]
        self.assertEqual(os.listdir(self.runtime), [])

    def test_invalid_mode_refuses_to_start_and_never_sweeps(self):
        sess = session.Session(writer=None, environ={"PI_GUI_HELPER_MODE": "desktop"})
        with self.assertRaisesRegex(session.StartupError, "must be 'host' or 'container'"):
            sess.start()
        original = session.in_container
        session.in_container = lambda: True
        sess._sweep = lambda keep: self.fail("no sweep")
        try:
            self.assertEqual(sess.teardown(), [])
        finally:
            session.in_container = original

    def test_bad_contract_fails_startup(self):
        sess = session.Session(writer=None, environ=self.host_environ(PI_GUI_RUNTIME_DIR="/nonexistent/runtime"))
        with self.assertRaisesRegex(session.StartupError, "PI_GUI_RUNTIME_DIR"):
            sess.start()

    def test_container_mode_is_unchanged(self):
        sess = session.Session(writer=None, environ={"HOME": "/home/app", "PATH": "/usr/bin"})
        self.assertEqual(sess.mode, "container")
        self.assertIsNone(sess.host)
        self.assertEqual(sess.default_cwd, "/workspace")
        sess.display, sess.bus_address, sess.runtime_dir = ":1", "unix:path=/run/user/1/bus", "/run/user/1"
        self.assertEqual(sess.child_env({"A": "b"}), session.build_env(sess.environ, {"A": "b"}, sess.session_env()))
        self.assertTrue(sess.child_env({})["PATH"].startswith("/deps/venv/bin:"))


class FakeCtx:
    def sleep(self, seconds):
        time.sleep(seconds)

    def check(self):
        pass


class HostHandlerTests(HostSessionTests):
    def test_exec_is_refused_unless_allowed(self):
        sess = self.session()
        handlers = methods.Handlers(sess, lambda reason: None)
        with self.assertRaises(ProtocolError) as caught:
            handlers.exec_(FakeCtx(), {"cmd": "true"})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        self.assertIn("PI_GUI_ALLOW_EXEC", caught.exception.message)
        sess.teardown()

    def test_exec_when_allowed_runs_in_the_workspace_with_the_forced_env(self):
        sess = self.session(PI_GUI_ALLOW_EXEC="1")

        class Writer:
            lines = []

            def log(self, stream, source, data):
                self.lines.append(data)
        sess.writer = Writer()
        handlers = methods.Handlers(sess, lambda reason: None)
        result = handlers.exec_(FakeCtx(), {"cmd": 'printf "%s|%s|%s" "$PWD" "$DISPLAY" "${WAYLAND_DISPLAY-unset}"', "timeoutMs": 10000})
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual("".join(Writer.lines), "%s|:93|unset" % os.path.realpath(self.workspace))
        sess.teardown()

    def test_launch_handoff_is_detected_in_host_mode(self):
        from pi_gui_helper import x11

        sess = self.session()

        class Writer:
            def log(self, stream, source, data):
                pass
        sess.writer = Writer()
        handlers = methods.Handlers(sess, lambda reason: None)
        original = x11.client_window_ids
        x11.client_window_ids = lambda env: []
        try:
            with self.assertRaises(ProtocolError) as caught:
                handlers.launch(FakeCtx(), {"cmd": "true", "args": [], "env": {}})
            self.assertEqual(caught.exception.code, "HANDOFF")
            with self.assertRaises(ProtocolError) as missing:
                handlers.launch(FakeCtx(), {"cmd": "/nonexistent/app", "env": {}})
            self.assertEqual(missing.exception.code, "NOT_FOUND")
        finally:
            x11.client_window_ids = original
            sess.teardown()

    def test_no_atspi_snapshots_report_coverage_none(self):
        sess = self.session()
        sess.a11y_available = False
        handlers = methods.Handlers(sess, lambda reason: None)
        result = handlers.hello(FakeCtx(), {"protocol": methods.PROTOCOL_VERSION})
        self.assertNotIn("a11y-atspi", result["capabilities"])
        store = handlers._store()
        snap = store.take(10, [])
        self.assertEqual((snap["coverage"], snap["tree"], snap["truncated"]), ("none", [], False))
        self.assertIn("tree_gz_base64", store.full(snap["snapshotId"]))
        with self.assertRaises(ProtocolError) as caught:
            store.resolve("s1:0")
        self.assertEqual(caught.exception.code, "NOT_FOUND")
        self.assertFalse(handlers._wait_probe("text", "x", FakeCtx())())
        sess.teardown()


class NoWindowManagerTests(unittest.TestCase):
    def test_without_net_client_list_mapped_root_children_are_the_toplevels(self):
        from pi_gui_helper import x11

        outputs = {
            ("xprop", "-root", "_NET_CLIENT_LIST"): b"_NET_CLIENT_LIST:  not found.\n",
            ("xwininfo", "-root", "-children"): (b"xwininfo: Window id: 0x2a (the root window) (has no name)\n\n"
                                                 b"  Root window id: 0x2a (the root window) (has no name)\n"
                                                 b"  Parent window id: 0x0 (none)\n     3 children:\n"
                                                 b"     0x200001 \"Pi GUI smoke\": (\"app.py\" \"App\")  320x160+0+0  +0+0\n"
                                                 b"     0x200009 (has no name): ()  1x1+-100+-100  +-100+-100\n"
                                                 b"     0x20000c \"tooltip\": ()  80x20+5+5  +5+5\n"),
            ("xwininfo", "-id", "0x200001"): b"  Map State: IsViewable\n  Override Redirect State: no\n",
            ("xwininfo", "-id", "0x200009"): b"  Map State: IsUnMapped\n  Override Redirect State: no\n",
            ("xwininfo", "-id", "0x20000c"): b"  Map State: IsViewable\n  Override Redirect State: yes\n",
        }
        original = x11.run_tool
        x11.run_tool = lambda argv, env, **kw: outputs[tuple(argv)]
        try:
            self.assertEqual(x11.client_window_ids({}), [0x200001])
            outputs[("xprop", "-root", "_NET_CLIENT_LIST")] = b"_NET_CLIENT_LIST(WINDOW): window id # 0x400003, 0x400010\n"
            self.assertEqual(x11.client_window_ids({}), [0x400003, 0x400010])
        finally:
            x11.run_tool = original


class ProbeTests(Scratch):
    def run_helper(self, probe, env):
        proc = subprocess.run([sys.executable, "-I", "-B", HELPER, "--probe", probe], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        return proc.returncode, json.loads(proc.stdout.decode().strip().splitlines()[-1])

    def test_env_probe_shows_a_scrubbed_child(self):
        env = self.host_environ(**DESKTOP)
        code, report = self.run_helper("env", env)
        self.assertEqual(code, 0, report)
        seen = report["seen"]
        for key in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SESSION_MANAGER", "NO_AT_BRIDGE"):
            self.assertNotIn(key, seen)
        for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY", "HOME"):
            self.assertEqual(seen[key], report["expected"][key])
        self.assertNotEqual(seen["DISPLAY"], ":0")
        self.assertFalse(report["tokenPresent"])
        self.assertEqual(report["contractKeys"], [])
        self.assertEqual(os.listdir(self.runtime), [], "the probe removes the dirs it created")

    def test_display_probe_without_xvfb_reports_cleanly(self):
        env = {"PATH": self.tmp, "PI_GUI_DISPLAY_LOCK_DIR": self.locks, "PI_GUI_RUNTIME_DIR": self.runtime}
        code, report = self.run_helper("display", env)
        self.assertEqual(code, 1)
        self.assertEqual(report, {"ok": False, "error": "Xvfb not found on PATH"})
        self.assertEqual(os.listdir(self.locks), [])

    def test_unknown_probe_and_stray_arguments(self):
        code, report = self.run_helper("nope", {"PATH": "/usr/bin:/bin"})
        self.assertEqual(code, 2)
        self.assertIn("unknown probe", report["error"])
        proc = subprocess.run([sys.executable, "-I", "-B", HELPER, "extra"], env={"PATH": "/usr/bin:/bin"},
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, b"")


@unittest.skipUnless(shutil.which("Xvfb"), "Xvfb not installed")
class LiveDisplayProbeTests(Scratch):
    def test_display_probe_starts_and_stops_xvfb(self):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PI_GUI_DISPLAY_LOCK_DIR": self.locks, "PI_GUI_RUNTIME_DIR": self.runtime}
        proc = subprocess.run([sys.executable, "-I", "-B", HELPER, "--probe", "display"], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        report = json.loads(proc.stdout.decode().strip().splitlines()[-1])
        self.assertEqual(proc.returncode, 0, report)
        number = int(report["display"][1:])
        self.assertGreaterEqual(number, 90)
        self.assertEqual(os.listdir(self.locks), [])
        self.assertFalse(any(os.path.lexists(p) for p in hostmode.x_files(number)))


if __name__ == "__main__":
    unittest.main()
