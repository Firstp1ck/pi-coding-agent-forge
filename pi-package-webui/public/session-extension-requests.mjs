function validIdentifier(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Keep blocking requests by exact tab/id without sending responses or cancelling
 * work. enqueue returns a boolean; invalid identifiers leave state unchanged.
 * pending lists queued requests only. clear includes active first. Requests keep
 * their original references; ownership keys are captured when enqueued.
 */
export function createExtensionRequestStore() {
  let queue = [];
  let active = null;

  function matches(entry, tabId, id) {
    return entry !== null && entry.tabId === tabId && entry.id === id;
  }

  function has(tabId, id) {
    if (!validIdentifier(tabId) || !validIdentifier(id)) return false;
    return matches(active, tabId, id) || queue.some((entry) => matches(entry, tabId, id));
  }

  return {
    enqueue(request) {
      const tabId = request?.tabId;
      const id = request?.id;
      if (!validIdentifier(tabId) || !validIdentifier(id) || has(tabId, id)) return false;
      queue.push({ tabId, id, request });
      return true;
    },
    takeNext() {
      if (active || queue.length === 0) return null;
      active = queue.shift();
      return active.request;
    },
    get active() { return active?.request ?? null; },
    has,
    remove(tabId, ids = []) {
      if (!validIdentifier(tabId) || !Array.isArray(ids) || Array.from(ids).some((id) => !validIdentifier(id))) {
        return { activeRemoved: false, pendingRemoved: [] };
      }
      const selected = new Set(ids);
      const activeRemoved = active !== null && active.tabId === tabId && selected.has(active.id);
      const pendingRemoved = [];
      queue = queue.filter((entry) => {
        if (entry.tabId !== tabId || !selected.has(entry.id)) return true;
        pendingRemoved.push(entry.request);
        return false;
      });
      if (activeRemoved) active = null;
      return { activeRemoved, pendingRemoved };
    },
    clear() {
      const requests = queue.map((entry) => entry.request);
      if (active) requests.unshift(active.request);
      active = null;
      queue = [];
      return requests;
    },
    pending() { return queue.map((entry) => entry.request); },
  };
}
