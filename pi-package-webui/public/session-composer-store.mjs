export function createSessionComposerStore() {
  const drafts = new Map();
  const attachments = new Map();
  const pendingCompactions = new Set();

  return {
    getDraft(tabId) {
      return drafts.get(tabId) ?? "";
    },
    setDraft(tabId, draft) {
      if (tabId) drafts.set(tabId, String(draft ?? ""));
    },
    hasDraft(tabId) {
      return drafts.has(tabId);
    },
    deleteDraft(tabId) {
      return drafts.delete(tabId);
    },
    draftEntries() {
      return drafts.entries();
    },
    getAttachments(tabId) {
      return attachments.get(tabId) ?? [];
    },
    ensureAttachments(tabId) {
      if (!tabId) return [];
      if (!attachments.has(tabId)) attachments.set(tabId, []);
      return attachments.get(tabId);
    },
    setAttachments(tabId, items) {
      if (tabId) attachments.set(tabId, items);
    },
    hasAttachments(tabId) {
      return attachments.has(tabId);
    },
    deleteAttachments(tabId) {
      return attachments.delete(tabId);
    },
    clearTab(tabId) {
      drafts.delete(tabId);
      attachments.delete(tabId);
      pendingCompactions.delete(tabId);
    },
    beginCompaction(tabId) {
      if (!tabId || pendingCompactions.has(tabId)) return false;
      pendingCompactions.add(tabId);
      return true;
    },
    endCompaction(tabId) {
      return pendingCompactions.delete(tabId);
    },
    isCompactionPending(tabId) {
      return pendingCompactions.has(tabId);
    },
  };
}
