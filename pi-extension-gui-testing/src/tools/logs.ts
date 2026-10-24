/**
 * Bounded per-session log store for `gui_logs` (spec §8). App and setup output
 * arrives as helper `log` events; the newest output is kept in memory and every
 * event is also appended to the session's temporary `app.log`.
 *
 * Log events come from the container and are untrusted: each stored event is
 * canonical (known fields only, its text an owned copy cut at
 * {@link LOG_LIMITS.eventChars}), so nothing else a forged event carries is
 * retained; memory is bounded by event count and by bytes (each event counts
 * its text plus a fixed overhead); pending disk writes are coalesced into one
 * append at a time and bounded, with a "dropped N" marker (also written by
 * {@link LogBuffer.flush}); the file stops growing at {@link LOG_LIMITS.fileBytes}.
 */
import { close as closeFd, constants, open as openFd, write as writeFd } from "node:fs";
import { promisify } from "node:util";

const openAsync = promisify(openFd);
// fs.write has a custom promisified form that resolves to { bytesWritten, buffer }.
const writeAsync = promisify(writeFd) as unknown as (fd: number, buffer: Buffer) => Promise<{ bytesWritten: number }>;
const closeAsync = promisify(closeFd);
import { canonicalLogEvent } from "../framing/log-event.ts";
import type { LogEvent } from "../protocol.ts";

export const DEFAULT_LOG_MEMORY_BYTES = 1024 * 1024;

export const LOG_LIMITS = {
  /** Events kept in memory. */
  events: 10_000,
  /** Characters kept of one event's text (in memory and on disk). */
  eventChars: 64 * 1024,
  /** Bytes charged per event on top of its text (object, source, stream). */
  eventOverhead: 64,
  /** Characters waiting for the disk; more is dropped and counted. */
  pendingChars: 4 * 1024 * 1024,
  /** Size of `app.log`; later output stays in memory only. */
  fileBytes: 64 * 1024 * 1024,
} as const;

export type LogLimits = { [K in keyof typeof LOG_LIMITS]: number };

export class LogBuffer {
  readonly #max: number;
  readonly #file?: string;
  /** A plain descriptor, not a FileHandle: an unclosed FileHandle throws when garbage-collected. */
  #fd?: number;
  #openFailed = false;
  #closed = false;
  readonly #limits: LogLimits;
  #events: LogEvent[] = [];
  #bytes = 0;
  /** Lines waiting for the disk and their length. */
  #pending: string[] = [];
  #pendingChars = 0;
  /** Events not written because the queue was full, since the last marker. */
  #droppedWrites = 0;
  #fileBytes = 0;
  #fileFull = false;
  /** The running append loop, if any. */
  #writing?: Promise<void>;
  /** Events dropped from memory (oldest first). */
  dropped = 0;

  /** @param file Optional path to append every event to (best effort). */
  constructor(file?: string, maxBytes: number = DEFAULT_LOG_MEMORY_BYTES, limits: Partial<LogLimits> = {}) {
    this.#file = file;
    this.#max = maxBytes;
    this.#limits = { ...LOG_LIMITS, ...limits };
  }

  #cost(event: LogEvent): number {
    return event.data.length + this.#limits.eventOverhead;
  }

  add(event: LogEvent): void {
    const kept = canonicalLogEvent(event, this.#limits.eventChars);
    this.#events.push(kept);
    this.#bytes += this.#cost(kept);
    while ((this.#bytes > this.#max || this.#events.length > this.#limits.events) && this.#events.length > 1) {
      this.#bytes -= this.#cost(this.#events.shift()!);
      this.dropped++;
    }
    if (this.#file) this.#persist(kept);
  }

  #persist(event: LogEvent): void {
    if (this.#fileFull) return;
    const text = event.data.endsWith("\n") ? event.data : `${event.data}\n`;
    const line = `[${event.source} ${event.stream}] ${text}`;
    if (this.#pendingChars + line.length > this.#limits.pendingChars) {
      this.#droppedWrites++;
      return;
    }
    this.#queueDropMarker();
    this.#queue(line);
  }

  /** Queues the "dropped N" marker for writes dropped since the last one (it may exceed the pending bound). */
  #queueDropMarker(): void {
    if (this.#droppedWrites === 0 || this.#fileFull) return;
    this.#queue(`[gui-testing] dropped ${this.#droppedWrites} log event(s): the disk could not keep up\n`);
    this.#droppedWrites = 0;
  }

  #queue(line: string): void {
    this.#pending.push(line);
    this.#pendingChars += line.length;
    if (!this.#writing) this.#startDrain();
  }

  #startDrain(): void {
    this.#writing = this.#drain().finally(() => {
      this.#writing = undefined;
      if (this.#pending.length > 0 && !this.#fileFull) this.#startDrain();
    });
  }

  /** Appends queued lines one batch at a time until the queue is empty. */
  async #drain(): Promise<void> {
    const file = this.#file!;
    while (this.#pending.length > 0 && !this.#fileFull) {
      let batch = this.#pending.join("");
      this.#pending = [];
      this.#pendingChars = 0;
      const room = this.#limits.fileBytes - this.#fileBytes;
      let bytes = Buffer.byteLength(batch);
      if (bytes > room) {
        const marker = "\n[gui-testing] app.log reached its size limit; later output is kept in memory only (gui_logs)\n";
        batch = `${Buffer.from(batch).subarray(0, Math.max(0, room - Buffer.byteLength(marker))).toString("utf8")}${marker}`;
        bytes = Buffer.byteLength(batch);
        this.#fileFull = true;
        this.#pending = [];
        this.#pendingChars = 0;
      }
      try {
        const fd = await this.#descriptor(file);
        if (fd !== undefined) {
          let rest = Buffer.from(batch);
          while (rest.length > 0) {
            const { bytesWritten } = await writeAsync(fd, rest);
            if (!(bytesWritten > 0)) throw new Error("app.log write made no progress");
            rest = rest.subarray(bytesWritten);
          }
          this.#fileBytes += bytes;
        }
      } catch {
        // Best effort: the in-memory buffer still has the output.
      }
    }
  }

  /**
   * The log file, created once with O_EXCL and then written through the kept descriptor: an entry planted at
   * that path (a symbolic or hard link) makes the creation fail instead of being written through, and a
   * later swap of the path cannot redirect writes. `undefined` when the file cannot be created (the
   * in-memory buffer still has the output) or after `close()`.
   */
  async #descriptor(file: string): Promise<number | undefined> {
    if (this.#closed) return undefined;
    if (this.#fd === undefined) {
      if (this.#openFailed) return undefined;
      try {
        this.#fd = await openAsync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
      } catch (error) {
        this.#openFailed = true;
        throw error;
      }
    }
    return this.#fd;
  }

  /**
   * Flushes, then releases the log file (before the session dir is removed: Windows cannot delete a
   * directory holding an open file). Later output stays in memory only. Idempotent; never rejects.
   */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) await closeAsync(fd).catch(() => {});
  }

  /**
   * Waits for pending file writes (before the session dir is exported or
   * removed), first queueing the marker for writes dropped since the last
   * event. Never rejects.
   */
  async flush(): Promise<void> {
    if (this.#file) this.#queueDropMarker();
    while (this.#writing) await this.#writing;
  }

  /**
   * The last `lines` lines, each prefixed with its source and stream.
   *
   * @param source Restrict to app or setup output.
   */
  tail(lines: number, source?: LogEvent["source"]): string[] {
    const out: string[] = [];
    for (let i = this.#events.length - 1; i >= 0 && out.length < lines; i--) {
      const event = this.#events[i];
      if (source && event.source !== source) continue;
      const parts = event.data.replace(/\n$/, "").split("\n");
      for (let j = parts.length - 1; j >= 0 && out.length < lines; j--) out.push(`[${event.source} ${event.stream}] ${parts[j]}`);
    }
    return out.reverse();
  }
}
