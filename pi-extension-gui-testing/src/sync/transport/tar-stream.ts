/**
 * Streaming POSIX tar (ustar with PAX extended headers) for the `tar` sync
 * fallback and the remote helper deploy (spec §4.2a). Writes regular files,
 * directories, and symlinks; long or non-ASCII names and link targets go into
 * PAX records, which GNU tar, bsdtar, and BusyBox tar read. Files stream
 * chunk by chunk, so archive size is not bounded by memory.
 */
import { Readable } from "node:stream";

export interface TarStreamEntry {
  /** Relative path with `/` separators; no `..`, no leading `/`. */
  path: string;
  type: "file" | "dir" | "symlink";
  /** Permission bits. */
  mode: number;
  /** Seconds since the epoch. */
  mtime?: number;
  /** File size; the data source must deliver exactly this many bytes. */
  size?: number;
  /** For symlinks. */
  linkTarget?: string;
  /** For files: in-memory content … */
  data?: Buffer;
  /** … or a stream opened when the entry is written. */
  open?: () => Promise<AsyncIterable<Buffer>>;
}

const BLOCK = 512;
const MAX_OCTAL_11 = 8 ** 11 - 1;

/** `true` for a clean relative archive path. */
export function safeArchivePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function writeField(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(block, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeField(block, offset, length, `${Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0")}\0`);
}

function header(name: string, typeflag: string, options: { mode: number; size: number; mtime: number; linkname?: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeField(block, 0, 100, name);
  writeOctal(block, 100, 8, options.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, Math.min(options.size, MAX_OCTAL_11));
  writeOctal(block, 136, 12, Math.min(options.mtime, MAX_OCTAL_11));
  block.fill(0x20, 148, 156);
  block.write(typeflag, 156, "latin1");
  if (options.linkname) writeField(block, 157, 100, options.linkname);
  writeField(block, 257, 6, "ustar\0");
  writeField(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeField(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** One PAX record: `<len> <key>=<value>\n`, where `<len>` counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

const ASCII_SHORT = (value: string, max: number) => /^[\x20-\x7e]*$/.test(value) && value.length <= max;

function padding(size: number): Buffer | undefined {
  const pad = (BLOCK - (size % BLOCK)) % BLOCK;
  return pad > 0 ? Buffer.alloc(pad) : undefined;
}

/** Header blocks (a PAX header first when needed) for one entry. */
export function entryHeaders(entry: TarStreamEntry): Buffer[] {
  if (!safeArchivePath(entry.path)) throw new Error(`unsafe archive path ${JSON.stringify(entry.path)}`);
  const size = entry.type === "file" ? (entry.size ?? entry.data?.length ?? 0) : 0;
  const path = entry.type === "dir" ? `${entry.path}/` : entry.path;
  const mtime = entry.mtime ?? 0;
  const records: string[] = [];
  if (!ASCII_SHORT(path, 100)) records.push(paxRecord("path", path));
  if (entry.type === "symlink") {
    if (!entry.linkTarget || entry.linkTarget.includes("\0")) throw new Error(`symlink ${entry.path} has no target`);
    if (!ASCII_SHORT(entry.linkTarget, 100)) records.push(paxRecord("linkpath", entry.linkTarget));
  }
  if (size > MAX_OCTAL_11) records.push(paxRecord("size", String(size)));
  const blocks: Buffer[] = [];
  if (records.length > 0) {
    const body = Buffer.from(records.join(""), "utf8");
    blocks.push(header("PaxHeader", "x", { mode: 0o644, size: body.length, mtime }), body);
    const pad = padding(body.length);
    if (pad) blocks.push(pad);
  }
  const shortName = ASCII_SHORT(path, 100) ? path : Buffer.from(path, "utf8").subarray(0, 99).toString("latin1").replace(/[^\x20-\x7e]/g, "_");
  const typeflag = entry.type === "file" ? "0" : entry.type === "dir" ? "5" : "2";
  const linkname = entry.type === "symlink" ? (ASCII_SHORT(entry.linkTarget!, 100) ? entry.linkTarget! : "PaxLink") : undefined;
  blocks.push(header(shortName, typeflag, { mode: entry.mode, size, mtime, ...(linkname ? { linkname } : {}) }));
  return blocks;
}

async function* archive(entries: AsyncIterable<TarStreamEntry> | Iterable<TarStreamEntry>, counter: { bytes: number }): AsyncGenerator<Buffer> {
  const emit = (chunk: Buffer) => {
    counter.bytes += chunk.length;
    return chunk;
  };
  for await (const entry of entries) {
    for (const block of entryHeaders(entry)) yield emit(block);
    if (entry.type !== "file") continue;
    const size = entry.size ?? entry.data?.length ?? 0;
    if (entry.data) {
      if (entry.data.length !== size) throw new Error(`${entry.path}: ${entry.data.length} bytes, expected ${size}`);
      if (size > 0) yield emit(entry.data);
    } else if (entry.open) {
      let written = 0;
      for await (const chunk of await entry.open()) {
        if (written + chunk.length > size) throw new Error(`${entry.path} grew while it was archived`);
        written += chunk.length;
        yield emit(chunk);
      }
      if (written !== size) throw new Error(`${entry.path} shrank while it was archived (${written} of ${size} bytes)`);
    } else if (size > 0) {
      throw new Error(`${entry.path}: no data source`);
    }
    const pad = padding(size);
    if (pad) yield emit(pad);
  }
  yield emit(Buffer.alloc(BLOCK * 2));
}

/**
 * A readable tar stream of `entries`. `counter.bytes` counts the bytes
 * produced so far (the archive size once the stream ended).
 */
export function tarStream(entries: AsyncIterable<TarStreamEntry> | Iterable<TarStreamEntry>, counter: { bytes: number } = { bytes: 0 }): Readable {
  return Readable.from(archive(entries, counter), { objectMode: false });
}

/** Collects a whole archive in memory (small archives such as the helper deploy, and tests). */
export async function tarBuffer(entries: Iterable<TarStreamEntry>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of archive(entries, { bytes: 0 })) chunks.push(chunk);
  return Buffer.concat(chunks);
}
