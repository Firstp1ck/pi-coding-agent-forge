import type { ApprovalRequest, ReliabilityConfig, ScopeAuthority, TaskState } from "./types.ts";
import { resolveScopeBlockForExactApproval, scopeAuthorityIsCurrent, scopeFingerprint, scopeSessionIsCurrent, type ScopeAuthorityBinding } from "./scope-state.ts";
import { hashToolCall } from "./utils.ts";

const MAX_APPROVALS = 80;

function currentSessionAllowsUserAuthority(state: TaskState, binding: ScopeAuthorityBinding | undefined): boolean {
  const current = state.current_session;
  if (!state.task_identity.session_id) return !binding?.session_id && !binding?.entry_id && current.lifecycle_identity !== "unavailable";
  return current.lifecycle_identity === "available"
    && current.session_id === state.task_identity.session_id
    && (!state.task_identity.session_anchor_entry_id || current.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id))
    && binding?.session_id === current.session_id
    && Boolean(binding.entry_id)
    && current.branch_entry_ids.includes(binding.entry_id!);
}

function approvalForId(state: TaskState, approvalId: string): ApprovalRequest {
  const approval = state.scope_state.approvals.find((item) => item.id === approvalId);
  if (!approval) throw new Error(`No approval request matches ${approvalId}.`);
  return approval;
}

function approvalHasExpired(approval: ApprovalRequest, now: Date): boolean {
  return approval.status === "approved" && (!approval.expires_at || Date.parse(approval.expires_at) <= now.getTime());
}

export function expireScopeApprovals(state: TaskState, now = new Date()): string[] {
  const expired: string[] = [];
  for (const approval of state.scope_state.approvals) {
    if (!approvalHasExpired(approval, now)) continue;
    approval.status = "expired";
    expired.push(approval.id);
  }
  return expired;
}

/** A verified continuity reset invalidates every unused side-effect grant, regardless of ordinary TTL. */
export function expireUnusedScopeApprovalsAtContextReset(state: TaskState, now = new Date()): string[] {
  const expired: string[] = [];
  for (const approval of state.scope_state.approvals) {
    if (approval.status !== "approved") continue;
    approval.status = "expired";
    approval.expires_at = now.toISOString();
    expired.push(approval.id);
  }
  return expired;
}

/** Records an exact-effect request without turning model text into authority. */
export function createApprovalRequest(
  state: TaskState,
  request: Pick<ApprovalRequest, "tool_name" | "requested_normalized_effect" | "description" | "reversible">,
  now = new Date(),
): ApprovalRequest {
  const active = state.scope_state.active_scope;
  if (!active) throw new Error("An approval request requires an active execution scope.");
  if (!scopeSessionIsCurrent(state, active) || !scopeAuthorityIsCurrent(state, active)) {
    throw new Error("An approval request requires a current native-authorized scope on this Pi session branch.");
  }
  if (active.external_side_effects === "forbidden") {
    throw new Error("The active scope forbids external side effects; request a separately native-confirmed scope amendment first.");
  }
  if (!active.allowed_tools.includes(request.tool_name)) {
    throw new Error(`Approval requests cannot add out-of-scope tool ${request.tool_name}.`);
  }
  if (!request.requested_normalized_effect.startsWith(`${request.tool_name}:`) || request.requested_normalized_effect.includes("\0")) {
    throw new Error("Approval requests require the exact host-normalized effect from reliability_scope check.");
  }
  const duplicate = state.scope_state.approvals.find((item) => item.status === "pending"
    && item.tool_name === request.tool_name
    && item.requested_normalized_effect === request.requested_normalized_effect
    && item.scope_hash === scopeFingerprint(active));
  if (duplicate) return duplicate;
  const approval: ApprovalRequest = {
    id: `A${state.id_counters.next_approval++}`,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    tool_name: request.tool_name,
    requested_normalized_effect: request.requested_normalized_effect,
    description: request.description,
    reversible: request.reversible,
    scope_hash: scopeFingerprint(active),
    status: "pending",
    requested_at: now.toISOString(),
  };
  state.scope_state.approvals.push(approval);
  if (state.scope_state.approvals.length > MAX_APPROVALS) {
    state.scope_state.approvals.splice(0, state.scope_state.approvals.length - MAX_APPROVALS);
  }
  return approval;
}

/** Only native-confirmation wiring with a post-confirmation receipt may promote a request. */
export function approveScopeApproval(
  state: TaskState,
  approvalId: string,
  config: ReliabilityConfig,
  authority: Extract<ScopeAuthority, "user-command" | "native-confirmation">,
  now = new Date(),
  binding?: ScopeAuthorityBinding,
): ApprovalRequest {
  if (!currentSessionAllowsUserAuthority(state, binding)) {
    throw new Error("Approval requires a current user-visible Pi session and exact post-confirmation receipt.");
  }
  expireScopeApprovals(state, now);
  const approval = approvalForId(state, approvalId);
  if (approval.status !== "pending") throw new Error(`Approval ${approval.id} is ${approval.status} and cannot be approved.`);
  const active = state.scope_state.active_scope;
  if (!active || approval.scope_hash !== scopeFingerprint(active)) {
    throw new Error(`Approval ${approval.id} no longer matches the active execution scope.`);
  }
  if (!scopeSessionIsCurrent(state, active) || !scopeAuthorityIsCurrent(state, active)) {
    throw new Error("Approval scope authority is stale or belongs to another Pi session branch.");
  }
  if (active.external_side_effects === "forbidden") {
    throw new Error("The active scope forbids this side effect; a separately native-confirmed scope amendment is required first.");
  }
  approval.status = "approved";
  approval.approved_at = now.toISOString();
  approval.approved_by = authority;
  approval.expires_at = new Date(now.getTime() + config.scope.approvalTtlMs).toISOString();
  approval.session_id = binding?.session_id;
  approval.session_anchor_entry_id = binding?.entry_id;
  approval.approval_receipt_hash = binding?.receipt_hash;
  resolveScopeBlockForExactApproval(state, approval.tool_name, approval.requested_normalized_effect, approval.scope_hash);
  return approval;
}

export function rejectScopeApproval(state: TaskState, approvalId: string, now = new Date()): ApprovalRequest {
  const approval = approvalForId(state, approvalId);
  if (approval.status !== "pending") throw new Error(`Approval ${approval.id} is ${approval.status} and cannot be rejected.`);
  approval.status = "rejected";
  approval.rejected_at = now.toISOString();
  return approval;
}

/** Looks up an exact valid approval without mutating counters, expiry state, or approval state. */
export function findExactScopeApproval(
  state: TaskState,
  toolName: string,
  normalizedEffect: string,
  now = new Date(),
): ApprovalRequest | undefined {
  const active = state.scope_state.active_scope;
  if (!active || active.external_side_effects === "forbidden" || !scopeSessionIsCurrent(state, active) || !scopeAuthorityIsCurrent(state, active)) return undefined;
  const expectedScopeHash = scopeFingerprint(active);
  return state.scope_state.approvals.find((item) => {
    const sessionMatches = state.task_identity.session_id
      ? item.session_id === state.current_session.session_id
        && item.session_anchor_entry_id !== undefined
        && item.approval_receipt_hash !== undefined
        && state.current_session.branch_entry_ids.includes(item.session_anchor_entry_id)
        && state.current_session.scope_approval_receipts?.some((receipt) => receipt.entry_id === item.session_anchor_entry_id
          && receipt.task_id === state.task_id
          && receipt.approval_id === item.id
          && receipt.scope_hash === item.scope_hash
          && receipt.normalized_effect_hash === hashToolCall("approval", item.requested_normalized_effect)
          && receipt.receipt_hash === item.approval_receipt_hash) === true
      : item.session_id === undefined && item.session_anchor_entry_id === undefined && item.approval_receipt_hash === undefined;
    return item.status === "approved"
      && !approvalHasExpired(item, now)
      && item.task_id === state.task_id
      && item.branch_id === state.task_identity.branch_id
      && item.tool_name === toolName
      && item.requested_normalized_effect === normalizedEffect
      && item.scope_hash === expectedScopeHash
      && sessionMatches;
  });
}

/** Consumes one exact user-authorized effect before execution, preventing parallel reuse. */
export function consumeExactScopeApproval(
  state: TaskState,
  toolName: string,
  normalizedEffect: string,
  now = new Date(),
): ApprovalRequest | undefined {
  expireScopeApprovals(state, now);
  const approval = findExactScopeApproval(state, toolName, normalizedEffect, now);
  if (!approval) return undefined;
  approval.status = "consumed";
  approval.consumed_at = now.toISOString();
  return approval;
}

export function formatApprovalStatus(state: TaskState): string {
  if (state.scope_state.approvals.length === 0) return "Approvals: none.";
  const lines = ["Approvals:"];
  for (const approval of state.scope_state.approvals.slice(-12)) {
    lines.push(`- ${approval.id}: ${approval.status}; ${approval.tool_name}; ${approval.description.slice(0, 180)}`);
  }
  return lines.join("\n");
}
