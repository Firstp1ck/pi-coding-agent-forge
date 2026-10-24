/**
 * Interprocess lock of one ledger directory: every Pi process of this machine
 * that shares the agent dir serialises its ledger transitions through it.
 *
 * The lock is a generation number. `.lock.<n>` (created by `link()` from a
 * fully written temp file, so it is never seen half written, and only one
 * process can create a given `n`) names its holder: PID, process start time,
 * and boot id. The holder of the highest generation holds the lock until it
 * creates `.lock.<n>.free`. A waiter takes generation `n + 1` when `n` is
 * free or its holder is provably gone (same boot, and the PID is gone or has
 * another start time). A holder that is alive, or whose liveness cannot be
 * judged, is never superseded: no file of a live holder is removed, renamed,
 * or rewritten, so stale-lock recovery cannot steal the lock. The new holder
 * removes the generations below its own.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROC_ROOT, ownerLiveness, readBootId, readProcessStartTime } from "../../cleanup/identity.ts";

const GENERATION = /^\.lock\.(\d{1,15})$/;
/** Largest lock file read (a holder record is about 150 bytes). */
const MAX_LOCK_BYTES = 4096;

export interface LedgerLockOptions {
  /** Where holders' liveness is read; default `/proc`. */
  procRoot?: string;
  /** How long one transition waits for a live holder before failing (ms); default 30 s. */
  timeoutMs?: number;
}

interface Holder {
  version: 1;
  pid: number;
  processStartTime: string;
  bootId: string;
  /** Random per acquisition, so two acquisitions of one process differ. */
  token: string;
}

type GenerationState = "free" | "stale" | "live" | "gone";

let selfIdentity: { processStartTime: string; bootId: string } | undefined;

/** This process's start time and boot id (read once). Unreadable parts stay empty, which no waiter can judge dead. */
function identity(): { processStartTime: string; bootId: string } {
  if (!selfIdentity) {
    let processStartTime: string | null | undefined;
    let bootId: string | undefined;
    try {
      processStartTime = readProcessStartTime(process.pid);
      bootId = readBootId();
    } catch {
      // Left empty: such a holder is judged "unknown", i.e. never stale.
    }
    selfIdentity = { processStartTime: processStartTime ?? "", bootId: bootId ?? "" };
  }
  return selfIdentity;
}

function parseHolder(text: string): Holder | undefined {
  try {
    const raw = JSON.parse(text) as Partial<Holder>;
    if (raw.version !== 1 || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return undefined;
    if (typeof raw.processStartTime !== "string" || typeof raw.bootId !== "string" || typeof raw.token !== "string") return undefined;
    return raw as Holder;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

export class LedgerLock {
  readonly dir: string;
  readonly #procRoot: string;
  readonly #timeoutMs: number;

  constructor(dir: string, options: LedgerLockOptions = {}) {
    this.dir = dir;
    this.#procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #file(generation: number): string {
    return join(this.dir, `.lock.${generation}`);
  }

  async #generations(): Promise<number[]> {
    const generations: number[] = [];
    for (const name of await readdir(this.dir)) {
      const match = GENERATION.exec(name);
      if (match) generations.push(Number(match[1]));
    }
    return generations;
  }

  /** Whether generation `n` may be superseded. */
  async #state(generation: number): Promise<{ state: GenerationState; holder?: Holder }> {
    try {
      await stat(`${this.#file(generation)}.free`);
      return { state: "free" };
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    let text: string;
    try {
      const handle = await open(this.#file(generation), "r");
      try {
        const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) return { state: "gone" };
      throw error;
    }
    const holder = text.length <= MAX_LOCK_BYTES ? parseHolder(text) : undefined;
    // An unreadable holder record is never judged stale: removing it could steal a live lock.
    if (!holder) return { state: "live" };
    // A holder that could not read its own identity cannot be judged either.
    if (!holder.processStartTime || !holder.bootId) return { state: "live", holder };
    return { state: ownerLiveness(holder, this.#procRoot) === "dead" ? "stale" : "live", holder };
  }

  /** Takes generation `n` when nobody else has; `false` when another process won it. */
  async #take(generation: number, holder: Holder): Promise<boolean> {
    const temp = join(this.dir, `.lock-tmp.${process.pid}.${holder.token}`);
    try {
      await writeFile(temp, `${JSON.stringify(holder)}\n`, { mode: 0o600, flag: "wx" });
      await link(temp, this.#file(generation));
      return true;
    } catch (error) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Waits for the lock; resolves to its release function. */
  async acquire(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const { processStartTime, bootId } = identity();
    const deadline = Date.now() + this.#timeoutMs;
    let waitedOn: Holder | undefined;
    for (;;) {
      const generations = await this.#generations();
      const top = generations.length ? Math.max(...generations) : 0;
      if (top > 0) {
        const { state, holder } = await this.#state(top);
        if (state === "gone") continue; // Removed by a newer holder: list again.
        if (state === "live") {
          waitedOn = holder;
          if (Date.now() >= deadline) {
            const who = waitedOn ? `process ${waitedOn.pid}` : "an unreadable lock record";
            throw new Error(`the cua sandbox ledger ${this.dir} is locked by ${who}; try again, or remove ${this.#file(top)} if no Pi process is running`);
          }
          await sleep(5 + Math.floor(Math.random() * 20));
          continue;
        }
      }
      const next = top + 1;
      const holder: Holder = { version: 1, pid: process.pid, processStartTime, bootId, token: randomBytes(8).toString("hex") };
      if (!(await this.#take(next, holder))) continue;
      // A generation removed by a newer holder can be taken again: only the highest one holds the lock.
      if ((await this.#generations()).some((g) => g > next)) {
        await rm(this.#file(next), { force: true });
        continue;
      }
      for (const old of generations) {
        if (old >= next) continue;
        await rm(`${this.#file(old)}.free`, { force: true });
        await rm(this.#file(old), { force: true });
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await writeFile(`${this.#file(next)}.free`, "", { mode: 0o600, flag: "wx" }).catch((error) => {
          if (!isCode(error, "EEXIST")) throw error;
        });
      };
    }
  }

  /** Runs `fn` while holding the lock. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}
