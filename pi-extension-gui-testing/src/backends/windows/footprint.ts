/**
 * Footprint of a Windows helper session on the machine that runs it (spec
 * §7a.4 `local-windows` row): the session's Job Objects and their processes,
 * its private desktop, and its runtime dir. The helper removes all of it on
 * teardown, and Windows ends every job process when the helper dies. These
 * functions are the client's second line: they read `session.json` from the
 * runtime dir, check each object by PID + creation time or by name, end what
 * is left (teardown and sweep only), and remove the dir.
 *
 * `session.json` is written by the helper into a dir the app under test can
 * also write, so it never authorizes ending a process on its own:
 * - jobs are terminated by name only when the name carries the session tag
 *   the client chose and recorded (the runtime dir's own hex digits) before
 *   the helper started, so only the session's jobs and their processes end;
 * - a process is ended by PID only when it is the helper the client itself
 *   spawned: its PID and start time recorded by the client at spawn must
 *   match the record's helper entry (and the kill re-checks the exact
 *   creation time);
 * - every other recorded process is inspected and reported, never ended.
 *
 * The runtime dir's `owner.json` copy is just as writable, so it never
 * authorizes a kill either. In teardown the client's in-memory spawn id does;
 * in the orphan sweep only the client's own session record does: the
 * `owner.json` of a client session dir (`pi-gui-testing-XXXXXX`, outside the
 * runtime dir) that lists this runtime dir. Without exactly one such record
 * (for example after the client scan already removed it) the sweep ends only
 * the session's jobs and reports the helper.
 *
 * The orphan audit and sweep act only on runtime dirs this package created
 * (name pattern, real directory, owner record) whose owner is dead. Live and
 * unknown owners are never touched; unknown ones are reported.
 */
import { win32 } from "node:path";
import { DEFAULT_PROC_ROOT, ownerLiveness, type ProcessProbe } from "../../cleanup/identity.ts";
import { parseProcessResourceId, PROCESS_KIND } from "../../cleanup/session-dir.ts";
import { BACKEND_OWNED_DIR } from "../../cleanup/sweep.ts";
import { OWNER_FILE, SESSION_DIR_PREFIX, type OwnerRecord } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { inspectWindowsObjects, type InspectResult, type ObjectState } from "./inspect.ts";
import { boundedText, samePath } from "./paths.ts";
import { isPackageRuntimeDir, ownerRecordFrom, readRuntimeOwner, removeRuntimeDir, RUNTIME_DIR_KIND, RUNTIME_DIR_NAME, runtimeDirTag, type WinFs } from "./runtime-dir.ts";
import { MAX_SESSION_RECORD_BYTES, parseSessionRecord, processKey, SESSION_RECORD_FILE, type WinProcessId, type WinSessionRecord } from "./session-record.ts";

export interface WinFootprintOptions {
  fs: WinFs;
  runner: CommandRunner;
  /** Absolute `powershell.exe`. */
  powershell: string;
  /** Allow-listed system variables for PowerShell. */
  env: Record<string, string>;
  /** `%LOCALAPPDATA%\Temp`, where runtime dirs live. */
  root: string;
  /**
   * Where the client's session dirs live (`os.tmpdir()`, usually the same
   * dir as `root`). Their `owner.json` is the only record the orphan sweep
   * trusts to end a dead owner's helper; without it, nothing is ended by PID.
   */
  clientRoot?: string;
  /** Owner liveness probe (the platform default in production). */
  probe: ProcessProbe;
  signal?: AbortSignal;
}

export type RecordRead = { state: "missing" } | { state: "invalid"; problem: string } | { state: "ok"; record: WinSessionRecord };

/** Reads `<runtimeDir>\session.json` (untrusted) with the rules of {@link parseSessionRecord} for a `local` helper of this runtime dir's tag. */
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
  const tag = runtimeDirTag(runtimeDir);
  if (tag === undefined) return { state: "invalid", problem: "is in a dir that is not a runtime dir of this package" };
  const parsed = parseSessionRecord(text, { runtimeDir, mode: "local", privateDesktop: true, tag });
  return "record" in parsed ? { state: "ok", record: parsed.record } : { state: "invalid", problem: parsed.problem };
}

/** Seconds since 1970 of a FILETIME (100 ns ticks since 1601), as `owner.json` process start times are written on Windows. */
export function filetimeToUnixSeconds(created: string): bigint {
  return BigInt(created) / 10_000_000n - 11_644_473_600n;
}

/**
 * `true` when `process` (PID + FILETIME from a session record) is one the
 * client recorded itself at spawn: `trusted` holds `owner.json` process ids
 * (`<pid>:<start, Unix seconds>`).
 */
export function spawnedByClient(process: WinProcessId, trusted: readonly string[]): boolean {
  let seconds: bigint;
  try {
    seconds = filetimeToUnixSeconds(process.created);
  } catch {
    return false;
  }
  return trusted.some((id) => {
    const parsed = parseProcessResourceId(id);
    if (!parsed || parsed.pid !== process.pid || !/^\d{1,15}$/.test(parsed.startTime)) return false;
    const delta = BigInt(parsed.startTime) - seconds;
    return delta >= -1n && delta <= 1n;
  });
}

/** The `process` resources of a client owner record: what the client itself spawned and recorded. */
export function ownerProcesses(owner: OwnerRecord | undefined): string[] {
  return (owner?.resources ?? []).filter((r) => r.kind === PROCESS_KIND).map((r) => r.id);
}

/**
 * Inspects the helper, the recorded processes and jobs, and the private
 * desktop of `record`. With `kill`, ends the jobs and, if it is in `trusted`
 * ({@link spawnedByClient}), the helper; other processes are only inspected.
 */
export function inspectRecord(record: WinSessionRecord, action: "audit" | "kill", options: WinFootprintOptions, trusted: readonly string[] = []): Promise<InspectResult> {
  const helper = { ...record.helper, ...(action === "kill" && spawnedByClient(record.helper, trusted) ? { kill: true } : {}) };
  return inspectWindowsObjects(
    { action, tag: record.tag, processes: [helper, ...record.processes.filter((p) => processKey(p) !== processKey(record.helper))], jobs: record.jobs, desktops: [record.desktop] },
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
 * terminates the session's jobs that still exist (names with the session
 * tag) and the helper if the client spawned it (`trusted`, see
 * {@link spawnedByClient}), reports every other recorded process that still
 * runs, then removes the dir. The dir stays while anything is left, so a
 * later attempt can retry with the same record.
 */
export async function cleanupRuntimeDir(runtimeDir: string, options: WinFootprintOptions, where = "session", trusted: readonly string[] = []): Promise<Leftover[]> {
  const type = await options.fs.lstat(runtimeDir).catch(() => "dir" as const);
  if (type === undefined) return [];
  const read = type === "dir" ? await readSessionRecord(options.fs, runtimeDir) : ({ state: "missing" } as const);
  const leftovers: Leftover[] = [];
  if (read.state === "ok") {
    const result = await inspectRecord(read.record, "kill", options, trusted);
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
  /** `process` resources of the client session record that lists this dir: the helper the dead owner spawned. */
  spawned?: string[];
}

/** A client session dir's `owner.json` (outside every runtime dir) of a `local-windows` session. */
interface ClientRecord {
  dir: string;
  record: OwnerRecord;
}

/**
 * The client session records under `clientRoot` written by `local-windows`
 * sessions. Only real dirs with the generic session-dir name are read; the
 * runtime dirs (also `pi-gui-testing-…`) never count, since their apps can write them.
 */
async function clientRecords(options: WinFootprintOptions): Promise<ClientRecord[]> {
  const root = options.clientRoot;
  if (!root) return [];
  let names: string[];
  try {
    names = await options.fs.readdir(root);
  } catch {
    return [];
  }
  const records: ClientRecord[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(SESSION_DIR_PREFIX) || BACKEND_OWNED_DIR.test(name)) continue;
    const dir = win32.join(root, name);
    try {
      if ((await options.fs.lstat(dir)) !== "dir" || (await options.fs.lstat(win32.join(dir, OWNER_FILE))) !== "file") continue;
      const record = ownerRecordFrom(await options.fs.readFile(win32.join(dir, OWNER_FILE), 64 * 1024));
      if (record?.backend === "local-windows") records.push({ dir, record });
    } catch {
      // Unreadable: not a record this sweep can rely on.
    }
  }
  return records;
}

/**
 * Runtime dirs of this package under `root`, with their owner's liveness.
 * Links and other users' leftovers are skipped. The client session record
 * that lists a dir decides its owner and trusted helper; the dir's own owner
 * copy only judges the owner when no client record lists it, and then
 * authorizes nothing.
 */
export async function scanRuntimeDirs(options: WinFootprintOptions): Promise<RuntimeDirEntry[]> {
  let names: string[];
  try {
    names = await options.fs.readdir(options.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const clients = await clientRecords(options);
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
    const claims = clients.filter((c) => c.record.resources.some((r) => r.kind === RUNTIME_DIR_KIND && samePath(r.id, dir)));
    if (claims.length > 1) {
      entries.push({ dir, liveness: "unknown", reason: `${claims.length} client session records list it (${claims.map((c) => c.dir).join(", ")})` });
      continue;
    }
    const client = claims[0]?.record;
    const owner = client ?? (await readRuntimeOwner(options.fs, dir));
    if (!owner) {
      entries.push({ dir, liveness: "unknown", reason: "owner.json missing or invalid" });
      continue;
    }
    const liveness = ownerLiveness(owner, DEFAULT_PROC_ROOT, options.probe);
    entries.push({ dir, liveness, ...(client ? { spawned: ownerProcesses(client) } : {}), ...(liveness === "unknown" ? { reason: "owner process state could not be read" } : {}) });
  }
  return entries;
}

/**
 * Orphan audit (read-only): runtime dirs of dead owners with what their
 * records still name, and dirs whose owner is unknown. The client's generic
 * session-dir scan leaves these dirs to this audit (it skips the
 * `pi-gui-testing-win-` names), so every line comes from here.
 */
export async function auditWindowsOrphans(options: WinFootprintOptions): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  for (const entry of await scanRuntimeDirs(options)) {
    if (options.signal?.aborted) break;
    if (entry.liveness === "alive") continue;
    if (entry.liveness === "unknown") {
      leftovers.push({ kind: "tempdir", id: entry.dir, detail: `owner unknown (${entry.reason}); not removed automatically` });
      continue;
    }
    leftovers.push(...(await auditRuntimeDir(entry.dir, options, "orphan")));
  }
  return leftovers;
}

/**
 * Orphan sweep: {@link cleanupRuntimeDir} for every runtime dir whose owner is
 * dead, trusting only the helper its client session record lists. Returns
 * what is left and unknown owners.
 */
export async function sweepWindowsOrphans(options: WinFootprintOptions): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  for (const entry of await scanRuntimeDirs(options)) {
    if (options.signal?.aborted) break;
    if (entry.liveness === "alive") continue;
    if (entry.liveness === "unknown") {
      leftovers.push({ kind: "tempdir", id: entry.dir, detail: `owner unknown (${entry.reason}); not removed automatically` });
      continue;
    }
    leftovers.push(...(await cleanupRuntimeDir(entry.dir, options, "orphan", entry.spawned ?? [])));
  }
  return leftovers;
}
