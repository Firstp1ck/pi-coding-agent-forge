const INTERCOM_CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{24}$/;
const INTERCOM_MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{24}$/;
const INTERCOM_DETAIL_REFRESH_MS = 5_000;

function intercomBoundedString(value, maxLength = 240) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeIntercomParticipant(value, fallback) {
  const participant = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const id = intercomBoundedString(participant.id, 240);
  const name = intercomBoundedString(participant.name, 160);
  return { id: id || null, name: name || id || fallback };
}

function intercomParticipantLabel(participant, fallback = "Agent") {
  const normalized = normalizeIntercomParticipant(participant, fallback);
  return normalized.id && normalized.id !== normalized.name ? `${normalized.name} (${normalized.id})` : normalized.name;
}

function normalizeIntercomConversationSummary(value) {
  if (!value || typeof value !== "object" || !INTERCOM_CONVERSATION_ID_PATTERN.test(String(value.id || ""))) return null;
  const participants = value.participants && typeof value.participants === "object" ? value.participants : {};
  const messageCount = Number(value.messageCount);
  return Object.freeze({
    id: String(value.id),
    participants: Object.freeze({
      local: Object.freeze(normalizeIntercomParticipant(participants.local, "Local agent")),
      peer: Object.freeze(normalizeIntercomParticipant(participants.peer, "Peer agent")),
    }),
    messageCount: Number.isSafeInteger(messageCount) && messageCount >= 0 ? messageCount : 0,
    lastMessageAt: typeof value.lastMessageAt === "string" ? value.lastMessageAt : null,
    truncatedBefore: value.truncatedBefore === true,
  });
}

function normalizeIntercomConversationDetail(value) {
  const summary = normalizeIntercomConversationSummary(value);
  if (!summary) return null;
  const messages = [];
  const seenMessageIds = new Set();
  for (const candidate of Array.isArray(value.messages) ? value.messages.slice(-200) : []) {
    const id = String(candidate?.id || "");
    if (!candidate || typeof candidate !== "object" || !INTERCOM_MESSAGE_ID_PATTERN.test(id) || seenMessageIds.has(id)
      || !["local", "peer"].includes(candidate.direction) || typeof candidate.text !== "string") continue;
    seenMessageIds.add(id);
    const timestamp = typeof candidate.timestamp === "string" && Number.isFinite(Date.parse(candidate.timestamp)) ? candidate.timestamp : null;
    messages.push({
      id,
      direction: candidate.direction,
      text: candidate.text.slice(0, 65_536),
      timestamp,
      truncatedText: candidate.truncatedText === true,
    });
  }
  return { ...summary, messages };
}

function intercomConversationLabel(conversation) {
  const local = intercomParticipantLabel(conversation?.participants?.local, "Local agent");
  const peer = intercomParticipantLabel(conversation?.participants?.peer, "Peer agent");
  return `${local} ↔ ${peer}`;
}

function intercomConversationSummarySignature(conversations) {
  return JSON.stringify((conversations || []).map((conversation) => [
    conversation.id,
    intercomConversationLabel(conversation),
    conversation.messageCount,
    conversation.lastMessageAt,
    conversation.truncatedBefore,
  ]));
}

/** Owns read-only Intercom summaries, detail rendering and polling for one foreground context. */
export function createActivityIntercomController({
  document, nodes, api, getContext, isCurrent,
  onEvent = () => {}, onChange = () => {},
  onDialogOpen, onDialogClose,
  setTimeout = document.defaultView.setTimeout.bind(document.defaultView),
  clearTimeout = document.defaultView.clearTimeout.bind(document.defaultView),
  requestAnimationFrame = document.defaultView.requestAnimationFrame.bind(document.defaultView),
  cancelAnimationFrame = document.defaultView.cancelAnimationFrame.bind(document.defaultView),
  ResizeObserver = document.defaultView.ResizeObserver,
}) {
  const window = document.defaultView;
  const intercomConversationSummariesByTab = new Map();
  const intercomMessageRenderSignatures = new WeakMap();
  const emptySummaries = Object.freeze([]);
  const listeners = [];
  let disposed = false;
  let installed = false;
  let intercomSummaryRequestSerial = 0;
  let intercomSummaryRefreshTimer = null;
  let intercomDetailRequestSerial = 0;
  let intercomDetailRefreshTimer = null;
  let intercomConversationDialogState = null;
  let intercomConversationTagLayoutFrame = null;
  let intercomConversationTagResizeObserver = null;
  let intercomConversationOverflowOpen = false;
  let detailFrame = null;

  function make(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }

  function current(context) {
    return !disposed && Boolean(context?.tabId) && isCurrent(context);
  }

  function detailCurrent(state) {
    return Boolean(state && state === intercomConversationDialogState && nodes.intercomConversationDialog?.open && current(state));
  }

  function setOverflowOpen(open, { focusMenu = false, restoreFocus = false } = {}) {
    if (disposed) return;
    const container = nodes.intercomConversationTags;
    const overflow = container?.querySelector("button.composer-intercom-tag.overflow");
    const menu = container?.querySelector(".composer-intercom-overflow-menu");
    if (!container || !overflow || !menu) {
      intercomConversationOverflowOpen = false;
      return;
    }

    const availableItems = [...menu.querySelectorAll("button:not([hidden])")];
    const expanded = Boolean(open && !overflow.hidden && availableItems.length);
    intercomConversationOverflowOpen = expanded;
    container.classList.toggle("overflow-open", expanded);
    overflow.setAttribute("aria-expanded", expanded ? "true" : "false");
    menu.hidden = !expanded;

    if (expanded && focusMenu) availableItems[0]?.focus();
    else if (!expanded && restoreFocus) overflow.focus();
  }

  function fitTags() {
    const container = nodes.intercomConversationTags;
    if (disposed || !container || container.hidden) return;
    const tags = [...container.querySelectorAll(":scope > button.composer-intercom-tag:not(.overflow)")];
    const overflow = container.querySelector("button.composer-intercom-tag.overflow");
    const menuItems = [...container.querySelectorAll(".composer-intercom-overflow-menu-item")];
    if (!tags.length || !overflow || menuItems.length !== tags.length) return;

    const availableWidth = container.clientWidth;
    if (availableWidth <= 0) return;

    for (const tag of tags) tag.hidden = false;
    overflow.hidden = false;

    const containerStyle = window.getComputedStyle(container);
    const gap = Number.parseFloat(containerStyle.columnGap || containerStyle.gap) || 0;
    const tagWidths = tags.map((tag) => tag.getBoundingClientRect().width);
    const overflowWidths = new Map();
    const maxOverflowDigits = String(tags.length).length;
    for (let digits = 1; digits <= maxOverflowDigits; digits += 1) {
      overflow.textContent = `+${"0".repeat(digits)}`;
      overflowWidths.set(digits, overflow.getBoundingClientRect().width);
    }
    let visibleCount = 0;

    for (let count = tags.length; count >= 0; count -= 1) {
      const hiddenCount = tags.length - count;
      const itemCount = count + (hiddenCount ? 1 : 0);
      const tagsWidth = tagWidths.slice(0, count).reduce((total, width) => total + width, 0);
      const overflowWidth = hiddenCount ? overflowWidths.get(String(hiddenCount).length) || 0 : 0;
      const requiredWidth = tagsWidth + overflowWidth + Math.max(0, itemCount - 1) * gap;
      if (requiredWidth <= availableWidth + 0.5) {
        visibleCount = count;
        break;
      }
    }

    tags.forEach((tag, index) => { tag.hidden = index >= visibleCount; });
    menuItems.forEach((item, index) => { item.hidden = index < visibleCount; });
    const hiddenCount = tags.length - visibleCount;
    overflow.hidden = hiddenCount === 0;
    if (hiddenCount) {
      const label = `Show ${hiddenCount} more agent conversation${hiddenCount === 1 ? "" : "s"}`;
      overflow.textContent = `+${hiddenCount}`;
      overflow.title = `${label}.`;
      overflow.setAttribute("aria-label", label);
      if (intercomConversationOverflowOpen) setOverflowOpen(true);
    } else {
      setOverflowOpen(false);
    }
  }

  function scheduleTagLayout() {
    if (disposed || intercomConversationTagLayoutFrame !== null) return;
    intercomConversationTagLayoutFrame = requestAnimationFrame(() => {
      intercomConversationTagLayoutFrame = null;
      fitTags();
    });
  }

  function install() {
    const container = nodes.intercomConversationTags;
    if (disposed || installed || !container) return;
    installed = true;
    if (typeof ResizeObserver === "function") {
      intercomConversationTagResizeObserver = new ResizeObserver(scheduleTagLayout);
      intercomConversationTagResizeObserver.observe(container);
      if (container.parentElement) intercomConversationTagResizeObserver.observe(container.parentElement);
    } else {
      listen(window, "resize", scheduleTagLayout, { passive: true });
    }
    listen(container, "click", (event) => {
      const button = event.target.closest?.("button.composer-intercom-tag");
      if (!button || !container.contains(button)) return;
      if (button.classList.contains("overflow")) {
        const opening = !intercomConversationOverflowOpen;
        setOverflowOpen(opening, { focusMenu: opening });
      } else {
        if (button.classList.contains("composer-intercom-overflow-menu-item")) {
          setOverflowOpen(false, { restoreFocus: true });
        }
        open(button.dataset.intercomConversationId);
      }
    });
    listen(container, "keydown", (event) => {
      if (event.key !== "Escape" || !intercomConversationOverflowOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setOverflowOpen(false, { restoreFocus: true });
    });
    listen(container, "focusout", () => {
      window.queueMicrotask(() => {
        if (!disposed && intercomConversationOverflowOpen && !container.contains(document.activeElement)) setOverflowOpen(false);
      });
    });
    listen(document, "pointerdown", (event) => {
      if (intercomConversationOverflowOpen && !container.contains(event.target)) setOverflowOpen(false);
    });
  }

  function updateIntercomConversationTag(tag, conversation) {
    const label = intercomConversationLabel(conversation);
    tag.setAttribute("aria-label", `Open agent conversation ${label}`);
    tag.title = `${label} · ${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`;
    const visualSignature = JSON.stringify([label, conversation.messageCount]);
    if (tag.dataset.intercomVisualSignature === visualSignature) return;
    const children = [make("span", "composer-intercom-tag-icon", "↔"), make("span", "composer-intercom-tag-label", label)];
    if (conversation.messageCount > 0) children.push(make("span", "composer-intercom-tag-count", String(conversation.messageCount)));
    tag.replaceChildren(...children);
    tag.dataset.intercomVisualSignature = visualSignature;
  }

  function renderTags(tabId = getContext().tabId) {
    const container = nodes.intercomConversationTags;
    if (disposed || !container) return;
    const conversations = intercomConversationSummariesByTab.get(tabId) || [];
    if (!conversations.length) {
      intercomConversationOverflowOpen = false;
      container.classList.remove("overflow-open");
      container.replaceChildren();
      container.hidden = true;
      return;
    }

    let overflow = container.querySelector("button.composer-intercom-tag.overflow");
    if (!overflow) {
      overflow = make("button", "composer-intercom-tag overflow", `+${conversations.length}`);
      overflow.type = "button";
      overflow.hidden = true;
      overflow.setAttribute("aria-haspopup", "dialog");
      overflow.setAttribute("aria-expanded", "false");
      overflow.setAttribute("aria-controls", "intercomConversationOverflowMenu");
    }
    let menu = container.querySelector(".composer-intercom-overflow-menu");
    if (!menu) {
      menu = make("div", "composer-intercom-overflow-menu");
      menu.id = "intercomConversationOverflowMenu";
      menu.hidden = true;
      menu.setAttribute("role", "dialog");
      menu.setAttribute("aria-label", "More agent conversations");
    }
    if (overflow.parentElement !== container) container.append(overflow);
    if (menu.parentElement !== container) container.append(menu);

    const existingTags = new Map([...container.querySelectorAll(":scope > .composer-intercom-tag[data-intercom-conversation-id]")]
      .map((tag) => [tag.dataset.intercomConversationId, tag]));
    const existingMenuItems = new Map([...menu.querySelectorAll(".composer-intercom-overflow-menu-item[data-intercom-conversation-id]")]
      .map((tag) => [tag.dataset.intercomConversationId, tag]));
    const orderedTags = [];
    const orderedMenuItems = [];
    const seenConversationIds = new Set();
    for (const conversation of conversations) {
      if (seenConversationIds.has(conversation.id)) continue;
      seenConversationIds.add(conversation.id);
      let tag = existingTags.get(conversation.id);
      if (tag) existingTags.delete(conversation.id);
      else {
        tag = make("button", "composer-intercom-tag");
        tag.type = "button";
        tag.dataset.intercomConversationId = conversation.id;
        tag.setAttribute("aria-haspopup", "dialog");
        tag.setAttribute("aria-controls", "intercomConversationDialog");
      }
      updateIntercomConversationTag(tag, conversation);
      orderedTags.push(tag);

      let menuItem = existingMenuItems.get(conversation.id);
      if (menuItem) existingMenuItems.delete(conversation.id);
      else {
        menuItem = make("button", "composer-intercom-tag composer-intercom-overflow-menu-item");
        menuItem.type = "button";
        menuItem.dataset.intercomConversationId = conversation.id;
        menuItem.setAttribute("aria-haspopup", "dialog");
        menuItem.setAttribute("aria-controls", "intercomConversationDialog");
      }
      updateIntercomConversationTag(menuItem, conversation);
      orderedMenuItems.push(menuItem);
    }

    for (const staleTag of existingTags.values()) staleTag.remove();
    for (const staleItem of existingMenuItems.values()) staleItem.remove();
    let tagCursor = container.firstElementChild;
    for (const tag of orderedTags) {
      if (tag === tagCursor) tagCursor = tagCursor.nextElementSibling;
      else container.insertBefore(tag, tagCursor);
    }
    let menuCursor = menu.firstElementChild;
    for (const menuItem of orderedMenuItems) {
      if (menuItem === menuCursor) menuCursor = menuCursor.nextElementSibling;
      else menu.insertBefore(menuItem, menuCursor);
    }
    container.hidden = false;
    scheduleTagLayout();
  }

  function setStatus(message = "", level = "") {
    const status = nodes.intercomConversationStatus;
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", level === "error");
    status.classList.toggle("warn", level === "warn");
  }

  function formatIntercomMessageTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function renderIntercomConversationMessage(article, message, conversation) {
    const participant = message.direction === "local" ? conversation.participants.local : conversation.participants.peer;
    const senderLabel = intercomParticipantLabel(participant, message.direction === "local" ? "Local agent" : "Peer agent");
    const formattedTime = formatIntercomMessageTime(message.timestamp);
    const signature = JSON.stringify([message.direction, senderLabel, message.text, message.timestamp, message.truncatedText]);
    if (intercomMessageRenderSignatures.get(article) === signature) return;

    article.className = `intercom-conversation-message ${message.direction}`;
    article.dataset.intercomMessageId = message.id;
    article.setAttribute("aria-label", `${senderLabel} message`);
    const header = make("header", "intercom-conversation-message-header");
    header.append(make("strong", "intercom-conversation-message-sender", senderLabel));
    if (formattedTime) {
      const time = make("time", "intercom-conversation-message-time", formattedTime);
      time.dateTime = message.timestamp;
      header.append(time);
    }
    const text = make("p", "intercom-conversation-message-text");
    text.textContent = message.text;
    const children = [header, text];
    if (message.truncatedText) children.push(make("span", "intercom-conversation-truncated", "Message truncated"));
    article.replaceChildren(...children);
    intercomMessageRenderSignatures.set(article, signature);
  }

  function renderIntercomConversationDetail(conversation) {
    const transcript = nodes.intercomConversationTranscript;
    if (!transcript || !conversation) return;
    const state = intercomConversationDialogState;
    const signature = JSON.stringify([
      conversation.id,
      conversation.truncatedBefore,
      intercomConversationLabel(conversation),
      conversation.messages.map((message) => [message.id, message.direction, message.text, message.timestamp, message.truncatedText]),
    ]);
    if (state?.detailSignature === signature) return false;
    if (state) state.detailSignature = signature;

    const existingArticles = new Map([...transcript.querySelectorAll(":scope > .intercom-conversation-message[data-intercom-message-id]")]
      .map((article) => [article.dataset.intercomMessageId, article]));
    const shouldFollow = !existingArticles.size || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    const previousScrollTop = transcript.scrollTop;
    const anchor = shouldFollow ? null : [...existingArticles.values()]
      .find((article) => article.offsetTop + article.offsetHeight > transcript.scrollTop);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top : 0;
    const orderedArticles = [];

    for (const message of conversation.messages) {
      let article = existingArticles.get(message.id);
      if (article) existingArticles.delete(message.id);
      else article = make("article", `intercom-conversation-message ${message.direction}`);
      renderIntercomConversationMessage(article, message, conversation);
      orderedArticles.push(article);
    }
    for (const staleArticle of existingArticles.values()) staleArticle.remove();
    transcript.querySelector(":scope > .intercom-conversation-empty")?.remove();

    let cursor = transcript.firstElementChild;
    for (const article of orderedArticles) {
      if (article === cursor) cursor = cursor.nextElementSibling;
      else transcript.insertBefore(article, cursor);
    }
    if (!orderedArticles.length) transcript.append(make("p", "intercom-conversation-empty", "No messages are available in this conversation."));

    if (detailFrame !== null) cancelAnimationFrame(detailFrame);
    detailFrame = requestAnimationFrame(() => {
      detailFrame = null;
      if (!detailCurrent(state)) return;
      if (shouldFollow) transcript.scrollTop = transcript.scrollHeight;
      else if (anchor?.isConnected) {
        const currentAnchorOffset = anchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
        transcript.scrollTop += currentAnchorOffset - anchorOffset;
      }
      else transcript.scrollTop = previousScrollTop;
    });
    return true;
  }

  function updateIntercomSummaryFromDetail(conversation) {
    const state = intercomConversationDialogState;
    if (!state || !conversation) return;
    const summaries = intercomConversationSummariesByTab.get(state.tabId) || [];
    const index = summaries.findIndex((summary) => summary.id === conversation.id);
    if (index < 0) return;
    const next = [...summaries];
    next[index] = normalizeIntercomConversationSummary(conversation);
    if (intercomConversationSummarySignature(summaries) === intercomConversationSummarySignature(next)) return false;
    intercomConversationSummariesByTab.set(state.tabId, Object.freeze(next));
    return true;
  }

  async function refreshSummaries(context = getContext()) {
    if (!current(context)) return false;
    const target = { ...context };
    const serial = ++intercomSummaryRequestSerial;
    const response = await api("/api/intercom/conversations", { tabId: target.tabId });
    if (serial !== intercomSummaryRequestSerial || !current(target)) return false;
    const seen = new Set();
    const conversations = [];
    for (const value of Array.isArray(response.data?.conversations) ? response.data.conversations : []) {
      const conversation = normalizeIntercomConversationSummary(value);
      if (!conversation || seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      conversations.push(conversation);
    }
    const previous = getSummaries(target.tabId);
    const changed = intercomConversationSummarySignature(previous) !== intercomConversationSummarySignature(conversations);
    intercomConversationSummariesByTab.set(target.tabId, Object.freeze(conversations));
    if (changed && !nodes.intercomConversationDialog?.open) renderTags(target.tabId);
    if (intercomConversationDialogState?.tabId === target.tabId && !seen.has(intercomConversationDialogState.conversationId)) {
      close({ restoreFocus: false });
    }
    if (changed) onChange();
    return true;
  }

  function scheduleRefresh(context = getContext(), delay = 180) {
    if (disposed) return;
    clearTimeout(intercomSummaryRefreshTimer);
    intercomSummaryRefreshTimer = null;
    if (!current(context)) return;
    const target = { ...context };
    intercomSummaryRefreshTimer = setTimeout(() => {
      intercomSummaryRefreshTimer = null;
      if (!current(target)) return;
      const completion = refreshSummaries(target);
      const serial = intercomSummaryRequestSerial;
      completion.catch((error) => {
        if (serial === intercomSummaryRequestSerial && current(target)) {
          onEvent(`agent conversation refresh failed: ${error.message || String(error)}`, "warn");
        }
      });
    }, delay);
  }

  function scheduleDetailRefresh() {
    clearTimeout(intercomDetailRefreshTimer);
    intercomDetailRefreshTimer = null;
    const state = intercomConversationDialogState;
    if (!detailCurrent(state)) return;
    intercomDetailRefreshTimer = setTimeout(() => {
      intercomDetailRefreshTimer = null;
      if (detailCurrent(state)) refreshDetail();
    }, INTERCOM_DETAIL_REFRESH_MS);
  }

  async function refreshDetail({ announceLoading = false } = {}) {
    const state = intercomConversationDialogState;
    if (!detailCurrent(state)) return false;
    clearTimeout(intercomDetailRefreshTimer);
    intercomDetailRefreshTimer = null;
    const serial = ++intercomDetailRequestSerial;
    if (announceLoading) setStatus("Loading agent messages…");
    try {
      const path = `/api/intercom/conversations?conversation=${encodeURIComponent(state.conversationId)}`;
      const response = await api(path, { tabId: state.tabId });
      if (serial !== intercomDetailRequestSerial || !detailCurrent(state)) return false;
      const conversation = normalizeIntercomConversationDetail(response.data?.conversation);
      if (!conversation || conversation.id !== state.conversationId) throw new Error("Agent conversation is unavailable.");
      nodes.intercomConversationTitle.textContent = intercomParticipantLabel(conversation.participants.peer, "Agent conversation");
      nodes.intercomConversationParticipants.textContent = intercomConversationLabel(conversation);
      const detailChanged = renderIntercomConversationDetail(conversation);
      const summaryChanged = updateIntercomSummaryFromDetail(conversation);
      const notices = [];
      if (conversation.truncatedBefore) notices.push("Earlier messages are unavailable.");
      if (conversation.messages.some((message) => message.truncatedText)) notices.push("One or more messages were truncated.");
      setStatus(notices.join(" "), notices.length ? "warn" : "");
      if (detailChanged || summaryChanged) onChange();
      return true;
    } catch (error) {
      if (serial === intercomDetailRequestSerial && detailCurrent(state)) setStatus(error.message || String(error), "error");
      return false;
    } finally {
      if (serial === intercomDetailRequestSerial && detailCurrent(state)) scheduleDetailRefresh();
    }
  }

  function open(conversationId) {
    const context = getContext();
    const dialog = nodes.intercomConversationDialog;
    if (!current(context) || !INTERCOM_CONVERSATION_ID_PATTERN.test(String(conversationId || "")) || !dialog) return false;
    const summary = getSummaries(context.tabId).find((conversation) => conversation.id === conversationId);
    if (!summary) return false;
    resetDetail();
    const state = { ...context, conversationId, detailSignature: "" };
    intercomConversationDialogState = state;
    nodes.intercomConversationTitle.textContent = intercomParticipantLabel(summary.participants.peer, "Agent conversation");
    nodes.intercomConversationParticipants.textContent = intercomConversationLabel(summary);
    setStatus("Loading agent messages…");
    onDialogOpen(dialog);
    if (!detailCurrent(state)) return false;
    window.queueMicrotask(() => {
      if (detailCurrent(state)) nodes.intercomConversationCloseButton?.focus({ preventScroll: true });
    });
    refreshDetail();
    return true;
  }

  function resetDetail() {
    intercomDetailRequestSerial += 1;
    clearTimeout(intercomDetailRefreshTimer);
    intercomDetailRefreshTimer = null;
    if (detailFrame !== null) cancelAnimationFrame(detailFrame);
    detailFrame = null;
    intercomConversationDialogState = null;
    nodes.intercomConversationTranscript?.replaceChildren();
    if (nodes.intercomConversationParticipants) nodes.intercomConversationParticipants.textContent = "";
    setStatus("");
  }

  function reset() {
    if (disposed) return;
    resetDetail();
    renderTags();
  }

  function close({ restoreFocus = true } = {}) {
    if (disposed) return;
    const dialog = nodes.intercomConversationDialog;
    reset();
    if (dialog?.open) onDialogClose(dialog, { restoreFocus });
  }

  function activate(context = getContext()) {
    if (disposed) return;
    intercomSummaryRequestSerial += 1;
    clearTimeout(intercomSummaryRefreshTimer);
    intercomSummaryRefreshTimer = null;
    setOverflowOpen(false);
    close({ restoreFocus: false });
    renderTags(context?.tabId);
  }

  function getSummaries(tabId = getContext()?.tabId) {
    return intercomConversationSummariesByTab.get(tabId) || emptySummaries;
  }

  function prune(liveIds) {
    if (disposed) return;
    const live = new Set(liveIds);
    for (const tabId of intercomConversationSummariesByTab.keys()) {
      if (!live.has(tabId)) intercomConversationSummariesByTab.delete(tabId);
    }
    if (!live.has(getContext()?.tabId)) {
      intercomSummaryRequestSerial += 1;
      clearTimeout(intercomSummaryRefreshTimer);
      intercomSummaryRefreshTimer = null;
      renderTags();
    }
    if (intercomConversationDialogState && !live.has(intercomConversationDialogState.tabId)) close({ restoreFocus: false });
  }

  function dispose() {
    if (disposed) return;
    intercomSummaryRequestSerial += 1;
    clearTimeout(intercomSummaryRefreshTimer);
    intercomSummaryRefreshTimer = null;
    resetDetail();
    setOverflowOpen(false);
    if (intercomConversationTagLayoutFrame !== null) cancelAnimationFrame(intercomConversationTagLayoutFrame);
    intercomConversationTagLayoutFrame = null;
    intercomConversationTagResizeObserver?.disconnect();
    intercomConversationTagResizeObserver = null;
    for (const remove of listeners) remove();
    listeners.length = 0;
    intercomConversationSummariesByTab.clear();
    nodes.intercomConversationTags?.replaceChildren();
    if (nodes.intercomConversationTags) nodes.intercomConversationTags.hidden = true;
    disposed = true;
  }

  return { install, activate, refreshSummaries, scheduleRefresh, renderTags, fitTags, scheduleTagLayout, setOverflowOpen,
    open, refreshDetail, reset, close, prune, getSummaries, dispose };
}
