/**
 * Client session temp dir and its `owner.json` (spec §7a.2). The record is
 * rewritten atomically before every resource is created, so a crash at any
 * point leaves a record that lists everything that may exist.
 */
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../config/atomic.ts";
import { OWNER_FILE, SESSION_DIR_PREFIX, formatOwnerLabel, type OwnerLabel, type OwnerRecord, type OwnerResource } from "../owner.ts";
import { readProcessStartTime, DEFAULT_PROC_ROOT } from "./identity.ts";

/** Resource kind for client processes; its id is {@link processResourceId}. */
export const PROCESS_KIND = "process";

/** Id of a process resource: `<pid>:<startTime>`, so the sweep can tell a reused PID apart. */
export function processResourceId(pid: number, procRoot: string = DEFAULT_PROC_ROOT): string {
  const start = readProcessStartTime(pid, procRoot);
  if (!start) throw new Error(`cannot read start time of process ${pid}`);
  return `${pid}:${start}`;
}

/** Parses a {@link processResourceId}; `undefined` when malformed. */
export function parseProcessResourceId(id: string): { pid: number; startTime: string } | undefined {
  const match = /^(\d+):(\d+)$/.exec(id);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, startTime: match[2] } : undefined;
}

/** Writes `owner.json` atomically with mode 0600. */
export async function writeOwnerRecord(dir: string, record: OwnerRecord): Promise<void> {
  await writeJsonAtomic(join(dir, OWNER_FILE), record, { mode: 0o600 });
}

export type OwnerRecordRead = { ok: true; record: OwnerRecord } | { ok: false; reason: string };

/** Reads and validates `owner.json`. Missing, malformed, partial, or unknown-version records are `ok: false`. */
export async function readOwnerRecord(dir: string): Promise<OwnerRecordRead> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, OWNER_FILE), "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "owner.json missing" : `owner.json unreadable: ${(error as Error).message}` };
  }
  const problem = ownerRecordProblem(raw);
  return problem ? { ok: false, reason: `owner.json ${problem}` } : { ok: true, record: raw as OwnerRecord };
}

function ownerRecordProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "is not an object";
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return `has unknown version ${JSON.stringify(r.version)}`;
  if (!Number.isSafeInteger(r.pid) || (r.pid as number) <= 0) return "has no valid pid";
  if (typeof r.processStartTime !== "string" || !/^\d+$/.test(r.processStartTime)) return "has no valid processStartTime";
  for (const key of ["bootId", "clientId", "piSessionId", "backend", "createdAt"]) {
    if (typeof r[key] !== "string" || (key !== "piSessionId" && (r[key] as string).length === 0)) return `has no valid ${key}`;
  }
  if (!Array.isArray(r.resources)) return "has no resources list";
  for (const res of r.resources) {
    if (typeof res !== "object" || res === null || typeof res.kind !== "string" || typeof res.id !== "string") {
      return "has a malformed resource entry";
    }
  }
  return undefined;
}

export interface CreateSessionDirOptions {
  identity: OwnerLabel;
  piSessionId: string;
  backend: string;
  /** Parent directory; default `os.tmpdir()`. */
  tmpRoot?: string;
  now?: () => Date;
}

/** A live session temp dir owned by this client. */
export class SessionDir {
  readonly path: string;
  readonly ownerLabel: string;
  #record: OwnerRecord;
  #writes: Promise<void> = Promise.resolve();
  #removed = false;

  constructor(path: string, record: OwnerRecord) {
    this.path = path;
    this.#record = record;
    this.ownerLabel = formatOwnerLabel(record);
  }

  /** A copy of the current record. */
  get record(): OwnerRecord {
    return { ...this.#record, resources: this.#record.resources.map((r) => ({ ...r })) };
  }

  /** Resources recorded so far. */
  get resources(): OwnerResource[] {
    return this.record.resources;
  }

  /**
   * Adds a resource to `owner.json` and resolves once the file is replaced.
   * Callers must await it before creating the resource. Duplicate entries are
   * ignored; concurrent calls are serialised so no update is lost.
   */
  recordResource(kind: string, id: string): Promise<void> {
    const run = async () => {
      if (this.#removed) throw new Error(`session dir ${this.path} was already removed`);
      if (this.#record.resources.some((r) => r.kind === kind && r.id === id)) return;
      const next = { ...this.#record, resources: [...this.#record.resources, { kind, id }] };
      await writeOwnerRecord(this.path, next);
      this.#record = next;
    };
    const result = this.#writes.then(run);
    this.#writes = result.catch(() => {});
    return result;
  }

  /** Removes the directory and everything in it. Idempotent. */
  async remove(): Promise<void> {
    this.#removed = true;
    await this.#writes;
    await rm(this.path, { recursive: true, force: true });
  }
}

/**
 * Creates `os.tmpdir()/pi-gui-testing-XXXXXX` with mode 0700 and writes its
 * initial `owner.json` (no resources yet).
 */
export async function createSessionDir(options: CreateSessionDirOptions): Promise<SessionDir> {
  const root = options.tmpRoot ?? tmpdir();
  const path = await mkdtemp(join(root, SESSION_DIR_PREFIX));
  try {
    // mkdtemp already uses 0700; chmod guards against an unusual umask-free platform default.
    await chmod(path, 0o700);
    const { identity } = options;
    const record: OwnerRecord = {
      version: 1,
      pid: identity.pid,
      processStartTime: identity.processStartTime,
      bootId: identity.bootId,
      clientId: identity.clientId,
      piSessionId: options.piSessionId,
      backend: options.backend,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      resources: [],
    };
    await writeOwnerRecord(path, record);
    return new SessionDir(path, record);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}
