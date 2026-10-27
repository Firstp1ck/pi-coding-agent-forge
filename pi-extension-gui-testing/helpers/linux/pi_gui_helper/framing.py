"""Line framing for the helper protocol.

Contract (docs/protocol.md "Framing"): the token arrives in
``PI_GUI_TESTING_TOKEN`` (32 hex characters); the helper prints
``PI-GUI-TESTING-READY <token>`` once, then every protocol line in either
direction is ``<token> <json>\\n``. Lines without the prefix are noise.
"""

import json
import os
import re
import threading

TOKEN_ENV = "PI_GUI_TESTING_TOKEN"
READY_PREFIX = "PI-GUI-TESTING-READY"
MAX_LINE_BYTES = 64 * 1024 * 1024
MAX_LOG_EVENT_BYTES = 64 * 1024

_TOKEN_RE = re.compile(r"^[0-9a-fA-F]{32}$")


class FramingError(Exception):
    """A token-prefixed line whose payload is not a JSON object."""


def valid_token(token):
    """Return True when ``token`` is exactly 32 hex characters."""
    return isinstance(token, str) and bool(_TOKEN_RE.match(token))


def parse_line(line, token):
    """Decode one input line.

    Returns the JSON object for a protocol line and ``None`` for noise (a line
    without the ``<token> `` prefix, or a blank line). Raises ``FramingError``
    for a protocol line whose payload is not a JSON object.
    """
    if isinstance(line, bytes):
        if len(line) > MAX_LINE_BYTES:
            raise FramingError("line exceeds 64 MiB")
        line = line.decode("utf-8", errors="replace")
    line = line.rstrip("\r\n")
    prefix = token + " "
    if not line.startswith(prefix):
        return None
    try:
        message = json.loads(line[len(prefix):])
    except ValueError as exc:
        raise FramingError("invalid JSON: %s" % exc) from None
    if not isinstance(message, dict):
        raise FramingError("protocol payload must be a JSON object")
    return message


def encode_line(token, message):
    """Encode ``message`` as one ``<token> <json>\\n`` line (UTF-8 bytes)."""
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
    return (token + " " + payload + "\n").encode("utf-8")


def split_utf8(text, limit=MAX_LOG_EVENT_BYTES):
    """Split ``text`` into pieces whose UTF-8 encoding is at most ``limit`` bytes.

    Pieces never split a code point, so each piece is valid UTF-8 on its own.
    """
    data = text.encode("utf-8")
    if len(data) <= limit:
        return [text] if text else []
    pieces = []
    start = 0
    while start < len(data):
        end = min(start + limit, len(data))
        # Back off to a code-point boundary: continuation bytes are 0b10xxxxxx.
        while end < len(data) and end > start and (data[end] & 0xC0) == 0x80:
            end -= 1
        pieces.append(data[start:end].decode("utf-8"))
        start = end
    return pieces


class Writer:
    """Thread-safe writer of protocol lines to a dedicated file descriptor.

    Responses, events, and the ready line come from several threads (queue
    worker, bypass handlers, log pumps); the lock keeps every line whole.
    """

    def __init__(self, fd, token):
        self._fd = fd
        self._token = token
        self._lock = threading.Lock()
        self.closed = False

    def _write(self, data):
        with self._lock:
            if self.closed:
                return
            try:
                view = memoryview(data)
                while view:
                    written = os.write(self._fd, view)
                    view = view[written:]
            except OSError:
                # The client is gone; teardown follows from stdin EOF.
                self.closed = True

    def ready(self):
        self._write(("%s %s\n" % (READY_PREFIX, self._token)).encode("ascii"))

    def send(self, message):
        self._write(encode_line(self._token, message))

    def respond_ok(self, request_id, result):
        self.send({"id": request_id, "ok": True, "result": result})

    def respond_error(self, request_id, code, message):
        self.send({"id": request_id, "ok": False, "error": {"code": code, "message": message}})

    def log(self, stream, source, text):
        """Send ``text`` as one or more ``log`` events of at most 64 KiB each."""
        for piece in split_utf8(text):
            self.send({"event": "log", "stream": stream, "source": source, "data": piece})
