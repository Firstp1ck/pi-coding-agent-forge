/**
 * Runs a local process (here: `ssh`) with binary or streamed stdin, for tar
 * streams and image build contexts that the text-only {@link CommandRunner}
 * cannot carry. Timeout and abort signal the process group, then SIGKILL.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
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

/** Starts a process that daemonizes itself (`ssh -f`) and waits for the foreground part to exit. */
export interface DetachedRunner {
  /**
   * Runs `argv` with stdin and stdout on `/dev/null` and stderr in a log file,
   * so the background child keeps no pipe of ours open. Resolves when the
   * foreground process exits; `stderr` holds the log's tail.
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
      const log = openSync(options.logPath, "w", 0o600);
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
        } finally {
          closeSync(log);
        }
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
          options.signal?.removeEventListener("abort", onAbort);
          let stderr = "";
          try {
            stderr = readFileSync(options.logPath, "utf8").slice(-16 * 1024);
          } catch {
            // No log.
          }
          rmSync(options.logPath, { force: true });
          resolve({ exitCode: timedOut ? null : code, signal, stdout: "", stderr, timedOut, truncated: false, durationMs: Date.now() - started });
        };
        child.once("error", (error) => {
          if (child.pid === undefined) {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            rmSync(options.logPath, { force: true });
            reject(error);
          }
        });
        child.once("exit", finish);
      });
    },
  };
}
