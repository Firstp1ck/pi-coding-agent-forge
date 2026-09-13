import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { TaskState } from "./types.ts";
import type { PlanModeRun } from "./plan-mode.ts";

export const PLAN_ARTIFACT_SLOTS = ["exploration", "plan", "summary", "verification", "failure", "final-report"] as const;
const MAX_BYTES = 32_768;
const MAX_FAILURES = 12;
const phaseSlots: Record<string, readonly string[]> = {
  explore: ["exploration"], plan: ["plan"], implement: ["plan", "failure"], summarize: ["summary"],
  verify: ["verification", "failure", "plan"], report: ["final-report"],
};

/** Reject symlink ancestors before creating or opening any package-owned plan artifact. */
export function assertPlanStoragePath(path: string, createParents = false): void {
  const absolute = resolve(path);
  let parent = dirname(absolute);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    // existsSync follows symlinks, so dangling ancestors need a separate lstat.
    try { if (lstatSync(parent).isSymbolicLink()) throw new Error("Plan storage cannot traverse a symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    missing.unshift(parent);
    const next = dirname(parent);
    if (next === parent) throw new Error("Plan storage has no real parent.");
    parent = next;
  }
  for (let current = parent; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Plan storage cannot traverse a symlink or non-directory.");
    if (dirname(current) === current) break;
  }
  if (missing.length && !createParents) throw new Error("Plan artifact parent is missing.");
  for (const directory of missing) mkdirSync(directory, { mode: 0o700 });
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error("Plan artifact cannot be a symlink.");
    if (!stat.isFile()) throw new Error("Plan artifact must be a regular file.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function assertPlanModeOwner(state: TaskState, run: PlanModeRun): void {
  if (!run.enabled || state.task_id !== run.task_id || run.run_id !== state.task_id || resolve(run.cwd) !== resolve(state.cwd)) throw new Error("No matching active plan run.");
  const session = state.current_session;
  if (session.lifecycle_identity !== "available" || !session.session_id || session.session_id !== state.task_identity.session_id
    || !state.task_identity.session_anchor_entry_id || !session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)) throw new Error("Plan artifacts require current task/session/branch anchors.");
  if (state.context_reset.mutation_blocked || state.input_pause) throw new Error("Plan artifacts are paused pending input confirmation or checkpoint recovery.");
}

function artifactPath(state: TaskState, run: PlanModeRun, input: unknown, writing: boolean): string {
  assertPlanModeOwner(state, run);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plan artifact requires an enumerated slot.");
  const value = input as Record<string, unknown>;
  const keys = writing ? ["run_id", "phase", "slot", "failure_index", "expected_sha256", "content"] : ["run_id", "phase", "slot", "failure_index"];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unknown plan artifact field; caller-selected paths are forbidden.");
  if (value.run_id !== run.run_id || value.phase !== run.phase || !phaseSlots[run.phase]) throw new Error("Plan artifact run or phase is stale.");
  if (!PLAN_ARTIFACT_SLOTS.includes(value.slot as typeof PLAN_ARTIFACT_SLOTS[number])) throw new Error("Unknown plan artifact slot.");
  if (writing && !phaseSlots[run.phase].includes(value.slot as string)) throw new Error("Plan artifact slot is not writable in this phase.");
  const names: Record<string, string> = { exploration: "01-exploration.md", plan: "02-implementation-plan.md", summary: "03-summary.md", verification: "04-verification.md", "final-report": "05-final-report.md" };
  let name = names[value.slot as string];
  if (value.slot === "failure") {
    if (!Number.isSafeInteger(value.failure_index) || Number(value.failure_index) < 1 || Number(value.failure_index) > MAX_FAILURES) throw new Error(`Failure slot index must be 1–${MAX_FAILURES}.`);
    name = `failures/failure-${value.failure_index}.md`;
  } else if (value.failure_index !== undefined) throw new Error("Failure index applies only to failure slots.");
  const root = realpathSync(state.cwd);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.task_id)) throw new Error("Unsafe task storage identity.");
  const path = resolve(state.cwd, ".pi", "tasks", state.task_id, "plan-mode", name);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Plan artifact escaped the workspace.");
  assertPlanStoragePath(path, writing);
  return path;
}

function readBounded(path: string): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`Plan artifact exceeds ${MAX_BYTES} bytes or is not a regular file.`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function readPlanModeArtifact(state: TaskState, run: PlanModeRun, input: unknown): { content: string; sha256: string } {
  const content = readBounded(artifactPath(state, run, input, false));
  return { content, sha256: hash(content) };
}

export function writePlanModeArtifact(state: TaskState, run: PlanModeRun, input: unknown): { sha256: string } {
  const path = artifactPath(state, run, input, true);
  const value = input as Record<string, unknown>;
  if (typeof value.content !== "string" || !value.content.trim() || Buffer.byteLength(value.content) > MAX_BYTES
    || typeof value.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_sha256)) throw new Error("Plan artifact needs bounded Markdown and its expected SHA-256.");
  const lock = `${path}.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  try {
    assertPlanStoragePath(path);
    if (hash(readBounded(path)) !== value.expected_sha256) throw new Error("Stale plan artifact content; inspect the slot again before replacement.");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { ftruncateSync(fd, 0); writeFileSync(fd, value.content, "utf8"); } finally { closeSync(fd); }
    return { sha256: hash(value.content) };
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
