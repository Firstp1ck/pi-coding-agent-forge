"""Dependency-cache transfers (protocol 2): pack/unpack roundtrip and malicious archives."""
import base64
import hashlib
import io
import os
import shutil
import stat
import tarfile
import tempfile
import unittest

import helperpath  # noqa: F401
from pi_gui_helper import deps, hostmode, methods
from pi_gui_helper.dispatch import ProtocolError


class Ctx:
    def __init__(self):
        self.cancelled = False

    def check(self):
        if self.cancelled:
            from pi_gui_helper.dispatch import Cancelled

            raise Cancelled()


def gz_tar(build):
    """A gzip tar built by ``build(tar)`` (raw tarfile access, so malicious members are possible)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        build(tar)
    return buf.getvalue()


def add_file(tar, name, data=b"x", mode=0o644, kind=tarfile.REGTYPE):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = len(data) if kind in (tarfile.REGTYPE, tarfile.AREGTYPE) else 0
    info.mode = mode
    tar.addfile(info, io.BytesIO(data) if info.size else None)


def add_entry(tar, name, kind, linkname="", mode=0o755):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    info.mode = mode
    tar.addfile(info)


class DepsTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pi-gui-deps-test-")
        self.src = os.path.join(self.tmp, "src")
        self.dst = os.path.join(self.tmp, "dst")
        self.outside = os.path.join(self.tmp, "outside")
        self.transfer_tmp = os.path.join(self.tmp, "transfer")
        for path in (self.src, self.dst, self.outside, self.transfer_tmp):
            os.mkdir(path)
        self.unpacked = 0

        def on_unpacked():
            self.unpacked += 1

        self.packer = deps.Transfers(lambda: self.src, tmp_dir=self.transfer_tmp)
        self.unpacker = deps.Transfers(lambda: self.dst, tmp_dir=self.transfer_tmp, on_unpacked=on_unpacked)

    def tearDown(self):
        for t in (self.packer, self.unpacker):
            t.close()
        for root, dirs, _ in os.walk(self.tmp):
            for d in dirs:
                try:
                    os.chmod(os.path.join(root, d), 0o700)
                except OSError:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def pull(self, transfer, size, chunk=7):
        data = b""
        offset = 0
        while True:
            part = self.packer.read(Ctx(), {"transfer": transfer, "offset": offset, "length": chunk})
            piece = base64.b64decode(part["data_base64"])
            data += piece
            offset += len(piece)
            if part["eof"]:
                break
        self.assertEqual(len(data), size)
        return data

    def push(self, archive, sha=None, size=None, chunk=5, max_bytes=10 ** 9, max_entries=10 ** 6):
        sha = sha or hashlib.sha256(archive).hexdigest()
        transfer = self.unpacker.receive(Ctx(), {"size": size or len(archive), "sha256": sha})["transfer"]
        for offset in range(0, len(archive), chunk):
            self.unpacker.write(Ctx(), {"transfer": transfer, "offset": offset,
                                        "data_base64": base64.b64encode(archive[offset:offset + chunk]).decode("ascii")})
        return self.unpacker.unpack(Ctx(), {"transfer": transfer, "maxUnpackedBytes": max_bytes, "maxEntries": max_entries})

    def assertRejected(self, archive, code="ARCHIVE_REJECTED", **kwargs):
        with open(os.path.join(self.dst, "stale"), "w") as fh:
            fh.write("old")
        with self.assertRaises(ProtocolError) as caught:
            self.push(archive, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.message)
        self.assertEqual(os.listdir(self.dst), [], "the deps dir must be left empty")
        self.assertEqual(os.listdir(self.outside), [], "nothing may be written outside the deps dir")
        return caught.exception


class RoundtripTests(DepsTestBase):
    def build_tree(self):
        os.makedirs(os.path.join(self.src, "venv", "lib", "site-packages", "pkg"))
        with open(os.path.join(self.src, "venv", "lib", "site-packages", "pkg", "__init__.py"), "w") as fh:
            fh.write("VALUE = 42\n")
        os.makedirs(os.path.join(self.src, "venv", "bin"))
        script = os.path.join(self.src, "venv", "bin", "tool")
        with open(script, "w") as fh:
            fh.write("#!/deps/venv/bin/python\n")
        os.chmod(script, 0o4755)  # setuid is stripped on the way
        os.symlink("lib", os.path.join(self.src, "venv", "lib64"))
        os.symlink("/usr/bin/python3", os.path.join(self.src, "venv", "bin", "python"))  # escapes: skipped
        os.symlink(os.path.join(self.src, "venv", "lib"), os.path.join(self.src, "venv", "abs-inside"))  # made relative
        os.symlink("../../outside", os.path.join(self.src, "venv", "escape"))  # escapes: skipped
        os.mkfifo(os.path.join(self.src, "fifo"))  # special file: skipped
        os.utime(os.path.join(self.src, "venv", "lib", "site-packages", "pkg", "__init__.py"), (1_600_000_000, 1_600_000_000))

    def test_pack_then_unpack_reproduces_the_tree_without_escaping_links(self):
        self.build_tree()
        packed = self.packer.pack(Ctx(), {"maxBytes": 10 ** 8})
        self.assertEqual(packed["skipped"], 3)
        self.assertRegex(packed["sha256"], r"^[0-9a-f]{64}$")
        archive = self.pull(packed["transfer"], packed["size"])
        self.assertEqual(hashlib.sha256(archive).hexdigest(), packed["sha256"])
        os.makedirs(os.path.join(self.dst, "venv", "bin"))  # e.g. the venv the helper created before setup
        with open(os.path.join(self.dst, "venv", "bin", "old"), "w") as fh:
            fh.write("stale")
        result = self.push(archive)
        self.assertEqual(result["entries"], packed["entries"])
        self.assertEqual(self.unpacked, 1)
        pkg = os.path.join(self.dst, "venv", "lib", "site-packages", "pkg", "__init__.py")
        with open(pkg) as fh:
            self.assertEqual(fh.read(), "VALUE = 42\n")
        self.assertEqual(int(os.stat(pkg).st_mtime), 1_600_000_000)
        self.assertFalse(os.path.exists(os.path.join(self.dst, "venv", "bin", "old")), "unpack replaces the deps dir")
        self.assertEqual(os.readlink(os.path.join(self.dst, "venv", "lib64")), "lib")
        self.assertEqual(os.readlink(os.path.join(self.dst, "venv", "abs-inside")), "lib")
        self.assertFalse(os.path.lexists(os.path.join(self.dst, "venv", "bin", "python")))
        self.assertFalse(os.path.lexists(os.path.join(self.dst, "venv", "escape")))
        self.assertFalse(os.path.lexists(os.path.join(self.dst, "fifo")))
        tool = os.stat(os.path.join(self.dst, "venv", "bin", "tool"))
        self.assertEqual(stat.S_IMODE(tool.st_mode), 0o755)
        self.assertEqual(tool.st_uid, os.getuid())

    def test_pack_over_the_bound_is_too_large(self):
        with open(os.path.join(self.src, "big"), "wb") as fh:
            fh.write(os.urandom(200_000))
        with self.assertRaises(ProtocolError) as caught:
            self.packer.pack(Ctx(), {"maxBytes": 10_000})
        self.assertEqual(caught.exception.code, "TOO_LARGE")

    def test_read_and_write_validate_their_input(self):
        packed = self.packer.pack(Ctx(), {"maxBytes": 10 ** 6})
        with self.assertRaises(ProtocolError) as caught:
            self.packer.read(Ctx(), {"transfer": "nope", "offset": 0, "length": 10})
        self.assertEqual(caught.exception.code, "NOT_FOUND")
        with self.assertRaises(ProtocolError) as caught:
            self.packer.read(Ctx(), {"transfer": packed["transfer"], "offset": 0, "length": deps.CHUNK_BYTES + 1})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        transfer = self.unpacker.receive(Ctx(), {"size": 4, "sha256": "0" * 64})["transfer"]
        with self.assertRaises(ProtocolError) as caught:
            self.unpacker.write(Ctx(), {"transfer": transfer, "offset": 1, "data_base64": "AAAA"})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        with self.assertRaises(ProtocolError) as caught:
            self.unpacker.write(Ctx(), {"transfer": transfer, "offset": 0, "data_base64": "not base64!"})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        with self.assertRaises(ProtocolError) as caught:
            self.unpacker.write(Ctx(), {"transfer": transfer, "offset": 0, "data_base64": base64.b64encode(b"12345").decode()})
        self.assertEqual(caught.exception.code, "ARCHIVE_REJECTED")
        self.assertEqual(self.packer.discard(Ctx(), {"transfer": packed["transfer"]}), {"ok": True})
        self.assertEqual(self.packer.discard(Ctx(), {"transfer": packed["transfer"]}), {"ok": True})
        with self.assertRaises(ProtocolError):
            self.packer.discard(Ctx(), {"transfer": "../x"})

    def test_no_deps_dir_answers_bad_request(self):
        none = deps.Transfers(lambda: None)
        for call, params in ((none.pack, {"maxBytes": 10}), (none.receive, {"size": 1, "sha256": "0" * 64})):
            with self.assertRaises(ProtocolError) as caught:
                call(Ctx(), params)
            self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_transfer_count_is_bounded(self):
        for _ in range(deps.MAX_TRANSFERS):
            self.packer.pack(Ctx(), {"maxBytes": 10 ** 6})
        with self.assertRaises(ProtocolError) as caught:
            self.packer.pack(Ctx(), {"maxBytes": 10 ** 6})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_cancelled_unpack_leaves_the_deps_dir_empty(self):
        archive = gz_tar(lambda tar: [add_file(tar, "f%d" % i) for i in range(5)])
        transfer = self.unpacker.receive(Ctx(), {"size": len(archive), "sha256": hashlib.sha256(archive).hexdigest()})["transfer"]
        self.unpacker.write(Ctx(), {"transfer": transfer, "offset": 0, "data_base64": base64.b64encode(archive).decode()})
        ctx = Ctx()
        ctx.cancelled = True
        with self.assertRaises(ProtocolError) as caught:
            self.unpacker.unpack(ctx, {"transfer": transfer, "maxUnpackedBytes": 10 ** 6, "maxEntries": 100})
        self.assertEqual(caught.exception.code, "CANCELLED")
        self.assertEqual(os.listdir(self.dst), [])


class MaliciousArchiveTests(DepsTestBase):
    def test_absolute_member(self):
        self.assertRejected(gz_tar(lambda tar: add_file(tar, os.path.join(self.outside, "pwned"))))

    def test_dotdot_member(self):
        self.assertRejected(gz_tar(lambda tar: add_file(tar, "a/../../outside/pwned")))

    def test_symlink_with_absolute_target(self):
        self.assertRejected(gz_tar(lambda tar: add_entry(tar, "link", tarfile.SYMTYPE, self.outside)))

    def test_symlink_escaping_relatively(self):
        self.assertRejected(gz_tar(lambda tar: add_entry(tar, "a/link", tarfile.SYMTYPE, "../../outside")))

    def test_member_below_a_symlink(self):
        def build(tar):
            add_entry(tar, "inside", tarfile.DIRTYPE)
            add_entry(tar, "dir", tarfile.SYMTYPE, "inside")  # allowed on its own
            add_file(tar, "dir/pwned")  # but nothing may be written through it

        self.assertRejected(gz_tar(build))

    def test_directory_member_over_a_symlink(self):
        def build(tar):
            add_entry(tar, "inside", tarfile.DIRTYPE)
            add_entry(tar, "dir", tarfile.SYMTYPE, "inside")
            add_entry(tar, "dir", tarfile.DIRTYPE)

        self.assertRejected(gz_tar(build))

    def test_hardlink(self):
        def build(tar):
            add_file(tar, "a")
            add_entry(tar, "b", tarfile.LNKTYPE, "a")

        self.assertRejected(gz_tar(build))

    def test_hardlink_to_outside(self):
        self.assertRejected(gz_tar(lambda tar: add_entry(tar, "b", tarfile.LNKTYPE, "/etc/passwd")))

    def test_devices_and_fifos(self):
        for kind in (tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.CONTTYPE):
            with self.subTest(kind=kind):
                self.assertRejected(gz_tar(lambda tar: add_entry(tar, "dev", kind)))

    def test_duplicate_file_does_not_overwrite(self):
        def build(tar):
            add_file(tar, "a", b"first")
            add_file(tar, "a", b"second")

        self.assertRejected(gz_tar(build))

    def test_file_over_a_symlink_name(self):
        def build(tar):
            add_entry(tar, "a", tarfile.SYMTYPE, "b")
            add_file(tar, "a", b"through the link")

        self.assertRejected(gz_tar(build))

    def test_not_an_archive(self):
        self.assertRejected(b"this is not gzip at all")

    def test_truncated_archive(self):
        archive = gz_tar(lambda tar: add_file(tar, "a", os.urandom(50_000)))
        self.assertRejected(archive[: len(archive) // 2])

    def test_hash_mismatch(self):
        archive = gz_tar(lambda tar: add_file(tar, "a"))
        self.assertRejected(archive, sha="0" * 64)

    def test_unpacked_size_bound(self):
        self.assertRejected(gz_tar(lambda tar: add_file(tar, "a", b"x" * 1000)), code="TOO_LARGE", max_bytes=100)

    def test_entry_bound(self):
        self.assertRejected(gz_tar(lambda tar: [add_file(tar, "f%d" % i) for i in range(10)]), code="TOO_LARGE", max_entries=5)

    def test_mode_bits_are_sanitised(self):
        self.push(gz_tar(lambda tar: (add_file(tar, "s", b"#!/bin/sh\n", mode=0o6777), add_entry(tar, "d", tarfile.DIRTYPE, mode=0o1777))))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dst, "s")).st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.dst, "d")).st_mode), 0o755)

    def test_rejection_after_good_members_removes_them(self):
        def build(tar):
            add_file(tar, "good", b"fine")
            add_entry(tar, "bad", tarfile.SYMTYPE, "/etc")

        self.assertRejected(gz_tar(build))


class HostModeDepsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pi-gui-deps-host-")
        self.workspace = os.path.join(self.tmp, "ws")
        self.runtime = os.path.join(self.tmp, "run")
        self.locks = os.path.join(self.tmp, "locks")
        os.mkdir(self.workspace)
        os.mkdir(self.runtime, 0o700)
        os.mkdir(self.locks, 0o700)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def environ(self, **extra):
        env = {hostmode.MODE_ENV: "host", hostmode.WORKSPACE_ENV: self.workspace, hostmode.RUNTIME_ENV: self.runtime,
               hostmode.LOCK_DIR_ENV: self.locks}
        env.update(extra)
        return env

    def test_deps_dir_is_optional_created_and_validated(self):
        self.assertIsNone(hostmode.HostConfig.from_environ(self.environ()).deps_dir)
        deps_dir = os.path.join(self.tmp, "deps")
        config = hostmode.HostConfig.from_environ(self.environ(PI_GUI_DEPS_DIR=deps_dir))
        self.assertEqual(config.deps_dir, deps_dir)
        self.assertEqual(stat.S_IMODE(os.stat(deps_dir).st_mode) & 0o022, 0)
        with self.assertRaises(hostmode.HostModeError):
            hostmode.HostConfig.from_environ(self.environ(PI_GUI_DEPS_DIR="relative/deps"))
        os.symlink(self.workspace, os.path.join(self.tmp, "link"))
        with self.assertRaises(hostmode.HostModeError):
            hostmode.HostConfig.from_environ(self.environ(PI_GUI_DEPS_DIR=os.path.join(self.tmp, "link")))

    def test_child_env_points_installs_into_the_deps_dir(self):
        base = {"PATH": "/usr/bin:/bin", hostmode.DEPS_DIR_ENV: "/x", "HOME": "/home/u"}
        env = hostmode.build_host_env(base, {"PIP_TARGET": "/override"}, {"HOME": "/private"}, "PI_GUI_TESTING_", deps_dir="/s/deps")
        self.assertEqual(env["PIP_TARGET"], "/override")
        self.assertEqual(env["PYTHONPATH"], "/s/deps/python")
        self.assertEqual(env["npm_config_prefix"], "/s/deps/node")
        self.assertEqual(env["NODE_PATH"], "/s/deps/node/lib/node_modules")
        self.assertEqual(env["PATH"], "/s/deps/python/bin:/s/deps/node/bin:/usr/bin:/bin")
        self.assertNotIn(hostmode.DEPS_DIR_ENV, env)
        plain = hostmode.build_host_env(base, {}, {}, "PI_GUI_TESTING_")
        self.assertNotIn("PIP_TARGET", plain)
        self.assertEqual(plain["PATH"], "/usr/bin:/bin")


class HelloTests(unittest.TestCase):
    def test_platform_fingerprint_is_bounded_and_names_python(self):
        text = methods.platform_fingerprint()
        self.assertLessEqual(len(text), 256)
        self.assertIn("python ", text)


if __name__ == "__main__":
    unittest.main()
