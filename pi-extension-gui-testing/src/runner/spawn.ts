/**
 * Real {@link CommandRunner} on `child_process.spawn`. Argv only, never a shell,
 * so arguments cannot be reinterpreted.
 */
import { spawn } from "node:child_process";
import type { CommandRunner, RunOptions, RunResult } from "./types.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Time between SIGTERM and SIGKILL when a command times out or is aborted. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Variables inherited from the client environment. `DISPLAY`,
 * `WAYLAND_DISPLAY`, and `DBUS_SESSION_BUS_ADDRESS` are deliberately absent so
 * no command can reach the user's desktop (R5). Docker variables stay, because
 * `docker.endpoint` must see a remote `DOCKER_HOST` to refuse it.
 */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // Windows (Docker Desktop hosts, M1c): the docker CLI finds its config, contexts, and
  // plugins through these, and Windows programs need SystemRoot. None reaches a desktop session.
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "SystemRoot",
  "SystemDrive",
  "TEMP",
  "TMP",
  "PATHEXT",
] as const;

export interface SpawnRunnerOptions {
  killGraceMs?: number;
  /** Source of inherited variables; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Builds the child environment: the {@link INHERITED_ENV} subset of `base`, overlaid with `extra`. */
export function minimalEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Creates a runner that spawns each command in its own process group (POSIX),
 * so a timeout or abort also stops grandchildren: SIGTERM to the group, then
 * SIGKILL after the grace period.
 */
export function createSpawnRunner(options: SpawnRunnerOptions = {}): CommandRunner {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const baseEnv = options.baseEnv ?? process.env;
  return {
    run: (argv, runOptions) => runCommand(argv, runOptions, killGraceMs, baseEnv),
  };
}

function runCommand(
  argv: readonly string[],
  options: RunOptions,
  killGraceMs: number,
  baseEnv: NodeJS.ProcessEnv,
): Promise<RunResult> {
  if (argv.length === 0) return Promise.reject(new Error("empty argv"));
  if (options.signal?.aborted) {
    return Promise.reject(Object.assign(new Error("aborted before spawn"), { name: "AbortError" }));
  }
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const groupKill = process.platform !== "win32";
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: minimalEnv(baseEnv, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: groupKill,
      shell: false,
      windowsHide: true,
    });

    const out = new BoundedCollector(maxBytes);
    const err = new BoundedCollector(maxBytes);
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;

    const sendSignal = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (groupKill) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // ESRCH: the group is already gone.
      }
    };
    const terminate = () => {
      sendSignal("SIGTERM");
      killTimer ??= setTimeout(() => sendSignal("SIGKILL"), killGraceMs);
    };
    const onAbort = () => terminate();
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut ? null : exitCode,
        signal: signal ?? null,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => out.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.add(chunk));
    child.stdin.on("error", () => {
      // EPIPE when the child exits before reading its input; the exit status tells the story.
    });
    child.once("error", (error) => {
      if (settled) return;
      if (child.pid === undefined) {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      // A grandchild may keep the pipes open after the child exits; bound the wait for `close`.
      exitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, killGraceMs);
    });
    child.once("close", (code, signal) => finish(code, signal));

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Keeps at most `max` bytes of a stream and remembers whether more arrived. */
class BoundedCollector {
  readonly #max: number;
  #parts: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  add(chunk: Buffer): void {
    const room = this.#max - this.#size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.#parts.push(part);
    this.#size += part.length;
  }

  text(): string {
    return Buffer.concat(this.#parts).toString("utf8");
  }
}
