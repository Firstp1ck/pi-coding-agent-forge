"""Framing: token validation, line parsing, noise tolerance, encoding, log splitting."""
import json
import os
import tempfile
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import framing

TOKEN = "0123456789abcdef0123456789ABCDEF"


class TokenTests(unittest.TestCase):
    def test_valid_token(self):
        self.assertTrue(framing.valid_token(TOKEN))
        for bad in ("", "abc", TOKEN + "0", TOKEN[:-1] + "g", None, " " + TOKEN[1:]):
            self.assertFalse(framing.valid_token(bad), bad)


class ParseTests(unittest.TestCase):
    def test_protocol_line(self):
        self.assertEqual(framing.parse_line(b"%s {\"id\":1,\"method\":\"ping\"}\n" % TOKEN.encode(), TOKEN),
                         {"id": 1, "method": "ping"})

    def test_noise_is_ignored(self):
        for line in (b"", b"\n", b"motd: welcome\n", b"PI-GUI-TESTING-READY " + TOKEN.encode() + b"\n",
                     b"ffffffffffffffffffffffffffffffff {\"id\":1}\n", TOKEN.encode() + b"{\"id\":1}\n",
                     b" " + TOKEN.encode() + b" {\"id\":1}\n"):
            self.assertIsNone(framing.parse_line(line, TOKEN), line)

    def test_bad_payloads_raise(self):
        for payload in (b"not json", b"[1,2]", b"42", b"\"x\""):
            with self.assertRaises(framing.FramingError):
                framing.parse_line(TOKEN.encode() + b" " + payload + b"\n", TOKEN)

    def test_crlf_and_utf8(self):
        msg = framing.parse_line((TOKEN + ' {"text":"Grüße ✓"}\r\n').encode("utf-8"), TOKEN)
        self.assertEqual(msg["text"], "Grüße ✓")


class EncodeTests(unittest.TestCase):
    def test_round_trip(self):
        line = framing.encode_line(TOKEN, {"id": 3, "ok": True, "result": {"name": "é\nx"}})
        self.assertTrue(line.endswith(b"\n"))
        self.assertEqual(line.count(b"\n"), 1, "JSON must escape embedded newlines")
        self.assertEqual(framing.parse_line(line, TOKEN)["result"]["name"], "é\nx")


class SplitTests(unittest.TestCase):
    def test_small_text_single_piece(self):
        self.assertEqual(framing.split_utf8("abc"), ["abc"])
        self.assertEqual(framing.split_utf8(""), [])

    def test_split_respects_limit_and_code_points(self):
        text = "a" + "€" * 50000  # 3-byte code points straddle the 64 KiB boundary
        pieces = framing.split_utf8(text)
        self.assertGreater(len(pieces), 1)
        self.assertEqual("".join(pieces), text)
        for piece in pieces:
            self.assertLessEqual(len(piece.encode("utf-8")), framing.MAX_LOG_EVENT_BYTES)


class WriterTests(unittest.TestCase):
    def _writer(self):
        # A temp file, not a pipe: the test writes more than a pipe buffer holds before reading.
        handle = tempfile.TemporaryFile()
        self.addCleanup(handle.close)
        return framing.Writer(handle.fileno(), TOKEN), handle

    @staticmethod
    def _read_lines(handle):
        handle.seek(0)
        return handle.read().decode("utf-8").splitlines()

    def test_ready_and_messages(self):
        writer, handle = self._writer()
        writer.ready()
        writer.respond_ok(1, {"ok": True})
        writer.respond_error(2, "STALE_REF", "stale ref, take a new snapshot")
        writer.log("stderr", "app", "x" * (framing.MAX_LOG_EVENT_BYTES + 10))
        lines = self._read_lines(handle)
        self.assertEqual(lines[0], "PI-GUI-TESTING-READY " + TOKEN)
        messages = [json.loads(line[len(TOKEN) + 1:]) for line in lines[1:]]
        self.assertEqual(messages[0], {"id": 1, "ok": True, "result": {"ok": True}})
        self.assertEqual(messages[1]["error"], {"code": "STALE_REF", "message": "stale ref, take a new snapshot"})
        logs = messages[2:]
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(m["event"] == "log" and "id" not in m for m in logs))
        self.assertEqual(sum(len(m["data"]) for m in logs), framing.MAX_LOG_EVENT_BYTES + 10)

    def test_closed_pipe_does_not_raise(self):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        writer = framing.Writer(write_fd, TOKEN)
        import signal
        old = signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        try:
            writer.respond_ok(1, {})
        finally:
            signal.signal(signal.SIGPIPE, old)
            os.close(write_fd)
        self.assertTrue(writer.closed)


if __name__ == "__main__":
    unittest.main()
