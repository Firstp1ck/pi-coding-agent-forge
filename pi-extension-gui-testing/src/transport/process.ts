/**
 * Backend-independent handle on a running helper process (or whatever carries
 * its stdio: `docker run -i`, a local spawn, `ssh`). Backends hand one to
 * {@link HelperSession}; unit tests substitute fakes with the same shape.
 */
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface ExitStatus {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be spawned. */
  error?: Error;
}

/** A running child with open pipes. */
export interface HelperProcess {
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

/**
 * Wraps a child spawned with `detached: true` (its own process group on
 * POSIX) and three pipes. `kill` signals the whole group, so grandchildren
 * stop too.
 */
export function wrapChildProcess(child: ChildProcess): HelperProcess {
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
  child.stdin!.on("error", () => {
    // EPIPE after the child died; the exit status reports it.
  });
  return {
    pid: child.pid,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
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
