"""Venv creation never runs project code (Q1): planted modules in the cwd stay inert."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import session

TOKEN = "0123456789abcdef0123456789abcdef"

PLANTED = """
import os, sys
with open(os.environ.get("PLANT_MARKER") or %r, "w") as fh:
    fh.write(os.environ.get("PI_GUI_TESTING_TOKEN", "no-token"))
sys.exit(0)
"""


class VenvIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pi-gui-venv-test-")
        self.workspace = os.path.join(self.tmp, "workspace")
        os.mkdir(self.workspace)
        self.marker = os.path.join(self.tmp, "planted-ran")
        for name in ("venv.py", "ensurepip.py", "site.py", "sitecustomize.py", "usercustomize.py"):
            with open(os.path.join(self.workspace, name), "w") as fh:
                fh.write(PLANTED % self.marker)
        self.old_cwd = os.getcwd()
        self.old_venv = session.VENV_DIR
        os.chdir(self.workspace)

    def tearDown(self):
        os.chdir(self.old_cwd)
        session.VENV_DIR = self.old_venv
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unsafe_command_would_run_the_planted_module(self):
        # Control: the pre-Q1 command line executes workspace code from the cwd.
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", os.path.join(self.tmp, "v0")],
                       env={"PATH": os.environ.get("PATH", ""), "PI_GUI_TESTING_TOKEN": TOKEN},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)
        self.assertTrue(os.path.exists(self.marker))

    def test_ensure_venv_ignores_planted_modules_and_hides_the_token(self):
        session.VENV_DIR = os.path.join(self.tmp, "deps", "venv")
        environ = {
            "PATH": os.environ.get("PATH", ""),
            "PI_GUI_TESTING_TOKEN": TOKEN,
            "PYTHONPATH": self.workspace,
            "PYTHONSTARTUP": os.path.join(self.workspace, "venv.py"),
            "PYTHONHOME": self.workspace,
            "PLANT_MARKER": self.marker,
            "LANG": "C.UTF-8",
        }
        sess = session.Session(writer=None, environ=environ)
        sess.ensure_venv()
        self.assertFalse(os.path.exists(self.marker), "a module planted in the cwd ran during venv creation")
        self.assertTrue(os.path.exists(os.path.join(session.VENV_DIR, "bin", "python")))

    def test_argv_and_env(self):
        self.assertEqual(session.venv_argv("/usr/bin/python3", "/deps/venv"),
                         ["/usr/bin/python3", "-I", "-m", "venv", "--system-site-packages", "/deps/venv"])
        env = session.venv_env({"PI_GUI_TESTING_TOKEN": TOKEN, "PYTHONPATH": "/workspace",
                                "PATH": "/workspace/bin", "LANG": "C.UTF-8", "HOME": "/workspace"})
        self.assertNotIn("PI_GUI_TESTING_TOKEN", env)
        self.assertFalse([k for k in env if k.startswith("PYTHON")])
        self.assertNotIn("/workspace", env["PATH"])
        self.assertNotIn("/workspace", env["HOME"])
        self.assertEqual(env["LANG"], "C.UTF-8")


if __name__ == "__main__":
    unittest.main()
