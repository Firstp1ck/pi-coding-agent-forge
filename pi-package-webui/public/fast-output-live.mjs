export const FAST_OUTPUT_FLUSH_INTERVAL_MS = 100;

function text(value) {
  return typeof value === "string" ? value : "";
}

function toolCallName(update = {}) {
  const value = update.name || update.toolName || update.toolCall?.name || "";
  return text(value).trim();
}

function toolCallId(update = {}) {
  const value = update.toolCallId || update.toolCall?.id || update.id || "";
  return text(value).trim();
}

function toolCallArguments(update = {}) {
  const value = update.toolCall?.arguments ?? update.arguments ?? update.args;
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function createFastOutputLiveState() {
  return {
    text: "",
    thinking: "",
    toolCall: { id: "", name: "", arguments: "", complete: false },
    changed: false,
  };
}

export function seedFastOutputLiveState({ text: seededText = "", thinking: seededThinking = "" } = {}) {
  return {
    ...createFastOutputLiveState(),
    text: text(seededText),
    thinking: text(seededThinking),
  };
}

export function fastOutputLiveTextAndThinking(state = {}) {
  return {
    text: text(state.text),
    thinking: text(state.thinking),
  };
}

export function shouldConsumeFastOutputLiveEvent(reduction = {}) {
  return reduction.changed === true || ["text-end", "thinking-end", "toolcall-end"].includes(reduction.kind);
}

/**
 * Pure compact-v1 reducer. It consumes only the direct compact fields: no
 * accumulated message or partial snapshot is read, so raw Unicode deltas stay
 * intact until final transcript reconciliation.
 */
export function reduceFastOutputLiveEvent(state = createFastOutputLiveState(), event = {}) {
  const update = event?.type === "message_update" && event.assistantMessageEvent && typeof event.assistantMessageEvent === "object"
    ? event.assistantMessageEvent
    : null;
  if (!update) return { state, changed: false, kind: "ignored" };

  const current = {
    text: text(state.text),
    thinking: text(state.thinking),
    toolCall: { ...createFastOutputLiveState().toolCall, ...(state.toolCall || {}) },
    changed: false,
  };
  const delta = text(update.delta);
  let changed = false;
  let kind = "ignored";

  if (update.type === "text_delta") {
    current.text += delta;
    changed = true;
    kind = "text";
  } else if (update.type === "thinking_delta") {
    current.thinking += delta;
    changed = true;
    kind = "thinking";
  } else if (update.type === "toolcall_delta") {
    current.toolCall = {
      ...current.toolCall,
      id: toolCallId(update) || current.toolCall.id,
      name: toolCallName(update) || current.toolCall.name,
      arguments: current.toolCall.arguments + delta,
      complete: false,
    };
    changed = true;
    kind = "toolcall";
  } else if (update.type === "text_end") {
    const finalText = typeof update.content === "string" ? update.content
      : typeof update.text === "string" ? update.text : typeof update.delta === "string" ? delta : current.text;
    changed = current.text !== finalText;
    current.text = finalText;
    kind = "text-end";
  } else if (update.type === "thinking_end") {
    const finalThinking = typeof update.content === "string" ? update.content
      : typeof update.thinking === "string" ? update.thinking : typeof update.delta === "string" ? delta : current.thinking;
    changed = current.thinking !== finalThinking;
    current.thinking = finalThinking;
    kind = "thinking-end";
  } else if (update.type === "toolcall_end" || update.type === "tool_call_end") {
    const argumentsText = toolCallArguments(update) || delta || current.toolCall.arguments;
    current.toolCall = {
      ...current.toolCall,
      id: toolCallId(update) || current.toolCall.id,
      name: toolCallName(update) || current.toolCall.name,
      arguments: argumentsText,
      complete: true,
    };
    changed = true;
    kind = "toolcall-end";
  }

  if (!changed) return { state, changed: false, kind };
  current.changed = true;
  return { state: current, changed: true, kind };
}

/**
 * First output flushes immediately. Later writes coalesce to a maximum of one
 * flush per interval. The clock and timer hooks make this deterministic in
 * Node tests as well as browsers.
 */
export function createSustainedFlushScheduler({
  flush,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  intervalMs = FAST_OUTPUT_FLUSH_INTERVAL_MS,
} = {}) {
  if (typeof flush !== "function") throw new TypeError("flush is required");
  let timer = null;
  let pending = false;
  let lastFlushAt = null;

  const run = () => {
    timer = null;
    if (!pending) return false;
    pending = false;
    lastFlushAt = now();
    flush();
    return true;
  };

  const schedule = () => {
    if (timer !== null || !pending) return;
    const elapsed = lastFlushAt === null ? intervalMs : Math.max(0, now() - lastFlushAt);
    timer = setTimer(run, Math.max(0, intervalMs - elapsed));
  };

  return {
    request() {
      pending = true;
      if (lastFlushAt === null) return run();
      schedule();
      return false;
    },
    flushNow() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      return run();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = false;
      lastFlushAt = null;
    },
    pending() {
      return pending;
    },
  };
}
