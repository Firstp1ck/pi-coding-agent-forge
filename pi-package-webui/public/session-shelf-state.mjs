export const SESSION_SHELF_STORAGE_KEY = "pi-webui-session-shelves-v1";

const MAX_SETTLED = 512;
const MAX_ID_LENGTH = 512;
const MAX_IDENTITY_LENGTH = 4096;
// Covers 512 maximum-length marks even when JSON escapes every string character.
const MAX_STORAGE_LENGTH = 16 * 1024 * 1024;
const SECTIONS = ["inbox", "working", "settled"];
const STATES = ["idle", "done", "input", "working"];

function validString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function normalizeMark(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, identity, completionSerial } = value;
  if (!validString(id, MAX_ID_LENGTH) || !validString(identity, MAX_IDENTITY_LENGTH)
    || !Number.isSafeInteger(completionSerial) || completionSerial < 0) return null;
  return { id, identity, completionSerial };
}

function normalizeRecord(value) {
  try {
    const mark = normalizeMark(value);
    const state = value?.state;
    return mark && STATES.includes(state) ? { ...mark, state } : null;
  } catch {
    return null;
  }
}

function readState(storage) {
  const fallback = { settled: new Map(), expanded: { inbox: true, working: true, settled: false } };
  let raw;
  try {
    raw = storage.getItem(SESSION_SHELF_STORAGE_KEY);
  } catch {
    return { ...fallback, blockedReason: "unavailable" };
  }
  if (raw === null) return { ...fallback, blockedReason: null };
  if (typeof raw !== "string" || raw.length > MAX_STORAGE_LENGTH) {
    return { ...fallback, blockedReason: "invalid-storage" };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    if (Number.isSafeInteger(value.v) && value.v > 1) return { ...fallback, blockedReason: "future-storage" };
    if (value.v !== 1 || !Array.isArray(value.settled) || value.settled.length > MAX_SETTLED
      || !value.expanded || typeof value.expanded !== "object" || Array.isArray(value.expanded)
      || !SECTIONS.every((section) => typeof value.expanded[section] === "boolean")) throw new Error("invalid");
    const settled = new Map();
    for (const entry of value.settled) {
      const mark = normalizeMark(entry);
      if (!mark || settled.has(mark.id)) throw new Error("invalid");
      settled.set(mark.id, mark);
    }
    return {
      settled,
      expanded: Object.fromEntries(SECTIONS.map((section) => [section, value.expanded[section]])),
      blockedReason: null,
    };
  } catch {
    return { ...fallback, blockedReason: "invalid-storage" };
  }
}

/** Browser-local organization only. Caller owns record identity and activity precedence. */
export function createSessionShelfState({ storage } = {}) {
  const { settled, expanded, blockedReason } = readState(storage);
  let persistence = { ok: blockedReason === null, reason: blockedReason };

  function serializableState() {
    return { v: 1, settled: [...settled.values()].map((mark) => ({ ...mark })), expanded: { ...expanded } };
  }

  function persist() {
    // An unreadable record may belong to a newer client; never replace it implicitly.
    if (blockedReason) return { ...persistence };
    try {
      storage.setItem(SESSION_SHELF_STORAGE_KEY, JSON.stringify(serializableState()));
      persistence = { ok: true, reason: null };
    } catch {
      persistence = { ok: false, reason: "unavailable" };
    }
    return { ...persistence };
  }

  return {
    reconcile(records, { pruneMissing = false } = {}) {
      const input = Array.isArray(records) ? records : [];
      const normalized = Array.from(input, normalizeRecord);
      const present = new Set();
      let changed = false;
      for (const record of normalized) {
        if (!record) continue;
        present.add(record.id);
        const mark = settled.get(record.id);
        if (mark && (record.identity !== mark.identity || record.state === "input" || record.state === "working"
          || record.completionSerial > mark.completionSerial)) {
          settled.delete(record.id);
          changed = true;
        }
      }
      // Invalid/partial catalogs cannot establish which sessions no longer exist.
      if (pruneMissing === true && Array.isArray(records) && normalized.every(Boolean)) {
        for (const id of settled.keys()) {
          if (!present.has(id)) {
            settled.delete(id);
            changed = true;
          }
        }
      }
      if (changed) persist();
      const result = { inbox: [], working: [], settled: [], expanded: { ...expanded } };
      input.forEach((record, index) => {
        const current = normalized[index];
        const section = !current ? "inbox" : current.state === "working" ? "working"
          : settled.has(current.id) ? "settled" : "inbox";
        result[section].push(record);
      });
      return result;
    },
    settle(record) {
      const current = normalizeRecord(record);
      if (!current) return { ok: false, reason: "invalid-record" };
      if (current.state === "working" || current.state === "input") return { ok: false, reason: current.state };
      const previous = settled.get(current.id);
      if (previous?.identity === current.identity && previous.completionSerial === current.completionSerial) {
        return { ...persistence };
      }
      if (!previous && settled.size >= MAX_SETTLED) return { ok: false, reason: "limit" };
      settled.set(current.id, { id: current.id, identity: current.identity, completionSerial: current.completionSerial });
      return persist();
    },
    restore(id) {
      if (!validString(id, MAX_ID_LENGTH)) return { ok: false, reason: "invalid-id" };
      return settled.delete(id) ? persist() : { ...persistence };
    },
    setExpanded(section, value) {
      if (!SECTIONS.includes(section)) return { ok: false, reason: "invalid-section" };
      if (typeof value !== "boolean") return { ok: false, reason: "invalid-expanded" };
      if (expanded[section] === value) return { ...persistence };
      expanded[section] = value;
      return persist();
    },
    snapshot() {
      return { ...serializableState(), persistence: { ...persistence } };
    },
  };
}
