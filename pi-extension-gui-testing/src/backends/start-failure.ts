/**
 * A session start that failed and whose teardown left something behind keeps
 * its session handle on the thrown error, so the runtime can track the
 * leftovers (with the frozen endpoint, `owner.json`, the temp dir, and the
 * exit cleanup) and retry them instead of forgetting them.
 */
import type { Session } from "../backend.ts";
import type { Leftover } from "../protocol.ts";

const START_LEFTOVERS = Symbol.for("pi-gui-testing.startLeftovers");

export interface StartLeftovers {
  /** The half-started session; its `stop()` retries the cleanup. */
  session: Session;
  leftovers: Leftover[];
}

/** Records on `error` that stopping `session` after a failed start left `leftovers`. Returns `error`. */
export function attachStartLeftovers<E>(error: E, session: Session, leftovers: Leftover[]): E {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, START_LEFTOVERS, { value: { session, leftovers } satisfies StartLeftovers, configurable: true, enumerable: false });
  }
  return error;
}

/** The leftovers attached by {@link attachStartLeftovers}, if any. */
export function startLeftovers(error: unknown): StartLeftovers | undefined {
  if (error === null || typeof error !== "object") return undefined;
  return (error as { [START_LEFTOVERS]?: StartLeftovers })[START_LEFTOVERS];
}

/**
 * Stops `session` after a failed start (a retry when an earlier attempt failed).
 * Clean → `[]` and any earlier attachment is cleared. Otherwise attaches the
 * leftovers to `error` (a stop that throws counts as a leftover) and returns them.
 */
export async function stopAfterFailedStart(session: Session, error: unknown): Promise<Leftover[]> {
  const leftovers = await session.stop().catch((e: Error): Leftover[] => [{ kind: "session", id: session.id, detail: `stop failed: ${e?.message ?? String(e)}` }]);
  if (leftovers.length > 0) attachStartLeftovers(error, session, leftovers);
  else if (error !== null && typeof error === "object") delete (error as { [START_LEFTOVERS]?: StartLeftovers })[START_LEFTOVERS];
  return leftovers;
}
