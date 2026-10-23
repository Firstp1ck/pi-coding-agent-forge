"""Pointer and keyboard input through xdotool (XTEST) on the private display."""

from .dispatch import ProtocolError
from .x11 import run_tool

_BUTTONS = {"click": ("1", 1), "double_click": ("1", 2), "right_click": ("3", 1)}
_SCROLL_BUTTONS = {"up": "4", "down": "5", "left": "6", "right": "7"}
_TYPE_DELAY_MS = "12"


def pointer(action, x, y, env):
    """Move to screen point ``(x, y)`` and press the button for ``action``."""
    button, repeat = _BUTTONS[action]
    argv = ["xdotool", "mousemove", "--sync", str(int(x)), str(int(y)), "click"]
    if repeat > 1:
        argv += ["--repeat", str(repeat), "--delay", "80"]
    run_tool(argv + [button], env)


def move(x, y, env):
    run_tool(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))], env)


def type_text(text, env):
    if text:
        run_tool(["xdotool", "type", "--clearmodifiers", "--delay", _TYPE_DELAY_MS, "--", text], env,
                 timeout=max(5.0, len(text) * 0.05 + 5.0))


def key(text, env):
    """Send a key or chord sequence in xdotool syntax, e.g. ``"ctrl+a BackSpace Return"``."""
    keys = (text or "").split()
    if not keys:
        raise ProtocolError("BAD_REQUEST", "key needs text such as \"Return\" or \"ctrl+s\"")
    run_tool(["xdotool", "key", "--clearmodifiers", "--"] + keys, env)


def parse_scroll(text):
    """Parse ``"down"``, ``"up 3"``, ... into ``(button, count)``; default is one step down."""
    parts = (text or "down").split()
    direction = parts[0].lower()
    if direction not in _SCROLL_BUTTONS:
        raise ProtocolError("BAD_REQUEST", "scroll text must be up, down, left, or right, optionally with a count")
    count = 1
    if len(parts) > 1:
        if not parts[1].isdigit() or not 1 <= int(parts[1]) <= 100:
            raise ProtocolError("BAD_REQUEST", "scroll count must be 1-100")
        count = int(parts[1])
    return _SCROLL_BUTTONS[direction], count


def scroll(text, env):
    button, count = parse_scroll(text)
    run_tool(["xdotool", "click", "--repeat", str(count), "--delay", "40", button], env)
