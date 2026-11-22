/**
 * Workspace sync to a remote session dir (spec §4.2a "Workspace sync",
 * §4.7). The §4.7 file set is first staged on the client with the existing
 * copy code ({@link copyFileSet}): it never follows symlinks out of the
 * project, re-checks every file at copy time, and fails closed. The staged
 * tree (in the client session dir, mode 0700) is then sent:
 *
 * - with `rsync` over SSH when both ends have it: `--files-from` lists exactly
 *   the staged entries, `--checksum` makes re-syncs incremental, `-e` carries
 *   this session's SSH options and ControlMaster socket, and there is no
 *   `--delete`;
 * - otherwise as a tar stream over SSH (a full copy of the file set),
 *   extracted by the remote `tar` inside the remote workspace.
 *
 * On a re-sync, files that left the file set (or changed type) are removed
 * first, by exact relative path inside the remote workspace and nowhere else
 * ({@link REMOVE_STALE_SCRIPT}: no symlink is followed on the way there).
 * Every result reports file count, bytes sent, and excluded count.
 */
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncSummary } from "../../backend.ts";
import { createSpawnRunner } from "../../runner/spawn.ts";
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import { assertSafeRemotePath } from "../../transport/ssh/quote.ts";
import type { SshTransport } from "../../transport/ssh/transport.ts";
import { copyFileSet } from "../copy.ts";
import { parentOf, type FileSet, type SyncedEntry } from "../fileset.ts";
import { tarStream, type TarStreamEntry } from "./tar-stream.ts";

export type SyncMethod = "rsync" | "tar";

export interface SyncReport extends SyncSummary {
  method: SyncMethod;
  /** Bytes of the file set (what a full copy holds). */
  setBytes: number;
  /** Remote paths removed because they left the file set. */
  deleted: number;
}

export interface WorkspaceSyncOptions {
  transport: SshTransport;
  /** Client directory for staging (inside the session dir); created with mode 0700. */
  stagingRoot: string;
  /** Absolute remote workspace directory (safe characters only); must exist. */
  remoteDir: string;
  /** Local runner for `rsync`; default the spawn runner. */
  localRunner?: CommandRunner;
  /** `auto` (default) uses rsync when both ends have it. */
  method?: "auto" | SyncMethod;
  /** Bound for one transfer. Default 30 minutes. */
  timeoutMs?: number;
}

/** Paths per remote removal call. */
const DELETE_BATCH = 200;

/**
 * Removes stale paths (`$2…`, relative) inside the workspace `$1` without
 * following any symlink. The workspace must be a real directory (not a
 * symlink) owned by the SSH user. Each path is reached one component at a
 * time from the workspace's resolved path: a component that is a symlink, not
 * a directory, `.`/`..`, or that resolves anywhere but the expected place
 * (`pwd -P`) ends that path untouched. The leaf is unlinked relative to the
 * verified current directory (a symlink leaf removes the link itself); a
 * directory leaf is never removed. POSIX sh, inputs as argv only.
 */
export const REMOVE_STALE_SCRIPT = [
  'root=$1; shift; case $root in /*) ;; *) echo "workspace $root is not absolute" >&2; exit 2 ;; esac',
  '{ [ -d "$root" ] && [ ! -L "$root" ] && [ -O "$root" ]; } || { echo "workspace $root is not a directory owned by the SSH user" >&2; exit 3; }',
  'cd -P -- "$root" || exit 3; real=$(pwd -P) || exit 3',
  "rm_stale() {",
  '  cd -P -- "$real" || return 1; [ "$(pwd -P)" = "$real" ] || return 1',
  '  ifs=$IFS; IFS=/; set -f; set -- $1; IFS=$ifs; set +f; want=$real',
  '  while [ "$#" -gt 1 ]; do',
  '    c=$1; shift; case $c in ""|.|..) return 0 ;; esac',
  '    { [ ! -L "$c" ] && [ -d "$c" ]; } || return 0',
  '    cd -P -- "./$c" || return 0; want=$want/$c; [ "$(pwd -P)" = "$want" ] || return 0',
  "  done",
  '  case $1 in ""|.|..) return 0 ;; esac',
  '  if [ -L "$1" ]; then rm -f -- "./$1"; elif [ -d "$1" ]; then return 0; elif [ -e "$1" ]; then rm -f -- "./$1"; fi',
  "}",
  'st=0; for p in "$@"; do rm_stale "$p" || st=1; done; exit "$st"',
].join("\n");
export const SYNC_TIMEOUT_MS = 30 * 60_000;

/** `rsync` argv for one transfer (exported for tests and the checks). */
export function rsyncArgv(options: { listFile: string; stage: string; rsh: string; destination: string; remoteDir: string }): string[] {
  return [
    "rsync",
    `--files-from=${options.listFile}`,
    "--from0",
    "--links",
    "--perms",
    "--checksum",
    "--safe-links",
    "--stats",
    "-e",
    options.rsh,
    "--",
    `${options.stage}/`,
    `${options.destination}:${options.remoteDir}/`,
  ];
}

/** Bytes sent from `rsync --stats` output; `undefined` when absent. */
export function parseRsyncBytesSent(output: string): number | undefined {
  const match = /Total bytes sent:\s*([\d,.]+)/.exec(output);
  if (!match) return undefined;
  const value = Number(match[1].replace(/[,.]/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/** rsync's `host:path` syntax cannot carry an `ssh://` URI or a destination with `:`. */
export function rsyncCanReach(destination: string): boolean {
  return !destination.includes("://") && !destination.includes(":") && !destination.includes("[");
}

function describe(result: RunResult): string {
  if (result.timedOut) return `timed out after ${result.durationMs} ms`;
  const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ").slice(-400);
  return `${result.exitCode === null ? `killed by ${result.signal}` : `exit ${result.exitCode}`}${tail ? `: ${tail}` : ""}`;
}

/** Tar entries for the staged tree: parent directories first, then files and links in set order. */
export function stagedTarEntries(stage: string, entries: readonly SyncedEntry[], mtime: number = Math.floor(Date.now() / 1000)): TarStreamEntry[] {
  const dirs = new Set<string>();
  const out: TarStreamEntry[] = [];
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    if (parent) {
      const parts = parent.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (dirs.has(dir)) continue;
        dirs.add(dir);
        out.push({ path: dir, type: "dir", mode: 0o755, mtime });
      }
    }
    if (entry.type === "symlink") {
      out.push({ path: entry.path, type: "symlink", mode: 0o777, mtime, linkTarget: entry.linkTarget! });
      continue;
    }
    out.push({
      path: entry.path,
      type: "file",
      mode: entry.mode & 0o777,
      mtime,
      size: entry.size,
      open: async () => {
        // The staging dir is ours (0700), but still never follow a link there.
        const handle = await open(join(stage, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size !== entry.size) {
          await handle.close();
          throw new Error(`staged ${entry.path} is not the copied file`);
        }
        return handle.createReadStream({ autoClose: true });
      },
    });
  }
  return out;
}

export class WorkspaceSync {
  readonly #options: WorkspaceSyncOptions;
  readonly #local: CommandRunner;
  #previous?: Map<string, SyncedEntry["type"]>;
  #method?: SyncMethod;
  #round = 0;

  constructor(options: WorkspaceSyncOptions) {
    assertSafeRemotePath(options.remoteDir);
    this.#options = options;
    this.#local = options.localRunner ?? createSpawnRunner();
  }

  /** The transfer method chosen by the first sync. */
  get method(): SyncMethod | undefined {
    return this.#method;
  }

  async #chooseMethod(signal?: AbortSignal): Promise<SyncMethod> {
    const wanted = this.#options.method ?? "auto";
    if (wanted !== "auto") return wanted;
    if (!rsyncCanReach(this.#options.transport.destination)) return "tar";
    const local = await this.#local.run(["rsync", "--version"], { timeoutMs: 10_000, ...(signal ? { signal } : {}) }).catch(() => undefined);
    if (local?.exitCode !== 0) return "tar";
    const remote = await this.#options.transport.runner.run(["rsync", "--version"], { timeoutMs: 15_000, ...(signal ? { signal } : {}) }).catch(() => undefined);
    return remote?.exitCode === 0 ? "rsync" : "tar";
  }

  /**
   * Sends `set` to the remote workspace. The first call is a full copy; later
   * calls are incremental with rsync and full copies with tar.
   *
   * @throws SyncChangedError when a project file changed during staging; Error when the transfer failed.
   */
  async sync(set: FileSet, signal?: AbortSignal): Promise<SyncReport> {
    this.#method ??= await this.#chooseMethod(signal);
    const round = ++this.#round;
    await mkdir(this.#options.stagingRoot, { recursive: true, mode: 0o700 });
    const stage = join(this.#options.stagingRoot, `stage-${round}`);
    try {
      const staged = await copyFileSet(set, stage, signal);
      const current = new Map(set.entries.map((e) => [e.path, e.type] as const));
      const deleted = await this.#deleteStale(current, signal);
      const bytesSent = this.#method === "rsync" ? await this.#rsync(set, stage, signal) : await this.#tar(set, stage, signal);
      this.#previous = current;
      return { files: staged.files, bytes: bytesSent, excluded: staged.excluded, method: this.#method, setBytes: set.bytes, deleted };
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Removes remote paths that left the file set or changed type, by exact path inside the workspace (never through a symlink). */
  async #deleteStale(current: ReadonlyMap<string, SyncedEntry["type"]>, signal?: AbortSignal): Promise<number> {
    if (!this.#previous) return 0;
    const stale = [...this.#previous].filter(([path, type]) => current.get(path) !== type).map(([path]) => path);
    for (let i = 0; i < stale.length; i += DELETE_BATCH) {
      const batch = stale.slice(i, i + DELETE_BATCH);
      const argv = ["/bin/sh", "-c", REMOVE_STALE_SCRIPT, "sh", this.#options.remoteDir, ...batch];
      const result = await this.#options.transport.runner.run(argv, { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new Error(`removing files that left the sync set failed (${describe(result)})`);
    }
    return stale.length;
  }

  async #rsync(set: FileSet, stage: string, signal?: AbortSignal): Promise<number> {
    const listFile = join(this.#options.stagingRoot, `files-${this.#round}.list`);
    await writeFile(listFile, set.entries.map((e) => `${e.path}\0`).join(""), { mode: 0o600 });
    try {
      const argv = rsyncArgv({ listFile, stage, rsh: this.#options.transport.rshCommand(), destination: this.#options.transport.destination, remoteDir: this.#options.remoteDir });
      const result = await this.#local.run(argv, { timeoutMs: this.#options.timeoutMs ?? SYNC_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      if (result.exitCode !== 0) throw new Error(`rsync to ${this.#options.transport.destination} failed (${describe(result)})`);
      return parseRsyncBytesSent(result.stdout) ?? set.bytes;
    } finally {
      await rm(listFile, { force: true }).catch(() => undefined);
    }
  }

  async #tar(set: FileSet, stage: string, signal?: AbortSignal): Promise<number> {
    const counter = { bytes: 0 };
    const stream = tarStream(stagedTarEntries(stage, set.entries), counter);
    const result = await this.#options.transport.runStream(["/bin/sh", "-c", "umask 022 && exec tar -x -f -", "sh"], stream, {
      cwd: this.#options.remoteDir,
      timeoutMs: this.#options.timeoutMs ?? SYNC_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`tar over ssh to ${this.#options.transport.destination} failed (${describe(result)})`);
    return counter.bytes;
  }
}
