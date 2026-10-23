/**
 * Process identity and owner liveness (spec §7a.2). An owner is identified by
 * boot id + PID + process start time, so a reused PID or a reboot is never
 * mistaken for the original owner.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnerLabel, OwnerLiveness } from "../owner.ts";

/** Root of the proc filesystem; tests point it at a fake tree. */
export const DEFAULT_PROC_ROOT = "/proc";

/**
 * Reads field 22 (`starttime`) of `<procRoot>/<pid>/stat`.
 *
 * @returns The start time as a decimal string; `null` when the PID does not
 *   exist; `undefined` when the file exists but cannot be read or parsed.
 */
export function readProcessStartTime(pid: number, procRoot: string = DEFAULT_PROC_ROOT): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? null : undefined;
  }
  // Field 2 (comm) is parenthesised and may contain spaces or ')', so split after the last ')'.
  const close = text.lastIndexOf(")");
  if (close === -1) return undefined;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // `rest[0]` is field 3 (state), so field 22 is rest[19].
  const value = rest[19];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}

/** Reads `<procRoot>/sys/kernel/random/boot_id`; `undefined` when unreadable. */
export function readBootId(procRoot: string = DEFAULT_PROC_ROOT): string | undefined {
  try {
    const value = readFileSync(join(procRoot, "sys", "kernel", "random", "boot_id"), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns a new random client id (one per extension instance). */
export function createClientId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Identity of this extension instance. Create it once per instance and reuse
 * it, so `clientId` stays stable for the instance's lifetime.
 *
 * @throws Error when this process's start time or the boot id cannot be read
 *   (non-Linux hosts are out of M1 scope).
 */
export function createOwnerIdentity(procRoot: string = DEFAULT_PROC_ROOT, pid: number = process.pid): OwnerLabel {
  const processStartTime = readProcessStartTime(pid, procRoot);
  const bootId = readBootId(procRoot);
  if (!processStartTime || !bootId) {
    throw new Error(`cannot read process identity from ${procRoot} (start time ${processStartTime}, boot id ${bootId})`);
  }
  return { clientId: createClientId(), pid, processStartTime, bootId };
}

/**
 * Decides whether an owner is still running.
 *
 * - `dead`: the boot id differs, the PID is gone, or the PID now has a different start time.
 * - `alive`: same boot, same PID, same start time.
 * - `unknown`: anything could not be read; such owners are never swept.
 */
export function ownerLiveness(
  owner: Pick<OwnerLabel, "pid" | "processStartTime" | "bootId">,
  procRoot: string = DEFAULT_PROC_ROOT,
): OwnerLiveness {
  const bootId = readBootId(procRoot);
  if (!bootId) return "unknown";
  if (bootId !== owner.bootId) return "dead";
  const startTime = readProcessStartTime(owner.pid, procRoot);
  if (startTime === null) return "dead";
  if (startTime === undefined) return "unknown";
  return startTime === owner.processStartTime ? "alive" : "dead";
}
