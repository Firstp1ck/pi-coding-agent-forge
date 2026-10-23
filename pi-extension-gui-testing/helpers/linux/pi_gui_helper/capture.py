"""Screen and window capture.

Every capture reads the whole root window as raw 8-bit RGB, crops to the
target window's on-screen bounds when one is requested, hashes the unscaled
pixels, and encodes a PNG (downscaled so the long edge is at most ``maxEdge``).

``sha256`` is the SHA-256 of the unscaled RGB pixel bytes (row-major, no
header). Hashing pixels instead of PNG bytes keeps it stable across encoder
settings, so the client's usage check sees identical screens as identical.
"""

import base64
import hashlib
import shutil
import struct
import zlib

from .dispatch import ProtocolError
from .x11 import run_tool

DEFAULT_MAX_EDGE = 1280


def _magick(tool):
    """Resolve an ImageMagick tool: IM7 ``magick <tool>`` or the IM6 standalone name."""
    if shutil.which("magick"):
        return ["magick", tool] if tool != "convert" else ["magick"]
    return [tool]


def grab_root_rgb(env, width, height):
    """Raw RGB bytes of the whole screen (``width*height*3`` bytes)."""
    data = run_tool(_magick("import") + ["-silent", "-window", "root", "-depth", "8", "rgb:-"], env, timeout=15.0)
    expected = width * height * 3
    if len(data) != expected:
        raise ProtocolError("INTERNAL", "capture returned %d bytes, expected %d" % (len(data), expected))
    return data


def clip_bounds(bounds, screen_w, screen_h):
    """Intersect ``bounds`` with the screen; return None when nothing is visible."""
    x0 = max(0, bounds["x"])
    y0 = max(0, bounds["y"])
    x1 = min(screen_w, bounds["x"] + bounds["width"])
    y1 = min(screen_h, bounds["y"] + bounds["height"])
    if x1 <= x0 or y1 <= y0:
        return None
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def crop_rgb(data, screen_w, rect):
    stride = screen_w * 3
    left = rect["x"] * 3
    right = left + rect["width"] * 3
    rows = [data[(rect["y"] + row) * stride + left:(rect["y"] + row) * stride + right] for row in range(rect["height"])]
    return b"".join(rows)


def _chunk(kind, payload):
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(rgb, width, height):
    """Encode raw 8-bit RGB as a PNG (filter 0 on every row, no ancillary chunks)."""
    stride = width * 3
    if len(rgb) != stride * height:
        raise ValueError("rgb buffer does not match %dx%d" % (width, height))
    scanlines = b"".join(b"\x00" + rgb[row * stride:(row + 1) * stride] for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(scanlines, 6)) + _chunk(b"IEND", b"")


def scaled_size(width, height, max_edge):
    """Return ``(scale, out_w, out_h)`` so the long edge is at most ``max_edge`` (never upscales)."""
    long_edge = max(width, height)
    if long_edge <= max_edge:
        return 1, width, height
    scale = max_edge / float(long_edge)
    return scale, max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def resize_to_png(rgb, width, height, out_w, out_h, env):
    return run_tool(
        _magick("convert")
        + ["-size", "%dx%d" % (width, height), "-depth", "8", "rgb:-", "-resize", "%dx%d!" % (out_w, out_h),
           "-define", "png:exclude-chunks=date,time", "PNG24:-"],
        env,
        timeout=15.0,
        input_bytes=rgb,
    )


def build_capture(rgb, width, height, max_edge, env):
    """Return the screenshot result fields that depend only on the pixels."""
    scale, out_w, out_h = scaled_size(width, height, max_edge)
    if scale == 1:
        png = encode_png(rgb, width, height)
    else:
        png = resize_to_png(rgb, width, height, out_w, out_h, env)
    result = {
        "width": width,
        "height": height,
        "scale": scale,
        "png_base64": base64.b64encode(png).decode("ascii"),
        "sha256": hashlib.sha256(rgb).hexdigest(),
    }
    if not rgb.strip(b"\x00"):
        result["allBlack"] = True
    return result


def is_uniform(rgb):
    """True when every pixel has the same colour (used by tests and wait idle diagnostics)."""
    return len(rgb) < 3 or rgb == rgb[:3] * (len(rgb) // 3)
