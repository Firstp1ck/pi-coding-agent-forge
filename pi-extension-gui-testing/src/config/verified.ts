/**
 * Verified-backend state (spec §5.1, §7): tools refuse unverified backends and
 * ask for `/gui-doctor` when a checked tool version drifted.
 */
import { updateGlobalConfig } from "./load.ts";
import { IMPLEMENTED_BACKENDS, type BackendId, type GlobalConfig, type VerifiedBackend } from "./types.ts";

/** One drifted tool version. */
export interface VersionChange {
  key: string;
  recorded: string | undefined;
  current: string;
}

/**
 * Compares recorded tool versions with current ones. A key the caller reports
 * now that differs from (or is missing in) the record makes the state stale;
 * keys the caller cannot observe now are not evidence of drift and are skipped.
 */
export function staleVersions(record: VerifiedBackend, current: Record<string, string>): VersionChange[] {
  const changes: VersionChange[] = [];
  for (const [key, value] of Object.entries(current)) {
    const recorded = record.toolVersions[key];
    if (recorded !== value) changes.push({ key, recorded, current: value });
  }
  return changes;
}

export type VerificationState =
  | { state: "verified"; record: VerifiedBackend }
  | { state: "unverified"; message: string }
  | { state: "stale"; record: VerifiedBackend; changes: VersionChange[]; message: string };

/** Error text for a tool call on a backend that is not set up (spec §5.1). */
export function notSetUpMessage(backend: BackendId): string {
  return `backend "${backend}" is not set up; ask the user to run /gui-setup ${backend}`;
}

/** Error text for a backend id that exists in the contract but not in this build (or not in `available`). */
export function notAvailableMessage(backend: string, available: readonly BackendId[] = IMPLEMENTED_BACKENDS): string {
  return `backend "${backend}" is not available yet; available: ${available.join(", ")}`;
}

/**
 * Decides whether tools may use `backend`. Pass `currentVersions` when the
 * caller has fresh observations (e.g. the image label); without them only the
 * presence of a record is checked.
 */
export function verificationState(
  global: GlobalConfig,
  backend: BackendId,
  currentVersions?: Record<string, string>,
): VerificationState {
  const record = global.verified[backend];
  if (!record) return { state: "unverified", message: notSetUpMessage(backend) };
  if (currentVersions) {
    const changes = staleVersions(record, currentVersions);
    if (changes.length > 0) {
      const detail = changes.map((c) => `${c.key} ${c.recorded ?? "(unrecorded)"} → ${c.current}`).join(", ");
      return {
        state: "stale",
        record,
        changes,
        message: `backend "${backend}" changed since setup (${detail}); ask the user to run /gui-doctor ${backend}`,
      };
    }
  }
  return { state: "verified", record };
}

/** Persists a verified record for `backend` in the global config (atomic). */
export async function markVerified(backend: BackendId, record: VerifiedBackend, globalPath?: string): Promise<void> {
  await updateGlobalConfig((config) => {
    config.verified[backend] = record;
  }, globalPath);
}

/** Removes the verified record of `backend`, so tools refuse it until setup or doctor passes again. */
export async function markUnverified(backend: BackendId, globalPath?: string): Promise<void> {
  await updateGlobalConfig((config) => {
    delete config.verified[backend];
  }, globalPath);
}
