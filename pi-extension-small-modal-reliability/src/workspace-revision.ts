import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkspaceRevision } from "./types.ts";
import { nowIso } from "./utils.ts";

const MAX_INVENTORY_FILES = 10_000;
const MAX_INVENTORY_DIRECTORIES = 2_000;
const MAX_INVENTORY_DEPTH = 32;
const MAX_INVENTORY_BYTES = 20 * 1024 * 1024;
const INVENTORY_DEADLINE_MS = 1_000;
const GIT_TIMEOUT_MS = 1_000;

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    }).toString("utf8").trim();
    return value || undefined;
  } catch {
    // A non-Git directory and an unavailable Git binary are both non-fatal;
    // content inventory remains the authoritative revision in either case.
    return undefined;
  }
}

function isIgnoredRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts[0] === ".git" || parts[0] === "node_modules") return true;
  if (parts[0] !== ".pi") return false;
  return parts[1] === "tasks" || parts[1] === "npm" || parts[1] === "git";
}

function updateRecord(hash: ReturnType<typeof createHash>, relativePath: string, value: Buffer | string): void {
  hash.update(relativePath);
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

/**
 * Returns a time-, depth-, directory-, file-, and byte-bounded content inventory.
 * Internal task artifacts are excluded so state persistence does not invalidate evidence.
 */
export function captureWorkspaceRevision(cwd: string): WorkspaceRevision {
  const observedAt = nowIso();
  const root = resolve(cwd);
  const deadline = Date.now() + INVENTORY_DEADLINE_MS;
  const hash = createHash("sha256");
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  let incompleteReason: string | undefined;

  const exhausted = (): boolean => {
    if (Date.now() <= deadline) return false;
    incompleteReason = "workspace inventory exceeded its time bound";
    return true;
  };

  const visit = (directory: string, depth: number): void => {
    if (incompleteReason || exhausted()) return;
    if (depth > MAX_INVENTORY_DEPTH) {
      incompleteReason = "workspace inventory exceeded its directory depth bound";
      return;
    }
    directoryCount += 1;
    if (directoryCount > MAX_INVENTORY_DIRECTORIES) {
      incompleteReason = "workspace inventory exceeded its directory bound";
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      incompleteReason = "workspace inventory could not read a directory";
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (incompleteReason || exhausted()) return;
      const absolutePath = join(directory, entry.name);
      const rel = relative(root, absolutePath).replace(/\\/g, "/");
      if (isIgnoredRelativePath(rel)) continue;
      try {
        const stat = lstatSync(absolutePath);
        if (stat.isDirectory()) {
          visit(absolutePath, depth + 1);
          continue;
        }
        if (stat.isSymbolicLink()) {
          // An external target can change without a visible worktree revision.
          updateRecord(hash, `${rel}:symlink`, readlinkSync(absolutePath));
          incompleteReason = "workspace inventory contains a symbolic link";
          return;
        }
        if (!stat.isFile()) continue;
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > MAX_INVENTORY_FILES || totalBytes > MAX_INVENTORY_BYTES) {
          incompleteReason = "workspace inventory exceeded its safe bound";
          return;
        }
        updateRecord(hash, rel, readFileSync(absolutePath));
      } catch {
        incompleteReason = "workspace inventory could not read a file";
      }
    }
  };

  visit(root, 0);
  const gitHead = gitValue(root, ["rev-parse", "HEAD"]);
  const gitBranch = gitValue(root, ["branch", "--show-current"]);
  hash.update(`git-head:${gitHead ?? "none"}\0git-branch:${gitBranch ?? "none"}`);

  return {
    digest: incompleteReason ? "unknown" : hash.digest("hex"),
    inventory_complete: !incompleteReason,
    observed_at: observedAt,
    file_count: fileCount,
    directory_count: directoryCount,
    total_bytes: totalBytes,
    git_head: gitHead,
    git_branch: gitBranch,
    reason: incompleteReason,
  };
}

export function workspaceBranchIdentity(cwd: string, revision: WorkspaceRevision): string {
  if (revision.git_branch) return `git:${revision.git_branch}:${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12)}`;
  return `workspace:${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12)}`;
}

export function revisionsMatch(left: WorkspaceRevision | string | undefined, right: WorkspaceRevision | string | undefined): boolean {
  const leftDigest = typeof left === "string" ? left : left?.digest;
  const rightDigest = typeof right === "string" ? right : right?.digest;
  const leftComplete = typeof left === "string" ? left !== "unknown" : left?.inventory_complete === true;
  const rightComplete = typeof right === "string" ? right !== "unknown" : right?.inventory_complete === true;
  return Boolean(leftComplete && rightComplete && leftDigest && rightDigest && leftDigest === rightDigest);
}
