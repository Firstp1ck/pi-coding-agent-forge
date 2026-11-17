const EXTENSION_UI_BLOCKING_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Create the approval service; the caller owns tab state and lifecycle wiring. */
export function createExtensionUiRequestService({
  truncateStatusText,
  markTabWorking,
  sendSseToClient,
  tabActivitySnapshot,
  broadcastTabEvent,
}) {
  function pendingExtensionUiMap(tab) {
    if (!tab.pendingExtensionUiRequests) tab.pendingExtensionUiRequests = new Map();
    return tab.pendingExtensionUiRequests;
  }

  function isPendingExtensionUiRequest(event) {
    return event?.type === "extension_ui_request" && EXTENSION_UI_BLOCKING_METHODS.has(event.method) && event.id;
  }

  function pruneExpiredPendingExtensionUiRequests(tab, nowMs = Date.now()) {
    const pending = tab?.pendingExtensionUiRequests;
    if (!pending) return;
    for (const [id, request] of pending) {
      const expiresAtMs = Date.parse(request.expiresAt || "");
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) pending.delete(id);
    }
  }

  function pendingExtensionUiRequests(tab) {
    pruneExpiredPendingExtensionUiRequests(tab);
    return [...(tab?.pendingExtensionUiRequests?.values() || [])];
  }

  function pendingExtensionUiRequestSummaries(tab) {
    return pendingExtensionUiRequests(tab).map((request) => ({
      id: request.id,
      method: request.method,
      title: truncateStatusText(request.title || request.placeholder || "", 120),
      message: request.message ? truncateStatusText(request.message, 180) : undefined,
      receivedAt: request.receivedAt,
      expiresAt: request.expiresAt,
    }));
  }

  function trackPendingExtensionUiRequest(tab, event) {
    if (!isPendingExtensionUiRequest(event)) return;
    const receivedAt = new Date().toISOString();
    const timeoutMs = Number(event.timeout);
    const expiresAt = Number.isFinite(timeoutMs) && timeoutMs > 0 ? new Date(Date.parse(receivedAt) + timeoutMs + 1000).toISOString() : undefined;
    pendingExtensionUiMap(tab).set(String(event.id), { ...event, receivedAt, expiresAt });
    if (!tab.activity?.isWorking) markTabWorking(tab, receivedAt);
  }

  function resolvePendingExtensionUiRequest(tab, id) {
    if (!id) return false;
    return !!tab?.pendingExtensionUiRequests?.delete(String(id));
  }

  function clearPendingExtensionUiRequests(tab) {
    tab?.pendingExtensionUiRequests?.clear();
  }

  function replayPendingExtensionUiRequests(tab, client) {
    const pending = pendingExtensionUiRequests(tab);
    for (const request of pending) {
      sendSseToClient(client, {
        ...request,
        type: "extension_ui_request",
        replayed: true,
        tabId: tab.id,
        tabTitle: tab.title,
        pendingExtensionUiRequestCount: pending.length,
        tabActivity: tabActivitySnapshot(tab),
      });
    }
  }

  async function cancelPendingExtensionUiRequests(tab) {
    const pending = pendingExtensionUiRequests(tab);
    if (!pending.length) return 0;
    const ids = [];
    for (const request of pending) {
      ids.push(String(request.id));
      try {
        await tab.rpc.writeRaw({ type: "extension_ui_response", id: request.id, cancelled: true });
      } catch {
        // Abort should remain best-effort even if the RPC process already exited.
      }
      resolvePendingExtensionUiRequest(tab, request.id);
    }
    broadcastTabEvent(tab, {
      type: "webui_extension_ui_cancelled",
      tabId: tab.id,
      tabTitle: tab.title,
      ids,
      pendingExtensionUiRequestCount: pendingExtensionUiRequests(tab).length,
      tabActivity: tabActivitySnapshot(tab),
    });
    return ids.length;
  }

  return {
    pendingExtensionUiMap,
    isPendingExtensionUiRequest,
    pruneExpiredPendingExtensionUiRequests,
    pendingExtensionUiRequests,
    pendingExtensionUiRequestSummaries,
    trackPendingExtensionUiRequest,
    resolvePendingExtensionUiRequest,
    clearPendingExtensionUiRequests,
    replayPendingExtensionUiRequests,
    cancelPendingExtensionUiRequests,
  };
}
