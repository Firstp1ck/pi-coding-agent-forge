/**
 * Orphan audit and sweep for `cua` (spec §7a.2, §7a.4). Only sandboxes this
 * machine's ledger records are ever deleted, and only when their owner process
 * is gone: a cloud account is shared by all of its owner's machines, so a
 * sandbox without a record here may belong to a live Pi elsewhere. Kept
 * sandboxes (`keepSandbox`) are not orphans; a dead owner's sandbox that asked
 * to be kept is moved to the kept set instead of deleted. A record pending
 * deletion (`phase: "deleting"`, in either set) is never reused: the sweep
 * deletes it unless its owner still runs (then it is reported), and
 * `/gui-reset cua` deletes it.
 */
import { DEFAULT_PROC_ROOT } from "../../cleanup/identity.ts";
import type { Leftover } from "../../protocol.ts";
import type { CuaApi } from "./api.ts";
import { expectedState, hostPrefix, pendingDeletion, recordOwnerLiveness, type LedgerEntry, type LedgerRecord, type SandboxLedger } from "./ledger.ts";
import { redact } from "./redact.ts";

export interface OrphanOptions {
  api: CuaApi;
  ledger: SandboxLedger;
  /** This machine's host tag (sandbox name prefix). */
  hostTag: string;
  signal: AbortSignal;
  procRoot?: string;
  /** Called with the ref of every sandbox confirmed deleted or gone (the cost ledger stops billing it). */
  onDeleted?: (ref: string) => void;
}

/** Detail of a kept record written before images were recorded: it is never reused. */
export const NO_IMAGE_KEPT =
  "kept sandbox from an older version (its image is not recorded), so it is never reused; it keeps billing until it expires or you delete it with /gui-reset cua";

const UNRECORDED =
  "carries this machine's name prefix but has no record in the local ledger (record lost or another Pi config dir); not removed automatically. Delete it with `cua sandbox rm <ref> --force` if it is yours";

/**
 * A copy of an unknown record (one of its copies cannot be read or
 * validated): the sandbox may belong to a running session, so nothing acts
 * on it; the user resolves it by hand.
 */
function problemLeftover(entry: LedgerEntry): Leftover {
  return {
    kind: "ledger",
    id: entry.file,
    detail: `unreadable sandbox record (${entry.problem}); its sandbox ${entry.name} is never reused, kept, or deleted automatically. If no Pi session uses it, delete the sandbox with \`cua sandbox rm <location>:${entry.name} --force\` (\`cua sandbox ls\` shows its location), then remove this file and the sandbox's other record file, if any`,
  };
}

/** Detail of a superseded copy of a record that a ledger change committed but could not remove. */
export const STALE_COPY =
  "stale copy of a sandbox record (superseded by its newer copy, so it is ignored); a ledger change could not remove it, or was interrupted first. The sandbox's next ledger change removes it; it does not bill";

/** Detail of a record pending deletion whose owner process still runs (it may be deleting it right now). */
const PENDING_LIVE_OWNER = "pending deletion; its owner process still runs, so the sweep leaves it to that process (/gui-reset cua deletes it now)";
const PENDING = "pending deletion; the next sweep (/gui-cleanup cua) or /gui-reset cua deletes it";

/**
 * Deletes the sandbox of a record pending deletion and removes the record
 * (only while it is unchanged since `record` was read). Never throws.
 */
async function finishDeletion(options: Omit<OrphanOptions, "procRoot">, record: LedgerRecord, kept: boolean, result: SweepResult, failed: string): Promise<void> {
  try {
    await options.api.deleteSandbox(record.ref, options.signal);
  } catch (error) {
    result.leftovers.push({ kind: "sandbox", id: record.ref, detail: `${failed}: ${redact((error as Error).message)}` });
    return;
  }
  options.onDeleted?.(record.ref);
  try {
    if (await options.ledger.remove(record.name, kept, expectedState(record))) result.deleted.push(record.ref);
    else result.leftovers.push({ kind: "ledger", id: record.ref, detail: "sandbox deleted, but its ledger record changed meanwhile; not removed" });
  } catch (error) {
    result.leftovers.push({ kind: "ledger", id: record.ref, detail: `sandbox deleted, but removing its ledger record failed: ${redact((error as Error).message)}` });
  }
}

/** Sandboxes with this machine's prefix that no ledger record names (read-only). */
async function unrecorded(options: OrphanOptions, entries: readonly LedgerEntry[]): Promise<Leftover[]> {
  // Also the names of unknown records: their sandbox is recorded, only its record cannot be read.
  const known = new Set(entries.map((e) => e.name));
  const prefix = hostPrefix(options.hostTag);
  try {
    return (await options.api.listSandboxes(options.signal))
      .filter((s) => s.name.startsWith(prefix) && !known.has(s.name))
      .map((s) => ({ kind: "sandbox", id: `${s.location}:${s.name}`, detail: UNRECORDED }));
  } catch (error) {
    return [{ kind: "sandbox", id: prefix, detail: `listing sandboxes failed: ${redact((error as Error).message)}` }];
  }
}

/** Read-only: sandboxes pending deletion, dead owners' sandboxes, owners that cannot be judged, unreadable records, stale record copies, unrecorded sandboxes of this machine. */
export async function auditCuaOrphans(options: OrphanOptions): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const entries = await options.ledger.entries();
  const leftovers: Leftover[] = [];
  for (const entry of entries) {
    if (!entry.record) {
      leftovers.push(problemLeftover(entry));
      continue;
    }
    if (pendingDeletion(entry)) {
      leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: recordOwnerLiveness(entry.record, procRoot) === "alive" ? PENDING_LIVE_OWNER : PENDING });
      continue;
    }
    if (entry.kept) {
      if (entry.record.image === undefined) leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: NO_IMAGE_KEPT });
      continue;
    }
    const liveness = recordOwnerLiveness(entry.record, procRoot);
    if (liveness === "dead") leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: entry.record.keep ? "owner gone; will be kept (keepSandbox)" : "owner gone" });
    else if (liveness === "unknown") leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: "owner unknown; not removed automatically" });
  }
  for (const file of await options.ledger.staleCopies()) leftovers.push({ kind: "ledger", id: file, detail: STALE_COPY });
  leftovers.push(...(await unrecorded(options, entries)));
  return leftovers;
}

export interface SweepResult {
  deleted: string[];
  kept: string[];
  leftovers: Leftover[];
}

/**
 * Deletes dead owners' sandboxes (or moves them to the kept set) and
 * sandboxes pending deletion whose owner is not running, forgets kept records
 * whose sandbox is gone (expired), and reports everything it may not touch.
 * Every transition acts only on the record state it read. Never throws for a
 * single sandbox.
 */
export async function sweepCuaOrphans(options: OrphanOptions): Promise<SweepResult> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const { api, ledger, signal } = options;
  const entries = await ledger.entries();
  const result: SweepResult = { deleted: [], kept: [], leftovers: [] };
  for (const entry of entries) {
    if (signal.aborted) break;
    const record = entry.record;
    if (!record) {
      result.leftovers.push(problemLeftover(entry));
      continue;
    }
    if (pendingDeletion(entry)) {
      // Never reused, so deleting it is safe whoever recorded it; a running owner may be deleting it right now.
      if (recordOwnerLiveness(record, procRoot) === "alive") result.leftovers.push({ kind: "sandbox", id: record.ref, detail: PENDING_LIVE_OWNER });
      else await finishDeletion(options, record, entry.kept, result, "delete failed (it may keep billing)");
      continue;
    }
    if (entry.kept) {
      // A kept sandbox that expired or was deleted elsewhere: forget it.
      try {
        if (!(await api.getSandbox(record.ref, signal))) {
          options.onDeleted?.(record.ref);
          // Only the record that was read: a session may have claimed and kept it again meanwhile.
          await ledger.remove(record.name, true, expectedState(record));
        } else if (record.image === undefined) {
          result.leftovers.push({ kind: "sandbox", id: record.ref, detail: NO_IMAGE_KEPT });
        }
      } catch {
        // Unreachable now; checked again by the next sweep.
      }
      continue;
    }
    const liveness = recordOwnerLiveness(record, procRoot);
    if (liveness === "alive") continue;
    if (liveness === "unknown") {
      result.leftovers.push({ kind: "sandbox", id: record.ref, detail: "owner unknown; not removed automatically" });
      continue;
    }
    // Every transition below acts only while the record is exactly what this sweep read (owner, phase,
    // generation): another sweep, a reset, or a new session may have kept, claimed, or condemned it since.
    try {
      if (record.keep && record.phase === "created") {
        if (await ledger.markKept(record.name, expectedState(record))) result.kept.push(record.ref);
        continue;
      }
      const condemned = await ledger.update(record.name, { phase: "deleting" }, expectedState(record));
      if (!condemned) continue;
      await finishDeletion(options, condemned, false, result, "delete failed (it may keep billing)");
    } catch (error) {
      result.leftovers.push({ kind: "sandbox", id: record.ref, detail: `ledger transition failed; the next sweep retries: ${redact((error as Error).message)}` });
    }
  }
  if (!signal.aborted) result.leftovers.push(...(await unrecorded(options, await ledger.entries())));
  return result;
}

/**
 * `/gui-reset cua`: deletes every kept sandbox of this machine (each record
 * claimed first, as `deleting`) and every sandbox already pending deletion,
 * after the orphan sweep. A failed deletion stays recorded as `deleting`, so
 * the next sweep or reset retries it. An unknown record (unreadable copy) is
 * left alone and reported with its manual remedy. Live sessions are stopped
 * by the runtime before this runs.
 */
export async function deleteKeptSandboxes(options: Omit<OrphanOptions, "procRoot">): Promise<SweepResult> {
  const { ledger, signal } = options;
  const result: SweepResult = { deleted: [], kept: [], leftovers: [] };
  const failed = "delete failed (it keeps billing until it expires)";
  for (const entry of await ledger.entries()) {
    if (signal.aborted) break;
    const record = entry.record;
    if (!record) {
      result.leftovers.push(problemLeftover(entry));
      continue;
    }
    if (pendingDeletion(entry)) {
      await finishDeletion(options, record, entry.kept, result, failed);
      continue;
    }
    if (!entry.kept) continue;
    // Claim it first, so a session starting meanwhile cannot reuse a sandbox being deleted.
    const claimed = await ledger.claimForDeletion(record.name);
    if (claimed) await finishDeletion(options, claimed, false, result, failed);
  }
  return result;
}

/**
 * Cheap startup gate input: does any active record name a dead owner, or any
 * record pending deletion (in either set) an owner that is not running?
 * Reads files and `/proc` only.
 */
export async function hasDeadOwnerRecords(ledger: SandboxLedger, procRoot: string = DEFAULT_PROC_ROOT): Promise<boolean> {
  for (const entry of await ledger.entries()) {
    if (!entry.record) continue;
    const liveness = recordOwnerLiveness(entry.record, procRoot);
    if (pendingDeletion(entry) ? liveness !== "alive" : !entry.kept && liveness === "dead") return true;
  }
  return false;
}
