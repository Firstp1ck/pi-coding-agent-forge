/**
 * Last-resort cleanup on process `exit` (spec §7a.2). Node allows only
 * synchronous work there, so each command runs with `spawnSync` and a hard
 * bound. The primary path is the async `session_shutdown` handler; this only
 * catches what it could not finish. No SIGINT handler: Pi owns Ctrl-C.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { minimalEnv } from "../runner/spawn.ts";

/** Upper bound per command (spec: at most 5 s per container). */
export const EXIT_COMMAND_TIMEOUT_MS = 5_000;

export interface ExitCleanupSource {
  /** Argv lists to run, e.g. `["docker", "--context", "default", "rm", "-f", id]`. Read at exit time. */
  commands(): string[][];
  /** Directories to remove, read at exit time. */
  dirs?(): string[];
}

/**
 * Runs the cleanup synchronously: each command with `spawnSync` (no shell,
 * SIGKILL after `timeoutMs`), then removes each dir. Never throws.
 */
export function runExitCleanupSync(source: ExitCleanupSource, timeoutMs: number = EXIT_COMMAND_TIMEOUT_MS): void {
  let commands: string[][] = [];
  let dirs: string[] = [];
  try {
    commands = source.commands();
    dirs = source.dirs?.() ?? [];
  } catch {
    return;
  }
  const env = minimalEnv(process.env);
  for (const argv of commands) {
    if (argv.length === 0) continue;
    try {
      spawnSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL", env, shell: false, windowsHide: true });
    } catch {
      // Best effort: the startup sweep handles whatever remains.
    }
  }
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort, as above.
    }
  }
}

/**
 * Registers {@link runExitCleanupSync} on process `exit`.
 *
 * @returns A function that unregisters the handler (call it from `session_shutdown` after a clean teardown).
 */
export function installExitCleanup(source: ExitCleanupSource, timeoutMs?: number): () => void {
  const handler = () => runExitCleanupSync(source, timeoutMs);
  process.on("exit", handler);
  return () => {
    process.off("exit", handler);
  };
}
