/**
 * Ownership record of one client session (spec §7a.2). Written atomically
 * (temp file + rename) to `owner.json` in the session temp dir and updated
 * before each resource is created, so a crash never leaves an unrecorded
 * resource.
 */

export const OWNER_FILE = "owner.json";
export const SESSION_DIR_PREFIX = "pi-gui-testing-";

export interface OwnerResource {
  /** Same open vocabulary as protocol `Leftover.kind`, e.g. `container`, `network`, `volume`, `process`. */
  kind: string;
  id: string;
}

export interface OwnerRecord {
  /** Record format version; unknown versions are reported, never swept. */
  version: 1;
  pid: number;
  /** Process start time in clock ticks since boot (`/proc/<pid>/stat` field 22), as a decimal string. */
  processStartTime: string;
  /** `/proc/sys/kernel/random/boot_id`. */
  bootId: string;
  /** Stable random id of this Pi process's extension instance. */
  clientId: string;
  piSessionId: string;
  backend: string;
  /** ISO 8601. */
  createdAt: string;
  resources: OwnerResource[];
}

/** Parsed `pi-gui-testing.owner` label: `<clientId>:<pid>:<processStartTime>:<bootId>`. */
export interface OwnerLabel {
  clientId: string;
  pid: number;
  processStartTime: string;
  bootId: string;
}

/** Formats the owner label value. */
export function formatOwnerLabel(owner: OwnerLabel): string {
  return `${owner.clientId}:${owner.pid}:${owner.processStartTime}:${owner.bootId}`;
}

/**
 * Parses an owner label value.
 *
 * @returns The parsed label, or `undefined` when the value does not have all
 *   four fields. Callers must report such objects and never sweep them.
 */
export function parseOwnerLabel(value: string): OwnerLabel | undefined {
  const parts = value.split(":");
  if (parts.length !== 4) return undefined;
  const [clientId, pidText, processStartTime, bootId] = parts;
  const pid = Number(pidText);
  if (!clientId || !Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(processStartTime) || !bootId) {
    return undefined;
  }
  return { clientId, pid, processStartTime, bootId };
}

/** Liveness of an owner, as decided by the sweep. `unknown` is never swept. */
export type OwnerLiveness = "alive" | "dead" | "unknown";
