#!/usr/bin/env python3
"""Sample-app acceptance (plan S4/S5 prerequisites): snapshot → act by ref → screenshot.

GTK 4 runs with ``--network none``. PySide6 and Electron need the default
network for their ``setup`` downloads; Electron also runs in copy mode (a
writable temp copy of the sample) with ``--shm-size=512m``.

    python3 tests/helper/host/test_apps.py -v            # all
    python3 tests/helper/host/test_apps.py -v Apps.test_gtk4
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import pngdecode  # noqa: E402
from client import Helper  # noqa: E402

TESTAPPS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "testapps"))
BUTTON_ROLES = {"button", "push button"}


def config(app):
    with open(os.path.join(TESTAPPS, app, ".pi", "gui.json")) as handle:
        return json.load(handle)


def _inside(inner, outer):
    if inner is None:
        return False
    return (outer["x"] <= inner["x"] and outer["y"] <= inner["y"]
            and inner["x"] + inner["width"] <= outer["x"] + outer["width"]
            and inner["y"] + inner["height"] <= outer["y"] + outer["height"])


class Apps(unittest.TestCase):
    results = {}

    def run_app(self, app, network="none", shm_size=None, copy=False, launch_timeout=90):
        cfg = config(app)
        source = os.path.join(TESTAPPS, app)
        workdir = None
        if copy:
            workdir = tempfile.mkdtemp(prefix="w2-copy-")
            shutil.copytree(source, os.path.join(workdir, "ws"), ignore=shutil.ignore_patterns(".pi"))
            mount = (os.path.join(workdir, "ws"), "/workspace", "rw")
        else:
            mount = (source, "/workspace", "ro")
        record = {"app": app}
        try:
            with Helper("w2-test-app-%s-%d" % (app, os.getpid()), network=network, shm_size=shm_size,
                        mounts=[mount]) as h:
                h.call("hello", {"protocol": 2, "packageVersion": "0.1.0"})
                for cmd in cfg.get("setup", []):
                    started = time.monotonic()
                    result = h.call("exec", {"cmd": cmd, "cwd": "/workspace", "env": {}, "timeoutMs": 900000}, timeout=960)
                    record.setdefault("setup", []).append({"cmd": cmd, "exitCode": result["exitCode"],
                                                           "seconds": round(time.monotonic() - started, 1)})
                    if result["exitCode"] != 0:
                        tail = "".join(e["data"] for e in h.events if e.get("source") == "setup")[-3000:]
                        self.fail("setup %r exited %d:\n%s" % (cmd, result["exitCode"], tail))
                launch = cfg["launch"]
                started = time.monotonic()
                launched = h.call("launch", {"cmd": launch["cmd"], "args": launch.get("args", []),
                                             "env": launch.get("env", {}), "cwd": "/workspace"}, timeout=launch_timeout)
                record["launchSeconds"] = round(time.monotonic() - started, 1)
                record["windows"] = [w["title"] for w in launched["windows"]]
                self.assertTrue(launched["windows"], "no window appeared")
                button = None
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    snap = h.call("snapshot", {"maxNodes": 1000})
                    button = next((n for n in snap["tree"] if n["role"] in BUTTON_ROLES and n["name"] == "Press me"), None)
                    if button is not None:
                        break
                    time.sleep(0.5)
                record["coverage"] = snap["coverage"]
                record["nodes"] = len(snap["tree"])
                record["roles"] = sorted({n["role"] for n in snap["tree"]})
                self.assertIsNotNone(button, "button not found; roles seen: %s" % sorted({n["role"] for n in snap["tree"]}))
                record["buttonBounds"] = button.get("bounds")
                record["windowBounds"] = launched["windows"][0]["bounds"]
                self.assertTrue(_inside(button.get("bounds"), launched["windows"][0]["bounds"]),
                                "button bounds %s outside window %s" % (button.get("bounds"), launched["windows"][0]["bounds"]))
                h.call("act", {"ref": button["ref"], "action": "click"})
                record["pressedVisible"] = h.call("wait", {"for": "text", "value": "Pressed", "timeoutMs": 8000})["matched"]
                shot = h.call("screenshot", {"window": launched["windows"][0]["ref"]})
                width, height, rgb = pngdecode.decode(base64.b64decode(shot["png_base64"]))
                record["screenshot"] = "%dx%d scale %s" % (width, height, shot["scale"])
                self.assertFalse(rgb == rgb[:3] * (len(rgb) // 3), "uniform screenshot")
                self.assertTrue(record["pressedVisible"], "label did not change to Pressed")
                self.assertEqual(record["coverage"], "full")
                record["stop"] = h.call("stop")
                self.assertEqual(record["stop"]["leftovers"], [])
        finally:
            Apps.results[app] = record
            if workdir:
                shutil.rmtree(workdir, ignore_errors=True)

    def test_gtk4(self):
        self.run_app("gtk4")

    def test_pyside6(self):
        self.run_app("pyside6", network=None)

    def test_electron(self):
        self.run_app("electron", network=None, shm_size="512m", copy=True)


def tearDownModule():
    print("\n" + json.dumps(Apps.results, indent=1), file=sys.stderr)
    out = subprocess.run(["docker", "ps", "-a", "--format", "{{.ID}} {{.Label \"pi-gui-testing.session\"}}"],
                         stdout=subprocess.PIPE, check=False).stdout.decode()
    leftovers = [line.split()[0] for line in out.splitlines() if " w2-test-" in line]
    if leftovers:
        subprocess.run(["docker", "rm", "-f"] + leftovers, check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()
