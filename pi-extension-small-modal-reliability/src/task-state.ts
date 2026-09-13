import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersistedExtensionState, ReliabilityConfig, SessionBranchIdentity, TaskState, TaskSummary } from "./types.ts";
import { CUSTOM_STATE_TYPE, DEFAULT_CONFIG } from "./types.ts";
import { archivedMarkerPath, ensureTaskArtifactDirectory, latestPointerPath, statePathFor, taskDir, taskRoot } from "./paths.ts";
import { createCriteria, isTaskStateV1, isTaskStateV2, migrateTaskState } from "./state-migration.ts";
import { createScopeState } from "./scope-state.ts";
import { createContextResetState } from "./checkpoint-contracts.ts";
import { createStructuredOutputState } from "./structured-output.ts";
import { createInitialPlan, extractConstraints, extractSuccessCriteria, normalizeGoal, planProgress } from "./planner.ts";
import { writeScratchpad } from "./scratchpad.ts";
import { createAuthoritativeInstructions, createWorkingContext } from "./working-context.ts";
import { captureWorkspaceRevision, workspaceBranchIdentity } from "./workspace-revision.ts";
import { nowIso, readJsonFile, truncate, writeJsonFile } from "./utils.ts";

let scratchpadWritesEnabled = DEFAULT_CONFIG.scratchpadEnabled;

export function setScratchpadWritesEnabled(enabled: boolean): void {
  scratchpadWritesEnabled = enabled;
}

export function createTaskState(
  cwd: string,
  prompt: string,
  sessionFile: string | undefined,
  config: ReliabilityConfig,
  sessionIdentity?: SessionBranchIdentity,
): TaskState {
  const created = nowIso();
  const initialSession = sessionIdentity ?? { branch_entry_ids: [], observed_at: created };
  const sessionAnchor = initialSession.branch_entry_ids.at(-1);
  const successCriteria = extractSuccessCriteria(prompt);
  const workspaceRevision = captureWorkspaceRevision(cwd);
  const taskId = randomUUID();
  return {
    schema_version: 2,
    task_id: taskId,
    created_at: created,
    updated_at: created,
    cwd,
    session_file: sessionFile,
    status: "planning",
    user_goal: prompt,
    normalized_goal: normalizeGoal(prompt),
    success_criteria: successCriteria,
    constraints: extractConstraints(prompt),
    current_phase: "planning",
    current_step_id: "S1",
    plan: createInitialPlan(successCriteria),
    completed_steps: [],
    blocked_steps: [],
    known_facts: [],
    open_questions: [],
    decisions: [],
    tool_history: [],
    files_touched: [],
    read_files: [],
    modified_files: [],
    errors: [],
    loop_warnings: [],
    verification: [],
    next_action: "Follow the current plan step and gather only necessary context.",
    final_answer_requirements: [
      "State what changed or was concluded.",
      "List verification evidence, commands, or checks performed.",
      "Disclose failed or unknown success criteria and remaining risks.",
    ],
    lane: "general",
    evidence_packs: [],
    active_evidence_pack_id: undefined,
    structured_output: createStructuredOutputState(),
    quality_gate: { claims: [], escalations: [], resolutions: [], assessments: [] },
    advisor_state: {
      records: [],
      automatic_calls_used: 0,
      automatic_usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, unknown_usage_calls: 0 },
      automatic_reservations: [],
      automatic_trigger_ids: [],
    },
    dependency_evidence: [],
    coding_boundary: {
      status: "pending",
      task_id: taskId,
      branch_id: workspaceBranchIdentity(cwd, workspaceRevision),
      allowed_write_paths: [],
    },
    scope_state: createScopeState(),
    criteria: createCriteria(successCriteria),
    trusted_check_mappings: [],
    execution_receipts: [],
    criterion_results: [],
    model_verification_claims: [],
    completion_gates: [],
    task_identity: {
      task_id: taskId,
      branch_id: workspaceBranchIdentity(cwd, workspaceRevision),
      created_workspace_revision: workspaceRevision.digest,
      session_id: initialSession.session_id,
      session_anchor_entry_id: sessionAnchor,
    },
    workspace_revision: workspaceRevision,
    pending_tool_calls: [],
    current_session: initialSession,
    recovery: { total_attempts: 0, total_actions: 0, episodes: [] },
    id_counters: {
      next_advisor_advice: 1,
      next_criterion: successCriteria.length + 1,
      next_mapping: 1,
      next_receipt: 1,
      next_gate: 1,
      next_evidence_pack: 1,
      next_scope: 1,
      next_scope_change: 1,
      next_approval: 1,
      next_output_contract: 1,
      next_output_validation: 1,
      next_quality_gate_claim: 1,
      next_quality_gate_escalation: 1,
      next_quality_gate_assessment: 1,
      next_quality_gate_resolution: 1,
      next_checkpoint: 1,
    },
    context_epoch: 0,
    context_checkpoints: [],
    active_checkpoint_id: undefined,
    context_reset: createContextResetState(),
    retired_criterion_ids: [],
    authoritative_instructions: createAuthoritativeInstructions(prompt, { origin: "user-command", session_id: initialSession.session_id, session_entry_id: sessionAnchor }),
    working_context: createWorkingContext(),
    migration: { source_schema_version: 2, backup_pending: false },
    counters: {
      context_injections: 0,
      model_responses: 0,
      tool_calls: 0,
      repeated_action_limit: config.maxRepeatedAction,
      blocked_calls: 0,
      errors_used: 0,
      iterations_used: 0,
    },
  };
}

export function changedTopLevelKeys(previous: TaskState | undefined, next: TaskState): string[] {
  if (!previous) return ["created"];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const before = (previous as unknown as Record<string, unknown>)[key];
    const after = (next as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(key);
  }
  return changed;
}

export type SaveOptions = {
  failBeforeCommit?: boolean;
  failAfterCommitAt?: "latest-pointer" | "migration-event" | "state-event";
};

export type TaskLoadResult =
  | { status: "absent" }
  | { status: "loaded"; state: TaskState }
  | { status: "recovery-required"; reason: string; state_path: string };

function cloneState(state: TaskState): TaskState {
  return JSON.parse(JSON.stringify(state)) as TaskState;
}

function writeTaskStateAtomically(path: string, state: TaskState, options: SaveOptions = {}): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const prepared = readJsonFile<unknown>(temporaryPath);
    if (!isTaskStateV2(prepared)) throw new Error("Refusing to commit an invalid v2 task state.");
    if (options.failBeforeCommit) throw new Error("Injected task-state commit failure.");
    renameSync(temporaryPath, path);
    const committed = readJsonFile<unknown>(path);
    if (!isTaskStateV2(committed) || committed.task_id !== state.task_id) {
      throw new Error("Task-state commit verification failed; recovery from the v1 backup is required.");
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

/**
 * Writes migration output as a verified atomic replacement. The original v1
 * bytes are copied first and the migration event is appended only after commit.
 */
export function saveTaskState(state: TaskState, reason: string, options: SaveOptions = {}): void {
  ensureTaskArtifactDirectory(state.cwd, state.task_id);
  const path = statePathFor(state.cwd, state.task_id);
  const previousRaw = readJsonFile<unknown>(path);
  const previous = migrateTaskState(previousRaw);
  const next = cloneState(state);
  next.updated_at = nowIso();
  if (next.migration.backup_pending) {
    if (!isTaskStateV1(previousRaw)) throw new Error("Refusing to migrate a task without a valid v1 source record.");
    const backupPath = join(taskDir(next.cwd, next.task_id), "state.v1.backup.json");
    const sourceBytes = readFileSync(path);
    mkdirSync(dirname(backupPath), { recursive: true });
    if (existsSync(backupPath)) {
      if (!readFileSync(backupPath).equals(sourceBytes)) {
        throw new Error("Existing v1 migration backup does not match the source bytes.");
      }
    } else {
      copyFileSync(path, backupPath);
      if (!readFileSync(backupPath).equals(sourceBytes)) {
        throw new Error("v1 migration backup verification failed.");
      }
    }
    next.migration.backup_pending = false;
    next.migration.backup_path = backupPath;
    next.migration.event_pending = true;
  }
  writeTaskStateAtomically(path, next, options);
  const eventPath = join(taskDir(state.cwd, state.task_id), "state-events.jsonl");
  try {
    if (options.failAfterCommitAt === "latest-pointer") throw new Error("Injected latest-pointer failure.");
    writeJsonFile(latestPointerPath(state.cwd), { task_id: state.task_id, updated_at: next.updated_at });
    if (next.migration.event_pending) {
      if (options.failAfterCommitAt === "migration-event") throw new Error("Injected migration-event failure.");
      appendFileSync(eventPath, `${JSON.stringify({ timestamp: next.updated_at, reason: "state_migrated_v1_to_v2", changedKeys: ["schema_version", "criteria", "execution_receipts", "criterion_results"] })}\n`, { encoding: "utf8", mode: 0o600 });
      next.migration.event_pending = false;
      writeTaskStateAtomically(path, next);
    }
    if (options.failAfterCommitAt === "state-event") throw new Error("Injected state-event failure.");
    appendFileSync(
      eventPath,
      `${JSON.stringify({ timestamp: next.updated_at, reason, changedKeys: changedTopLevelKeys(previous, next) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (scratchpadWritesEnabled) writeScratchpad(next);
  } catch (error) {
    // The v2 state is already durable. Keep the caller retryable, including a
    // persisted migration event_pending marker when later bookkeeping failed.
    Object.assign(state, next);
    throw error;
  }
  Object.assign(state, next);
}

/** Loads one task without converting malformed or unsupported records into absence. */
export function loadTaskStateWithRecovery(cwd: string, taskId: string | undefined): TaskLoadResult {
  if (!taskId) return { status: "absent" };
  const path = statePathFor(cwd, taskId);
  if (!existsSync(path)) return { status: "absent" };
  const raw = readJsonFile<unknown>(path);
  if (raw === undefined) return { status: "recovery-required", reason: "Task state is unreadable or malformed JSON.", state_path: path };
  try {
    const state = migrateTaskState(raw);
    if (!state || !isTaskStateV2(state)) {
      return { status: "recovery-required", reason: "Task state does not satisfy a supported schema after validation or migration.", state_path: path };
    }
    if (state.task_id !== taskId || state.cwd !== cwd) return { status: "recovery-required", reason: "Task state identity does not match its saved location.", state_path: path };
    return { status: "loaded", state };
  } catch (error) {
    return {
      status: "recovery-required",
      reason: `Task state migration failed: ${error instanceof Error ? error.message : String(error)}`,
      state_path: path,
    };
  }
}

export function loadTaskState(cwd: string, taskId: string | undefined): TaskState | undefined {
  const result = loadTaskStateWithRecovery(cwd, taskId);
  return result.status === "loaded" ? result.state : undefined;
}

export function isTaskArchived(cwd: string, taskId: string): boolean {
  return existsSync(archivedMarkerPath(cwd, taskId));
}

export function listTaskStates(cwd: string, includeArchived = false): TaskState[] {
  const root = taskRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadTaskState(cwd, entry.name))
    .filter((state): state is TaskState => !!state)
    .filter((state) => includeArchived || !isTaskArchived(state.cwd, state.task_id))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export function loadLatestTaskState(cwd: string): TaskState | undefined {
  const pointer = readJsonFile<{ task_id?: string }>(latestPointerPath(cwd));
  const pointed = loadTaskState(cwd, pointer?.task_id);
  if (pointed && !isTaskArchived(cwd, pointed.task_id)) return pointed;
  return listTaskStates(cwd, false)[0];
}

export function archiveTask(cwd: string, taskId: string): void {
  ensureTaskArtifactDirectory(cwd, taskId);
  const markerPath = archivedMarkerPath(cwd, taskId);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `archivedAt=${nowIso()}\n`, { encoding: "utf8", mode: 0o600 });
}

export function summarizeTask(state: TaskState): TaskSummary {
  const progress = planProgress(state);
  return {
    task_id: state.task_id,
    status: state.status,
    goal: state.normalized_goal || state.user_goal,
    updated_at: state.updated_at,
    current_step_id: state.current_step_id,
    progress: `${progress.done}/${progress.total}`,
    archived: isTaskArchived(state.cwd, state.task_id),
  };
}

export function formatTaskSummaries(states: TaskState[]): string {
  if (states.length === 0) return "No reliability tasks found.";
  return states.map((state) => {
    const summary = summarizeTask(state);
    const archived = summary.archived ? " archived" : "";
    return `${summary.task_id.slice(0, 8)}  ${summary.status}${archived}  ${summary.progress}  ${summary.updated_at}  ${truncate(summary.goal, 90)}`;
  }).join("\n");
}

export function resolveTaskQuery(cwd: string, query: string | undefined, includeArchived = true): { state?: TaskState; error?: string } {
  const trimmed = query?.trim();
  if (!trimmed) {
    const latest = loadLatestTaskState(cwd);
    return latest ? { state: latest } : { error: "No latest reliability task found." };
  }
  const matches = listTaskStates(cwd, includeArchived).filter((state) => state.task_id === trimmed || state.task_id.startsWith(trimmed));
  if (matches.length === 1) return { state: matches[0] };
  if (matches.length === 0) return { error: `No reliability task matches '${trimmed}'.` };
  return { error: `Ambiguous task id '${trimmed}': ${matches.map((state) => state.task_id.slice(0, 8)).join(", ")}` };
}

export function readProjectConfig(ctx: ExtensionContext): Partial<ReliabilityConfig> {
  try {
    if (typeof ctx.isProjectTrusted === "function" && !ctx.isProjectTrusted()) return {};
    return readJsonFile<Partial<ReliabilityConfig>>(resolve(ctx.cwd, CONFIG_DIR_NAME, "reliability.json")) ?? {};
  } catch {
    return {};
  }
}

export function persistedPointerFromSession(ctx: ExtensionContext): PersistedExtensionState | undefined {
  const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: PersistedExtensionState }>;
  return branch
    .filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE)
    .map((entry) => entry.data)
    .filter((data): data is PersistedExtensionState => !!data && typeof data.enabled === "boolean")
    .at(-1);
}

export function persistExtensionState(pi: ExtensionAPI, enabled: boolean, state: TaskState | undefined): void {
  pi.appendEntry(CUSTOM_STATE_TYPE, {
    enabled,
    taskId: state?.task_id,
    taskDir: state ? taskDir(state.cwd, state.task_id) : undefined,
    updatedAt: nowIso(),
  } satisfies PersistedExtensionState);
}
