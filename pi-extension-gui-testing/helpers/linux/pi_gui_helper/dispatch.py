"""Request envelope, sequential queue, cancellation, and heartbeat watchdog.

Contract (docs/protocol.md "Requests and responses", "Ordering"):
- every request has an integer ``id``; the response echoes it with either
  ``ok: true`` + ``result`` or ``ok: false`` + ``error {code, message}``;
- requests run one at a time in arrival order, except the bypass methods
  (``ping``, ``cancel``), which are answered from the reader thread at once;
- ``cancel {targetId}`` removes a queued request or signals the running one;
  either way that request answers ``CANCELLED``.
"""

import collections
import sys
import threading
import time
import traceback

ERROR_CODES = (
    "STALE_REF",
    "NOT_FOUND",
    "TIMEOUT",
    "HANDOFF",
    "PROTOCOL_MISMATCH",
    "CANCELLED",
    "BAD_REQUEST",
    "INTERNAL",
)

BYPASS_METHODS = ("ping", "cancel")


class ProtocolError(Exception):
    """A failure reported to the client as ``error {code, message}``."""

    def __init__(self, code, message):
        if code not in ERROR_CODES:
            raise ValueError("unknown error code %r" % code)
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(ProtocolError):
    def __init__(self, message="request cancelled"):
        super().__init__("CANCELLED", message)


def diag(text):
    """Write a diagnostic line to stderr (never stdout, which is the protocol channel)."""
    try:
        sys.stderr.write("pi-gui-helper: %s\n" % text)
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


class RequestContext:
    """Per-request state handed to a handler.

    Handlers call ``check()`` between steps and ``sleep()`` instead of
    ``time.sleep`` so that ``cancel`` interrupts them promptly. ``after`` may
    be set to a callable that runs once the response has been written (used by
    ``stop`` and a mismatched ``hello`` to exit after answering).
    """

    def __init__(self, request_id, method):
        self.id = request_id
        self.method = method
        self._cancelled = threading.Event()
        self.after = None

    @property
    def cancelled(self):
        return self._cancelled.is_set()

    def cancel(self):
        self._cancelled.set()

    def check(self):
        if self._cancelled.is_set():
            raise Cancelled()

    def sleep(self, seconds):
        if self._cancelled.wait(seconds):
            raise Cancelled()


def _param_error(message):
    return ProtocolError("BAD_REQUEST", message)


class Dispatcher:
    """Routes decoded requests to handlers with the protocol's ordering rules.

    ``handlers`` maps method name to ``fn(ctx, params) -> result dict``.
    ``cancel`` is built in. The queue worker is a daemon thread; ``close()``
    stops it after the current request.
    """

    def __init__(self, writer, handlers):
        self._writer = writer
        self._handlers = dict(handlers)
        self._queue = collections.deque()
        self._cond = threading.Condition()
        self._current = None
        self._closed = False
        self._thread = threading.Thread(target=self._run, name="queue", daemon=True)
        self._thread.start()

    def submit(self, message):
        """Accept one decoded request object from the reader thread."""
        request_id = message.get("id")
        if isinstance(request_id, bool) or not isinstance(request_id, int):
            diag("dropping request without integer id: %r" % (message.get("method"),))
            return
        method = message.get("method")
        params = message.get("params", {})
        if params is None:
            params = {}
        if not isinstance(method, str) or not isinstance(params, dict):
            self._writer.respond_error(request_id, "BAD_REQUEST", "request needs a string method and object params")
            return
        if method != "cancel" and method not in self._handlers:
            self._writer.respond_error(request_id, "BAD_REQUEST", "unknown method %r" % method)
            return
        ctx = RequestContext(request_id, method)
        if method in BYPASS_METHODS:
            self._execute(ctx, params)
            return
        with self._cond:
            if self._closed:
                self._writer.respond_error(request_id, "CANCELLED", "helper is shutting down")
                return
            self._queue.append((ctx, params))
            self._cond.notify()

    def _cancel(self, ctx, params):
        target = params.get("targetId")
        if isinstance(target, bool) or not isinstance(target, int):
            raise _param_error("cancel needs an integer targetId")
        removed = None
        with self._cond:
            for item in self._queue:
                if item[0].id == target:
                    removed = item
                    break
            if removed is not None:
                self._queue.remove(removed)
            elif self._current is not None and self._current.id == target:
                self._current.cancel()
        if removed is not None:
            self._writer.respond_error(target, "CANCELLED", "request cancelled before it started")
        # Unknown or finished targets also answer ok: the client cannot tell a
        # late cancel from an early one, and either way nothing is running.
        return {"ok": True}

    def _execute(self, ctx, params):
        handler = self._cancel if ctx.method == "cancel" else self._handlers[ctx.method]
        try:
            result = handler(ctx, params)
        except ProtocolError as exc:
            self._writer.respond_error(ctx.id, exc.code, exc.message)
        except Exception as exc:  # noqa: BLE001 - every failure must answer the request
            diag("internal error in %s: %s" % (ctx.method, traceback.format_exc()))
            self._writer.respond_error(ctx.id, "INTERNAL", "%s: %s" % (type(exc).__name__, exc))
        else:
            if ctx.cancelled:
                self._writer.respond_error(ctx.id, "CANCELLED", "request cancelled")
            else:
                self._writer.respond_ok(ctx.id, result)
        if ctx.after is not None:
            ctx.after()

    def _run(self):
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed:
                    pending = list(self._queue)
                    self._queue.clear()
                    break
                ctx, params = self._queue.popleft()
                self._current = ctx
            try:
                self._execute(ctx, params)
            finally:
                with self._cond:
                    self._current = None
        for ctx, _ in pending:
            self._writer.respond_error(ctx.id, "CANCELLED", "helper is shutting down")

    def close(self):
        """Stop accepting work, cancel the running request, and flush the queue with CANCELLED."""
        with self._cond:
            self._closed = True
            if self._current is not None:
                self._current.cancel()
            self._cond.notify_all()

    def idle(self):
        with self._cond:
            return self._current is None and not self._queue


class Watchdog:
    """Fires ``on_timeout`` once when no client message arrived for ``timeout_s``.

    Any line from the client counts as activity (spec §6: the client pings every
    15 s even while a long request runs, so long ``setup`` commands never trip it).
    """

    def __init__(self, timeout_s, on_timeout, clock=time.monotonic):
        self.timeout_s = timeout_s
        self._on_timeout = on_timeout
        self._clock = clock
        self._last = clock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)

    def start(self):
        self._thread.start()

    def touch(self):
        self._last = self._clock()

    def expired(self):
        return self._clock() - self._last >= self.timeout_s

    def stop(self):
        self._stop.set()

    def _run(self):
        interval = min(1.0, max(0.05, self.timeout_s / 10.0))
        while not self._stop.wait(interval):
            if self.expired():
                self._on_timeout()
                return


def heartbeat_timeout_seconds(environ, default_ms=60000):
    """Heartbeat timeout from ``PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS`` (tests only), else 60 s."""
    raw = environ.get("PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS", "")
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        value = default_ms
    return value / 1000.0
