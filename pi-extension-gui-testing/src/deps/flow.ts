/**
 * The dependency-cache step of a session start (spec §4.8), shared by the
 * backends that run `setup` through the helper:
 *
 * - **hit**: the entry for the current key is verified, sent, and unpacked
 *   into the session's deps dir; `setup` is skipped;
 * - **miss**: `setup` runs as before; on success the helper packs its deps dir,
 *   the client pulls and verifies it, and stores it (then evicts LRU entries).
 *
 * Only the deps dir is cached. When `setup` changed the (writable) workspace,
 * a later hit could not reproduce that, so such a run is never stored. Cache
 * problems never fail a start: they fall back to running `setup` and are
 * named in the report. Only a dead session or a cancelled start propagates.
 */
import { randomBytes } from "node:crypto";
import { SessionError, type DepsCacheReport } from "../backend.ts";
import type { ResolvedConfig } from "../config/types.ts";
import { computeDepsKey, DepsKeyError } from "./key.ts";
import { DEFAULT_DEPS_CACHE_MAX_BYTES, DepsCache, projectHash, type CacheEntryRef } from "./store.ts";
import { pullArchive, pushArchive, type DepsSession } from "./transfer.ts";

/** Bound for packing or unpacking a deps dir in the helper. */
export const DEPS_PACK_TIMEOUT_MS = 10 * 60_000;
/** Unpacked size allowed for an archive of `n` bytes (gzip of installed packages rarely exceeds 1:8). */
export const UNPACK_RATIO = 16;
export const MAX_UNPACK_ENTRIES = 2_000_000;

/** Codes after which the session cannot go on, so the start fails instead of falling back to `setup`. */
const FATAL_CODES = new Set(["CLOSED", "CANCELLED", "BAD_RESPONSE", "PROTOCOL_ERROR"]);

export interface DepsCacheSettings {
  enabled: boolean;
  maxBytes: number;
}

/** The resolved `depsCache` personal setting, with defaults. */
export function depsCacheSettings(config: Pick<ResolvedConfig, "depsCache">): DepsCacheSettings {
  return { enabled: config.depsCache?.enabled ?? true, maxBytes: config.depsCache?.maxBytes ?? DEFAULT_DEPS_CACHE_MAX_BYTES };
}

/** The cache for one session start, or `undefined` when `depsCache.enabled` is false. `root` overrides the default location (tests). */
export function depsCacheFor(config: Pick<ResolvedConfig, "depsCache">, root?: string): DepsCache | undefined {
  const settings = depsCacheSettings(config);
  if (!settings.enabled) return undefined;
  return new DepsCache({ maxBytes: settings.maxBytes, ...(root ? { root } : {}) });
}

export interface DepsFlowOptions {
  session: DepsSession;
  /** `undefined` when the cache is off for this start. */
  cache: DepsCache | undefined;
  projectRoot: string;
  config: ResolvedConfig;
  backend: string;
  /** What the dependencies are built against, e.g. `image 0.1.0` or `helper 0.1.0`. */
  base: string;
  /** The workspace as the helper sees it; `writable` enables the "setup changed the workspace" check. */
  workspace: { path: string; writable: boolean };
  /** Runs the `setup` commands (throws `SETUP_FAILED` as before). */
  runSetup(): Promise<void>;
  onStatus?(text: string): void;
  signal: AbortSignal;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function fatal(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof SessionError && FATAL_CODES.has(error.code);
}

function reason(error: unknown): string {
  const text = (error as Error)?.message ?? String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Shell-quoted for `sh -c` (single quotes). */
function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Runs `setup` with the cache. Returns `undefined` when there is no `setup` (nothing to cache). */
export async function runSetupWithCache(o: DepsFlowOptions): Promise<DepsCacheReport | undefined> {
  const shared = o.config.shared;
  const setup = shared.setup ?? [];
  if (setup.length === 0) return undefined;
  if (!o.cache) {
    await o.runSetup();
    return { state: "off", detail: "off (depsCache.enabled is false); setup ran" };
  }
  if (!(o.session.capabilities ?? []).includes("deps")) {
    await o.runSetup();
    return { state: "off", detail: "not available in this session (the helper has no deps dir); setup ran" };
  }
  const cache = o.cache;
  const notes: string[] = [];
  let ref: CacheEntryRef | undefined;
  let short: string | undefined;
  try {
    const { key } = await computeDepsKey({
      projectRoot: o.projectRoot,
      ...(shared.deps?.keyFiles ? { keyFiles: shared.deps.keyFiles } : {}),
      setup,
      env: shared.deps?.env ?? {},
      backend: o.backend,
      base: o.base,
      targetOs: "linux",
      arch: o.session.arch,
      ...(o.session.platform ? { platform: o.session.platform } : {}),
    });
    short = key.slice(0, 12);
    ref = cache.entry(await projectHash(o.projectRoot), "linux", o.session.arch, key);
  } catch (error) {
    if (!(error instanceof DepsKeyError) && !(error instanceof Error)) throw error;
    notes.push(`not used: ${reason(error)}`);
  }

  if (ref) {
    const found = await cache.lookup(ref).catch((error: unknown) => ({ miss: true as const, discarded: `lookup failed (${reason(error)})` }));
    if ("hit" in found) {
      try {
        o.onStatus?.(`restoring cached dependencies (${mb(found.hit.size)})`);
        const unpacked = await pushArchive(
          o.session,
          found.hit,
          { maxUnpackedBytes: Math.max(found.hit.size * UNPACK_RATIO, 64 * 1024 ** 2), maxEntries: MAX_UNPACK_ENTRIES },
          { signal: o.signal, onProgress: (done, total) => o.onStatus?.(`restoring cached dependencies (${mb(done)} of ${mb(total)})`) },
        );
        await cache.touch(ref);
        return { state: "hit", key: short!, detail: `hit: restored ${unpacked.entries} entries (${mb(unpacked.bytes)}) from the cache; setup skipped (key ${short})` };
      } catch (error) {
        if (fatal(error, o.signal)) throw error;
        if (error instanceof SessionError && error.code === "ARCHIVE_REJECTED") {
          await cache.discard(ref).catch(() => undefined);
          notes.push(`the cached entry was rejected by the helper (${reason(error)}) and removed`);
        } else {
          notes.push(`restoring the cached entry failed (${reason(error)})`);
        }
      }
    } else if (found.discarded) {
      notes.push(`the cached entry was corrupt (${found.discarded})`);
    }
  }

  // Miss: run setup, then store the deps dir.
  const marker = `.pi-gui-setup-marker-${randomBytes(6).toString("hex")}`;
  // The 1 s pause after creating it keeps coarse file-system timestamps from hiding a change.
  const markerPath = `"\${TMPDIR:-/tmp}"/${marker}`;
  let watched = false;
  if (ref && o.workspace.writable) {
    const placed = await o.session.request("exec", { cmd: `: > ${markerPath} && sleep 1`, cwd: "/", env: {}, timeoutMs: 30_000 }, { signal: o.signal, timeoutMs: 60_000 }).catch((error: unknown) => {
      if (fatal(error, o.signal)) throw error;
      return undefined;
    });
    watched = placed?.exitCode === 0;
    if (!watched) notes.push("the workspace change check could not start, so this run is not stored");
  }
  await o.runSetup();
  const missed = (stored: boolean, extra?: string): DepsCacheReport => ({
    state: "miss",
    ...(short ? { key: short } : {}),
    stored,
    detail: ["miss: setup ran", ...notes, ...(extra ? [extra] : [])].join("; "),
  });
  if (!ref || (o.workspace.writable && !watched)) return missed(false);

  if (o.workspace.writable) {
    const check = `m=${markerPath}; [ -e "$m" ] || exit 3; out=$(find ${quote(o.workspace.path)} -xdev -cnewer "$m" -print -quit) || exit 2; rm -f "$m"; [ -z "$out" ]`;
    const changed = await o.session.request("exec", { cmd: check, cwd: "/", env: {}, timeoutMs: 120_000 }, { signal: o.signal, timeoutMs: 150_000 }).catch((error: unknown) => {
      if (fatal(error, o.signal)) throw error;
      return { exitCode: -1 };
    });
    if (changed.exitCode === 1) return missed(false, "not stored: setup changed the workspace, and only the deps dir is cached");
    if (changed.exitCode !== 0) return missed(false, `not stored: the workspace change check failed (exit ${changed.exitCode})`);
  }

  let packed;
  try {
    o.onStatus?.("packing the installed dependencies for the cache");
    packed = await o.session.request("depsPack", { maxBytes: cache.maxBytes }, { signal: o.signal, timeoutMs: DEPS_PACK_TIMEOUT_MS });
  } catch (error) {
    if (fatal(error, o.signal)) throw error;
    if (error instanceof SessionError && error.code === "TOO_LARGE") return missed(false, `not stored: larger than the cache limit (${mb(cache.maxBytes)})`);
    return missed(false, `not stored: packing failed (${reason(error)})`);
  }
  const discard = () => o.session.request("depsDiscard", { transfer: packed.transfer }).catch(() => undefined);
  if (packed.size > cache.maxBytes) {
    await discard();
    return missed(false, `not stored: larger than the cache limit (${mb(cache.maxBytes)})`);
  }
  let writer;
  try {
    writer = await cache.beginStore(ref);
  } catch (error) {
    await discard();
    return missed(false, `not stored: ${reason(error)}`);
  }
  if ("skipped" in writer) {
    await discard();
    return missed(false, `not stored: ${writer.skipped}`);
  }
  try {
    await pullArchive(o.session, writer, packed, { signal: o.signal, onProgress: (done, total) => o.onStatus?.(`storing dependencies in the cache (${mb(done)} of ${mb(total)})`) });
    await writer.commit({ size: packed.size, sha256: packed.sha256 });
  } catch (error) {
    await writer.abort();
    await discard();
    if (fatal(error, o.signal)) throw error;
    return missed(false, `not stored: ${reason(error)}`);
  }
  await discard();
  await cache.touch(ref);
  const evicted = await cache.evict(ref).catch(() => ({ removed: [] as CacheEntryRef[] }));
  return missed(true, `stored ${mb(packed.size)} (${packed.entries} entries${packed.skipped ? `, ${packed.skipped} skipped` : ""}; key ${short})${evicted.removed.length ? `; evicted ${evicted.removed.length} older entr${evicted.removed.length === 1 ? "y" : "ies"}` : ""}`);
}
