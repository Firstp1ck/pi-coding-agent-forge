"""Pure helpers: PNG encoding, scaling, cropping, env block, launch args, refs, X parsing."""
import base64
import hashlib
import os
import sys
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import capture, inputs, methods, session, x11
from pi_gui_helper.dispatch import ProtocolError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pngdecode  # noqa: E402


class CaptureTests(unittest.TestCase):
    def test_png_round_trip(self):
        rgb = bytes((x * 7 + y * 3) % 256 for y in range(5) for x in range(12))  # 4x5 RGB
        png = capture.encode_png(rgb, 4, 5)
        self.assertEqual(pngdecode.decode(png), (4, 5, rgb))

    def test_scaled_size(self):
        self.assertEqual(capture.scaled_size(1280, 800, 1280), (1, 1280, 800))
        self.assertEqual(capture.scaled_size(1280, 800, 640), (0.5, 640, 400))
        self.assertEqual(capture.scaled_size(100, 50, 2000), (1, 100, 50))
        scale, w, h = capture.scaled_size(800, 1280, 1000)
        self.assertEqual((w, h), (625, 1000))
        self.assertAlmostEqual(scale, 0.78125)

    def test_clip_and_crop(self):
        self.assertIsNone(capture.clip_bounds({"x": 2000, "y": 0, "width": 10, "height": 10}, 1280, 800))
        self.assertEqual(capture.clip_bounds({"x": -5, "y": 790, "width": 20, "height": 30}, 1280, 800),
                         {"x": 0, "y": 790, "width": 15, "height": 10})
        screen = bytes(range(4 * 3 * 3))  # 4x3 screen
        rect = {"x": 1, "y": 1, "width": 2, "height": 2}
        self.assertEqual(capture.crop_rgb(screen, 4, rect), screen[15:21] + screen[27:33])

    def test_build_capture_fields(self):
        rgb = b"\x00" * (3 * 6 * 4)
        result = capture.build_capture(rgb, 6, 4, 1280, env={})
        self.assertEqual((result["width"], result["height"], result["scale"]), (6, 4, 1))
        self.assertTrue(result["allBlack"])
        self.assertEqual(result["sha256"], hashlib.sha256(rgb).hexdigest())
        self.assertEqual(pngdecode.decode(base64.b64decode(result["png_base64"]))[:2], (6, 4))
        lit = capture.build_capture(b"\x00\x01\x00" + rgb[3:], 6, 4, 1280, env={})
        self.assertNotIn("allBlack", lit)
        self.assertTrue(capture.is_uniform(rgb))
        self.assertFalse(capture.is_uniform(b"\x00\x01\x00" + rgb[3:]))


class EnvTests(unittest.TestCase):
    SESSION = {"DISPLAY": ":3", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1/bus", "HOME": "/home/app",
               "VIRTUAL_ENV": "/deps/venv", "QT_ACCESSIBILITY": "1"}

    def test_block_overrides_request_and_strips_private(self):
        base = {"PATH": "/usr/bin:/bin", "PI_GUI_TESTING_TOKEN": "t" * 32, "WAYLAND_DISPLAY": "wayland-0",
                "NO_AT_BRIDGE": "1", "LANG": "C.UTF-8"}
        env = session.build_env(base, {"DISPLAY": ":99", "FOO": "bar", "NO_AT_BRIDGE": "1"}, self.SESSION)
        self.assertEqual(env["DISPLAY"], ":3")
        self.assertEqual(env["FOO"], "bar")
        self.assertEqual(env["LANG"], "C.UTF-8")
        self.assertEqual(env["PATH"], "/deps/venv/bin:/deps/node/bin:/usr/bin:/bin")
        for key in ("PI_GUI_TESTING_TOKEN", "WAYLAND_DISPLAY", "NO_AT_BRIDGE"):
            self.assertNotIn(key, env)

    def test_request_path_is_kept_after_prefix(self):
        env = session.build_env({"PATH": "/usr/bin"}, {"PATH": "/opt/tool/bin:/usr/bin"}, self.SESSION)
        self.assertEqual(env["PATH"], "/deps/venv/bin:/deps/node/bin:/opt/tool/bin:/usr/bin")


class LaunchArgTests(unittest.TestCase):
    def test_chromium_flag(self):
        flag = "--force-renderer-accessibility"
        self.assertEqual(methods.launch_args("./node_modules/.bin/electron", [".", "--no-sandbox"]),
                         [".", "--no-sandbox", flag])
        self.assertEqual(methods.launch_args("/usr/bin/chromium", [flag]), [flag])
        self.assertEqual(methods.launch_args("npx", ["electron", "."]), ["electron", ".", flag])
        self.assertEqual(methods.launch_args("python3", ["app.py"]), ["app.py"])
        self.assertEqual(methods.launch_args("node", ["server.js"]), ["server.js"])


class InputTests(unittest.TestCase):
    def test_scroll_parse(self):
        self.assertEqual(inputs.parse_scroll(""), ("5", 1))
        self.assertEqual(inputs.parse_scroll("up 3"), ("4", 3))
        self.assertEqual(inputs.parse_scroll("RIGHT"), ("7", 1))
        for bad in ("sideways", "up x", "down 0", "down 101"):
            with self.assertRaises(ProtocolError) as err:
                inputs.parse_scroll(bad)
            self.assertEqual(err.exception.code, "BAD_REQUEST")


class X11ParseTests(unittest.TestCase):
    def test_window_refs(self):
        self.assertEqual(x11.window_ref(0x400003), "win:0x400003")
        self.assertEqual(x11.parse_window_ref("win:0x400003"), 0x400003)
        self.assertIsNone(x11.parse_window_ref("s1:3"))
        with self.assertRaises(ProtocolError):
            x11.parse_window_ref("win:zz")

    def test_xwininfo(self):
        text = """
xwininfo: Window id: 0x400003 "Pi GUI smoke"

  Absolute upper-left X:  480
  Absolute upper-left Y:  328
  Relative upper-left X:  1
  Width: 320
  Height: 160
  Map State: IsViewable
"""
        self.assertEqual(x11.parse_xwininfo(text), ({"x": 480, "y": 328, "width": 320, "height": 160}, True))
        self.assertEqual(x11.parse_xwininfo(text.replace("IsViewable", "IsUnMapped"))[1], False)
        self.assertEqual(x11.parse_xwininfo("garbage"), (None, False))


class A11yPureTests(unittest.TestCase):
    """Ref parsing and coverage; imports gi/pyatspi, which the image must provide."""

    def setUp(self):
        from pi_gui_helper import a11y
        self.a11y = a11y

    def test_parse_ref(self):
        self.assertEqual(self.a11y.parse_ref("s12:40"), ("s12", 40))
        for bad in ("s12", "s12:", ":4", "s1:x", 5, None):
            with self.assertRaises(ProtocolError) as err:
                self.a11y.parse_ref(bad)
            self.assertEqual(err.exception.code, "BAD_REQUEST")

    def test_coverage(self):
        self.assertEqual(self.a11y.coverage(1, 1, 5), "full")
        self.assertEqual(self.a11y.coverage(2, 1, 5), "partial")
        self.assertEqual(self.a11y.coverage(1, 0, 0), "none")
        self.assertEqual(self.a11y.coverage(0, 0, 0), "none")

    def test_stale_and_unknown_refs(self):
        store = self.a11y.SnapshotStore()
        with self.assertRaises(ProtocolError) as err:
            store.resolve("s1:0")
        self.assertEqual(err.exception.code, "STALE_REF")
        with self.assertRaises(ProtocolError) as err:
            store.full("s1")
        self.assertEqual(err.exception.code, "STALE_REF")


if __name__ == "__main__":
    unittest.main()
