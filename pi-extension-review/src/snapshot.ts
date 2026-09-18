import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ReviewCoreError,
  assertVersionMatchesBytes,
  createNonTextTarget,
  createTextTarget,
  isCanonicalPath,
  sha256,
  type LineRange,
  type SnapshotTarget,
} from "./core.ts";

export const DEFAULT_SNAPSHOT_LIMITS = {
  maxTargets: 500,
  maxTargetBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxPathLength: 4_096,
  maxDirectoryEntries: 10_000,
  maxDirectoryDepth: 64,
} as const;

export type SnapshotLimits = {
  maxTargets?: number;
  maxTargetBytes?: number;
  maxTotalBytes?: number;
  maxPathLength?: number;
  maxDirectoryEntries?: number;
  maxDirectoryDepth?: number;
};

/** W2 can supply session settings or precomputed ignore rules without changing capture authority. */
export type PathExcluder = (relativePath: string) => string | undefined | Promise<string | undefined>;

export class SnapshotError extends Error {}

type ResolvedLimits = {
  maxTargets: number;
  maxTargetBytes: number;
  maxTotalBytes: number;
  maxPathLength: number;
  maxDirectoryEntries: number;
  maxDirectoryDepth: number;
};

function limitsWithDefaults(input: SnapshotLimits = {}): ResolvedLimits {
  const result = { ...DEFAULT_SNAPSHOT_LIMITS, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value <= 0) throw new SnapshotError(`${name} must be a positive integer.`);
  }
  return result;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (relative && !isCanonicalPath(relative)) throw new SnapshotError("Selected path is not a canonical project-relative path.");
  return relative;
}

function metadataVersion(pathname: string, reason: string): string {
  return `metadata:${sha256(`firstpick/pi-extension-review/metadata/v1\0${pathname}\0${reason}`)}`;
}

type GitProbe = { code: number | null; stdout: string; stderr: string; launchError?: NodeJS.ErrnoException };
const gitRepositoryChecks = new Map<string, Promise<boolean>>();

async function probeGit(projectRoot: string, args: string[]): Promise<GitProbe> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: GitProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Child already exited. */ }
      if (!settled) {
        settled = true;
        reject(new SnapshotError("Git ignore check timed out."));
      }
    }, 5_000);
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        try { child.kill("SIGKILL"); } catch { /* Child already exited. */ }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new SnapshotError("Git ignore check exceeded its output limit."));
        }
        return;
      }
      destination.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout: "", stderr: "", launchError: error }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), }));
  });
}

async function isGitRepository(projectRoot: string): Promise<boolean> {
  const cached = gitRepositoryChecks.get(projectRoot);
  if (cached) return await cached;
  const check = (async () => {
    const result = await probeGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (result.launchError?.code === "ENOENT") return false;
    if (result.launchError) throw new SnapshotError(`Could not determine Git repository status: ${result.launchError.message}`);
    if (result.code === 0 && result.stdout.trim() === "true") return true;
    if (result.code === 128 && /not a git repository/i.test(result.stderr)) return false;
    throw new SnapshotError("Could not determine Git repository status.");
  })();
  gitRepositoryChecks.set(projectRoot, check);
  try {
    return await check;
  } catch (error) {
    gitRepositoryChecks.delete(projectRoot);
    throw error;
  }
}

async function gitIgnoreReason(projectRoot: string, relativePath: string): Promise<string | undefined> {
  if (!await isGitRepository(projectRoot)) return undefined;
  // Deliberately omit --no-index: tracked paths remain reviewable even when a
  // later .gitignore pattern would match their names.
  const result = await probeGit(projectRoot, ["check-ignore", "-q", "--", relativePath]);
  if (result.launchError) throw new SnapshotError(`Could not check Git ignore rules: ${result.launchError.message}`);
  if (result.code === 0) return "Git ignore exclusion.";
  if (result.code === 1) return undefined;
  throw new SnapshotError("Git ignore check failed.");
}

async function exclusionReasonFor(projectRoot: string, relativePath: string, custom?: PathExcluder): Promise<string | undefined> {
  const defaultReason = defaultExclusionReason(relativePath);
  if (defaultReason) return defaultReason;
  const customReason = await custom?.(relativePath);
  if (customReason !== undefined) {
    if (typeof customReason !== "string" || !customReason.trim() || customReason.length > 1_000) throw new SnapshotError("Custom exclusion reason must be a bounded non-empty string.");
    return customReason;
  }
  return await gitIgnoreReason(projectRoot, relativePath);
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Default exclusions are visible manifest targets, never silent coverage. */
export function defaultExclusionReason(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.includes(".git")) return "Git administrative directory exclusion.";
  if (segments.includes(".pi") || segments.includes(".pi-review") || segments.includes(".review")) return "Extension runtime or configuration exclusion.";
  if (segments.includes("node_modules") || segments.includes("vendor") || segments.includes("vendored")) return "Default vendor dependency exclusion.";
  if (/(^|\.)generated(?:\.|$)|\.gen\.[^.]+$|\.min\.(?:js|css)$/.test(basename) || segments.includes("dist")) return "Default generated-output exclusion.";
  if (basename === ".env" || basename.startsWith(".env.") || /(?:^|[-_.])(secrets?|credentials?|private[-_]?(?:keys?))(?:[-_.]|$)/.test(basename) || /\.(?:pem|p12|pfx|key)$/i.test(basename)) {
    return "Default secret-bearing path exclusion.";
  }
  return undefined;
}

export function snapshotTargetFromBuffer(input: {
  path: string;
  version: string;
  bytes: Buffer;
  requiredRanges?: readonly LineRange[];
  maxBytes?: number;
  exclusionReason?: string;
}): SnapshotTarget {
  const maxBytes = input.maxBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxTargetBytes;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new SnapshotError("Snapshot byte limit must be a positive integer.");
  assertVersionMatchesBytes(input.version, input.bytes);
  if (input.exclusionReason) {
    return createNonTextTarget({
      path: input.path,
      version: input.version,
      disposition: "excluded",
      reason: input.exclusionReason,
      sha256: sha256(input.bytes),
      byteLength: input.bytes.length,
    });
  }
  if (input.bytes.length > maxBytes) {
    return createNonTextTarget({
      path: input.path,
      version: input.version,
      disposition: "blocked",
      reason: `File exceeds the ${maxBytes}-byte snapshot limit.`,
      byteLength: input.bytes.length,
    });
  }
  if (input.bytes.includes(0)) {
    return createNonTextTarget({
      path: input.path,
      version: input.version,
      disposition: "blocked",
      reason: "Binary or NUL-containing content is not supported for text review.",
      sha256: sha256(input.bytes),
      byteLength: input.bytes.length,
    });
  }
  try {
    return createTextTarget(input);
  } catch (error) {
    if (error instanceof ReviewCoreError && /UTF-8/.test(error.message)) {
      return createNonTextTarget({
        path: input.path,
        version: input.version,
        disposition: "blocked",
        reason: "Content is not valid UTF-8 text.",
        sha256: sha256(input.bytes),
        byteLength: input.bytes.length,
      });
    }
    throw error;
  }
}

async function resolveSelectedPath(projectRoot: string, requestedPath: string): Promise<{ root: string; candidate: string; relative: string; info: Stats }> {
  if (typeof requestedPath !== "string" || !requestedPath || requestedPath.includes("\0") || path.isAbsolute(requestedPath)) {
    throw new SnapshotError("Selected paths must be non-empty relative paths.");
  }
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, requestedPath);
  if (!isInside(root, candidate)) throw new SnapshotError("Selected path escapes the project boundary.");
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new SnapshotError("Symbolic-link selections are not supported.");
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) throw new SnapshotError("Selected path escapes the project boundary through a symlink.");
  return { root, candidate: resolved, relative: canonicalRelative(root, resolved), info };
}

/**
 * Freeze one regular project file. The returned target embeds immutable bytes;
 * it never rereads the worktree during coverage accounting.
 */
export async function capturePathTarget(input: {
  projectRoot: string;
  requestedPath: string;
  requiredRanges?: readonly LineRange[];
  limits?: SnapshotLimits;
  exclusionReason?: string;
  exclude?: PathExcluder;
}): Promise<SnapshotTarget> {
  const limits = limitsWithDefaults(input.limits);
  const selected = await resolveSelectedPath(input.projectRoot, input.requestedPath);
  if (selected.relative.length > limits.maxPathLength) throw new SnapshotError("Selected path exceeds the snapshot path limit.");
  if (!selected.info.isFile()) throw new SnapshotError("Selected path is not a regular file.");

  const exclusionReason = input.exclusionReason ?? await exclusionReasonFor(selected.root, selected.relative, input.exclude);
  if (exclusionReason) {
    return createNonTextTarget({
      path: selected.relative,
      version: metadataVersion(selected.relative, exclusionReason),
      disposition: "excluded",
      reason: exclusionReason,
      byteLength: selected.info.size,
    });
  }
  if (selected.info.size > limits.maxTargetBytes) {
    return createNonTextTarget({
      path: selected.relative,
      version: metadataVersion(selected.relative, `oversized:${selected.info.size}`),
      disposition: "blocked",
      reason: `File exceeds the ${limits.maxTargetBytes}-byte snapshot limit.`,
      byteLength: selected.info.size,
    });
  }

  const handle = await open(selected.candidate, "r");
  try {
    const opened = await handle.stat({ bigint: false });
    if (!opened.isFile() || !sameIdentity(selected.info, opened)) throw new SnapshotError("Selected file changed before snapshot capture.");
    const bytes = await handle.readFile();
    const after = await lstat(selected.candidate);
    if (!sameIdentity(selected.info, after) || bytes.length !== selected.info.size) throw new SnapshotError("Selected file changed during snapshot capture.");
    return snapshotTargetFromBuffer({
      path: selected.relative,
      version: `sha256:${sha256(bytes)}`,
      bytes,
      requiredRanges: input.requiredRanges,
      maxBytes: limits.maxTargetBytes,
    });
  } finally {
    await handle.close();
  }
}

type DirectoryEntry = { relativePath: string; exclusionReason?: string };

async function directoryEntries(root: string, requestedPath: string, limits: ResolvedLimits, exclude?: PathExcluder): Promise<DirectoryEntry[]> {
  const selected = await resolveSelectedPath(root, requestedPath);
  if (!selected.info.isDirectory()) return [{ relativePath: selected.relative }];
  const entries: DirectoryEntry[] = [];
  let visited = 0;
  const visit = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (depth > limits.maxDirectoryDepth) throw new SnapshotError("Directory selection exceeds the maximum directory depth.");
    if (relative) {
      const exclusion = await exclusionReasonFor(selected.root, relative, exclude);
      if (exclusion) {
        entries.push({ relativePath: relative, exclusionReason: exclusion });
        return;
      }
    }
    const children = await readdir(absolute, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      if (++visited > limits.maxDirectoryEntries) throw new SnapshotError("Directory selection exceeds the directory-entry limit.");
      if (entries.length >= limits.maxTargets) throw new SnapshotError("Directory selection exceeds the target limit.");
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) throw new SnapshotError("Symbolic links are not supported in directory selections.");
      if (entry.isDirectory()) await visit(child, childRelative, depth + 1);
      else if (entry.isFile()) entries.push({ relativePath: childRelative });
      else throw new SnapshotError("Directory selection contains an unsupported non-regular entry.");
    }
  };
  await visit(selected.candidate, selected.relative, 0);
  return entries;
}

/** Expand explicit file/directory selections while retaining visible exclusions and one immutable target per regular file. */
export async function capturePathTargets(input: {
  projectRoot: string;
  requestedPaths: readonly string[];
  limits?: SnapshotLimits;
  exclude?: PathExcluder;
}): Promise<SnapshotTarget[]> {
  const limits = limitsWithDefaults(input.limits);
  if (!Array.isArray(input.requestedPaths) || input.requestedPaths.length === 0) throw new SnapshotError("At least one path must be selected.");
  const selections = new Map<string, DirectoryEntry>();
  for (const requestedPath of input.requestedPaths) {
    for (const entry of await directoryEntries(input.projectRoot, requestedPath, limits, input.exclude)) {
      const existing = selections.get(entry.relativePath);
      if (!existing || entry.exclusionReason) selections.set(entry.relativePath, entry);
    }
  }
  if (selections.size > limits.maxTargets) throw new SnapshotError("Path selection exceeds the target limit.");
  const targets: SnapshotTarget[] = [];
  let totalSnapshotBytes = 0;
  for (const entry of [...selections.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (totalSnapshotBytes >= limits.maxTotalBytes) throw new SnapshotError("Path selection exceeds the total snapshot byte limit.");
    const effectiveLimits = { ...limits, maxTargetBytes: Math.min(limits.maxTargetBytes, limits.maxTotalBytes - totalSnapshotBytes) };
    const target = entry.exclusionReason
      ? createNonTextTarget({
        path: entry.relativePath,
        version: metadataVersion(entry.relativePath, entry.exclusionReason),
        disposition: "excluded",
        reason: entry.exclusionReason,
      })
      : await capturePathTarget({ projectRoot: input.projectRoot, requestedPath: entry.relativePath, limits: effectiveLimits, exclude: input.exclude });
    if (target.contentBase64) totalSnapshotBytes += target.byteLength ?? 0;
    targets.push(target);
  }
  return targets;
}

/** Create a visible no-line target for Git deletions, pure renames, and mode-only changes. */
export function createMetadataTarget(pathname: string, reason: string): SnapshotTarget {
  return createNonTextTarget({
    path: pathname,
    version: metadataVersion(pathname, reason),
    disposition: "metadata",
    reason,
  });
}

/** Ensure an extension-owned storage root exists before a caller persists snapshots. */
export async function ensurePrivateRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SnapshotError("Snapshot storage root is not a directory.");
  return await realpath(root);
}
