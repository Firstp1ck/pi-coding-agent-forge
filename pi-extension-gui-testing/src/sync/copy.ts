/**
 * Copies a {@link FileSet} into a destination directory (`copy` mode, spec
 * §4.1, §4.7). Files keep their permission bits; links are recreated with
 * targets relative to themselves; nothing outside the file set is touched.
 *
 * The project can change between enumeration and copy. Each file is opened
 * without following a final symlink, and the opened file must still be a
 * regular file with the enumerated identity (device and inode) whose real
 * location is the enumerated path inside the root. A file that fails any of
 * these checks fails the copy (fail closed).
 */
import { constants, createWriteStream } from "node:fs";
import { chmod, mkdir, open, readlink, realpath, symlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { SyncSummary } from "../backend.ts";
import { fileIdentity, parentOf, type FileSet, type SyncedEntry } from "./fileset.ts";

/** A synced file changed into something the copy must not read. The message names the path. */
export class SyncChangedError extends Error {
  constructor(path: string, why: string) {
    super(`${path} changed while the workspace was being copied (${why}); nothing outside the project was read. Try again`);
    this.name = "SyncChangedError";
  }
}

/** Where an open file really is, via `/proc/self/fd` (Linux), or `undefined` when that is unavailable. */
async function openedPath(handle: FileHandle): Promise<string | undefined> {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`);
  } catch {
    return undefined;
  }
}

/**
 * Opens one enumerated file for reading after re-checking it (see the module
 * comment).
 *
 * @throws SyncChangedError when the file is no longer the enumerated regular file inside `root`.
 */
export async function openSyncedFile(root: string, entry: SyncedEntry): Promise<FileHandle> {
  const source = join(root, entry.path);
  // The parent must still resolve to itself: no ancestor became a symlink.
  const parent = dirname(source);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    throw new SyncChangedError(entry.path, `parent unreadable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  if (realParent !== parent) throw new SyncChangedError(entry.path, "a parent directory became a symlink");
  let handle: FileHandle;
  try {
    handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SyncChangedError(entry.path, code === "ELOOP" ? "it became a symlink" : `cannot open: ${code ?? (error as Error).message}`);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new SyncChangedError(entry.path, "it is no longer a regular file");
    if (entry.identity !== undefined && fileIdentity(info) !== entry.identity) throw new SyncChangedError(entry.path, "it was replaced by another file");
    const actual = await openedPath(handle);
    if (actual !== undefined && actual !== source) throw new SyncChangedError(entry.path, `it resolved to ${actual}`);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Copies every entry of `set` from `set.root` to `dest` (created with mode 0700).
 *
 * @returns File count (files and links), bytes copied, and excluded count.
 * @throws SyncChangedError when a file changed after enumeration.
 */
export async function copyFileSet(set: FileSet, dest: string, signal?: AbortSignal): Promise<SyncSummary> {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const made = new Set<string>([""]);
  const ensureDir = async (rel: string) => {
    if (made.has(rel)) return;
    await mkdir(join(dest, rel), { recursive: true, mode: 0o755 });
    made.add(rel);
  };
  for (const entry of set.entries) {
    if (signal?.aborted) throw signal.reason ?? new Error("copy aborted");
    await ensureDir(parentOf(entry.path));
    const target = join(dest, entry.path);
    if (entry.type === "symlink") {
      await symlink(entry.linkTarget!, target);
      continue;
    }
    const handle = await openSyncedFile(set.root, entry);
    try {
      // `wx`: never write through something that already exists at the target.
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: "wx", mode: entry.mode & 0o777 }), signal ? { signal } : {});
    } finally {
      await handle.close().catch(() => {});
    }
    // The write stream's mode is subject to the umask; set the exact bits.
    await chmod(target, entry.mode & 0o777);
  }
  return { files: set.entries.length, bytes: set.bytes, excluded: set.excluded.length };
}
