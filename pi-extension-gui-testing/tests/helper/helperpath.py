"""Put the helper package on sys.path: the image copy, else the source tree."""
import os
import sys

_CANDIDATES = (
    "/opt/pi-gui-testing/lib",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "helpers", "linux")),
)
for _path in _CANDIDATES:
    if os.path.isdir(os.path.join(_path, "pi_gui_helper")):
        sys.path.insert(0, _path)
        break
