"""Helper entrypoint: framing setup, startup, request loop, and exit paths.

Exit paths (docs/protocol.md "Heartbeat and teardown"): ``stop``, stdin EOF,
SIGTERM/SIGHUP/SIGINT, heartbeat timeout, and a mismatched ``hello``. Each
one runs the same idempotent ``Session.teardown`` and then exits, so
``docker run --rm`` removes the container without client action.
"""

import os
import signal
import sys
import threading
import time

from . import framing
from .dispatch import Dispatcher, Watchdog, diag, heartbeat_timeout_seconds
from .methods import Handlers
from .session import Session, StartupError

READY_DEADLINE_S = 9.0


class Shutdown:
    """First reason wins; the main thread waits for it and tears down."""

    def __init__(self):
        self.event = threading.Event()
        self.reason = None
        self._lock = threading.Lock()

    def request(self, reason):
        with self._lock:
            if self.reason is None:
                self.reason = reason
        self.event.set()


def _reader(stream, token, dispatcher, watchdog, shutdown):
    try:
        _read_loop(stream, token, dispatcher, watchdog)
    except Exception as exc:  # noqa: BLE001 - a dead reader must still end the session
        diag("stdin reader failed: %s" % exc)
        shutdown.request("stdin error")
    else:
        shutdown.request("stdin EOF")


def _read_loop(stream, token, dispatcher, watchdog):
    while True:
        line = stream.readline(framing.MAX_LINE_BYTES + 1)
        if not line:
            return
        watchdog.touch()
        if len(line) > framing.MAX_LINE_BYTES and not line.endswith(b"\n"):
            diag("dropping a line longer than 64 MiB")
            while line and not line.endswith(b"\n"):
                line = stream.readline(framing.MAX_LINE_BYTES + 1)
            continue
        try:
            message = framing.parse_line(line, token)
        except framing.FramingError as exc:
            diag("bad protocol line: %s" % exc)
            continue
        if message is None:
            continue
        dispatcher.submit(message)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) == 2 and argv[0] == "--probe":
        # Client checks of the host mode (probe.py): one JSON line, no protocol.
        from .probe import run

        return run(argv[1])
    if argv:
        diag("unexpected arguments %r (only --probe display|env)" % (argv,))
        return 2
    # The image's WORKDIR is /workspace (project files). Nothing the helper
    # runs itself (X tools, venv creation) should start there.
    try:
        os.chdir("/")
    except OSError:
        pass
    token = os.environ.get(framing.TOKEN_ENV, "")
    if not framing.valid_token(token):
        diag("%s must hold 32 hex characters" % framing.TOKEN_ENV)
        return 2

    # Reserve the real stdout for protocol lines and point fd 1 at stderr, so
    # stray writes from C libraries or inherited descriptors cannot corrupt
    # the protocol stream.
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    writer = framing.Writer(protocol_fd, token)

    shutdown = Shutdown()
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, lambda num, _frame: shutdown.request("signal %d" % num))
    # A client that disappears mid-write must not kill the helper before teardown.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    session = Session(writer)
    started = time.monotonic()
    try:
        session.start()
    except (StartupError, OSError, Exception) as exc:  # noqa: BLE001 - any startup failure is fatal
        diag("startup failed: %s" % exc)
        session.teardown()
        return 1
    if time.monotonic() - started > READY_DEADLINE_S:
        diag("startup took %.1f s" % (time.monotonic() - started))
    diag("display %s ready in %s" % (session.display, ", ".join("%s=%.2fs" % kv for kv in session.timings.items())))

    handlers = Handlers(session, shutdown.request)
    dispatcher = Dispatcher(writer, handlers.table())
    watchdog = Watchdog(heartbeat_timeout_seconds(os.environ), lambda: shutdown.request("heartbeat timeout"))
    writer.ready()
    watchdog.start()
    threading.Thread(target=_reader, args=(sys.stdin.buffer, token, dispatcher, watchdog, shutdown),
                     name="reader", daemon=True).start()

    while not shutdown.event.wait(0.5):
        pass
    diag("tearing down: %s" % shutdown.reason)
    watchdog.stop()
    dispatcher.close()
    leftovers = session.teardown()
    if leftovers:
        diag("leftovers after teardown: %r" % leftovers)
    try:
        os.close(protocol_fd)
    except OSError:
        pass
    # Worker threads may sit in blocking AT-SPI or subprocess calls; exit hard
    # once teardown is done instead of joining them.
    sys.stderr.flush()
    os._exit(0)
