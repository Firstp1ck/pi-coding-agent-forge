/**
 * Archives uploaded into a sandbox: the workspace (the §4.7 file set) and the
 * helper tooling. A sandbox is reached only through `cua sandbox cp` (one
 * file per call), so each is one tar file staged in the 0700 client session
 * dir, uploaded, and unpacked in the guest.
 *
 * The workspace archive is streamed: each file is opened with
 * {@link openSyncedFile} (no final symlink, same identity as enumerated, still
 * inside the root) and exactly the size it had when opened is written; a file
 * that shrinks meanwhile fails the sync (fail closed). Paths and link targets
 * beyond the ustar limits use pax extended headers.
 */
import { open, type FileHandle } from "node:fs/promises";
import type { SyncSummary } from "../../backend.ts";
import { openSyncedFile, SyncChangedError } from "../../sync/copy.ts";
import type { FileSet } from "../../sync/fileset.ts";

const BLOCK = 512;
const CHUNK = 1024 * 1024;

function field(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(header, offset);
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  field(header, offset, length, `${text}\0`);
}

/** `prefix`/`name` split for ustar, or `undefined` when the path needs a pax header. */
function ustarSplit(path: string): { prefix: string; name: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { prefix, name };
  }
  return undefined;
}

type Kind = "file" | "dir" | "symlink" | "pax";
const TYPE_FLAG: Record<Kind, number> = { file: 0x30, dir: 0x35, symlink: 0x32, pax: 0x78 };

function header(path: string, kind: Kind, mode: number, size: number, link = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  // A path beyond ustar's limits is carried by the preceding pax header; the ustar name is a placeholder.
  const split = ustarSplit(path) ?? { prefix: "", name: kind === "dir" ? "pax-long-path/" : "pax-long-path" };
  field(block, 0, 100, split.name);
  octal(block, 100, 8, mode & 0o7777);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = TYPE_FLAG[kind];
  if (Buffer.byteLength(link) <= 100) field(block, 157, 100, link);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, split.prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function padding(size: number): Buffer {
  const pad = (BLOCK - (size % BLOCK)) % BLOCK;
  return Buffer.alloc(pad);
}

/** Sequential tar writer on an open file. */
export class TarWriter {
  readonly #out: FileHandle;
  bytes = 0;

  constructor(out: FileHandle) {
    this.#out = out;
  }

  async #write(data: Buffer): Promise<void> {
    if (data.length === 0) return;
    await this.#out.write(data);
    this.bytes += data.length;
  }

  /** Writes the header(s) of one entry, with a pax header first when a path or link is too long for ustar. */
  async #header(path: string, kind: Exclude<Kind, "pax">, mode: number, size: number, link = ""): Promise<void> {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) throw new Error(`unsafe tar path: ${path}`);
    const records = [];
    if (!ustarSplit(path)) records.push(paxRecord("path", path));
    if (Buffer.byteLength(link) > 100) records.push(paxRecord("linkpath", link));
    if (records.length > 0) {
      const data = Buffer.from(records.join(""), "utf8");
      await this.#write(header("PaxHeader", "pax", 0o644, data.length));
      await this.#write(data);
      await this.#write(padding(data.length));
    }
    await this.#write(header(path, kind, mode, size, link));
  }

  async dir(path: string, mode = 0o755): Promise<void> {
    await this.#header(path.endsWith("/") ? path : `${path}/`, "dir", mode, 0);
  }

  async symlink(path: string, target: string): Promise<void> {
    await this.#header(path, "symlink", 0o777, 0, target);
  }

  async buffer(path: string, data: Buffer, mode = 0o644): Promise<void> {
    await this.#header(path, "file", mode, data.length);
    await this.#write(data);
    await this.#write(padding(data.length));
  }

  /**
   * Streams `size` bytes of `source`.
   *
   * @throws SyncChangedError when the file ends early (it shrank while being read).
   */
  async file(path: string, source: FileHandle, size: number, mode: number, signal?: AbortSignal): Promise<void> {
    await this.#header(path, "file", mode, size);
    const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    let done = 0;
    while (done < size) {
      if (signal?.aborted) throw Object.assign(new Error("the workspace upload was cancelled"), { name: "AbortError" });
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, size - done), done);
      if (bytesRead === 0) throw new SyncChangedError(path, "it shrank while it was being archived");
      await this.#write(chunk.subarray(0, bytesRead));
      done += bytesRead;
    }
    await this.#write(padding(size));
  }

  async end(): Promise<void> {
    await this.#write(Buffer.alloc(BLOCK * 2));
  }
}

/** Parent directories of `path` (`a/b/c` → `a`, `a/b`). */
function parents(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Writes the synced file set as a tar file at `dest` (created 0600, must not
 * exist). Returns the sync summary: files and links written, their bytes,
 * and the excluded count.
 */
export async function writeWorkspaceTar(set: FileSet, dest: string, signal?: AbortSignal): Promise<SyncSummary> {
  const out = await open(dest, "wx", 0o600);
  let files = 0;
  let bytes = 0;
  try {
    const tar = new TarWriter(out);
    const dirs = new Set<string>();
    for (const entry of set.entries) {
      for (const dir of parents(entry.path)) {
        if (dirs.has(dir)) continue;
        dirs.add(dir);
        await tar.dir(dir);
      }
      if (entry.type === "symlink") {
        await tar.symlink(entry.path, entry.linkTarget ?? "");
        files++;
        continue;
      }
      const handle = await openSyncedFile(set.root, entry);
      try {
        const size = (await handle.stat()).size;
        await tar.file(entry.path, handle, size, entry.mode & 0o777, signal);
        bytes += size;
        files++;
      } finally {
        await handle.close();
      }
    }
    await tar.end();
    await out.sync();
  } finally {
    await out.close();
  }
  return { files, bytes, excluded: set.excluded.length };
}

/** Writes an in-memory archive (the helper tooling) to `dest` (created 0600, must not exist). */
export async function writeBufferFile(dest: string, data: Buffer): Promise<void> {
  const out = await open(dest, "wx", 0o600);
  try {
    await out.writeFile(data);
  } finally {
    await out.close();
  }
}
