/**
 * Canonical log events. Helper events are untrusted: consumers receive only
 * the fields the protocol defines (`event`, `stream`, `source`, `data`), and
 * `data` as an independently owned string of bounded length. Neither extra
 * properties of a forged event nor the protocol line it was parsed from (up to
 * {@link MAX_LINE_BYTES}) stay reachable through a stored event.
 */
import { MAX_LOG_EVENT_BYTES, type LogEvent } from "../protocol.ts";

/** Appended to text that was cut to its limit. */
export const CUT_MARKER = "… (cut)\n";

/**
 * A flat copy of `text.slice(start, end)` that shares no memory with `text`.
 * A plain `slice` may keep the whole parent string alive; the copy through a
 * Buffer never does. A surrogate pair split at a boundary becomes U+FFFD.
 */
export function ownedSlice(text: string, start = 0, end = text.length): string {
  return Buffer.from(text.slice(start, end), "utf8").toString("utf8");
}

/**
 * The known fields of `event`, with `data` owned and cut to `maxChars`
 * characters (then followed by {@link CUT_MARKER}). Unknown `stream` or
 * `source` values fall back to `stdout` and `app`.
 */
export function canonicalLogEvent(event: LogEvent, maxChars: number = MAX_LOG_EVENT_BYTES): LogEvent {
  const raw = typeof event.data === "string" ? event.data : String(event.data);
  return {
    event: "log",
    stream: event.stream === "stderr" ? "stderr" : "stdout",
    source: event.source === "setup" ? "setup" : "app",
    data: raw.length > maxChars ? `${ownedSlice(raw, 0, maxChars)}${CUT_MARKER}` : ownedSlice(raw),
  };
}

/** The last `maxChars` characters of a stream of text, held as one owned string. */
export class TextTail {
  readonly #max: number;
  #text = "";

  constructor(maxChars: number) {
    this.#max = maxChars;
  }

  push(text: string): void {
    const joined = this.#text + text;
    this.#text = ownedSlice(joined, Math.max(0, joined.length - this.#max));
  }

  get text(): string {
    return this.#text;
  }
}
