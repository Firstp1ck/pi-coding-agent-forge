/**
 * Long-lived and streaming `docker` processes (`docker run -i`, `docker build -`).
 * The {@link CommandRunner} covers short calls with text input; these need open
 * pipes or binary stdin. Unit tests substitute a {@link Spawner} fake.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { minimalEnv } from "../../runner/spawn.ts";
import type { RunResult } from "../../runner/types.ts";

export interface ExitStatus {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be spawned. */
  error?: Error;
}

/** A running child with open pipes. */
export interface ChildHandle {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves once the process exited (or failed to spawn). Never rejects. */
  readonly exited: Promise<ExitStatus>;
  /** `true` until the process exited. */
  running(): boolean;
  /** Signals the child's process group (POSIX) or the child. Ignores a child that already exited. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  /** Merged over the runner's minimal inherited environment. */
  env?: Record<string, string>;
}

export interface Spawner {
  spawn(argv: readonly string[], options?: SpawnOptions): ChildHandle;
}

/**
 * Spawns in a new process group, so a terminal Ctrl-C never reaches `docker`
 * directly and a kill also reaches its children. The environment is the
 * minimal inherited set (no `DISPLAY`, `WAYLAND_DISPLAY`, or session bus).
 */
export function createSpawner(baseEnv: NodeJS.ProcessEnv = process.env): Spawner {
  return {
    spawn(argv, options = {}) {
      if (argv.length === 0) throw new Error("empty argv");
      const child = spawn(argv[0], argv.slice(1), {
        env: minimalEnv(baseEnv, options.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
      });
      let alive = true;
      const exited = new Promise<ExitStatus>((resolve) => {
        child.once("error", (error) => {
          if (child.pid === undefined) {
            alive = false;
            resolve({ code: null, signal: null, error });
          }
        });
        child.once("exit", (code, signal) => {
          alive = false;
          resolve({ code, signal });
        });
      });
      child.stdin.on("error", () => {
        // EPIPE after the child died; the exit status reports it.
      });
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        running: () => alive,
        kill(signal) {
          if (!alive || child.pid === undefined) return;
          try {
            if (process.platform !== "win32") process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            // ESRCH: already gone.
          }
        },
      };
    },
  };
}

export interface RunWithInputOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Called with each complete output line (stdout and stderr), for progress. */
  onLine?: (line: string) => void;
  /** Bytes kept per stream; default 256 KiB (the tail is kept). */
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/**
 * Runs a command with binary `input` on stdin and resolves with a
 * {@link RunResult}. Timeout and abort send SIGTERM to the process group, then
 * SIGKILL after the grace period. Rejects only when the command cannot be spawned.
 */
export function runWithInput(spawner: Spawner, argv: readonly string[], input: Buffer, options: RunWithInputOptions): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted before spawn"), { name: "AbortError" }));
  const max = options.maxOutputBytes ?? 256 * 1024;
  const grace = options.killGraceMs ?? 2_000;
  const started = Date.now();
  const child = spawner.spawn(argv, { env: options.env });
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
  child.stdin.end(input);

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

/** Keeps the last `max` bytes of a stream. */
export class TailBuffer {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  add(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#max && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift()!.length;
      this.truncated = true;
    }
    if (this.#size > this.#max) {
      const only = this.#chunks[0];
      this.#chunks = [only.subarray(only.length - this.#max)];
      this.#size = this.#max;
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}
