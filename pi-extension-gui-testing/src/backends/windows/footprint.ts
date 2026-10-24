/**
 * Footprint of a Windows helper session on the machine that runs it (spec
 * §7a.4 `local-windows` row): the session's Job Objects and their processes,
 * its private desktop, and its runtime dir. The helper removes all of it on
 * teardown, and Windows ends every job process when the helper dies. These
 * functions are the client's second line: they read `session.json` from the
 * runtime dir, check each object by PID + creation time or by name, end what
 * is left (teardown and sweep only), and remove the dir.
 *
 * The orphan audit and sweep act only on runtime dirs this package created
 * (name pattern, real directory, owner record) whose owner is dead. Live and
 * unknown owners are never touched; unknown ones are reported.
 */
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { DEFAULT_PROC_ROOT, ownerLiveness, type ProcessProbe } from "../../cleanup/identity.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { inspectWindowsObjects, type InspectResult, type ObjectState } from "./inspect.ts";
import { boundedText, samePath } from "./paths.ts";
import { isPackageRuntimeDir, readRuntimeOwner, removeRuntimeDir, RUNTIME_DIR_NAME, type WinFs } from "./runtime-dir.ts";
import { MAX_SESSION_RECORD_BYTES, parseSessionRecord, processKey, SESSION_RECORD_FILE, type WinSessionRecord } from "./session-record.ts";

export interface WinFootprintOptions {
  fs: WinFs;
  runner: CommandRunner;
  /** Absolute `powershell.exe`. */
  powershell: string;
  /** Allow-listed system variables for PowerShell. */
  env: Record<string, string>;
  /** `%LOCALAPPDATA%\Temp`, where runtime dirs live. */
  root: string;
  /** Owner liveness probe (the platform default in production). */
  probe: ProcessProbe;
  /**
   * Root of the client's generic session-dir scan (`os.tmpdir()`). When it is
   * {@link root}, that scan already reports runtime dirs without a valid owner
   * and dirs of dead owners, so this audit does not repeat those lines.
   */
  genericRoot?: string;
  signal?: AbortSignal;
}

export type RecordRead = { state: "missing" } | { state: "invalid"; problem: string } | { state: "ok"; record: WinSessionRecord };

/** Reads `<runtimeDir>\session.json` (untrusted) with the rules of {@link parseSessionRecord} for a `local` helper. */
export async function readSessionRecord(fs: WinFs, runtimeDir: string): Promise<RecordRead> {
  const path = win32.join(runtimeDir, SESSION_RECORD_FILE);
  let type;
  try {
    type = await fs.lstat(path);
  } catch (error) {
    return { state: "invalid", problem: `cannot read it: ${boundedText((error as Error).message)}` };
  }
  if (type === undefined) return { state: "missing" };
  if (type !== "file") return { state: "invalid", problem: "is not a regular file" };
  let text: string;
  try {
    text = await fs.readFile(path, MAX_SESSION_RECORD_BYTES);
  } catch (error) {
    return { state: "invalid", problem: `cannot read it: ${boundedText((error as Error).message)}` };
  }
  const parsed = parseSessionRecord(text, { runtimeDir, mode: "local", privateDesktop: true });
  return "record" in parsed ? { state: "ok", record: parsed.record } : { state: "invalid", problem: parsed.problem };
}

/** Inspects (or ends, with `kill`) the helper, the recorded processes and jobs, and the private desktop of `record`. */
export function inspectRecord(record: WinSessionRecord, action: "audit" | "kill", options: WinFootprintOptions): Promise<InspectResult> {
  return inspectWindowsObjects(
    { action, tag: record.tag, processes: [record.helper, ...record.processes.filter((p) => processKey(p) !== processKey(record.helper))], jobs: record.jobs, desktops: [record.desktop] },
    { runner: options.runner, powershell: options.powershell, env: options.env, ...(options.signal ? { signal: options.signal } : {}) },
  );
}

function stateDetail(state: ObjectState, what: string, problem: string | undefined): string | undefined {
  if (state === "alive") return `${what} still exists`;
  if (state === "unknown") return `${what} could not be inspected${problem ? ` (${problem})` : ""}`;
  return undefined;
}

/** Leftovers for every object of `record` that still exists or could not be inspected. */
export function leftoversOf(record: WinSessionRecord, result: InspectResult, where: string): Leftover[] {
  const leftovers: Leftover[] = [];
  const helperKey = processKey(record.helper);
  for (const [id, state] of result.processes) {
    const detail = stateDetail(state, id === helperKey ? `GUI helper process (${where})` : `app process (${where})`, result.problem);
    if (detail) leftovers.push({ kind: "process", id, detail });
  }
  for (const [id, state] of result.jobs) {
    const detail = stateDetail(state, `Job Object (${where})`, result.problem);
    if (detail) leftovers.push({ kind: "job", id, detail });
  }
  for (const [id, state] of result.desktops) {
    const detail = stateDetail(state, `private desktop (${where}); a process outside the session's jobs may still use it`, result.problem);
    if (detail) leftovers.push({ kind: "desktop", id, detail });
  }
  return leftovers;
}

/**
 * Teardown or sweep of one runtime dir whose helper is gone (or must go):
 * ends the helper, recorded processes, and jobs that still exist (matching
 * PID + creation time, or the session's job names), then removes the dir. The
 * dir stays while anything is left, so a later attempt can retry with the
 * same record.
 */
export async function cleanupRuntimeDir(runtimeDir: string, options: WinFootprintOptions, where = "session"): Promise<Leftover[]> {
  const type = await options.fs.lstat(runtimeDir).catch(() => "dir" as const);
  if (type === undefined) return [];
  const read = type === "dir" ? await readSessionRecord(options.fs, runtimeDir) : ({ state: "missing" } as const);
  const leftovers: Leftover[] = [];
  if (read.state === "ok") {
    const result = await inspectRecord(read.record, "kill", options);
    leftovers.push(...leftoversOf(read.record, result, where));
  }
  // With no readable record there is nothing the client can identify safely; the jobs died with the helper.
  if (leftovers.some((l) => l.kind !== "tempdir")) {
    leftovers.push({ kind: "tempdir", id: runtimeDir, detail: "kept until the objects above are gone" });
    return leftovers;
  }
  leftovers.push(...(await removeRuntimeDir(options.fs, options.root, runtimeDir)));
  return leftovers;
}

/** Read-only audit of one session's runtime dir and the objects its record names. */
export async function auditRuntimeDir(runtimeDir: string, options: WinFootprintOptions, where = "session"): Promise<Leftover[]> {
  const type = await options.fs.lstat(runtimeDir).catch(() => "dir" as const);
  if (type === undefined) return [];
  const leftovers: Leftover[] = [{ kind: "tempdir", id: runtimeDir, detail: `runtime dir (${where})` }];
  if (type !== "dir") return leftovers;
  const read = await readSessionRecord(options.fs, runtimeDir);
  if (read.state === "invalid") leftovers.push({ kind: "tempdir", id: win32.join(runtimeDir, SESSION_RECORD_FILE), detail: `session record ${read.problem}; its objects were not inspected` });
  if (read.state === "ok") {
    leftovers.push(...leftoversOf(read.record, await inspectRecord(read.record, "audit", options), where));
    if (read.record.omitted > 0) leftovers.push({ kind: "tempdir", id: win32.join(runtimeDir, SESSION_RECORD_FILE), detail: `${read.record.omitted} recorded job(s) or process(es) not inspected (beyond the client's limit, or without a creation time)` });
  }
  return leftovers;
}

interface RuntimeDirEntry {
  dir: string;
  liveness: "alive" | "dead" | "unknown";
  reason?: string;
}

/** Runtime dirs of this package under `root`, with their owner's liveness. Links and other users' leftovers are skipped. */
export async function scanRuntimeDirs(options: WinFootprintOptions): Promise<RuntimeDirEntry[]> {
  let names: string[];
  try {
    names = await options.fs.readdir(options.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: RuntimeDirEntry[] = [];
  for (const name of names.sort()) {
    if (!RUNTIME_DIR_NAME.test(name)) continue;
    const dir = win32.join(options.root, name);
    if (!isPackageRuntimeDir(options.root, dir)) continue;
    let type;
    try {
      type = await options.fs.lstat(dir);
    } catch {
      continue;
    }
    if (type !== "dir") continue;
    const owner = await readRuntimeOwner(options.fs, dir);
    if (!owner) {
      entries.push({ dir, liveness: "unknown", reason: "owner.json missing or invalid" });
      continue;
    }
    const liveness = ownerLiveness(owner, DEFAULT_PROC_ROOT, options.probe);
    entries.push({ dir, liveness, ...(liveness === "unknown" ? { reason: "owner process state could not be read" } : {}) });
  }
  return entries;
}

function sharesGenericRoot(options: WinFootprintOptions): boolean {
  return samePath(options.genericRoot ?? tmpdir(), options.root);
}

/** Orphan audit (read-only): runtime dirs of dead owners with what their records still name, and dirs whose owner is unknown. */
export async function auditWindowsOrphans(options: WinFootprintOptions): Promise<Leftover[]> {
  const shared = sharesGenericRoot(options);
  const leftovers: Leftover[] = [];
  for (const entry of await scanRuntimeDirs(options)) {
    if (options.signal?.aborted) break;
    if (entry.liveness === "alive") continue;
    if (entry.liveness === "unknown") {
      if (!shared) leftovers.push({ kind: "tempdir", id: entry.dir, detail: `owner unknown (${entry.reason}); not removed automatically` });
      continue;
    }
    const audit = await auditRuntimeDir(entry.dir, options, "orphan");
    // The generic scan already lists the dir itself when it shares the root.
    leftovers.push(...(shared ? audit.filter((l) => !(l.kind === "tempdir" && l.id === entry.dir)) : audit));
  }
  return leftovers;
}

/** Orphan sweep: {@link cleanupRuntimeDir} for every runtime dir whose owner is dead. Returns what is left and unknown owners. */
export async function sweepWindowsOrphans(options: WinFootprintOptions): Promise<Leftover[]> {
  const shared = sharesGenericRoot(options);
  const leftovers: Leftover[] = [];
  for (const entry of await scanRuntimeDirs(options)) {
    if (options.signal?.aborted) break;
    if (entry.liveness === "alive") continue;
    if (entry.liveness === "unknown") {
      if (!shared) leftovers.push({ kind: "tempdir", id: entry.dir, detail: `owner unknown (${entry.reason}); not removed automatically` });
      continue;
    }
    leftovers.push(...(await cleanupRuntimeDir(entry.dir, options, "orphan")));
  }
  return leftovers;
}
