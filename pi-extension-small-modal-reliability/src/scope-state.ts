import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { createApprovalRequest } from "./approval-state.ts";
import type { ScopeApprovalRequestInput, ReliabilityScopeInput, ScopeSetInput } from "./scope-contracts.ts";
import { validateReliabilityScopeInput } from "./scope-contracts.ts";
import type { ExecutionReceipt, ExecutionScope, ReliabilityConfig, ScopeAuthority, ScopeChangeRequest, ScopeFreshRead, ScopeState, TaskState, WorkflowLane } from "./types.ts";
import { nowIso, stableStringify, truncate } from "./utils.ts";

const MAX_SCOPE_REQUESTS = 40;
const MAX_SCOPE_FRESH_READS = 80;
const MAX_SCOPE_VIOLATIONS = 40;
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "brave_search", "web_search", "fetch_content"]);

export type ScopeAuthorityBinding = {
  session_id?: string;
  entry_id?: string;
  receipt_hash?: string;
};

export type ScopeActionResult = {
  action: ReliabilityScopeInput["action"];
  scope?: ExecutionScope;
  scope_change?: ScopeChangeRequest;
  approval_id?: string;
  check?: { candidate_tool?: string; candidate_input?: unknown };
};

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function realWorkspaceRoot(cwd: string): string {
  const root = realpathSync(cwd);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Scope workspace root must be a real directory, not a symlink.");
  return root;
}

function assertNoSymlinkAncestor(path: string): void {
  let current = path;
  for (;;) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("Scope paths cannot traverse a symlink.");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Refuses a path that crosses an existing symlink or escapes the selected boundary. */
export function normalizeScopePath(cwd: string, value: string, options: { allowExternalRead?: boolean } = {}): string {
  const root = realWorkspaceRoot(cwd);
  const requested = value.replace(/^@/, "").trim();
  if (!requested) throw new Error("Scope paths must not be empty.");
  const candidate = resolve(root, requested);
  if (!options.allowExternalRead && !pathIsWithin(root, candidate)) throw new Error("Scope path escapes the task workspace.");
  assertNoSymlinkAncestor(candidate);
  return candidate;
}

/** External documentation is read-only and must still be explicitly scoped. */
export function normalizeScopeReadPath(cwd: string, value: string): string {
  return normalizeScopePath(cwd, value, { allowExternalRead: true });
}

function normalizedPaths(cwd: string, paths: string[], options: { allowExternalRead?: boolean } = {}): string[] {
  const normalized = paths.map((path) => normalizeScopePath(cwd, path, options));
  if (new Set(normalized).size !== normalized.length) throw new Error("Scope paths resolve to duplicate boundaries.");
  return normalized;
}

function scopeFromInput(
  state: TaskState,
  input: ScopeSetInput,
  config: ReliabilityConfig,
  authority: ScopeAuthority,
  scopeId: string,
  timestamp: string,
): ExecutionScope {
  if (input.maxToolCalls > config.scope.maxToolCalls || input.maxErrors > config.scope.maxErrors || input.maxIterations > config.scope.maxIterations) {
    throw new Error("Scope budgets cannot exceed the trusted project guard limits.");
  }
  const allowedReadPaths = normalizedPaths(state.cwd, input.allowedReadPaths ?? [], { allowExternalRead: true });
  const allowedWritePaths = normalizedPaths(state.cwd, input.allowedWritePaths ?? []);
  const forbiddenPaths = normalizedPaths(state.cwd, input.forbiddenPaths ?? []);
  for (const boundary of [...allowedReadPaths, ...allowedWritePaths]) {
    // A parent allow with a child deny is valid. A boundary wholly inside a
    // forbidden path could never be used and is rejected as malformed.
    if (forbiddenPaths.some((forbidden) => pathIsWithin(forbidden, boundary))) {
      throw new Error("An allowed scope path cannot be wholly inside a forbidden path.");
    }
  }
  return {
    scope_id: scopeId,
    lane: input.lane,
    allowed_tools: [...input.allowedTools].sort(),
    allowed_read_paths: allowedReadPaths.sort(),
    allowed_write_paths: allowedWritePaths.sort(),
    forbidden_paths: forbiddenPaths.sort(),
    max_tool_calls: input.maxToolCalls,
    max_errors: input.maxErrors,
    max_iterations: input.maxIterations,
    external_side_effects: input.externalSideEffects,
    validation_commands: [...(input.validationCommands ?? [])].sort(),
    stop_conditions: [...input.stopConditions].sort(),
    escalation_conditions: [...input.escalationConditions].sort(),
    authority,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function createScopeState(): ScopeState {
  return {
    pending_scope_changes: [],
    approvals: [],
    usage: { tool_calls_used: 0, blocked_tool_calls: 0, errors_used: 0, iterations_used: 0 },
    fresh_reads: [],
    violations: [],
  };
}

export function scopeFingerprint(scope: ExecutionScope): string {
  const canonical = {
    lane: scope.lane,
    allowed_tools: [...scope.allowed_tools].sort(),
    allowed_read_paths: [...scope.allowed_read_paths].sort(),
    allowed_write_paths: [...scope.allowed_write_paths].sort(),
    forbidden_paths: [...scope.forbidden_paths].sort(),
    max_tool_calls: scope.max_tool_calls,
    max_errors: scope.max_errors,
    max_iterations: scope.max_iterations,
    external_side_effects: scope.external_side_effects,
    validation_commands: [...scope.validation_commands].sort(),
    stop_conditions: [...scope.stop_conditions].sort(),
    escalation_conditions: [...scope.escalation_conditions].sort(),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

function boundarySubset(candidate: string[], current: string[]): boolean {
  return candidate.every((path) => current.some((existing) => pathIsWithin(existing, path)));
}

function stringsSubset(candidate: string[], current: string[]): boolean {
  return candidate.every((item) => current.includes(item));
}

function stringsSuperset(candidate: string[], current: string[]): boolean {
  return current.every((item) => candidate.includes(item));
}

function sideEffectRank(value: ExecutionScope["external_side_effects"]): number {
  return value === "forbidden" ? 0 : value === "approval-required" ? 1 : 2;
}

/** A model may narrow an existing scope but cannot silently broaden it. */
export function scopeIsNarrowerOrEqual(candidate: ExecutionScope, current: ExecutionScope): boolean {
  return stringsSubset(candidate.allowed_tools, current.allowed_tools)
    && boundarySubset(candidate.allowed_read_paths, current.allowed_read_paths)
    && boundarySubset(candidate.allowed_write_paths, current.allowed_write_paths)
    && stringsSuperset(candidate.forbidden_paths, current.forbidden_paths)
    && candidate.max_tool_calls <= current.max_tool_calls
    && candidate.max_errors <= current.max_errors
    && candidate.max_iterations <= current.max_iterations
    && sideEffectRank(candidate.external_side_effects) <= sideEffectRank(current.external_side_effects)
    && stringsSubset(candidate.validation_commands, current.validation_commands)
    && stringsSuperset(candidate.stop_conditions, current.stop_conditions)
    && stringsSuperset(candidate.escalation_conditions, current.escalation_conditions);
}

/** A model proposal needs trusted scope authority before it can permit mutation. */
export function scopeContainsMutation(scope: ExecutionScope): boolean {
  return scope.allowed_write_paths.length > 0
    || scope.external_side_effects !== "forbidden"
    || scope.allowed_tools.some((tool) => !READ_ONLY_TOOL_NAMES.has(tool));
}

/** Canonical hash of the exact persisted custom receipt payload. */
export function nativeAuthorityReceiptHash(customType: string, data: Record<string, string>): string {
  return createHash("sha256").update(stableStringify({ custom_type: customType, data })).digest("hex");
}

function applyAuthorityBinding(scope: ExecutionScope, binding: ScopeAuthorityBinding | undefined, scopeChangeId?: string): void {
  scope.authority_session_id = binding?.session_id;
  scope.authority_entry_id = binding?.entry_id;
  scope.authority_scope_change_id = binding?.session_id || binding?.entry_id || binding?.receipt_hash ? scopeChangeId : undefined;
  scope.authority_receipt_hash = binding?.receipt_hash;
}

function inheritAuthorityBinding(scope: ExecutionScope, source: ExecutionScope | undefined): void {
  scope.authority_session_id = source?.authority_session_id;
  scope.authority_entry_id = source?.authority_entry_id;
  scope.authority_scope_change_id = source?.authority_scope_change_id;
  scope.authority_receipt_hash = source?.authority_receipt_hash;
}

function setActiveScope(state: TaskState, next: ExecutionScope): void {
  state.scope_state.active_scope = next;
  state.lane = next.lane;
  state.scope_state.fresh_reads = [];
}

function requestScopeExpansion(state: TaskState, proposed: ExecutionScope, timestamp: string): ScopeChangeRequest {
  state.id_counters.next_scope = Math.max(state.id_counters.next_scope, Number(proposed.scope_id.slice(1)) + 1);
  const request: ScopeChangeRequest = {
    id: `SC${state.id_counters.next_scope_change++}`,
    requested_scope: proposed,
    requested_at: timestamp,
    status: "pending",
  };
  state.scope_state.pending_scope_changes.push(request);
  if (state.scope_state.pending_scope_changes.length > MAX_SCOPE_REQUESTS) {
    state.scope_state.pending_scope_changes.splice(0, state.scope_state.pending_scope_changes.length - MAX_SCOPE_REQUESTS);
  }
  return request;
}

function taskSessionIsCurrent(state: TaskState): boolean {
  const taskSession = state.task_identity.session_id;
  if (!taskSession) return state.current_session.lifecycle_identity !== "unavailable";
  return state.current_session.lifecycle_identity === "available"
    && state.current_session.session_id === taskSession
    && (!state.task_identity.session_anchor_entry_id || state.current_session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id));
}

/** Confirms that a scope still belongs to this task's current Pi session branch. */
export function scopeSessionIsCurrent(state: TaskState, scope = state.scope_state.active_scope): boolean {
  if (!scope || !taskSessionIsCurrent(state)) return false;
  const hasBinding = scope.authority_session_id !== undefined || scope.authority_entry_id !== undefined;
  if (!hasBinding) return true;
  return scope.authority_session_id === state.current_session.session_id
    && scope.authority_entry_id !== undefined
    && state.current_session.branch_entry_ids.includes(scope.authority_entry_id);
}

/** Mutating authority must have a native receipt in installed sessions. */
export function scopeAuthorityIsCurrent(state: TaskState, scope = state.scope_state.active_scope): boolean {
  if (!scopeSessionIsCurrent(state, scope) || !scope) return false;
  if (!state.task_identity.session_id) {
    return scope.authority_session_id === undefined
      && scope.authority_entry_id === undefined
      && scope.authority_scope_change_id === undefined
      && scope.authority_receipt_hash === undefined;
  }
  if (scope.authority_session_id !== state.current_session.session_id
    || !scope.authority_entry_id
    || !scope.authority_scope_change_id
    || !scope.authority_receipt_hash
    || !state.current_session.branch_entry_ids.includes(scope.authority_entry_id)) return false;
  const authorized = state.scope_state.authoritative_scope;
  if (!authorized || !scopeIsNarrowerOrEqual(scope, authorized)
    || scope.authority_session_id !== authorized.authority_session_id
    || scope.authority_entry_id !== authorized.authority_entry_id
    || scope.authority_scope_change_id !== authorized.authority_scope_change_id
    || scope.authority_receipt_hash !== authorized.authority_receipt_hash) return false;
  // A narrower projection inherits permission, not a new confirmation receipt.
  return state.current_session.scope_authorization_receipts?.some((receipt) => receipt.entry_id === authorized.authority_entry_id
    && receipt.task_id === state.task_id
    && receipt.scope_change_id === authorized.authority_scope_change_id
    && receipt.scope_hash === scopeFingerprint(authorized)
    && receipt.receipt_hash === authorized.authority_receipt_hash) === true;
}

function currentBindingIsValid(state: TaskState, binding: ScopeAuthorityBinding | undefined): boolean {
  if (!state.task_identity.session_id) return !binding?.session_id && !binding?.entry_id;
  return state.current_session.lifecycle_identity === "available"
    && state.current_session.session_id === state.task_identity.session_id
    && binding?.session_id === state.current_session.session_id
    && Boolean(binding.entry_id)
    && state.current_session.branch_entry_ids.includes(binding.entry_id!);
}

/** Applies a validated scope action; callers save state only after this returns. */
export function applyReliabilityScopeAction(
  state: TaskState,
  rawInput: unknown,
  config: ReliabilityConfig,
  now = new Date(),
): ScopeActionResult {
  const input = validateReliabilityScopeInput(rawInput);
  const timestamp = now.toISOString();
  if (input.action === "status") return { action: input.action, scope: state.scope_state.active_scope };
  if (input.action === "check") return { action: input.action, check: { candidate_tool: input.candidateTool, candidate_input: input.candidateInput } };
  if (input.action === "request-approval") {
    const approval = createApprovalRequest(state, {
      tool_name: input.toolName,
      requested_normalized_effect: input.normalizedEffect,
      description: input.description,
      reversible: input.reversible,
    }, now);
    return { action: input.action, scope: state.scope_state.active_scope, approval_id: approval.id };
  }

  const proposed = scopeFromInput(state, input, config, "model", `S${state.id_counters.next_scope}`, timestamp);
  const active = state.scope_state.active_scope;
  const authoritative = state.scope_state.authoritative_scope;
  if (!active && scopeContainsMutation(proposed)) {
    return { action: input.action, scope_change: requestScopeExpansion(state, proposed, timestamp) };
  }
  if (authoritative && !scopeIsNarrowerOrEqual(proposed, authoritative)) {
    return { action: input.action, scope: active, scope_change: requestScopeExpansion(state, proposed, timestamp) };
  }
  if (active && !scopeIsNarrowerOrEqual(proposed, active)) {
    return { action: input.action, scope: active, scope_change: requestScopeExpansion(state, proposed, timestamp) };
  }
  if (scopeContainsMutation(proposed)) inheritAuthorityBinding(proposed, authoritative ?? active);
  state.id_counters.next_scope += 1;
  if (!state.scope_state.initial_scope) state.scope_state.initial_scope = structuredClone(proposed);
  setActiveScope(state, proposed);
  return { action: input.action, scope: proposed };
}

function scopeChangeForId(state: TaskState, requestId: string): ScopeChangeRequest {
  const request = state.scope_state.pending_scope_changes.find((item) => item.id === requestId);
  if (!request) throw new Error(`No pending scope change matches ${requestId}.`);
  return request;
}

/** A native confirmation is the only path that may establish or broaden mutation scope. */
export function approveScopeChange(
  state: TaskState,
  requestId: string,
  authority: Extract<ScopeAuthority, "user-command" | "native-confirmation">,
  now = new Date(),
  binding?: ScopeAuthorityBinding,
): ExecutionScope {
  const request = scopeChangeForId(state, requestId);
  if (request.status !== "pending") throw new Error(`Scope change ${request.id} is ${request.status} and cannot be approved.`);
  if (!currentBindingIsValid(state, binding)) throw new Error("Scope approval requires an exact current-session native confirmation receipt.");
  const approved = structuredClone(request.requested_scope);
  approved.authority = authority;
  approved.updated_at = now.toISOString();
  applyAuthorityBinding(approved, binding, request.id);
  setActiveScope(state, approved);
  if (!state.scope_state.initial_scope) state.scope_state.initial_scope = structuredClone(approved);
  state.id_counters.next_scope = Math.max(state.id_counters.next_scope, Number(approved.scope_id.slice(1)) + 1);
  state.scope_state.authoritative_scope = structuredClone(approved);
  request.status = "approved";
  request.resolved_at = now.toISOString();
  request.resolved_by = authority;
  return approved;
}

export function rejectScopeChange(state: TaskState, requestId: string, now = new Date()): ScopeChangeRequest {
  const request = scopeChangeForId(state, requestId);
  if (request.status !== "pending") throw new Error(`Scope change ${request.id} is ${request.status} and cannot be rejected.`);
  request.status = "rejected";
  request.resolved_at = now.toISOString();
  request.resolved_by = "user-command";
  return request;
}

/**
 * Scope clear never restores a broader authoritative snapshot. A narrowed
 * projection remains operative until a separately native-confirmed expansion.
 */
export function clearScope(state: TaskState): ExecutionScope | undefined {
  return state.scope_state.active_scope;
}

const MAX_FRESH_READ_BYTES = 48 * 1024;
const MAX_PARTIAL_TARGET_BYTES = 2 * 1024 * 1024;

function currentFileIdentity(path: string, maximumBytes = MAX_FRESH_READ_BYTES): { sha256: string; bytes: number } | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) return undefined;
    const bytes = readFileSync(path);
    if (bytes.length !== stat.size) return undefined;
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } catch {
    return undefined;
  }
}

function freshReadReceipt(state: TaskState, fresh: ScopeFreshRead): ExecutionReceipt | undefined {
  if (!fresh.receipt_id || !fresh.tool_call_id || !fresh.content_sha256 || fresh.content_bytes === undefined) return undefined;
  const receipt = state.execution_receipts.find((item) => item.id === fresh.receipt_id);
  if (!receipt || receipt.operation !== "read" || receipt.tool_call_id !== fresh.tool_call_id || receipt.outcome !== "success" || !receipt.execution_observed) return undefined;
  if (state.task_identity.session_id) {
    if (receipt.session_id !== state.current_session.session_id || !receipt.session_anchor_entry_id || !state.current_session.branch_entry_ids.includes(receipt.session_anchor_entry_id)) return undefined;
  } else if (receipt.session_id !== undefined || receipt.session_anchor_entry_id !== undefined) return undefined;
  return receipt;
}

/** Stores an actual successful host read; model-provided result text cannot mint freshness. */
export function recordScopeFreshRead(state: TaskState, path: string, receipt: ExecutionReceipt, observedAt = nowIso()): void {
  const active = state.scope_state.active_scope;
  if (!active || receipt.operation !== "read" || receipt.outcome !== "success" || !receipt.execution_observed || !receipt.tool_call_id) return;
  const observed = receipt.read_targets?.find((target) => target.path === path && (target.full_coverage || target.inspected_span));
  if (!observed) return;
  const maximumBytes = observed.full_coverage ? MAX_FRESH_READ_BYTES : MAX_PARTIAL_TARGET_BYTES;
  const content = currentFileIdentity(path, maximumBytes);
  // The bytes sampled before host execution must remain stable through the
  // result event; hashing only after execution could bless uninspected bytes.
  if (!content || content.sha256 !== observed.content_sha256 || content.bytes !== observed.content_bytes) return;
  const fresh: ScopeFreshRead = {
    path,
    workspace_revision: receipt.workspace_revision_after,
    observed_at: observedAt,
    receipt_id: receipt.id,
    tool_call_id: receipt.tool_call_id,
    content_sha256: observed.content_sha256,
    content_bytes: observed.content_bytes,
    full_coverage: observed.full_coverage,
    inspected_span: observed.inspected_span,
  };
  const index = state.scope_state.fresh_reads.findIndex((item) => item.path === path);
  if (index >= 0) state.scope_state.fresh_reads[index] = fresh;
  else state.scope_state.fresh_reads.push(fresh);
  if (state.scope_state.fresh_reads.length > MAX_SCOPE_FRESH_READS) {
    state.scope_state.fresh_reads.splice(0, state.scope_state.fresh_reads.length - MAX_SCOPE_FRESH_READS);
  }
}

/** Rechecks the exact read receipt, current branch anchor, and target bytes at write preflight. */
export function isFreshScopeRead(state: TaskState, path: string): boolean {
  const fresh = state.scope_state.fresh_reads.find((item) => item.path === path);
  if (!fresh || fresh.full_coverage !== true || !freshReadReceipt(state, fresh)) return false;
  const content = currentFileIdentity(path);
  return Boolean(content && content.sha256 === fresh.content_sha256 && content.bytes === fresh.content_bytes);
}

/** Allows only an exact edit whose old text is wholly inside an actual bounded read span. */
export function isFreshScopeTargetedEdit(state: TaskState, path: string, input: unknown): boolean {
  const fresh = state.scope_state.fresh_reads.find((item) => item.path === path);
  if (!fresh || fresh.full_coverage === true || !fresh.inspected_span || !freshReadReceipt(state, fresh)) return false;
  const content = currentFileIdentity(path, MAX_PARTIAL_TARGET_BYTES);
  if (!content || content.sha256 !== fresh.content_sha256 || content.bytes !== fresh.content_bytes) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 12) return false;
  try {
    const oldTexts = edits.map((edit) => edit && typeof edit === "object" && !Array.isArray(edit) ? (edit as { oldText?: unknown }).oldText : undefined);
    if (oldTexts.some((oldText) => typeof oldText !== "string" || oldText.length === 0) || new Set(oldTexts).size !== oldTexts.length) return false;
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const span = fresh.inspected_span;
    const selected = lines.slice(span.start_line - 1, span.end_line).join("\n");
    if (createHash("sha256").update(selected).digest("hex") !== span.content_sha256) return false;
    const prefix = lines.slice(0, span.start_line - 1).join("\n");
    const spanStart = prefix.length + (span.start_line > 1 ? 1 : 0);
    const spanEnd = spanStart + selected.length;
    const ranges: Array<{ start: number; end: number }> = [];
    return edits.every((edit) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
      const oldText = (edit as { oldText?: unknown }).oldText;
      if (typeof oldText !== "string" || oldText.length === 0) return false;
      const first = text.indexOf(oldText);
      const end = first + oldText.length;
      if (first < spanStart || end > spanEnd || text.indexOf(oldText, end) !== -1) return false;
      if (ranges.some((range) => first < range.end && end > range.start)) return false;
      ranges.push({ start: first, end });
      return true;
    });
  } catch {
    return false;
  }
}

/** Runtime-owned state and policy are never generic model tool targets. */
export function isRuntimeOwnedScopePath(cwd: string, path: string, includeDescendants = false): boolean {
  const root = realWorkspaceRoot(cwd);
  const directories = [resolve(root, ".pi", "tasks"), resolve(root, ".pi", "reliability-policy")];
  const policy = resolve(root, ".pi", "reliability.json");
  return directories.some((boundary) => pathIsWithin(boundary, path))
    || path === policy
    || includeDescendants && [...directories, policy].some((boundary) => pathIsWithin(path, boundary));
}

export function recordScopeViolation(
  state: TaskState,
  reason: string,
  attribution?: { tool_name: string; normalized_effect?: string },
): void {
  state.scope_state.usage.last_block_reason = truncate(reason, 600);
  state.scope_state.usage.last_block_tool = attribution?.tool_name;
  state.scope_state.usage.last_block_normalized_effect = attribution?.normalized_effect;
  state.scope_state.usage.last_block_scope_hash = attribution?.normalized_effect && state.scope_state.active_scope
    ? scopeFingerprint(state.scope_state.active_scope)
    : undefined;
  state.scope_state.violations.push(truncate(reason, 600));
  if (state.scope_state.violations.length > MAX_SCOPE_VIOLATIONS) {
    state.scope_state.violations.splice(0, state.scope_state.violations.length - MAX_SCOPE_VIOLATIONS);
  }
}

/** Resolves only the latest exact blocked effect; violations and budgets stay durable. */
export function resolveScopeBlockForExactApproval(state: TaskState, toolName: string, normalizedEffect: string, scopeHash: string): boolean {
  const usage = state.scope_state.usage;
  if (usage.last_block_tool !== toolName
    || usage.last_block_normalized_effect !== normalizedEffect
    || usage.last_block_scope_hash !== scopeHash) return false;
  delete usage.last_block_reason;
  delete usage.last_block_tool;
  delete usage.last_block_normalized_effect;
  delete usage.last_block_scope_hash;
  return true;
}

export function setScopeToolFocus(state: TaskState, lane: WorkflowLane | undefined): void {
  state.scope_state.tool_focus_lane = lane;
}

/** Mandatory completion requirement whenever an execution scope has been used. */
export function evaluateScopeCompletionRequirement(state: TaskState): { decision: "fail" | "escalate"; reasons: string[] } | undefined {
  const scope = state.scope_state.active_scope;
  const pending = state.scope_state.pending_scope_changes.some((item) => item.status === "pending");
  const activeApprovals = state.scope_state.approvals.some((item) => item.status === "approved");
  if (!scope && !pending && !activeApprovals && state.scope_state.violations.length === 0) return undefined;
  const reasons: string[] = [];
  if (pending) reasons.push("A scope expansion is still pending native user confirmation.");
  if (activeApprovals) reasons.push("An exact effect approval remains unused; consume it or let it expire before completion.");
  if (scope) {
    if (!scopeSessionIsCurrent(state, scope)) reasons.push("The active scope does not belong to the current Pi session branch.");
    if (scopeContainsMutation(scope) && !scopeAuthorityIsCurrent(state, scope)) reasons.push("The active mutating scope lacks a current native authority receipt.");
    if (state.scope_state.usage.tool_calls_used > scope.max_tool_calls) reasons.push("The scope call budget was exceeded.");
    if (state.scope_state.usage.errors_used >= scope.max_errors) reasons.push("The scope error budget was exhausted.");
    if (state.scope_state.usage.iterations_used > scope.max_iterations) reasons.push("The scope iteration budget was exceeded.");
  }
  if (state.scope_state.usage.last_block_reason) reasons.push(`Scope guard remains unresolved: ${state.scope_state.usage.last_block_reason}`);
  return reasons.length > 0 ? { decision: "escalate", reasons } : undefined;
}

export function formatScopeStatus(state: TaskState): string {
  const active = state.scope_state.active_scope;
  if (!active) return "Execution scope: not established. Mutating external actions remain blocked until a native-confirmed reliability_scope establishes one.";
  const usage = state.scope_state.usage;
  const lines = [
    `Execution scope ${active.scope_id}: ${active.lane}; authority=${active.authority}${active.authority_entry_id ? " (current receipt bound)" : ""}.`,
    `Tools: ${active.allowed_tools.join(", ")}.`,
    `Reads: ${active.allowed_read_paths.join(", ") || "none"}; writes: ${active.allowed_write_paths.join(", ") || "none"}.`,
    `Budget: ${usage.tool_calls_used}/${active.max_tool_calls} calls, ${usage.errors_used}/${active.max_errors} errors, ${usage.iterations_used}/${active.max_iterations} turns.`,
    `Approvals: ${state.scope_state.approvals.filter((item) => item.status === "pending").length} pending, ${state.scope_state.approvals.filter((item) => item.status === "approved").length} active.`,
  ];
  if (usage.last_block_reason) lines.push(`Latest block: ${usage.last_block_reason}`);
  return lines.join("\n");
}
