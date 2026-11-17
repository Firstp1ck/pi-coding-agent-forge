export function normalizeQueuedMessages(event) {
  const normalize = (items) => (Array.isArray(items) ? items.map((item) => String(item || "")).filter((item) => item.trim()) : []);
  const source = event?.source === "webui-compaction" ? "webui-compaction" : "pi-runtime";
  return {
    source,
    revision: source === "webui-compaction" && Number.isSafeInteger(event?.revision) && event.revision >= 0 ? event.revision : undefined,
    draining: source === "webui-compaction" && event?.draining === true,
    steering: normalize(event?.steering),
    followUp: normalize(event?.followUp),
  };
}

export function queueMessageCount(snapshot) {
  return (snapshot?.steering?.length || 0) + (snapshot?.followUp?.length || 0);
}

export function queueMutationBody(snapshot, operation) {
  const body = {
    source: snapshot.source,
    kind: "followUp",
    expected: { steering: [...snapshot.steering], followUp: [...snapshot.followUp] },
    operation,
  };
  if (snapshot.source === "webui-compaction") body.revision = snapshot.revision;
  return body;
}

export function preservedFocusedFollowUpQueueDraft(draft, followUps) {
  if (!draft || !Array.isArray(followUps) || !Number.isSafeInteger(draft.index) || draft.index < 0) return null;
  const authoritativeText = String(draft.authoritativeText ?? "");
  const value = String(draft.value ?? "");
  if (value === authoritativeText || followUps[draft.index] !== authoritativeText) return null;
  const selectionStart = Math.max(0, Math.min(value.length, Number.isSafeInteger(draft.selectionStart) ? draft.selectionStart : value.length));
  const selectionEnd = Math.max(selectionStart, Math.min(value.length, Number.isSafeInteger(draft.selectionEnd) ? draft.selectionEnd : selectionStart));
  return { index: draft.index, value, selectionStart, selectionEnd };
}

export function createActivityQueueController({
  document, nodes, api, getContext, isCurrent, isAlive, getSnapshot, setSnapshot,
  onBeforeOpen = () => {}, onAfterClose = () => {}, onProjectionChange = () => {},
  onEvent = () => {}, deferRender = () => false,
  captureContinuity = () => null, restoreContinuity = () => {},
  isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files"),
  requestAnimationFrame = document.defaultView.requestAnimationFrame.bind(document.defaultView),
  cancelAnimationFrame = document.defaultView.cancelAnimationFrame.bind(document.defaultView),
}) {
  let disposed = false;
  let open = false;
  let status = { text: "", level: "" };
  let restoreFocusTarget = null;
  let drag = null;
  let suppressBlurFor = null;
  let presentation = 0;
  let overlaySerial = 0;
  const locks = new Map();
  const frames = new Set();
  const alive = (context) => !disposed && !!context?.tabId && isAlive(context);
  const current = (context) => alive(context) && isCurrent(context);
  const snapshotFor = (tabId = getContext()?.tabId) => getSnapshot(tabId) || normalizeQueuedMessages({});
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function frame(callback) {
    const epoch = presentation;
    const id = requestAnimationFrame(() => {
      frames.delete(id);
      if (!disposed && epoch === presentation) callback();
    });
    frames.add(id);
  }

  function cancelFrames() {
    for (const id of frames) cancelAnimationFrame(id);
    frames.clear();
  }

  function defer(key, callback) {
    const context = getContext();
    const epoch = presentation;
    return deferRender(key, () => {
      if (current(context) && epoch === presentation) callback();
    });
  }

  function isMutationInFlight(tabId = getContext()?.tabId) {
    const token = locks.get(tabId);
    return !!token && alive(token.context);
  }

  function setStatus(text = "", level = "") {
    if (disposed) return;
    status = { text, level };
    if (!nodes.followUpQueueStatus) return;
    nodes.followUpQueueStatus.textContent = text;
    nodes.followUpQueueStatus.className = `follow-up-queue-status${level ? ` ${level}` : ""}`;
  }

  function syncControls() {
    const locked = isMutationInFlight();
    const draining = snapshotFor().draining;
    nodes.followUpQueueOverlay?.classList.toggle("is-busy", locked);
    nodes.followUpQueueOverlay?.classList.toggle("is-draining", draining);
    for (const control of nodes.followUpQueueRows?.querySelectorAll("[data-follow-up-queue-mutation-control]") || []) {
      control.disabled = locked || draining || control.dataset.queueBoundary === "true";
    }
    for (const handle of nodes.followUpQueueRows?.querySelectorAll(".follow-up-queue-drag-handle") || []) handle.draggable = !locked && !draining;
  }

  function clearDragVisuals() {
    for (const row of nodes.followUpQueueRows?.querySelectorAll(".is-dragging, .is-drop-target") || []) row.classList.remove("is-dragging", "is-drop-target");
  }

  function setOpen(value, { restoreFocus = false } = {}) {
    if (disposed) return;
    const shouldOpen = !!value && snapshotFor().followUp.length > 0;
    cancelFrames();
    if (shouldOpen && !open) {
      restoreFocusTarget = document.activeElement instanceof document.defaultView.HTMLElement ? document.activeElement : nodes.followUpQueueTrigger;
      onBeforeOpen();
    }
    open = shouldOpen;
    nodes.followUpQueueTrigger?.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    if (nodes.followUpQueueOverlay) nodes.followUpQueueOverlay.hidden = !shouldOpen;
    if (!shouldOpen) {
      drag = null;
      clearDragVisuals();
      onAfterClose();
      if (restoreFocus) {
        const context = getContext();
        const target = restoreFocusTarget?.isConnected ? restoreFocusTarget : nodes.followUpQueueTrigger;
        frame(() => { if (!open && current(context)) target?.focus({ preventScroll: true }); });
      }
      restoreFocusTarget = null;
      return;
    }
    renderOverlay();
  }

  function ingest(event) {
    if (disposed) return;
    const context = getContext(event?.tabId || getContext()?.tabId);
    if (!alive(context)) return;
    setSnapshot(context.tabId, normalizeQueuedMessages(event));
    if (current(context)) render();
  }

  function applyAuthoritative(context, queue) {
    if (!alive(context) || !queue) return;
    setSnapshot(context.tabId, normalizeQueuedMessages(queue));
    // Navigation may advance generation while the originating lifetime stays alive.
    const foreground = getContext(context.tabId);
    if (alive(context) && current(foreground)) render();
  }

  function operationMatches(snapshot, operation) {
    if (!operation || !["edit", "delete", "move"].includes(operation.type)) return false;
    const index = operation.type === "move" ? operation.from : operation.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.followUp.length || snapshot.followUp[index] !== operation.expectedText) return false;
    if (operation.type === "edit") return typeof operation.text === "string" && !!operation.text.trim();
    return operation.type !== "move" || (Number.isSafeInteger(operation.to) && operation.to >= 0 && operation.to < snapshot.followUp.length && operation.to !== index);
  }

  async function mutate(operation, context = getContext()) {
    if (!alive(context) || isMutationInFlight(context.tabId)) return false;
    const snapshot = snapshotFor(context.tabId);
    if (!snapshot.followUp.length || snapshot.draining) {
      if (current(context)) setStatus("Queue is draining; follow-ups can no longer be changed.", "warn");
      return false;
    }
    if (!operationMatches(snapshot, operation)) return false;
    const token = { context };
    locks.set(context.tabId, token);
    if (current(context)) {
      syncControls();
      setStatus(operation.type === "edit" ? "Saving queued follow-up…" : operation.type === "delete" ? "Removing queued follow-up…" : "Reordering queued follow-ups…");
    }
    try {
      const response = await api("/api/queue/mutate", { method: "POST", body: queueMutationBody(snapshot, operation), tabId: context.tabId });
      if (!alive(context)) return false;
      const result = response?.data || {};
      if (result.queue) applyAuthoritative(context, result.queue);
      if (!alive(context)) return false;
      if (!result.mutated) {
        if (current(context)) setStatus("Queue changed before the update could be applied.", "warn");
        return false;
      }
      if (current(context)) setStatus(operation.type === "edit" ? `Saved queued follow-up ${operation.index + 1}.` : operation.type === "delete" ? `Removed queued follow-up ${operation.index + 1}.` : `Moved queued follow-up ${operation.from + 1} to position ${operation.to + 1}.`, "success");
      return true;
    } catch (error) {
      if (!alive(context)) return false;
      const result = error?.data?.data || {};
      if (result.queue) applyAuthoritative(context, result.queue);
      if (current(context)) {
        if (error?.statusCode === 409) setStatus(result.reason === "queue-draining" ? "Queue is draining; refreshed the authoritative queue." : "Queue changed elsewhere; refreshed the authoritative queue.", "warn");
        else setStatus(error.message || "Unable to update the queued follow-up.", "error");
      }
      return false;
    } finally {
      // A retired operation may share a tab ID with replacement-session work.
      if (locks.get(context.tabId) === token) {
        locks.delete(context.tabId);
        const foreground = getContext(context.tabId);
        if (alive(context) && current(foreground)) renderOverlay();
      }
    }
  }

  async function remove(index, text, context = getContext()) {
    const removed = await mutate({ type: "delete", index, expectedText: text }, context);
    if (removed && current(context)) onEvent(`removed queued follow-up #${index + 1}`);
    return removed && alive(context);
  }

  function saveText(index, expectedText, value, context) {
    const text = String(value ?? "");
    if (!current(context) || text === expectedText) return;
    if (!text.trim()) {
      const draft = focusedFollowUpQueueDraft();
      if (draft?.index === index && draft.authoritativeText === expectedText) draft.textarea.value = expectedText;
      setStatus("Queued follow-ups cannot be empty; restored the authoritative text.", "warn");
      renderOverlay();
      return;
    }
    void mutate({ type: "edit", index, expectedText, text }, context);
  }

  function updateQueueHeaderBadge(total) {
    if (!nodes.queueCountBadge) return;
    nodes.queueCountBadge.hidden = total === 0;
    nodes.queueCountBadge.textContent = String(total);
    nodes.queueCountBadge.setAttribute("aria-label", `${total} queued message${total === 1 ? "" : "s"}`);
  }

  function queueSummaryPill(label, count, tone) {
    const pill = make("span", `queue-summary-pill ${tone}`.trim());
    pill.append(make("strong", undefined, String(count)), make("span", undefined, label));
    return pill;
  }

  function focusedFollowUpQueueDraft() {
    const textarea = document.activeElement;
    if (!textarea?.matches?.("textarea.follow-up-queue-textarea") || !nodes.followUpQueueRows?.contains(textarea)) return null;
    const index = Number(textarea.closest(".follow-up-queue-row")?.dataset.followUpIndex);
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const authoritativeText = String(textarea.dataset.followUpQueueAuthoritativeText ?? "");
    if (textarea.value === authoritativeText) return null;
    return {
      textarea,
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft,
      index,
      authoritativeText,
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  }

  function renderOverlay() {
    if (disposed || defer("follow-up-queue", renderOverlay)) return;
    const context = getContext();
    const epoch = presentation;
    const serial = ++overlaySerial;
    const snapshot = snapshotFor();
    const followUps = snapshot.followUp;
    const count = followUps.length;
    const trigger = nodes.followUpQueueTrigger;
    if (trigger) {
      trigger.hidden = count === 0;
      trigger.setAttribute("aria-expanded", open && count ? "true" : "false");
      trigger.setAttribute("aria-label", `${count} queued follow-up${count === 1 ? "" : "s"}`);
    }
    if (nodes.followUpQueueTriggerCount) nodes.followUpQueueTriggerCount.textContent = String(count);
    if (nodes.followUpQueueOverlayCount) nodes.followUpQueueOverlayCount.textContent = String(count);
    if (!count) {
      if (open) setOpen(false);
      if (nodes.followUpQueueRows) nodes.followUpQueueRows.replaceChildren();
      return;
    }
    if (!open || !nodes.followUpQueueRows) return;

    const locked = isMutationInFlight();
    const unavailable = locked || snapshot.draining;
    const focusedDraft = focusedFollowUpQueueDraft();
    const preservedDraft = preservedFocusedFollowUpQueueDraft(focusedDraft, followUps);
    const rows = followUps.map((item, index) => {
      const row = make("article", "follow-up-queue-row");
      row.dataset.followUpIndex = String(index);
      row.draggable = false;
      const rowCurrent = () => open && current(context) && epoch === presentation && row.isConnected;
      const dragHandle = make("span", "follow-up-queue-drag-handle", "⠿");
      dragHandle.draggable = !unavailable;
      dragHandle.setAttribute("aria-hidden", "true");
      dragHandle.title = "Drag to reorder";
      const textarea = make("textarea", "follow-up-queue-textarea");
      const textareaDraft = preservedDraft?.index === index ? preservedDraft : null;
      textarea.value = textareaDraft ? textareaDraft.value : item;
      textarea.dataset.followUpQueueAuthoritativeText = item;
      textarea.rows = Math.max(2, Math.min(6, item.split("\n").length + 1));
      textarea.disabled = unavailable;
      textarea.setAttribute("aria-label", `Queued follow-up ${index + 1}`);
      textarea.dataset.followUpQueueMutationControl = "true";
      textarea.addEventListener("blur", () => {
        if (textarea === suppressBlurFor) return;
        if (rowCurrent()) saveText(index, item, textarea.value, context);
      });
      textarea.addEventListener("keydown", (event) => {
        if (!rowCurrent()) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === "Enter") {
          event.preventDefault();
          saveText(index, item, textarea.value, context);
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (textarea.value !== item) {
          textarea.value = item;
          setStatus(`Restored queued follow-up ${index + 1}.`, "warn");
        } else {
          setOpen(false, { restoreFocus: true });
        }
      });
      const controls = make("div", "follow-up-queue-row-controls");
      const moveUp = make("button", "follow-up-queue-move-button", "↑");
      moveUp.type = "button";
      moveUp.dataset.followUpQueueMutationControl = "true";
      moveUp.dataset.queueBoundary = index === 0 ? "true" : "false";
      moveUp.disabled = unavailable || index === 0;
      moveUp.title = `Move queued follow-up ${index + 1} up`;
      moveUp.setAttribute("aria-label", `Move queued follow-up ${index + 1} up`);
      moveUp.addEventListener("click", () => { if (rowCurrent()) void mutate({ type: "move", from: index, to: index - 1, expectedText: item }, context); });
      const moveDown = make("button", "follow-up-queue-move-button", "↓");
      moveDown.type = "button";
      moveDown.dataset.followUpQueueMutationControl = "true";
      moveDown.dataset.queueBoundary = index === followUps.length - 1 ? "true" : "false";
      moveDown.disabled = unavailable || index === followUps.length - 1;
      moveDown.title = `Move queued follow-up ${index + 1} down`;
      moveDown.setAttribute("aria-label", `Move queued follow-up ${index + 1} down`);
      moveDown.addEventListener("click", () => { if (rowCurrent()) void mutate({ type: "move", from: index, to: index + 1, expectedText: item }, context); });
      const removeButton = make("button", "follow-up-queue-remove-button", "Remove");
      removeButton.type = "button";
      removeButton.dataset.followUpQueueMutationControl = "true";
      removeButton.title = `Remove queued follow-up ${index + 1}`;
      removeButton.setAttribute("aria-label", `Remove queued follow-up ${index + 1}`);
      removeButton.addEventListener("pointerdown", () => { if (rowCurrent()) suppressBlurFor = textarea; });
      removeButton.addEventListener("pointercancel", () => {
        if (suppressBlurFor === textarea) suppressBlurFor = null;
      });
      removeButton.addEventListener("click", () => {
        if (suppressBlurFor === textarea) suppressBlurFor = null;
        if (rowCurrent()) void remove(index, item, context);
      });
      controls.append(moveUp, moveDown, removeButton);
      row.append(dragHandle, textarea, controls);
      row.addEventListener("dragstart", (event) => {
        if (!rowCurrent() || isMutationInFlight(context.tabId) || snapshotFor(context.tabId).draining || unavailable || event.target?.closest?.(".follow-up-queue-drag-handle") !== dragHandle) {
          event.preventDefault();
          return;
        }
        drag = { context, index, expectedText: item };
        event.dataTransfer?.setData("application/x-pi-webui-follow-up", JSON.stringify({ tabId: context.tabId, index, expectedText: item }));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragover", (event) => {
        if (!rowCurrent() || !drag || !current(drag.context) || isMutationInFlight(context.tabId) || snapshotFor(context.tabId).draining || unavailable || isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        clearDragVisuals();
        row.classList.add("is-drop-target");
      });
      row.addEventListener("dragleave", (event) => {
        if (!row.contains(event.relatedTarget)) row.classList.remove("is-drop-target");
      });
      row.addEventListener("drop", (event) => {
        if (!rowCurrent() || !drag || !current(drag.context) || isMutationInFlight(context.tabId) || snapshotFor(context.tabId).draining || unavailable || isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const source = drag;
        clearDragVisuals();
        drag = null;
        if (source.index !== index) void mutate({ type: "move", from: source.index, to: index, expectedText: source.expectedText }, source.context);
      });
      row.addEventListener("dragend", () => {
        if (!rowCurrent()) return;
        drag = null;
        clearDragVisuals();
      });
      return row;
    });
    const scrollTop = nodes.followUpQueueRows.scrollTop;
    const scrollLeft = nodes.followUpQueueRows.scrollLeft;
    drag = null;
    suppressBlurFor = focusedDraft?.textarea || null;
    try {
      nodes.followUpQueueRows.replaceChildren(...rows);
    } finally {
      suppressBlurFor = null;
    }
    nodes.followUpQueueRows.scrollTop = scrollTop;
    nodes.followUpQueueRows.scrollLeft = scrollLeft;
    if (preservedDraft && !unavailable) {
      frame(() => {
        if (!open || !current(context) || epoch !== presentation || serial !== overlaySerial) return;
        const activeElement = document.activeElement;
        if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) return;
        const textarea = nodes.followUpQueueRows?.querySelector(`.follow-up-queue-row[data-follow-up-index="${preservedDraft.index}"] textarea`);
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(preservedDraft.selectionStart, preservedDraft.selectionEnd);
        textarea.scrollTop = focusedDraft.scrollTop;
        textarea.scrollLeft = focusedDraft.scrollLeft;
      });
    }
    setStatus(status.text, status.level);
    syncControls();
  }

  function renderQueueGroup(label, items, tone, { removable = false, context } = {}) {
    const epoch = presentation;
    const tabId = context?.tabId;
    const group = make("section", `queue-group ${tone}`.trim());
    const heading = make("h3", "queue-group-title");
    heading.append(make("span", undefined, label), make("span", "queue-group-count", String(items.length)));
    const list = make("ol", "queue-list");
    items.forEach((item, index) => {
      const row = make("li", `queue-item${removable ? " can-remove" : ""}`);
      row.append(make("span", "queue-item-number", `#${index + 1}`), make("div", "queue-item-text", item));
      if (removable) {
        const removeButton = make("button", "queue-remove-button", "Remove");
        removeButton.type = "button";
        removeButton.dataset.queueContinuityKey = `remove:${tabId || ""}:${index}:${item}`;
        removeButton.title = `Remove queued follow-up #${index + 1}`;
        removeButton.setAttribute("aria-label", `Remove queued follow-up #${index + 1}`);
        removeButton.addEventListener("click", async () => {
          if (!current(context) || epoch !== presentation || !removeButton.isConnected) return;
          removeButton.disabled = true;
          removeButton.textContent = "Removing…";
          const removed = await remove(index, item, context);
          if (!removed && current(context) && epoch === presentation && removeButton.isConnected) {
            removeButton.disabled = false;
            removeButton.textContent = "Remove";
          }
        });
        row.append(removeButton);
      }
      list.append(row);
    });
    group.append(heading, list);
    return group;
  }

  function render() {
    if (disposed || defer("queue", render)) return;
    const context = getContext();
    const tabId = context?.tabId;
    const snapshot = snapshotFor(tabId);
    if (!nodes.queueBox) { renderOverlay(); onProjectionChange(); return; }
    const continuityContextKey = `${tabId || ""}:${context?.generation ?? ""}:queue`;
    const focusSnapshot = captureContinuity(nodes.queueBox, continuityContextKey, (node) => node?.dataset?.queueContinuityKey || "");
    const scrollTop = nodes.queueBox.scrollTop;
    const scrollLeft = nodes.queueBox.scrollLeft;
    const restore = () => {
      restoreContinuity(nodes.queueBox, continuityContextKey, focusSnapshot, (key) => [...nodes.queueBox.querySelectorAll("[data-queue-continuity-key]")]
        .find((node) => node.dataset.queueContinuityKey === key));
      nodes.queueBox.scrollTop = scrollTop;
      nodes.queueBox.scrollLeft = scrollLeft;
    };
    const steering = snapshot.steering;
    const followUp = snapshot.followUp;
    const total = queueMessageCount(snapshot);
    updateQueueHeaderBadge(total);
    nodes.queueBox.replaceChildren();
    nodes.queueBox.classList.toggle("muted", total === 0);
    nodes.queueBox.classList.toggle("has-items", total > 0);
    if (total === 0) {
      nodes.queueBox.append(make("div", "queue-empty", "No queued messages."));
      renderOverlay();
      onProjectionChange();
      restore();
      return;
    }

    const summary = make("div", "queue-summary");
    summary.append(make("strong", undefined, `${total} queued message${total === 1 ? "" : "s"}`));
    const counts = make("div", "queue-summary-counts");
    if (steering.length) counts.append(queueSummaryPill("steering", steering.length, "steering"));
    if (followUp.length) counts.append(queueSummaryPill("follow-up", followUp.length, "follow-up"));
    summary.append(counts);

    nodes.queueBox.append(summary);
    if (steering.length) nodes.queueBox.append(renderQueueGroup("Steering", steering, "steering", { context }));
    if (followUp.length) nodes.queueBox.append(renderQueueGroup("Follow-up", followUp, "follow-up", { removable: !snapshot.draining, context }));
    nodes.queueBox.append(make("div", "queue-hint", snapshot.source === "pi-runtime"
      ? "Alt+Up restores this queue snapshot to the composer without clearing Pi's queue. Use Remove beside follow-ups to drop them from the queue."
      : "Alt+Up restores this queue snapshot to the composer without clearing Pi's queue. Edit, reorder, or remove compaction-held follow-ups with the composer Queue control."));
    renderOverlay();
    onProjectionChange();
    restore();
  }

  function activate() {
    if (disposed) return;
    presentation += 1;
    cancelFrames();
    nodes.followUpQueueRows?.replaceChildren();
    setOpen(false);
    setStatus();
    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    presentation += 1;
    cancelFrames();
    open = false;
    drag = null;
    suppressBlurFor = null;
    restoreFocusTarget = null;
    locks.clear();
    if (nodes.followUpQueueOverlay) nodes.followUpQueueOverlay.hidden = true;
    nodes.followUpQueueTrigger?.setAttribute("aria-expanded", "false");
    nodes.followUpQueueRows?.replaceChildren();
  }

  return { ingest, render, renderOverlay, setOpen, isOpen: () => open, mutate, remove, setStatus, isMutationInFlight, activate, dispose };
}
