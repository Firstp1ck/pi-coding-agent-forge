import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ExecutionOutcome, ExecutionReceipt, HostExecutionProvenance, ParsedVerificationResult, ReadTargetObservation, ReliabilityConfig, SessionBranchIdentity, TaskState, ToolHistoryItem } from "./types.ts";
import { MAX_ERRORS, MAX_FACTS, MAX_HISTORY } from "./types.ts";
import { displayPath, taskDir } from "./paths.ts";
import { selectNextStep, setStepStatus } from "./planner.ts";
import { contentToText, addUniqueBounded, hashToolCall, nowIso, pushBounded, stableStringify, truncate } from "./utils.ts";
import { captureWorkspaceRevision, revisionsMatch } from "./workspace-revision.ts";
import { truncateRawLog } from "./redaction.ts";
import { parseVerificationResult } from "./verifier.ts";
import { isVerificationCommand } from "./verification-suggestions.ts";
import { addOrUpdateVerification, applyParsedVerificationToCriteria, invalidateVerificationEvidence } from "./verification-state.ts";
import { recordRecoveryAction, recordRecoveryFailure, recordRecoverySuccess } from "./loop-detector.ts";
import { recordCodingRepairMutation, recordCodingValidationResult } from "./coding-boundary.ts";

export function extractCommand(input: unknown): string | undefined {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  return typeof record?.command === "string" ? record.command.trim() : undefined;
}

export function normalizeToolPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const withoutAt = value.replace(/^@/, "");
  return resolve(cwd, withoutAt);
}

export function extractToolPaths(cwd: string, toolName: string, input: unknown): { read: string[]; modified: string[]; touched: string[] } {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawPaths: unknown[] = [];
  if ("path" in record) rawPaths.push(record.path);
  if ("paths" in record && Array.isArray(record.paths)) rawPaths.push(...record.paths);

  const paths = rawPaths
    .map((value) => normalizeToolPath(cwd, value))
    .filter((value): value is string => !!value)
    .map((path) => displayPath(cwd, path));

  const modified = toolName === "write" || toolName === "edit" ? paths : [];
  const read = toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls" ? paths : [];
  return { read, modified, touched: paths };
}

/** Exact normalized resources are retained for attributable plan/dependency evidence. */
export function extractToolResources(cwd: string, toolName: string, input: unknown): string[] {
  const paths = extractToolPaths(cwd, toolName, input).touched.map((path) => resolve(cwd, path));
  if (!input || typeof input !== "object" || Array.isArray(input)) return paths;
  const url = (input as Record<string, unknown>).url;
  if (typeof url === "string" && (toolName === "fetch_content" || toolName === "brave_search" || toolName === "web_search")) {
    try {
      const normalized = new URL(url);
      if ((normalized.protocol === "http:" || normalized.protocol === "https:") && !normalized.username && !normalized.password) paths.push(normalized.toString());
    } catch {
      // The host result remains usable for its own purpose, but cannot prove a resource reference.
    }
  }
  return [...new Set(paths)].sort();
}

export function summarizeToolResult(event: { content: unknown; isError?: boolean }): string {
  const text = contentToText(event.content);
  const prefix = event.isError ? "ERROR: " : "OK: ";
  return truncate(`${prefix}${text}`, 600);
}

function safeLogFilePart(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "tool";
}

export function writeRawToolLog(state: TaskState, toolName: string, toolCallId: string | undefined, rawOutput: string, config: ReliabilityConfig): string | undefined {
  if (!config.storeRawToolLogs || rawOutput.length === 0) return undefined;
  const timestamp = nowIso().replace(/[:.]/g, "-");
  const fileName = `${timestamp}-${safeLogFilePart(toolName)}-${safeLogFilePart(toolCallId ?? "no-id")}.log`;
  const logPath = join(taskDir(state.cwd, state.task_id), "tool-logs", fileName);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, truncateRawLog(rawOutput, config.rawLogMaxChars), { encoding: "utf8", mode: 0o600 });
  return displayPath(state.cwd, logPath);
}

function activeBatchId(state: TaskState): string {
  return state.pending_tool_calls.at(-1)?.batch_id ?? `B${state.id_counters.next_receipt}`;
}

export type ToolExecutionContext = {
  host_provenance: HostExecutionProvenance;
  session?: SessionBranchIdentity;
};

const UNVERIFIED_EXECUTION_CONTEXT: ToolExecutionContext = { host_provenance: "unknown" };
const MAX_FRESH_READ_BYTES = 48 * 1024;
const MAX_PARTIAL_TARGET_BYTES = 2 * 1024 * 1024;
const MAX_PARTIAL_LINES = 400;

function fullReadCoverage(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return !["offset", "limit", "startLine", "endLine", "start_line", "end_line"].some((key) => record[key] !== undefined);
}

function boundedPartialSpan(input: unknown, text: string): { start_line: number; end_line: number; content_sha256: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!Number.isSafeInteger(record.offset) || !Number.isSafeInteger(record.limit)
    || (record.offset as number) < 1 || (record.limit as number) < 1 || (record.limit as number) > MAX_PARTIAL_LINES) return undefined;
  const lines = text.split("\n");
  const start = record.offset as number;
  if (start > lines.length) return undefined;
  const end = Math.min(lines.length, start + (record.limit as number) - 1);
  const selected = lines.slice(start - 1, end).join("\n");
  if (!selected) return undefined;
  return {
    start_line: start,
    end_line: end,
    content_sha256: createHash("sha256").update(selected).digest("hex"),
  };
}

/** Captures target identity before a host read. Partial spans remain bounded and are later checked against host output. */
function observeReadTargets(cwd: string, toolName: string, input: unknown): ReadTargetObservation[] | undefined {
  if (toolName !== "read") return undefined;
  const path = normalizeToolPath(cwd, (input as Record<string, unknown>).path);
  if (!path) return undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PARTIAL_TARGET_BYTES) return undefined;
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length || bytes.length !== before.size) return undefined;
    const content_sha256 = createHash("sha256").update(bytes).digest("hex");
    if (fullReadCoverage(input) && bytes.length <= MAX_FRESH_READ_BYTES && text.split("\n").length <= DEFAULT_MAX_LINES) {
      return [{ path, content_sha256, content_bytes: bytes.length, full_coverage: true }];
    }
    const inspected_span = boundedPartialSpan(input, text);
    return inspected_span ? [{ path, content_sha256, content_bytes: bytes.length, full_coverage: false, inspected_span }] : undefined;
  } catch {
    return undefined;
  }
}

function finalizedReadTargets(receipt: ExecutionReceipt, input: unknown, rawOutput: string, details: unknown): void {
  if (receipt.operation !== "read" || !receipt.read_targets?.length || receipt.outcome !== "success") return;
  const truncation = details && typeof details === "object" ? (details as { truncation?: { truncated?: unknown } }).truncation : undefined;
  for (const target of receipt.read_targets) {
    if (target.full_coverage) continue;
    const span = target.inspected_span;
    if (!span || truncation?.truncated === true) {
      receipt.read_targets = receipt.read_targets.filter((candidate) => candidate.full_coverage);
      return;
    }
    try {
      const text = readFileSync(target.path, "utf8");
      const current = createHash("sha256").update(text).digest("hex");
      const selected = text.split("\n").slice(span.start_line - 1, span.end_line).join("\n");
      if (current !== target.content_sha256
        || createHash("sha256").update(selected).digest("hex") !== span.content_sha256
        || !rawOutput.startsWith(selected)) {
        receipt.read_targets = receipt.read_targets.filter((candidate) => candidate.full_coverage);
        return;
      }
    } catch {
      receipt.read_targets = receipt.read_targets.filter((candidate) => candidate.full_coverage);
      return;
    }
  }
}

type PersistedSessionEntry = {
  id?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
};

function isPersistedResultForReceipt(entry: unknown, receipt: ExecutionReceipt): entry is PersistedSessionEntry & { id: string } {
  if (!entry || typeof entry !== "object" || !receipt.tool_call_id || typeof receipt.result_is_error !== "boolean") return false;
  const candidate = entry as PersistedSessionEntry;
  const message = candidate.message;
  return typeof candidate.id === "string"
    && candidate.type === "message"
    && message?.role === "toolResult"
    && message.toolCallId === receipt.tool_call_id
    && message.toolName === receipt.operation
    && message.isError === receipt.result_is_error
    && (receipt.outcome === "success" || receipt.outcome === "error");
}

/**
 * Binds a session-backed receipt only after SessionManager has persisted its
 * matching toolResult entry. Extension tool-result hooks run before that write.
 */
export function reconcilePersistedToolResults(
  state: TaskState,
  session: SessionBranchIdentity,
  branch: readonly unknown[],
): number {
  state.current_session = session;
  if (!session.session_id || session.lifecycle_identity === "unavailable") return 0;
  let reconciled = 0;
  for (const receipt of state.execution_receipts) {
    if (receipt.session_id !== session.session_id || receipt.session_anchor_entry_id) continue;
    const persisted = branch.find((entry) => isPersistedResultForReceipt(entry, receipt));
    if (!persisted) continue;
    receipt.session_anchor_entry_id = persisted.id;
    reconciled += 1;
  }
  return reconciled;
}

export function recordToolCall(
  state: TaskState,
  toolCallId: string | undefined,
  toolName: string,
  input: unknown,
  executionContext: ToolExecutionContext = UNVERIFIED_EXECUTION_CONTEXT,
): ToolHistoryItem {
  const before = captureWorkspaceRevision(state.cwd);
  state.workspace_revision = before;
  const step = selectNextStep(state);
  if (step?.status === "blocked") {
    step.status = "in_progress";
    state.blocked_steps = state.blocked_steps.filter((stepId) => stepId !== step.step_id);
  }
  const batchId = activeBatchId(state);
  const item: ToolHistoryItem = {
    timestamp: nowIso(),
    tool_call_id: toolCallId,
    batch_id: batchId,
    step_id: step?.step_id,
    tool: toolName,
    arguments_hash: hashToolCall(toolName, input),
    arguments_preview: truncate(stableStringify(input), 1000),
    status: "called",
    workspace_revision_before: before.digest,
  };
  pushBounded(state.tool_history, item, MAX_HISTORY);
  // A result with no host call ID cannot settle any other pending invocation.
  if (toolCallId) {
    state.pending_tool_calls.push({
      tool_call_id: toolCallId,
      batch_id: batchId,
      operation: toolName,
      started_at: item.timestamp,
      workspace_revision_before: before.digest,
      input_hash: item.arguments_hash,
      host_provenance: executionContext.host_provenance,
      read_targets: observeReadTargets(state.cwd, toolName, input),
      session_id: executionContext.session?.session_id,
      session_anchor_entry_id: executionContext.session?.branch_entry_ids.at(-1),
    });
  }
  if (!toolName.startsWith("reliability_")) recordRecoveryAction(state, step?.step_id, before.digest);
  state.counters.tool_calls += 1;
  state.status = "executing";
  state.current_phase = step?.title ?? state.current_phase;
  return item;
}

function criterionForResult(state: TaskState, criterionId: string): string {
  return state.criteria.find((criterion) => criterion.id === criterionId)?.requirement ?? criterionId;
}

function updatePathTracking(state: TaskState, toolName: string, input: unknown): void {
  const paths = extractToolPaths(state.cwd, toolName, input);
  for (const file of paths.read) addUniqueBounded(state.read_files, file, 120);
  for (const file of paths.modified) addUniqueBounded(state.modified_files, file, 120);
  for (const file of paths.touched) addUniqueBounded(state.files_touched, file, 120);
}

function observedExitCode(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const direct = (details as Record<string, unknown>).exitCode;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const nested = (details as Record<string, unknown>).result;
  const nestedExitCode = nested && typeof nested === "object" ? (nested as Record<string, unknown>).exitCode : undefined;
  return typeof nestedExitCode === "number" && Number.isInteger(nestedExitCode) ? nestedExitCode : undefined;
}

function observedOutcome(toolName: string, isError: boolean | undefined, details: unknown, hostProvenance: HostExecutionProvenance): ExecutionOutcome {
  if (typeof isError !== "boolean") return "unknown";
  if (isError) return "error";
  if (toolName !== "bash") return "success";
  const exitCode = observedExitCode(details);
  if (exitCode !== undefined) return exitCode === 0 ? "success" : "error";
  // Only the inspected Pi built-in Bash contract guarantees that a non-error
  // result without an explicit exit code represents exit 0.
  return hostProvenance === "pi-builtin-bash" ? "success" : "unknown";
}

function observedReceiptExitCode(toolName: string, isError: boolean | undefined, details: unknown, hostProvenance: HostExecutionProvenance): number | undefined {
  const explicit = observedExitCode(details);
  if (explicit !== undefined) return explicit;
  return toolName === "bash" && isError === false && hostProvenance === "pi-builtin-bash" ? 0 : undefined;
}

function recordVerificationCommandResult(state: TaskState, toolName: string, input: unknown, isError: boolean | undefined, rawOutput: string, receipt: ExecutionReceipt): ParsedVerificationResult | undefined {
  if (toolName !== "bash") return undefined;
  const command = extractCommand(input);
  if (!command) return undefined;
  const configuredCheck = state.scope_state.active_scope?.validation_commands.includes(command)
    && state.trusted_check_mappings.some((mapping) => mapping.operation === toolName && (!mapping.command || mapping.command === command));
  if (!isVerificationCommand(command) && !configuredCheck) return undefined;
  const parsed = parseVerificationResult(command, rawOutput, isError === true);
  receipt.validation_status = parsed.status;
  applyParsedVerificationToCriteria(state, parsed, receipt);
  if (parsed.status === "failed") {
    if (!state.plan.some((step) => step.exit_conditions.length)) setStepStatus(state, "S3", "blocked");
    state.status = "blocked";
  } else if (!state.plan.some((step) => step.exit_conditions.length) && receipt.criterion_ids.length > 0 && receipt.outcome === "success" && receipt.exit_code === 0 && receipt.batch_settled) {
    setStepStatus(state, "S3", "complete");
  }
  return parsed;
}

function receiptForToolResult(
  state: TaskState,
  item: ToolHistoryItem | undefined,
  toolCallId: string | undefined,
  toolName: string,
  input: unknown,
  isError: boolean | undefined,
  details: unknown,
  executionContext: ToolExecutionContext,
): ExecutionReceipt {
  const after = captureWorkspaceRevision(state.cwd);
  const inputHash = hashToolCall(toolName, input);
  const pending = toolCallId
    ? state.pending_tool_calls.find((call) => call.tool_call_id === toolCallId
      && call.operation === toolName
      && call.input_hash === inputHash)
    : undefined;
  if (pending) state.pending_tool_calls = state.pending_tool_calls.filter((call) => call.tool_call_id !== pending.tool_call_id);
  const matchedHistory = pending && item && item.tool_call_id === toolCallId && item.arguments_hash === inputHash ? item : undefined;
  const batchId = matchedHistory?.batch_id ?? pending?.batch_id ?? `B${state.id_counters.next_receipt}`;
  const batchSettled = Boolean(pending) && !state.pending_tool_calls.some((call) => call.batch_id === batchId);
  const command = extractCommand(input);
  const hostProvenance = pending?.host_provenance ?? executionContext.host_provenance;
  const outcome = pending ? observedOutcome(toolName, isError, details, hostProvenance) : "unknown";
  const resultSession = executionContext.session;
  const finalizedSession = pending?.session_id && resultSession?.session_id === pending.session_id
    ? resultSession
    : undefined;
  const receipt: ExecutionReceipt = {
    id: `R${state.id_counters.next_receipt++}`,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    batch_id: batchId,
    tool_call_id: toolCallId,
    step_id: matchedHistory?.step_id,
    operation: toolName,
    command,
    input_hash: inputHash,
    outcome,
    execution_observed: Boolean(pending && hostProvenance !== "unknown"),
    host_provenance: hostProvenance,
    exit_code: pending ? observedReceiptExitCode(toolName, isError, details, hostProvenance) : undefined,
    cwd: state.cwd,
    workspace_revision_before: matchedHistory?.workspace_revision_before ?? pending?.workspace_revision_before ?? "unknown",
    workspace_revision_after: after.digest,
    criterion_ids: [],
    artifact_refs: extractToolPaths(state.cwd, toolName, input).touched,
    resource_refs: extractToolResources(state.cwd, toolName, input),
    read_targets: pending?.read_targets,
    batch_settled: batchSettled,
    session_id: finalizedSession?.session_id,
    // The result event precedes persistence; reconciliation binds the exact
    // persisted toolResult entry at a later lifecycle boundary.
    session_anchor_entry_id: undefined,
    result_is_error: pending ? isError : undefined,
    started_at: matchedHistory?.timestamp ?? pending?.started_at ?? nowIso(),
    finished_at: nowIso(),
  };
  state.workspace_revision = after;
  return receipt;
}

export function updateToolResult(
  state: TaskState,
  toolCallId: string | undefined,
  toolName: string,
  input: unknown,
  isError: boolean | undefined,
  summary: string,
  rawOutput = summary,
  config?: ReliabilityConfig,
  details?: unknown,
  executionContext: ToolExecutionContext = UNVERIFIED_EXECUTION_CONTEXT,
): ExecutionReceipt {
  const rawLogPath = config ? writeRawToolLog(state, toolName, toolCallId, rawOutput, config) : undefined;
  const inputHash = hashToolCall(toolName, input);
  const match = toolCallId
    ? [...state.tool_history].reverse().find((item) => item.tool_call_id === toolCallId && item.tool === toolName && item.arguments_hash === inputHash)
    : undefined;
  const receipt = receiptForToolResult(state, match, toolCallId, toolName, input, isError, details, executionContext);
  finalizedReadTargets(receipt, input, rawOutput, details);
  if (match) {
    match.status = receipt.outcome === "success" ? "success" : receipt.outcome === "error" ? "error" : "blocked";
    match.summary = truncate(summary, 1000);
    match.workspace_revision_after = receipt.workspace_revision_after;
    if (rawLogPath) match.raw_log_path = rawLogPath;
  }
  if (!revisionsMatch(receipt.workspace_revision_before, receipt.workspace_revision_after)) {
    invalidateVerificationEvidence(state, "A workspace, dependency, configuration, or unknown shell effect changed after verification evidence was recorded.");
  }
  updatePathTracking(state, toolName, input);
  state.execution_receipts.push(receipt);
  if (state.execution_receipts.length > 120) {
    const retired = state.execution_receipts.splice(0, state.execution_receipts.length - 120);
    const retiredIds = new Set(retired.map((item) => item.id));
    for (const result of state.criterion_results) {
      if (!result.receipt_ids.some((receiptId) => retiredIds.has(receiptId))) continue;
      result.receipt_ids = result.receipt_ids.filter((receiptId) => !retiredIds.has(receiptId));
      result.status = "unknown";
      result.fresh = false;
      result.remaining_work = "The supporting receipt was retired by bounded history; rerun the trusted check.";
      addOrUpdateVerification(state, {
        criterion: criterionForResult(state, result.criterion_id),
        criterion_id: result.criterion_id,
        status: "unknown",
        evidence: "The supporting receipt was retired by bounded history.",
        remaining_work: result.remaining_work,
        source: "runtime",
        updated_at: nowIso(),
      });
    }
  }
  if (receipt.outcome === "error") {
    if (match) recordRecoveryFailure(state, match, summary);
    pushBounded(state.errors, `${toolName}: ${truncate(summary, 300)}`, MAX_ERRORS);
  } else if (receipt.outcome === "success") {
    recordRecoverySuccess(state);
  }
  const parsed = recordVerificationCommandResult(state, toolName, input, isError, rawOutput, receipt);
  if (parsed) {
    recordCodingValidationResult(state, receipt.id, parsed.status === "passed" ? "passed" : "failed");
    addUniqueBounded(state.known_facts, `Verification command: ${parsed.summary}`, MAX_FACTS);
  }
  if ((toolName === "write" || toolName === "edit") && receipt.outcome === "success") {
    recordCodingRepairMutation(state, receipt.id, !revisionsMatch(receipt.workspace_revision_before, receipt.workspace_revision_after));
  }
  return receipt;
}
