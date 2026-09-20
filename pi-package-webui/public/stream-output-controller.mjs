const MESSAGE_UPDATE_KINDS = Object.freeze({
  thinking_start: "thinking",
  thinking_delta: "thinking",
  thinking_end: "thinking",
  text_start: "text",
  text_delta: "text",
  text_end: "text",
  toolcall_start: "tool-call",
  toolcall_delta: "tool-call",
  toolcall_end: "tool-call",
  error: "stream-error",
});

const COALESCIBLE_DELTA_TYPES = new Set(["thinking_delta", "text_delta", "toolcall_delta"]);
const DIAGNOSTIC_INDEX_LIMIT = 4096;
const URGENT_PRESSURE_ENTRY_LIMIT = 1;
export const DEFAULT_STREAM_PENDING_ENTRY_LIMIT = 128;
export const DEFAULT_STREAM_PENDING_BYTE_LIMIT = 256 * 1024;

export const TRANSCRIPT_STREAM_MESSAGE_UPDATE_TYPES = Object.freeze(Object.keys(MESSAGE_UPDATE_KINDS));

/** An explicit snapshot wins, including empty or shortened provider corrections. */
export function reconcileTranscriptThinkingSnapshot(accumulated, snapshot) {
  return typeof snapshot === "string" ? snapshot : typeof accumulated === "string" ? accumulated : "";
}

/** Reconstruct message-scoped tool calls without depending on cumulative RPC snapshots. */
export function createToolCallStreamTracker({ isHiddenTool = () => false, maxCalls = 128, maxArgumentChars = 256 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(maxArgumentChars) || maxArgumentChars < 1) {
    throw new TypeError("Tool stream limits must be positive safe integers");
  }
  const calls = new Map();
  const nonempty = (value) => typeof value === "string" ? value.trim() : "";
  const argumentText = (value) => {
    if (typeof value === "string") return value;
    if (value === undefined) return undefined;
    try { return JSON.stringify(value, null, 2); } catch { return undefined; }
  };
  return {
    reset() { calls.clear(); },
    ingest(event) {
      const update = event?.assistantMessageEvent;
      if (event?.type !== "message_update" || !["toolcall_start", "toolcall_delta", "toolcall_end"].includes(update?.type)) return null;
      const contentIndex = update.contentIndex ?? event.contentIndex ?? 0;
      if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) return null;
      const message = event.message?.role === "assistant" ? event.message : update.partial;
      const candidate = update.toolCall ?? message?.content?.[contentIndex];
      const part = candidate?.type === "toolCall" || candidate?.name ? candidate : null;
      const name = nonempty(part?.name) || nonempty(update.toolName) || nonempty(update.name);
      const id = nonempty(part?.id) || nonempty(update.id) || nonempty(update.toolCallId);
      let call = calls.get(contentIndex);
      if (!call || update.type === "toolcall_start" || (id && call.id && id !== call.id)) {
        if (!call && calls.size >= maxCalls) return null;
        call = { contentIndex, id: "", name: "", rawArguments: "", complete: false, truncated: false };
        calls.set(contentIndex, call);
      }
      if (name) call.name = name;
      if (id) call.id = id;
      call.complete = update.type === "toolcall_end";
      const visible = Boolean(call.name) && !isHiddenTool(call.name);
      if (!visible) {
        // Older RPC starts have no identity. Wait for a named snapshot or completed call.
        call.rawArguments = "";
        call.truncated = false;
      } else {
        const snapshot = argumentText(part?.arguments ?? update.arguments ?? update.args);
        if (call.complete && snapshot !== undefined) {
          call.rawArguments = snapshot.slice(0, maxArgumentChars);
          call.truncated = snapshot.length > maxArgumentChars;
        } else if (update.type === "toolcall_delta" && typeof update.delta === "string") {
          const remaining = maxArgumentChars - call.rawArguments.length;
          call.rawArguments += update.delta.slice(0, remaining);
          call.truncated ||= update.delta.length > remaining;
        } else if (snapshot !== undefined && snapshot !== "{}") {
          call.rawArguments = snapshot.slice(0, maxArgumentChars);
          call.truncated = snapshot.length > maxArgumentChars;
        }
      }
      return { ...call, visible };
    },
  };
}

export function classifyTranscriptStreamEvent(event) {
  if (event?.type === "tool_execution_update") {
    return Object.freeze({ kind: "tool-execution", subtype: "tool_execution_update", recognized: true, barrier: false });
  }
  if (event?.type !== "message_update") return null;
  const subtype = typeof event.assistantMessageEvent?.type === "string" ? event.assistantMessageEvent.type : "";
  const kind = MESSAGE_UPDATE_KINDS[subtype];
  if (!kind) return Object.freeze({ kind: "unknown-message-update", subtype, recognized: false, barrier: false });
  return Object.freeze({
    kind,
    subtype,
    recognized: true,
    barrier: subtype.endsWith("_end") || subtype === "error",
  });
}

function defaultNow() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

function defaultScheduleFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") return globalThis.requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 0);
}

function defaultCancelFrame(handle) {
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else globalThis.clearTimeout(handle);
}

function defaultSchedulePressureDrain(callback) {
  return globalThis.setTimeout(callback, 0);
}

function defaultCancelPressureDrain(handle) {
  globalThis.clearTimeout(handle);
}

function positiveLimit(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function jsonStringCodeUnits(value) {
  let units = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      units += 2;
    } else if (code < 0x20) {
      units += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units += 2;
        index += 1;
      } else {
        units += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      units += 6;
    } else {
      units += 1;
    }
  }
  return units;
}

function plainJsonCodeUnits(value, ancestors = new Set()) {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringCodeUnits(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return null;
  if (typeof value.toJSON === "function") return null;
  ancestors.add(value);
  let units = 2;
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const itemUnits = plainJsonCodeUnits(item, ancestors);
      units += (count > 0 ? 1 : 0) + (itemUnits === null ? 4 : itemUnits);
      count += 1;
    }
  } else {
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (["undefined", "function", "symbol"].includes(typeof item)) continue;
      const itemUnits = plainJsonCodeUnits(item, ancestors);
      if (itemUnits === null) {
        ancestors.delete(value);
        return null;
      }
      units += (count > 0 ? 1 : 0) + jsonStringCodeUnits(key) + 1 + itemUnits;
      count += 1;
    }
  }
  ancestors.delete(value);
  return units;
}

function conservativeEventBytes(event) {
  const codeUnits = plainJsonCodeUnits(event);
  if (codeUnits !== null) return Math.max(1, codeUnits * 2);
  try {
    const serialized = JSON.stringify(event);
    return typeof serialized === "string" ? Math.max(1, serialized.length * 2) : DEFAULT_STREAM_PENDING_BYTE_LIMIT;
  } catch {
    return DEFAULT_STREAM_PENDING_BYTE_LIMIT;
  }
}

function eventByteAccounting(event, classification) {
  const bytes = conservativeEventBytes(event);
  const delta = event?.assistantMessageEvent?.delta;
  if (!COALESCIBLE_DELTA_TYPES.has(classification?.subtype) || typeof delta !== "string") {
    return { bytes, envelopeBytes: bytes, payloadBytes: 0, incrementalDelta: false };
  }
  const payloadBytes = Math.max(0, (jsonStringCodeUnits(delta) - 2) * 2);
  return {
    bytes,
    envelopeBytes: Math.max(0, bytes - payloadBytes),
    payloadBytes,
    incrementalDelta: true,
  };
}

function eventDebugIndex(event) {
  const value = Number(event?.isolationDeltaIndex ?? event?.streamIsolationIndex);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toolCallIdentity(event) {
  const update = event?.assistantMessageEvent || {};
  return String(event?.toolCallId || update.toolCallId || update.toolCall?.id || update.id || "");
}

function entryCoalesceKey({ event, classification, owner }) {
  if (COALESCIBLE_DELTA_TYPES.has(classification.subtype)) {
    const update = event?.assistantMessageEvent || {};
    if (typeof update.delta !== "string") return "";
    const contentIndex = Number.isInteger(Number(update.contentIndex)) ? Number(update.contentIndex) : "";
    const toolId = classification.subtype === "toolcall_delta" ? toolCallIdentity(event) : "";
    return `${String(owner ?? "")}|${classification.subtype}|${contentIndex}|${toolId}`;
  }
  if (classification.kind === "tool-execution" && event?.partialResult && typeof event.partialResult === "object") {
    const toolId = toolCallIdentity(event);
    return toolId ? `${String(owner ?? "")}|tool-execution|${toolId}` : "";
  }
  return "";
}

function mergedAdjacentEntry(previous, incoming) {
  const previousKey = entryCoalesceKey(previous);
  if (!previousKey || previousKey !== entryCoalesceKey(incoming)) return null;
  if (incoming.classification.kind === "tool-execution") {
    return {
      ...incoming,
      receivedAt: previous.receivedAt !== undefined ? previous.receivedAt : incoming.receivedAt,
      sourceCount: previous.sourceCount + incoming.sourceCount,
      sourceIndexes: [...previous.sourceIndexes, ...incoming.sourceIndexes].slice(-DIAGNOSTIC_INDEX_LIMIT),
    };
  }
  const previousUpdate = previous.event.assistantMessageEvent || {};
  const incomingUpdate = incoming.event.assistantMessageEvent || {};
  const event = {
    ...incoming.event,
    assistantMessageEvent: {
      ...incomingUpdate,
      delta: `${typeof previousUpdate.delta === "string" ? previousUpdate.delta : ""}${typeof incomingUpdate.delta === "string" ? incomingUpdate.delta : ""}`,
    },
  };
  const payloadBytes = previous.payloadBytes + incoming.payloadBytes;
  return {
    ...incoming,
    event,
    receivedAt: previous.receivedAt !== undefined ? previous.receivedAt : incoming.receivedAt,
    bytes: incoming.envelopeBytes + payloadBytes,
    payloadBytes,
    sourceCount: previous.sourceCount + incoming.sourceCount,
    sourceIndexes: [...previous.sourceIndexes, ...incoming.sourceIndexes].slice(-DIAGNOSTIC_INDEX_LIMIT),
  };
}

/**
 * Owns the bounded frame queue for high-frequency transcript stream events.
 * Adjacent compatible deltas are losslessly coalesced while event-kind and
 * semantic barriers retain server order. First pressure uses one explicitly
 * bounded urgent entry and a near-term task; repeated pressure, barriers, and
 * oversize events retain synchronous lossless fallback behavior.
 */
export function createStreamOutputController({
  scheduleFrame = defaultScheduleFrame,
  cancelFrame = defaultCancelFrame,
  schedulePressureDrain = defaultSchedulePressureDrain,
  cancelPressureDrain = defaultCancelPressureDrain,
  now = defaultNow,
  isOwnerCurrent = () => true,
  applyTextUpdate = () => {},
  applyThinkingUpdate = () => {},
  applyToolCallUpdate = () => {},
  applyToolExecutionUpdate = () => {},
  applyStreamError = () => {},
  applyFollowScroll = () => {},
  onUnknownStreamEvent = () => {},
  onStaleOwner = () => {},
  onOverflow = () => {},
  onDiagnostic,
  maxPendingEntries,
  maxPendingBytes,
} = {}) {
  if (typeof scheduleFrame !== "function" || typeof cancelFrame !== "function") {
    throw new TypeError("scheduleFrame and cancelFrame must be functions");
  }
  if (typeof schedulePressureDrain !== "function" || typeof cancelPressureDrain !== "function") {
    throw new TypeError("schedulePressureDrain and cancelPressureDrain must be functions");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const entryLimit = positiveLimit(maxPendingEntries, DEFAULT_STREAM_PENDING_ENTRY_LIMIT, "maxPendingEntries");
  const byteLimit = positiveLimit(maxPendingBytes, DEFAULT_STREAM_PENDING_BYTE_LIMIT, "maxPendingBytes");
  const diagnosticsEnabled = typeof onDiagnostic === "function";
  const emitDiagnostic = diagnosticsEnabled
    ? (record) => {
        try {
          onDiagnostic(Object.freeze(record));
        } catch {
          // Test/debug instrumentation must never alter stream behavior.
        }
      }
    : () => {};

  let frameHandle = null;
  let pressureHandle = null;
  let pending = [];
  let pendingBytes = 0;
  let urgentEntry = null;

  const totalCount = () => pending.length + (urgentEntry ? 1 : 0);
  const totalBytes = () => pendingBytes + (urgentEntry?.bytes || 0);
  const ownerIsCurrent = (owner) => owner === undefined || isOwnerCurrent(owner) === true;

  const reportStale = (event, owner, classification, phase) => {
    onStaleOwner(event, owner);
    emitDiagnostic({ type: "stale", phase, owner, kind: classification?.kind || "", subtype: classification?.subtype || "", index: eventDebugIndex(event) });
  };

  const applyEntry = ({ event, classification, owner, sourceCount = 1, sourceIndexes = [] }) => {
    if (!ownerIsCurrent(owner)) {
      reportStale(event, owner, classification, "apply");
      return false;
    }
    let applied = true;
    switch (classification.kind) {
      case "text":
        applyTextUpdate(event, classification);
        break;
      case "thinking":
        applyThinkingUpdate(event, classification);
        break;
      case "tool-call":
        applyToolCallUpdate(event, classification);
        break;
      case "tool-execution":
        applyToolExecutionUpdate(event, classification);
        break;
      case "stream-error":
        applyStreamError(event, classification);
        break;
      default:
        onUnknownStreamEvent(event, classification, owner);
        applied = false;
        break;
    }
    emitDiagnostic({
      type: "apply",
      owner,
      kind: classification.kind,
      subtype: classification.subtype,
      applied,
      sourceCount,
      sourceIndexes: Object.freeze([...sourceIndexes]),
    });
    return applied;
  };

  const cancelScheduledDrains = () => {
    if (frameHandle !== null) cancelFrame(frameHandle);
    if (pressureHandle !== null) cancelPressureDrain(pressureHandle);
    frameHandle = null;
    pressureHandle = null;
  };

  const drain = () => {
    cancelScheduledDrains();
    if (!pending.length && !urgentEntry) return 0;
    const entries = urgentEntry ? [...pending, urgentEntry] : pending;
    pending = [];
    pendingBytes = 0;
    urgentEntry = null;
    const drainStart = diagnosticsEnabled ? now() : 0;
    let applied = 0;
    for (const entry of entries) {
      if (applyEntry(entry)) applied += 1;
    }
    if (applied > 0) applyFollowScroll();
    if (diagnosticsEnabled) {
      let maxAgeMs = 0;
      for (const entry of entries) {
        if (typeof entry.receivedAt === "number") maxAgeMs = Math.max(maxAgeMs, drainStart - entry.receivedAt);
      }
      emitDiagnostic({
        type: "batch",
        entries: entries.length,
        sourceCount: entries.reduce((total, entry) => total + entry.sourceCount, 0),
        applied,
        maxAgeMs,
        drainMs: now() - drainStart,
      });
    }
    return applied;
  };

  const schedule = () => {
    if (frameHandle !== null || pressureHandle !== null) return;
    frameHandle = scheduleFrame(() => {
      frameHandle = null;
      drain();
    });
  };

  const schedulePressure = () => {
    if (pressureHandle !== null) return;
    pressureHandle = schedulePressureDrain(() => {
      pressureHandle = null;
      drain();
    });
  };

  const flush = () => drain();

  const applyOversize = (entry) => {
    const applyStart = diagnosticsEnabled ? now() : 0;
    const applied = applyEntry(entry) ? 1 : 0;
    if (applied) applyFollowScroll();
    if (diagnosticsEnabled) {
      const maxAgeMs = typeof entry.receivedAt === "number" ? Math.max(0, applyStart - entry.receivedAt) : 0;
      emitDiagnostic({ type: "batch", entries: 1, sourceCount: entry.sourceCount, applied, direct: true, maxAgeMs, drainMs: now() - applyStart });
    }
    return applied;
  };

  const reportOverflow = (reason, entry) => {
    const record = { reason, pendingCount: totalCount(), pendingBytes: totalBytes(), incomingBytes: entry.bytes };
    onOverflow(record);
    emitDiagnostic({ type: "overflow", ...record });
  };

  const enqueue = (entry) => {
    const last = urgentEntry || pending[pending.length - 1];
    const merged = last ? mergedAdjacentEntry(last, entry) : null;
    const mergedFits = urgentEntry
      ? merged?.bytes <= byteLimit
      : merged && pendingBytes - last.bytes + merged.bytes <= byteLimit;
    if (mergedFits) {
      if (urgentEntry) urgentEntry = merged;
      else {
        pending[pending.length - 1] = merged;
        pendingBytes = pendingBytes - last.bytes + merged.bytes;
      }
      emitDiagnostic({ type: "queued", coalesced: true, pendingCount: totalCount(), pendingBytes: totalBytes(), sourceCount: merged.sourceCount });
      return;
    }

    if (entry.bytes > byteLimit) {
      if (totalCount()) {
        emitDiagnostic({ type: "pressure", action: "synchronous-fallback", reason: "oversize-event", pendingCount: totalCount(), pendingBytes: totalBytes() });
        flush();
      }
      reportOverflow("oversize-event", entry);
      applyOversize(entry);
      return;
    }

    if (urgentEntry) {
      emitDiagnostic({ type: "pressure", action: "synchronous-fallback", reason: merged ? "urgent-merge-limit" : "urgent-slot-full", pendingCount: totalCount(), pendingBytes: totalBytes() });
      flush();
      enqueue(entry);
      return;
    }

    if (merged || pending.length >= entryLimit || pendingBytes + entry.bytes > byteLimit) {
      const reason = merged ? "coalesced-byte-limit" : pending.length >= entryLimit ? "entry-limit" : "byte-limit";
      reportOverflow(reason, entry);
      urgentEntry = entry;
      emitDiagnostic({ type: "pressure", action: "deferred", reason, pendingCount: totalCount(), pendingBytes: totalBytes() });
      emitDiagnostic({ type: "queued", coalesced: false, urgent: true, pendingCount: totalCount(), pendingBytes: totalBytes(), sourceCount: entry.sourceCount });
      schedulePressure();
      return;
    }

    pending.push(entry);
    pendingBytes += entry.bytes;
    emitDiagnostic({ type: "queued", coalesced: false, pendingCount: totalCount(), pendingBytes: totalBytes(), sourceCount: entry.sourceCount });
  };

  return Object.freeze({
    dispatch(event, { owner } = {}) {
      const classification = classifyTranscriptStreamEvent(event);
      if (!classification) return false;
      const index = eventDebugIndex(event);
      emitDiagnostic({ type: "receipt", owner, kind: classification.kind, subtype: classification.subtype, index });
      if (!ownerIsCurrent(owner)) {
        reportStale(event, owner, classification, "dispatch");
        return true;
      }
      const accounting = eventByteAccounting(event, classification);
      const entry = {
        event,
        classification,
        owner,
        receivedAt: diagnosticsEnabled ? now() : undefined,
        ...accounting,
        sourceCount: 1,
        sourceIndexes: diagnosticsEnabled && index !== null ? [index] : [],
      };
      enqueue(entry);
      if (classification.barrier) {
        emitDiagnostic({ type: "barrier", reason: classification.subtype, pendingCount: totalCount(), pendingBytes: totalBytes() });
        flush();
      } else if (totalCount()) {
        schedule();
      }
      return true;
    },
    flush,
    barrier(reason = "semantic") {
      emitDiagnostic({ type: "barrier", reason: String(reason || "semantic"), pendingCount: totalCount(), pendingBytes: totalBytes() });
      return flush();
    },
    cancel(owner) {
      if (owner === undefined) {
        pending = [];
        urgentEntry = null;
      } else {
        pending = pending.filter((entry) => entry.owner !== owner);
        if (urgentEntry?.owner === owner) urgentEntry = null;
      }
      pendingBytes = pending.reduce((total, entry) => total + entry.bytes, 0);
      if (!totalCount()) cancelScheduledDrains();
      emitDiagnostic({ type: "cancel", owner, pendingCount: totalCount(), pendingBytes: totalBytes() });
    },
    pendingCount() {
      return totalCount();
    },
    pendingBytes() {
      return totalBytes();
    },
    limits() {
      return Object.freeze({
        maxPendingEntries: entryLimit,
        maxPendingBytes: byteLimit,
        maxUrgentEntries: URGENT_PRESSURE_ENTRY_LIMIT,
        maxUrgentBytes: byteLimit,
      });
    },
    hasScheduledFrame() {
      return frameHandle !== null;
    },
    hasScheduledPressureDrain() {
      return pressureHandle !== null;
    },
  });
}
