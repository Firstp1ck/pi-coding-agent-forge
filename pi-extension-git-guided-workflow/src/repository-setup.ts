import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  GuidedGitError,
  planStagePaths,
  preflightRepository,
  readRemotes,
  sanitizeDiagnostic,
  type CommandPlan,
  type GitResult,
  type GitRunner,
  type RepositoryState,
  runGit,
} from "./core.ts";

const GH_TIMEOUT_MS = 30_000;
const GH_TERMINATION_TIMEOUT_MS = 5_000;
const GH_OUTPUT_MAX_BYTES = 1024 * 1024;
const STARTER_README = "README.md";
const STARTER_GITIGNORE = ".gitignore";
export const STARTER_FILE_PATHS = Object.freeze([STARTER_README, STARTER_GITIGNORE] as const);
export type StarterFilePath = (typeof STARTER_FILE_PATHS)[number];

export type GhRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;
export type WorkflowMutationGuard = () => void;

function assertMutationCurrent(guard?: WorkflowMutationGuard): void {
  guard?.();
}

/** Run the system GitHub CLI without a shell, prompts, or unbounded output. */
export const runGh: GhRunner = (cwd, args) => new Promise((resolve, reject) => {
  const child = spawn("gh", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", LC_ALL: "C" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let stopError: GuidedGitError | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  const finish = (error?: Error, result?: GitResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(operationTimer);
    if (terminationTimer) clearTimeout(terminationTimer);
    if (error) reject(error);
    else resolve(result!);
  };
  const stop = (error: GuidedGitError) => {
    if (stopError || settled) return;
    stopError = error;
    clearTimeout(operationTimer);
    try { child.kill("SIGKILL"); } catch { /* The close barrier or watchdog decides. */ }
    terminationTimer = setTimeout(() => finish(new GuidedGitError(
      "GH_TERMINATION_UNCONFIRMED",
      "The GitHub CLI was asked to stop, but direct-child termination could not be confirmed; the result is uncertain",
      { causeCode: error.code, terminationConfirmed: false },
    )), GH_TERMINATION_TIMEOUT_MS);
  };
  const operationTimer = setTimeout(() => stop(new GuidedGitError("GH_TIMEOUT", `The GitHub CLI timed out after ${GH_TIMEOUT_MS} ms`)), GH_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopError) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > GH_OUTPUT_MAX_BYTES) return stop(new GuidedGitError("GH_OUTPUT_TOO_LARGE", "The GitHub CLI output exceeded its bounded limit"));
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stopError) return;
    stderrBytes += chunk.length;
    if (stderrBytes > GH_OUTPUT_MAX_BYTES) return stop(new GuidedGitError("GH_OUTPUT_TOO_LARGE", "The GitHub CLI diagnostic output exceeded its bounded limit"));
    stderr.push(Buffer.from(chunk));
  });
  child.on("error", (error) => {
    if (!stopError) finish(new GuidedGitError("GH_SPAWN_FAILED", sanitizeDiagnostic(error.message)));
  });
  child.on("close", (exitCode) => {
    if (stopError) {
      stopError.details = { ...stopError.details, terminationConfirmed: true, closeExitCode: exitCode };
      finish(stopError);
      return;
    }
    finish(undefined, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, timedOut: false });
  });
});

function commandFailure(code: string, label: string, result: GitResult): GuidedGitError {
  const diagnostic = sanitizeDiagnostic(result.stderr.length ? result.stderr : result.stdout);
  return new GuidedGitError(code, diagnostic || `${label} failed with exit code ${result.exitCode ?? "unknown"}`);
}

async function requireGit(root: string, args: readonly string[], runner: GitRunner): Promise<Buffer> {
  const result = await runner(root, args);
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("GIT_COMMAND_FAILED", `git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

interface DirectoryIdentity {
  root: string;
  device: number;
  inode: number;
}

async function directoryIdentity(cwd: string): Promise<DirectoryIdentity> {
  const root = await realpath(path.resolve(cwd)).catch(() => undefined);
  if (!root) throw new GuidedGitError("INVALID_REPOSITORY_DIRECTORY", "The target directory does not exist");
  const info = await stat(root);
  if (!info.isDirectory()) throw new GuidedGitError("INVALID_REPOSITORY_DIRECTORY", "The target must be a directory");
  return { root, device: info.dev, inode: info.ino };
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const actual = await directoryIdentity(expected.root);
  if (actual.root !== expected.root || actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new GuidedGitError("REPOSITORY_DIRECTORY_CHANGED", "The target directory changed after confirmation");
  }
}

async function assertNotRepository(root: string, runner: GitRunner): Promise<void> {
  const result = await runner(root, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode === 0) throw new GuidedGitError("ALREADY_REPOSITORY", "The target is already inside a Git repository");
  const diagnostic = result.stderr.length ? result.stderr.toString("utf8") : result.stdout.toString("utf8");
  if (!result.timedOut && result.exitCode === 128 && /not a git repository/iu.test(diagnostic)) return;
  throw commandFailure("GIT_COMMAND_FAILED", "Git repository check", result);
}

export interface RepositoryInitializationPlan extends DirectoryIdentity {
  command: CommandPlan;
  initialBranch: "main";
}

/** Bind a non-repository directory to a conservative `main` initialization command. */
export async function planRepositoryInitialization(cwd: string, runner: GitRunner = runGit): Promise<RepositoryInitializationPlan> {
  const identity = await directoryIdentity(cwd);
  await assertNotRepository(identity.root, runner);
  return { ...identity, command: { command: "git", args: ["init", "--initial-branch=main", "--"] }, initialBranch: "main" };
}

/** Revalidate and execute an initialization plan, then verify the resulting unborn repository. */
export async function executeRepositoryInitialization(
  plan: RepositoryInitializationPlan,
  runner: GitRunner = runGit,
  options: { assertCurrent?: WorkflowMutationGuard } = {},
): Promise<RepositoryState> {
  if (plan.command.command !== "git" || plan.initialBranch !== "main"
    || JSON.stringify(plan.command.args) !== JSON.stringify(["init", "--initial-branch=main", "--"])) {
    throw new GuidedGitError("INVALID_INITIALIZATION_PLAN", "The repository initialization command changed after planning");
  }
  await assertDirectoryIdentity(plan);
  await assertNotRepository(plan.root, runner);
  assertMutationCurrent(options.assertCurrent);
  const result = await runner(plan.root, plan.command.args);
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("INITIALIZATION_FAILED", "Git initialization", result);
  const state = await preflightRepository(plan.root, runner);
  if (state.root !== plan.root || state.branch !== "main" || state.headOid !== null) {
    throw new GuidedGitError("INITIALIZATION_UNEXPECTED_RESULT", "Git initialized an unexpected repository state; do not retry automatically");
  }
  return state;
}

export interface StarterFilePlanEntry {
  relativePath: StarterFilePath;
  absolutePath: string;
  status: "create" | "preserve" | "blocked";
  content: string | null;
  reason: string | null;
}

export interface StarterFilesPlan extends DirectoryIdentity {
  branch: string;
  headOid: string | null;
  entries: StarterFilePlanEntry[];
}

function starterContents(root: string): Record<StarterFilePath, string> {
  const name = validatePublicationRepositoryName(path.basename(root), false) ?? "Project";
  return {
    [STARTER_README]: `# ${name}\n`,
    [STARTER_GITIGNORE]: "# Operating system metadata\n.DS_Store\nThumbs.db\n",
  };
}

async function starterEntry(root: string, relativePath: StarterFilePath, content: string): Promise<StarterFilePlanEntry> {
  const absolutePath = path.join(root, relativePath);
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { relativePath, absolutePath, status: "blocked", content: null, reason: "The path exists but is not a regular non-symlink file." };
    }
    return { relativePath, absolutePath, status: "preserve", content: null, reason: "The existing file will not be overwritten or staged automatically." };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { relativePath, absolutePath, status: "create", content, reason: null };
  }
}

/** Inspect conservative root-level starter files without creating or overwriting either path. */
export async function planStarterFiles(root: string, runner: GitRunner = runGit): Promise<StarterFilesPlan> {
  const state = await preflightRepository(root, runner);
  const identity = await directoryIdentity(state.root);
  const contents = starterContents(identity.root);
  const entries = await Promise.all(STARTER_FILE_PATHS.map((relativePath) => starterEntry(identity.root, relativePath, contents[relativePath])));
  return { ...identity, branch: state.branch, headOid: state.headOid, entries };
}

async function revalidateStarterPlan(plan: StarterFilesPlan, runner: GitRunner): Promise<void> {
  await assertDirectoryIdentity(plan);
  const state = await preflightRepository(plan.root, runner);
  if (state.root !== plan.root) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed before starter-file creation");
  if (state.branch !== plan.branch) throw new GuidedGitError("BRANCH_CHANGED", "The branch changed before starter-file creation");
  if (state.headOid !== plan.headOid) throw new GuidedGitError("HEAD_CHANGED", "HEAD changed before starter-file creation");
}

export interface StarterFilesWriteResult {
  root: string;
  branch: string;
  headOid: string | null;
  created: StarterFilePath[];
  paths: string[];
  createdFiles: Array<{ relativePath: StarterFilePath; absolutePath: string; sha256: string }>;
}

/** Create only explicitly selected, previously absent starter files and roll back safe partial writes. */
export async function executeStarterFiles(
  plan: StarterFilesPlan,
  selectedPaths: readonly StarterFilePath[],
  runner: GitRunner = runGit,
  operations: {
    openFile?: (file: string, flags: "wx", mode: number) => Promise<Pick<FileHandle, "stat" | "writeFile" | "sync" | "close">>;
    assertCurrent?: WorkflowMutationGuard;
  } = {},
): Promise<StarterFilesWriteResult> {
  if (!Array.isArray(selectedPaths) || selectedPaths.length === 0 || new Set(selectedPaths).size !== selectedPaths.length) {
    throw new GuidedGitError("INVALID_STARTER_SELECTION", "Select one or more distinct starter files to create");
  }
  const expectedContents = starterContents(plan.root);
  const selected = selectedPaths.map((relativePath: StarterFilePath) => {
    const entry = plan.entries.find((candidate) => candidate.relativePath === relativePath);
    const expectedPath = path.join(plan.root, relativePath);
    if (!STARTER_FILE_PATHS.includes(relativePath) || !entry || entry.status !== "create"
      || entry.absolutePath !== expectedPath || entry.content !== expectedContents[relativePath]) {
      throw new GuidedGitError("INVALID_STARTER_SELECTION", "Only unchanged starter-file plans for confirmed absent paths can be created");
    }
    return entry;
  });
  await revalidateStarterPlan(plan, runner);
  assertMutationCurrent(operations.assertCurrent);
  for (const entry of selected) {
    const current = await lstat(entry.absolutePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (current !== null) throw new GuidedGitError("STARTER_PATH_CHANGED", `${entry.relativePath} appeared after confirmation; no starter file was overwritten`);
  }

  const openFile = operations.openFile ?? open;
  const created: Array<StarterFilePlanEntry & { device: number; inode: number }> = [];
  try {
    for (const entry of selected) {
      assertMutationCurrent(operations.assertCurrent);
      const handle = await openFile(entry.absolutePath, "wx", 0o644);
      let info: Awaited<ReturnType<typeof handle.stat>>;
      try {
        info = await handle.stat();
      } catch (error) {
        let closeError: unknown;
        try { await handle.close(); }
        catch (caught) { closeError = caught; }
        throw new GuidedGitError(
          "STARTER_OWNERSHIP_UNVERIFIED",
          `${entry.relativePath} was exclusively created, but its ownership could not be verified. The unproven partial file was preserved for manual inspection.`,
          { cause: sanitizeDiagnostic(String(error)), close: closeError ? sanitizeDiagnostic(String(closeError)) : undefined },
        );
      }
      created.push({ ...entry, device: info.dev, inode: info.ino });
      try { await handle.writeFile(entry.content!, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    }
    await revalidateStarterPlan(plan, runner);
    return {
      root: plan.root,
      branch: plan.branch,
      headOid: plan.headOid,
      created: selectedPaths.slice() as StarterFilePath[],
      paths: selected.map((entry) => entry.absolutePath),
      createdFiles: selected.map((entry) => ({
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        sha256: createHash("sha256").update(entry.content!).digest("hex"),
      })),
    };
  } catch (error) {
    let rollbackError: unknown;
    for (const entry of [...created].reverse()) {
      try {
        const [info, bytes] = await Promise.all([lstat(entry.absolutePath), readFile(entry.absolutePath)]);
        const expected = Buffer.from(entry.content!, "utf8");
        if (info.isFile() && !info.isSymbolicLink() && info.dev === entry.device && info.ino === entry.inode
          && expected.subarray(0, bytes.length).equals(bytes)) {
          await rm(entry.absolutePath);
        } else {
          throw new Error(`${entry.relativePath} changed after creation`);
        }
      } catch (caught) { rollbackError ??= caught; }
    }
    if (rollbackError) {
      throw new GuidedGitError("STARTER_ROLLBACK_FAILED", "Starter-file creation failed and a partial write could not be rolled back safely", {
        cause: sanitizeDiagnostic(String(error)), rollback: sanitizeDiagnostic(String(rollbackError)),
      });
    }
    throw error;
  }
}

/** Stage only the explicitly selected paths created by one starter-file execution. */
export async function executeStarterFileStaging(
  write: StarterFilesWriteResult,
  selectedPaths: readonly StarterFilePath[],
  runner: GitRunner = runGit,
  options: { assertCurrent?: WorkflowMutationGuard } = {},
): Promise<CommandPlan> {
  if (path.resolve(write.root) !== write.root || selectedPaths.some((candidate) => !write.created.includes(candidate))) {
    throw new GuidedGitError("INVALID_STARTER_SELECTION", "Only starter files created by this execution can be staged");
  }
  const state = await preflightRepository(write.root, runner);
  if (state.root !== write.root) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed before starter-file staging");
  if (state.branch !== write.branch) throw new GuidedGitError("BRANCH_CHANGED", "The branch changed before starter-file staging");
  if (state.headOid !== write.headOid) throw new GuidedGitError("HEAD_CHANGED", "HEAD changed before starter-file staging");
  const expectedContents = starterContents(write.root);
  for (const relativePath of selectedPaths) {
    const expectedPath = path.join(write.root, relativePath);
    const record = write.createdFiles.find((candidate) => candidate.relativePath === relativePath);
    const info = await lstat(expectedPath).catch(() => null);
    const bytes = info?.isFile() && !info.isSymbolicLink() ? await readFile(expectedPath) : null;
    const expectedHash = createHash("sha256").update(expectedContents[relativePath]).digest("hex");
    if (!record || record.absolutePath !== expectedPath || record.sha256 !== expectedHash || !bytes
      || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new GuidedGitError("STARTER_PATH_CHANGED", `${relativePath} changed before staging; no path was staged`);
    }
  }
  const plan = planStagePaths(selectedPaths);
  assertMutationCurrent(options.assertCurrent);
  const result = await runner(write.root, plan.args);
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure("STARTER_STAGE_FAILED", "Starter-file staging", result);
  return plan;
}

export type PublicationVisibility = "public" | "private";
export interface PublicationPlan {
  root: string;
  branch: string;
  headOid: string;
  host: "github.com";
  account: string;
  repositoryName: string;
  qualifiedRepository: string;
  visibility: PublicationVisibility;
  command: "gh";
  args: string[];
}

function validatePublicationRepositoryName(value: string, required = true): string | null {
  if (/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/u.test(value)) return value;
  if (!required) return null;
  throw new GuidedGitError("INVALID_PUBLICATION_NAME", "The repository directory name is not a safe GitHub repository name (1-100 letters, digits, dots, underscores, or hyphens)");
}

async function requireGhAuthentication(root: string, runner: GhRunner): Promise<{ host: "github.com"; account: string }> {
  const host = "github.com" as const;
  const version = await runner(root, ["--version"]);
  if (version.exitCode !== 0 || version.timedOut) throw commandFailure("GH_UNAVAILABLE", "GitHub CLI discovery", version);
  const auth = await runner(root, ["auth", "status", "--hostname", host]);
  if (auth.exitCode !== 0 || auth.timedOut) throw commandFailure("GH_AUTH_REQUIRED", "GitHub CLI authentication", auth);
  const accountResult = await runner(root, ["api", "--hostname", host, "user", "--jq", ".login"]);
  if (accountResult.exitCode !== 0 || accountResult.timedOut) throw commandFailure("GH_ACCOUNT_UNAVAILABLE", "GitHub account discovery", accountResult);
  const account = accountResult.stdout.toString("utf8").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(account) || account.includes("--")) {
    throw new GuidedGitError("INVALID_GITHUB_ACCOUNT", "The authenticated GitHub account name is invalid");
  }
  return { host, account };
}

async function publicationState(cwd: string, runner: GitRunner): Promise<RepositoryState & { repositoryName: string }> {
  const state = await preflightRepository(cwd, runner);
  if (!state.headOid) throw new GuidedGitError("MISSING_HEAD", "Publish requires an existing HEAD commit");
  if ((await readRemotes(state.root, runner)).length !== 0) throw new GuidedGitError("PUBLICATION_REMOTE_EXISTS", "Publish is available only when no Git remote exists");
  return { ...state, repositoryName: validatePublicationRepositoryName(path.basename(state.root))! };
}

/** Capture the exact local publication target; visibility must already be explicitly selected. */
export async function planRepositoryPublication(
  cwd: string,
  visibility: PublicationVisibility,
  options: { gitRunner?: GitRunner; ghRunner?: GhRunner } = {},
): Promise<PublicationPlan> {
  if (visibility !== "public" && visibility !== "private") throw new GuidedGitError("PUBLICATION_VISIBILITY_REQUIRED", "Select Public or Private explicitly before publication");
  const ghRunner = options.ghRunner ?? runGh;
  const gitRunner = options.gitRunner ?? runGit;
  const identity = await directoryIdentity(cwd);
  const { host, account } = await requireGhAuthentication(identity.root, ghRunner);
  const state = await publicationState(identity.root, gitRunner);
  const qualifiedRepository = `${host}/${account}/${state.repositoryName}`;
  return {
    root: state.root,
    branch: state.branch,
    headOid: state.headOid!,
    host,
    account,
    repositoryName: state.repositoryName,
    qualifiedRepository,
    visibility,
    command: "gh",
    args: ["repo", "create", qualifiedRepository, `--${visibility}`, "--source", state.root, "--remote", "origin", "--push"],
  };
}

/** Recheck authentication, canonical root, immutable HEAD/branch, and no-remotes immediately before gh. */
export async function revalidateRepositoryPublication(
  plan: PublicationPlan,
  options: { gitRunner?: GitRunner; ghRunner?: GhRunner } = {},
): Promise<void> {
  const expectedQualifiedRepository = `${plan.host}/${plan.account}/${plan.repositoryName}`;
  const expectedArgs = ["repo", "create", expectedQualifiedRepository, `--${plan.visibility}`, "--source", plan.root, "--remote", "origin", "--push"];
  if (plan.command !== "gh" || plan.host !== "github.com"
    || plan.qualifiedRepository !== expectedQualifiedRepository
    || (plan.visibility !== "public" && plan.visibility !== "private")
    || path.resolve(plan.root) !== plan.root || JSON.stringify(plan.args) !== JSON.stringify(expectedArgs)) {
    throw new GuidedGitError("INVALID_PUBLICATION_PLAN", "The publication target changed after planning");
  }
  const ghRunner = options.ghRunner ?? runGh;
  const gitRunner = options.gitRunner ?? runGit;
  const identity = await requireGhAuthentication(plan.root, ghRunner);
  if (identity.host !== plan.host || identity.account !== plan.account) {
    throw new GuidedGitError("GITHUB_IDENTITY_CHANGED", "The authenticated GitHub host or account changed after confirmation");
  }
  const state = await publicationState(plan.root, gitRunner);
  if (state.root !== plan.root) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed before publication");
  if (state.branch !== plan.branch) throw new GuidedGitError("BRANCH_CHANGED", "The branch changed before publication");
  if (state.headOid !== plan.headOid) throw new GuidedGitError("HEAD_CHANGED", "HEAD changed before publication");
  if (state.repositoryName !== plan.repositoryName) throw new GuidedGitError("PUBLICATION_NAME_CHANGED", "The publication repository name changed");
}

export interface PublicationExecutionResult {
  status: "published" | "uncertain";
  diagnostic: string;
  invoked: true;
}

/** Invoke one confirmed publication exactly once; uncertain outcomes are returned without retry or cleanup. */
export async function executeRepositoryPublication(
  plan: PublicationPlan,
  options: { gitRunner?: GitRunner; ghRunner?: GhRunner; assertCurrent?: WorkflowMutationGuard } = {},
): Promise<PublicationExecutionResult> {
  const ghRunner = options.ghRunner ?? runGh;
  await revalidateRepositoryPublication(plan, options);
  assertMutationCurrent(options.assertCurrent);
  try {
    const result = await ghRunner(plan.root, plan.args);
    if (result.exitCode === 0 && !result.timedOut) {
      return { status: "published", diagnostic: sanitizeDiagnostic(result.stdout), invoked: true };
    }
    return {
      status: "uncertain",
      diagnostic: sanitizeDiagnostic(result.stderr.length ? result.stderr : result.stdout) || "The GitHub CLI returned an unsuccessful or timed-out result",
      invoked: true,
    };
  } catch (error) {
    return { status: "uncertain", diagnostic: sanitizeDiagnostic(error instanceof Error ? error.message : String(error)), invoked: true };
  }
}
