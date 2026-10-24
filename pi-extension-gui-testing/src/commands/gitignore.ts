/**
 * Keeping `.pi/gui.local.json` out of Git (spec §7): when a command writes it
 * in a Git work tree where it is not ignored, offer once to add it to the
 * project's `.gitignore`. With `--fix` the line is added without asking;
 * with `--no-fix`, or without a UI and without `--fix`, nothing is changed
 * and the report warns. Symlinks and special files are never written.
 * Git runs with the same hardened settings as the sync enumeration.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_PERSONAL_FILE } from "../config/types.ts";
import type { CommandRunner } from "../runner/types.ts";
import { SAFE_GIT_ENV, safeGitArgv } from "../sync/git.ts";

export type IgnoreState = { state: "ignored" | "not-ignored" | "no-repo" } | { state: "unknown"; reason: string };

/** Whether Git ignores `.pi/gui.local.json` in `projectRoot` (by ignore rules, tracked or not). */
export async function localConfigIgnoreState(runner: CommandRunner, projectRoot: string, signal?: AbortSignal): Promise<IgnoreState> {
  const options = { timeoutMs: 10_000, signal, env: { ...SAFE_GIT_ENV } };
  try {
    const inside = await runner.run(safeGitArgv(projectRoot, ["rev-parse", "--is-inside-work-tree"]), options);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { state: "no-repo" };
    const check = await runner.run(safeGitArgv(projectRoot, ["check-ignore", "-q", "--no-index", PROJECT_PERSONAL_FILE]), options);
    if (check.exitCode === 0) return { state: "ignored" };
    if (check.exitCode === 1) return { state: "not-ignored" };
    return { state: "unknown", reason: (check.stderr || check.stdout).trim().split("\n")[0] || `git check-ignore exit ${check.exitCode}` };
  } catch (error) {
    // No Git on PATH: nothing can be committed by accident either.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "no-repo" };
    if (signal?.aborted) throw error;
    return { state: "unknown", reason: (error as Error).message };
  }
}

/** `.gitignore` is not a regular file the command may write (a symlink, FIFO, device, directory, …). */
export class GitignoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitignoreRefusedError";
  }
}

const OPEN_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Appends `.pi/gui.local.json` to `<projectRoot>/.gitignore` (created if
 * missing). The file is opened without following a symlink (`O_NOFOLLOW`),
 * without blocking on a FIFO (`O_NONBLOCK`), and created only with `O_EXCL`;
 * the descriptor must be a regular file, and the read and the append go
 * through it, so a link can never redirect the write outside the project.
 *
 * @throws GitignoreRefusedError for symlinks and special files.
 */
export async function addLocalConfigToGitignore(projectRoot: string): Promise<void> {
  const path = join(projectRoot, ".gitignore");
  let handle: FileHandle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new GitignoreRefusedError(`${path} is a symbolic link`);
    if (code === "EISDIR" || code === "ENXIO") throw new GitignoreRefusedError(`${path} is not a regular file`);
    if (code !== "ENOENT") throw error;
    try {
      handle = await open(path, OPEN_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o644);
    } catch (createError) {
      const createCode = (createError as NodeJS.ErrnoException).code;
      // A dangling symlink, or something created in between: never write through it.
      if (createCode === "EEXIST" || createCode === "ELOOP") throw new GitignoreRefusedError(`${path} appeared while it was being created (or is a dangling symbolic link)`);
      throw createError;
    }
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new GitignoreRefusedError(`${path} is not a regular file`);
    let separator = "";
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      const { bytesRead } = await handle.read(last, 0, 1, info.size - 1);
      if (bytesRead === 1 && last[0] !== 0x0a) separator = "\n";
    }
    await handle.write(`${separator}${PROJECT_PERSONAL_FILE}\n`);
  } finally {
    await handle.close();
  }
}

export interface IgnoreOfferOptions {
  runner: CommandRunner;
  projectRoot: string;
  /** `--fix`: add the line without asking. */
  fix: boolean;
  /** `--no-fix`: report only; never ask, never write. */
  noFix?: boolean;
  /** Present only with an interactive UI; asked at most once. Use the setup dialog adapter (signal and timeout). */
  confirm?: (title: string, message: string) => Promise<boolean>;
  signal?: AbortSignal;
}

/** Result for the command report: a line, and whether it is a warning. */
export interface IgnoreOfferResult {
  line?: string;
  warning: boolean;
}

/** Checks, offers or applies, and describes the outcome (see the module comment). */
export async function offerLocalConfigIgnore(options: IgnoreOfferOptions): Promise<IgnoreOfferResult> {
  const status = await localConfigIgnoreState(options.runner, options.projectRoot, options.signal);
  if (status.state === "no-repo" || status.state === "ignored") return { warning: false };
  if (status.state === "unknown") {
    return { line: `warning: could not check whether Git ignores ${PROJECT_PERSONAL_FILE} (${status.reason}); make sure it is not committed`, warning: true };
  }
  const notIgnored = `warning: ${PROJECT_PERSONAL_FILE} holds personal settings but Git does not ignore it; add it to .gitignore so it is not committed`;
  if (options.noFix) return { line: `${notIgnored} (--no-fix: .gitignore was not changed)`, warning: true };
  let apply = options.fix;
  if (!apply && options.confirm) {
    try {
      apply = await options.confirm(`Keep ${PROJECT_PERSONAL_FILE} out of Git?`, `It holds your personal GUI testing settings. Add "${PROJECT_PERSONAL_FILE}" to .gitignore?`);
    } catch (error) {
      if (options.signal?.aborted || (error as Error)?.name === "AbortError") return { line: `${notIgnored} (cancelled: .gitignore was not changed)`, warning: true };
      throw error;
    }
    if (!apply) return { line: notIgnored, warning: true };
  }
  if (!apply) return { line: `${notIgnored} (or re-run with --fix to add it)`, warning: true };
  // The last chance to honour a cancel (shutdown, /gui-cleanup, a dialog timeout) before writing.
  if (options.signal?.aborted) return { line: `${notIgnored} (cancelled: .gitignore was not changed)`, warning: true };
  try {
    await addLocalConfigToGitignore(options.projectRoot);
  } catch (error) {
    if (!(error instanceof GitignoreRefusedError)) throw error;
    return { line: `warning: did not add ${PROJECT_PERSONAL_FILE} to .gitignore: ${error.message}; add the line yourself so the file is not committed`, warning: true };
  }
  const after = await localConfigIgnoreState(options.runner, options.projectRoot, options.signal);
  if (after.state !== "ignored") return { line: `added ${PROJECT_PERSONAL_FILE} to .gitignore, but Git still does not ignore it; check your ignore rules`, warning: true };
  return { line: `added ${PROJECT_PERSONAL_FILE} to .gitignore`, warning: false };
}
