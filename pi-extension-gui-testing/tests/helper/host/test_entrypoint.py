#!/usr/bin/env python3
"""Entrypoint tests: run the base image exactly as production does and drive the helper.

Run from the package root with the image built (see build_image.py):

    python3 tests/helper/host/test_entrypoint.py -v

Every container carries ``pi-gui-testing.session=w2-test-*`` and ``--rm``;
``tearDownModule`` removes any leftover with that label prefix.
"""

import base64
import hashlib
import os
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import pngdecode  # noqa: E402
from client import Helper, HelperError, container_ids, wait_container_gone  # noqa: E402

SMOKE = {"cmd": "python3", "args": ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"], "env": {}, "cwd": "/workspace"}
TESTAPPS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "testapps"))
_counter = [0]


def session_id(name):
    _counter[0] += 1
    return "w2-test-%s-%d-%d" % (name, os.getpid(), _counter[0])


def find(tree, role, name):
    for node in tree:
        if node["role"] == role and node["name"] == name:
            return node
    return None


def decode_shot(shot):
    return pngdecode.decode(base64.b64decode(shot["png_base64"]))


def is_uniform(rgb):
    return rgb == rgb[:3] * (len(rgb) // 3)


class SmokeFlow(unittest.TestCase):
    """Spec §5.5 smoke flow plus the protocol details W3 depends on."""

    @classmethod
    def setUpClass(cls):
        cls.sid = session_id("smoke")
        cls.h = Helper(cls.sid)

    @classmethod
    def tearDownClass(cls):
        cls.h.close()

    def test_1_ready_and_hello(self):
        self.assertLess(self.h.ready_after, 10.0)
        hello = self.h.call("hello", {"protocol": 2, "packageVersion": "0.1.0"})
        self.assertEqual(hello["protocol"], 2)
        self.assertEqual(hello["os"], "linux")
        self.assertIn("snapshot", hello["capabilities"])

    def test_2_noise_and_bad_requests(self):
        h = self.h
        h.proc.stdin.write(b"hello there\n" + b"0" * 32 + b" {\"id\": 99}\n" + h.token.encode() + b" not json\n")
        h.proc.stdin.flush()
        self.assertEqual(h.call("ping"), {"ok": True})
        with self.assertRaises(HelperError) as err:
            h.call("frobnicate")
        self.assertEqual(err.exception.code, "BAD_REQUEST")
        with self.assertRaises(HelperError) as err:
            h.call("act", {"action": "explode", "ref": "s1:0"})
        self.assertEqual(err.exception.code, "BAD_REQUEST")

    def test_3_launch_snapshot_act(self):
        h = self.h
        launched = h.call("launch", SMOKE)
        self.assertGreater(launched["pid"], 0)
        self.assertEqual([w["title"] for w in launched["windows"]], ["Pi GUI smoke"])
        self.assertTrue(h.call("wait", {"for": "window", "value": "Pi GUI smoke", "timeoutMs": 5000})["matched"])
        snap = h.call("snapshot", {"maxNodes": 200})
        self.assertEqual(snap["coverage"], "full")
        button = find(snap["tree"], "button", "Press me")
        self.assertIsNotNone(button, snap["tree"])
        self.assertIsNotNone(find(snap["tree"], "label", "Waiting"))
        self.assertEqual(h.call("act", {"ref": button["ref"], "action": "click"}), {"ok": True})
        self.assertTrue(h.call("wait", {"for": "text", "value": "Pressed", "timeoutMs": 5000})["matched"])
        snap2 = h.call("snapshot", {"maxNodes": 200})
        self.assertIsNotNone(find(snap2["tree"], "label", "Pressed"))
        with self.assertRaises(HelperError) as err:
            h.call("act", {"ref": button["ref"], "action": "click"})
        self.assertEqual(err.exception.code, "STALE_REF")
        truncated = h.call("snapshot", {"maxNodes": 2})
        self.assertTrue(truncated["truncated"])
        self.assertEqual(len(truncated["tree"]), 2)
        full = h.call("snapshotFull", {"snapshotId": truncated["snapshotId"]})
        import gzip
        import json
        nodes = json.loads(gzip.decompress(base64.b64decode(full["tree_gz_base64"])))
        self.assertGreater(len(nodes), 2)
        with self.assertRaises(HelperError) as err:
            h.call("snapshotFull", {"snapshotId": snap["snapshotId"]})
        self.assertEqual(err.exception.code, "STALE_REF")

    def test_4_screenshots(self):
        h = self.h
        shot = h.call("screenshot", {})
        self.assertEqual((shot["target"], shot["origin"], shot["width"], shot["height"], shot["scale"]),
                         ("screen", {"x": 0, "y": 0}, 1280, 800, 1))
        width, height, rgb = decode_shot(shot)
        self.assertEqual((width, height), (1280, 800))
        self.assertFalse(is_uniform(rgb))
        self.assertEqual(hashlib.sha256(rgb).hexdigest(), shot["sha256"])
        self.assertNotIn("allBlack", shot)
        small = h.call("screenshot", {"maxEdge": 640})
        self.assertEqual((small["width"], small["height"], small["scale"]), (1280, 800, 0.5))
        self.assertEqual(decode_shot(small)[:2], (640, 400))
        window = h.call("windows")["windows"][0]
        wshot = h.call("screenshot", {"window": window["ref"]})
        self.assertEqual(wshot["target"], window["ref"])
        self.assertEqual(wshot["origin"], {"x": window["bounds"]["x"], "y": window["bounds"]["y"]})
        self.assertEqual(decode_shot(wshot)[:2], (window["bounds"]["width"], window["bounds"]["height"]))
        with self.assertRaises(HelperError) as err:
            h.call("act", {"captureId": shot["captureId"], "x": 10, "y": 10, "action": "click"})
        self.assertEqual(err.exception.code, "STALE_REF")
        with self.assertRaises(HelperError) as err:
            h.call("act", {"captureId": wshot["captureId"], "x": 5000, "y": 10, "action": "click"})
        self.assertEqual(err.exception.code, "BAD_REQUEST")
        with self.assertRaises(HelperError) as err:
            h.call("screenshot", {"window": "win:0x7fffff0"})
        self.assertEqual(err.exception.code, "NOT_FOUND")

    def test_5_exec_logs_and_venv(self):
        h = self.h
        before = len(h.events)
        result = h.call("exec", {"cmd": "echo out-line; echo err-line >&2; test -x /deps/venv/bin/python && "
                                        "python3 -c 'import sys, gi, pyatspi; print(sys.prefix)'; exit 3",
                                 "cwd": "/workspace", "env": {"FOO": "bar"}, "timeoutMs": 60000})
        self.assertEqual(result["exitCode"], 3)
        events = h.events[before:]
        stdout = "".join(e["data"] for e in events if e["stream"] == "stdout")
        stderr = "".join(e["data"] for e in events if e["stream"] == "stderr")
        self.assertTrue(all(e["event"] == "log" and e["source"] == "setup" for e in events))
        self.assertIn("out-line", stdout)
        self.assertIn("/deps/venv", stdout)
        self.assertIn("err-line", stderr)
        env = h.call("exec", {"cmd": "env", "cwd": "/workspace", "env": {"WAYLAND_DISPLAY": "wayland-0"}, "timeoutMs": 10000})
        self.assertEqual(env["exitCode"], 0)
        dump = "".join(e["data"] for e in h.events if e.get("source") == "setup")
        self.assertNotIn("WAYLAND_DISPLAY", dump)
        self.assertNotIn("PI_GUI_TESTING_TOKEN", dump)
        self.assertIn("QT_ACCESSIBILITY=1", dump)

    def test_6_big_log_is_split(self):
        h = self.h
        before = len(h.events)
        h.call("exec", {"cmd": "head -c 300000 /dev/zero | tr '\\0' x", "cwd": "/workspace", "env": {}, "timeoutMs": 10000})
        events = h.events[before:]
        self.assertEqual(sum(len(e["data"]) for e in events), 300000)
        self.assertTrue(all(len(e["data"].encode()) <= 65536 for e in events))

    def test_7_timeout_cancel_and_bypass(self):
        h = self.h
        with self.assertRaises(HelperError) as err:
            h.call("exec", {"cmd": "sleep 30", "cwd": "/workspace", "env": {}, "timeoutMs": 500})
        self.assertEqual(err.exception.code, "TIMEOUT")
        long_id = h.send("exec", {"cmd": "sleep 30", "cwd": "/workspace", "env": {}, "timeoutMs": 60000})
        queued_id = h.send("windows")
        started = time.monotonic()
        self.assertEqual(h.call("ping", timeout=5), {"ok": True})
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(h.call("cancel", {"targetId": queued_id}), {"ok": True})
        self.assertEqual(h.response(queued_id, 5)["error"]["code"], "CANCELLED")
        self.assertEqual(h.call("cancel", {"targetId": long_id}), {"ok": True})
        self.assertEqual(h.response(long_id, 10)["error"]["code"], "CANCELLED")
        self.assertLess(time.monotonic() - started, 8.0)
        procs = h.call("exec", {"cmd": "pgrep -x sleep || true", "cwd": "/workspace", "env": {}, "timeoutMs": 5000})
        self.assertEqual(procs["exitCode"], 0)

    def test_8_stop(self):
        result = self.h.call("stop")
        self.assertEqual(result, {"ok": True, "leftovers": []})
        self.assertIsNotNone(wait_container_gone(self.sid, 15))


class CoordinateClick(unittest.TestCase):
    def test_gtk3_click_by_capture_coordinates(self):
        with Helper(session_id("coords")) as h:
            h.call("launch", SMOKE)
            button = find(h.call("snapshot", {"maxNodes": 200})["tree"], "button", "Press me")
            window = h.call("windows")["windows"][0]
            shot = h.call("screenshot", {"window": window["ref"], "maxEdge": 200})
            self.assertLess(shot["scale"], 1)
            x = button["bounds"]["x"] + button["bounds"]["width"] // 2 - shot["origin"]["x"]
            y = button["bounds"]["y"] + button["bounds"]["height"] // 2 - shot["origin"]["y"]
            self.assertEqual(h.call("act", {"captureId": shot["captureId"], "x": x, "y": y, "action": "click"}), {"ok": True})
            self.assertTrue(h.call("wait", {"for": "text", "value": "Pressed", "timeoutMs": 5000})["matched"])
            self.assertEqual(h.call("stop")["leftovers"], [])


class Tk(unittest.TestCase):
    def test_tk_has_no_tree_and_works_by_coordinates(self):
        with Helper(session_id("tk"), mounts=[(os.path.join(TESTAPPS, "tk"), "/workspace", "ro")]) as h:
            launched = h.call("launch", {"cmd": "python3", "args": ["app.py"], "env": {}, "cwd": "/workspace"})
            self.assertEqual(launched["windows"][0]["title"], "Pi GUI Tk")
            snap = h.call("snapshot", {"maxNodes": 100})
            self.assertEqual(snap["coverage"], "none")
            self.assertFalse(h.call("wait", {"for": "text", "value": "Waiting", "timeoutMs": 500})["matched"])
            self.assertTrue(h.call("wait", {"for": "idle", "timeoutMs": 5000})["matched"])
            window = launched["windows"][0]
            before = h.call("screenshot", {"window": window["ref"]})
            # A click on empty space must not change the window; the button sits in the lower part.
            h.call("act", {"captureId": before["captureId"], "x": 5, "y": 5, "action": "click"})
            h.call("wait", {"for": "idle", "timeoutMs": 3000})
            same = h.call("screenshot", {"window": window["ref"]})
            self.assertEqual(same["sha256"], before["sha256"])
            _, height, rgb = decode_shot(same)
            width = same["width"]
            bx, by = self._button_center(rgb, width, height)
            h.call("act", {"captureId": same["captureId"], "x": bx, "y": by, "action": "click"})
            h.call("wait", {"for": "idle", "timeoutMs": 3000})
            after = h.call("screenshot", {"window": window["ref"]})
            self.assertNotEqual(after["sha256"], same["sha256"])
            self.assertEqual(h.call("stop")["leftovers"], [])

    @staticmethod
    def _button_center(rgb, width, height):
        # The Tk button is the lowest region whose pixels differ from the window
        # background (sampled at the top-left corner); aim at its middle row.
        bg = rgb[:3]
        rows = [y for y in range(height // 2, height)
                if any(rgb[(y * width + x) * 3:(y * width + x) * 3 + 3] != bg for x in range(0, width, 4))]
        top, bottom = min(rows), max(rows)
        return width // 2, (top + bottom) // 2


class Teardown(unittest.TestCase):
    def test_stdin_eof_removes_container(self):
        sid = session_id("eof")
        h = Helper(sid)
        try:
            h.call("launch", SMOKE)
            self.assertTrue(container_ids(sid))
            closed = time.monotonic()
            h.close_stdin()
            gone = wait_container_gone(sid, 15)
            self.assertIsNotNone(gone, "container still present 15 s after stdin EOF")
            print("\n  EOF teardown: container gone after %.1f s" % (gone - closed), file=sys.stderr)
        finally:
            h.close()

    def test_heartbeat_timeout_removes_container(self):
        sid = session_id("heartbeat")
        h = Helper(sid, extra_env={"PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS": "3000"})
        try:
            h.call("launch", SMOKE)
            silent = time.monotonic()
            gone = wait_container_gone(sid, 20)
            self.assertIsNotNone(gone, "container still present 20 s into a silent client")
            self.assertGreaterEqual(gone - silent, 2.5)
            self.assertIn("heartbeat timeout", "".join(h.stderr_lines))
            print("\n  heartbeat teardown: container gone after %.1f s of silence" % (gone - silent), file=sys.stderr)
        finally:
            h.close()

    def test_sigterm_removes_container(self):
        sid = session_id("sigterm")
        h = Helper(sid)
        try:
            h.call("launch", SMOKE)
            subprocess.run(["docker", "kill", "--signal", "TERM"] + container_ids(sid), check=True, stdout=subprocess.DEVNULL)
            self.assertIsNotNone(wait_container_gone(sid, 15))
            self.assertIn("tearing down: signal 15", "".join(h.stderr_lines))
        finally:
            h.close()

    def test_protocol_mismatch_exits(self):
        sid = session_id("mismatch")
        h = Helper(sid)
        try:
            with self.assertRaises(HelperError) as err:
                h.call("hello", {"protocol": 999, "packageVersion": "0.1.0"})
            self.assertEqual(err.exception.code, "PROTOCOL_MISMATCH")
            self.assertIsNotNone(wait_container_gone(sid, 15))
        finally:
            h.close()

    def test_missing_token_fails_fast(self):
        sid = session_id("notoken")
        from client import docker_run_argv, write_identity
        import tempfile
        import shutil
        tmp = tempfile.mkdtemp(prefix="w2-session-")
        self.addCleanup(shutil.rmtree, tmp, True)
        write_identity(tmp)
        proc = subprocess.run(docker_run_argv(tmp, "bad", sid), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, b"")
        self.assertIn(b"32 hex", proc.stderr)


def tearDownModule():
    out = subprocess.run(["docker", "ps", "-a", "--format", "{{.ID}} {{.Label \"pi-gui-testing.session\"}}"],
                         stdout=subprocess.PIPE, check=False).stdout.decode()
    leftovers = [line.split()[0] for line in out.splitlines() if " w2-test-" in line]
    if leftovers:
        subprocess.run(["docker", "rm", "-f"] + leftovers, check=False, stdout=subprocess.DEVNULL)
        print("removed leftover test containers: %s" % leftovers, file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
