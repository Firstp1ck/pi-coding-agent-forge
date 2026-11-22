/**
 * Runs a local process (here: `ssh`) with binary or streamed stdin, for tar
 * streams and image build contexts that the text-only {@link CommandRunner}
 * cannot carry. Timeout and abort signal the process group, then SIGKILL.
 */
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Spawner } from "../../backends/docker/process.ts";
import { minimalEnv } from "../../runner/spawn.ts";
import type { RunResult } from "../../runner/types.ts";
import { TailBuffer } from "../process.ts";

export interface PipedRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called with each complete output line, for progress. */
  onLine?: (line: string) => void;
  /** Bytes kept per stream (the tail). Default 256 KiB. */
  maxOutputBytes?: number;
  killGraceMs?: number;
  /** Text written to stdin before `input` (e.g. the environment preamble). */
  preamble?: string;
}

/**
 * Spawns `argv`, writes `input` to its stdin, and resolves with its result.
 * Rejects only when the process cannot be spawned or `signal` was aborted before.
 */
export function runPiped(spawner: Spawner, argv: readonly string[], input: Buffer | Readable, options: PipedRunOptions): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted before spawn"), { name: "AbortError" }));
  const max = options.maxOutputBytes ?? 256 * 1024;
  const grace = options.killGraceMs ?? 2_000;
  const started = Date.now();
  const child = spawner.spawn(argv, {});
  const out = new TailBuffer(max);
  const err = new TailBuffer(max);
  let partial = "";
  const lines = (chunk: Buffer) => {
    if (!options.onLine) return;
    partial += chunk.toString("utf8");
    const split = partial.split("\n");
    partial = split.pop() ?? "";
    for (const line of split) options.onLine(line);
  };
  child.stdout.on("data", (chunk: Buffer) => (out.add(chunk), lines(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (err.add(chunk), lines(chunk)));

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  const onAbort = () => terminate();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.preamble) child.stdin.write(options.preamble);
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : input;
  // EPIPE when the remote side exits early; the exit status reports what happened.
  pipeline(source, child.stdin).catch(() => {
    if (Buffer.isBuffer(input)) return;
    (input as Readable).destroy();
  });

  return child.exited.then((status) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
    if (status.error) throw status.error;
    return {
      exitCode: timedOut ? null : status.code,
      signal: status.signal,
      stdout: out.text(),
      stderr: err.text(),
      timedOut,
      truncated: out.truncated || err.truncated,
      durationMs: Date.now() - started,
    };
  });
}

/** Bytes of the log's tail a {@link DetachedRunner} returns as `stderr`. */
export const DETACHED_TAIL_BYTES = 16 * 1024;
/** Size at which a {@link DetachedRunner} log is cut back to empty (its tail kept in memory). */
export const DETACHED_LOG_CAP_BYTES = 1024 * 1024;
const LOG_CHECK_MS = 200;

/** The last `max` bytes of the file at `fd`, read by position into a fresh buffer (nothing larger is ever read). */
function readTail(fd: number, max: number): Buffer {
  const size = fstatSync(fd).size;
  const start = Math.max(0, size - max);
  const tail = Buffer.alloc(size - start);
  let read = 0;
  while (read < tail.length) {
    const n = readSync(fd, tail, read, tail.length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return tail.subarray(0, read);
}

/** UTF-8 text of `bytes` without a code point cut at the start; a copy that owns its memory. */
function tailText(bytes: Buffer): string {
  let from = 0;
  while (from < bytes.length && from < 4 && (bytes[from] & 0xc0) === 0x80) from++;
  return Buffer.from(bytes.subarray(from)).toString("utf8");
}

/** Starts a process that daemonizes itself (`ssh -f`) and waits for the foreground part to exit. */
export interface DetachedRunner {
  /**
   * Runs `argv` with stdin and stdout on `/dev/null` and stderr in a log file,
   * so the background child keeps no pipe of ours open. Resolves when the
   * foreground process exits; `stderr` holds the log's tail (at most
   * {@link DETACHED_TAIL_BYTES}). The log is kept below about
   * {@link DETACHED_LOG_CAP_BYTES}: past it, its tail is kept in memory and
   * the file is emptied (it is opened for append, so writes restart at 0).
   */
  run(argv: readonly string[], options: { logPath: string; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult>;
}

/** The real {@link DetachedRunner}. */
export function createDetachedRunner(baseEnv: NodeJS.ProcessEnv = process.env): DetachedRunner {
  return {
    run(argv, options) {
      if (argv.length === 0) return Promise.reject(new Error("empty argv"));
      if (options.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted before spawn"), { name: "AbortError" }));
      const started = Date.now();
      // Ours stays open for the tail reads and cuts; the child's copy appends, so a cut restarts its writes at 0.
      const log = openSync(options.logPath, constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      let closed = false;
      const closeLog = () => {
        if (closed) return;
        closed = true;
        try {
          closeSync(log);
        } catch {
          // Already closed.
        }
      };
      return new Promise<RunResult>((resolve, reject) => {
        let child;
        try {
          child = spawn(argv[0], argv.slice(1), {
            env: minimalEnv(baseEnv),
            stdio: ["ignore", "ignore", log],
            detached: process.platform !== "win32",
            shell: false,
            windowsHide: true,
          });
        } catch (error) {
          closeLog();
          rmSync(options.logPath, { force: true });
          throw error;
        }
        let carry: Buffer = Buffer.alloc(0);
        let truncated = false;
        const bound = () => {
          if (closed) return;
          try {
            if (fstatSync(log).size <= DETACHED_LOG_CAP_BYTES) return;
            // Bytes written between this read and the cut are lost; the kept tail is the log's end before it.
            carry = Buffer.from(readTail(log, DETACHED_TAIL_BYTES));
            ftruncateSync(log, 0);
            truncated = true;
          } catch {
            // The next check retries.
          }
        };
        const watch = setInterval(bound, LOG_CHECK_MS);
        watch.unref?.();
        let timedOut = false;
        const kill = (signal: NodeJS.Signals) => {
          if (child.pid === undefined) return;
          try {
            if (process.platform !== "win32") process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            // Already gone.
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill("SIGKILL");
        }, options.timeoutMs);
        const onAbort = () => kill("SIGKILL");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer);
          clearInterval(watch);
          options.signal?.removeEventListener("abort", onAbort);
          let stderr = "";
          try {
            const rest = readTail(log, DETACHED_TAIL_BYTES);
            const both = carry.length === 0 ? rest : Buffer.concat([carry, rest]);
            if (truncated || fstatSync(log).size > DETACHED_TAIL_BYTES) truncated = true;
            stderr = tailText(both.subarray(Math.max(0, both.length - DETACHED_TAIL_BYTES)));
          } catch {
            // No log.
          }
          carry = Buffer.alloc(0);
          closeLog();
          rmSync(options.logPath, { force: true });
          resolve({ exitCode: timedOut ? null : code, signal, stdout: "", stderr, timedOut, truncated, durationMs: Date.now() - started });
        };
        child.once("error", (error) => {
          if (child.pid === undefined) {
            clearTimeout(timer);
            clearInterval(watch);
            options.signal?.removeEventListener("abort", onAbort);
            closeLog();
            rmSync(options.logPath, { force: true });
            reject(error);
          }
        });
        child.once("exit", finish);
      });
    },
  };
}
