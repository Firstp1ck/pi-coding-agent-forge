import { reconcileTranscriptThinkingSnapshot as reconcileThinkingSnapshot } from "../public/stream-output-controller.mjs";

export { reconcileThinkingSnapshot };

function thinkingText(message, contentIndex) {
  const part = message?.content?.[contentIndex];
  if (part?.type !== "thinking") return undefined;
  if (typeof part.thinking === "string") return part.thinking;
  if (typeof part.content === "string") return part.content;
  return typeof part.text === "string" ? part.text : undefined;
}

/** Fill missing thinking-end text during streaming, never rewrite finalized messages. */
export class ThinkingStreamRecovery {
  #active = new Map();

  ingest(event) {
    if (!event || typeof event !== "object") return event;
    if ((event.type === "message_start" || event.type === "message_end") && event.message?.role === "assistant") {
      this.#active.clear();
      return event;
    }
    if (event.type !== "message_update") return event;
    const update = event.assistantMessageEvent;
    if (!["thinking_start", "thinking_delta", "thinking_end"].includes(update?.type)) return event;
    const contentIndex = update.contentIndex ?? event.contentIndex ?? 0;
    if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) return event;
    const previous = update.type === "thinking_start" ? "" : this.#active.get(contentIndex) || "";
    const partial = thinkingText(update.partial, contentIndex);
    const direct = typeof update.content === "string" ? update.content
      : typeof update.thinking === "string" ? update.thinking : undefined;
    const delta = typeof update.delta === "string" ? update.delta : "";
    const accumulated = update.type === "thinking_delta" ? previous + delta : previous;
    const next = reconcileThinkingSnapshot(accumulated, direct ?? partial);
    if (update.type !== "thinking_end") {
      this.#active.set(contentIndex, next);
      return event;
    }
    this.#active.delete(contentIndex);
    if (direct !== undefined) return event;
    return { ...event, assistantMessageEvent: { ...update, content: next } };
  }
}
