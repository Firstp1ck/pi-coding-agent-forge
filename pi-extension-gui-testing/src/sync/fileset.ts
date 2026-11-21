/**
 * Sync file set (spec §4.7) for `copy` mode and remote backends. Decides which
 * project files leave the project directory; never follows symlinks.
 *
 * A path is synced when it is in the file set, not inside a dependency
 * directory, not matched by `sync.deny`, and either not always-excluded or
 * listed in `sync.allow`. `sync.deny` beats `sync.allow`; nothing re-includes
 * a dependency directory. Symlinks survive only when their target resolves
 * inside the root and is itself synced (a directory link: at least one synced
 * file lies below its target). Sockets, FIFOs, and devices are dropped.
 *
 * Git can list cached paths below a directory that was later replaced by a
 * symlink (`dir/file` with `dir -> /elsewhere`). Every ancestor of a candidate
 * must therefore be a real directory inside the root; a path below a symlinked
 * ancestor is excluded, never followed.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { isRelativeInside } from "../paths.ts";
import type { CommandRunner } from "../runner/types.ts";
import { SAFE_GIT_ENV, safeGitArgv } from "./git.ts";
import { compilePatterns, DEFAULT_IGNORED_DIRS, inDependencyDir, secretMatch, type PathPattern } from "./patterns.ts";


/**
 * `<dev>:<ino>:<birth time ns>` of a file. The birth time tells a replacement
 * that reuses a freed inode number (common on ext4) from the enumerated file,
 * and does not change when the file is edited in place.
 */
export function fileIdentity(info: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

export type ExclusionReason =
  | "dependency"
  | "deny"
  | "secret"
  | "link-outside"
  | "link-excluded"
  | "link-dangling"
  | "link-ancestor"
  | "invalid"
  | "special"
  | "missing";

export interface SyncedEntry {
  /** Root-relative path with `/` separators. */
  path: string;
  type: "file" | "symlink";
  /** File size in bytes (0 for links). */
  size: number;
  /** Permission bits of a file. */
  mode: number;
  /** For links: the target relative to the link's directory, so it stays valid in the copy. */
  linkTarget?: string;
  /** For files: {@link fileIdentity} at enumeration; the copy refuses a file whose identity changed. */
  identity?: string;
}

export interface ExcludedEntry {
  path: string;
  reason: ExclusionReason;
  /** e.g. the matching pattern. */
  detail?: string;
}

export interface FileSet {
  /** Resolved project root the paths are relative to; the copy reads from here. */
  root: string;
  source: "git" | "walk";
  entries: SyncedEntry[];
  excluded: ExcludedEntry[];
  /** Total bytes of synced files. */
  bytes: number;
}

export interface FileSetOptions {
  allow?: readonly string[];
  deny?: readonly string[];
  /** Used for `git ls-files`; without it (or without Git) the tree is walked. */
  runner?: CommandRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Candidate paths from Git (tracked + untracked-but-not-ignored), or `undefined` outside a repository. */
async function gitCandidates(root: string, options: FileSetOptions): Promise<string[] | undefined> {
  if (!options.runner) return undefined;
  let result;
  try {
    // The repository's config is untrusted: safeGitArgv disables fsmonitor and hooks.
    result = await options.runner.run(safeGitArgv(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), {
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      maxOutputBytes: 64 * 1024 * 1024,
      env: { ...SAFE_GIT_ENV },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
  if (result.exitCode !== 0) return undefined;
  if (result.truncated) throw new Error("git ls-files output too large");
  // --cached lists a path once per index stage during a merge conflict; keep one.
  return [...new Set(result.stdout.split("\0").filter((p) => p.length > 0))];
}

/** All non-directory entries below `root`, skipping {@link DEFAULT_IGNORED_DIRS} at any depth. */
async function walkCandidates(root: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    if (signal?.aborted) throw signal.reason ?? new Error("file set aborted");
    const rel = pending.pop()!;
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(DEFAULT_IGNORED_DIRS as readonly string[]).includes(entry.name)) pending.push(path);
      } else {
        out.push(path);
      }
    }
  }
  return out;
}

interface Rules {
  allow: PathPattern[];
  deny: PathPattern[];
}

/** Rule decision for a path by name only (no file-type checks). */
function nameDecision(path: string, isDir: boolean, rules: Rules): ExcludedEntry | undefined {
  if (inDependencyDir(path, isDir)) return { path, reason: "dependency" };
  const denied = rules.deny.find((p) => p.test(path, isDir));
  if (denied) return { path, reason: "deny", detail: denied.source };
  const secret = secretMatch(isDir ? `${path}/x` : path);
  if (secret && !rules.allow.some((p) => p.test(path, isDir))) return { path, reason: "secret", detail: secret };
  return undefined;
}

/** `true` for a clean relative path: no empty, `.`, or `..` segment, not absolute, no NUL. */
function isCleanRelative(path: string): boolean {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Why a candidate may not be read through its ancestors, or `undefined` when
 * every ancestor directory is a real directory (not a symlink). Results per
 * ancestor are cached in `cache`.
 */
async function ancestorProblem(realRoot: string, path: string, cache: Map<string, ExcludedEntry["reason"] | "ok">): Promise<ExcludedEntry | undefined> {
  const parts = path.split("/");
  let prefix = "";
  for (const part of parts.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    let state = cache.get(prefix);
    if (state === undefined) {
      try {
        const info = await lstat(join(realRoot, prefix));
        state = info.isSymbolicLink() ? "link-ancestor" : info.isDirectory() ? "ok" : "missing";
      } catch {
        state = "missing";
      }
      cache.set(prefix, state);
    }
    if (state !== "ok") return { path, reason: state, ...(state === "link-ancestor" ? { detail: `${prefix} is a symlink` } : {}) };
  }
  return undefined;
}

/**
 * Builds the file set of `root`.
 *
 * @throws Error for invalid `sync.allow`/`sync.deny` patterns or an unreadable tree.
 */
export async function buildFileSet(root: string, options: FileSetOptions = {}): Promise<FileSet> {
  const rules: Rules = { allow: compilePatterns(options.allow, "sync.allow"), deny: compilePatterns(options.deny, "sync.deny") };
  const realRoot = await realpath(root);
  const git = await gitCandidates(realRoot, options);
  const candidates = (git ?? (await walkCandidates(realRoot, options.signal))).map(toPosix).sort();
  const set: FileSet = { root: realRoot, source: git ? "git" : "walk", entries: [], excluded: [], bytes: 0 };
  const synced = new Set<string>();
  const links: { path: string; mode: number }[] = [];
  const ancestors = new Map<string, ExcludedEntry["reason"] | "ok">();

  for (const path of candidates) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("file set aborted");
    if (!isCleanRelative(path)) {
      set.excluded.push({ path, reason: "invalid" });
      continue;
    }
    const byName = nameDecision(path, false, rules);
    if (byName) {
      set.excluded.push(byName);
      continue;
    }
    const ancestor = await ancestorProblem(realRoot, path, ancestors);
    if (ancestor) {
      set.excluded.push(ancestor);
      continue;
    }
    let info;
    try {
      info = await lstat(join(realRoot, path), { bigint: true });
    } catch {
      // Tracked but deleted from the working tree.
      set.excluded.push({ path, reason: "missing" });
      continue;
    }
    if (info.isSymbolicLink()) {
      links.push({ path, mode: Number(info.mode) });
    } else if (info.isFile()) {
      const size = Number(info.size);
      set.entries.push({ path, type: "file", size, mode: Number(info.mode) & 0o7777, identity: fileIdentity(info) });
      set.bytes += size;
      synced.add(path);
    } else if (info.isDirectory()) {
      // A Git submodule (gitlink) appears as a directory; its contents are not part of this repository's file set.
      set.excluded.push({ path, reason: "special", detail: "directory entry (submodule)" });
    } else {
      set.excluded.push({ path, reason: "special", detail: info.isSocket() ? "socket" : info.isFIFO() ? "fifo" : "device" });
    }
  }

  for (const link of links) {
    const decision = await linkDecision(realRoot, link.path, synced, rules);
    if ("reason" in decision) set.excluded.push(decision);
    else set.entries.push({ path: link.path, type: "symlink", size: 0, mode: 0o777, linkTarget: decision.target });
  }
  set.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return set;
}

async function linkDecision(realRoot: string, path: string, synced: ReadonlySet<string>, rules: Rules): Promise<{ target: string } | ExcludedEntry> {
  const absolute = join(realRoot, path);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    return { path, reason: "link-dangling" };
  }
  const rel = relative(realRoot, resolved);
  if (rel === "" || !isRelativeInside(rel)) return { path, reason: "link-outside", detail: resolved };
  const target = toPosix(rel);
  let isDir = false;
  try {
    isDir = (await lstat(resolved)).isDirectory();
  } catch {
    return { path, reason: "link-dangling" };
  }
  // A directory link survives only when its target directory contributes synced files.
  const targetSynced = isDir
    ? nameDecision(target, true, rules) === undefined && [...synced].some((p) => p.startsWith(`${target}/`))
    : synced.has(target);
  if (!targetSynced) return { path, reason: "link-excluded", detail: target };
  // Point at the resolved target relative to the link, so the copy works under any mount point.
  const linkDir = posix.dirname(path);
  return { target: posix.relative(linkDir === "." ? "" : linkDir, target) || "." };
}

/** Directory part of a root-relative path, or `""`. */
export function parentOf(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "" : toPosix(dir);
}
