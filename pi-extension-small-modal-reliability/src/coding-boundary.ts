import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { builtinModules } from "node:module";

import { taskDir } from "./paths.ts";
import { normalizeScopePath, scopeFingerprint } from "./scope-state.ts";
import { CODING_REVIEW_KINDS } from "./types.ts";
import type { CodingBoundary, CodingBoundaryFile, CodingChange, CodingReviewKind, Criterion, TaskState } from "./types.ts";
import { nowIso } from "./utils.ts";
import { captureWorkspaceRevision } from "./workspace-revision.ts";

const MAX_BASELINE_FILES = 10_000;
const MAX_BASELINE_BYTES = 20 * 1024 * 1024;
const MAX_BASELINE_DEPTH = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_DIRECTORIES = 5_000;
const MAX_BASELINE_ELAPSED_MS = 2_000;
const BASELINE_FILE = "coding-baseline.json";
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const TEST_PATH = /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const SECURITY_PATH = /(?:^|[\/_.-])(auth|security|crypto|password|secret|token|permission|access|acl)(?:[\/_.-]|$)/i;

export type CodingChangeAssessment = {
  changes: CodingChange[];
  diff_hash: string;
  reasons: string[];
  complete: boolean;
};

export type ImportAssessment = {
  packages: string[];
  /** Parser ambiguity and non-code changes require an exact-diff local-only disposition. */
  local_only_paths: string[];
  reasons: string[];
};

type BaselineArtifact = {
  schema_version: 1;
  task_id: string;
  branch_id: string;
  captured_at: string;
  files: CodingBoundaryFile[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Creates task storage one checked segment at a time; recursive mkdir would follow a .pi/tasks symlink. */
function checkedBaselineDirectory(state: TaskState, create: boolean): string {
  const root = realpathSync(state.cwd);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Coding baseline workspace root must be a real directory.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.task_id)) throw new Error("Coding baseline task ID is not path-safe.");
  let current = root;
  for (const segment of [".pi", "tasks", state.task_id]) {
    const candidate = join(current, segment);
    if (!pathIsWithin(root, candidate)) throw new Error("Coding baseline path escaped the workspace root.");
    let stat = lstatIfExists(candidate);
    if (!stat) {
      if (!create) throw new Error("Coding baseline directory is absent.");
      const parent = lstatSync(current);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Coding baseline ancestor must be a real directory.");
      mkdirSync(candidate, { mode: 0o700 });
      stat = lstatSync(candidate);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Coding baseline ancestor must be a real directory, not a symlink.");
    const canonical = realpathSync(candidate);
    if (!pathIsWithin(root, canonical)) throw new Error("Coding baseline ancestor resolves outside the workspace root.");
    current = canonical;
  }
  return current;
}

function ignored(relativePath: string): boolean {
  const [first, second] = relativePath.split("/");
  return first === ".git" || first === "node_modules" || (first === ".pi" && ["tasks", "npm", "git"].includes(second ?? ""));
}

function inventory(cwd: string): { files: CodingBoundaryFile[]; complete: boolean; reason?: string } {
  const root = resolve(cwd);
  const files: CodingBoundaryFile[] = [];
  let totalBytes = 0;
  let directories = 0;
  const startedAt = Date.now();
  let reason: string | undefined;
  const visit = (directory: string, depth: number): void => {
    if (reason) return;
    if (Date.now() - startedAt > MAX_BASELINE_ELAPSED_MS) {
      reason = "Coding baseline inventory exceeded its elapsed-time bound.";
      return;
    }
    if (++directories > MAX_BASELINE_DIRECTORIES) {
      reason = "Coding baseline inventory exceeded its directory-count bound.";
      return;
    }
    if (depth > MAX_BASELINE_DEPTH) {
      reason = "Coding baseline inventory exceeded its directory depth bound.";
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      reason = "Coding baseline inventory could not read a directory.";
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (reason) return;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, "/");
      if (!path || ignored(path)) continue;
      try {
        const stat = lstatSync(absolute);
        if (stat.isDirectory()) {
          visit(absolute, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          reason = "Coding baseline inventory encountered an unsupported non-regular path.";
          return;
        }
        if (stat.size > MAX_FILE_BYTES || files.length >= MAX_BASELINE_FILES || totalBytes + stat.size > MAX_BASELINE_BYTES) {
          reason = "Coding baseline inventory exceeded its bounded file or byte limit.";
          return;
        }
        const bytes = readFileSync(absolute);
        if (bytes.length !== stat.size) {
          reason = "Coding baseline inventory observed an unstable file.";
          return;
        }
        totalBytes += bytes.length;
        files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
      } catch {
        reason = "Coding baseline inventory could not read a file.";
      }
    }
  };
  visit(root, 0);
  return { files, complete: !reason, reason };
}

function baselinePath(state: TaskState, create = false): string {
  const directory = checkedBaselineDirectory(state, create);
  const path = resolve(directory, BASELINE_FILE);
  if (!pathIsWithin(directory, path)) throw new Error("Coding baseline path escaped its task directory.");
  if (lstatIfExists(path)?.isSymbolicLink()) throw new Error("Coding baseline artifact cannot be a symlink.");
  return path;
}

function writeArtifact(path: string, artifact: BaselineArtifact): string {
  if (lstatIfExists(path)?.isSymbolicLink()) throw new Error("Coding baseline artifact cannot be a symlink.");
  const content = `${JSON.stringify(artifact)}\n`;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (lstatIfExists(temp)) throw new Error("Coding baseline temporary artifact already exists.");
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (lstatIfExists(path)?.isSymbolicLink()) throw new Error("Coding baseline artifact became a symlink during write.");
    renameSync(temp, path);
  } finally {
    if (existsSync(temp) && !lstatSync(temp).isSymbolicLink()) unlinkSync(temp);
  }
  return sha256(content);
}

/** Captures task baseline before any agent mutation; a later coding scope may only bind it, never replace it. */
export function captureCodingBoundary(state: TaskState): CodingBoundary {
  if (state.coding_boundary.status === "captured" || state.coding_boundary.status === "missing") return state.coding_boundary;
  const current = captureWorkspaceRevision(state.cwd);
  const snapshot = inventory(state.cwd);
  if (!current.inventory_complete || !snapshot.complete) {
    state.coding_boundary = {
      status: "missing",
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      allowed_write_paths: [],
      reason: current.reason ?? snapshot.reason ?? "Coding baseline could not be captured before task work.",
    };
    return state.coding_boundary;
  }
  const artifact: BaselineArtifact = {
    schema_version: 1,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    captured_at: nowIso(),
    files: snapshot.files,
  };
  try {
    const path = baselinePath(state, true);
    const artifactHash = writeArtifact(path, artifact);
    const after = inventory(state.cwd);
    if (!after.complete || JSON.stringify(after.files) !== JSON.stringify(snapshot.files)) {
      state.coding_boundary = {
        status: "missing",
        task_id: state.task_id,
        branch_id: state.task_identity.branch_id,
        allowed_write_paths: [],
        reason: after.reason ?? "Coding baseline inventory changed while its artifact was captured.",
      };
      return state.coding_boundary;
    }
    state.coding_boundary = {
      status: "captured",
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      baseline_path: BASELINE_FILE,
      baseline_sha256: artifactHash,
      baseline_workspace_revision: current.digest,
      allowed_write_paths: [],
      captured_at: artifact.captured_at,
      review_dispositions: [],
      repair_intervals: [],
    };
  } catch (error) {
    state.coding_boundary = {
      status: "missing",
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      allowed_write_paths: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return state.coding_boundary;
}

/** Adds approved coding scope provenance once without resetting a pre-task baseline. */
export function bindCodingBoundaryScope(state: TaskState): void {
  const boundary = state.coding_boundary;
  const scope = state.scope_state.active_scope;
  if (boundary.status !== "captured" || !scope || scope.lane !== "coding") return;
  if (boundary.scope_id !== undefined) return;
  boundary.scope_id = scope.scope_id;
  boundary.scope_hash = scopeFingerprint(scope);
  boundary.allowed_write_paths = [...scope.allowed_write_paths];
}

function loadArtifact(state: TaskState): BaselineArtifact | undefined {
  const boundary = state.coding_boundary;
  if (boundary.status !== "captured" || boundary.baseline_path !== BASELINE_FILE || !boundary.baseline_sha256) return undefined;
  try {
    const path = baselinePath(state);
    const content = readFileSync(path, "utf8");
    if (sha256(content) !== boundary.baseline_sha256) return undefined;
    const artifact = JSON.parse(content) as BaselineArtifact;
    if (artifact.schema_version !== 1 || artifact.task_id !== state.task_id || artifact.branch_id !== state.task_identity.branch_id || !Array.isArray(artifact.files)) return undefined;
    if (artifact.files.some((file) => !file || typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) return undefined;
    return artifact;
  } catch {
    return undefined;
  }
}

export function assessCodingChanges(state: TaskState): CodingChangeAssessment {
  const artifact = loadArtifact(state);
  if (!artifact) return { changes: [], diff_hash: "unknown", complete: false, reasons: [state.coding_boundary.reason ?? "Coding baseline is missing, incomplete, or tampered."] };
  const current = inventory(state.cwd);
  if (!current.complete) return { changes: [], diff_hash: "unknown", complete: false, reasons: [current.reason ?? "Current coding inventory is incomplete."] };
  const before = new Map(artifact.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const changes: CodingChange[] = [];
  for (const [path, file] of before) {
    const currentFile = after.get(path);
    if (!currentFile) changes.push({ path, kind: "deleted", before_sha256: file.sha256 });
    else if (currentFile.sha256 !== file.sha256) changes.push({ path, kind: "modified", before_sha256: file.sha256, after_sha256: currentFile.sha256 });
  }
  for (const [path, file] of after) if (!before.has(path)) changes.push({ path, kind: "added", after_sha256: file.sha256 });
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { changes, diff_hash: sha256(JSON.stringify(changes)), complete: true, reasons: [] };
}

function extension(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0].toLowerCase() ?? "";
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function sourceForChangedFile(state: TaskState, path: string): string | undefined {
  try {
    const absolute = normalizeScopePath(state.cwd, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

/** Conservative import parser: unsupported/dynamic code cannot claim a local-only exemption. */
function sourceWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Conservative import parser: non-code or unparseable changes need exact-diff local-only review, never a silent exemption. */
export function assessChangedCodeImports(state: TaskState, changes: CodingChange[]): ImportAssessment {
  const packages = new Set<string>();
  const localOnly = new Set<string>();
  const reasons: string[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") {
      if (CODE_EXTENSIONS.has(extension(change.path))) localOnly.add(change.path);
      continue;
    }
    const ext = extension(change.path);
    if (!CODE_EXTENSIONS.has(ext)) {
      localOnly.add(change.path);
      continue;
    }
    const source = sourceForChangedFile(state, change.path);
    if (source === undefined) {
      localOnly.add(change.path);
      reasons.push(`Changed source ${change.path} could not be read for dependency analysis.`);
      continue;
    }
    const code = sourceWithoutComments(source);
    if (/\bimport\s*\(|\brequire\s*\([^'"`]/.test(code)) {
      localOnly.add(change.path);
      reasons.push(`Changed source ${change.path} contains dynamic or unsupported module loading.`);
      continue;
    }
    const staticSpecifiers = [
      ...code.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...code.matchAll(/\bimport\s*["']([^"']+)["']/g),
      ...code.matchAll(/\brequire\s*\(\s*["']([^"']+)\s*["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of staticSpecifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (specifier.startsWith("#") || specifier.startsWith("/")) {
        localOnly.add(change.path);
        reasons.push(`Changed source ${change.path} uses an alias or absolute import that requires local-only review.`);
        continue;
      }
      const name = packageName(specifier);
      if (!builtinModules.includes(name) && !builtinModules.includes(`node:${name}`)) packages.add(name);
    }
  }
  return { packages: [...packages].sort(), local_only_paths: [...localOnly].sort(), reasons };
}

export function codingReviewKinds(changes: CodingChange[]): CodingReviewKind[] {
  const kinds: CodingReviewKind[] = [];
  if (changes.some((change) => TEST_PATH.test(change.path))) kinds.push("test-integrity");
  if (changes.some((change) => SECURITY_PATH.test(change.path))) kinds.push("security");
  return kinds;
}

/** Retires old exact-diff review criteria from the active set without erasing their audit disposition. */
function supersedePriorCodingReviews(state: TaskState, currentDiffHash: string): void {
  const boundary = state.coding_boundary;
  boundary.review_dispositions ??= [];
  const superseded = new Set<string>();
  for (const disposition of boundary.review_dispositions) {
    if (disposition.diff_hash === currentDiffHash || disposition.status === "superseded") continue;
    disposition.status = "superseded";
    disposition.superseded_at = nowIso();
    superseded.add(disposition.criterion_id);
  }
  if (superseded.size === 0) return;
  state.criteria = state.criteria.filter((criterion) => !(criterion.origin === "host-coding-review" && superseded.has(criterion.id)));
  state.trusted_check_mappings = state.trusted_check_mappings.filter((mapping) => !superseded.has(mapping.criterion_id));
  state.retired_criterion_ids = [...new Set([...state.retired_criterion_ids, ...superseded])];
  for (const result of state.criterion_results) {
    if (!superseded.has(result.criterion_id)) continue;
    result.status = "unknown";
    result.fresh = false;
    result.remaining_work = "The reviewed diff changed; this review is retained only as historical audit evidence.";
  }
}

/** Adds bounded host safety criteria tied to the exact current diff; they never replace user criteria. */
export function ensureCodingReviewCriteria(state: TaskState, assessment: CodingChangeAssessment, requiresLocalOnlyReview = false): Criterion[] {
  const boundary = state.coding_boundary;
  if (assessment.diff_hash === "unknown") return [];
  supersedePriorCodingReviews(state, assessment.diff_hash);
  boundary.review_dispositions ??= [];
  const created: Criterion[] = [];
  const kinds = codingReviewKinds(assessment.changes);
  if (requiresLocalOnlyReview) kinds.push("local-only");
  for (const kind of CODING_REVIEW_KINDS.filter((kind) => kinds.includes(kind))) {
    const existing = boundary.review_dispositions.find((item) => item.kind === kind && item.diff_hash === assessment.diff_hash && item.status !== "superseded");
    if (existing) continue;
    const criterion: Criterion = {
      id: `C${state.id_counters.next_criterion++}`,
      requirement: `[Host coding review:${kind}:${assessment.diff_hash}] User-confirm the exact current coding diff.`,
      expected_evidence: "user-attestation",
      required: true,
      origin: "host-coding-review",
    };
    state.criteria.push(criterion);
    boundary.review_dispositions.push({ kind, diff_hash: assessment.diff_hash, status: "pending", criterion_id: criterion.id });
    created.push(criterion);
  }
  return created;
}

/** Returns true only for an existing host safety criterion bound to the current exact diff. */
export function recordCodingReviewAttestation(state: TaskState, criterionId: string, attestationId: string): boolean {
  const assessment = assessCodingChanges(state);
  if (!assessment.complete || assessment.diff_hash === "unknown") return false;
  const disposition = state.coding_boundary.review_dispositions?.find((item) => item.criterion_id === criterionId && item.diff_hash === assessment.diff_hash);
  if (!disposition) return false;
  disposition.status = "attested";
  disposition.attestation_id = attestationId;
  disposition.session_id = state.current_session.session_id;
  disposition.session_anchor_entry_id = state.current_session.branch_entry_ids.at(-1);
  return true;
}

export function codingChangeIsInScope(state: TaskState, change: CodingChange): boolean {
  const scope = state.scope_state.active_scope;
  if (!scope || scope.lane !== "coding") return false;
  try {
    const path = normalizeScopePath(state.cwd, change.path);
    return scope.allowed_write_paths.some((boundary) => path === boundary || path.startsWith(`${boundary}/`) || path.startsWith(`${boundary}\\`))
      && !scope.forbidden_paths.some((boundary) => path === boundary || path.startsWith(`${boundary}/`) || path.startsWith(`${boundary}\\`));
  } catch {
    // Deleted paths normalize against workspace root even when absent.
    const path = resolve(state.cwd, change.path);
    return scope.allowed_write_paths.some((boundary) => path === boundary || path.startsWith(`${boundary}/`) || path.startsWith(`${boundary}\\`));
  }
}

function repairCycles(interval: NonNullable<TaskState["coding_boundary"]["repair_intervals"]>[number]) {
  if (interval.cycles) return interval.cycles;
  // Persisted first-correction state counted writes. Preserve it as one historical cycle, never as two attempts.
  const legacy = interval.repair_receipt_ids ?? [];
  interval.cycles = legacy.length > 0
    ? [{ started_by_receipt_id: legacy[0], mutation_receipt_ids: [...legacy], started_at: interval.opened_at }]
    : [];
  delete interval.repair_receipt_ids;
  return interval.cycles;
}

function activeRepairInterval(state: TaskState) {
  return [...(state.coding_boundary.repair_intervals ?? [])].reverse().find((candidate) => !candidate.closed_by_receipt_id);
}

/** A failed trusted validation opens an episode, or closes its active repair cycle; read/tool errors never reach this function. */
export function recordCodingValidationResult(state: TaskState, receiptId: string, status: "passed" | "failed"): void {
  const boundary = state.coding_boundary;
  boundary.repair_intervals ??= [];
  const interval = activeRepairInterval(state);
  if (status === "passed") {
    if (!interval) return;
    const cycle = repairCycles(interval).at(-1);
    if (cycle && !cycle.closed_by_receipt_id) {
      cycle.closed_by_receipt_id = receiptId;
      cycle.outcome = "passed";
      cycle.closed_at = nowIso();
    }
    interval.closed_by_receipt_id = receiptId;
    interval.closed_at = nowIso();
    return;
  }
  if (!interval) {
    boundary.repair_intervals.push({
      failure_receipt_id: receiptId,
      failure_revision: state.workspace_revision.digest,
      step_id: state.current_step_id,
      cycles: [],
      opened_at: nowIso(),
    });
    if (boundary.repair_intervals.length > 24) boundary.repair_intervals.splice(0, boundary.repair_intervals.length - 24);
    return;
  }
  const cycle = repairCycles(interval).at(-1);
  // Repeated validation before a repair leaves the initial failure episode awaiting its first attempt.
  if (!cycle || cycle.closed_by_receipt_id) return;
  cycle.closed_by_receipt_id = receiptId;
  cycle.outcome = "failed";
  cycle.closed_at = nowIso();
}

/** A successful changed mutation starts a repair cycle once, then accumulates all scoped files until validation. */
export function recordCodingRepairMutation(state: TaskState, receiptId: string, changed: boolean): void {
  if (!changed) return;
  const interval = activeRepairInterval(state);
  if (!interval) return;
  const cycles = repairCycles(interval);
  let cycle = cycles.at(-1);
  if (!cycle || cycle.closed_by_receipt_id) {
    if (cycles.length >= 2) return;
    cycle = { started_by_receipt_id: receiptId, mutation_receipt_ids: [], started_at: nowIso() };
    cycles.push(cycle);
  }
  if (!cycle.mutation_receipt_ids.includes(receiptId)) cycle.mutation_receipt_ids.push(receiptId);
}

/** Blocks only the third repair cycle, before its first mutation; any number of files remain valid within either cycle. */
export function codingRepairMutationBlockReason(state: TaskState, toolName: string): string | undefined {
  if (toolName !== "write" && toolName !== "edit") return undefined;
  const interval = activeRepairInterval(state);
  if (!interval) return undefined;
  const cycles = repairCycles(interval);
  const last = cycles.at(-1);
  if (cycles.length < 2 || !last?.closed_by_receipt_id || last.outcome !== "failed") return undefined;
  return "Blocked coding mutation: two failed repair cycles followed the initial failed validation. Run a trusted validation or request a decision before a third repair attempt.";
}

/** Backward-compatible predicate for callers that only need the pre-execution decision. */
export function isMutationAfterFailedValidation(state: TaskState): boolean {
  return Boolean(codingRepairMutationBlockReason(state, "edit"));
}
