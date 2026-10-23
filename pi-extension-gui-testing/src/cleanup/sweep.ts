/**
 * Startup sweep and client-scope footprint audit (spec §7a.2, §7a.4). Only
 * dead owners are swept; owners whose liveness is unknown (unreadable proc
 * data, missing or malformed `owner.json`) are reported and left alone.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../backend.ts";
import type { Leftover } from "../protocol.ts";
import { SESSION_DIR_PREFIX, type OwnerLiveness, type OwnerRecord, type OwnerResource } from "../owner.ts";
import { DEFAULT_PROC_ROOT, ownerLiveness, readProcessStartTime } from "./identity.ts";
import { PROCESS_KIND, parseProcessResourceId, readOwnerRecord } from "./session-dir.ts";

/** One `pi-gui-testing-*` dir and what is known about its owner. */
export interface SessionDirInfo {
  path: string;
  liveness: OwnerLiveness;
  record?: OwnerRecord;
  /** Why liveness is `unknown`. */
  reason?: string;
}

export interface ScanOptions {
  /** Default `os.tmpdir()`. */
  tmpRoot?: string;
  procRoot?: string;
}

/**
 * Lists this user's session dirs under `tmpRoot` with their owner liveness.
 * Symlinks and other users' dirs are skipped: they are not ours to judge.
 */
export async function scanSessionDirs(options: ScanOptions = {}): Promise<SessionDirInfo[]> {
  const root = options.tmpRoot ?? tmpdir();
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const uid = process.getuid?.();
  const infos: SessionDirInfo[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(SESSION_DIR_PREFIX) || !entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      if (uid !== undefined && (await stat(path)).uid !== uid) continue;
    } catch {
      continue;
    }
    const read = await readOwnerRecord(path);
    if (!read.ok) {
      infos.push({ path, liveness: "unknown", reason: read.reason });
      continue;
    }
    const liveness = ownerLiveness(read.record, procRoot);
    const info: SessionDirInfo = { path, liveness, record: read.record };
    if (liveness === "unknown") info.reason = "owner process state could not be read";
    infos.push(info);
  }
  return infos;
}

/** `true` when the recorded process still runs with the recorded start time. */
function processStillRuns(resource: OwnerResource, procRoot: string): boolean {
  const parsed = parseProcessResourceId(resource.id);
  return parsed !== undefined && readProcessStartTime(parsed.pid, procRoot) === parsed.startTime;
}

function unknownLeftover(info: SessionDirInfo): Leftover {
  return { kind: "tempdir", id: info.path, detail: `owner unknown (${info.reason}); not removed automatically` };
}

/** Leftovers of one session after it stopped: its dir, if it still exists, and recorded processes still running. */
export async function auditSession(
  session: { path: string; resources: readonly OwnerResource[] },
  procRoot: string = DEFAULT_PROC_ROOT,
): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  try {
    await stat(session.path);
    leftovers.push({ kind: "tempdir", id: session.path });
  } catch {
    // Gone, as it should be.
  }
  for (const resource of session.resources) {
    if (resource.kind === PROCESS_KIND && processStillRuns(resource, procRoot)) {
      leftovers.push({ kind: PROCESS_KIND, id: resource.id, detail: `still running (session ${session.path})` });
    }
  }
  return leftovers;
}

/**
 * Orphan-scoped client audit: dirs of dead owners and the recorded processes
 * that still run, plus dirs whose owner is unknown. Live owners are exempt.
 */
export async function auditClientOrphans(options: ScanOptions = {}): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const leftovers: Leftover[] = [];
  for (const info of await scanSessionDirs(options)) {
    if (info.liveness === "unknown") leftovers.push(unknownLeftover(info));
    if (info.liveness !== "dead") continue;
    leftovers.push({ kind: "tempdir", id: info.path, detail: "owner gone" });
    for (const resource of info.record!.resources) {
      if (resource.kind === PROCESS_KIND && processStillRuns(resource, procRoot)) {
        leftovers.push({ kind: PROCESS_KIND, id: resource.id, detail: `orphan of ${info.path}` });
      }
    }
  }
  return leftovers;
}

export interface SweepOptions extends ScanOptions {
  /** Backend sweepers for non-process resources (containers etc.), found by label. */
  sweepers?: ReadonlyArray<Pick<Backend, "id" | "sweepOrphans">>;
  signal: AbortSignal;
  /** Injected for tests; default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface SweepReport {
  removedDirs: string[];
  /** Process resource ids that were killed. */
  killed: string[];
  /** Owners that could not be judged; reported, untouched. */
  unknown: Leftover[];
  /** What could not be removed. */
  leftovers: Leftover[];
}

/**
 * Startup sweep for the client scope. For each dead owner: kills recorded
 * processes (after re-checking PID + start time), then removes its dir. A dir
 * whose processes could not all be stopped is kept so a later sweep retries.
 * Then runs every backend sweeper. Idempotent.
 */
export async function sweepClientOrphans(options: SweepOptions): Promise<SweepReport> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const report: SweepReport = { removedDirs: [], killed: [], unknown: [], leftovers: [] };

  for (const info of await scanSessionDirs(options)) {
    if (options.signal.aborted) break;
    if (info.liveness === "unknown") {
      report.unknown.push(unknownLeftover(info));
      continue;
    }
    if (info.liveness !== "dead") continue;
    let clean = true;
    for (const resource of info.record!.resources) {
      if (resource.kind !== PROCESS_KIND) continue;
      const parsed = parseProcessResourceId(resource.id);
      if (!parsed) {
        report.leftovers.push({ kind: PROCESS_KIND, id: resource.id, detail: "malformed process id in owner.json; not killed" });
        continue;
      }
      if (readProcessStartTime(parsed.pid, procRoot) !== parsed.startTime) continue;
      try {
        kill(parsed.pid, "SIGKILL");
        report.killed.push(resource.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
        clean = false;
        report.leftovers.push({ kind: PROCESS_KIND, id: resource.id, detail: `kill failed: ${(error as Error).message}` });
      }
    }
    if (!clean) {
      report.leftovers.push({ kind: "tempdir", id: info.path, detail: "kept because a recorded process could not be stopped" });
      continue;
    }
    try {
      await rm(info.path, { recursive: true, force: true });
      report.removedDirs.push(info.path);
    } catch (error) {
      report.leftovers.push({ kind: "tempdir", id: info.path, detail: `remove failed: ${(error as Error).message}` });
    }
  }

  for (const sweeper of options.sweepers ?? []) {
    if (options.signal.aborted) break;
    try {
      report.leftovers.push(...(await sweeper.sweepOrphans(options.signal)));
    } catch (error) {
      report.leftovers.push({ kind: "sweeper", id: sweeper.id, detail: `sweep failed: ${(error as Error).message}` });
    }
  }
  return report;
}
