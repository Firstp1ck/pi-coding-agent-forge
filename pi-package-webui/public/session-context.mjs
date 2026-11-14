export function createSessionContext() {
  let activeTabId = null;
  let generation = 0;
  const sessionIdentities = new Map();

  function capture(tabId = activeTabId) {
    return { tabId: tabId || null, generation };
  }

  return {
    get activeTabId() { return activeTabId; },
    get generation() { return generation; },
    activate(tabId) {
      const nextTabId = tabId || null;
      if (nextTabId !== activeTabId) generation += 1;
      activeTabId = nextTabId;
      return capture();
    },
    capture,
    isCurrent(context) {
      return !!context && context.tabId === activeTabId && context.generation === generation;
    },
    invalidate(tabId = activeTabId) {
      const targetTabId = tabId || null;
      sessionIdentities.delete(targetTabId);
      if (targetTabId === activeTabId) generation += 1;
      return capture(targetTabId);
    },
    observeSession(tabId, identity) {
      const targetTabId = tabId || null;
      if (!targetTabId || !identity) return { changed: false, context: capture(targetTabId) };
      const changed = sessionIdentities.has(targetTabId) && sessionIdentities.get(targetTabId) !== identity;
      sessionIdentities.set(targetTabId, identity);
      if (changed && targetTabId === activeTabId) generation += 1;
      return { changed, context: capture(targetTabId) };
    },
  };
}
