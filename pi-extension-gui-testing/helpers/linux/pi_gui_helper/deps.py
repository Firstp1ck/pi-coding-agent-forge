"""Dependency-cache transfers (protocol 2, docs/protocol.md "Dependency cache").

The client keeps installed dependencies between sessions (spec §4.8). After a
successful ``setup`` it asks the helper to pack the deps dir (``depsPack``) and
pulls the archive in chunks (``depsRead``); on a cache hit it pushes an archive
(``depsReceive``, ``depsWrite``) and asks the helper to unpack it
(``depsUnpack``). Archives are gzip-compressed tar files.

Archives are untrusted: a cached archive was produced in an earlier session by
code the project controls. Packing and unpacking therefore follow the same
rules, and unpacking fails closed:

- member names are relative, contain no ``..`` and no NUL, and never lead
  through a symlink (every parent is opened with ``O_NOFOLLOW`` relative to the
  previous one, so a symlink planted by an earlier member cannot redirect a
  later write);
- only regular files, directories, and symlinks whose target stays inside the
  deps dir; hardlinks, devices, FIFOs, sparse and contiguous files are refused;
- owners are never applied; modes keep only ``0755`` plus owner read/write;
- the upload's size and SHA-256 must match what the client announced;
- bounds on unpacked bytes and entries.

Any violation empties the deps dir again and answers ``ARCHIVE_REJECTED`` (or
``TOO_LARGE`` for a bound). Transfer files are unlinked temp files, so nothing
else can reach them by path, and they disappear with the helper.
"""

import base64
import binascii
import errno
import hashlib
import os
import posixpath
import re
import secrets
import stat
import tarfile
import tempfile
import zlib

from .dispatch import ProtocolError

CHUNK_BYTES = 4 * 1024 * 1024
MAX_TRANSFERS = 4
MAX_NAME_BYTES = 4096
MAX_COMPONENT_BYTES = 255
MAX_DEPTH = 128
DEFAULT_MAX_ENTRIES = 2_000_000
_COPY_BYTES = 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TRANSFER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
_FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


class Rejected(Exception):
    """An archive member or upload that breaks the rules; becomes ``ARCHIVE_REJECTED``."""


class TooLarge(Exception):
    """A bound was exceeded; becomes ``TOO_LARGE``."""


def _file_mode(mode):
    return (mode & 0o755) | 0o600


def _dir_mode(mode):
    return (mode & 0o755) | 0o700


def _inside(path):
    """True when the normalised relative ``path`` stays inside the root (``""``/``.`` is the root)."""
    norm = posixpath.normpath(path) if path else "."
    return not posixpath.isabs(norm) and norm != ".." and not norm.startswith("../")


def member_parts(name):
    """Validated path components of an archive member name; ``[]`` for the root itself.

    Raises Rejected for absolute names, ``..``, NUL, or names over the bounds.
    """
    if not isinstance(name, str) or "\x00" in name:
        raise Rejected("member name %r is not a valid path" % (name,))
    if len(name.encode("utf-8", "surrogateescape")) > MAX_NAME_BYTES:
        raise Rejected("member name is longer than %d bytes" % MAX_NAME_BYTES)
    if name.startswith("/"):
        raise Rejected("member %r has an absolute path" % name)
    parts = [p for p in name.split("/") if p not in ("", ".")]
    for part in parts:
        if part == "..":
            raise Rejected("member %r contains '..'" % name)
        if len(part.encode("utf-8", "surrogateescape")) > MAX_COMPONENT_BYTES:
            raise Rejected("member %r has a component over %d bytes" % (name, MAX_COMPONENT_BYTES))
    if len(parts) > MAX_DEPTH:
        raise Rejected("member %r is nested deeper than %d levels" % (name, MAX_DEPTH))
    return parts


def safe_link_target(member_path, target):
    """True when a symlink at ``member_path`` (relative) pointing to ``target`` stays inside the root."""
    if not target or "\x00" in target or target.startswith("/"):
        return False
    return _inside(posixpath.join(posixpath.dirname(member_path), target))


def clear_dir(root):
    """Removes everything inside ``root`` (never ``root`` itself, never through a symlink)."""
    fd = os.open(root, _DIR_FLAGS)
    try:
        _clear_fd(fd)
    finally:
        os.close(fd)


def _clear_fd(fd):
    for name in os.listdir(fd):
        try:
            info = os.lstat(name, dir_fd=fd)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(info.st_mode):
            sub = os.open(name, _DIR_FLAGS, dir_fd=fd)
            try:
                # A read-only directory (mode 0555) cannot be emptied otherwise.
                os.fchmod(sub, 0o700)
                _clear_fd(sub)
            finally:
                os.close(sub)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)


class _HashingWriter:
    """File-like sink that hashes, counts, and enforces a size bound."""

    def __init__(self, handle, max_bytes):
        self._handle = handle
        self._max = max_bytes
        self.size = 0
        self.hasher = hashlib.sha256()

    def write(self, data):
        self.size += len(data)
        if self.size > self._max:
            raise TooLarge("the deps archive exceeds %d bytes" % self._max)
        self.hasher.update(data)
        return self._handle.write(data)

    def flush(self):
        self._handle.flush()


class _Pack:
    def __init__(self, handle, size, sha256):
        self.handle = handle
        self.size = size
        self.sha256 = sha256


class _Upload:
    def __init__(self, handle, size, sha256):
        self.handle = handle
        self.size = size
        self.sha256 = sha256
        self.received = 0
        self.hasher = hashlib.sha256()


def _new_id():
    return secrets.token_hex(8)


def _int_param(params, key, minimum, maximum):
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError("BAD_REQUEST", "%s must be an integer" % key)
    if value < minimum or value > maximum:
        raise ProtocolError("BAD_REQUEST", "%s must be within %d..%d" % (key, minimum, maximum))
    return value


def _transfer_param(params):
    value = params.get("transfer")
    if not isinstance(value, str) or not _TRANSFER_RE.match(value):
        raise ProtocolError("BAD_REQUEST", "transfer must be a transfer id")
    return value


class Transfers:
    """The open packs and uploads of one session; bound to its deps dir."""

    def __init__(self, deps_root, tmp_dir=None, on_unpacked=None):
        # ``deps_root()`` returns the deps dir or None (local-linux has none).
        self._deps_root = deps_root
        self._tmp_dir = tmp_dir
        self._on_unpacked = on_unpacked
        self._packs = {}
        self._uploads = {}

    def _root(self):
        root = self._deps_root()
        if not root:
            raise ProtocolError("BAD_REQUEST", "this session has no deps dir, so it does not use the dependency cache")
        try:
            info = os.lstat(root)
        except OSError as exc:
            raise ProtocolError("INTERNAL", "deps dir %s: %s" % (root, exc.strerror or exc)) from None
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ProtocolError("INTERNAL", "deps dir %s is not a real directory" % root)
        return root

    def _temp(self):
        if len(self._packs) + len(self._uploads) >= MAX_TRANSFERS:
            raise ProtocolError("BAD_REQUEST", "too many open deps transfers; discard one first")
        tmp = self._tmp_dir() if callable(self._tmp_dir) else self._tmp_dir
        # Unlinked at once: no other process can open it by path.
        return tempfile.TemporaryFile(dir=tmp)

    def close(self):
        for table in (self._packs, self._uploads):
            for item in table.values():
                try:
                    item.handle.close()
                except OSError:
                    pass
            table.clear()

    # ----- pack ----------------------------------------------------------

    def pack(self, ctx, params):
        max_bytes = _int_param(params, "maxBytes", 1, 2 ** 50)
        root = self._root()
        handle = self._temp()
        writer = _HashingWriter(handle, max_bytes)
        counts = {"entries": 0, "skipped": 0}
        try:
            with tarfile.open(fileobj=writer, mode="w:gz", format=tarfile.PAX_FORMAT, compresslevel=6) as tar:
                _pack_tree(tar, root, "", counts, ctx)
            handle.flush()
        except TooLarge as exc:
            handle.close()
            raise ProtocolError("TOO_LARGE", str(exc)) from None
        except ProtocolError:
            handle.close()
            raise
        except OSError as exc:
            handle.close()
            raise ProtocolError("INTERNAL", "packing the deps dir failed: %s" % (exc.strerror or exc)) from None
        transfer = _new_id()
        sha = writer.hasher.hexdigest()
        self._packs[transfer] = _Pack(handle, writer.size, sha)
        return {"transfer": transfer, "size": writer.size, "sha256": sha,
                "entries": counts["entries"], "skipped": counts["skipped"]}

    def read(self, ctx, params):
        transfer = _transfer_param(params)
        pack = self._packs.get(transfer)
        if pack is None:
            raise ProtocolError("NOT_FOUND", "unknown deps transfer %s" % transfer)
        offset = _int_param(params, "offset", 0, pack.size)
        length = _int_param(params, "length", 1, CHUNK_BYTES)
        pack.handle.seek(offset)
        data = pack.handle.read(min(length, pack.size - offset))
        return {"data_base64": base64.b64encode(data).decode("ascii"), "eof": offset + len(data) >= pack.size}

    # ----- unpack --------------------------------------------------------

    def receive(self, ctx, params):
        size = _int_param(params, "size", 1, 2 ** 50)
        sha = params.get("sha256")
        if not isinstance(sha, str) or not _SHA256_RE.match(sha):
            raise ProtocolError("BAD_REQUEST", "sha256 must be a lowercase hex SHA-256")
        self._root()
        transfer = _new_id()
        self._uploads[transfer] = _Upload(self._temp(), size, sha)
        return {"transfer": transfer}

    def write(self, ctx, params):
        transfer = _transfer_param(params)
        upload = self._uploads.get(transfer)
        if upload is None:
            raise ProtocolError("NOT_FOUND", "unknown deps transfer %s" % transfer)
        offset = _int_param(params, "offset", 0, upload.size)
        text = params.get("data_base64")
        if not isinstance(text, str) or len(text) > (CHUNK_BYTES // 3 + 1) * 4:
            raise ProtocolError("BAD_REQUEST", "data_base64 must be a string of at most one chunk")
        try:
            data = base64.b64decode(text.encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError, ValueError):
            raise ProtocolError("BAD_REQUEST", "data_base64 is not base64") from None
        if offset != upload.received:
            raise ProtocolError("BAD_REQUEST", "chunk at offset %d, expected %d" % (offset, upload.received))
        if upload.received + len(data) > upload.size:
            self._drop(self._uploads, transfer)
            raise ProtocolError("ARCHIVE_REJECTED", "the upload is longer than the announced %d bytes" % upload.size)
        upload.handle.write(data)
        upload.hasher.update(data)
        upload.received += len(data)
        return {"received": upload.received}

    def unpack(self, ctx, params):
        transfer = _transfer_param(params)
        max_bytes = _int_param(params, "maxUnpackedBytes", 1, 2 ** 50)
        max_entries = _int_param(params, "maxEntries", 1, 100_000_000)
        if transfer not in self._uploads:
            raise ProtocolError("NOT_FOUND", "unknown deps transfer %s" % transfer)
        root = self._root()
        upload = self._uploads.pop(transfer)
        try:
            if upload.received != upload.size:
                raise Rejected("received %d of %d bytes" % (upload.received, upload.size))
            if upload.hasher.hexdigest() != upload.sha256:
                raise Rejected("SHA-256 of the upload does not match")
            clear_dir(root)
            upload.handle.flush()
            upload.handle.seek(0)
            result = unpack_archive(upload.handle, root, max_bytes, max_entries, ctx.check)
        except Rejected as exc:
            _empty(root)
            raise ProtocolError("ARCHIVE_REJECTED", "dependency archive rejected: %s; the deps dir was left empty" % exc) from None
        except TooLarge as exc:
            _empty(root)
            raise ProtocolError("TOO_LARGE", "%s; the deps dir was left empty" % exc) from None
        except ProtocolError:
            _empty(root)
            raise
        except OSError as exc:
            _empty(root)
            raise ProtocolError("INTERNAL", "unpacking failed: %s; the deps dir was left empty" % (exc.strerror or exc)) from None
        finally:
            upload.handle.close()
        if self._on_unpacked is not None:
            self._on_unpacked()
        return result

    def discard(self, ctx, params):
        transfer = _transfer_param(params)
        self._drop(self._packs, transfer)
        self._drop(self._uploads, transfer)
        return {"ok": True}

    @staticmethod
    def _drop(table, transfer):
        item = table.pop(transfer, None)
        if item is not None:
            try:
                item.handle.close()
            except OSError:
                pass


def _empty(root):
    try:
        clear_dir(root)
    except OSError:
        pass


def _pack_tree(tar, root, rel, counts, ctx):
    """Adds the contents of ``root/rel`` in name order, never following symlinks."""
    path = os.path.join(root, rel) if rel else root
    try:
        names = sorted(os.listdir(path))
    except OSError as exc:
        raise ProtocolError("INTERNAL", "cannot list %s: %s" % (path, exc.strerror or exc)) from None
    for name in names:
        ctx.check()
        member = posixpath.join(rel, name) if rel else name
        full = os.path.join(path, name)
        try:
            info = os.lstat(full)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(info.st_mode):
            entry = tarfile.TarInfo(member)
            entry.type = tarfile.DIRTYPE
            entry.mode = _dir_mode(info.st_mode)
            entry.mtime = int(info.st_mtime)
            tar.addfile(entry)
            counts["entries"] += 1
            _pack_tree(tar, root, member, counts, ctx)
        elif stat.S_ISREG(info.st_mode):
            try:
                fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
            except OSError:
                counts["skipped"] += 1
                continue
            with os.fdopen(fd, "rb") as handle:
                opened = os.fstat(handle.fileno())
                if not stat.S_ISREG(opened.st_mode):
                    counts["skipped"] += 1
                    continue
                entry = tarfile.TarInfo(member)
                entry.size = opened.st_size
                entry.mode = _file_mode(opened.st_mode)
                entry.mtime = int(opened.st_mtime)
                tar.addfile(entry, handle)
            counts["entries"] += 1
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(full)
            if target.startswith("/"):
                # An absolute link into the deps dir is kept as a relative one.
                absolute = posixpath.normpath(target)
                base = posixpath.normpath(root)
                if absolute == base or absolute.startswith(base + "/"):
                    target = posixpath.relpath(absolute, posixpath.dirname(posixpath.join(base, member)))
            if not safe_link_target(member, target):
                # E.g. a venv's bin/python → /usr/bin/python3; recreated in the next session.
                counts["skipped"] += 1
                continue
            entry = tarfile.TarInfo(member)
            entry.type = tarfile.SYMTYPE
            entry.linkname = target
            entry.mode = 0o777
            entry.mtime = int(info.st_mtime)
            tar.addfile(entry)
            counts["entries"] += 1
        else:
            counts["skipped"] += 1


def _open_parent(root_fd, parts):
    """Opens the directory holding ``parts[-1]``, creating missing parents; never through a symlink."""
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            try:
                nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, 0o755, dir_fd=fd)
                nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise Rejected("member path %s leads through a symlink or a file" % "/".join(parts)) from None
                raise
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def unpack_archive(handle, root, max_bytes, max_entries, check=None):
    """Unpacks the gzip tar ``handle`` into the empty directory ``root`` under the rules above.

    Returns ``{"entries": n, "bytes": total}``. Raises Rejected or TooLarge;
    the caller empties ``root`` then.
    """
    total = 0
    entries = 0
    root_fd = os.open(root, _DIR_FLAGS)
    try:
        try:
            tar = tarfile.open(fileobj=handle, mode="r|gz")
        except (tarfile.TarError, EOFError, OSError, zlib.error) as exc:
            raise Rejected("not a gzip-compressed tar archive (%s)" % exc) from None
        with tar:
            while True:
                if check is not None:
                    check()
                try:
                    member = tar.next()
                except (tarfile.TarError, EOFError, zlib.error) as exc:
                    raise Rejected("corrupt archive (%s)" % exc) from None
                except OSError as exc:
                    if exc.errno is None:
                        raise Rejected("corrupt archive (%s)" % exc) from None
                    raise
                if member is None:
                    break
                parts = member_parts(member.name)
                if not parts:
                    if not member.isdir():
                        raise Rejected("the archive root is not a directory")
                    continue
                entries += 1
                if entries > max_entries:
                    raise TooLarge("the archive has more than %d entries" % max_entries)
                rel = "/".join(parts)
                if member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    total += member.size
                    if total > max_bytes:
                        raise TooLarge("the archive unpacks to more than %d bytes" % max_bytes)
                    _write_file(tar, member, root_fd, parts, rel)
                elif member.type == tarfile.DIRTYPE:
                    _make_dir(root_fd, parts, member.mode, rel)
                elif member.type == tarfile.SYMTYPE:
                    if not safe_link_target(rel, member.linkname):
                        raise Rejected("symlink %s → %r points outside the deps dir" % (rel, member.linkname))
                    parent = _open_parent(root_fd, parts)
                    try:
                        os.symlink(member.linkname, parts[-1], dir_fd=parent)
                    except FileExistsError:
                        raise Rejected("duplicate member %s" % rel) from None
                    finally:
                        os.close(parent)
                else:
                    kind = {tarfile.LNKTYPE: "hardlink", tarfile.CHRTYPE: "character device", tarfile.BLKTYPE: "block device",
                            tarfile.FIFOTYPE: "FIFO", tarfile.CONTTYPE: "contiguous file"}.get(member.type, "type %r" % member.type)
                    if member.issparse():
                        kind = "sparse file"
                    raise Rejected("member %s is a %s" % (rel, kind))
    finally:
        os.close(root_fd)
    return {"entries": entries, "bytes": total}


def _make_dir(root_fd, parts, mode, rel):
    parent = _open_parent(root_fd, parts)
    try:
        name = parts[-1]
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        try:
            fd = os.open(name, _DIR_FLAGS, dir_fd=parent)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Rejected("directory member %s collides with a file or symlink" % rel) from None
            raise
        try:
            os.fchmod(fd, _dir_mode(mode))
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def _write_file(tar, member, root_fd, parts, rel):
    source = tar.extractfile(member)
    if source is None:
        raise Rejected("member %s has no data" % rel)
    parent = _open_parent(root_fd, parts)
    try:
        try:
            fd = os.open(parts[-1], _FILE_FLAGS, 0o600, dir_fd=parent)
        except FileExistsError:
            raise Rejected("duplicate member %s" % rel) from None
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise Rejected("member %s collides with a symlink" % rel) from None
            raise
    finally:
        os.close(parent)
    try:
        written = 0
        while True:
            try:
                block = source.read(_COPY_BYTES)
            except (tarfile.TarError, EOFError, zlib.error) as exc:
                raise Rejected("corrupt archive data in %s (%s)" % (rel, exc)) from None
            if not block:
                break
            written += len(block)
            view = memoryview(block)
            while view:
                view = view[os.write(fd, view):]
        if written != member.size:
            raise Rejected("member %s is truncated" % rel)
        os.fchmod(fd, _file_mode(member.mode))
        mtime = int(member.mtime) if isinstance(member.mtime, (int, float)) and member.mtime >= 0 else 0
        os.utime(fd, (mtime, mtime))
    finally:
        os.close(fd)
