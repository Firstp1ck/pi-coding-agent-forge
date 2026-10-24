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
 * sweep completes. Claiming a kept sandbox is a `rename` of its kept record,
 * which only one process can win.
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

export class SandboxLedger {
  readonly dir: string;

  constructor(dir: string = defaultLedgerDir()) {
    this.dir = dir;
  }

  #file(name: string, kept: boolean): string {
    if (!name.startsWith(SANDBOX_PREFIX) || name.includes("/") || name.includes("\0")) throw new Error(`invalid sandbox name ${JSON.stringify(name)}`);
    return join(this.dir, `${name}${kept ? KEPT : ACTIVE}`);
  }

  /** Writes (or replaces) the active record. Resolves before the caller creates or deletes anything. */
  async write(record: LedgerRecord): Promise<void> {
    await writeJsonAtomic(this.#file(record.name, false), record, { mode: 0o600, dirMode: 0o700 });
  }

  async update(name: string, change: Partial<LedgerRecord>): Promise<LedgerRecord | undefined> {
    const current = await this.read(name);
    if (!current) return undefined;
    const next = { ...current, ...change };
    await this.write(next);
    return next;
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

  /** Removes the active record once the sandbox is confirmed gone. */
  async remove(name: string, kept = false): Promise<void> {
    await rm(this.#file(name, kept), { force: true });
  }

  /** Moves the active record to the kept set (the sandbox stays). */
  async markKept(name: string): Promise<void> {
    const current = await this.read(name);
    if (!current) return;
    await writeJsonAtomic(this.#file(name, true), { ...current, keptAt: new Date().toISOString() }, { mode: 0o600, dirMode: 0o700 });
    await this.remove(name);
  }

  /**
   * Claims a kept sandbox for a new session: the kept record of `project` in
   * `location` whose rename succeeds first. Returns the claimed record, now
   * active with `phase: "created"` and the new owner.
   */
  async claimKept(location: string, project: string, owner: { ownerLabel: string; sessionId: string }): Promise<LedgerRecord | undefined> {
    for (const entry of await this.entries()) {
      const r = entry.record;
      if (!entry.kept || !r || r.location !== location || r.projectKey !== project) continue;
      try {
        await rename(entry.file, this.#file(r.name, false));
      } catch {
        continue; // Another session won it, or it is gone.
      }
      const claimed: LedgerRecord = { ...r, ...owner, phase: "created", keep: true };
      delete claimed.keptAt;
      await this.write(claimed);
      return claimed;
    }
    return undefined;
  }

  /**
   * Claims a kept record for deletion: renames it to the active set with
   * `phase: "deleting"`, so the sweep retries a failed deletion and no
   * session reuses it. `false` when another process claimed it first.
   */
  async claimForDeletion(name: string): Promise<boolean> {
    try {
      await rename(this.#file(name, true), this.#file(name, false));
    } catch {
      return false;
    }
    await this.update(name, { phase: "deleting", keep: false });
    return true;
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
