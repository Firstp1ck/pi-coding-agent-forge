"""X11 queries on the private Xvfb display via xprop, xwininfo, and xdotool.

Window refs are ``win:<hex X id>``. They stay valid as long as the window
exists (unlike snapshot refs), because X ids are not reused within a session's
short lifetime in practice; a vanished window answers ``NOT_FOUND``.
"""

import re
import subprocess

from .dispatch import ProtocolError

WINDOW_REF_PREFIX = "win:"
_TOOL_TIMEOUT_S = 5.0


def run_tool(argv, env, timeout=_TOOL_TIMEOUT_S, input_bytes=None):
    """Run an X tool with the session environment; return stdout bytes or raise INTERNAL."""
    try:
        proc = subprocess.run(
            argv,
            env=env,
            input=input_bytes,
            stdin=None if input_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ProtocolError("INTERNAL", "%s timed out after %.0f s" % (argv[0], timeout)) from None
    except OSError as exc:
        raise ProtocolError("INTERNAL", "%s failed to start: %s" % (argv[0], exc)) from None
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise ProtocolError("INTERNAL", "%s exited %d: %s" % (argv[0], proc.returncode, err[:500]))
    return proc.stdout


def window_ref(xid):
    return "%s0x%x" % (WINDOW_REF_PREFIX, xid)


def parse_window_ref(ref):
    """Return the X id of a ``win:0x…`` ref, or None when ``ref`` is not a window ref."""
    if not isinstance(ref, str) or not ref.startswith(WINDOW_REF_PREFIX):
        return None
    try:
        return int(ref[len(WINDOW_REF_PREFIX):], 16)
    except ValueError:
        raise ProtocolError("BAD_REQUEST", "malformed window ref %r" % ref) from None


def screen_size(env):
    out = run_tool(["xdotool", "getdisplaygeometry"], env).decode().split()
    return int(out[0]), int(out[1])


_ID_RE = re.compile(r"0x[0-9a-fA-F]+")


def client_window_ids(env):
    """Managed top-level windows in stacking order, from openbox's ``_NET_CLIENT_LIST``."""
    try:
        out = run_tool(["xprop", "-root", "_NET_CLIENT_LIST"], env).decode("utf-8", "replace")
    except ProtocolError:
        return []
    if "not found" in out or "no such atom" in out:
        return []
    return [int(match, 16) for match in _ID_RE.findall(out.split("=", 1)[-1])]


_GEOM_KEYS = {
    "Absolute upper-left X": "x",
    "Absolute upper-left Y": "y",
    "Width": "width",
    "Height": "height",
}


def parse_xwininfo(text):
    """Extract absolute bounds and map state from ``xwininfo -id`` output."""
    bounds = {}
    viewable = False
    for line in text.splitlines():
        key, _, value = line.strip().partition(":")
        if key in _GEOM_KEYS:
            bounds[_GEOM_KEYS[key]] = int(value.strip())
        elif key == "Map State":
            viewable = value.strip() == "IsViewable"
    if len(bounds) != 4:
        return None, viewable
    return bounds, viewable


def _title(xid, env):
    try:
        out = run_tool(["xprop", "-id", "0x%x" % xid, "_NET_WM_NAME", "WM_NAME"], env).decode("utf-8", "replace")
    except ProtocolError:
        return ""
    for line in out.splitlines():
        _, sep, value = line.partition(" = ")
        if sep and value.startswith('"'):
            return _unquote(value)
    return ""


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    return value.replace('\\"', '"').replace("\\\\", "\\")


def window_info(xid, env):
    """``WindowInfo`` for one X window, or None when it is gone or not viewable."""
    try:
        text = run_tool(["xwininfo", "-id", "0x%x" % xid], env).decode("utf-8", "replace")
    except ProtocolError:
        return None
    bounds, viewable = parse_xwininfo(text)
    if bounds is None or not viewable:
        return None
    return {"ref": window_ref(xid), "title": _title(xid, env), "bounds": bounds}


def list_windows(env):
    """All viewable managed top-level windows on the private display."""
    windows = []
    for xid in client_window_ids(env):
        info = window_info(xid, env)
        if info is not None:
            windows.append(info)
    return windows


def window_pids(xid, env):
    try:
        out = run_tool(["xprop", "-id", "0x%x" % xid, "_NET_WM_PID"], env).decode()
    except ProtocolError:
        return None
    match = re.search(r"=\s*(\d+)", out)
    return int(match.group(1)) if match else None


def activate(xid, env):
    """Raise and focus a window; best effort because some clients refuse focus."""
    try:
        run_tool(["xdotool", "windowactivate", "--sync", "0x%x" % xid], env, timeout=3.0)
    except ProtocolError:
        pass
