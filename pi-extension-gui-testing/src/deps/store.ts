/**
 * The client-side dependency cache on disk (spec §4.8, §7a.1):
 *
 * ```text
 * <root>/<project-hash>/<target-os>-<arch>/<key>.tar.gz   archive, as the helper packed it
 * <root>/<project-hash>/<target-os>-<arch>/<key>.sha256   "<sha256>  <key>.tar.gz\n"; its mtime is lastUsed
 * <root>/<project-hash>/<target-os>-<arch>/<key>.lock     present while one writer stores the entry
 * ```
 *
 * The root defaults to `$XDG_CACHE_HOME/pi-extension-gui-testing/deps`, else
 * `~/.cache/pi-extension-gui-testing/deps`, created with mode 0700.
 *
 * Archives are opaque bytes to the client: it hashes, stores, and forwards
 * them, and never unpacks or parses them (the helper does, under its rules).
 * Writes are atomic (temp file in the same directory, fsync, rename; the
 * sidecar last), one writer per entry holds the lock, and every read
 * re-verifies the archive against its sidecar, so a torn, corrupted, or
 * concurrently replaced entry is discarded instead of used. Eviction is LRU
 * over the whole root down to the size limit.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, utimes, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Default size limit of the whole cache (spec §4.8). */
export const DEFAULT_DEPS_CACHE_MAX_BYTES = 5 * 1024 ** 3;
export const ARCHIVE_SUFFIX = ".tar.gz";
export const SIDECAR_SUFFIX = ".sha256";
export const LOCK_SUFFIX = ".lock";
/** A lock older than this is a crashed writer's and may be taken over. */
export const LOCK_STALE_MS = 30 * 60_000;
/** Temp files and unpaired halves older than this are removed by eviction. */
export const ORPHAN_AGE_MS = 60 * 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

/** `$XDG_CACHE_HOME/pi-extension-gui-testing/deps`, else `~/.cache/pi-extension-gui-testing/deps`. */
export function defaultDepsCacheRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "pi-extension-gui-testing", "deps");
}

/** First 16 hex characters of the SHA-256 of the project's real path. */
export async function projectHash(projectRoot: string): Promise<string> {
  const real = await realpath(projectRoot).catch(() => projectRoot);
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/** The files of one cache entry. */
export interface CacheEntryRef {
  dir: string;
  key: string;
  archive: string;
  sidecar: string;
  lock: string;
}

/** A verified entry, ready to send. */
export interface CacheHit {
  ref: CacheEntryRef;
  size: number;
  sha256: string;
}

export type LookupResult = { hit: CacheHit } | { miss: true; discarded?: string };

/** Bytes written so far, hashed on the way; committed or aborted exactly once. */
export interface CacheWriter {
  readonly ref: CacheEntryRef;
  write(chunk: Buffer): Promise<void>;
  /** Verifies size and hash, then makes the entry visible atomically. @throws Error on a mismatch (the entry is not stored). */
  commit(expected: { size: number; sha256: string }): Promise<void>;
  abort(): Promise<void>;
}

interface Listed {
  ref: CacheEntryRef;
  size: number;
  lastUsed: number;
}

export interface DepsCacheOptions {
  root?: string;
  maxBytes?: number;
  now?: () => number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** SHA-256 hex and size of a file, streaming. */
export async function hashFileStream(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), size };
}

export class DepsCache {
  readonly root: string;
  readonly maxBytes: number;
  readonly #now: () => number;

  constructor(options: DepsCacheOptions = {}) {
    this.root = options.root ?? defaultDepsCacheRoot();
    this.maxBytes = options.maxBytes ?? DEFAULT_DEPS_CACHE_MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The entry for one project, target, and key.
   *
   * @throws Error for a malformed key, project hash, OS, or arch (never builds a path from them otherwise).
   */
  entry(project: string, targetOs: string, arch: string, key: string): CacheEntryRef {
    if (!/^[0-9a-f]{16}$/.test(project)) throw new Error(`invalid project hash ${JSON.stringify(project)}`);
    if (!SEGMENT.test(targetOs) || !SEGMENT.test(arch)) throw new Error(`invalid cache target ${JSON.stringify(`${targetOs}-${arch}`)}`);
    if (!HEX64.test(key)) throw new Error(`invalid cache key ${JSON.stringify(key)}`);
    const dir = join(this.root, project, `${targetOs}-${arch}`);
    return { dir, key, archive: join(dir, `${key}${ARCHIVE_SUFFIX}`), sidecar: join(dir, `${key}${SIDECAR_SUFFIX}`), lock: join(dir, `${key}${LOCK_SUFFIX}`) };
  }

  /**
   * Looks the entry up and verifies the archive against its sidecar. A
   * mismatch (corruption, a torn write) removes the entry, unless a writer
   * currently holds its lock, and reports a miss.
   */
  async lookup(ref: CacheEntryRef): Promise<LookupResult> {
    let expected: string;
    try {
      expected = await this.#readSidecar(ref);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { miss: true };
      return { miss: true, discarded: await this.#discardUnlessLocked(ref, `unreadable checksum file (${(error as Error).message})`) };
    }
    let info;
    try {
      info = await lstat(ref.archive);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { miss: true, discarded: await this.#discardUnlessLocked(ref, "archive missing") };
      throw error;
    }
    if (!info.isFile() || info.size === 0) return { miss: true, discarded: await this.#discardUnlessLocked(ref, "archive is not a regular file") };
    const actual = await hashFileStream(ref.archive);
    if (actual.sha256 !== expected) return { miss: true, discarded: await this.#discardUnlessLocked(ref, "SHA-256 mismatch") };
    return { hit: { ref, size: actual.size, sha256: actual.sha256 } };
  }

  /** Marks the entry as used now (its sidecar's mtime is `lastUsed`). */
  async touch(ref: CacheEntryRef): Promise<void> {
    const at = new Date(this.#now());
    await utimes(ref.sidecar, at, at).catch(() => undefined);
  }

  /** Removes one entry (archive and sidecar). */
  async discard(ref: CacheEntryRef): Promise<void> {
    await rm(ref.sidecar, { force: true });
    await rm(ref.archive, { force: true });
  }

  /**
   * Starts storing an entry, or explains why not: another writer holds the
   * lock. A lock older than {@link LOCK_STALE_MS} is taken over once.
   */
  async beginStore(ref: CacheEntryRef): Promise<CacheWriter | { skipped: string }> {
    await mkdir(ref.dir, { recursive: true, mode: 0o700 });
    let lock: FileHandle | undefined;
    for (let attempt = 0; attempt < 2 && !lock; attempt++) {
      try {
        lock = await open(ref.lock, "wx", 0o600);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const age = await stat(ref.lock).then((s) => this.#now() - s.mtimeMs, () => 0);
        if (age < LOCK_STALE_MS || attempt > 0) return { skipped: "another Pi session is storing this entry right now" };
        await unlink(ref.lock).catch(() => undefined);
      }
    }
    if (!lock) return { skipped: "the entry lock could not be taken" };
    await lock.writeFile(`${process.pid}\n`).catch(() => undefined);
    await lock.close();
    const temp = join(ref.dir, `.${ref.key}.${randomBytes(6).toString("hex")}.tmp`);
    let handle: FileHandle;
    try {
      handle = await open(temp, "wx", 0o600);
    } catch (error) {
      await rm(ref.lock, { force: true });
      throw error;
    }
    const hash = createHash("sha256");
    let size = 0;
    let done = false;
    const maxBytes = this.maxBytes;
    const now = this.#now;
    // A long transfer keeps its lock fresh, so it is never mistaken for a crashed writer's.
    let lockTouched = now();
    const finish = async () => {
      done = true;
      await handle.close().catch(() => undefined);
    };
    return {
      ref,
      async write(chunk) {
        if (done) throw new Error("the cache writer is closed");
        size += chunk.length;
        if (size > maxBytes) throw new Error(`the archive is larger than the cache limit (${maxBytes} bytes)`);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        if (now() - lockTouched > 60_000) {
          lockTouched = now();
          const at = new Date(lockTouched);
          await utimes(ref.lock, at, at).catch(() => undefined);
        }
      },
      async commit(expected) {
        if (done) throw new Error("the cache writer is closed");
        try {
          const actual = hash.digest("hex");
          if (size !== expected.size || actual !== expected.sha256) {
            throw new Error(`received ${size} bytes with SHA-256 ${actual.slice(0, 12)}…, the helper announced ${expected.size} bytes with ${expected.sha256.slice(0, 12)}…`);
          }
          await handle.sync();
          await finish();
          const sidecarTemp = `${temp}.sha256`;
          const sidecar = await open(sidecarTemp, "wx", 0o600);
          try {
            await sidecar.writeFile(`${actual}  ${ref.key}${ARCHIVE_SUFFIX}\n`);
            await sidecar.sync();
          } finally {
            await sidecar.close();
          }
          // Archive first, sidecar last: a reader that sees the new sidecar sees the new archive.
          await rename(temp, ref.archive);
          await rename(sidecarTemp, ref.sidecar);
        } catch (error) {
          await finish();
          await rm(temp, { force: true });
          await rm(`${temp}.sha256`, { force: true });
          throw error;
        } finally {
          await rm(ref.lock, { force: true });
        }
      },
      async abort() {
        if (done) return;
        await finish();
        await rm(temp, { force: true });
        await rm(ref.lock, { force: true });
      },
    };
  }

  /** Every complete entry with its size and `lastUsed`, plus stale temp files and unpaired halves (removed here). */
  async #list(): Promise<Listed[]> {
    const listed: Listed[] = [];
    const now = this.#now();
    for (const project of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{16}$/.test(project)) continue;
      for (const target of await readdir(join(this.root, project)).catch(() => [] as string[])) {
        const dir = join(this.root, project, target);
        const names = await readdir(dir).catch(() => [] as string[]);
        const present = new Set(names);
        for (const name of names) {
          const path = join(dir, name);
          if (name.endsWith(".tmp") || name.endsWith(".tmp.sha256")) {
            const age = await stat(path).then((s) => now - s.mtimeMs, () => 0);
            if (age > ORPHAN_AGE_MS) await rm(path, { force: true });
            continue;
          }
          if (!name.endsWith(ARCHIVE_SUFFIX)) {
            if (name.endsWith(SIDECAR_SUFFIX) && !present.has(name.slice(0, -SIDECAR_SUFFIX.length) + ARCHIVE_SUFFIX)) {
              const age = await stat(path).then((s) => now - s.mtimeMs, () => 0);
              if (age > ORPHAN_AGE_MS) await rm(path, { force: true });
            }
            continue;
          }
          const key = name.slice(0, -ARCHIVE_SUFFIX.length);
          if (!HEX64.test(key)) continue;
          const ref: CacheEntryRef = { dir, key, archive: path, sidecar: join(dir, `${key}${SIDECAR_SUFFIX}`), lock: join(dir, `${key}${LOCK_SUFFIX}`) };
          const archive = await lstat(path).catch(() => undefined);
          if (!archive?.isFile()) continue;
          const sidecar = await stat(ref.sidecar).catch(() => undefined);
          if (!sidecar) {
            if (now - archive.mtimeMs > ORPHAN_AGE_MS && !present.has(`${key}${LOCK_SUFFIX}`)) await rm(path, { force: true });
            continue;
          }
          listed.push({ ref, size: archive.size, lastUsed: sidecar.mtimeMs });
        }
      }
    }
    return listed;
  }

  /** Entries and bytes in the cache. */
  async usage(): Promise<{ entries: number; bytes: number }> {
    const listed = await this.#list();
    return { entries: listed.length, bytes: listed.reduce((sum, e) => sum + e.size, 0) };
  }

  /**
   * Removes the least recently used entries until the cache fits
   * {@link maxBytes}. `keep` (the entry just stored or used) goes last;
   * entries whose lock a writer holds are skipped.
   */
  async evict(keep?: CacheEntryRef): Promise<{ removed: CacheEntryRef[]; bytes: number }> {
    const listed = await this.#list();
    let total = listed.reduce((sum, e) => sum + e.size, 0);
    const removed: CacheEntryRef[] = [];
    const order = listed.sort((a, b) => {
      const ak = keep && a.ref.archive === keep.archive ? 1 : 0;
      const bk = keep && b.ref.archive === keep.archive ? 1 : 0;
      return ak - bk || a.lastUsed - b.lastUsed;
    });
    for (const entry of order) {
      if (total <= this.maxBytes) break;
      if (await stat(entry.ref.lock).then(() => true, () => false)) continue;
      await this.discard(entry.ref);
      removed.push(entry.ref);
      total -= entry.size;
    }
    return { removed, bytes: total };
  }

  /** `/gui-cleanup --deps`: removes the whole cache directory. */
  async clear(): Promise<{ entries: number; bytes: number }> {
    const usage = await this.usage();
    await rm(this.root, { recursive: true, force: true });
    return usage;
  }

  async #readSidecar(ref: CacheEntryRef): Promise<string> {
    const info = await lstat(ref.sidecar);
    if (!info.isFile() || info.size > 512) throw new Error("not a small regular file");
    const text = await readFile(ref.sidecar, "utf8");
    const match = /^([0-9a-f]{64}) {2}(\S+)\n?$/.exec(text);
    if (!match || match[2] !== `${ref.key}${ARCHIVE_SUFFIX}`) throw new Error("malformed");
    return match[1];
  }

  async #discardUnlessLocked(ref: CacheEntryRef, reason: string): Promise<string> {
    const locked = await stat(ref.lock).then((s) => this.#now() - s.mtimeMs < LOCK_STALE_MS, () => false);
    if (locked) return `${reason}; another session is writing it, so it was left alone`;
    await this.discard(ref);
    return `${reason}; the entry was removed`;
  }
}
