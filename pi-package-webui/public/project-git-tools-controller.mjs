export const GIT_TOOLS_SECTIONS = Object.freeze([
  { key: "stash", title: "Stash", detail: "List, apply, pop, drop, or create stashes." },
  { key: "undo", title: "Undo & recovery", detail: "Undo the last unpushed commit, amend its message, review recent HEAD history." },
  { key: "worktrees", title: "Worktrees", detail: "Health, removal, and pruning of git worktrees." },
  { key: "submodules", title: "Submodules", detail: "Status and recursive update." },
  { key: "tags", title: "Tags", detail: "Recent tags and annotated tag creation." },
  { key: "signing", title: "Signing", detail: "Commit signing configuration and diagnostics." },
].map(Object.freeze));

export const GIT_TOOLS_ENDPOINTS = Object.freeze({
  stash: "/api/git-stash",
  undo: "/api/git-undo",
  worktrees: "/api/git-worktrees",
  submodules: "/api/git-submodules",
  tags: "/api/git-tags",
  signing: "/api/git-signing",
});

function requireSection(key) {
  if (!Object.hasOwn(GIT_TOOLS_ENDPOINTS, key)) throw new RangeError(`Unknown Git tools section: ${key}`);
}

function requireBusyKey(key) {
  if (key === "operation" || key === "conflict-agent") return;
  requireSection(typeof key === "string" && key.startsWith("load:") ? key.slice(5) : key);
}

function emptyState(tabId = null) {
  return { tabId, openSections: new Set(), cache: {}, busy: new Set(), notice: {} };
}

/** Owns one Git tools view. Reset on dialog reopen or repository/session replacement. */
export function createProjectGitToolsController({
  api, captureTarget, isTargetCurrent, confirm, addEvent, onChange,
  onRefreshChanges, onRefreshFooter, onMessage,
}) {
  let state = emptyState();
  let owner = null;

  function capture() {
    return owner?.token;
  }

  function isCurrent(token) {
    return !!owner && token === owner.token && !!owner.target?.tabId && isTargetCurrent(owner.target);
  }

  function reset(target = captureTarget()) {
    state = emptyState(target?.tabId ?? null);
    owner = { token: Symbol("Git tools owner"), target, pendingActions: new Set() };
    if (isCurrent(owner.token)) onChange();
  }

  function getState() {
    // API data is JSON; copying the projection also protects nested cached records.
    return structuredClone(state);
  }

  function setSectionOpen(key, open, token = capture()) {
    requireSection(key);
    if (!isCurrent(token)) return false;
    if (state.openSections.has(key) === !!open) return true;
    if (open) state.openSections.add(key);
    else state.openSections.delete(key);
    onChange();
    return true;
  }

  function setBusy(key, busy, token = capture()) {
    requireBusyKey(key);
    if (!isCurrent(token)) return false;
    if (state.busy.has(key) === !!busy) return true;
    if (busy) state.busy.add(key);
    else state.busy.delete(key);
    onChange();
    return true;
  }

  function setNotice(key, text, token = capture()) {
    requireSection(key);
    if (!isCurrent(token)) return false;
    if (state.notice[key] === text) return true;
    state.notice[key] = text;
    onChange();
    return true;
  }

  async function loadSection(key, { force = false }, token) {
    requireSection(key);
    if (!isCurrent(token)) return false;
    if (!force && state.cache[key]) return true;
    const busyKey = `load:${key}`;
    if (state.busy.has(busyKey)) return false;
    const { target } = owner;
    state.busy.add(busyKey);
    try {
      onChange();
      if (!isCurrent(token)) return false;
      const response = await api(GIT_TOOLS_ENDPOINTS[key], { tabId: target.tabId });
      if (!isCurrent(token)) return false;
      if (!response?.ok) throw new Error(response?.error || `Failed to load ${key}`);
      state.cache[key] = response.data;
      if (key === "undo") {
        const reflog = await api("/api/git-reflog", { tabId: target.tabId }).catch(() => null);
        if (!isCurrent(token)) return false;
        state.cache.reflog = reflog?.ok ? reflog.data : null;
      }
      state.notice[key] = "";
      return true;
    } catch (error) {
      if (!isCurrent(token)) return false;
      state.notice[key] = error?.message || String(error);
      return false;
    } finally {
      if (isCurrent(token)) {
        state.busy.delete(busyKey);
        onChange();
      }
    }
  }

  function load(key, options = {}) {
    return loadSection(key, options, capture());
  }

  /** Returns false for declined, duplicate, failed or stale work; refresh errors remain visible. */
  async function run(sectionKey, {
    url, method = "POST", body, confirm: confirmation, success, successMessage, refreshChanges = false,
  }, token = capture()) {
    requireSection(sectionKey);
    if (!isCurrent(token) || state.busy.has(sectionKey) || owner.pendingActions.has(sectionKey)) return false;
    const actionOwner = owner;
    const { target } = actionOwner;
    // Reserve before confirmation so repeated clicks cannot queue the same action.
    actionOwner.pendingActions.add(sectionKey);
    try {
      if (confirmation) {
        const accepted = await confirm(confirmation, {
          affected: target.root || "the current repository", confirmLabel: success || "Continue",
        });
        if (!isCurrent(token) || !accepted) return false;
      }
      state.busy.add(sectionKey);
      onChange();
      if (!isCurrent(token)) return false;
      const response = await api(url, { method, body, tabId: target.tabId });
      if (!isCurrent(token)) return false;
      if (!response?.ok) throw new Error([response?.error, response?.hint].filter(Boolean).join("\n") || "git action failed");
      const finalMessage = (typeof successMessage === "function" ? successMessage(response) : "") || success;
      if (!isCurrent(token)) return false;
      state.notice[sectionKey] = "";
      state.busy.delete(sectionKey);
      addEvent(finalMessage, "success");
      if (!isCurrent(token)) return false;
      await loadSection(sectionKey, { force: true }, token);
      if (!isCurrent(token)) return false;
      if (refreshChanges) {
        await onRefreshChanges(target);
        if (!isCurrent(token)) return false;
      }
      onMessage(finalMessage, target);
      if (!isCurrent(token)) return false;
      onChange();
      if (!isCurrent(token)) return false;
      await onRefreshFooter(target);
      return isCurrent(token);
    } catch (error) {
      if (!isCurrent(token)) return false;
      state.notice[sectionKey] = error?.message || String(error);
      return false;
    } finally {
      actionOwner.pendingActions.delete(sectionKey);
      if (isCurrent(token)) {
        state.busy.delete(sectionKey);
        onChange();
      }
    }
  }

  return { reset, getState, capture, isCurrent, setSectionOpen, setBusy, setNotice, load, run };
}
