/**
 * Exporting session artifacts (spec §7a.2): screenshots, accessibility dumps,
 * and logs leave the temp dir only through `gui_export` or `/gui-export`, into a
 * user-chosen directory. Existing files there are never overwritten.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ARTIFACT_NAME, artifactPath } from "./artifacts.ts";
import { isWithin } from "../paths.ts";
import type { LiveSession } from "./runtime.ts";

/** Default bound for one export. */
export const EXPORT_TIMEOUT_MS = 2 * 60_000;

/** How long an interrupted copy may take to clean up its partial file. */
const SETTLE_MS = 1_000;

export interface ExportResult {
  dest: string;
  copied: string[];
  /** Names that already existed in `dest` and were left untouched. */
  skipped: string[];
}

/** Copies one file; must stop (and reject) promptly when `signal` aborts. */
export type CopyFn = (src: string, dest: string, signal: AbortSignal) => Promise<void>;

export interface ExportOptions {
  /** Cancels the export, also in the middle of the log flush or a copy (the tool call's or the command's signal). */
  signal?: AbortSignal;
  /** Overall bound; default {@link EXPORT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Test clock. With it the deadline is checked between steps only (no timer). */
  now?: () => number;
  /** Test hook for the per-file copy; default {@link copyArtifact}. */
  copy?: CopyFn;
}

const isInside = isWithin;

/**
 * `path` (absolute, normalised) with its nearest existing ancestor resolved
 * through `realpath`: symlinks along the existing part are followed, the
 * components that do not exist yet are appended unchanged.
 */
async function resolveExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Copies `src` to a new file `dest` (`wx`: never overwrites, never follows a
 * link there) through streams bound to `signal`. A partial copy is removed.
 *
 * @throws Error with code `EEXIST` when `dest` exists; `AbortError` on abort.
 */
export async function copyArtifact(src: string, dest: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let created = false;
  const out = createWriteStream(dest, { flags: "wx", mode: 0o600 });
  out.once("open", () => (created = true));
  try {
    await pipeline(createReadStream(src), out, { signal });
  } catch (error) {
    if (created) await rm(dest, { force: true }).catch(() => {});
    throw error;
  }
}

/** Resolves with `work`, or rejects as soon as `signal` aborts (the work itself may continue in the background). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => (signal.removeEventListener("abort", onAbort), resolvePromise(value)),
      (error) => (signal.removeEventListener("abort", onAbort), reject(error)),
    );
  });
}

/**
 * Copies the session's artifacts into `dest` (resolved against `cwd`, created if needed).
 * One deadline covers the whole export; the caller's signal and the deadline
 * interrupt the log flush and each copy, and are checked between steps and
 * after the last copy.
 *
 * @throws Error when `dest` lies inside the session temp dir, or with name `AbortError` on cancel or timeout
 *   (files copied completely so far stay in `dest`; a partial file is removed).
 */
export async function exportArtifacts(live: LiveSession, dest: string, cwd: string, options: ExportOptions = {}): Promise<ExportResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? EXPORT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const copy = options.copy ?? copyArtifact;
  const result: ExportResult = { dest: resolve(cwd, dest), copied: [], skipped: [] };
  const timeoutError = () =>
    Object.assign(new Error(`export did not finish within ${Math.round(timeoutMs / 1000)} s; ${result.copied.length} file(s) were copied to ${result.dest}`), { name: "AbortError" });
  const expired = new AbortController();
  // Referenced on purpose: a pending export (a tool call Pi waits for) must settle, never be dropped by a drained event loop.
  const timer = options.now ? undefined : setTimeout(() => expired.abort(timeoutError()), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, expired.signal]) : expired.signal;
  const check = () => {
    if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error("export cancelled"), { name: "AbortError" });
    if (expired.signal.aborted || now() >= deadline) throw timeoutError();
  };
  const interrupted = (error: unknown): never => {
    // Report a deadline with the current count rather than the reason captured when the timer fired.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (expired.signal.aborted) throw timeoutError();
    throw error;
  };
  try {
    check();
    await raceAbort(live.logs.flush(), signal).catch(interrupted);
    // Compared after resolving symlinks: a link into the session dir would let gui_stop delete the "exported" files.
    const sessionDirs = [live.dir.path, await realpath(live.dir.path), await realpath(live.artifactsDir)];
    const refuseInside = (path: string) => {
      if (sessionDirs.some((dir) => isInside(path, dir))) {
        throw new Error(`export destination ${result.dest} is inside the temporary session dir${path === result.dest ? "" : ` (it resolves to ${path})`}; choose a directory outside it`);
      }
    };
    refuseInside(result.dest);
    refuseInside(await resolveExisting(result.dest));
    check();
    await mkdir(result.dest, { recursive: true });
    // Re-resolved once it exists; the copies go to this real path.
    const target = await realpath(result.dest);
    refuseInside(target);
    for (const entry of await readdir(live.artifactsDir, { withFileTypes: true })) {
      check();
      if (!entry.isFile() || !ARTIFACT_NAME.test(entry.name)) continue;
      const copying = copy(artifactPath(live.artifactsDir, entry.name), artifactPath(target, entry.name), signal);
      try {
        await raceAbort(copying, signal);
        result.copied.push(entry.name);
      } catch (error) {
        // Give an interrupted copy a moment to remove its partial file.
        if (signal.aborted) {
          let settle: NodeJS.Timeout | undefined;
          await Promise.race([copying.catch(() => {}), new Promise((r) => (settle = setTimeout(r, SETTLE_MS)))]);
          clearTimeout(settle);
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          result.skipped.push(entry.name);
          continue;
        }
        interrupted(error);
      }
    }
    check();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
