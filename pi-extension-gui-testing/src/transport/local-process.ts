/**
 * Starts a helper (or any long-lived child with open pipes) directly on the
 * client, for backends without a container or SSH hop (`local-linux`).
 *
 * The child gets exactly the environment the caller passes: nothing is
 * inherited from Pi's process, so the host's `DISPLAY`, `WAYLAND_DISPLAY`,
 * `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, … never reach it unless the
 * backend sets them on purpose (R5). Pass `PATH` yourself or an absolute
 * `argv[0]`. The child runs in its own process group, so a terminal Ctrl-C
 * never reaches it and `kill()` also stops its children.
 */
import { spawn } from "node:child_process";
import { wrapChildProcess, type HelperProcess } from "./process.ts";

export interface LocalProcessOptions {
  /** The complete environment of the child; nothing is inherited. */
  env: Readonly<Record<string, string>>;
  /** Working directory; default `/`, so nothing in the project is picked up by accident. */
  cwd?: string;
}

export interface LocalSpawner {
  spawn(argv: readonly string[], options: LocalProcessOptions): HelperProcess;
}

/** Environment variables that would connect a child to the user's desktop session. */
export const DESKTOP_ENV = ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY"] as const;

/**
 * Spawns `argv` with an explicit environment in a new process group.
 *
 * @throws Error for an empty argv or an environment value that is not a string.
 */
export function spawnLocalProcess(argv: readonly string[], options: LocalProcessOptions): HelperProcess {
  if (argv.length === 0) throw new Error("empty argv");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (typeof value !== "string") throw new Error(`environment value of ${key} is not a string`);
    env[key] = value;
  }
  const child = spawn(argv[0], argv.slice(1), {
    env,
    cwd: options.cwd ?? "/",
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
  });
  return wrapChildProcess(child);
}

/** The real {@link LocalSpawner}; tests substitute a fake with the same shape. */
export function createLocalSpawner(): LocalSpawner {
  return { spawn: spawnLocalProcess };
}
