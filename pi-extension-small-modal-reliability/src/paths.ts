import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const TASKS_GITIGNORE = "*\n!.gitignore\n";

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith("/") && !path.startsWith("\\"));
}

function ensureRealDirectory(root: string, segment: string): string {
  const path = join(root, segment);
  if (!pathIsWithin(root, path)) throw new Error("Task artifact storage escaped the workspace root.");
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Task artifact storage cannot traverse a symlink.");
  const canonical = realpathSync(path);
  if (!pathIsWithin(root, canonical)) throw new Error("Task artifact storage resolves outside the workspace.");
  return canonical;
}

function taskArtifactRoot(cwd: string): string {
  const requestedRoot = resolve(cwd);
  const workspace = lstatSync(requestedRoot);
  if (!workspace.isDirectory() || workspace.isSymbolicLink()) throw new Error("Task artifact workspace must be a real directory, not a symlink.");
  const root = realpathSync(requestedRoot);
  const configDir = ensureRealDirectory(root, CONFIG_DIR_NAME);
  const tasksDir = ensureRealDirectory(configDir, "tasks");
  const ignorePath = join(tasksDir, ".gitignore");
  if (existsSync(ignorePath)) {
    const stat = lstatSync(ignorePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Task artifact ignore file must be a regular file, not a symlink.");
  } else {
    try {
      writeFileSync(ignorePath, TASKS_GITIGNORE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(ignorePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Task artifact ignore file must be a regular file, not a symlink.");
    }
  }
  return tasksDir;
}

/**
 * Creates the extension-owned task ignore file without modifying repository-level
 * ignore policy. Every ancestor is checked before a task artifact is written.
 */
export function ensureTaskArtifactsPrivate(cwd: string): void {
  taskArtifactRoot(cwd);
}

/** Ensures one generated task directory is real and remains within private task storage. */
export function ensureTaskArtifactDirectory(cwd: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Task artifact storage requires a safe generated task ID.");
  return ensureRealDirectory(taskArtifactRoot(cwd), taskId);
}

export function taskRoot(cwd: string): string {
  return resolve(cwd, CONFIG_DIR_NAME, "tasks");
}

export function taskDir(cwd: string, taskId: string): string {
  return join(taskRoot(cwd), taskId);
}

export function statePathFor(cwd: string, taskId: string): string {
  return join(taskDir(cwd, taskId), "state.json");
}

export function scratchpadPathFor(cwd: string, taskId: string): string {
  return join(taskDir(cwd, taskId), "scratchpad.md");
}

export function latestPointerPath(cwd: string): string {
  return join(taskRoot(cwd), "latest.json");
}

export function archivedMarkerPath(cwd: string, taskId: string): string {
  return join(taskDir(cwd, taskId), ".archived");
}

export function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return rel;
  return absolutePath;
}
