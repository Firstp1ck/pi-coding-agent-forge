/**
 * Local record of every sandbox this machine creates (spec §7a). A cloud
 * account is shared by every machine of its owner, so a sandbox is removed by
 * a sweep only when this machine's ledger proves that this client created it
 * and that its owner process is gone. Sandboxes with the package's name
 * prefix but no record here are reported, never deleted.
 *
 * Layout: `<dir>/<name>.json` for a sandbox in use or awaiting deletion,
 * `<dir>/<name>.kept.json` for one kept by `keepSandbox`. A record is written
 * (0600) before `sandbox create` runs and removed only after the deletion is
 * confirmed, so a crash at any point leaves a record the next sweep completes.
 *
 * Every transition writes the new record to a temp file and renames it onto
 * its destination with a generation above the old one (the single commit
 * point), and only then removes the copy it replaced. A crash between the two,
 * or a failure of that removal, leaves both copies; the higher generation is
 * the current one, readers ignore the stale copy, the next transition removes
 * it, and the orphan audit reports it meanwhile. Removing that copy is garbage
 * collection: its failure never fails a committed transition. `deleting` is
 * terminal: such a record (in either set, also an older version's crash
 * residue in the kept set) is never kept, claimed, or reused again, only
 * deleted and removed.
 *
 * Every transition (write, update, keep, claim, delete) runs under the
 * ledger's interprocess lock ({@link LedgerLock}) and re-reads the record
 * inside it: a transition that names an expected state (session id, and
 * optionally owner label, `keptAt`, phase, and generation) acts only when the
 * record still has it (compare-and-swap). A sweep or a session working from
 * an older read can therefore never move, claim, or delete a record another
 * process has changed since. Reads (`read`, `entries`) take no lock.
 *
 * A record is unknown when any of its copies exists but cannot be read or
 * validated: which copy is current, and so who owns the sandbox, cannot be
 * told. Such a record fails closed. It is never claimed, kept, or replaced,
 * transitions that would change it throw ({@link UnreadableRecordError}),
 * `entries()` lists every copy of it as a problem (never as a record), and the
 * audit, sweep, and reset only report it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { readdir, readFile, rm } from "node:fs/promises";
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
  /** `deleting` is terminal: such a sandbox is never kept, claimed, or reused again, only deleted. */
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
  /**
   * Raised by every committed transition (absent, meaning 0, in records of
   * older versions). Of two copies of a record, the higher generation is
   * the current one, and a transition that names the generation it read acts
   * only while the record still has it.
   */
  generation?: number;
}

/** The state a transition expects the record to still have; every given field must match. */
export interface ExpectedOwner {
  sessionId: string;
  ownerLabel?: string;
  /** For kept records: the `keptAt` that was read. */
  keptAt?: string;
  phase?: LedgerPhase;
  generation?: number;
}

/** The full state of `record` as read, for a transition that must act only while nothing changed since. */
export function expectedState(record: LedgerRecord): ExpectedOwner {
  return {
    sessionId: record.sessionId,
    ownerLabel: record.ownerLabel,
    phase: record.phase,
    generation: record.generation ?? 0,
    ...(record.keptAt !== undefined ? { keptAt: record.keptAt } : {}),
  };
}

function matches(record: LedgerRecord, expect: ExpectedOwner | undefined): boolean {
  if (!expect) return true;
  return (
    record.sessionId === expect.sessionId &&
    (expect.ownerLabel === undefined || record.ownerLabel === expect.ownerLabel) &&
    (expect.keptAt === undefined || record.keptAt === expect.keptAt) &&
    (expect.phase === undefined || record.phase === expect.phase) &&
    (expect.generation === undefined || (record.generation ?? 0) === expect.generation)
  );
}

/** Default ledger directory: `<agent dir>/gui/cua-sandboxes`. */
export function defaultLedgerDir(): string {
  return join(dirname(globalConfigPath()), "cua-sandboxes");
}

const ACTIVE = ".json";
const KEPT = ".kept.json";

/** One copy of a record as read: the record, or why it cannot be used. */
type Copy = { record: LedgerRecord; problem?: undefined } | { problem: string; record?: undefined };

/** The copy in `text` of the file of sandbox `name`. */
function parseCopy(text: string, name: string): Copy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { problem: `unreadable: ${(error as Error).message}` };
  }
  const problem = recordProblem(raw);
  if (problem) return { problem };
  if ((raw as LedgerRecord).name !== name) return { problem: "file name and record disagree" };
  return { record: raw as LedgerRecord };
}

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
  if (r.generation !== undefined && (!Number.isSafeInteger(r.generation) || (r.generation as number) < 0)) return "bad generation";
  if (!(r.name as string).startsWith(SANDBOX_PREFIX) || r.ref !== `${r.location}:${r.name}`) return "name and ref disagree";
  return undefined;
}

/**
 * Of the active and the kept copy of one record, the current one: the higher
 * generation; on a tie (only by hand), a `deleting` copy, else the active one.
 * Two copies exist only after a crash between a transition's commit and the
 * removal of the copy it replaced.
 */
function current(active: LedgerRecord | undefined, kept: LedgerRecord | undefined): { record: LedgerRecord; kept: boolean } | undefined {
  if (!active || !kept) return active ? { record: active, kept: false } : kept ? { record: kept, kept: true } : undefined;
  const a = active.generation ?? 0;
  const k = kept.generation ?? 0;
  if (k > a || (k === a && kept.phase === "deleting" && active.phase !== "deleting")) return { record: kept, kept: true };
  return { record: active, kept: false };
}

interface Loaded {
  /** The current copy. */
  current?: { record: LedgerRecord; kept: boolean };
  active?: LedgerRecord;
  kept?: LedgerRecord;
  /** Set when a copy exists but cannot be read or validated: the record is unknown and is not changed. */
  unknown?: string;
}

export interface LedgerEntry {
  record?: LedgerRecord;
  /**
   * Set when the file could not be read or validated, or when the other copy
   * of its record could not: such entries are reported, never acted on.
   */
  problem?: string;
  /** Sandbox name (from the file name). */
  name: string;
  file: string;
  kept: boolean;
}

/** Detail of the readable copy of a record whose other copy cannot be read. */
const OTHER_COPY_UNREADABLE = "its other copy cannot be read, so which copy is current is unknown";

/** A transition refused because a copy of the record cannot be read or validated (the record is unknown). */
export class UnreadableRecordError extends Error {
  constructor(name: string, problem: string) {
    super(`the ledger record of sandbox ${name} cannot be read (${problem}), so it is not changed; /gui-doctor lists it with the manual remedy`);
    this.name = "UnreadableRecordError";
  }
}

/** A record whose sandbox is to be deleted (wherever its file is): never kept, claimed, or reused. */
export function pendingDeletion(entry: LedgerEntry): boolean {
  return entry.record?.phase === "deleting";
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

  /** One copy; `undefined` only when its file does not exist. */
  async #readCopy(name: string, kept: boolean): Promise<Copy | undefined> {
    let text: string;
    try {
      text = await readFile(this.#file(name, kept), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return { problem: `unreadable: ${(error as Error).message}` };
    }
    return parseCopy(text, name);
  }

  async #load(name: string): Promise<Loaded> {
    const [activeCopy, keptCopy] = await Promise.all([this.#readCopy(name, false), this.#readCopy(name, true)]);
    // Fail closed: a copy that exists but cannot be used may be the current one.
    const problem = activeCopy?.problem ?? keptCopy?.problem;
    if (problem !== undefined) return { unknown: `${activeCopy?.problem !== undefined ? `${name}${ACTIVE}` : `${name}${KEPT}`}: ${problem}` };
    const active = activeCopy?.record;
    const kept = keptCopy?.record;
    const now = current(active, kept);
    return { ...(now ? { current: now } : {}), ...(active ? { active } : {}), ...(kept ? { kept } : {}) };
  }

  /** `loaded`, unless its record is unknown: then the transition throws. */
  #known(name: string, loaded: Loaded): Loaded {
    if (loaded.unknown !== undefined) throw new UnreadableRecordError(name, loaded.unknown);
    return loaded;
  }

  /**
   * Commits `record` as the record of its sandbox in the active or kept set:
   * one temp-file write plus `rename` onto the destination, with a generation
   * above both copies, is the commit point; only then is the copy it replaces
   * removed. A crash at any step leaves either the old record or the new one
   * as the current copy, never a half-made transition.
   */
  async #commit(record: LedgerRecord, kept: boolean, loaded: Loaded): Promise<LedgerRecord> {
    const next: LedgerRecord = { ...record, generation: Math.max(loaded.active?.generation ?? 0, loaded.kept?.generation ?? 0) + 1 };
    await writeJsonAtomic(this.#file(record.name, kept), next, { mode: 0o600, dirMode: 0o700 });
    // Committed. The replaced copy is now stale (a lower generation): removing it is best-effort garbage
    // collection, so a failure here must not make the caller believe the transition did not happen.
    // A copy left behind is ignored by readers, removed by the next transition, and reported by the audit.
    if (kept ? loaded.active : loaded.kept) await rm(this.#file(record.name, !kept), { force: true }).catch(() => undefined);
    return next;
  }

  /**
   * Writes (or replaces) the record as active. Resolves before the caller
   * creates or deletes anything. Refuses to replace a record pending deletion.
   */
  async write(record: LedgerRecord): Promise<void> {
    this.#file(record.name, false);
    await this.#lock.run(async () => {
      const loaded = this.#known(record.name, await this.#load(record.name));
      if (loaded.current?.record.phase === "deleting") throw new Error(`sandbox ${record.name} is pending deletion; its record is not replaced`);
      await this.#commit(record, false, loaded);
    });
  }

  /**
   * Changes the active record; only while it still has `expect`'s state, when
   * given. A record pending deletion takes no change other than `deleting`.
   * Throws for an unknown record.
   */
  async update(name: string, change: Partial<LedgerRecord>, expect?: ExpectedOwner): Promise<LedgerRecord | undefined> {
    this.#file(name, false);
    const { generation: _ignored, name: _name, ...wanted } = change;
    return this.#lock.run(async () => {
      const loaded = this.#known(name, await this.#load(name));
      const now = loaded.current;
      if (!now || now.kept || !matches(now.record, expect)) return undefined;
      const next = { ...now.record, ...wanted };
      const changed = Object.keys(wanted).some((key) => (next as unknown as Record<string, unknown>)[key] !== (now.record as unknown as Record<string, unknown>)[key]);
      if (!changed) return now.record;
      if (now.record.phase === "deleting") return undefined;
      return this.#commit(next, false, loaded);
    });
  }

  /** The current record of `name` when it is in the active (or, with `kept`, the kept) set; none when it is unknown. Takes no lock. */
  async read(name: string, kept = false): Promise<LedgerRecord | undefined> {
    const now = (await this.#load(name)).current;
    return now && now.kept === kept ? now.record : undefined;
  }

  /**
   * Removes a record once the sandbox is confirmed gone; with `expect`, only
   * while the current record is in that set and still has that state. `true`
   * when no such record is left. Throws for an unknown record, which stays.
   */
  async remove(name: string, kept = false, expect?: ExpectedOwner): Promise<boolean> {
    this.#file(name, kept);
    return this.#lock.run(async () => {
      const loaded = this.#known(name, await this.#load(name));
      const now = loaded.current;
      if (expect && now && (now.kept !== kept || !matches(now.record, expect))) return false;
      // A stale copy in the other set goes first, while the current record still outranks it: removing the
      // current record first would let a crash in between make the stale (older) generation current again.
      if (now?.kept === kept && (kept ? loaded.active : loaded.kept)) await rm(this.#file(name, !kept), { force: true });
      await rm(this.#file(name, kept), { force: true });
      return true;
    });
  }

  /**
   * Moves the active record to the kept set (the sandbox stays), only while
   * it still belongs to `expect` (a session id, or the full state a sweep
   * read) and is not pending deletion. `true` when it moved. Throws for an
   * unknown record.
   */
  /**
   * Whether the sandbox still has a record (active or kept), read as one step under the lock, so a
   * concurrent move between the two copies is never seen as absence. An unknown record counts as present.
   */
  async recorded(name: string): Promise<boolean> {
    this.#file(name, false);
    return this.#lock.run(async () => {
      const loaded = await this.#load(name);
      return loaded.unknown !== undefined || loaded.current !== undefined;
    });
  }

  async markKept(name: string, expect: string | ExpectedOwner): Promise<boolean> {
    const owner = typeof expect === "string" ? { sessionId: expect } : expect;
    if (typeof owner?.sessionId !== "string") throw new Error("markKept needs the session id of the record it keeps");
    this.#file(name, false);
    return this.#lock.run(async () => {
      const loaded = this.#known(name, await this.#load(name));
      const now = loaded.current;
      if (!now || now.kept || now.record.phase === "deleting" || !matches(now.record, owner)) return false;
      await this.#commit({ ...now.record, keptAt: new Date().toISOString() }, true, loaded);
      return true;
    });
  }

  /**
   * Claims a kept sandbox for a new session: a kept record of `project` in
   * `location` (with `image`: recorded as made from that image; with
   * `exclude`: none of those names), never one pending deletion or unknown. Returns the
   * claimed record, now active with `phase: "created"` and the new owner.
   */
  async claimKept(location: string, project: string, owner: { ownerLabel: string; sessionId: string }, options: { image?: string; exclude?: ReadonlySet<string> } = {}): Promise<LedgerRecord | undefined> {
    const { image, exclude } = options;
    const claimable = (r: LedgerRecord) => r.phase !== "deleting" && r.location === location && r.projectKey === project && (image === undefined || r.image === image) && !exclude?.has(r.name);
    const candidates = (await this.entries()).filter((e) => e.kept && e.record && claimable(e.record)).map((e) => e.record!.name);
    // Nothing to claim: no lock (and no ledger dir) needed.
    if (candidates.length === 0) return undefined;
    return this.#lock.run(async () => {
      for (const name of candidates) {
        const loaded = await this.#load(name);
        const now = loaded.current;
        // An unknown record has no current copy: its sandbox may be another session's.
        if (!now?.kept || !claimable(now.record)) continue;
        const claimed: LedgerRecord = { ...now.record, ...owner, phase: "created", keep: true };
        delete claimed.keptAt;
        return this.#commit(claimed, false, loaded);
      }
      return undefined;
    });
  }

  /**
   * Claims a kept record for deletion: commits it to the active set with
   * `phase: "deleting"` (terminal), so no session reuses it and the sweep or
   * the next reset retries a failed deletion. Returns the committed record
   * (pass it to {@link expectedState} for the removal), or `undefined` when it
   * is no longer kept (or is unknown).
   */
  async claimForDeletion(name: string): Promise<LedgerRecord | undefined> {
    this.#file(name, true);
    return this.#lock.run(async () => {
      const loaded = await this.#load(name);
      if (!loaded.current?.kept) return undefined;
      const next: LedgerRecord = { ...loaded.current.record, phase: "deleting", keep: false };
      delete next.keptAt;
      return this.#commit(next, false, loaded);
    });
  }

  /**
   * Every record, active and kept: one entry per sandbox (its current copy;
   * a stale copy left by a crash is skipped), plus every file that cannot be
   * read or validated. Every copy of an unknown record (one copy cannot be
   * read or validated) is a problem entry, never a record. A missing
   * directory is an empty ledger.
   */
  async entries(): Promise<LedgerEntry[]> {
    return (await this.#listed()).entries;
  }

  /**
   * Files of stale copies: a record's other copy, superseded by its current
   * one (a higher generation) and ignored by readers. One is left only when a
   * transition was interrupted, or failed to remove it, after its commit; the
   * sandbox's next transition removes it.
   */
  async staleCopies(): Promise<string[]> {
    return (await this.#listed()).stale;
  }

  async #listed(): Promise<{ entries: LedgerEntry[]; stale: string[] }> {
    // A transition may replace a file between the listing and its read; list again then.
    for (let attempt = 0; ; attempt++) {
      const listed = await this.#list(attempt < 4);
      if (listed) return listed;
    }
  }

  async #list(retryOnVanished: boolean): Promise<{ entries: LedgerEntry[]; stale: string[] } | undefined> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], stale: [] };
      throw error;
    }
    const entries: LedgerEntry[] = [];
    const byName = new Map<string, { active?: LedgerEntry; kept?: LedgerEntry }>();
    for (const file of names.sort()) {
      if (!file.startsWith(SANDBOX_PREFIX) || !file.endsWith(ACTIVE)) continue;
      const kept = file.endsWith(KEPT);
      const name = file.slice(0, -(kept ? KEPT : ACTIVE).length);
      const path = join(this.dir, file);
      let copy: Copy;
      try {
        copy = parseCopy(await readFile(path, "utf8"), name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (retryOnVanished) return undefined;
          continue;
        }
        copy = { problem: `unreadable: ${(error as Error).message}` };
      }
      const pair = byName.get(name) ?? {};
      pair[kept ? "kept" : "active"] = { file: path, kept, name, ...copy };
      byName.set(name, pair);
    }
    const stale: string[] = [];
    for (const pair of byName.values()) {
      const copies = [pair.active, pair.kept].filter((c): c is LedgerEntry => c !== undefined);
      if (copies.some((c) => c.problem !== undefined)) {
        // Unknown: the unusable copy may be the current one, so no copy is acted on.
        for (const c of copies) entries.push(c.problem !== undefined ? c : { file: c.file, kept: c.kept, name: c.name, problem: OTHER_COPY_UNREADABLE });
        continue;
      }
      const now = current(pair.active?.record, pair.kept?.record);
      if (!now) continue;
      entries.push((now.kept ? pair.kept : pair.active)!);
      const other = now.kept ? pair.active : pair.kept;
      if (other) stale.push(other.file);
    }
    return { entries: entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)), stale: stale.sort() };
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
