/**
 * Transport-agnostic protocol client over a helper's stdio (spec §6). Backends
 * hand it the stdin/stdout of whatever runs the helper (`docker run -i`, a local
 * spawn, SSH) and keep owning that process.
 */
import type { Readable, Writable } from "node:stream";
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  QUEUE_BYPASS_METHODS,
  READY_TIMEOUT_MS,
  type ErrorCode,
  type HelperMessage,
  type LogEvent,
  type Method,
  type Params,
  type Request,
  type Response,
  type Result,
} from "../protocol.ts";
import { classifyLine, DiagnosticBuffer, encodeRequest, FramingError, LineDecoder } from "./codec.ts";

/**
 * Client-side failure codes: every protocol {@link ErrorCode} plus `CLOSED`
 * (stream ended or client closed) and `PROTOCOL_ERROR` (framing violation).
 */
export type ClientErrorCode = ErrorCode | "CLOSED" | "PROTOCOL_ERROR";

/**
 * Error raised by {@link ProtocolClient}. Mirrors `SessionError` from
 * `src/backend.ts` (same `code` + `message` shape); it is a separate class
 * because `backend.ts` cannot be loaded under Node's type stripping.
 */
export class ProtocolClientError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = "ProtocolClientError";
    this.code = code;
  }
}

export interface ProtocolClientOptions {
  /** Helper stdin. */
  stdin: Writable;
  /** Helper stdout. */
  stdout: Readable;
  /** Framing token passed to the helper in `PI_GUI_TESTING_TOKEN`. */
  token: string;
  readyTimeoutMs?: number;
  /** Interval of heartbeat `ping`s while open; `0` disables them (tests only). */
  heartbeatIntervalMs?: number;
  /** Default per-request timeout when the caller passes none. */
  defaultTimeoutMs?: number;
  /**
   * After a request times out or is aborted, the queue waits this long for the
   * helper's `CANCELLED` answer before sending the next request, so the client
   * and helper queues stay aligned.
   */
  cancelGraceMs?: number;
  maxLineBytes?: number;
  onLog?: (event: LogEvent) => void;
  /** Called once when the client closes, with the reason. */
  onClose?: (error: ProtocolClientError) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  id: number;
  method: Method;
  resolve: (result: unknown) => void;
  reject: (error: ProtocolClientError) => void;
  /** Resolves when the helper answered (or the grace elapsed), releasing the queue slot. */
  settled: Promise<void>;
  markSettled: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;

/**
 * One connection to a helper. Requests run one at a time in call order, except
 * `ping` and `cancel`, which bypass the queue. Every request has a timeout and
 * honours an AbortSignal; on either, the client sends `cancel` and rejects.
 * When the stream ends, every pending request fails with `CLOSED`.
 */
export class ProtocolClient {
  readonly #opts: Required<Omit<ProtocolClientOptions, "onLog" | "onClose">> & Pick<ProtocolClientOptions, "onLog" | "onClose">;
  readonly #decoder: LineDecoder;
  readonly #diagnostics = new DiagnosticBuffer();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #queueTail: Promise<void> = Promise.resolve();
  #ready = false;
  #readyWaiter?: { resolve: () => void; reject: (error: ProtocolClientError) => void };
  #closed?: ProtocolClientError;
  #heartbeat?: NodeJS.Timeout;

  constructor(options: ProtocolClientOptions) {
    this.#opts = {
      readyTimeoutMs: READY_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      defaultTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      cancelGraceMs: DEFAULT_CANCEL_GRACE_MS,
      maxLineBytes: MAX_LINE_BYTES,
      ...options,
    };
    this.#decoder = new LineDecoder(this.#opts.maxLineBytes);
    const { stdout, stdin } = this.#opts;
    stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk));
    stdout.on("end", () => this.#onStreamEnd("helper stdout ended"));
    stdout.on("close", () => this.#onStreamEnd("helper stdout closed"));
    stdout.on("error", (error: Error) => this.#onStreamEnd(`helper stdout failed: ${error.message}`));
    // EPIPE after the helper died must not crash Pi; the stdout side reports the closure.
    stdin.on("error", () => {});
  }

  /** `true` until the stream ends or {@link close} is called. */
  get isOpen(): boolean {
    return this.#closed === undefined;
  }

  /** Recent non-protocol stdout lines, for error reports. */
  diagnostics(): string[] {
    return this.#diagnostics.lines();
  }

  /**
   * Waits for the ready line, then performs the `hello` handshake. Fails closed:
   * any failure (ready timeout, `PROTOCOL_MISMATCH`, stream end) closes the client.
   *
   * @returns The helper's `hello` result.
   */
  async connect(packageVersion: string, signal?: AbortSignal): Promise<Result<"hello">> {
    try {
      await this.#waitReady(signal);
      const hello = await this.request("hello", { protocol: PROTOCOL_VERSION, packageVersion }, { signal });
      if (hello.protocol !== PROTOCOL_VERSION) {
        throw new ProtocolClientError(
          "PROTOCOL_MISMATCH",
          `helper speaks protocol ${hello.protocol}, this client needs ${PROTOCOL_VERSION}`,
        );
      }
      this.#startHeartbeat();
      return hello;
    } catch (error) {
      const failure = toClientError(error);
      this.close(failure);
      throw failure;
    }
  }

  /**
   * Sends one request and resolves with its result.
   *
   * @throws ProtocolClientError with the helper's error code, `TIMEOUT`,
   *   `CANCELLED` (signal aborted), or `CLOSED`.
   */
  request<M extends Method>(method: M, params: Params<M>, options: RequestOptions = {}): Promise<Result<M>> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (options.signal?.aborted) return Promise.reject(new ProtocolClientError("CANCELLED", `${method} was cancelled`));
    const timeoutMs = options.timeoutMs ?? this.#opts.defaultTimeoutMs;
    const bypass = (QUEUE_BYPASS_METHODS as readonly string[]).includes(method);

    return new Promise<Result<M>>((resolve, reject) => {
      let sent: Pending | undefined;
      let finished = false;
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: ProtocolClientError) => {
        if (finished) return;
        cleanup();
        if (sent) this.#abandon(sent);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new ProtocolClientError("TIMEOUT", `${method} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      const onAbort = () => fail(new ProtocolClientError("CANCELLED", `${method} was cancelled`));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const send = (): Promise<void> => {
        if (finished) return Promise.resolve();
        if (this.#closed) {
          fail(this.#closed);
          return Promise.resolve();
        }
        sent = this.#send(method, params, {
          resolve: (result) => {
            if (finished) return;
            cleanup();
            resolve(result as Result<M>);
          },
          reject: (error) => {
            if (finished) return;
            cleanup();
            reject(error);
          },
        });
        return sent.settled;
      };

      if (bypass) {
        void send();
      } else {
        const previous = this.#queueTail;
        this.#queueTail = previous.then(send);
      }
    });
  }

  /**
   * Closes the client: stops the heartbeat, fails every pending request, and
   * ends the helper's stdin (which makes a well-behaved helper tear down).
   * Idempotent; does not kill the helper process, which the backend owns.
   */
  close(reason: ProtocolClientError = new ProtocolClientError("CLOSED", "protocol client closed")): void {
    if (this.#closed) return;
    this.#closed = reason;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#readyWaiter?.reject(reason);
    this.#readyWaiter = undefined;
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
      pending.markSettled();
    }
    this.#pending.clear();
    try {
      this.#opts.stdin.end();
    } catch {
      // Already destroyed; nothing left to end.
    }
    this.#opts.onClose?.(reason);
  }

  #send(method: Method, params: unknown, handlers: Pick<Pending, "resolve" | "reject">): Pending {
    const id = this.#nextId++;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    const pending: Pending = { id, method, ...handlers, settled, markSettled };
    this.#pending.set(id, pending);
    const request = { id, method, params } as Request;
    try {
      this.#opts.stdin.write(encodeRequest(this.#opts.token, request));
    } catch (error) {
      this.close(new ProtocolClientError("CLOSED", `cannot write to helper: ${(error as Error).message}`));
    }
    return pending;
  }

  /** Called when the caller gave up on a sent request: ask the helper to cancel it and bound the wait for its answer. */
  #abandon(pending: Pending): void {
    if (!this.#pending.has(pending.id)) return;
    pending.resolve = () => {};
    pending.reject = () => {};
    if (pending.method !== "cancel" && pending.method !== "ping" && !this.#closed) {
      this.request("cancel", { targetId: pending.id }, { timeoutMs: this.#opts.cancelGraceMs }).catch(() => {});
    }
    const grace = setTimeout(() => {
      this.#pending.delete(pending.id);
      pending.markSettled();
    }, this.#opts.cancelGraceMs);
    grace.unref?.();
    void pending.settled.then(() => clearTimeout(grace));
  }

  #waitReady(signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#readyWaiter = undefined;
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new ProtocolClientError(
            "TIMEOUT",
            `helper did not print its ready line within ${this.#opts.readyTimeoutMs} ms${this.#diagnostics.tail()}`,
          ),
        );
      }, this.#opts.readyTimeoutMs);
      const onAbort = () => {
        done();
        reject(new ProtocolClientError("CANCELLED", "connect was cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#readyWaiter = {
        resolve: () => {
          done();
          resolve();
        },
        reject: (error) => {
          done();
          reject(error);
        },
      };
    });
  }

  #startHeartbeat(): void {
    const interval = this.#opts.heartbeatIntervalMs;
    if (interval <= 0 || this.#closed) return;
    this.#heartbeat = setInterval(() => {
      // A lost ping is not fatal by itself; a dead helper ends the stream, which closes the client.
      this.request("ping", {}, { timeoutMs: interval }).catch(() => {});
    }, interval);
    this.#heartbeat.unref?.();
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closed) return;
    try {
      for (const line of this.#decoder.push(chunk)) {
        this.#onLine(line);
        if (this.#closed) return;
      }
    } catch (error) {
      this.close(toClientError(error, this.#diagnostics.tail()));
    }
  }

  #onLine(line: string): void {
    const classified = classifyLine(this.#opts.token, line);
    if (classified.type === "diagnostic") {
      this.#diagnostics.add(classified.line);
      return;
    }
    if (classified.type === "ready") {
      this.#ready = true;
      this.#readyWaiter?.resolve();
      return;
    }
    if (!this.#ready) {
      // Protocol traffic before READY violates the framing contract.
      throw new FramingError("protocol message received before the ready line");
    }
    this.#onMessage(classified.message);
  }

  #onMessage(message: HelperMessage): void {
    if ("event" in message) {
      this.#opts.onLog?.(message);
      return;
    }
    const response = message as Response;
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#diagnostics.add(`response for unknown request id ${response.id}`);
      return;
    }
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new ProtocolClientError(response.error.code, response.error.message));
    pending.markSettled();
  }

  #onStreamEnd(reason: string): void {
    if (this.#closed) return;
    const rest = this.#decoder.flush();
    if (rest !== undefined && rest.length > 0) this.#diagnostics.add(rest);
    this.close(new ProtocolClientError("CLOSED", `${reason}${this.#diagnostics.tail()}`));
  }
}

function toClientError(error: unknown, suffix = ""): ProtocolClientError {
  if (error instanceof ProtocolClientError) return error;
  if (error instanceof FramingError) return new ProtocolClientError("PROTOCOL_ERROR", `${error.message}${suffix}`);
  return new ProtocolClientError("INTERNAL", `${(error as Error)?.message ?? String(error)}${suffix}`);
}
