"""Envelope, sequential queue, ping/cancel bypass, cancellation, error codes, heartbeat."""
import threading
import time
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import dispatch
from pi_gui_helper.dispatch import Dispatcher, ProtocolError, Watchdog


class FakeWriter:
    def __init__(self):
        self.messages = []
        self.cond = threading.Condition()

    def _add(self, message):
        with self.cond:
            self.messages.append(message)
            self.cond.notify_all()

    def respond_ok(self, request_id, result):
        self._add({"id": request_id, "ok": True, "result": result})

    def respond_error(self, request_id, code, message):
        self._add({"id": request_id, "ok": False, "error": {"code": code, "message": message}})

    def wait_for(self, request_id, timeout=5.0):
        deadline = time.monotonic() + timeout
        with self.cond:
            while True:
                for message in self.messages:
                    if message.get("id") == request_id:
                        return message
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError("no response for %d" % request_id)
                self.cond.wait(remaining)


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.writer = FakeWriter()
        self.order = []
        self.release = threading.Event()

        def slow(ctx, params):
            self.order.append(("start", ctx.id))
            while not self.release.is_set():
                ctx.sleep(0.01)
            self.order.append(("end", ctx.id))
            return {"done": ctx.id}

        def quick(ctx, params):
            self.order.append(("quick", ctx.id))
            return {"echo": params.get("v")}

        def fails(ctx, params):
            raise ProtocolError("NOT_FOUND", "nothing there")

        def crashes(ctx, params):
            raise RuntimeError("boom")

        self.dispatcher = Dispatcher(self.writer, {"slow": slow, "quick": quick, "fails": fails,
                                                   "crashes": crashes, "ping": lambda c, p: {"ok": True}})
        self.addCleanup(self.dispatcher.close)
        self.addCleanup(self.release.set)

    def submit(self, request_id, method, params=None):
        self.dispatcher.submit({"id": request_id, "method": method, "params": params or {}})

    def test_ok_and_error_envelopes(self):
        self.submit(1, "quick", {"v": 5})
        self.assertEqual(self.writer.wait_for(1), {"id": 1, "ok": True, "result": {"echo": 5}})
        self.submit(2, "fails")
        self.assertEqual(self.writer.wait_for(2)["error"], {"code": "NOT_FOUND", "message": "nothing there"})
        self.submit(3, "crashes")
        error = self.writer.wait_for(3)["error"]
        self.assertEqual(error["code"], "INTERNAL")
        self.assertIn("boom", error["message"])

    def test_bad_requests(self):
        self.submit(1, "nope")
        self.assertEqual(self.writer.wait_for(1)["error"]["code"], "BAD_REQUEST")
        self.dispatcher.submit({"id": 2, "method": "quick", "params": [1]})
        self.assertEqual(self.writer.wait_for(2)["error"]["code"], "BAD_REQUEST")
        self.dispatcher.submit({"id": 3, "method": 7})
        self.assertEqual(self.writer.wait_for(3)["error"]["code"], "BAD_REQUEST")
        self.dispatcher.submit({"id": 4, "method": "cancel", "params": {"targetId": "x"}})
        self.assertEqual(self.writer.wait_for(4)["error"]["code"], "BAD_REQUEST")
        # No usable id: nothing can be answered, so nothing is sent.
        for message in ({"method": "quick"}, {"id": "7", "method": "quick"}, {"id": True, "method": "quick"}):
            self.dispatcher.submit(message)
        time.sleep(0.1)
        self.assertEqual({m["id"] for m in self.writer.messages}, {1, 2, 3, 4})

    def test_sequential_order(self):
        self.submit(1, "slow")
        self.submit(2, "quick")
        self.submit(3, "quick")
        time.sleep(0.1)
        self.assertEqual(self.order, [("start", 1)])
        self.release.set()
        self.writer.wait_for(3)
        self.assertEqual(self.order, [("start", 1), ("end", 1), ("quick", 2), ("quick", 3)])

    def test_ping_bypasses_queue(self):
        self.submit(1, "slow")
        time.sleep(0.05)
        self.submit(2, "ping")
        self.assertEqual(self.writer.wait_for(2, timeout=1), {"id": 2, "ok": True, "result": {"ok": True}})
        self.assertFalse(any(m["id"] == 1 for m in self.writer.messages))

    def test_cancel_running_and_queued(self):
        self.submit(1, "slow")
        self.submit(2, "quick")
        time.sleep(0.05)
        self.submit(10, "cancel", {"targetId": 2})
        self.assertEqual(self.writer.wait_for(10)["result"], {"ok": True})
        self.assertEqual(self.writer.wait_for(2)["error"]["code"], "CANCELLED")
        self.submit(11, "cancel", {"targetId": 1})
        self.assertEqual(self.writer.wait_for(1)["error"]["code"], "CANCELLED")
        self.assertNotIn(("quick", 2), self.order)
        self.submit(12, "cancel", {"targetId": 999})
        self.assertEqual(self.writer.wait_for(12)["result"], {"ok": True})

    def test_after_runs_once_response_is_written(self):
        seen = []

        def handler(ctx, params):
            ctx.after = lambda: seen.append(len(self.writer.messages))
            return {}

        dispatcher = Dispatcher(self.writer, {"stop": handler})
        self.addCleanup(dispatcher.close)
        dispatcher.submit({"id": 5, "method": "stop"})
        self.writer.wait_for(5)
        time.sleep(0.05)
        self.assertEqual(seen, [1])

    def test_close_cancels_queue(self):
        self.submit(1, "slow")
        self.submit(2, "quick")
        time.sleep(0.05)
        self.dispatcher.close()
        self.assertEqual(self.writer.wait_for(2)["error"]["code"], "CANCELLED")
        self.assertEqual(self.writer.wait_for(1)["error"]["code"], "CANCELLED")
        self.submit(3, "quick")
        self.assertEqual(self.writer.wait_for(3)["error"]["code"], "CANCELLED")


class ErrorCodeTests(unittest.TestCase):
    def test_codes_match_protocol(self):
        self.assertEqual(set(dispatch.ERROR_CODES), {"STALE_REF", "NOT_FOUND", "TIMEOUT", "HANDOFF",
                                                     "PROTOCOL_MISMATCH", "CANCELLED", "BAD_REQUEST", "INTERNAL"})
        self.assertEqual(dispatch.BYPASS_METHODS, ("ping", "cancel"))
        with self.assertRaises(ValueError):
            ProtocolError("WHATEVER", "x")


class WatchdogTests(unittest.TestCase):
    def test_timeout_env(self):
        self.assertEqual(dispatch.heartbeat_timeout_seconds({}), 60.0)
        self.assertEqual(dispatch.heartbeat_timeout_seconds({"PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS": "3000"}), 3.0)
        for bad in ("", "abc", "0", "-5"):
            self.assertEqual(dispatch.heartbeat_timeout_seconds({"PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS": bad}), 60.0)

    def test_fires_after_silence_and_touch_defers(self):
        fired = threading.Event()
        dog = Watchdog(0.3, fired.set)
        dog.start()
        self.addCleanup(dog.stop)
        for _ in range(5):
            time.sleep(0.1)
            dog.touch()
        self.assertFalse(fired.is_set())
        self.assertTrue(fired.wait(2))


if __name__ == "__main__":
    unittest.main()
