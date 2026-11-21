/**
 * Host footprint of `local-linux` (spec §7a.2, §7a.4): display lock records
 * in the shared lock dir, the processes tagged with a session's
 * `PI_GUI_TAG`, and the X socket and lock of displays this package started.
 *
 * The helper removes all of it on teardown. These functions are the client's
 * second line: they clean up after a helper that is gone (crashed, killed)
 * and audit what is left. They act only on lock records whose helper is dead
 * (different boot, PID gone, or PID reused), and on X files whose lock names
 * the recorded Xvfb. Live helpers, unknown owners, and displays this package
 * did not start are reported or ignored, never touched.
 */
import { lstat, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROC_ROOT, ownerLiveness, readProcessStartTime } from "../../cleanup/identity.ts";
import { parseProcessResourceId } from "../../cleanup/session-dir.ts";
import type { OwnerLiveness } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import { HOST_MODE_ENV } from "./host.ts";

export const X11_SOCKET_DIR = "/tmp/.X11-unix";
export const X_LOCK_DIR = "/tmp";
const LOCK_NAME = /^display-(\d+)\.lock$/;
/** A lock that cannot be parsed is only reported once it is this old (a helper may be writing it). */
const UNPARSEABLE_GRACE_MS = 60_000;

/** One `display-<N>.lock` record (`hostmode.py`). */
export interface DisplayLockRecord {
  version: 1;
  display: number;
  /** `<pid>:<starttime>` of the helper that holds the display. */
  helper: string;
  bootId: string | null;
  tag: string;
  runtimeDir: string;
  workspace: string;
  createdAt: string;
  xvfbPid: number | null;
  /** `{ xvfb, dbus, atspi, openbox }` → `<pid>:<starttime>`. */
  infra: Record<string, string>;
}

export interface DisplayLockEntry {
  path: string;
  record?: DisplayLockRecord;
  /** Why `record` is missing. */
  problem?: string;
  mtimeMs: number;
}

export interface FootprintOptions {
  lockDir: string;
  procRoot?: string;
  x11Dir?: string;
  xLockDir?: string;
  uid?: number;
  /** Injected for tests; default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Time a SIGTERM gets before SIGKILL. Default 1.5 s. */
  termWaitMs?: number;
  now?: () => number;
}

/** Validates a parsed lock record; returns the problem, or `undefined` when it is usable. */
export function lockRecordProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "is not an object";
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return `has unknown version ${JSON.stringify(r.version)}`;
  if (!Number.isSafeInteger(r.display) || (r.display as number) < 1) return "has no valid display";
  if (typeof r.helper !== "string" || !parseProcessResourceId(r.helper)) return "has no valid helper id";
  if (typeof r.tag !== "string" || !/^[\w-]{1,64}$/.test(r.tag)) return "has no valid tag";
  if (r.bootId !== null && typeof r.bootId !== "string") return "has no valid bootId";
  if (r.xvfbPid !== null && !(Number.isSafeInteger(r.xvfbPid) && (r.xvfbPid as number) > 0)) return "has no valid xvfbPid";
  if (typeof r.infra !== "object" || r.infra === null || Array.isArray(r.infra)) return "has no infra map";
  return undefined;
}

/**
 * Lists the lock records of this user in `lockDir`. Files of other users and
 * anything that is not a regular `display-<N>.lock` file are skipped.
 */
export async function listDisplayLocks(lockDir: string, uid: number = process.getuid?.() ?? 0): Promise<DisplayLockEntry[]> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: DisplayLockEntry[] = [];
  for (const name of names.sort()) {
    if (!LOCK_NAME.test(name)) continue;
    const path = join(lockDir, name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.uid !== uid) continue;
    const entry: DisplayLockEntry = { path, mtimeMs: info.mtimeMs };
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const problem = lockRecordProblem(raw);
      if (problem) entry.problem = `lock ${problem}`;
      else entry.record = raw as DisplayLockRecord;
    } catch (error) {
      entry.problem = `lock unreadable: ${(error as Error).message}`;
    }
    entries.push(entry);
  }
  return entries;
}

/** Liveness of the helper that holds a lock; a record without a boot id is `unknown`. */
export function lockLiveness(record: DisplayLockRecord, procRoot: string = DEFAULT_PROC_ROOT): OwnerLiveness {
  const helper = parseProcessResourceId(record.helper);
  if (!helper || !record.bootId) return "unknown";
  return ownerLiveness({ pid: helper.pid, processStartTime: helper.startTime, bootId: record.bootId }, procRoot);
}

/** PIDs of this user's processes whose initial environment holds `PI_GUI_TAG=<tag>`. */
export async function taggedProcesses(tag: string, procRoot: string = DEFAULT_PROC_ROOT, uid: number = process.getuid?.() ?? 0): Promise<number[]> {
  const needle = `${HOST_MODE_ENV.tag}=${tag}`;
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if ((await stat(join(procRoot, name))).uid !== uid) continue;
      const environ = await readFile(join(procRoot, name, "environ"));
      if (environ.toString("utf8").split("\0").includes(needle)) found.push(Number(name));
    } catch {
      // Gone or not ours to read.
    }
  }
  return found.sort((a, b) => a - b);
}

function startOf(id: string | undefined): { pid: number; startTime: string } | undefined {
  return id ? parseProcessResourceId(id) : undefined;
}

function sendSignal(kill: NonNullable<FootprintOptions["kill"]>, pid: number, signal: NodeJS.Signals): void {
  try {
    kill(pid, signal);
  } catch {
    // ESRCH: already gone; EPERM: reported as still running below.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The X socket and lock files of display `n`. */
export function xFiles(n: number, x11Dir: string = X11_SOCKET_DIR, xLockDir: string = X_LOCK_DIR): { socket: string; lock: string } {
  return { socket: join(x11Dir, `X${n}`), lock: join(xLockDir, `.X${n}-lock`) };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** PID in an X server lock file (`/tmp/.X<N>-lock`), or `undefined`. */
export async function readXLockPid(path: string): Promise<number | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return /^\d+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * X files of `record`'s display that belong to its (now dead) Xvfb: present,
 * and either no X lock or an X lock naming the recorded Xvfb PID. Another X
 * server on the same number is not ours and is ignored.
 */
async function ownXFiles(record: DisplayLockRecord, options: FootprintOptions): Promise<string[]> {
  if (record.xvfbPid === null) return [];
  const files = xFiles(record.display, options.x11Dir, options.xLockDir);
  const hasLock = await exists(files.lock);
  if (hasLock && (await readXLockPid(files.lock)) !== record.xvfbPid) return [];
  const own = [];
  if (hasLock) own.push(files.lock);
  if (await exists(files.socket)) own.push(files.socket);
  return own;
}

function xvfbAlive(record: DisplayLockRecord, procRoot: string): boolean {
  const xvfb = startOf(record.infra.xvfb);
  return xvfb !== undefined && readProcessStartTime(xvfb.pid, procRoot) === xvfb.startTime;
}

/** Read-only: what is left of one lock's session (the lock itself is reported by the caller). */
export async function lockRemnants(record: DisplayLockRecord, options: FootprintOptions): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const leftovers: Leftover[] = [];
  for (const pid of await taggedProcesses(record.tag, procRoot, options.uid)) {
    leftovers.push({ kind: "process", id: String(pid), detail: `tagged ${record.tag} (display :${record.display})` });
  }
  const tagged = new Set(leftovers.map((l) => Number(l.id)));
  for (const [name, id] of Object.entries(record.infra)) {
    const parsed = startOf(id);
    if (parsed && !tagged.has(parsed.pid) && readProcessStartTime(parsed.pid, procRoot) === parsed.startTime) {
      leftovers.push({ kind: "process", id, detail: `${name} of display :${record.display}` });
    }
  }
  for (const path of await ownXFiles(record, options)) leftovers.push({ kind: "display", id: path, detail: `X file of display :${record.display}` });
  return leftovers;
}

/**
 * Removes what a gone helper left for `record`: tagged processes (SIGTERM,
 * then SIGKILL), recorded infrastructure processes whose start time still
 * matches, the display's X files when they belong to the recorded Xvfb, and
 * finally the lock at `path`. The lock stays when anything could not be
 * removed, so a later sweep retries. Returns what is left.
 */
export async function cleanupLock(path: string | undefined, record: DisplayLockRecord, options: FootprintOptions): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const termWait = options.termWaitMs ?? 1_500;
  const targets = new Set(await taggedProcesses(record.tag, procRoot, options.uid));
  for (const id of Object.values(record.infra)) {
    const parsed = startOf(id);
    if (parsed && readProcessStartTime(parsed.pid, procRoot) === parsed.startTime) targets.add(parsed.pid);
  }
  for (const [signal, waitMs] of [["SIGTERM", termWait], ["SIGKILL", 1_000]] as const) {
    if (targets.size === 0) break;
    for (const pid of targets) sendSignal(kill, pid, signal);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const remaining = await stillRunning(record, targets, procRoot, options.uid);
      targets.clear();
      for (const pid of remaining) targets.add(pid);
      if (targets.size === 0 || Date.now() >= deadline) break;
      await sleep(50);
    }
  }
  const leftovers: Leftover[] = [...targets].map((pid) => ({ kind: "process", id: String(pid), detail: `could not be stopped (display :${record.display})` }));
  if (!xvfbAlive(record, procRoot)) {
    for (const file of await ownXFiles(record, options)) {
      try {
        if ((await lstat(file)).uid === (options.uid ?? process.getuid?.() ?? 0)) await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") leftovers.push({ kind: "display", id: file, detail: `remove failed: ${(error as Error).message}` });
      }
    }
  }
  if (path && leftovers.length === 0) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") leftovers.push({ kind: "display-lock", id: path, detail: `remove failed: ${(error as Error).message}` });
    }
  } else if (path) {
    leftovers.push({ kind: "display-lock", id: path, detail: "kept until its processes are gone" });
  }
  return leftovers;
}

async function stillRunning(record: DisplayLockRecord, pids: ReadonlySet<number>, procRoot: string, uid: number | undefined): Promise<number[]> {
  const tagged = new Set(await taggedProcesses(record.tag, procRoot, uid));
  const infra = new Map<number, string>();
  for (const id of Object.values(record.infra)) {
    const parsed = startOf(id);
    if (parsed) infra.set(parsed.pid, parsed.startTime);
  }
  return [...pids].filter((pid) => tagged.has(pid) || (infra.has(pid) && readProcessStartTime(pid, procRoot) === infra.get(pid)));
}

function unknownLock(entry: DisplayLockEntry, reason: string): Leftover {
  return { kind: "display-lock", id: entry.path, detail: `owner unknown (${reason}); not removed automatically` };
}

/**
 * Orphan audit (read-only): locks of dead helpers with what they left, and
 * locks whose helper cannot be judged. Live helpers are exempt.
 */
export async function auditLocalOrphans(options: FootprintOptions): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const now = options.now?.() ?? Date.now();
  const leftovers: Leftover[] = [];
  for (const entry of await listDisplayLocks(options.lockDir, options.uid)) {
    if (!entry.record) {
      if (now - entry.mtimeMs >= UNPARSEABLE_GRACE_MS) leftovers.push(unknownLock(entry, entry.problem ?? "unreadable"));
      continue;
    }
    const liveness = lockLiveness(entry.record, procRoot);
    if (liveness === "alive") continue;
    if (liveness === "unknown") {
      leftovers.push(unknownLock(entry, "helper state could not be read"));
      continue;
    }
    leftovers.push({ kind: "display-lock", id: entry.path, detail: `display :${entry.record.display} of a stopped helper` });
    leftovers.push(...(await lockRemnants(entry.record, options)));
  }
  return leftovers;
}

/** Orphan sweep: {@link cleanupLock} for every lock whose helper is dead. Returns what could not be removed and unknown owners. */
export async function sweepLocalOrphans(options: FootprintOptions & { signal?: AbortSignal }): Promise<Leftover[]> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const now = options.now?.() ?? Date.now();
  const leftovers: Leftover[] = [];
  for (const entry of await listDisplayLocks(options.lockDir, options.uid)) {
    if (options.signal?.aborted) break;
    if (!entry.record) {
      if (now - entry.mtimeMs >= UNPARSEABLE_GRACE_MS) leftovers.push(unknownLock(entry, entry.problem ?? "unreadable"));
      continue;
    }
    const liveness = lockLiveness(entry.record, procRoot);
    if (liveness === "alive") continue;
    if (liveness === "unknown") {
      leftovers.push(unknownLock(entry, "helper state could not be read"));
      continue;
    }
    leftovers.push(...(await cleanupLock(entry.path, entry.record, options)));
  }
  return leftovers;
}
