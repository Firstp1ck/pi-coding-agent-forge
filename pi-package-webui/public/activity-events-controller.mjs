export const EVENT_DISPLAY_MODE_STORAGE_KEY = "pi-webui-event-display-mode-v1";
export const EVENT_FILTER_STORAGE_KEY = "pi-webui-event-filter-v1";
export const EVENT_FILTER_VALUES = new Set(["all", "errors", "warnings", "tools", "tree"]);

export function normalizeEventDisplayMode(value) {
  return value === "compact" ? "compact" : "detailed";
}

export function normalizeEventFilter(value) {
  return EVENT_FILTER_VALUES.has(value) ? value : "all";
}

export function createActivityEventsController({
  document,
  nodes,
  readPreference,
  writePreference,
  isVisible,
  onJump,
  onNotice,
  onUnreadChange,
}) {
  let disposed = false;
  let eventFilter = readStoredEventFilter();
  let eventDisplayMode = readStoredEventDisplayMode();
  let eventsUnreadCount = 0;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function jumpToEvent(event) {
    if (disposed) return;
    let row = event.target;
    while (row && row.parentNode !== nodes.eventLog) row = row.parentNode;
    if (row?.classList?.contains("event")) onJump(row);
  }

  function readStoredEventDisplayMode() {
    try {
      return normalizeEventDisplayMode(readPreference(EVENT_DISPLAY_MODE_STORAGE_KEY));
    } catch {
      return "detailed";
    }
  }

  function readStoredEventFilter() {
    try {
      return normalizeEventFilter(readPreference(EVENT_FILTER_STORAGE_KEY));
    } catch {
      return "all";
    }
  }

  function eventRowMatchesFilter(line, filter = eventFilter) {
    if (!line?.classList?.contains("event") || filter === "all") return true;
    if (filter === "errors") return line.dataset.eventLevel === "error";
    if (filter === "warnings") return line.dataset.eventLevel === "warn";
    if (filter === "tools") return ["start", "finish"].includes(line.dataset.eventToolPhase);
    if (filter === "tree") return line.dataset.eventTreeAvailable === "true";
    return true;
  }

  function applyEventFilter() {
    const rows = [...(nodes.eventLog?.children || [])].filter((line) => line.classList?.contains("event"));
    let shown = 0;
    for (const line of rows) {
      const matches = eventRowMatchesFilter(line);
      line.hidden = !matches;
      if (matches) shown += 1;
    }
    const total = rows.length;
    if (nodes.eventFilterStatus) {
      nodes.eventFilterStatus.textContent = total === 0
        ? "No events yet"
        : eventFilter === "all"
          ? `${total} event${total === 1 ? "" : "s"}`
          : `${shown} of ${total}`;
    }
    if (nodes.eventFilterEmpty) {
      nodes.eventFilterEmpty.hidden = total === 0 || shown > 0;
      const label = nodes.eventFilterSelect?.selectedOptions?.[0]?.textContent?.trim() || "this filter";
      nodes.eventFilterEmpty.textContent = `No events match ${label.toLowerCase()}.`;
    }
  }

  function syncEventFilterUi() {
    if (nodes.eventFilterSelect) nodes.eventFilterSelect.value = eventFilter;
    applyEventFilter();
  }

  function setEventFilter(value, { persist = true } = {}) {
    if (disposed) return;
    eventFilter = normalizeEventFilter(value);
    syncEventFilterUi();
    if (!persist) return;
    try {
      writePreference(EVENT_FILTER_STORAGE_KEY, eventFilter);
    } catch {
      // The filter remains active for this page when storage is unavailable.
    }
  }

  function syncEventDisplayModeUi() {
    if (nodes.eventLog) nodes.eventLog.dataset.displayMode = eventDisplayMode;
    nodes.eventDisplayDetailedAction?.setAttribute("aria-checked", String(eventDisplayMode === "detailed"));
    nodes.eventDisplayCompactAction?.setAttribute("aria-checked", String(eventDisplayMode === "compact"));
  }

  function setEventDisplayMode(value, { persist = true } = {}) {
    if (disposed) return;
    eventDisplayMode = normalizeEventDisplayMode(value);
    syncEventDisplayModeUi();
    if (!persist) return;
    try {
      writePreference(EVENT_DISPLAY_MODE_STORAGE_KEY, eventDisplayMode);
    } catch {
      // Display mode remains active for this page when storage is unavailable.
    }
  }

  function addEvent(message, level = "info", { toolCallId = "", toolEventPhase = "", details = [], notify = true, occurredAt = Date.now(), aggregateKey = "", aggregateIncrement = 1, aggregateSingular = "", aggregatePlural = "" } = {}) {
    if (disposed) return;
    const stableAggregateKey = String(aggregateKey || "").trim();
    const priorAggregate = stableAggregateKey
      ? [...(nodes.eventLog?.children || [])].find((candidate) => candidate.dataset.eventAggregateKey === stableAggregateKey)
      : null;
    const aggregateCount = stableAggregateKey
      ? Math.max(0, Number.parseInt(priorAggregate?.dataset.eventAggregateCount || "0", 10) || 0) + Math.max(1, Math.trunc(Number(aggregateIncrement) || 1))
      : 0;
    const eventMessage = stableAggregateKey && aggregateSingular
      ? `${message} ${aggregateCount} ${aggregateCount === 1 ? aggregateSingular : aggregatePlural || aggregateSingular}`
      : String(message || "");
    priorAggregate?.remove();
    const line = make("button", `event ${level}`.trim());
    line.type = "button";
    line.dataset.eventLevel = String(level || "info").trim().toLowerCase() || "info";
    line.dataset.chatEventTimestamp = String(occurredAt);
    if (stableAggregateKey) {
      line.dataset.eventAggregateKey = stableAggregateKey;
      line.dataset.eventAggregateCount = String(aggregateCount);
    }
    const stableToolCallId = String(toolCallId || "").trim();
    const toolLifecycle = ["start", "finish"].includes(toolEventPhase);
    const treeEligible = stableToolCallId && toolLifecycle;
    line.dataset.eventTreeAvailable = String(!!treeEligible);
    if (stableToolCallId) line.dataset.chatToolCallId = stableToolCallId;
    if (toolLifecycle) line.dataset.eventToolPhase = toolEventPhase;
    line.setAttribute("aria-keyshortcuts", "ContextMenu Shift+F10");
    const time = make("span", "event-time", `[${new Date(occurredAt).toLocaleTimeString()}]`);
    const summary = make("span", "event-summary", eventMessage);
    const main = make("span", "event-main");
    main.append(time, summary);
    line.append(main);
    if (Array.isArray(details) && details.length) {
      const meta = make("span", "event-details");
      for (const detail of details) {
        if (!detail?.label || !detail?.value) continue;
        const item = make("span", `event-detail${detail.tone ? ` ${detail.tone}` : ""}`);
        item.append(make("span", "event-detail-label", `${detail.label}:`), document.createTextNode(` ${detail.value}`));
        meta.append(item);
      }
      if (meta.childElementCount) line.append(meta);
    }
    const accessibleText = line.textContent.trim();
    line.title = `Jump to this event in the chat; open the context menu for display options${treeEligible ? " and Tree navigation" : ""}`;
    line.setAttribute("aria-label", `${accessibleText}. Jump to this event in the chat. Context menu: display options${treeEligible ? " and Tree navigation" : ""}.`);
    nodes.eventLog.prepend(line);
    while (nodes.eventLog.children.length > 120) nodes.eventLog.lastElementChild?.remove();
    applyEventFilter();
    if (notify && (level === "error" || level === "warn")) {
      onNotice(eventMessage, level);
      noteUnreadEvent();
    }
  }

  function renderEventsUnreadBadge() {
    const badge = nodes.eventsUnreadBadge;
    if (!badge) return;
    badge.textContent = eventsUnreadCount > 99 ? "99+" : String(eventsUnreadCount);
    badge.hidden = eventsUnreadCount === 0;
    badge.setAttribute("aria-label", `${eventsUnreadCount} unread warning${eventsUnreadCount === 1 ? "" : "s"} or errors`);
  }

  function noteUnreadEvent() {
    if (isVisible()) return;
    eventsUnreadCount += 1;
    renderEventsUnreadBadge();
    onUnreadChange(eventsUnreadCount);
  }

  function clearUnreadEvents() {
    if (disposed || !eventsUnreadCount) return;
    eventsUnreadCount = 0;
    renderEventsUnreadBadge();
    onUnreadChange(eventsUnreadCount);
  }

  function syncUi() {
    if (disposed) return;
    syncEventFilterUi();
    syncEventDisplayModeUi();
    renderEventsUnreadBadge();
  }

  function syncVisibility() {
    if (!disposed && isVisible()) clearUnreadEvents();
  }

  function getSnapshot() {
    return { filter: eventFilter, displayMode: eventDisplayMode, unreadCount: eventsUnreadCount };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    nodes.eventLog.removeEventListener("click", jumpToEvent);
  }

  nodes.eventLog.addEventListener("click", jumpToEvent);
  syncUi();

  return {
    add: addEvent,
    setFilter: setEventFilter,
    setDisplayMode: setEventDisplayMode,
    syncUi,
    clearUnread: clearUnreadEvents,
    syncVisibility,
    getSnapshot,
    dispose,
  };
}
