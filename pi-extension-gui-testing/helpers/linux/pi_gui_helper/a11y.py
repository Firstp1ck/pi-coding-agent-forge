"""Accessibility snapshots over the session's private AT-SPI bus.

Import this module only after ``DBUS_SESSION_BUS_ADDRESS`` points at the
private bus: libatspi connects to the accessibility bus it finds there.

Refs are ``<snapshotId>:<n>`` where ``n`` indexes the snapshot's node list;
only the most recent snapshot resolves (older refs fail with ``STALE_REF``).
"""

import base64
import gzip
import json

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

import pyatspi  # noqa: E402,F401  - the image contract promises pyatspi; importing it also initialises Atspi

from .dispatch import ProtocolError  # noqa: E402

# A hung app must not hang the helper: bound every AT-SPI call.
_CALL_TIMEOUT_MS = 1500
_STARTUP_TIMEOUT_MS = 3000
WALK_CAP = 20000
_MAX_CHILDREN = 2000
_MAX_VALUE_CHARS = 2000

_TOPLEVEL_ROLES = {"frame", "window", "dialog", "alert", "file chooser"}
_TEXT_VALUE_ROLES = {"text", "entry", "password text", "terminal", "document text", "spin button", "combo box"}

_initialised = False


def init():
    global _initialised
    if _initialised:
        return
    Atspi.init()
    try:
        Atspi.set_timeout(_CALL_TIMEOUT_MS, _STARTUP_TIMEOUT_MS)
    except (AttributeError, TypeError):
        pass
    _initialised = True


def _applications():
    desktop = Atspi.get_desktop(0)
    apps = []
    for index in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(index)
        except GLib.Error:
            continue
        if app is None:
            continue
        # Without a running main loop libatspi never sees change events, so
        # cached names and states would go stale; drop the cache on every
        # walk. (set_cache_mask(Atspi.Cache.NONE) would be the direct fix,
        # but it makes every later call on the app block in libatspi 2.56.)
        try:
            app.clear_cache()
        except (AttributeError, GLib.Error):
            pass
        apps.append(app)
    return apps


def _interfaces(acc):
    try:
        return set(acc.get_interfaces())
    except (GLib.Error, TypeError):
        return set()


def _states(acc):
    try:
        return [state.value_nick for state in acc.get_state_set().get_states()]
    except (GLib.Error, AttributeError):
        return []


def _bounds(acc, ifaces, offset=None):
    """Screen bounds of ``acc``.

    ``offset`` is set for toolkits whose SCREEN extents are wrong on X11
    (GTK 4 reports them without the window position): the bounds are then
    the WINDOW extents plus the toplevel's on-screen origin. ``False`` means
    such an app whose window could not be matched, so bounds are unknown.
    """
    if "Component" not in ifaces or offset is False:
        return None
    coord = Atspi.CoordType.SCREEN if offset is None else Atspi.CoordType.WINDOW
    try:
        ext = acc.get_extents(coord)
    except GLib.Error:
        return None
    if ext.width <= 0 or ext.height <= 0 or ext.x <= -(2 ** 30) or ext.y <= -(2 ** 30):
        return None
    dx, dy = offset if offset else (0, 0)
    return {"x": ext.x + dx, "y": ext.y + dy, "width": ext.width, "height": ext.height}


def _window_relative(app):
    """True for toolkits whose SCREEN extents lack the window origin on X11 (GTK 4)."""
    try:
        return app.get_toolkit_name() == "GTK" and (app.get_toolkit_version() or "").startswith("4.")
    except (GLib.Error, AttributeError):
        return False


def _toplevel_offset(acc, windows, claimed):
    """Origin of the X window matching a toplevel accessible by title and size, or False."""
    try:
        name = acc.get_name() or ""
        ext = acc.get_extents(Atspi.CoordType.WINDOW)
    except GLib.Error:
        return False
    for info in windows:
        b = info["bounds"]
        if info["ref"] in claimed or info["title"] != name:
            continue
        if (b["width"], b["height"]) == (ext.width, ext.height):
            claimed.add(info["ref"])
            return (b["x"], b["y"])
    return False


def _value(acc, role, ifaces):
    if "Text" in ifaces and (role in _TEXT_VALUE_ROLES or "EditableText" in ifaces):
        try:
            text = acc.get_text(0, _MAX_VALUE_CHARS)
        except (GLib.Error, TypeError):
            text = None
        if text is not None:
            return text
    if "Value" in ifaces:
        try:
            return "%g" % acc.get_current_value()
        except (GLib.Error, TypeError):
            return None
    return None


def describe(acc, offset=None):
    """Node fields for one accessible, without ``ref``/``parent``; None when defunct."""
    try:
        role = acc.get_role_name() or "unknown"
        name = acc.get_name() or ""
    except GLib.Error:
        return None
    states = _states(acc)
    if "defunct" in states:
        return None
    ifaces = _interfaces(acc)
    node = {"role": role, "name": name, "states": states}
    value = _value(acc, role, ifaces)
    if value is not None and value != name:
        node["value"] = value
    bounds = _bounds(acc, ifaces, offset)
    if bounds is not None:
        node["bounds"] = bounds
    return node


def walk(cap=WALK_CAP, check=None, windows=()):
    """Breadth-first walk of every application's tree.

    Returns ``(entries, toplevels)`` where each entry is
    ``(accessible, node_fields, parent_index, offset)``; ``offset`` is the
    coordinate correction for window-relative toolkits (see ``_bounds``).
    ``windows`` are the X windows used to place those toolkits' toplevels. Breadth-first order puts
    windows and their main structure first, so truncation to ``maxNodes`` keeps
    the useful top of every app.
    """
    init()
    entries = []
    # Queue items: (accessible, parent index, offset, app is window-relative).
    queue = [(app, None, None, _window_relative(app)) for app in _applications()]
    claimed = set()
    toplevels = 0
    head = 0
    while head < len(queue) and len(entries) < cap:
        if check is not None and head % 50 == 0:
            check()
        acc, parent, offset, relative = queue[head]
        head += 1
        if relative and parent is not None and entries[parent][1]["role"] == "application":
            offset = _toplevel_offset(acc, windows, claimed)
        node = describe(acc, offset)
        if node is None:
            continue
        index = len(entries)
        entries.append((acc, node, parent, offset))
        # Any visible direct child of an application is a toplevel: Qt reports
        # its main widget with roles outside _TOPLEVEL_ROLES (e.g. "filler").
        if parent is not None and entries[parent][1]["role"] == "application":
            if node["role"] in _TOPLEVEL_ROLES or "showing" in node["states"] or "visible" in node["states"]:
                toplevels += 1
        try:
            count = min(acc.get_child_count(), _MAX_CHILDREN)
        except GLib.Error:
            continue
        for child_index in range(count):
            try:
                child = acc.get_child_at_index(child_index)
            except GLib.Error:
                continue
            if child is not None:
                queue.append((child, index, offset, relative))
    return entries, toplevels


def coverage(x_windows, a11y_toplevels, node_count):
    """Map window/tree counts to ``full`` / ``partial`` / ``none``.

    ``none``: windows exist but no app exposes a visible top-level (e.g. Tk),
    or nothing is on screen at all. ``partial``: fewer accessible top-levels
    than X windows. ``full``: every window has an accessible counterpart.
    """
    if a11y_toplevels == 0 or node_count == 0:
        return "none"
    if a11y_toplevels < x_windows:
        return "partial"
    return "full"


class SnapshotStore:
    """Holds the latest snapshot and resolves refs against it."""

    def __init__(self):
        self._counter = 0
        self.current_id = None
        self._objects = []
        self._offsets = []
        self._nodes = []
        self._full = {}

    def take(self, max_nodes, windows, check=None):
        entries, toplevels = walk(check=check, windows=windows)
        self._counter += 1
        sid = "s%d" % self._counter
        nodes = []
        for index, (_, fields, parent, _offset) in enumerate(entries):
            node = {"ref": "%s:%d" % (sid, index)}
            node.update(fields)
            if parent is not None:
                node["parent"] = "%s:%d" % (sid, parent)
            nodes.append(node)
        self.current_id = sid
        self._objects = [entry[0] for entry in entries]
        self._offsets = [entry[3] for entry in entries]
        self._nodes = nodes
        # Keep only the latest full tree: snapshotFull is called right after
        # snapshot to dump it, and older trees would only hold memory.
        self._full = {sid: nodes}
        limit = max(0, max_nodes)
        return {
            "snapshotId": sid,
            "coverage": coverage(len(windows), toplevels, len(nodes)),
            "tree": nodes[:limit],
            "truncated": len(nodes) > limit,
        }

    def full(self, snapshot_id):
        nodes = self._full.get(snapshot_id)
        if nodes is None:
            raise ProtocolError("STALE_REF", "unknown or stale snapshotId %r, take a new snapshot" % snapshot_id)
        data = json.dumps(nodes, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return {"tree_gz_base64": base64.b64encode(gzip.compress(data, mtime=0)).decode("ascii")}

    def resolve(self, ref):
        """Return ``(accessible, node, offset)`` for ``ref`` or raise STALE_REF / NOT_FOUND / BAD_REQUEST."""
        sid, index = parse_ref(ref)
        if sid != self.current_id:
            raise ProtocolError("STALE_REF", "stale ref, take a new snapshot")
        if index >= len(self._objects):
            raise ProtocolError("NOT_FOUND", "ref %s is not in the snapshot" % ref)
        acc = self._objects[index]
        if describe(acc, self._offsets[index]) is None:
            raise ProtocolError("STALE_REF", "element no longer exists, take a new snapshot")
        return acc, self._nodes[index], self._offsets[index]


def parse_ref(ref):
    """Split ``<snapshotId>:<n>``; raise BAD_REQUEST when malformed."""
    if not isinstance(ref, str) or ":" not in ref:
        raise ProtocolError("BAD_REQUEST", "malformed ref %r" % (ref,))
    sid, _, num = ref.rpartition(":")
    if not sid or not num.isdigit():
        raise ProtocolError("BAD_REQUEST", "malformed ref %r" % (ref,))
    return sid, int(num)


def live_bounds(acc, offset=None):
    """Current on-screen bounds of an accessible, or None."""
    return _bounds(acc, _interfaces(acc), offset)


def find_text(text, check=None, cap=5000):
    """True when any accessible name or value contains ``text``."""
    entries, _ = walk(cap=cap, check=check)
    for _, node, _, _ in entries:
        if text in node["name"] or text in node.get("value", ""):
            return True
    return False


def do_named_action(acc, names):
    """Run the first AT-SPI action whose name is in ``names``; return True on success."""
    try:
        count = acc.get_n_actions()
    except (GLib.Error, AttributeError, TypeError):
        return False
    available = {}
    for index in range(count):
        try:
            available.setdefault((acc.get_action_name(index) or "").lower(), index)
        except GLib.Error:
            continue
    for name in names:
        if name in available:
            try:
                return bool(acc.do_action(available[name]))
            except GLib.Error:
                return False
    return False


def grab_focus(acc):
    try:
        return bool(acc.grab_focus())
    except (GLib.Error, AttributeError, TypeError):
        return False


def set_value(acc, text):
    """Set text via EditableText, or a number via Value. Raise BAD_REQUEST when neither applies."""
    ifaces = _interfaces(acc)
    if "EditableText" in ifaces:
        try:
            if acc.set_text_contents(text):
                return
        except GLib.Error as exc:
            raise ProtocolError("INTERNAL", "set_text_contents failed: %s" % exc.message) from None
    if "Value" in ifaces:
        try:
            number = float(text)
        except (TypeError, ValueError):
            raise ProtocolError("BAD_REQUEST", "set_value on a numeric element needs a number") from None
        try:
            if acc.set_current_value(number):
                return
        except GLib.Error as exc:
            raise ProtocolError("INTERNAL", "set_current_value failed: %s" % exc.message) from None
    raise ProtocolError("BAD_REQUEST", "element has no editable text or value")
