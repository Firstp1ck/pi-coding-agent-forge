/**
 * Line framing for the helper protocol (spec §6, `docs/protocol.md`). Pure and
 * transport-agnostic: the protocol client feeds stdout chunks in and writes the
 * encoded requests out.
 */
import { randomBytes } from "node:crypto";
import { ownedSlice } from "./log-event.ts";
import {
  MAX_LINE_BYTES,
  READY_PREFIX,
  TOKEN_HEX_LENGTH,
  type HelperMessage,
  type Request,
} from "../protocol.ts";

/** Raised for framing violations that make the stream untrustworthy (fail closed). */
export class FramingError extends Error {
  readonly code = "PROTOCOL_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/** Returns a fresh random framing token of {@link TOKEN_HEX_LENGTH} hex characters. */
export function generateToken(): string {
  return randomBytes(TOKEN_HEX_LENGTH / 2).toString("hex");
}

/** Encodes one request as `<token> <json>\n`. JSON.stringify never emits a raw LF, so one request is one line. */
export function encodeRequest(token: string, request: Request): string {
  return `${token} ${JSON.stringify(request)}\n`;
}

/** The exact ready line the helper prints once it accepts requests. */
export function readyLine(token: string): string {
  return `${READY_PREFIX} ${token}`;
}

/**
 * Splits a byte stream into LF-terminated lines. Works on bytes so that a UTF-8
 * sequence split across chunks decodes correctly and the length bound is exact.
 * A trailing CR is removed. After an overflow the decoder stays failed, because
 * the rest of that line can no longer be told apart from the next one.
 */
export class LineDecoder {
  readonly #maxLineBytes: number;
  #parts: Buffer[] = [];
  #pending = 0;
  #failed = false;

  /** @param maxLineBytes Upper bound for one line without its terminator. */
  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /**
   * Consumes one chunk and returns the complete lines it finished.
   *
   * @throws FramingError when a line exceeds the bound (also on every later call).
   */
  push(chunk: Buffer | string): string[] {
    if (this.#failed) throw new FramingError("line decoder already failed");
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const lines: string[] = [];
    let nl = buf.indexOf(0x0a);
    while (nl !== -1) {
      if (this.#pending + nl > this.#maxLineBytes + 1) this.#overflow();
      this.#parts.push(buf.subarray(0, nl));
      lines.push(this.#takeLine());
      buf = buf.subarray(nl + 1);
      nl = buf.indexOf(0x0a);
    }
    if (buf.length > 0) {
      // +1 allows a CR that may belong to a CRLF terminator arriving in the next chunk.
      if (this.#pending + buf.length > this.#maxLineBytes + 1) this.#overflow();
      this.#parts.push(buf);
      this.#pending += buf.length;
    }
    return lines;
  }

  /** Returns the unterminated remainder (stream ended mid-line), if any, and resets. */
  flush(): string | undefined {
    if (this.#failed || this.#pending === 0) return undefined;
    return this.#takeLine();
  }

  #takeLine(): string {
    let line = Buffer.concat(this.#parts);
    this.#parts = [];
    this.#pending = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length > this.#maxLineBytes) this.#overflow();
    return line.toString("utf8");
  }

  #overflow(): never {
    this.#failed = true;
    this.#parts = [];
    this.#pending = 0;
    throw new FramingError(`protocol line exceeds ${this.#maxLineBytes} bytes`);
  }
}

/** Classification of one stdout line. */
export type ClassifiedLine =
  | { type: "ready" }
  | { type: "message"; message: HelperMessage }
  | { type: "diagnostic"; line: string };

/**
 * Classifies one decoded line. Only token-prefixed lines are protocol messages;
 * everything else (MOTD, rc output, stray app output) is a diagnostic.
 *
 * @throws FramingError when a token-prefixed line is not a valid helper message,
 *   since a helper that emits broken protocol lines cannot be trusted further.
 */
export function classifyLine(token: string, line: string): ClassifiedLine {
  if (line === readyLine(token)) return { type: "ready" };
  const prefix = `${token} `;
  if (!line.startsWith(prefix)) return { type: "diagnostic", line };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(prefix.length));
  } catch (error) {
    throw new FramingError(`protocol line is not valid JSON: ${(error as Error).message}`);
  }
  const problem = helperMessageProblem(parsed);
  if (problem) throw new FramingError(`invalid protocol message: ${problem}`);
  return { type: "message", message: parsed as HelperMessage };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns why `value` is not a {@link HelperMessage}, or `undefined` when it is one. */
export function helperMessageProblem(value: unknown): string | undefined {
  if (!isObject(value)) return "not a JSON object";
  if ("event" in value) {
    if (value.event !== "log") return `unknown event ${JSON.stringify(value.event)}`;
    if (value.stream !== "stdout" && value.stream !== "stderr") return "log event has an invalid stream";
    if (value.source !== "app" && value.source !== "setup") return "log event has an invalid source";
    if (typeof value.data !== "string") return "log event data is not a string";
    return undefined;
  }
  if (!Number.isSafeInteger(value.id)) return "response id is not an integer";
  if (value.ok === true) {
    if (!("result" in value)) return "success response has no result";
    return undefined;
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isObject(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      return "error response has no {code, message}";
    }
    return undefined;
  }
  return "response ok is not a boolean";
}

/**
 * Bounded ring buffer of diagnostic lines, so error messages can show recent
 * helper output without unbounded memory growth from a chatty helper.
 */
export class DiagnosticBuffer {
  readonly #maxLines: number;
  readonly #maxLineChars: number;
  #lines: string[] = [];

  constructor(maxLines = 50, maxLineChars = 500) {
    this.#maxLines = maxLines;
    this.#maxLineChars = maxLineChars;
  }

  /** Adds one line, truncating it and evicting the oldest line when full. */
  add(line: string): void {
    // Owned copies: a slice (even of a short line) can keep the whole decoded protocol line alive.
    const text = line.length > this.#maxLineChars ? `${ownedSlice(line, 0, this.#maxLineChars)}…` : ownedSlice(line);
    this.#lines.push(text);
    if (this.#lines.length > this.#maxLines) this.#lines.shift();
  }

  /** Lines in arrival order. */
  lines(): string[] {
    return [...this.#lines];
  }

  /** The most recent `count` lines as an indented block for error messages, or `""` when empty. */
  tail(count = 10): string {
    const recent = this.#lines.slice(-count);
    return recent.length === 0 ? "" : `\nrecent helper output:\n${recent.map((l) => `  ${l}`).join("\n")}`;
  }
}
