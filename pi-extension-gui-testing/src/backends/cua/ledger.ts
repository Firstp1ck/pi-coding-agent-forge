/**
 * Local record of every sandbox this machine creates (spec §7a). A cloud
 * account is shared by every machine of its owner, so a sandbox is removed by
 * a sweep only when this machine's ledger proves that this client created it
 * and that its owner process is gone. Sandboxes with the package's name
 * prefix but no record here are reported, never deleted.
 *
 * Layout: `<dir>/<name>.json` for a sandbox in use or awaiting deletion,
 * `<dir>/<name>.kept.json` for one kept by `keepSandbox`. A record is written
 * (atomically, 0600) before `sandbox create` runs and removed only after the
 * deletion is confirmed, so a crash at any point leaves a record the next
 * sweep completes. Every move between the two sets is a single `rename`, so a
 * sandbox's record is in exactly one of them at any time.
 *
 * Every transition (write, update, keep, claim, delete) runs under the
 * ledger's interprocess lock ({@link LedgerLock}) and re-reads the record
 * inside it: a transition that names an expected owner (session id, and
 * optionally owner label or `keptAt`) acts only when the record still has it
 * (compare-and-swap). A sweep or a session working from an older read can
 * therefore never move, claim, or delete a record another process has taken
 * since. Reads (`read`, `entries`) take no lock.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../../config/atomic.ts";
import { globalConfigPath } from "../../config/types.ts";
import { DEFAULT_PROC_ROOT, ownerLiveness } from "../../cleanup/identity.ts";
import { parseOwnerLabel, type OwnerLiveness } from "../../owner.ts";
import { LedgerLock, type LedgerLockOptions } from "./ledger-lock.ts";

/** Prefix of every sandbox name this package creates. */
export const SANDBOX_PREFIX = "pi-gui-testing-";

/**
 * Short, stable tag of this machine (from `/etc/machine-id`, else the host
 * name). Sandbox names carry it, so a listing tells this machine's sandboxes
 * from those other machines of the same account create; it is a hash, not
 * the id itself.
 */
export function hostTag(files: readonly string[] = ["/etc/machine-id", "/var/lib/dbus/machine-id"]): string {
  let source = "";
  for (const file of files) {
    try {
      source = readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (source) break;
  }
  return createHash("sha256").update(source || `host:${hostname()}`).digest("hex").slice(0, 8);
}

/** Name prefix of this machine's sandboxes. */
export function hostPrefix(tag: string): string {
  return `${SANDBOX_PREFIX}${tag}-`;
}

/** Sandbox name of a session on the machine with `tag`; known before the sandbox exists. */
export function sandboxName(sessionId: string, tag: string): string {
  const name = `${hostPrefix(tag)}${sessionId}`;
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new Error(`session id ${JSON.stringify(sessionId)} does not make a valid sandbox name`);
  return name;
}

/** Stable key of a project root, so a kept sandbox is reused only for the project whose files it holds. */
export function projectKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

export type LedgerPhase = "creating" | "created" | "deleting";

export interface LedgerRecord {
  version: 1;
  name: string;
  /** `<location>:<name>`. */
  ref: string;
  location: string;
  /** `pi-gui-testing.owner` value of the session that uses it. */
  ownerLabel: string;
  sessionId: string;
  projectKey: string;
  phase: LedgerPhase;
  /** The session asked to keep it (`keepSandbox`); a dead owner's sandbox is then kept, not deleted. */
  keep: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601; set on kept records. */
  keptAt?: string;
  /**
   * Image the sandbox was created from. A kept sandbox is reused only for the
   * same image; records written before images were recorded have none and are
   * never reused.
   */
  image?: string;
}

/** The owner a transition expects the record to still have. */
export interface ExpectedOwner {
  sessionId: string;
  ownerLabel?: string;
  /** For kept records: the `keptAt` that was read. */
  keptAt?: string;
}

function hasOwner(record: LedgerRecord, expect: ExpectedOwner | undefined): boolean {
  if (!expect) return true;
  return record.sessionId === expect.sessionId && (expect.ownerLabel === undefined || record.ownerLabel === expect.ownerLabel) && (expect.keptAt === undefined || record.keptAt === expect.keptAt);
}

/** Default ledger directory: `<agent dir>/gui/cua-sandboxes`. */
export function defaultLedgerDir(): string {
  return join(dirname(globalConfigPath()), "cua-sandboxes");
}

const ACTIVE = ".json";
const KEPT = ".kept.json";

function recordProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return "unknown version";
  for (const key of ["name", "ref", "location", "ownerLabel", "sessionId", "projectKey", "createdAt"]) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0 || (r[key] as string).length > 512) return `bad ${key}`;
  }
  if (!["creating", "created", "deleting"].includes(r.phase as string)) return "bad phase";
  if (typeof r.keep !== "boolean") return "bad keep";
  if (r.image !== undefined && (typeof r.image !== "string" || r.image.length === 0 || r.image.length > 512)) return "bad image";
  if (!(r.name as string).startsWith(SANDBOX_PREFIX) || r.ref !== `${r.location}:${r.name}`) return "name and ref disagree";
  return undefined;
}

export interface LedgerEntry {
  record?: LedgerRecord;
  /** Set when the file could not be read or validated; such entries are reported, never acted on. */
  problem?: string;
  file: string;
  kept: boolean;
}

export interface SandboxLedgerOptions {
  lock?: LedgerLockOptions;
}

export class SandboxLedger {
  readonly dir: string;
  readonly #lock: LedgerLock;

  constructor(dir: string = defaultLedgerDir(), options: SandboxLedgerOptions = {}) {
    this.dir = dir;
    this.#lock = new LedgerLock(dir, options.lock);
  }

  #file(name: string, kept: boolean): string {
    if (!name.startsWith(SANDBOX_PREFIX) || name.includes("/") || name.includes("\0")) throw new Error(`invalid sandbox name ${JSON.stringify(name)}`);
    return join(this.dir, `${name}${kept ? KEPT : ACTIVE}`);
  }

  async #put(record: LedgerRecord, kept = false): Promise<void> {
    await writeJsonAtomic(this.#file(record.name, kept), record, { mode: 0o600, dirMode: 0o700 });
  }

  /** Writes (or replaces) the active record. Resolves before the caller creates or deletes anything. */
  async write(record: LedgerRecord): Promise<void> {
    this.#file(record.name, false);
    await this.#lock.run(() => this.#put(record));
  }

  /** Changes the active record; only while it still has `expect`'s owner, when given. */
  async update(name: string, change: Partial<LedgerRecord>, expect?: ExpectedOwner): Promise<LedgerRecord | undefined> {
    this.#file(name, false);
    return this.#lock.run(async () => {
      const current = await this.read(name);
      if (!current || !hasOwner(current, expect)) return undefined;
      const next = { ...current, ...change };
      await this.#put(next);
      return next;
    });
  }

  async read(name: string, kept = false): Promise<LedgerRecord | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#file(name, kept), "utf8"));
    } catch {
      return undefined;
    }
    return recordProblem(raw) ? undefined : (raw as LedgerRecord);
  }

  /**
   * Removes a record once the sandbox is confirmed gone; with `expect`, only
   * while the record still has that owner. `true` when no such record is left.
   */
  async remove(name: string, kept = false, expect?: ExpectedOwner): Promise<boolean> {
    this.#file(name, kept);
    return this.#lock.run(async () => {
      if (expect) {
        const current = await this.read(name, kept);
        if (current && !hasOwner(current, expect)) return false;
      }
      await rm(this.#file(name, kept), { force: true });
      return true;
    });
  }

  /**
   * Moves the active record to the kept set (the sandbox stays), only while
   * it still belongs to `expect` (a session id, or the session and owner a
   * sweep judged). `true` when it moved.
   */
  async markKept(name: string, expect: string | ExpectedOwner): Promise<boolean> {
    const owner = typeof expect === "string" ? { sessionId: expect } : expect;
    if (typeof owner?.sessionId !== "string") throw new Error("markKept needs the session id of the record it keeps");
    this.#file(name, false);
    return this.#lock.run(async () => {
      const current = await this.read(name);
      if (!current || !hasOwner(current, owner)) return false;
      await this.#put({ ...current, keptAt: new Date().toISOString() });
      await rename(this.#file(name, false), this.#file(name, true));
      return true;
    });
  }

  /**
   * Claims a kept sandbox for a new session: a kept record of `project` in
   * `location` (with `image`: recorded as made from that image; with
   * `exclude`: none of those names). Returns the claimed record, now active
   * with `phase: "created"` and the new owner.
   */
  async claimKept(location: string, project: string, owner: { ownerLabel: string; sessionId: string }, options: { image?: string; exclude?: ReadonlySet<string> } = {}): Promise<LedgerRecord | undefined> {
    const { image, exclude } = options;
    const wanted = (entry: LedgerEntry) => {
      const r = entry.record;
      return entry.kept && r !== undefined && r.location === location && r.projectKey === project && (image === undefined || r.image === image) && !exclude?.has(r.name);
    };
    // Nothing to claim: no lock (and no ledger dir) needed.
    if (!(await this.entries()).some(wanted)) return undefined;
    return this.#lock.run(async () => {
      for (const entry of await this.entries()) {
        if (!wanted(entry)) continue;
        const r = entry.record!;
        const claimed: LedgerRecord = { ...r, ...owner, phase: "created", keep: true };
        delete claimed.keptAt;
        await this.#put(claimed, true);
        await rename(this.#file(r.name, true), this.#file(r.name, false));
        return claimed;
      }
      return undefined;
    });
  }

  /**
   * Claims a kept record for deletion: moves it to the active set with
   * `phase: "deleting"`, so the sweep retries a failed deletion and no
   * session reuses it. `false` when it is no longer kept.
   */
  async claimForDeletion(name: string): Promise<boolean> {
    this.#file(name, true);
    return this.#lock.run(async () => {
      const current = await this.read(name, true);
      if (!current) return false;
      const next: LedgerRecord = { ...current, phase: "deleting", keep: false };
      delete next.keptAt;
      await this.#put(next, true);
      await rename(this.#file(name, true), this.#file(name, false));
      return true;
    });
  }

  /** Every record file, active and kept. A missing directory is an empty ledger. */
  async entries(): Promise<LedgerEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: LedgerEntry[] = [];
    for (const file of names.sort()) {
      if (!file.startsWith(SANDBOX_PREFIX) || !file.endsWith(ACTIVE)) continue;
      const kept = file.endsWith(KEPT);
      const path = join(this.dir, file);
      try {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        const problem = recordProblem(raw);
        const expected = `${(raw as LedgerRecord)?.name}${kept ? KEPT : ACTIVE}`;
        if (problem) entries.push({ file: path, kept, problem });
        else if (expected !== file) entries.push({ file: path, kept, problem: "file name and record disagree" });
        else entries.push({ file: path, kept, record: raw as LedgerRecord });
      } catch (error) {
        entries.push({ file: path, kept, problem: `unreadable: ${(error as Error).message}` });
      }
    }
    return entries;
  }
}

/**
 * Liveness of the owner a record names (same rules as the client sweep):
 * `dead` when the boot differs, the PID is gone, or it has another start
 * time; `unknown` when anything cannot be read or the label is malformed.
 */
export function recordOwnerLiveness(record: Pick<LedgerRecord, "ownerLabel">, procRoot: string = DEFAULT_PROC_ROOT): OwnerLiveness {
  const owner = parseOwnerLabel(record.ownerLabel);
  return owner ? ownerLiveness(owner, procRoot) : "unknown";
}
