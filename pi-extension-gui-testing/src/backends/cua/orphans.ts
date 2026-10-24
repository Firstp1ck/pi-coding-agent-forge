/**
 * Orphan audit and sweep for `cua` (spec §7a.2, §7a.4). Only sandboxes this
 * machine's ledger records are ever deleted, and only when their owner process
 * is gone: a cloud account is shared by all of its owner's machines, so a
 * sandbox without a record here may belong to a live Pi elsewhere. Kept
 * sandboxes (`keepSandbox`) are not orphans; a dead owner's sandbox that asked
 * to be kept is moved to the kept set instead of deleted.
 */
import { DEFAULT_PROC_ROOT } from "../../cleanup/identity.ts";
import type { Leftover } from "../../protocol.ts";
import type { CuaApi } from "./api.ts";
import { hostPrefix, recordOwnerLiveness, type LedgerEntry, type SandboxLedger } from "./ledger.ts";
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

const UNRECORDED =
  "carries this machine's name prefix but has no record in the local ledger (record lost or another Pi config dir); not removed automatically. Delete it with `cua sandbox rm <ref> --force` if it is yours";

function problemLeftover(entry: LedgerEntry): Leftover {
  return { kind: "ledger", id: entry.file, detail: `unreadable sandbox record (${entry.problem}); not acted on` };
}

/** Sandboxes with this machine's prefix that no ledger record names (read-only). */
async function unrecorded(options: OrphanOptions, entries: readonly LedgerEntry[]): Promise<Leftover[]> {
  const known = new Set(entries.map((e) => e.record?.name).filter(Boolean));
  const prefix = hostPrefix(options.hostTag);
  try {
    return (await options.api.listSandboxes(options.signal))
      .filter((s) => s.name.startsWith(prefix) && !known.has(s.name))
      .map((s) => ({ kind: "sandbox", id: `${s.location}:${s.name}`, detail: UNRECORDED }));
  } catch (error) {
    return [{ kind: "sandbox", id: prefix, detail: `listing sandboxes failed: ${redact((error as Error).message)}` }];
  }
}

/** Read-only: dead owners' sandboxes, owners that cannot be judged, unreadable records, unrecorded sandboxes of this machine. */
export async function auditCuaOrphans(options: OrphanOptions): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const entries = await options.ledger.entries();
  const leftovers: Leftover[] = [];
  for (const entry of entries) {
    if (!entry.record) {
      leftovers.push(problemLeftover(entry));
      continue;
    }
    if (entry.kept) continue;
    const liveness = recordOwnerLiveness(entry.record, procRoot);
    if (liveness === "dead") leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: entry.record.keep ? "owner gone; will be kept (keepSandbox)" : "owner gone" });
    else if (liveness === "unknown") leftovers.push({ kind: "sandbox", id: entry.record.ref, detail: "owner unknown; not removed automatically" });
  }
  leftovers.push(...(await unrecorded(options, entries)));
  return leftovers;
}

export interface SweepResult {
  deleted: string[];
  kept: string[];
  leftovers: Leftover[];
}

/**
 * Deletes dead owners' sandboxes (or moves them to the kept set), forgets
 * kept records whose sandbox is gone (expired), and reports everything it may
 * not touch. Never throws for a single sandbox.
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
    if (entry.kept) {
      // A kept sandbox that expired or was deleted elsewhere: forget it.
      try {
        if (!(await api.getSandbox(record.ref, signal))) {
          await ledger.remove(record.name, true);
          options.onDeleted?.(record.ref);
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
    if (record.keep && record.phase === "created") {
      await ledger.markKept(record.name);
      result.kept.push(record.ref);
      continue;
    }
    try {
      await ledger.update(record.name, { phase: "deleting" });
      await api.deleteSandbox(record.ref, signal);
      options.onDeleted?.(record.ref);
      await ledger.remove(record.name);
      result.deleted.push(record.ref);
    } catch (error) {
      result.leftovers.push({ kind: "sandbox", id: record.ref, detail: `delete failed (it may keep billing): ${redact((error as Error).message)}` });
    }
  }
  if (!signal.aborted) result.leftovers.push(...(await unrecorded(options, await ledger.entries())));
  return result;
}

/**
 * `/gui-reset cua`: deletes every kept sandbox of this machine (each record
 * claimed first), after the orphan sweep. A failed deletion stays recorded
 * as `deleting`, so the next sweep retries it. Live sessions are stopped by the runtime before this runs.
 */
export async function deleteKeptSandboxes(options: Omit<OrphanOptions, "procRoot">): Promise<SweepResult> {
  const { api, ledger, signal } = options;
  const result: SweepResult = { deleted: [], kept: [], leftovers: [] };
  for (const entry of await ledger.entries()) {
    if (signal.aborted) break;
    const record = entry.record;
    if (!entry.kept || !record) continue;
    // Claim it first, so a session starting meanwhile cannot reuse a sandbox being deleted.
    if (!(await ledger.claimForDeletion(record.name))) continue;
    try {
      await api.deleteSandbox(record.ref, signal);
      options.onDeleted?.(record.ref);
      await ledger.remove(record.name);
      result.deleted.push(record.ref);
    } catch (error) {
      result.leftovers.push({ kind: "sandbox", id: record.ref, detail: `delete failed (it keeps billing until it expires): ${redact((error as Error).message)}` });
    }
  }
  return result;
}

/** Cheap startup gate input: does any active record name a dead owner? Reads files and `/proc` only. */
export async function hasDeadOwnerRecords(ledger: SandboxLedger, procRoot: string = DEFAULT_PROC_ROOT): Promise<boolean> {
  for (const entry of await ledger.entries()) {
    if (entry.record && !entry.kept && recordOwnerLiveness(entry.record, procRoot) === "dead") return true;
  }
  return false;
}
