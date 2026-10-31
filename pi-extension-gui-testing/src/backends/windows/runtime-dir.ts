/**
 * The Windows runtime dir of a helper session (spec §4.5 "Temp files"):
 * `%LOCALAPPDATA%\Temp\pi-gui-testing-win-<16 hex>`, created by the client
 * with an owner-only ACL, handed to the helper as `PI_GUI_RUNTIME_DIR`, and
 * removed without following junctions or symbolic links.
 *
 * Removal is path based (Node has no handle-relative deletion), so it pins
 * each directory by identity instead: the volume serial number and file id
 * of a directory are read before it is listed, after it is listed, and before
 * every entry in it is removed. A directory that was replaced in between (by
 * a junction, a symbolic link, or another directory) changes identity, and
 * removal stops there with a leftover instead of entering or deleting through
 * it. What remains is the gap between the last check and one syscall.
 *
 * File access goes through {@link WinFs}, so unit tests can simulate a
 * Windows file system with Windows paths on any host.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { BACKEND_OWNED_DIR } from "../../cleanup/sweep.ts";
import { OWNER_FILE, type OwnerRecord } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { boundedText, isDirectChild, RUNTIME_DIR_PREFIX, samePath, system32Tool } from "./paths.ts";

/** What a path is, without following links. Junctions and symbolic links are `link`. */
export type WinEntryType = "file" | "dir" | "link" | "other";

/** What a path is (without following links) and which object it is: `<volume serial>:<file id>` (`ino`/`dev` from `lstat`). */
export interface WinEntryIdentity {
  type: WinEntryType;
  id: string;
}

/** The file operations the Windows client code needs. */
export interface WinFs {
  /** `undefined` when nothing exists at `path`. */
  lstat(path: string): Promise<WinEntryType | undefined>;
  /** Type and identity of `path` without following links; `undefined` when nothing exists there. */
  identify(path: string): Promise<WinEntryIdentity | undefined>;
  /** Final path (links, junctions, and 8.3 names resolved). */
  realpath(path: string): Promise<string>;
  /** Creates one directory; rejects (`EEXIST`) when anything exists there. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Reads a file as UTF-8; rejects when it is larger than `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<string>;
  /** Creates a new file; rejects (`EEXIST`) when one exists. */
  writeNewFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or a link (a directory link is removed as a link, never followed). */
  unlink(path: string): Promise<void>;
  /** Removes an empty directory. */
  rmdir(path: string): Promise<void>;
}

/** {@link WinFs} on `node:fs`. */
export const nodeWinFs: WinFs = {
  async lstat(path) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return "link";
      if (info.isDirectory()) return "dir";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async identify(path) {
    try {
      const info = await lstat(path, { bigint: true });
      const type: WinEntryType = info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
      // On Windows, libuv fills dev with the volume serial number and ino with the NTFS file id.
      return { type, id: `${info.dev}:${info.ino}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  realpath: (path) => realpath(path),
  mkdir: async (path) => void (await mkdir(path)),
  readdir: (path) => readdir(path),
  async readFile(path, maxBytes) {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  },
  writeNewFile: (path, data) => writeFile(path, data, { flag: "wx", mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  rmdir: (path) => rmdir(path),
};

/**
 * Runtime dir names this package creates (never the generic session dirs
 * `pi-gui-testing-XXXXXX`). The generic session-dir sweep skips them, so this
 * backend reads their records before anything removes them.
 */
export const RUNTIME_DIR_NAME = BACKEND_OWNED_DIR;

/** The session tag of a runtime dir: its 16 hex digits, or `undefined` for any other name. */
export function runtimeDirTag(dir: string): string | undefined {
  const name = win32.basename(dir);
  return RUNTIME_DIR_NAME.test(name) ? name.slice(-16) : undefined;
}

/** A fresh runtime dir name. */
export function runtimeDirName(random: Buffer = randomBytes(8)): string {
  return `${RUNTIME_DIR_PREFIX}win-${random.toString("hex")}`;
}

/** `true` when `dir` is a runtime dir this package could have created directly under `root`. */
export function isPackageRuntimeDir(root: string, dir: string): boolean {
  return isDirectChild(root, dir) && RUNTIME_DIR_NAME.test(win32.basename(dir));
}

/**
 * Checks that `dir` is a real directory reached without junctions or
 * symbolic links: not a link itself, and its final path is the path itself.
 *
 * @returns The problem, or `undefined`.
 */
export async function realDirProblem(fs: WinFs, dir: string): Promise<string | undefined> {
  const type = await fs.lstat(dir);
  if (type === undefined) return `${dir} does not exist`;
  if (type === "link") return `${dir} is a junction or symbolic link`;
  if (type !== "dir") return `${dir} is not a directory`;
  const final = await fs.realpath(dir);
  if (!samePath(final, dir)) return `${dir} resolves to ${final} (a junction, symbolic link, or short name on the way)`;
  return undefined;
}

/** The current user's SID from `whoami /user` (absolute path, never `PATH`). */
export async function currentUserSid(runner: CommandRunner, env: Readonly<Record<string, string | undefined>>, signal?: AbortSignal): Promise<string> {
  const result = await runner.run([system32Tool(env, "whoami.exe"), "/user", "/fo", "csv", "/nh"], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  const sid = result.exitCode === 0 ? /"(S-1-\d+(?:-\d+){1,14})"\s*$/m.exec(result.stdout)?.[1] : undefined;
  if (!sid) throw new Error(`cannot read your user SID with whoami (exit ${result.exitCode ?? result.signal}${result.stderr.trim() ? `: ${boundedText(result.stderr)}` : ""})`);
  return sid;
}

/**
 * Replaces the ACL of `dir` with one entry: full control for `sid`, inherited
 * by everything inside. Inherited entries (Users, Administrators, SYSTEM of
 * the parent) are removed.
 */
export async function restrictToOwner(runner: CommandRunner, env: Readonly<Record<string, string | undefined>>, dir: string, sid: string, signal?: AbortSignal): Promise<void> {
  if (!/^S-1-\d+(?:-\d+){1,14}$/.test(sid)) throw new Error(`invalid SID ${boundedText(sid, 80)}`);
  const result = await runner.run([system32Tool(env, "icacls.exe"), dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/q"], { timeoutMs: 15_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) {
    throw new Error(`icacls could not make ${dir} private (exit ${result.exitCode ?? result.signal}${result.stderr.trim() || result.stdout.trim() ? `: ${boundedText(result.stderr.trim() || result.stdout.trim())}` : ""})`);
  }
}

export interface CreateRuntimeDirOptions {
  fs: WinFs;
  runner: CommandRunner;
  /** Pi's environment (for `%SystemRoot%`). */
  env: Readonly<Record<string, string | undefined>>;
  /** `%LOCALAPPDATA%\Temp`. */
  root: string;
  /** Default {@link runtimeDirName}. */
  name?: string;
  /** Records the dir in `owner.json` before it is created. */
  recordResource(kind: string, id: string): Promise<void>;
  /** Called right after the dir was created, before it is checked and locked down. */
  onCreated?(dir: string): void;
  signal?: AbortSignal;
}

/** Resource kind of a runtime dir in `owner.json`. */
export const RUNTIME_DIR_KIND = "tempdir";

/**
 * Records, creates, and locks down a runtime dir. The parent must be a real
 * directory reached without links; the new dir must not exist yet.
 *
 * @returns The runtime dir path.
 * @throws Error naming the problem. The dir may then exist; remove it with {@link removeRuntimeDir}.
 */
export async function createRuntimeDir(options: CreateRuntimeDirOptions): Promise<string> {
  const { fs, root } = options;
  const parentProblem = await realDirProblem(fs, root);
  if (parentProblem) throw new Error(`the Windows temp dir is not usable: ${parentProblem}`);
  const dir = win32.join(root, options.name ?? runtimeDirName());
  if (!isPackageRuntimeDir(root, dir)) throw new Error(`refusing runtime dir name ${win32.basename(dir)}`);
  const sid = await currentUserSid(options.runner, options.env, options.signal);
  await options.recordResource(RUNTIME_DIR_KIND, dir);
  await fs.mkdir(dir);
  options.onCreated?.(dir);
  const problem = await realDirProblem(fs, dir);
  if (problem) throw new Error(`the new runtime dir is not a plain directory: ${problem}`);
  await restrictToOwner(options.runner, options.env, dir, sid, options.signal);
  return dir;
}

const MAX_DEPTH = 64;

/** Thrown when a directory changed identity during removal: removal stops without touching it again. */
class ReplacedError extends Error {}

/** Checks that `dir` is still the directory `id` names (not replaced by a link or another directory). */
async function stillSame(fs: WinFs, dir: string, id: string): Promise<void> {
  const now = await fs.identify(dir);
  if (now?.type !== "dir" || now.id !== id) {
    throw new ReplacedError(`${dir}: replaced while it was being removed (${now ? `now a ${now.type === "link" ? "junction or symbolic link" : now.type}` : "gone"}); not entered`);
  }
}

async function removeTree(fs: WinFs, dir: string, id: string, depth: number, problems: string[], keepLast?: string): Promise<void> {
  if (depth > MAX_DEPTH) {
    problems.push(`${dir}: nested deeper than ${MAX_DEPTH} levels`);
    return;
  }
  let names: string[];
  try {
    await stillSame(fs, dir, id);
    names = await fs.readdir(dir);
    // A swap between the check and the listing would have listed another directory: never act on such names.
    await stillSame(fs, dir, id);
  } catch (error) {
    problems.push(error instanceof ReplacedError ? error.message : `${dir}: ${boundedText((error as Error).message)}`);
    return;
  }
  for (const name of names) {
    if (keepLast !== undefined && name.toLowerCase() === keepLast.toLowerCase()) continue;
    const path = win32.join(dir, name);
    try {
      await stillSame(fs, dir, id);
      const entry = await fs.identify(path);
      if (entry === undefined) continue;
      // Links (junctions included) are removed as links: their targets are never entered.
      if (entry.type === "dir") await removeTree(fs, path, entry.id, depth + 1, problems);
      else {
        await stillSame(fs, dir, id);
        await fs.unlink(path);
      }
    } catch (error) {
      if (error instanceof ReplacedError) {
        problems.push(error.message);
        return;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path}: ${boundedText((error as Error).message)}`);
    }
  }
  // The owner record goes last, so a dir that could not be emptied can still be judged (and retried) by a later sweep.
  if (keepLast !== undefined) {
    if (problems.length > 0) return;
    try {
      await stillSame(fs, dir, id);
      await fs.unlink(win32.join(dir, keepLast));
    } catch (error) {
      if (error instanceof ReplacedError) {
        problems.push(error.message);
        return;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        problems.push(`${win32.join(dir, keepLast)}: ${boundedText((error as Error).message)}`);
        return;
      }
    }
  }
  try {
    await stillSame(fs, dir, id);
    await fs.rmdir(dir);
  } catch (error) {
    if (error instanceof ReplacedError) problems.push(error.message);
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${dir}: ${boundedText((error as Error).message)}`);
  }
}

/**
 * Removes a runtime dir this package created under `root`, never following
 * junctions or symbolic links, and never entering a directory that changed
 * identity while it was removed. A link found at `dir` itself is removed as
 * a link. Paths that are not package runtime dirs are refused.
 *
 * @returns What could not be removed (one `tempdir` leftover), or `[]`.
 */
export async function removeRuntimeDir(fs: WinFs, root: string, dir: string): Promise<Leftover[]> {
  if (!isPackageRuntimeDir(root, dir)) return [{ kind: "tempdir", id: dir, detail: "not a runtime dir of this package; not removed" }];
  let entry: WinEntryIdentity | undefined;
  try {
    entry = await fs.identify(dir);
  } catch (error) {
    return [{ kind: "tempdir", id: dir, detail: `cannot read it: ${boundedText((error as Error).message)}` }];
  }
  if (entry === undefined) return [];
  if (entry.type !== "dir") {
    try {
      await fs.unlink(dir);
      return [];
    } catch (error) {
      return [{ kind: "tempdir", id: dir, detail: `remove failed: ${boundedText((error as Error).message)}` }];
    }
  }
  const problems: string[] = [];
  await removeTree(fs, dir, entry.id, 0, problems, OWNER_FILE);
  if (problems.length === 0 && (await fs.lstat(dir).catch(() => "dir" as const)) === undefined) return [];
  return [{ kind: "tempdir", id: dir, detail: `not fully removed: ${boundedText(problems.slice(0, 3).join("; ") || "still exists", 600)}` }];
}

/** Validates an owner record read from a runtime dir (same rules as the session dir's `owner.json`). */
export function ownerRecordFrom(text: string): OwnerRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Number.isSafeInteger(r.pid) || (r.pid as number) <= 0) return undefined;
  if (typeof r.processStartTime !== "string" || !/^\d+$/.test(r.processStartTime)) return undefined;
  for (const key of ["bootId", "clientId", "backend", "createdAt"]) if (typeof r[key] !== "string" || (r[key] as string).length === 0) return undefined;
  if (typeof r.piSessionId !== "string" || !Array.isArray(r.resources)) return undefined;
  for (const res of r.resources) if (typeof res !== "object" || res === null || typeof res.kind !== "string" || typeof res.id !== "string") return undefined;
  return raw as OwnerRecord;
}

/** Reads and validates `<dir>\owner.json`; `undefined` when missing or invalid. */
export async function readRuntimeOwner(fs: WinFs, dir: string): Promise<OwnerRecord | undefined> {
  try {
    return ownerRecordFrom(await fs.readFile(win32.join(dir, OWNER_FILE), 64 * 1024));
  } catch {
    return undefined;
  }
}

/**
 * Writes `<dir>\owner.json` atomically (new temp file, then rename). A copy of
 * the session's owner record in the runtime dir lets this backend's orphan
 * audit and sweep judge the dir's owner (and recognise the helper it spawned),
 * instead of reporting it as a dir without an owner.
 */
export async function writeRuntimeOwner(fs: WinFs, dir: string, record: OwnerRecord): Promise<void> {
  const target = win32.join(dir, OWNER_FILE);
  const temp = win32.join(dir, `.owner-${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeNewFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}
