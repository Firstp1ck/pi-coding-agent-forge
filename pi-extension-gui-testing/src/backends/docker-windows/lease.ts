/**
 * One `docker-windows` session per machine, across every Pi process that
 * shares the agent dir. All session containers boot the same base volume,
 * and dockurr keeps small state files in it, so two sessions must never run
 * at once.
 *
 * Admission is atomic: under an interprocess lock (`LedgerLock`, the cua
 * ledger's lock) a starting session reads the lease, recovers a stale one,
 * runs the caller's checks (other session containers, the install), and
 * writes its own lease, which names its owner (the Pi process label) and its
 * container. The lease stays for the session's lifetime: a second start sees
 * it and is refused, even while the first container is not created yet.
 *
 * A lease is stale when its owner process is gone (same rule as container
 * owner labels), or when it is this process's own and no session of this
 * process holds it any more (a release that could not remove the file). A
 * lease whose owner cannot be judged, or that cannot be read, is never taken
 * over.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROC_ROOT, ownerLiveness } from "../../cleanup/identity.ts";
import { parseOwnerLabel, type OwnerLiveness } from "../../owner.ts";
import { LedgerLock } from "../cua/ledger-lock.ts";

/** The lease of the running (or starting) session. */
export interface SessionLease {
  version: 1;
  /** Owner label of the Pi process that holds it (`<clientId>:<pid>:<startTime>:<bootId>`). */
  owner: string;
  session: string;
  container: string;
  /** Random per admission: tells two leases of one process apart. */
  token: string;
  createdAt: string;
}

/** Tokens of the leases sessions of this process hold right now. */
const held = new Set<string>();

export const LEASE_FILE = "session-lease.json";
export const LEASE_LOCK_DIR = "session-lock";

export type LeaseRead = { state: "none" } | { state: "invalid"; problem: string } | { state: "ok"; lease: SessionLease };

function parseLease(text: string): SessionLease | undefined {
  try {
    const raw = JSON.parse(text) as Partial<SessionLease>;
    if (raw.version !== 1) return undefined;
    for (const key of ["owner", "session", "container", "token", "createdAt"] as const) if (typeof raw[key] !== "string" || raw[key]!.length === 0 || raw[key]!.length > 512) return undefined;
    // A stale lease's container is removed: only ever a session container name of this backend.
    if (!/^pi-gui-testing-win-[A-Za-z0-9_.-]{1,128}$/.test(raw.container!)) return undefined;
    return raw as SessionLease;
  } catch {
    return undefined;
  }
}

/** A held lease; {@link release} gives it up (idempotent). */
export interface LeaseHandle {
  readonly lease: SessionLease;
  release(): Promise<void>;
}

export interface SessionLeasesOptions {
  /** Where owner liveness is read (the backend's proc root). */
  procRoot?: string;
  /** How long an admission waits for another one (ms); default 30 s. */
  lockTimeoutMs?: number;
}

export class SessionLeases {
  readonly file: string;
  readonly #dir: string;
  readonly #lock: LedgerLock;
  readonly #procRoot: string;

  constructor(dir: string, options: SessionLeasesOptions = {}) {
    this.#dir = dir;
    this.file = join(dir, LEASE_FILE);
    // The lock judges its own holders by this process's real identity, never a test proc root.
    this.#lock = new LedgerLock(join(dir, LEASE_LOCK_DIR), { label: "the docker-windows session lock", ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}) });
    this.#procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  }

  async read(): Promise<LeaseRead> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" };
      return { state: "invalid", problem: `cannot be read (${(error as Error).message})` };
    }
    const lease = text.length <= 4096 ? parseLease(text) : undefined;
    return lease ? { state: "ok", lease } : { state: "invalid", problem: "is not a valid lease" };
  }

  /** `dead` or `abandoned` leases may be taken over; `alive` and `unknown` ones never. */
  judge(lease: SessionLease, self: string): OwnerLiveness | "abandoned" {
    if (lease.owner === self && !held.has(lease.token)) return "abandoned";
    const owner = parseOwnerLabel(lease.owner);
    return owner ? ownerLiveness(owner, this.#procRoot) : "unknown";
  }

  /**
   * Admits one session: under the lock, refuses while another live (or
   * unjudgeable) lease exists, runs `check` with the stale lease being
   * replaced (if any), then writes this session's lease.
   *
   * @throws Error naming the session that holds the machine, or what `check` threw. Nothing is written then.
   */
  async acquire(want: { owner: string; session: string; container: string }, check: (stale: SessionLease | undefined) => Promise<void>): Promise<LeaseHandle> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const lease = await this.#lock.run(async () => {
      const read = await this.read();
      let stale: SessionLease | undefined;
      if (read.state === "invalid") {
        throw new Error(`docker-windows: the session lease ${this.file} ${read.problem}; if no Pi process runs a docker-windows session, delete that file and start again`);
      }
      if (read.state === "ok") {
        const state = this.judge(read.lease, want.owner);
        if (state === "alive") {
          throw new Error(`docker-windows runs one session at a time and session ${read.lease.session} (container ${read.lease.container}) is still running or starting; stop it with gui_stop first`);
        }
        if (state === "unknown") {
          throw new Error(`docker-windows runs one session at a time and the owner of session ${read.lease.session} (container ${read.lease.container}) cannot be judged; run /gui-cleanup docker-windows, or delete ${this.file} if no Pi process uses it`);
        }
        stale = read.lease;
      }
      await check(stale);
      const next: SessionLease = { version: 1, ...want, token: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
      const temp = join(this.#dir, `.${LEASE_FILE}.${process.pid}.${next.token}.tmp`);
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      try {
        await rename(temp, this.file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      held.add(next.token);
      return next;
    });
    let released = false;
    return {
      lease,
      release: async () => {
        if (released) return;
        released = true;
        // Not held any more from here on: a lease file a failed removal leaves is this process's abandoned one.
        held.delete(lease.token);
        await this.#lock.run(async () => {
          const read = await this.read();
          if (read.state === "ok" && read.lease.token === lease.token) await rm(this.file, { force: true });
        });
      },
    };
  }
}
