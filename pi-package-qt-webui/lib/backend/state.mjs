import { createHash } from "node:crypto";
import path from "node:path";
import { LIMITS, ProtocolError } from "./protocol.mjs";
import { createJsonFileStore, stateDirectory } from "./store.mjs";

// Window state that should survive a restart but is not a user preference: composer drafts per
// session, recent and pinned directories, recent palette actions, and the open tabs. Lives under
// $XDG_STATE_HOME/qt-webui/state.json with private permissions.

function boundedStringList(list, maxItems, maxCharacters) {
  if (!Array.isArray(list)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxCharacters || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
    if (result.length >= maxItems) break;
  }
  return result;
}

function validateDrafts(raw, problems) {
  const drafts = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) problems.push("drafts must be an object");
    return drafts;
  }
  const entries = Object.entries(raw)
    .filter(([key, value]) => typeof key === "string" && key.length > 0 && key.length <= LIMITS.maxStateKeyCharacters && value && typeof value === "object" && typeof value.text === "string")
    .map(([key, value]) => [key, { text: value.text.slice(0, LIMITS.maxDraftCharacters), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 }])
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, LIMITS.maxDrafts);
  for (const [key, value] of entries) drafts[key] = value;
  return drafts;
}

function validateSettlementKeys(raw, field, maxItems, problems) {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) problems.push(`${field} must be an array`);
    return [];
  }
  const keys = [];
  const seen = new Set();
  for (const key of raw) {
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= maxItems) break;
  }
  return keys;
}

function validateSessionRestoreGrace(raw, problems) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) problems.push("sessionRestoreGrace must be an object");
    return {};
  }
  let malformed = false;
  const entries = Object.entries(raw)
    .filter(([key, restoredAt]) => {
      const valid = /^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(restoredAt) && restoredAt >= 0;
      if (!valid) malformed = true;
      return valid;
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LIMITS.maxSessionRestoreGraceEntries);
  if (malformed) problems.push("sessionRestoreGrace contains an invalid identity or timestamp");
  return Object.fromEntries(entries);
}

export function sessionSettlementKey(sessionIdentity) {
  return createHash("sha256").update(path.resolve(sessionIdentity)).digest("hex");
}

function validateTabs(raw) {
  if (!Array.isArray(raw)) return [];
  const tabs = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof entry.cwd !== "string" || entry.cwd.length === 0 || entry.cwd.length > LIMITS.maxStateKeyCharacters) continue;
    const sessionFile = typeof entry.sessionFile === "string" && entry.sessionFile.length <= LIMITS.maxStateKeyCharacters ? entry.sessionFile : "";
    const pendingResume = !sessionFile && typeof entry.pendingResume === "string" && entry.pendingResume.length <= LIMITS.maxStateKeyCharacters ? entry.pendingResume : "";
    tabs.push({
      cwd: entry.cwd,
      sessionFile,
      name: typeof entry.name === "string" ? entry.name.slice(0, LIMITS.maxRuntimeInfoCharacters) : "",
      ...(pendingResume ? { pendingResume } : {}),
    });
    if (tabs.length >= 16) break;
  }
  return tabs;
}

export function validateState(raw) {
  const problems = [];
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw !== null && raw !== undefined && source !== raw) problems.push("state file is not a JSON object");
  return {
    value: {
      drafts: validateDrafts(source.drafts, problems),
      recentDirectories: boundedStringList(source.recentDirectories, LIMITS.maxRecentEntries, LIMITS.maxPathCharacters),
      pinnedDirectories: boundedStringList(source.pinnedDirectories, LIMITS.maxRecentEntries, LIMITS.maxPathCharacters),
      recentActions: boundedStringList(source.recentActions, LIMITS.maxRecentEntries, 128),
      settledSessions: validateSettlementKeys(source.settledSessions, "settledSessions", LIMITS.maxSettledSessions, problems),
      automaticSettledSessions: validateSettlementKeys(source.automaticSettledSessions, "automaticSettledSessions", LIMITS.maxAutomaticSettledSessions, problems),
      sessionRestoreGrace: validateSessionRestoreGrace(source.sessionRestoreGrace, problems),
      tabs: validateTabs(source.tabs),
      activeTab: Number.isInteger(source.activeTab) && source.activeTab >= -1 ? source.activeTab : 0,
    },
    problems,
  };
}

export function createStateStore({ env = process.env, directory = stateDirectory(env), now = () => Date.now() } = {}) {
  const store = createJsonFileStore({ directory, fileName: "state.json", maxBytes: LIMITS.maxStateFileBytes, validate: validateState });

  function getDraft(key) {
    const draft = store.read().value.drafts[key];
    return draft ? draft.text : "";
  }

  function setDraft(key, text, expectedText) {
    return store.update((state) => {
      if (expectedText !== undefined && (state.drafts[key]?.text ?? "") !== expectedText) throw new ProtocolError("stale_request", "The saved draft has changed");
      if (text.length === 0) delete state.drafts[key];
      else state.drafts[key] = { text, updatedAt: now() };
      return state;
    }).value.drafts[key]?.text ?? "";
  }

  function pushRecent(listName, entry) {
    return store.update((state) => {
      state[listName] = [entry, ...state[listName].filter((item) => item !== entry)].slice(0, LIMITS.maxRecentEntries);
      return state;
    }).value[listName];
  }

  function togglePinned(directoryPath) {
    return store.update((state) => {
      if (state.pinnedDirectories.includes(directoryPath)) state.pinnedDirectories = state.pinnedDirectories.filter((item) => item !== directoryPath);
      else state.pinnedDirectories = [directoryPath, ...state.pinnedDirectories].slice(0, LIMITS.maxRecentEntries);
      return state;
    }).value.pinnedDirectories;
  }

  function saveTabs(tabs, activeTab) {
    return store.update((state) => {
      state.tabs = tabs;
      state.activeTab = activeTab;
      return state;
    }).value;
  }

  function setSessionSettled(sessionIdentity, settled) {
    const key = sessionSettlementKey(sessionIdentity);
    const updated = store.update((state) => {
      const manuallySettled = state.settledSessions.includes(key);
      const automaticallySettled = state.automaticSettledSessions.includes(key);
      if (settled) {
        if (!manuallySettled && !automaticallySettled) {
          if (state.settledSessions.length >= LIMITS.maxSettledSessions) throw new Error(`at most ${LIMITS.maxSettledSessions} sessions can be settled`);
          state.settledSessions.push(key);
        }
        delete state.sessionRestoreGrace[key];
      } else {
        if (manuallySettled) state.settledSessions = state.settledSessions.filter((entry) => entry !== key);
        if (automaticallySettled) state.automaticSettledSessions = state.automaticSettledSessions.filter((entry) => entry !== key);
        state.sessionRestoreGrace[key] = now();
        const graceKeys = Object.keys(state.sessionRestoreGrace);
        if (graceKeys.length > LIMITS.maxSessionRestoreGraceEntries) {
          graceKeys.sort((a, b) => state.sessionRestoreGrace[a] - state.sessionRestoreGrace[b] || b.localeCompare(a));
          for (const expired of graceKeys.slice(0, graceKeys.length - LIMITS.maxSessionRestoreGraceEntries)) delete state.sessionRestoreGrace[expired];
        }
      }
      return state;
    }).value;
    return updated.settledSessions.includes(key) || updated.automaticSettledSessions.includes(key);
  }

  function reconcileAutomaticSessionSettlement(sessions, { openSessionIdentities = [], thresholdMs, nowMs = now() } = {}) {
    if (!Number.isSafeInteger(thresholdMs) || thresholdMs <= 0) throw new TypeError("thresholdMs must be a positive safe integer");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("nowMs must be a non-negative safe integer");
    const updated = store.update(current => {
      const settledKeys = new Set([...current.settledSessions, ...current.automaticSettledSessions]);
      const automaticKeys = new Set(current.automaticSettledSessions);
      const openKeys = new Set(Array.from(openSessionIdentities, (identity) => sessionSettlementKey(identity)));
      const toSettle = [];
      let available = LIMITS.maxAutomaticSettledSessions - automaticKeys.size;
      for (const session of sessions.slice(0, LIMITS.maxSessionListEntries)) {
        if (available <= 0 || !session || typeof session.identity !== "string" || !Number.isFinite(session.modified)) continue;
        const key = sessionSettlementKey(session.identity);
        if (settledKeys.has(key) || openKeys.has(key) || nowMs - session.modified < thresholdMs) continue;
        const restoredAt = current.sessionRestoreGrace[key];
        if (Number.isSafeInteger(restoredAt) && Math.max(0, nowMs - restoredAt) < thresholdMs) continue;
        settledKeys.add(key);
        automaticKeys.add(key);
        toSettle.push(key);
        available -= 1;
      }
      for (const key of toSettle) {
        current.automaticSettledSessions.push(key);
        delete current.sessionRestoreGrace[key];
      }
      return current;
    }).value;
    return new Set([...updated.settledSessions, ...updated.automaticSettledSessions]);
  }

  return {
    read: store.read,
    update: store.update,
    getDraft,
    setDraft,
    pushRecent,
    togglePinned,
    saveTabs,
    setSessionSettled,
    reconcileAutomaticSessionSettlement,
    path: store.path,
    directory,
  };
}
