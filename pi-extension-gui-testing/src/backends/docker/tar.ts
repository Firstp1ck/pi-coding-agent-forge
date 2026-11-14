/**
 * Minimal POSIX ustar writer for the image build context (spec §4.1). Writes
 * regular files and directories only, owned by root with mtime 0, so the same
 * inputs always give the same bytes and Docker's layer cache stays valid.
 */

export interface TarEntry {
  /** Relative path with `/` separators; directories may end in `/`. */
  path: string;
  type: "file" | "dir";
  /** Permission bits, e.g. 0o644. */
  mode: number;
  /** File content; ignored for directories. */
  data?: Buffer;
}

const BLOCK = 512;

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  // length - 1 octal digits, then NUL.
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  writeString(header, offset, length, `${text}\0`);
}

/** Splits a path into ustar `prefix` (≤155 bytes) and `name` (≤100 bytes). */
function splitPath(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { prefix, name };
  }
  throw new Error(`path too long for ustar: ${path}`);
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const path = entry.type === "dir" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  const { prefix, name } = splitPath(path);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, entry.mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = entry.type === "dir" ? 0x35 : 0x30;
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(block, 265, 32, "root");
  writeString(block, 297, 32, "root");
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** Builds a complete tar archive (with the two trailing zero blocks) from `entries`, in order. */
export function createTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error(`unsafe tar path: ${entry.path}`);
    const data = entry.type === "file" ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    parts.push(header(entry, data.length));
    if (data.length > 0) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Parsed entry of {@link listTar}, for tests and diagnostics. */
export interface TarListing {
  path: string;
  type: "file" | "dir" | "other";
  mode: number;
  size: number;
  data: Buffer;
}

/** Reads back an archive written by {@link createTar} (ustar subset only). */
export function listTar(archive: Buffer): TarListing[] {
  const entries: TarListing[] = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    const field = (start: number, length: number) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const mode = parseInt(field(100, 8).trim() || "0", 8);
    const flag = String.fromCharCode(block[156]);
    const path = prefix ? `${prefix}/${name}` : name;
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    entries.push({ path, type: flag === "5" ? "dir" : flag === "0" || flag === "\0" ? "file" : "other", mode, size, data: Buffer.from(data) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
