import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractChecklist, stripChecklistLines, type ChecklistItem, type ChecklistStatus } from "@firstpick/pi-utils";
import {
  MAX_GOAL_CONTINUATIONS,
  MAX_GOAL_LENGTH,
  MAX_NO_PROGRESS_RUNS,
  beginGoalRun,
  createGoalRuntime,
  pauseGoalRuntime,
  recordObservableProgress,
  recordSettledRun,
  restoreGoalRuntime,
  resumeGoalRuntime,
  validateCheckpoint,
  type GoalCheckpointInput,
  type GoalRuntimeState,
} from "./goal-runtime.ts";

type TodoStatus = ChecklistStatus;
type TodoItem = ChecklistItem;
type TodoState = {
  visible: boolean;
  items: TodoItem[];
  offset: number;
  goal?: string;
  awaitingGoalCheck: boolean;
  allowNextListReplacement: boolean;
};
type PersistedTodoState = TodoState & { version: 1 };

const KEY = "todo-progress";
const STATE_KEY = "todo-progress-state";
const CONTEXT_KEY = "todo-progress-context";
const GOAL_STATE_KEY = "todo-progress-goal-state";
const GOAL_CONTEXT_KEY = "todo-progress-goal-context";
const GOAL_KICKOFF_KEY = "todo-progress-goal-kickoff";
const GOAL_CONTINUATION_KEY = "todo-progress-goal-continuation";
const MAX_ROWS = 5;
const MAX_ITEMS = 12;

const GOAL_CHECKPOINT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["status", "goalId", "runId", "summary"],
  properties: {
    status: { type: "string", enum: ["continue", "completed", "blocked", "waiting"] },
    goalId: { type: "string", minLength: 1, maxLength: 200 },
    runId: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    remainingWork: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
    nextAction: { type: "string", minLength: 1, maxLength: 2000 },
    coverage: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
    verificationEvidence: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
    blockerCause: { type: "string", minLength: 1, maxLength: 2000 },
    requiredIntervention: { type: "string", minLength: 1, maxLength: 2000 },
    waitingFor: { type: "string", minLength: 1, maxLength: 2000 },
    jobId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as any;

const GOAL_TOOL_GUIDELINES = [
  "For multi-step work, call goal with a concise one-sentence goal derived from the user's request before creating a checklist or starting execution; do not merely write Goal: text.",
  "Call goal as the sole tool call in its assistant batch. It starts durable execution with automatic follow-ups in the current run, just like /goal.",
  "Reuse the injected active goal instead of calling goal for each checklist or continuation. Use goal_checkpoint before ending a goal run.",
  "The goal tool does not grant new authorization: preserve the user's scope, approvals, and stop requests. Do not start goals for simple conversational replies or when the user requests no automatic continuation.",
  "The goal tool cannot replace or resume an unfinished goal. Only the user can replace it with /goal; when the user asks to resume, use goal_resume instead.",
];

const TODO_POLICY = [
  "",
  "",
  "[TODO PROGRESS POLICY] For multi-step work:",
  "- When goal and goal_checkpoint are available, use the goal tool to set the work goal before creating a checklist or starting execution. Reuse an active goal; do not replace it for each checklist.",
  "- When the user indicates they want to resume a paused, blocked, or waiting goal, call goal_resume before continuing work. Do not ask them to type /goal-resume when goal_resume is available. Status questions and clarifications alone do not authorize resuming.",
  "- Without those tools, or if the user requests no automatic continuation, formulate a concise one-sentence `Goal: ...` as a checklist label only.",
  "- Create concise, agent-authored checklists with 2-6 short items. Keep the goal separate; the todo list does not need to contain the goal.",
  "- Emit markdown checklist lines exactly like `- [ ] item`, `- [-] item`, or `- [x] item` only when starting a list or when item status/text changes; do not re-emit unchanged checklist items before every tool call.",
  "- Do not copy raw user-prompt lines as todos; rewrite them into clear action items.",
  "- Update checklist markers as work changes. Mark the active/current step `[-]` when useful and completed steps `[x]`; emitting only the changed checklist line(s) is enough.",
  "- When every item in the current list is `[x]`, explicitly check whether the goal is reached before doing more work.",
  "- If the goal is reached, stop creating todo lists. For a durable goal, call goal_checkpoint with completed and verification evidence; otherwise produce the final output. If the goal is not reached, create a new short checklist before the next execution step.",
  "- Multiple todo lists may be created during one session; each new list replaces the previous list in the progress widget.",
  "- Todo checklists are session progress: still emit `[x]` updates when possible; after a normal final assistant response the extension clears the widget automatically so stale partial lists do not persist.",
].join("\n");

function statusLabel(status: TodoStatus): string {
  if (status === "done") return "[x]";
  if (status === "partial") return "[-]";
  return "[ ]";
}

function isDoneList(items: TodoItem[]): boolean {
  return items.length > 0 && items.every((item) => item.status === "done");
}

function lastAssistantMessage(messages: any[]): any | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function userText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function assistantHasToolCalls(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "toolCall");
}

function shouldAutoClearOnAgentEnd(messages: any[], s: TodoState): boolean {
  if (s.items.length === 0) return false;

  const finalAssistant = lastAssistantMessage(messages);
  if (!finalAssistant) return false;

  // Do not erase active progress for interrupted, failed, truncated, or tool-use
  // terminal states. A normal final assistant text means the run has handed the
  // result back to the user, so stale partial markers should not remain visible.
  if (["aborted", "error", "length", "toolUse"].includes(finalAssistant.stopReason)) return false;
  if (assistantHasToolCalls(finalAssistant)) return false;

  return assistantText(finalAssistant).length > 0 || isDoneList(s.items);
}

function extractChecklistBlocks(text: string): TodoItem[][] {
  const blocks: TodoItem[][] = [];
  let current: TodoItem[] = [];
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }

    const item = inFence ? undefined : extractChecklist(line)[0];
    if (item) {
      current.push(item);
      continue;
    }

    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }

  if (current.length > 0) blocks.push(current);
  return blocks;
}

function normalizeTodoText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function todoItemKey(item: TodoItem): string {
  return normalizeTodoText(item.text);
}

function sameTodoItems(a: TodoItem[], b: TodoItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item.status === b[index]?.status && item.text === b[index]?.text);
}

function bestChecklistBlock(blocks: TodoItem[][], previousItems: TodoItem[]): TodoItem[] {
  if (blocks.length === 0) return [];
  const previousKeys = new Set(previousItems.map(todoItemKey));
  let best = blocks[0].slice(0, MAX_ITEMS);
  let bestScore = [-1, best.length, 0];

  blocks.forEach((block, index) => {
    const items = block.slice(0, MAX_ITEMS);
    const overlap = items.filter((item) => previousKeys.has(todoItemKey(item))).length;
    const score = previousKeys.size > 0 ? [overlap, items.length, index] : [items.length, items.length, index];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))) {
      best = items;
      bestScore = score;
    }
  });

  return best;
}

function extractBestChecklist(texts: string[], previousItems: TodoItem[]): TodoItem[] {
  return bestChecklistBlock(texts.flatMap((text) => extractChecklistBlocks(text)), previousItems);
}

function shouldAcceptInitialList(incomingItems: TodoItem[]): boolean {
  // A single non-todo line such as `- [-] Verify build` is usually a status
  // delta emitted without the full list. Do not let it become a new one-item
  // canonical list that later expands unpredictably.
  return incomingItems.length > 1 || incomingItems[0]?.status === "todo";
}

function shouldReplaceList(previousItems: TodoItem[], incomingItems: TodoItem[], overlap: number): boolean {
  if (incomingItems.length === 0) return false;

  // New lists are allowed once the prior list is complete and the model has
  // checked the goal. While work is active, unrelated or low-overlap blocks are
  // treated as stray status output instead of replacing the canonical list.
  if (isDoneList(previousItems)) return shouldAcceptInitialList(incomingItems);
  if (overlap === 0 || incomingItems.length < previousItems.length) return false;

  const previousOverlapRatio = overlap / previousItems.length;
  const incomingOverlapRatio = overlap / incomingItems.length;
  return previousOverlapRatio >= 0.75 && incomingOverlapRatio >= 0.5;
}

function mergeChecklistItems(previousItems: TodoItem[], incomingItems: TodoItem[], options: { allowReplacement?: boolean } = {}): TodoItem[] {
  if (incomingItems.length === 0) return previousItems.slice(0, MAX_ITEMS);
  if (previousItems.length === 0) return shouldAcceptInitialList(incomingItems) ? incomingItems.slice(0, MAX_ITEMS) : [];

  const previousByKey = new Map(previousItems.map((item) => [todoItemKey(item), item]));
  const incomingByKey = new Map(incomingItems.map((item) => [todoItemKey(item), item]));
  const overlap = incomingItems.filter((item) => previousByKey.has(todoItemKey(item))).length;

  if (options.allowReplacement && shouldAcceptInitialList(incomingItems)) return incomingItems.slice(0, MAX_ITEMS);
  if (shouldReplaceList(previousItems, incomingItems, overlap)) return incomingItems.slice(0, MAX_ITEMS);

  // Otherwise only apply status/text changes for existing items. Do not append
  // new unrelated items during active progress; that was the source of one-item
  // status deltas expanding into a different list mid-run.
  return previousItems.map((item) => incomingByKey.get(todoItemKey(item)) ?? item).slice(0, MAX_ITEMS);
}

function cleanGoalText(value: string | undefined): string | undefined {
  const goal = value
    ?.replace(/^\s*(?:`+|\*+|_+)+/, "")
    .replace(/(?:`+|\*+|_+)+\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
  return goal || undefined;
}

function createGoalRequest(value: unknown) {
  if (typeof value !== "string") throw new Error("goal must be a nonempty string");
  const goal = cleanGoalText(value);
  if (!goal) throw new Error("goal must be a nonempty string");
  if (goal.length > MAX_GOAL_LENGTH) throw new Error(`Goal must be at most ${MAX_GOAL_LENGTH} characters`);
  return { goal, goalId: randomUUID(), runId: randomUUID() };
}

function extractGoal(text: string): string | undefined {
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^\s*(?:[-*+]\s*)?(?:>\s*)?(?:\*\*|__)?\s*Goal\s*(?:\*\*|__)?\s*[:：—–-]\s*(.+)$/i.exec(line);
    const goal = cleanGoalText(match?.[1]);
    if (goal) return goal;
  }

  return undefined;
}

function fallbackGoalFromPrompt(prompt: string): string | undefined {
  const explicit = extractGoal(prompt);
  if (explicit) return explicit;

  const firstMeaningfulLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("/") && !line.startsWith("[TODO PROGRESS CONTEXT]"));

  return cleanGoalText(firstMeaningfulLine)?.slice(0, 160);
}

function clear(ctx: ExtensionContext, s: TodoState, options: { keepGoal?: boolean } = {}) {
  const hadWidget = s.visible || s.items.length > 0;
  const goal = s.goal;
  s.visible = false;
  s.items = [];
  s.offset = 0;
  s.goal = options.keepGoal ? goal : undefined;
  s.awaitingGoalCheck = false;
  s.allowNextListReplacement = false;
  if (ctx.hasUI && hadWidget) ctx.ui.setWidget(KEY, undefined);
}

function hideWidget(ctx: ExtensionContext) {
  if (ctx.hasUI) ctx.ui.setWidget(KEY, undefined);
}

function snapshotState(s: TodoState): PersistedTodoState {
  return {
    version: 1,
    visible: s.visible,
    items: s.items.map((item) => ({ ...item })),
    offset: s.offset,
    goal: s.goal,
    awaitingGoalCheck: s.awaitingGoalCheck,
    allowNextListReplacement: s.allowNextListReplacement,
  };
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "todo" || value === "partial" || value === "done";
}

function restoreSnapshot(data: unknown): TodoState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const snapshot = data as Partial<PersistedTodoState>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.items)) return undefined;

  const items = snapshot.items.flatMap((item: any) => {
    if (!item || typeof item.text !== "string" || !isTodoStatus(item.status)) return [];
    return [{ text: item.text, status: item.status }];
  });

  return {
    visible: Boolean(snapshot.visible) && items.length > 0,
    items: items.slice(0, MAX_ITEMS),
    offset: Math.max(0, Math.min(Number(snapshot.offset) || 0, Math.max(0, items.length - MAX_ROWS))),
    goal: typeof snapshot.goal === "string" && snapshot.goal.trim() ? snapshot.goal : undefined,
    awaitingGoalCheck: Boolean(snapshot.awaitingGoalCheck),
    allowNextListReplacement: Boolean((snapshot as any).allowNextListReplacement),
  };
}

function render(ctx: ExtensionContext, s: TodoState, explicitGoal?: string) {
  if (!ctx.hasUI) return;
  if (!s.visible || s.items.length === 0) {
    ctx.ui.setWidget(KEY, undefined);
    return;
  }

  const done = s.items.filter((i) => i.status === "done").length;
  const partial = s.items.filter((i) => i.status === "partial").length;
  const allDone = done === s.items.length;
  const top = s.items.slice(s.offset, s.offset + MAX_ROWS);
  const title = allDone
    ? `Todo ${done}/${s.items.length} done · check goal`
    : `Todo ${done}/${s.items.length} done${partial ? `, ${partial} partial` : ""}`;
  const lines = [ctx.ui.theme.fg("accent", `Goal: ${explicitGoal ?? s.goal ?? "not formulated yet"}`)];
  lines.push(ctx.ui.theme.fg(allDone ? "success" : "accent", title));
  for (const item of top) lines.push(`${statusLabel(item.status)} ${item.text}`);
  if (s.items.length > MAX_ROWS) lines.push(ctx.ui.theme.fg("dim", `Scroll ${s.offset + 1}-${Math.min(s.offset + MAX_ROWS, s.items.length)} of ${s.items.length}`));
  ctx.ui.setWidget(KEY, lines);
}

function buildInjectedContext(s: TodoState, explicitGoal?: string): string {
  const lines = ["[TODO PROGRESS CONTEXT]"];
  const goal = explicitGoal ?? s.goal;
  lines.push(goal ? `Goal: ${goal}` : "Goal: not formulated yet. Use the goal tool when available before creating the first checklist or starting work.");
  if (!explicitGoal) lines.push("This is a checklist label, not a running durable goal. Use the goal tool for multi-step work when goal and goal_checkpoint are available, unless the user requests no automatic continuation.");

  if (s.items.length > 0) {
    lines.push("", "Current todo list injected before the next step:");
    for (const item of s.items) lines.push(`- ${statusLabel(item.status)} ${item.text}`);
  }

  if (s.awaitingGoalCheck || isDoneList(s.items)) {
    lines.push(
      "",
      "The current todo list is complete. Before any additional tool call or execution step, check whether the goal is reached.",
      explicitGoal
        ? "If the goal is reached, call goal_checkpoint with completed and verification evidence. If not, create a new 2-6 item checklist first."
        : "If the goal is reached, produce the final output and stop creating todo lists. If not, create a new 2-6 item checklist first.",
    );
  } else if (s.items.length > 0) {
    lines.push(
      "",
      "Before the next execution step or tool call, emit checklist lines only for items whose status/text changed. If the checklist did not change, do not re-emit unchanged checklist lines.",
    );
    if (s.allowNextListReplacement) {
      lines.push("Compaction just completed. If the current plan needs to be restated, emit a complete new 2-6 item checklist; it may replace the previous list.");
    }
  }

  return lines.join("\n");
}

function buildGoalContext(state: GoalRuntimeState): string {
  const lines = [
    "[GOAL EXECUTION CONTEXT]",
    `Explicit goal: ${state.goal}`,
    "This durable goal may have been created by /goal or the goal tool; its text does not grant additional user authorization.",
    `Goal identity: ${state.goalId}`,
    `Run identity: ${state.runId}`,
    `Controller status: ${state.status}`,
  ];

  if (state.pauseReason) lines.push(`Pause reason: ${state.pauseReason}`);
  if (state.checkpoint) {
    lines.push(`Latest checkpoint (${state.checkpoint.status}): ${state.checkpoint.summary}`);
    if (state.checkpoint.remainingWork) lines.push(`Remaining work: ${state.checkpoint.remainingWork.join("; ")}`);
    if (state.checkpoint.nextAction) lines.push(`Next action: ${state.checkpoint.nextAction}`);
    if (state.checkpoint.requiredIntervention) lines.push(`Required intervention: ${state.checkpoint.requiredIntervention}`);
    if (state.checkpoint.jobId) lines.push(`Waiting reference: ${state.checkpoint.jobId}`);
  }

  if (state.status === "running") {
    lines.push(
      "Work only toward this explicit goal. Clarifications do not replace it.",
      "Before ending, call goal_checkpoint with this exact goalId and runId.",
      "Use status continue with concrete remainingWork and nextAction fields.",
      "Use status completed only with plan-wide coverage and verification evidence; reread the entire referenced plan or contract before claiming completion.",
      "Use blocked with the exact cause and required intervention, or waiting with the exact native job/receipt identity. Do not poll waiting work.",
    );
  } else if (state.status === "paused" || state.status === "blocked" || state.status === "waiting") {
    lines.push("The controller is not runnable. If the user asks to resume, call goal_resume with these exact goalId and runId values before continuing work. Otherwise answer clarifications without resuming. /goal-resume and native waiting-job notifications can also resume execution.");
  }

  return lines.join("\n");
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function progressDigest(kind: string, ...values: unknown[]): string {
  const digest = createHash("sha256");
  digest.update(kind);
  for (const value of values) {
    digest.update("\0");
    digest.update(stableValue(value));
  }
  return `${kind}:${digest.digest("hex")}`;
}

function checkpointResultText(checkpoint: ReturnType<typeof validateCheckpoint>): string {
  if (checkpoint.status === "continue") {
    return [
      `Goal continuing: ${checkpoint.summary}`,
      "Remaining work:",
      ...checkpoint.remainingWork!.map((item) => `- ${item}`),
      `Next action: ${checkpoint.nextAction}`,
    ].join("\n");
  }
  if (checkpoint.status === "completed") {
    return [
      `Goal completed: ${checkpoint.summary}`,
      "Coverage:",
      ...checkpoint.coverage!.map((item) => `- ${item}`),
      "Verification:",
      ...checkpoint.verificationEvidence!.map((item) => `- ${item}`),
    ].join("\n");
  }
  if (checkpoint.status === "blocked") {
    return `Goal blocked: ${checkpoint.summary}\nCause: ${checkpoint.blockerCause}\nRequired intervention: ${checkpoint.requiredIntervention}`;
  }
  return `Goal waiting: ${checkpoint.summary}\nWaiting for: ${checkpoint.waitingFor}\nJob/receipt: ${checkpoint.jobId}\nThe reference is agent-reported and is not independently verified.`;
}

function controllerPrompt(kind: "kickoff" | "continuation", goalId: string, runId: string, content: string): string {
  return `[TODO GOAL CONTROL ${kind} ${goalId} ${runId}]\n${content}`;
}

function controllerMessage(message: any): any | undefined {
  if (message?.role !== "user") return undefined;
  const text = userText(message);
  const match = /\[TODO GOAL CONTROL (kickoff|continuation) ([\w-]+) ([\w-]+)\]\s*/.exec(text);
  if (!match) return undefined;
  return {
    role: "custom",
    customType: match[1] === "kickoff" ? GOAL_KICKOFF_KEY : GOAL_CONTINUATION_KEY,
    content: text.replace(match[0], ""),
    display: false,
    timestamp: message.timestamp,
    details: { goalId: match[2], runId: match[3] },
  };
}

function finalAssistantStopReason(messages: any[]): string | undefined {
  return lastAssistantMessage(messages)?.stopReason;
}

export default function todoProgress(pi: ExtensionAPI) {
  const state: TodoState = { visible: false, items: [], offset: 0, awaitingGoalCheck: false, allowNextListReplacement: false };
  let goalState: GoalRuntimeState | undefined;
  let pendingGoals: Array<{ goal: string; goalId: string; runId: string }> = [];
  let canCreateToolGoal = false;
  let canResumeToolGoal = false;
  const canceledGoalKickoffs = new Set<string>();
  let agentSequence = 0;
  let runHasInput = false;
  let goalAgentSequence = -1;
  let lastSettledAgentSequence = -1;
  let assistantSequence = 0;
  let checkpointAssistantSequence = -1;
  let checkpointAgentSequence = -1;
  let lastAgentStopReason: string | undefined;
  const toolBatchSizes = new Map<string, number>();
  const toolInputs = new Map<string, { name: string; args: unknown }>();
  const observedAbortSignals = new WeakMap<AbortSignal, Set<string>>();

  function persistState() {
    pi.appendEntry(STATE_KEY, snapshotState(state));
  }

  function persistGoalState() {
    if (goalState) pi.appendEntry(GOAL_STATE_KEY, structuredClone(goalState));
  }

  function renderCurrent(ctx: ExtensionContext) {
    render(ctx, state, goalState?.status === "completed" ? undefined : goalState?.goal);
  }

  function pauseGoal(ctx: ExtensionContext, reason: string, notify = true) {
    canResumeToolGoal = false;
    if (!goalState || goalState.status === "paused") return;
    pauseGoalRuntime(goalState, reason);
    persistGoalState();
    if (notify) ctx.ui.notify(`Goal paused: ${reason}. Use /goal-resume to continue.`, "warning");
  }

  function captureAbortSignal(ctx: ExtensionContext, signal = ctx.signal) {
    if (!signal || !goalState || goalState.status !== "running") return;
    if (signal.aborted) {
      pauseGoal(ctx, "Native cancellation interrupted the goal run");
      return;
    }
    const goalId = goalState.goalId;
    const runId = goalState.runId;
    const observedAgentSequence = agentSequence;
    const identity = `${goalId}\0${runId}`;
    const observedIdentities = observedAbortSignals.get(signal) ?? new Set<string>();
    if (observedIdentities.has(identity)) return;
    observedIdentities.add(identity);
    observedAbortSignals.set(signal, observedIdentities);
    signal.addEventListener("abort", () => {
      if (
        !goalState ||
        goalState.goalId !== goalId ||
        goalState.runId !== runId ||
        goalAgentSequence !== observedAgentSequence ||
        agentSequence !== observedAgentSequence
      ) return;
      pauseGoal(ctx, "Native cancellation interrupted the goal run");
    }, { once: true });
  }

  function invalidateTerminalCheckpoint() {
    if (
      !goalState?.checkpoint ||
      goalState.checkpoint.status === "continue" ||
      goalState.status === "paused" ||
      checkpointAgentSequence !== agentSequence
    ) return false;
    goalState.status = "running";
    goalState.pauseReason = undefined;
    goalState.checkpoint = undefined;
    goalState.continuationOutstanding = false;
    checkpointAssistantSequence = -1;
    checkpointAgentSequence = -1;
    persistGoalState();
    return true;
  }

  function activateGoal(ctx: ExtensionContext, pending: { goal: string; goalId: string; runId: string }) {
    canCreateToolGoal = false;
    canResumeToolGoal = false;
    clear(ctx, state);
    state.goal = pending.goal;
    goalState = createGoalRuntime(pending.goal, pending.goalId, pending.runId);
    goalAgentSequence = agentSequence;
    captureAbortSignal(ctx);
    assistantSequence = 0;
    checkpointAssistantSequence = -1;
    checkpointAgentSequence = -1;
    lastAgentStopReason = undefined;
    lastSettledAgentSequence = -1;
    persistState();
    persistGoalState();
    renderCurrent(ctx);
  }

  function restoreState(ctx: ExtensionContext, pauseRunnableGoal: boolean) {
    const entries = ctx.sessionManager.getBranch();
    const savedTodo = entries
      .filter((entry: any) => entry.type === "custom" && entry.customType === STATE_KEY)
      .map((entry: any) => restoreSnapshot(entry.data))
      .filter((snapshot): snapshot is TodoState => Boolean(snapshot))
      .at(-1);
    const latestGoalEntry = entries
      .filter((entry: any) => entry.type === "custom" && entry.customType === GOAL_STATE_KEY)
      .at(-1);
    const savedGoal = restoreGoalRuntime((latestGoalEntry as any)?.data);

    if (savedTodo) {
      state.visible = savedTodo.visible;
      state.items = savedTodo.items;
      state.offset = savedTodo.offset;
      state.goal = savedTodo.goal;
      state.awaitingGoalCheck = savedTodo.awaitingGoalCheck;
      state.allowNextListReplacement = savedTodo.allowNextListReplacement;
    } else {
      clear(ctx, state);
    }

    goalState = savedGoal;
    canCreateToolGoal = false;
    canResumeToolGoal = false;
    pendingGoals = [];
    canceledGoalKickoffs.clear();
    goalAgentSequence = -1;
    assistantSequence = 0;
    checkpointAssistantSequence = -1;
    checkpointAgentSequence = -1;
    lastAgentStopReason = undefined;
    lastSettledAgentSequence = -1;
    if (goalState && pauseRunnableGoal && (goalState.status === "running" || goalState.status === "waiting" || goalState.continuationOutstanding)) {
      pauseGoalRuntime(goalState, "Session reload or branch restoration requires explicit resume");
      persistGoalState();
    }
    if (goalState && goalState.status !== "completed") state.goal = goalState.goal;
    renderCurrent(ctx);
  }

  function resumeGoal(ctx: ExtensionContext, inCurrentRun: boolean) {
    if (!goalState) throw new Error("No explicit goal to resume");
    if (goalState.status === "running") throw new Error("Goal is already running");
    if (goalState.status === "completed") throw new Error("Completed goals cannot be resumed; start a new /goal");
    goalState = resumeGoalRuntime(goalState, randomUUID());
    canCreateToolGoal = false;
    canResumeToolGoal = false;
    goalAgentSequence = inCurrentRun ? agentSequence : -1;
    checkpointAssistantSequence = -1;
    checkpointAgentSequence = -1;
    lastAgentStopReason = undefined;
    lastSettledAgentSequence = -1;
    state.goal = goalState.goal;
    if (inCurrentRun) captureAbortSignal(ctx);
    persistState();
    persistGoalState();
    renderCurrent(ctx);
    return goalState;
  }

  function continuationMessage(reason: "automatic" | "resume") {
    if (!goalState) return undefined;
    return {
      customType: GOAL_CONTINUATION_KEY,
      content: reason === "resume"
        ? `Resume the explicit goal. Reassess remaining work and call goal_checkpoint before ending. Goal ID: ${goalState.goalId}. Run ID: ${goalState.runId}.`
        : `Continue the explicit goal from the latest observable state. Do not repeat completed work. Call goal_checkpoint before ending. Goal ID: ${goalState.goalId}. Run ID: ${goalState.runId}.`,
      display: false,
      details: { goalId: goalState.goalId, runId: goalState.runId, reason, continuation: goalState.continuations },
    };
  }

  function dispatchContinuation(ctx: ExtensionContext, reason: "automatic" | "resume") {
    if (!goalState || goalState.status !== "running" || goalState.continuationOutstanding) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    if (reason === "automatic") {
      if (goalState.noProgressRuns >= MAX_NO_PROGRESS_RUNS) {
        pauseGoal(ctx, `No observable progress in ${MAX_NO_PROGRESS_RUNS} consecutive runs`);
        return;
      }
      if (goalState.continuations >= MAX_GOAL_CONTINUATIONS) {
        pauseGoal(ctx, `Automatic continuation limit (${MAX_GOAL_CONTINUATIONS}) reached`);
        return;
      }
      goalState.continuations += 1;
      goalState = beginGoalRun(goalState, randomUUID());
    }

    goalAgentSequence = -1;
    checkpointAssistantSequence = -1;
    checkpointAgentSequence = -1;
    goalState.continuationOutstanding = true;
    persistGoalState();
    const message = continuationMessage(reason);
    if (!message) return;
    try {
      // Native prompt startup preserves other extensions' input and policy hooks.
      // The context hook demotes this controller message to custom context so it
      // cannot grant new user authority or expand the already authorized goal.
      pi.sendUserMessage(controllerPrompt("continuation", goalState.goalId, goalState.runId, message.content), { deliverAs: "followUp" });
    } catch (error) {
      pauseGoal(ctx, `Continuation dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pi.registerTool({
    name: "goal",
    label: "Goal",
    description: "Set a concise work goal and start the same durable execution controller as /goal in the current run. Enables bounded automatic continuation. Reuses an identical running goal without resetting progress; cannot replace or resume unfinished goals. Goal previews are limited to 2000 characters.",
    promptSnippet: "Set the work goal and start durable execution with bounded automatic follow-ups",
    promptGuidelines: GOAL_TOOL_GUIDELINES,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goal"],
      properties: {
        goal: { type: "string", minLength: 1, maxLength: MAX_GOAL_LENGTH, description: "One-sentence outcome derived from the user's request, preserving its scope and constraints" },
      },
    } as any,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted || ctx.signal?.aborted) throw new Error("Goal creation cancelled");
      if (toolBatchSizes.get(toolCallId) !== 1) throw new Error("goal must be the sole tool call in its assistant batch");
      const request = createGoalRequest((params as { goal?: unknown } | undefined)?.goal);
      if (pendingGoals.length > 0) throw new Error("A user /goal is queued; wait for its delivery instead of creating another goal");
      if (goalState && goalState.status !== "completed") {
        if (goalState.status !== "running") throw new Error(`Goal is ${goalState.status}; use goal_resume if the user asked to resume, or let the user use /goal-resume or /goal`);
        if (goalState.goal !== request.goal) throw new Error("An unfinished goal already exists; reuse it. Only the user can replace it with /goal");
      } else {
        if (!canCreateToolGoal) throw new Error("Goal creation requires a new user request; do not restart completed or cancelled work");
        // Share /goal activation without queuing agent-authored text as a user request.
        activateGoal(ctx, request);
        captureAbortSignal(ctx, signal);
      }
      const current = goalState!;
      const preview = current.goal.length > 2000 ? `${current.goal.slice(0, 2000)}... [preview truncated; full goal is in goal context]` : current.goal;
      return {
        content: [{ type: "text", text: `Goal: ${preview}\nStatus: ${current.status}\nGoal identity: ${current.goalId}\nRun identity: ${current.runId}\nContinue working in this run. Use goal_checkpoint before ending. Automatic follow-ups are enabled; /goal-pause stops them.` }],
        details: { goalId: current.goalId, runId: current.runId, status: current.status },
      };
    },
  });

  pi.registerTool({
    name: "goal_resume",
    label: "Resume goal",
    description: "Resume a paused, blocked, or waiting durable goal when the user asks to resume. Uses the same transition as /goal-resume within the current run, with a fresh bounded continuation cycle. Requires the exact goalId and runId from the stopped goal context.",
    promptSnippet: "Resume an existing durable goal when the user asks to continue it",
    promptGuidelines: [
      "When the user indicates they want to resume or continue a paused, blocked, or waiting goal, call goal_resume rather than asking them to type /goal-resume.",
      "Call goal_resume as the sole tool call in its assistant batch, using the exact injected goalId and runId. Continue in this run and use the returned runId for goal_checkpoint.",
      "Use goal_resume only in response to the user's resume intent, never for a status question, clarification alone, notification, or to bypass a stop request or continuation limit. Preserve scope and approvals; resume does not prove a blocker is resolved or a waiting job succeeded.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goalId", "runId"],
      properties: {
        goalId: { type: "string", minLength: 1, maxLength: 200 },
        runId: { type: "string", minLength: 1, maxLength: 200 },
      },
    } as any,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted || ctx.signal?.aborted) throw new Error("Goal resume cancelled");
      if (toolBatchSizes.get(toolCallId) !== 1) throw new Error("goal_resume must be the sole tool call in its assistant batch");
      if (!goalState) throw new Error("No explicit goal to resume");
      const input = params as { goalId?: unknown; runId?: unknown } | undefined;
      if (input?.goalId !== goalState.goalId || input?.runId !== goalState.runId) {
        throw new Error("Resume goalId/runId does not match the stopped goal run");
      }
      if (pendingGoals.length > 0) throw new Error("A user /goal is queued; wait for its delivery instead of resuming another goal");
      if (ctx.hasPendingMessages()) throw new Error("Wait for pending messages to be delivered before goal_resume");
      if (!canResumeToolGoal) throw new Error("Goal resume requires a new user request after the goal stopped; do not resume autonomously");
      const current = resumeGoal(ctx, true);
      captureAbortSignal(ctx, signal);
      return {
        content: [{ type: "text", text: `Goal resumed.\nStatus: ${current.status}\nGoal identity: ${current.goalId}\nRun identity: ${current.runId}\nContinue in this run. Reassess remaining work and use this new runId for goal_checkpoint. Automatic follow-ups are enabled; /goal-pause stops them.` }],
        details: { goalId: current.goalId, runId: current.runId, status: current.status },
      };
    },
  });

  pi.registerTool({
    name: "goal_checkpoint",
    label: "Goal checkpoint",
    description: "Record a validated status checkpoint for the current durable goal started by /goal or the goal tool. Identity fields must exactly match the injected goal context.",
    promptSnippet: "Checkpoint the current durable goal run as continue, completed, blocked, or waiting",
    promptGuidelines: [
      "Call goal_checkpoint before ending work on a goal started by /goal or the goal tool; use the exact injected goalId and runId.",
      "Call goal_checkpoint with continue only when remainingWork and nextAction identify the unfinished work.",
      "Call goal_checkpoint with completed only after rereading the entire referenced plan and supplying plan-wide coverage plus verification evidence.",
      "Call goal_checkpoint with waiting only for a native job/receipt that will notify Pi; never poll waiting work.",
      "Call a terminal goal_checkpoint as the sole tool call in its assistant batch.",
    ],
    parameters: GOAL_CHECKPOINT_PARAMETERS,
    async execute(toolCallId, params, signal) {
      if (!goalState) throw new Error("No explicit goal is active");
      if (goalState.status !== "running") throw new Error(`Goal is ${goalState.status}; use goal_resume on user request or /goal-resume before checkpointing`);
      if (signal?.aborted) {
        pauseGoalRuntime(goalState, "Native cancellation interrupted the goal checkpoint");
        persistGoalState();
        throw new Error("Goal checkpoint cancelled");
      }

      const checkpoint = validateCheckpoint(params as GoalCheckpointInput, goalState.goalId, goalState.runId);
      if (checkpoint.status !== "continue" && toolBatchSizes.get(toolCallId) !== 1) {
        throw new Error("A terminal goal_checkpoint must be the sole tool call in its assistant batch");
      }
      goalState.checkpoint = checkpoint;
      if (checkpoint.status !== "continue") {
        canCreateToolGoal = false;
        canResumeToolGoal = false;
      }
      goalState.continuationOutstanding = false;
      goalState.pauseReason = undefined;
      checkpointAssistantSequence = assistantSequence;
      checkpointAgentSequence = agentSequence;
      if (checkpoint.status === "completed") goalState.status = "completed";
      else if (checkpoint.status === "blocked") goalState.status = "blocked";
      else if (checkpoint.status === "waiting") goalState.status = "waiting";
      else goalState.status = "running";
      persistGoalState();

      return {
        content: [{ type: "text", text: checkpointResultText(checkpoint) }],
        details: { checkpoint, goalStatus: goalState.status },
        ...(checkpoint.status === "continue" ? {} : { terminate: true }),
      };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    captureAbortSignal(ctx);
    return { systemPrompt: event.systemPrompt + TODO_POLICY };
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentSequence += 1;
    runHasInput = false;
    lastAgentStopReason = undefined;
    toolBatchSizes.clear();
    if (goalState?.status === "running") {
      if (goalAgentSequence === -1) {
        goalAgentSequence = agentSequence;
      } else if (goalAgentSequence !== agentSequence) {
        goalState = beginGoalRun(goalState, randomUUID());
        goalAgentSequence = agentSequence;
        checkpointAssistantSequence = -1;
        checkpointAgentSequence = -1;
        persistGoalState();
      }
    }
    captureAbortSignal(ctx);
  });

  pi.on("context", async (event) => {
    const messages = event.messages.flatMap((message: any) => {
      if (message?.customType === CONTEXT_KEY || message?.customType === GOAL_CONTEXT_KEY) return [];
      const control = controllerMessage(message);
      const candidate = control ?? message;
      if (candidate.customType === GOAL_KICKOFF_KEY) {
        const details = candidate.details as { goalId?: string; canceled?: boolean } | undefined;
        if (details?.canceled || canceledGoalKickoffs.has(details?.goalId ?? "")) return [];
        return [control ? { ...message, content: control.content } : message];
      }
      if (candidate.customType === GOAL_CONTINUATION_KEY) {
        if (candidate.details?.canceled || goalState?.status !== "running" ||
            candidate.details?.goalId !== goalState.goalId || candidate.details?.runId !== goalState.runId) return [];
      }
      return [control ?? message];
    });
    const explicitGoal = goalState && goalState.status !== "completed" ? goalState.goal : undefined;
    const additions: any[] = [];
    if (explicitGoal || state.goal || state.items.length > 0) {
      additions.push({
        role: "custom",
        customType: CONTEXT_KEY,
        content: buildInjectedContext(state, explicitGoal),
        display: false,
        timestamp: Date.now(),
      });
    }
    if (goalState && goalState.status !== "completed") {
      additions.push({
        role: "custom",
        customType: GOAL_CONTEXT_KEY,
        content: buildGoalContext(goalState),
        display: false,
        timestamp: Date.now(),
      });
    }
    if (additions.length === 0 && messages.every((message, index) => message === event.messages[index]) && messages.length === event.messages.length) return undefined;
    return { messages: [...messages, ...additions] };
  });

  pi.on("message_start", async (event, ctx) => {
    captureAbortSignal(ctx);

    if (event.message.role === "assistant") {
      assistantSequence += 1;
      if (checkpointAssistantSequence >= 0 && assistantSequence > checkpointAssistantSequence) invalidateTerminalCheckpoint();
      return;
    }

    const delivered = controllerMessage(event.message) ?? event.message;
    const firstInput = !runHasInput;
    if (delivered.role === "user" || delivered.role === "custom") runHasInput = true;
    if (delivered.role === "custom") {
      canResumeToolGoal = false;
      if (delivered.customType === GOAL_KICKOFF_KEY) {
        const details = delivered.details as { goalId?: string; runId?: string } | undefined;
        const pendingIndex = pendingGoals.findIndex((pending) =>
          pending.goalId === details?.goalId && pending.runId === details?.runId
        );
        if (pendingIndex >= 0 && !canceledGoalKickoffs.has(details?.goalId ?? "")) {
          const [pending] = pendingGoals.splice(pendingIndex, 1);
          activateGoal(ctx, pending);
        } else if (firstInput && canceledGoalKickoffs.has(details?.goalId ?? "")) {
          // A startup hook can finish after pause while Pi still appeared idle.
          // Abort only a standalone owned kickoff, never an unrelated queue run.
          ctx.abort();
        }
      } else if (delivered.customType === GOAL_CONTINUATION_KEY) {
        const details = delivered.details as { goalId?: string; runId?: string } | undefined;
        if (goalState?.status === "running" && details?.goalId === goalState.goalId && details.runId === goalState.runId) {
          goalState.continuationOutstanding = false;
          persistGoalState();
        } else if (firstInput) {
          ctx.abort();
        }
      } else if (goalState?.status === "waiting") {
        goalState = beginGoalRun(goalState, randomUUID());
        goalState.checkpoint = undefined;
        goalAgentSequence = agentSequence;
        checkpointAssistantSequence = -1;
        checkpointAgentSequence = -1;
        captureAbortSignal(ctx);
        recordObservableProgress(goalState, progressDigest("wake", delivered.customType, delivered.content));
        persistGoalState();
      } else if (goalState && goalState.status !== "running") {
        checkpointAssistantSequence = -1;
        checkpointAgentSequence = -1;
        goalAgentSequence = -1;
      }
      return;
    }

    if (event.message.role !== "user") return;
    const prompt = userText(event.message);
    canCreateToolGoal = true;
    canResumeToolGoal = Boolean(goalState && ["paused", "blocked", "waiting"].includes(goalState.status));
    // Pi can drain an external follow-up without a new agent_start. That prompt
    // is not late work owned by the preceding terminal checkpoint.
    if (goalState && goalState.status !== "running") {
      checkpointAssistantSequence = -1;
      checkpointAgentSequence = -1;
      goalAgentSequence = -1;
    }

    // Follow-ups are state changes only when Pi actually delivers them. While an
    // explicit goal is active, user clarifications may replace the checklist but
    // never the durable goal identity or scope.
    if (goalState && goalState.status !== "completed") {
      clear(ctx, state, { keepGoal: true });
      state.goal = goalState.goal;
    } else {
      clear(ctx, state);
      state.goal = fallbackGoalFromPrompt(prompt);
    }
    persistState();
  });

  pi.on("message_end", async (event, ctx) => {
    const control = controllerMessage(event.message) ?? event.message;
    if (control.role === "custom" && control.customType === GOAL_CONTINUATION_KEY) {
      const details = control.details as { goalId?: string; runId?: string } | undefined;
      if (goalState?.status !== "running" || details?.goalId !== goalState.goalId || details?.runId !== goalState.runId) {
        return { message: { ...event.message, content: "Canceled goal continuation; do not execute it.", customType: GOAL_CONTINUATION_KEY, details: { ...details, canceled: true } } as typeof event.message };
      }
      return;
    }
    if (control.role === "custom" && control.customType === GOAL_KICKOFF_KEY) {
      const details = control.details as { goalId?: string; canceled?: boolean } | undefined;
      if (details?.canceled || canceledGoalKickoffs.has(details?.goalId ?? "")) {
        return {
          message: {
            ...event.message,
            content: "Canceled explicit goal request; do not act on it.",
            customType: GOAL_KICKOFF_KEY,
            display: false,
            details: { ...details, canceled: true },
          } as typeof event.message,
        };
      }
      return;
    }
    if (event.message.role !== "assistant") return;

    const toolCalls = event.message.content.filter((part: any) => part?.type === "toolCall") as Array<{ id: string }>;
    for (const toolCall of toolCalls) toolBatchSizes.set(toolCall.id, toolCalls.length);
    const textParts = event.message.content.filter((c: any) => c.type === "text");
    const texts = textParts.map((c: any) => c.text);
    const previousGoal = state.goal;
    const previousItems = state.items.map((item) => ({ ...item }));
    if (!goalState || goalState.status === "completed") {
      const goal = texts.map(extractGoal).find(Boolean);
      if (goal) state.goal = goal;
    } else {
      state.goal = goalState.goal;
    }

    const checklist = extractBestChecklist(texts, previousItems);
    if (checklist.length === 0) {
      if (state.goal !== previousGoal && state.visible && state.items.length > 0) {
        renderCurrent(ctx);
        persistState();
      }
      return;
    }

    const allowedReplacement = state.allowNextListReplacement;
    const nextItems = mergeChecklistItems(previousItems, checklist, { allowReplacement: allowedReplacement });
    const replacementAllowanceConsumed = allowedReplacement && shouldAcceptInitialList(checklist);
    const nextAllowNextListReplacement = allowedReplacement && !replacementAllowanceConsumed;
    const nextAwaitingGoalCheck = isDoneList(nextItems);
    const nextOffset = Math.min(state.offset, Math.max(0, nextItems.length - MAX_ROWS));
    const changed = state.goal !== previousGoal || !sameTodoItems(state.items, nextItems) || state.awaitingGoalCheck !== nextAwaitingGoalCheck || state.allowNextListReplacement !== nextAllowNextListReplacement || state.offset !== nextOffset || !state.visible;

    if (changed) {
      state.items = nextItems;
      state.awaitingGoalCheck = nextAwaitingGoalCheck;
      state.allowNextListReplacement = nextAllowNextListReplacement;
      state.offset = nextOffset;
      state.visible = true;
      if (goalState?.status === "running" && recordObservableProgress(goalState, progressDigest("todo", nextItems))) persistGoalState();
      renderCurrent(ctx);
      persistState();
    }

    return {
      message: {
        ...event.message,
        content: event.message.content.map((c: any) => (c.type === "text" ? { ...c, text: stripChecklistLines(c.text) } : c)),
      },
    };
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    captureAbortSignal(ctx);
    toolInputs.set(event.toolCallId, { name: event.toolName, args: event.args });
    if (!["goal_checkpoint", "goal", "goal_resume"].includes(event.toolName)) invalidateTerminalCheckpoint();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    captureAbortSignal(ctx);
    const input = toolInputs.get(event.toolCallId);
    toolInputs.delete(event.toolCallId);
    if (["goal_checkpoint", "goal", "goal_resume"].includes(event.toolName)) return;
    invalidateTerminalCheckpoint();
    if (!event.isError && goalState?.status === "running") {
      const observableResult = event.result?.content ?? event.result;
      const signature = progressDigest("tool", event.toolName, input?.args, observableResult);
      if (recordObservableProgress(goalState, signature)) persistGoalState();
    }
  });

  pi.on("session_before_compact", async (event, ctx) => captureAbortSignal(ctx, event.signal));

  pi.on("session_compact", async (_event, ctx) => {
    // One complete post-compaction checklist may replace stale compacted progress.
    if (state.items.length > 0) state.allowNextListReplacement = true;
    renderCurrent(ctx);
    persistState();
  });

  pi.on("agent_end", async (event, ctx) => {
    lastAgentStopReason = finalAssistantStopReason(event.messages);
    if (lastAgentStopReason === "aborted" && goalAgentSequence === agentSequence) {
      pauseGoal(ctx, "Native cancellation interrupted the goal run");
    }

    if (shouldAutoClearOnAgentEnd(event.messages, state)) {
      clear(ctx, state, { keepGoal: Boolean(goalState && goalState.status !== "completed") });
      if (goalState && goalState.status !== "completed") state.goal = goalState.goal;
      persistState();
      return;
    }

    renderCurrent(ctx);
    persistState();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (lastSettledAgentSequence === agentSequence) return;
    lastSettledAgentSequence = agentSequence;
    if (!goalState || goalState.status !== "running") return;
    if (lastAgentStopReason === "error" || lastAgentStopReason === "length" || lastAgentStopReason === "deferred") {
      pauseGoal(ctx, `Terminal provider result: ${lastAgentStopReason}`);
      return;
    }
    if (goalState.continuationOutstanding) {
      pauseGoal(ctx, "Automatic continuation dispatch did not start");
      return;
    }

    recordSettledRun(goalState);
    persistGoalState();
    dispatchContinuation(ctx, "automatic");
  });

  pi.on("session_shutdown", async () => {
    persistState();
    persistGoalState();
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    persistState();
    persistGoalState();
    hideWidget(ctx);
    return undefined;
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    persistState();
    persistGoalState();
    hideWidget(ctx);
    return undefined;
  });
  pi.on("session_tree", async (_event, ctx) => restoreState(ctx, true));

  pi.registerShortcut("ctrl+alt+x", {
    description: "Dismiss completed todo widget",
    handler: async (ctx) => {
      clear(ctx, state, { keepGoal: Boolean(goalState && goalState.status !== "completed") });
      if (goalState && goalState.status !== "completed") state.goal = goalState.goal;
      persistState();
      ctx.ui.notify("Todo widget dismissed", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+j", { description: "Todo scroll down", handler: async (ctx) => { state.offset = Math.min(Math.max(0, state.items.length - MAX_ROWS), state.offset + 1); renderCurrent(ctx); persistState(); } });
  pi.registerShortcut("ctrl+alt+k", { description: "Todo scroll up", handler: async (ctx) => { state.offset = Math.max(0, state.offset - 1); renderCurrent(ctx); persistState(); } });

  pi.registerCommand("goal", {
    description: "Start an explicit durable goal. Usage: /goal <goal>",
    handler: async (args, ctx) => {
      let goal = cleanGoalText(args);

      if (!goal) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /goal <goal> (interactive input is unavailable)", "warning");
          return;
        }

        const currentGoal = goalState?.goal ?? state.goal;
        const input = await ctx.ui.input(
          "Set explicit goal",
          currentGoal ? `Current: ${currentGoal}` : "What should this work achieve?",
        );
        goal = cleanGoalText(input);
        if (!goal) {
          ctx.ui.notify("Goal start cancelled", "info");
          return;
        }
      }

      let pending: ReturnType<typeof createGoalRequest>;
      try {
        pending = createGoalRequest(goal);
      } catch (error) {
        ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}; nothing was started.`, "warning");
        return;
      }
      pendingGoals.push(pending);
      const startsImmediately = ctx.isIdle();
      try {
        pi.sendUserMessage(controllerPrompt("kickoff", pending.goalId, pending.runId, goal), { deliverAs: "followUp" });
      } catch (error) {
        pendingGoals = pendingGoals.filter((item) => item.goalId !== pending.goalId);
        ctx.ui.notify(`Goal submission failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      ctx.ui.notify(
        startsImmediately ? `Goal submitted and starting: ${goal}` : `Goal queued; the active run is unchanged until delivery: ${goal}`,
        "info",
      );
    },
  });

  pi.registerCommand("goal-status", {
    description: "Show the explicit goal controller status",
    handler: async (_args, ctx) => {
      if (!goalState) {
        ctx.ui.notify("No explicit goal has been started", "info");
        return;
      }
      const checkpoint = goalState.checkpoint ? ` · checkpoint ${goalState.checkpoint.status}: ${goalState.checkpoint.summary}` : " · checkpoint missing";
      const stopReason = lastAgentStopReason ? ` · last stop ${lastAgentStopReason}` : "";
      const pauseReason = goalState.pauseReason ? ` · reason ${goalState.pauseReason}` : "";
      const blocker = goalState.checkpoint?.status === "blocked"
        ? ` · cause ${goalState.checkpoint.blockerCause} · intervention ${goalState.checkpoint.requiredIntervention}`
        : "";
      ctx.ui.notify(`Goal: ${goalState.goal} · status ${goalState.status} · goalId ${goalState.goalId} · runId ${goalState.runId} · continuations ${goalState.continuations}/${MAX_GOAL_CONTINUATIONS} · no-progress ${goalState.noProgressRuns}/${MAX_NO_PROGRESS_RUNS}${checkpoint}${stopReason}${pauseReason}${blocker}`, "info");
    },
  });

  pi.registerCommand("goal-pause", {
    description: "Pause the current explicit goal and cancel active work",
    handler: async (_args, ctx) => {
      canCreateToolGoal = false;
      canResumeToolGoal = false;
      const queued = pendingGoals.splice(0);
      for (const pending of queued) canceledGoalKickoffs.add(pending.goalId);

      if (!goalState || goalState.status === "completed" || goalState.status === "paused") {
        ctx.ui.notify(
          queued.length > 0
            ? `Paused ${queued.length} queued goal request${queued.length === 1 ? "" : "s"}; canceled kickoff content will not reach the model.`
            : "No runnable explicit goal to pause",
          queued.length > 0 ? "info" : "warning",
        );
        return;
      }
      pauseGoal(ctx, "Paused explicitly by the user", false);
      if (!ctx.isIdle()) ctx.abort();
      ctx.ui.notify(queued.length > 0 ? "Goal and queued goal requests paused. Use /goal-resume to continue the active goal." : "Goal paused. Use /goal-resume to continue.", "info");
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume a paused, blocked, or waiting explicit goal",
    handler: async (_args, ctx) => {
      if (!goalState) {
        ctx.ui.notify("No explicit goal to resume", "warning");
        return;
      }
      if (goalState.status === "running") {
        ctx.ui.notify("Goal is already running", "warning");
        return;
      }
      if (goalState.status === "completed") {
        ctx.ui.notify("Completed goals cannot be resumed; start a new /goal", "warning");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for Pi and pending messages to settle before /goal-resume", "warning");
        return;
      }

      resumeGoal(ctx, false);
      dispatchContinuation(ctx, "resume");
      ctx.ui.notify(`Goal resumed with runId ${goalState.runId}`, "info");
    },
  });

  pi.registerCommand("todo-progress-status", {
    description: "Show todo-progress widget extension status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`todo-progress loaded · visible ${state.visible ? "yes" : "no"} · items ${state.items.length} · goal ${state.goal ? "yes" : "no"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => restoreState(ctx, true));
}
