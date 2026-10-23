"""Ad-hoc debugging driver: start one session, launch the smoke app, print a snapshot."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from client import Helper  # noqa: E402

with Helper("w2-test-quick") as h:
    print("ready", round(h.ready_after, 2))
    print(h.call("hello", {"protocol": 1, "packageVersion": "0.1.0"}))
    print("launch", h.call("launch", {"cmd": "python3", "args": ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"], "env": {}, "cwd": "/workspace"}))
    s = h.call("snapshot", {"maxNodes": 50})
    print(s["coverage"], s["truncated"])
    for node in s["tree"]:
        print(node)
    print(h.call("stop"))
print("stderr:", "".join(h.stderr_lines)[-1500:])
