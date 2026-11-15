export const DRAFT_STORAGE_KEY = "pi-webui-draft-conversations-v1";
export const DRAFT_LIMITS = Object.freeze({ records: 100, text: 200_000, serialized: 2_000_000 });

const validId = id => typeof id === "string" && /^draft:[a-zA-Z0-9-]{1,80}$/.test(id);

function browserDraftId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function decode(raw) {
  if (raw.length > DRAFT_LIMITS.serialized) throw new Error("Saved drafts exceed this version's storage limit.");
  const value = JSON.parse(raw);
  if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > DRAFT_LIMITS.records) {
    throw new Error("Saved drafts have an unsupported or invalid format.");
  }
  const ids = new Set();
  for (const record of value.records) {
    if (!validId(record?.id) || ids.has(record.id) || typeof record.text !== "string"
      || record.text.length > DRAFT_LIMITS.text || !record.text.trim()
      || !Number.isSafeInteger(record.revision) || record.revision < 0
      || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
      throw new Error("A saved draft is invalid. The saved data was kept unchanged.");
    }
    ids.add(record.id);
  }
  if (value.activeId !== null && value.activeId !== "blank" && !ids.has(value.activeId)) {
    throw new Error("The saved draft selection is invalid.");
  }
  return value;
}

/** Browser drafts have no server identity. Failed writes never discard memory or overwrite unreadable data. */
export function createDraftConversations({ storage = () => globalThis.localStorage, randomId = browserDraftId, now = Date.now } = {}) {
  const records = new Map();
  let activeId = null;
  let error = "";
  let unreadable = false;

  try {
    const raw = storage().getItem(DRAFT_STORAGE_KEY);
    if (raw !== null) {
      const stored = decode(raw);
      for (const record of stored.records) records.set(record.id, { ...record, saved: true });
      activeId = stored.activeId;
    }
  } catch (cause) {
    unreadable = true;
    error = `Browser drafts could not be loaded. ${cause.message || cause} Existing storage is unchanged; edits remain in this page only.`;
  }

  function create() {
    const id = `draft:${randomId()}`;
    if (!validId(id) || records.has(id)) throw new Error("Could not allocate a unique browser draft.");
    records.set(id, { id, text: "", revision: 0, updatedAt: now(), saved: false });
    activeId = id;
    return id;
  }
  if (activeId === "blank") create();

  function persist() {
    if (unreadable) return false;
    const saved = [...records.values()].filter(record => record.saved && record.text.trim());
    try {
      if (saved.length > DRAFT_LIMITS.records || saved.some(record => record.text.length > DRAFT_LIMITS.text)) {
        throw new Error("The browser draft storage limit was reached.");
      }
      const serialized = JSON.stringify({
        version: 1,
        activeId: activeId ? saved.some(record => record.id === activeId) ? activeId : "blank" : null,
        records: saved.map(({ id, text, revision, updatedAt }) => ({ id, text, revision, updatedAt })),
      });
      if (serialized.length > DRAFT_LIMITS.serialized) throw new Error("The browser draft storage limit was reached.");
      storage().setItem(DRAFT_STORAGE_KEY, serialized);
      error = "";
      return true;
    } catch (cause) {
      error = `Browser drafts could not be saved. ${cause.message || cause} Edits remain in this page only; copy them before closing or reloading.`;
      return false;
    }
  }

  return {
    get activeId() { return activeId; },
    get error() { return error; },
    create,
    get(id) { const record = records.get(id); return record ? { ...record } : null; },
    list() { return [...records.values()].filter(record => record.saved).map(record => ({ ...record })); },
    edit(id, text) {
      const record = records.get(id);
      if (!record) return false;
      const next = String(text);
      if (record.text !== next) {
        record.text = next;
        record.revision += 1;
        record.updatedAt = now();
      }
      if (record.saved) persist();
      return true;
    },
    save(id) {
      const record = records.get(id);
      if (record) record.saved = Boolean(record.text.trim());
      return persist();
    },
    select(id) {
      if (id !== null && !records.has(id)) return false;
      activeId = id;
      persist();
      return true;
    },
    remove(id) {
      const removed = records.delete(id);
      if (activeId === id) activeId = null;
      persist();
      return removed;
    },
    persist,
  };
}
