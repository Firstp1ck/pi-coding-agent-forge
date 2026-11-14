/**
 * Workspace sync into the Windows guest (spec §4.7 file set; transport as
 * the M2b tar fallback). The file set is staged on the client with
 * {@link copyFileSet} (never follows links out of the project, re-checks
 * every file) and streamed as tar over the guest SSH connection into
 * `tar.exe -x` (bsdtar, part of Windows 10 1803+), which refuses absolute
 * and `..` paths. rsync is not used: the guest has none. Names Windows cannot
 * store are left out and counted as excluded.
 *
 * The same stream deploys the helper into a session dir when the base's copy
 * differs from this package (the base keeps working across package updates).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SyncSummary } from "../../backend.ts";
import type { FileSet, SyncedEntry } from "../../sync/fileset.ts";
import { copyFileSet } from "../../sync/copy.ts";
import { tarStream, type TarStreamEntry } from "../../sync/transport/tar-stream.ts";
import { stagedTarEntries, SYNC_TIMEOUT_MS } from "../../sync/transport/workspace-sync.ts";
import { describeFailure } from "../docker/cli.ts";
import type { GuestSsh } from "./guest-ssh.ts";
import type { HelperFile } from "./oem.ts";
import { assertGuestPath, cmdLine } from "./powershell.ts";

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `path` (relative, `/`-separated) cannot exist on Windows, or `undefined`. */
export function windowsNameProblem(path: string): string | undefined {
  for (const part of path.split("/")) {
    if (/[<>:"|?*\\\x00-\x1f]/.test(part)) return `"${part}" contains a character Windows does not allow in names`;
    if (/[. ]$/.test(part)) return `"${part}" ends with a dot or space`;
    if (RESERVED.test(part)) return `"${part}" is a reserved Windows device name`;
  }
  return undefined;
}

/**
 * The file set without entries Windows cannot store: invalid or reserved
 * names, links whose target has such a name, and case-insensitive duplicates
 * (Windows file names ignore case; the first one wins).
 */
export function windowsSafeFileSet(set: FileSet): FileSet {
  const seen = new Set<string>();
  const entries: SyncedEntry[] = [];
  const excluded = [...set.excluded];
  let bytes = 0;
  for (const entry of set.entries) {
    const problem = windowsNameProblem(entry.path) ?? (entry.type === "symlink" && entry.linkTarget ? windowsNameProblem(entry.linkTarget.split("/").filter((p) => p !== ".." && p !== ".").join("/") || "x") : undefined);
    const folded = entry.path.toLowerCase();
    if (problem || seen.has(folded)) {
      excluded.push({ path: entry.path, reason: "invalid", detail: problem ? `not a valid Windows name: ${problem}` : "differs from another synced path only in letter case (Windows ignores case)" });
      continue;
    }
    seen.add(folded);
    entries.push(entry);
    bytes += entry.size;
  }
  return { ...set, entries, excluded, bytes };
}

/** The guest command line that extracts a tar stream into `dir`. */
export function untarCommand(dir: string): string {
  return cmdLine(["tar.exe", "-x", "-f", "-", "-C", assertGuestPath(dir)]);
}

export interface GuestSyncReport extends SyncSummary {
  /** Paths left out because Windows cannot store them (subset of `excluded`). */
  windowsExcluded: string[];
}

/**
 * Stages `set` in `stagingRoot` and extracts it into the guest directory `dir` (which must exist).
 *
 * @throws SyncChangedError when a project file changed during staging; Error when the transfer failed.
 */
export async function syncToGuest(guest: GuestSsh, set: FileSet, stagingRoot: string, dir: string, signal?: AbortSignal): Promise<GuestSyncReport> {
  const safe = windowsSafeFileSet(set);
  const windowsExcluded = safe.excluded.slice(set.excluded.length).map((e) => e.path);
  const stage = join(stagingRoot, "stage");
  try {
    const staged = await copyFileSet(safe, stage, signal);
    const counter = { bytes: 0 };
    const sent = await guest.stream(untarCommand(dir), tarStream(stagedTarEntries(stage, safe.entries), counter), { timeoutMs: SYNC_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    if (sent.exitCode !== 0) throw new Error(`copying the workspace into the Windows guest failed (${describeFailure(sent)})`);
    return { files: staged.files, bytes: counter.bytes, excluded: staged.excluded, windowsExcluded };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Tar entries of the helper files (directories first). */
export function helperTarEntries(files: readonly HelperFile[]): TarStreamEntry[] {
  const dirs = new Set<string>();
  const out: TarStreamEntry[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.has(dir)) {
        dirs.add(dir);
        out.push({ path: dir, type: "dir", mode: 0o755 });
      }
    }
    out.push({ path: file.path, type: "file", mode: 0o644, size: file.data.length, data: file.data });
  }
  return out;
}

/** Streams the helper files into the guest directory `dir` (which must exist). */
export async function deployHelper(guest: GuestSsh, files: readonly HelperFile[], dir: string, signal?: AbortSignal): Promise<void> {
  const sent = await guest.stream(untarCommand(dir), tarStream(helperTarEntries(files)), { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  if (sent.exitCode !== 0) throw new Error(`deploying the helper into the Windows guest failed (${describeFailure(sent)})`);
}
