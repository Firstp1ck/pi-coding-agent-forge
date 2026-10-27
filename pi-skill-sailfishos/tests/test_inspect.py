#!/usr/bin/env python3
"""Inventory safety checks; external service/repo commands are mocked."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / "skills" / "sailfishos"
SCRIPT = ROOT / "scripts" / "inspect.sh"


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.log = self.directory / "calls"
        fake_ssu = self.directory / "ssu"
        fake_ssu.write_text("""#!/bin/sh
printf 'ssu %s\\n' "$*" >> "$TEST_LOG"
[ "$*" = lr ] || exit 55
printf '%s\\n' "${TEST_REPOSITORY:- - custom ... https://alice:secret@repo.example/path?token=private#fragment}"
""")
        fake_ssu.chmod(0o755)
        fake_systemctl = self.directory / "systemctl"
        fake_systemctl.write_text("""#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
 --version) printf 'systemd test\\n' ;;
 *is-active*) printf 'inactive\\n'; exit 3 ;;
 *) exit 56 ;;
esac
""")
        fake_systemctl.chmod(0o755)
        fake_rpm = self.directory / "rpm"
        fake_rpm.write_text("""#!/bin/sh
printf 'rpm %s\\n' "$*" >> "$TEST_LOG"
[ "$1" = -q ] || exit 57
printf 'example-package-version\\n'
""")
        fake_rpm.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.directory) + ":" + os.environ["PATH"],
                        TEST_LOG=str(self.log))

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, *args):
        return subprocess.run(["/bin/sh", str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def test_help_does_not_inspect(self):
        self.assertEqual(self.run_helper("--help").returncode, 0)
        self.assertFalse(self.log.exists())

    def test_invalid_argument_does_not_inspect(self):
        self.assertEqual(self.run_helper("--install").returncode, 2)
        self.assertFalse(self.log.exists())

    @unittest.skipUnless(
        Path("/etc/os-release").exists() and
        "sailfishos" in Path("/etc/os-release").read_text(),
        "Full inspection is intentionally restricted to Sailfish OS")
    def test_redaction_and_read_only_invocations(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        for secret in ("alice", "secret", "token=private", "#fragment"):
            self.assertNotIn(secret, result.stdout)
        self.assertIn("https://[redacted]@repo.example/path[redacted]", result.stdout)
        calls = self.log.read_text().splitlines()
        self.assertIn("ssu lr", calls)
        self.assertTrue(all(
            line == "ssu lr" or line.startswith("rpm -q ") or
            line == "systemctl --version" or
            line.startswith("systemctl is-active ") or
            line.startswith("systemctl --user is-active ")
            for line in calls), calls)

    @unittest.skipUnless(
        Path("/etc/os-release").exists() and
        "sailfishos" in Path("/etc/os-release").read_text(),
        "Full inspection is intentionally restricted to Sailfish OS")
    def test_uri_scheme_redaction_and_read_only_invocations(self):
        for scheme in ("HTTPS", "hTtPs", "ftp", "sftp", "git+ssh", "X1+repo.-"):
            for suffix in ("?token=private#fragment", "?token=private", "#fragment"):
                with self.subTest(scheme=scheme, suffix=suffix):
                    if self.log.exists():
                        self.log.unlink()
                    self.env["TEST_REPOSITORY"] = (
                        f" - custom ... {scheme}://alice:secret@repo.example/path{suffix}")
                    result = self.run_helper()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.log.read_text().splitlines(), [
                        "rpm -q glibc qt5-qtcore qt5-qtdeclarative busybox bash systemd "
                        "sailfishos-chum-repo-config sailfishos-chum-gui",
                        "ssu lr",
                        "systemctl --version",
                        "systemctl is-active packagekit.service",
                        "systemctl is-active connman.service",
                        "systemctl is-active ofono.service",
                        "systemctl is-active mce.service",
                        "systemctl is-active dsme.service",
                        "systemctl is-active sshd.service",
                        "systemctl --user is-active lipstick.service",
                        "systemctl --user is-active pulseaudio.service",
                    ])
                    for secret in ("alice", "secret", "token=private", "#fragment"):
                        self.assertNotIn(secret, result.stdout)
                    self.assertIn(
                        f"{scheme}://[redacted]@repo.example/path[redacted]",
                        result.stdout)


if __name__ == "__main__":
    unittest.main()
