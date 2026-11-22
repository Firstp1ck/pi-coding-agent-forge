#!/usr/bin/env python3
"""Build the base image from a staged tar context (reference for the TS backend).

The context holds only package tooling: ``helpers/linux/{Dockerfile,
.dockerignore,helper,pi_gui_helper/}`` at its root and
``testapps/gtk3-smoke/`` below it. No project file ever enters it.

Usage: build_image.py [--tag pi-gui-testing-base:dev] [--version 0.1.0] [--protocol 2]
"""

import argparse
import io
import os
import subprocess
import sys
import tarfile

PACKAGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HELPER_DIR = os.path.join(PACKAGE_ROOT, "helpers", "linux")
SMOKE_DIR = os.path.join(PACKAGE_ROOT, "testapps", "gtk3-smoke")


def _add_tree(tar, src, arcname):
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        rel = os.path.relpath(root, src)
        base = arcname if rel == "." else os.path.join(arcname, rel)
        for name in sorted(files):
            if name.endswith(".pyc"):
                continue
            _add_file(tar, os.path.join(root, name), os.path.join(base, name))


def _add_file(tar, path, arcname):
    info = tar.gettarinfo(path, arcname)
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = 0
    info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
    with open(path, "rb") as handle:
        tar.addfile(info, handle)


def build_context():
    """Return the context tar as bytes."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name in ("Dockerfile", ".dockerignore", "helper"):
            _add_file(tar, os.path.join(HELPER_DIR, name), name)
        _add_tree(tar, os.path.join(HELPER_DIR, "pi_gui_helper"), "pi_gui_helper")
        _add_tree(tar, SMOKE_DIR, "testapps/gtk3-smoke")
    return buffer.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="pi-gui-testing-base:dev")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--protocol", default="2")
    parser.add_argument("--list", action="store_true", help="print the context member names and exit")
    args = parser.parse_args(argv)
    context = build_context()
    if args.list:
        with tarfile.open(fileobj=io.BytesIO(context)) as tar:
            print("\n".join(tar.getnames()))
        return 0
    cmd = ["docker", "build", "--build-arg", "PACKAGE_VERSION=" + args.version,
           "--build-arg", "PROTOCOL_VERSION=" + args.protocol, "-t", args.tag, "-"]
    return subprocess.run(cmd, input=context, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
