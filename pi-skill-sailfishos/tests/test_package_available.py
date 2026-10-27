#!/usr/bin/env python3
"""Offline tests for the read-only PackageKit helper; no real transactions."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / "skills" / "sailfishos"
SCRIPT = ROOT / "scripts" / "package-available.sh"


class PackageAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.log = self.directory / "queries.log"
        mock = self.directory / "pkcon"
        mock.write_text("""#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_QUERY_LOG"
[ "$LC_ALL" = C ] || exit 44
[ "$1" = --plain ] && [ "$2" = --filter ] && [ "$3" = '~source' ] && [ "$4" = resolve ] || exit 45
case "$5" in
 installed) printf 'Installed    installed-1.0.aarch64 (installed)\\n' ;;
 available|libfoo+bar) printf 'Available    %s-1.0.aarch64 (chum)\\n' "$5" ;;
 missing) printf 'Transaction: Resolving\\nResults:\\n' ;;
 fail) printf 'Fatal error: query unavailable\\n' >&2; exit 7 ;;
 *) printf 'Results:\\n' ;;
esac
""")
        mock.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.directory) + ":" + os.environ["PATH"],
                        TEST_QUERY_LOG=str(self.log), LC_ALL="de_DE.UTF-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, *args):
        return subprocess.run(["/bin/sh", str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def test_installed_and_available(self):
        result = self.run_helper("installed", "available", "libfoo+bar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.log.read_text().splitlines()), 3)

    def test_missing_even_when_pkcon_returns_success(self):
        result = self.run_helper("missing")
        self.assertEqual(result.returncode, 3)
        self.assertIn("No installed or available", result.stderr)

    def test_checks_remaining_names_after_missing(self):
        result = self.run_helper("missing", "available")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(len(self.log.read_text().splitlines()), 2)

    def test_query_failure_not_reported_as_missing(self):
        result = self.run_helper("fail", "available")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown", result.stderr)
        self.assertEqual(len(self.log.read_text().splitlines()), 1)

    def test_invalid_arguments_never_query(self):
        for name in ("--allow-untrusted", "bad;name", "two words", "$(id)", "", "a/b", "*"):
            with self.subTest(name=name):
                result = self.run_helper("available", name)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.log.exists())

    def test_missing_pkcon(self):
        (self.directory / "pkcon").unlink()
        self.env["PATH"] = str(self.directory)
        result = self.run_helper("available")
        self.assertEqual(result.returncode, 1)
        self.assertIn("pkcon unavailable", result.stderr)
        self.assertFalse(self.log.exists())

    def test_no_arguments(self):
        self.assertEqual(self.run_helper().returncode, 2)
        self.assertFalse(self.log.exists())

    def test_help(self):
        self.assertEqual(self.run_helper("--help").returncode, 0)
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
