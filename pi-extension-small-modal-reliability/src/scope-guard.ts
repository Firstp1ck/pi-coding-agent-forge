import { existsSync, lstatSync } from "node:fs";

import { consumeExactScopeApproval, findExactScopeApproval } from "./approval-state.ts";
import { extractCommand } from "./tool-normalizer.ts";
import {
  isFreshScopeRead,
  isFreshScopeTargetedEdit,
  isRuntimeOwnedScopePath,
  normalizeScopePath,
  normalizeScopeReadPath,
  recordScopeFreshRead,
  recordScopeViolation,
  scopeAuthorityIsCurrent,
  scopeSessionIsCurrent,
} from "./scope-state.ts";
import type { ExecutionReceipt, ExecutionScope, ReliabilityConfig, TaskState } from "./types.ts";
import { stableStringify, truncate } from "./utils.ts";

const RELIABILITY_CONTROL_TOOLS = new Set([
  "reliability_status",
  "reliability_evidence",
  "reliability_scope",
  "reliability_suggest_verification",
  "reliability_set_plan",
  "reliability_record_progress",
  "reliability_supervisor_decision",
  "reliability_submit_worker_result",
  "reliability_verify_completion",
  "reliability_gate",
]);
const KNOWN_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "brave_search", "web_search", "fetch_content"]);
const KNOWN_MUTATION_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

export type ScopeGuardResult = {
  allowed: boolean;
  reason?: string;
  normalized_effect?: string;
  approval_id?: string;
};

export type ScopeGuardOptions = {
  requireScope?: boolean;
  consume?: boolean;
  /** Runtime admission can charge the attempt while deferring approval spend until all guards pass. */
  consumeApproval?: boolean;
  now?: Date;
  /** Set only after exact registered-tool and source metadata verification. */
  trustedTool?: boolean;
  /** Set only for an exact package-owned registered control operation. */
  trustedControl?: boolean;
  /** Host batch identity; one iteration is charged per preflight batch. */
  batchId?: string;
};

function pathIsWithin(boundary: string, candidate: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}/`) || candidate.startsWith(`${boundary}\\`);
}

function scopePathsForInput(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const values: unknown[] = [];
  if (typeof record.path === "string") values.push(record.path);
  if (Array.isArray(record.paths)) values.push(...record.paths);
  if (values.length === 0 && ["grep", "find", "ls"].includes(toolName)) values.push(".");
  return values.filter((value): value is string => typeof value === "string");
}

function normalizedInputForEffect(state: TaskState, toolName: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = structuredClone(input) as Record<string, unknown>;
  if (typeof record.path === "string") record.path = normalizeScopePath(state.cwd, record.path, { allowExternalRead: toolName === "read" });
  if (Array.isArray(record.paths)) record.paths = record.paths.map((path) => typeof path === "string" ? normalizeScopePath(state.cwd, path, { allowExternalRead: toolName === "read" }) : path);
  if (toolName === "bash" || toolName === "powershell") record.command = normalizeShellCommand(record.command);
  return record;
}

/** The approval match is an exact host-normalized operation, never model prose. */
export function normalizeScopeEffect(state: TaskState, toolName: string, input: unknown): string {
  const normalizedInput = normalizedInputForEffect(state, toolName, input);
  return `${toolName}:${stableStringify(normalizedInput)}`;
}

export function normalizeShellCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Shell commands must be non-empty strings.");
  return value.replace(/\r\n/g, "\n").trim();
}

function blocked(state: TaskState, reason: string, toolName?: string, input?: unknown): ScopeGuardResult {
  let normalizedEffect: string | undefined;
  try {
    if (toolName) normalizedEffect = normalizeScopeEffect(state, toolName, input);
  } catch {
    // Keep the original deny reason when malformed input cannot normalize.
  }
  state.scope_state.usage.blocked_tool_calls += 1;
  recordScopeViolation(state, reason, toolName ? { tool_name: toolName, normalized_effect: normalizedEffect } : undefined);
  return { allowed: false, reason, normalized_effect: normalizedEffect };
}

function runtimeOwnedPathReason(state: TaskState, toolName: string, input: unknown): string | undefined {
  for (const rawPath of scopePathsForInput(toolName, input)) {
    try {
      const path = toolName === "read" ? normalizeScopeReadPath(state.cwd, rawPath) : normalizeScopePath(state.cwd, rawPath);
      if (isRuntimeOwnedScopePath(state.cwd, path, toolName === "grep" || toolName === "find")) {
        return `Path ${path} is runtime-owned reliability state or policy and is not available to generic tools.`;
      }
    } catch {
      // A later active-scope check provides the detailed path denial.
    }
  }
  return undefined;
}

function scopeBatchId(state: TaskState, supplied: string | undefined): string {
  // `next_receipt` stays stable while a host tool batch is still pending and
  // advances after its settled result, matching the runtime batch boundary.
  return supplied ?? `B${state.id_counters.next_receipt}`;
}

function budgetBlock(scope: ExecutionScope, state: TaskState, batchId: string, consume: boolean): string | undefined {
  const usage = state.scope_state.usage;
  const nextCalls = usage.tool_calls_used + 1;
  const startsNewIteration = usage.active_iteration_batch_id !== batchId;
  const nextIterations = usage.iterations_used + (startsNewIteration ? 1 : 0);
  // Every external preflight attempt is charged, including one denied by a
  // limit. New turns are never recorded beyond the configured iteration cap.
  if (consume) usage.tool_calls_used = nextCalls;
  if (nextCalls > scope.max_tool_calls) return `Scope call budget exhausted (${scope.max_tool_calls}); request a user decision or report blocked.`;
  if (usage.errors_used >= scope.max_errors) return `Scope error budget exhausted (${scope.max_errors}); stop and escalate instead of retrying.`;
  if (nextIterations > scope.max_iterations) return `Scope iteration budget exhausted (${scope.max_iterations}); stop and escalate instead of looping.`;
  if (consume && startsNewIteration) {
    usage.iterations_used = nextIterations;
    usage.active_iteration_batch_id = batchId;
  }
  return undefined;
}

function assertScopedPaths(state: TaskState, scope: ExecutionScope, toolName: string, input: unknown, write: boolean): string | undefined {
  const rawPaths = scopePathsForInput(toolName, input);
  if (rawPaths.length === 0) return write ? "Mutating tool input has no inspectable path and is blocked." : undefined;
  const allowedBoundaries = write ? scope.allowed_write_paths : scope.allowed_read_paths;
  if (allowedBoundaries.length === 0) return `${write ? "Write" : "Read"} paths are not allowed by the active scope.`;
  for (const rawPath of rawPaths) {
    let path: string;
    try {
      path = write ? normalizeScopePath(state.cwd, rawPath) : normalizeScopeReadPath(state.cwd, rawPath);
    } catch (error) {
      return `Scope path check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (isRuntimeOwnedScopePath(state.cwd, path, toolName === "grep" || toolName === "find")) return `Path ${path} is runtime-owned reliability state or policy and is not available to generic tools.`;
    if (scope.forbidden_paths.some((boundary) => pathIsWithin(boundary, path))) {
      return `Path ${path} is forbidden by the active scope.`;
    }
    // Native recursive tools have no verified exclusion adapter; caller globs
    // cannot certify that forbidden descendants will not be read.
    if (!write && (toolName === "grep" || toolName === "find") && scope.forbidden_paths.some((boundary) => pathIsWithin(path, boundary))) {
      return `Recursive search at ${path} intersects a forbidden descendant of the active scope.`;
    }
    if (!allowedBoundaries.some((boundary) => pathIsWithin(boundary, path))) {
      return `Path ${path} is outside the active ${write ? "write" : "read"} scope.`;
    }
    if (write && (toolName === "edit" || existsSync(path))) {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return `Existing mutation target ${path} is not a regular non-symlink path.`;
      if (toolName === "edit" && isFreshScopeTargetedEdit(state, path, input)) continue;
      if (!isFreshScopeRead(state, path)) {
        return toolName === "write"
          ? `Existing mutation target ${path} requires a successful current full, receipt-bound read before whole-file overwrite.`
          : `Existing mutation target ${path} requires a successful current full read or a bounded receipt-bound span that contains every exact edit target.`;
      }
    }
  }
  return undefined;
}

function isKnownExternalTool(toolName: string): boolean {
  return KNOWN_READ_ONLY_TOOLS.has(toolName) || KNOWN_MUTATION_TOOLS.has(toolName);
}

/**
 * Enforces scope before execution. Preview uses the same lookup and projected
 * budget decision as execution but never spends a counter or approval.
 */
export function evaluateScopeToolCall(
  state: TaskState,
  toolName: string,
  input: unknown,
  _config: ReliabilityConfig,
  options: ScopeGuardOptions = {},
): ScopeGuardResult {
  const consume = options.consume !== false;
  const now = options.now ?? new Date();
  const scope = state.scope_state.active_scope;
  if (options.trustedControl === true && RELIABILITY_CONTROL_TOOLS.has(toolName)) {
    const artifactAccess = (toolName === "reliability_status" || toolName === "reliability_record_progress")
      && input !== null && typeof input === "object" && "artifact" in input;
    if (artifactAccess && scope) {
      if (!scopeSessionIsCurrent(state, scope)) return { allowed: false, reason: "Artifact access requires the active scope's current session branch." };
      const reason = budgetBlock(scope, state, scopeBatchId(state, options.batchId), consume);
      if (reason) return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
    }
    return { allowed: true };
  }
  if (!scope) {
    if (options.trustedTool !== true || !isKnownExternalTool(toolName)) {
      return { allowed: false, reason: `Tool ${toolName} lacks trusted registered semantics and is blocked.` };
    }
    const protectedPath = runtimeOwnedPathReason(state, toolName, input);
    if (protectedPath) return { allowed: false, reason: protectedPath };
    // Observe/balanced rollout preserves only trusted read-only behavior. A
    // missing scope never grants writes, edits, shells, or policy forgery.
    if (!options.requireScope && KNOWN_READ_ONLY_TOOLS.has(toolName)) {
      return { allowed: true, normalized_effect: normalizeScopeEffect(state, toolName, input) };
    }
    return { allowed: false, reason: "Mutating external actions require a native-confirmed active reliability_scope before execution." };
  }
  if (!scopeSessionIsCurrent(state, scope)) {
    const reason = "The active scope belongs to another or unavailable Pi session branch.";
    return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
  }
  if (options.trustedTool !== true || !isKnownExternalTool(toolName)) {
    const reason = `Tool ${toolName} has unknown or untrusted mutation semantics and is blocked until a trusted integration classifies it.`;
    return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
  }
  const batchId = scopeBatchId(state, options.batchId);
  const exhausted = budgetBlock(scope, state, batchId, consume);
  if (exhausted) return consume ? blocked(state, exhausted, toolName, input) : { allowed: false, reason: exhausted };
  if (!scope.allowed_tools.includes(toolName)) {
    const reason = `Tool ${toolName} is not allowed by the active scope.`;
    return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
  }
  const stepScope = state.plan.find((step) => step.step_id === state.current_step_id)?.allowed_scope;
  if (stepScope) {
    if (!stepScope.allowed_tools.includes(toolName)) {
      const reason = `Tool ${toolName} is outside the canonical current plan-step scope.`;
      return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
    }
    const stepWrite = toolName === "write" || toolName === "edit";
    const stepRead = KNOWN_READ_ONLY_TOOLS.has(toolName) && !["brave_search", "web_search", "fetch_content"].includes(toolName);
    if (stepWrite || stepRead) {
      const bounds = stepWrite ? stepScope.allowed_write_paths : stepScope.allowed_read_paths;
      for (const rawPath of scopePathsForInput(toolName, input)) {
        try {
          const path = stepWrite ? normalizeScopePath(state.cwd, rawPath) : normalizeScopeReadPath(state.cwd, rawPath);
          if (!bounds.some((boundary) => pathIsWithin(boundary, path))) {
            const reason = `Path ${path} is outside the canonical current plan-step scope.`;
            return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
          }
        } catch (error) {
          const reason = `Plan-step path check failed: ${error instanceof Error ? error.message : String(error)}`;
          return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
        }
      }
    }
  }

  const isWrite = toolName === "write" || toolName === "edit";
  if (isWrite && scope.lane === "coding") {
    const exhaustedRepair = state.recovery.episodes.some((episode) => episode.step_id === state.current_step_id && episode.attempts >= 2);
    if (exhaustedRepair) {
      const reason = "Coding repair limit reached after two failed validation episodes; block the third mutation and request a decision.";
      return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
    }
  }
  const isRead = KNOWN_READ_ONLY_TOOLS.has(toolName) && !["brave_search", "web_search", "fetch_content"].includes(toolName);
  if ((isWrite || toolName === "bash" || toolName === "powershell") && !scopeAuthorityIsCurrent(state, scope)) {
    const reason = "Mutating scope authority requires a current native-confirmation receipt on this Pi session branch.";
    return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
  }
  const pathReason = isWrite
    ? assertScopedPaths(state, scope, toolName, input, true)
    : isRead
      ? assertScopedPaths(state, scope, toolName, input, false)
      : undefined;
  if (pathReason) return consume ? blocked(state, pathReason, toolName, input) : { allowed: false, reason: pathReason };

  if (toolName === "bash" || toolName === "powershell") {
    let command: string;
    try {
      command = normalizeShellCommand(extractCommand(input));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return consume ? blocked(state, reason, toolName, input) : { allowed: false, reason };
    }
    if (scope.external_side_effects === "forbidden") {
      const reason = "The active scope forbids external side effects; request a separately native-confirmed scope amendment before shell execution.";
      return consume ? blocked(state, reason, toolName, { ...(input as Record<string, unknown>), command }) : { allowed: false, reason };
    }
    const effect = normalizeScopeEffect(state, toolName, { ...(input as Record<string, unknown>), command });
    const approval = consume && options.consumeApproval !== false
      ? consumeExactScopeApproval(state, toolName, effect, now)
      : findExactScopeApproval(state, toolName, effect, now);
    if (approval) return { allowed: true, normalized_effect: effect, approval_id: approval.id };
    const reason = "Shell commands require a single-use native user approval of this exact normalized effect. Trusted check mappings describe evidence coverage but are not shell permission.";
    return consume ? blocked(state, reason, toolName, { ...(input as Record<string, unknown>), command }) : { allowed: false, reason, normalized_effect: effect };
  }

  return { allowed: true, normalized_effect: normalizeScopeEffect(state, toolName, input) };
}

/** Records only an exact, host-observed result paired to a successful preflight call. */
export function recordScopeToolResult(state: TaskState, receipt: ExecutionReceipt, input: unknown): void {
  const scope = state.scope_state.active_scope;
  if (!scope || !receipt.execution_observed || !receipt.tool_call_id || !isKnownExternalTool(receipt.operation)) return;
  if (receipt.outcome === "error") state.scope_state.usage.errors_used += 1;
  if (receipt.operation === "read" && receipt.outcome === "success" && scopeSessionIsCurrent(state, scope)) {
    for (const rawPath of scopePathsForInput("read", input)) {
      try {
        recordScopeFreshRead(state, normalizeScopeReadPath(state.cwd, rawPath), receipt);
      } catch (error) {
        recordScopeViolation(state, `Fresh-read tracking failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export function scopeGuardIsBlocking(state: TaskState): boolean {
  const reason = state.scope_state.usage.last_block_reason;
  const scope = state.scope_state.active_scope;
  if (!reason || !scope) return false;
  return state.scope_state.usage.tool_calls_used > scope.max_tool_calls
    || state.scope_state.usage.errors_used >= scope.max_errors
    || state.scope_state.usage.iterations_used > scope.max_iterations;
}

export function formatScopeCheck(result: ScopeGuardResult): string {
  if (result.allowed) return `Scope check passed${result.approval_id ? ` with approval ${result.approval_id}` : ""}.`;
  const effect = result.normalized_effect ? ` Normalized effect: ${truncate(result.normalized_effect, 1_000)}` : "";
  return `Scope check blocked: ${result.reason ?? "unknown reason"}.${effect}`;
}
