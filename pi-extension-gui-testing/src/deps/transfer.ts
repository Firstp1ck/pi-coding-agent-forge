/**
 * Moving dependency archives between the client cache and a session's helper
 * (protocol 2): chunked base64 over the normal request queue, each chunk at
 * most {@link DEPS_CHUNK_BYTES}, so a line never nears the frame limit and
 * memory stays bounded by one chunk. Both directions verify size and SHA-256:
 * the client while it stores a pulled archive, the helper before it unpacks
 * a pushed one.
 */
import { open } from "node:fs/promises";
import { SessionError, type Session } from "../backend.ts";
import { DEPS_CHUNK_BYTES } from "../protocol.ts";
import type { CacheHit, CacheWriter } from "./store.ts";

/** The parts of a {@link Session} the cache uses. */
export type DepsSession = Pick<Session, "request" | "arch" | "platform" | "capabilities">;

export interface TransferOptions {
  signal?: AbortSignal;
  /** Progress callback with bytes moved so far. */
  onProgress?(bytes: number, total: number): void;
}

/**
 * Pulls a packed archive (`depsPack` result) into `writer`. Never commits:
 * the caller commits with the announced size and hash.
 *
 * @throws SessionError for helper failures; Error when the helper sends more or other data than announced.
 */
export async function pullArchive(session: DepsSession, writer: CacheWriter, pack: { transfer: string; size: number }, options: TransferOptions = {}): Promise<void> {
  let offset = 0;
  for (;;) {
    const length = Math.min(DEPS_CHUNK_BYTES, Math.max(1, pack.size - offset));
    const chunk = await session.request("depsRead", { transfer: pack.transfer, offset, length }, { ...(options.signal ? { signal: options.signal } : {}) });
    const data = Buffer.from(chunk.data_base64, "base64");
    if (data.length > length || offset + data.length > pack.size) throw new Error(`the helper sent more archive data than announced (${offset + data.length} > ${pack.size} bytes)`);
    if (data.length === 0 && !chunk.eof) throw new Error("the helper sent an empty chunk before the end of the archive");
    if (data.length > 0) await writer.write(data);
    offset += data.length;
    options.onProgress?.(offset, pack.size);
    if (chunk.eof) break;
  }
  if (offset !== pack.size) throw new Error(`the archive ended after ${offset} of ${pack.size} bytes`);
}

/**
 * Pushes a verified cache entry to the helper and unpacks it into the
 * session's deps dir.
 *
 * @throws SessionError, e.g. `ARCHIVE_REJECTED` (the helper refused the archive and emptied its deps dir).
 */
export async function pushArchive(
  session: DepsSession,
  hit: CacheHit,
  bounds: { maxUnpackedBytes: number; maxEntries: number },
  options: TransferOptions = {},
): Promise<{ entries: number; bytes: number }> {
  const req = options.signal ? { signal: options.signal } : {};
  const { transfer } = await session.request("depsReceive", { size: hit.size, sha256: hit.sha256 }, req);
  let handed = false;
  try {
    const file = await open(hit.ref.archive, "r");
    try {
      const buffer = Buffer.allocUnsafe(DEPS_CHUNK_BYTES);
      let offset = 0;
      while (offset < hit.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(DEPS_CHUNK_BYTES, hit.size - offset), offset);
        if (bytesRead === 0) throw new Error(`the cached archive shrank while it was sent (${offset} of ${hit.size} bytes)`);
        const result = await session.request("depsWrite", { transfer, offset, data_base64: buffer.toString("base64", 0, bytesRead) }, req);
        offset += bytesRead;
        if (result.received !== offset) throw new SessionError("ARCHIVE_REJECTED", `the helper acknowledged ${result.received} of ${offset} bytes`);
        options.onProgress?.(offset, hit.size);
      }
    } finally {
      await file.close();
    }
    handed = true;
    return await session.request("depsUnpack", { transfer, maxUnpackedBytes: bounds.maxUnpackedBytes, maxEntries: bounds.maxEntries }, req);
  } finally {
    // depsUnpack consumes the upload; anything earlier leaves it to discard.
    if (!handed) await session.request("depsDiscard", { transfer }).catch(() => undefined);
  }
}
