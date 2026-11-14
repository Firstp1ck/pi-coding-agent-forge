const GIT_FILE_DIFF_CATEGORY_BY_PANEL = Object.freeze({
  staged: "staged",
  changes: "unstaged",
  conflicted: "conflicted",
  untracked: "untracked",
});

export function gitFileDiffCategory(panelCategory = "") {
  return GIT_FILE_DIFF_CATEGORY_BY_PANEL[String(panelCategory || "").trim()] || "";
}

export function resolveFileViewerMode(viewer) {
  if (!viewer) return "source";
  const hasChanges = !!viewer.gitChanges;
  if (viewer.mode === "changes") return hasChanges ? "changes" : viewer.kind === "image" ? "image" : "source";
  if (viewer.kind === "image") return "image";
  if (viewer.sourceAvailable === false) return hasChanges ? "changes" : "source";
  return viewer.mode === "preview" && viewer.language === "markdown" ? "preview" : "source";
}

/**
 * Owns per-tab buffers and selections. Projections are borrowed read-only objects.
 * activate restores a cached buffer; cache accepts only the active tab and retains
 * object identity. resetActive clears presentation without discarding that cache.
 * Requests return {success:true,viewer} or {success:false,reason,error?}. Reasons:
 * path, target, empty, read-only, declined, stale, error. A stale request may have
 * reached the server. Only a diff may apply while its originating tab is background.
 */
export function createProjectFileViewerController({
  api,
  captureTarget,
  isTargetCurrent,
  isTargetAlive,
  confirmDiscardEdits,
  normalizePath,
  fileApiPath,
  fileDisplayName,
  fileExtensionForPath,
  fileLanguageForPath,
  imageDataUrl,
  remapPath: remapFilePath,
  onChange = () => {},
  onStatus = () => {},
  onSelectPath = () => {},
  onRefreshDirectory = () => {},
  addEvent = () => {},
}) {
  const tabs = new Map();
  const saves = new WeakMap();
  let activeTabId = null;
  let viewer = null;
  let selection = null;
  let openSerial = 0;
  let diffSerial = 0;

  function ensureTab(tabId) {
    let owner = tabs.get(tabId);
    if (!owner) {
      owner = { viewer: null, selection: null };
      tabs.set(tabId, owner);
    }
    return owner;
  }

  function cache(tabId = activeTabId, editorContinuity) {
    if (!tabId || tabId !== activeTabId) return;
    if (viewer && editorContinuity !== undefined) viewer.editorContinuity = editorContinuity;
    const owner = ensureTab(tabId);
    owner.viewer = viewer;
    owner.selection = selection;
  }

  function activate(tabId) {
    openSerial += 1;
    activeTabId = tabId || null;
    viewer = tabs.get(activeTabId)?.viewer || null;
    selection = tabs.get(activeTabId)?.selection || null;
    onChange("activate");
    if (viewer?.dirty) onStatus("Unsaved file edits.", "warn");
    else if (viewer) onStatus("Restored for this terminal.", "success");
  }

  function resetActive() {
    openSerial += 1;
    viewer = null;
    selection = null;
    onChange("reset");
    onStatus("");
  }

  function close() {
    if (activeTabId) tabs.delete(activeTabId);
    openSerial += 1;
    viewer = null;
    selection = null;
    onChange("close");
    onStatus("");
  }

  function forgetTab(tabId) {
    // Deleting the owner rejects old work even if a later tab reuses this ID.
    tabs.delete(tabId);
    if (tabId === activeTabId) {
      openSerial += 1;
      viewer = null;
      selection = null;
    }
    onChange("forget");
  }

  function setDirty(dirty) {
    if (!viewer || viewer.readOnly) return;
    viewer.dirty = !!dirty;
    cache();
    onChange("content");
    if (viewer.dirty) onStatus("Unsaved file edits.", "warn");
  }

  function setContent(content) {
    if (!viewer || viewer.readOnly) return;
    viewer.content = String(content ?? "");
    viewer.size = new Blob([viewer.content]).size;
    setDirty(true);
  }

  function setMode(mode = "source") {
    if (!viewer) return;
    const previousMode = viewer.mode;
    viewer.mode = resolveFileViewerMode({ ...viewer, mode });
    if (viewer.mode === "changes" && previousMode !== "changes") selection = null;
    cache();
    onChange("mode");
  }

  function setSelection(next) {
    if (!viewer) return;
    selection = next;
    cache();
    onChange("selection");
  }

  function setEditorContinuity(state) {
    if (!viewer) return;
    viewer.editorContinuity = state;
    cache();
    onChange("continuity");
  }

  function remapPath(source, destination) {
    if (!viewer) return;
    const path = normalizePath(viewer.path || "");
    const nextPath = remapFilePath(path, source, destination);
    if (!nextPath || nextPath === path) return;
    openSerial += 1;
    saves.delete(viewer);
    const language = fileLanguageForPath(nextPath);
    Object.assign(viewer, {
      path: nextPath,
      name: fileDisplayName(nextPath),
      extension: fileExtensionForPath(nextPath),
      language,
      mode: viewer.mode === "preview" && language === "markdown" ? "preview" : "source",
      gitChanges: null,
    });
    viewer.mode = resolveFileViewerMode(viewer);
    if (selection) selection = { ...selection, path: nextPath, fileName: viewer.name };
    cache();
    onChange("move");
  }

  function isForeground(target) {
    return !!target?.tabId && target.tabId === activeTabId && isTargetCurrent(target);
  }

  function beginOpen() {
    const target = captureTarget();
    if (!isForeground(target)) return null;
    return {
      target,
      owner: ensureTab(target.tabId),
      candidate: viewer,
      content: viewer?.content,
      dirty: viewer?.dirty,
      path: viewer?.path,
      serial: ++openSerial,
    };
  }

  function isOpenCurrent(token) {
    return token.serial === openSerial && tabs.get(token.target.tabId) === token.owner
      && isForeground(token.target) && viewer === token.candidate
      && viewer?.path === token.path && viewer?.content === token.content && viewer?.dirty === token.dirty;
  }

  async function mayReplace(token, path) {
    if (token.candidate?.dirty && token.path !== path) {
      const accepted = await confirmDiscardEdits({ what: "unsaved file edits", target: token.path });
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      if (!accepted) return { success: false, reason: "declined" };
    }
    return null;
  }

  function publishOpen(next) {
    viewer = next;
    selection = null;
    cache();
    onChange("open");
  }

  async function loadDiff(path, category, tabId) {
    const snapshot = { category, path, label: "", command: "", diff: "", truncated: false, capBytes: 0, error: "" };
    try {
      const params = new URLSearchParams({ path, category });
      const response = await api(`/api/git-file-diff?${params.toString()}`, { tabId });
      if (!response.ok) throw new Error(response.error || "Failed to load Git changes for this file");
      const data = response.data || {};
      return {
        ...snapshot, ...data, category, path: data.path || path,
        diff: String(data.diff || ""), truncated: data.truncated === true,
        capBytes: Number(data.capBytes) || 0, contentError: data.error ? String(data.error) : "", error: "",
      };
    } catch (error) {
      return { ...snapshot, error: error.message || String(error) };
    }
  }

  async function applyDiff(request, token, buffer, placeholder) {
    const path = buffer.path;
    const snapshot = await request;
    if (tabs.get(token.target.tabId) !== token.owner || token.owner.viewer !== buffer
      || buffer.path !== path || buffer.gitChanges !== placeholder || !isTargetAlive(token.target)) return;
    buffer.gitChanges = snapshot;
    // Navigation changes the foreground generation, but not this live buffer.
    if (viewer === buffer && activeTabId === token.target.tabId) onChange("diff");
  }

  async function open(path = "", { gitCategory = "", gitPath = "" } = {}) {
    const normalized = normalizePath(path);
    if (!normalized) return { success: false, reason: "path" };
    const token = beginOpen();
    if (!token) return { success: false, reason: "target" };
    let changesRequest;
    let category;
    let changesPath;
    try {
      const declined = await mayReplace(token, normalized);
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      if (declined) return declined;
      onSelectPath(normalized);
      onStatus(`Opening ${normalized}…`);
      category = gitFileDiffCategory(gitCategory);
      changesPath = normalizePath(gitPath) || normalized;
      const requestSerial = category ? ++diffSerial : 0;
      changesRequest = category ? loadDiff(changesPath, category, token.target.tabId) : null;
      const response = await api(fileApiPath("/api/files/content", normalized), { tabId: token.target.tabId });
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      const data = response.data || {};
      const kind = data.kind === "image" ? "image" : "text";
      const imageUrl = kind === "image" ? imageDataUrl(data) : "";
      if (kind === "image" && !imageUrl) throw new Error("Image preview data is invalid or unsupported");
      const gitChanges = changesRequest ? {
        category, path: changesPath, label: "", command: "", diff: "", truncated: false,
        capBytes: 0, loading: true, requestSerial, error: "",
      } : null;
      const next = {
        path: normalizePath(data.path || normalized), name: data.name || fileDisplayName(normalized),
        content: kind === "text" ? String(data.content || "") : "",
        size: Number(data.size) || 0, mtimeMs: Number(data.mtimeMs) || 0, extension: data.extension || "",
        language: kind === "text" ? data.language || "text" : "image", kind,
        mimeType: kind === "image" ? String(data.mimeType || "") : "", imageUrl,
        mode: gitChanges ? "changes" : kind === "image" ? "image" : data.language === "markdown" ? "preview" : "source",
        dirty: false, readOnly: kind === "image", sourceAvailable: kind === "text", gitChanges,
      };
      publishOpen(next);
      onStatus(kind === "image" ? "Image opened in WebUI (read-only)." : "Opened in WebUI.", "success");
      if (changesRequest) void applyDiff(changesRequest, token, next, gitChanges);
      return { success: true, viewer: next };
    } catch (error) {
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      // Deleted tracked files can still show a bounded diff without live source.
      const gitChanges = changesRequest ? await changesRequest : null;
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      if (gitChanges && !gitChanges.error) {
        const next = {
          path: normalized, name: fileDisplayName(normalized), content: "", size: 0, mtimeMs: 0,
          extension: fileExtensionForPath(normalized), language: fileLanguageForPath(normalized),
          mode: "changes", dirty: false, readOnly: true, sourceAvailable: false, gitChanges,
        };
        publishOpen(next);
        onStatus("File content unavailable; showing Git changes (read-only).", "warn");
        return { success: true, viewer: next };
      }
      const message = error.message || String(error);
      onStatus(message, "error");
      addEvent(`file open failed: ${message}`, "error");
      return { success: false, reason: "error", error };
    }
  }

  async function openReport(path = "", repoRoot = "") {
    const normalized = normalizePath(path);
    const expectedRepoRoot = String(repoRoot || "");
    if (!normalized || !expectedRepoRoot) return { success: false, reason: "path" };
    const token = beginOpen();
    if (!token) return { success: false, reason: "target" };
    try {
      const declined = await mayReplace(token, normalized);
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      if (declined) return declined;
      onStatus(`Opening ${normalized}…`);
      const params = new URLSearchParams({ path: normalized, repoRoot: expectedRepoRoot });
      const response = await api(`/api/aur-review/report-content?${params.toString()}`, { tabId: token.target.tabId });
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      const data = response.data || {};
      const next = {
        path: normalizePath(data.path || normalized), name: data.name || fileDisplayName(normalized),
        content: String(data.content || ""), size: Number(data.size) || 0, mtimeMs: Number(data.mtimeMs) || 0,
        extension: data.extension || "", language: data.language || "text",
        mode: data.language === "markdown" ? "preview" : "source", dirty: false, readOnly: true,
      };
      publishOpen(next);
      onStatus("Report opened in WebUI (read-only).", "success");
      return { success: true, viewer: next };
    } catch (error) {
      if (!isOpenCurrent(token)) return { success: false, reason: "stale" };
      const message = error.message || String(error);
      onStatus(message, "error");
      addEvent(`review report open failed: ${message}`, "error");
      return { success: false, reason: "error", error };
    }
  }

  async function save(content) {
    if (!viewer) return { success: false, reason: "empty" };
    if (viewer.readOnly) {
      onStatus("This report is read-only.", "info");
      return { success: false, reason: "read-only" };
    }
    const target = captureTarget();
    if (!isForeground(target)) return { success: false, reason: "target" };
    const owner = tabs.get(target.tabId);
    const buffer = viewer;
    const path = buffer.path;
    const originalContent = buffer.content;
    const submitted = String(content ?? "");
    const token = {};
    saves.set(buffer, token);
    const isCurrent = () => tabs.get(target.tabId) === owner && owner?.viewer === buffer
      && viewer === buffer && buffer.path === path && saves.get(buffer) === token && isForeground(target);
    onStatus(`Saving ${path}…`);
    try {
      const response = await api("/api/files/content", {
        method: "POST", body: { path, content: submitted, mtimeMs: buffer.mtimeMs }, tabId: target.tabId,
      });
      if (!isCurrent()) return { success: false, reason: "stale" };
      const data = response.data || {};
      const currentContent = buffer.content === originalContent ? submitted : buffer.content;
      Object.assign(buffer, data, {
        path: normalizePath(data.path || path), content: currentContent, dirty: currentContent !== submitted,
        size: currentContent === submitted ? Number(data.size) || 0 : new Blob([currentContent]).size,
      });
      cache();
      onChange("save");
      await onRefreshDirectory(buffer.path, target);
      if (!isCurrent()) return { success: false, reason: "stale" };
      onStatus(buffer.dirty ? "Unsaved file edits." : "Saved.", buffer.dirty ? "warn" : "success");
      return { success: true, viewer: buffer };
    } catch (error) {
      if (!isCurrent()) return { success: false, reason: "stale" };
      onStatus(error.message || String(error), "error");
      return { success: false, reason: "error", error };
    }
  }

  return {
    get viewer() { return viewer; },
    get selection() { return selection; },
    get tabIds() { return [...tabs].filter(([, owner]) => owner.viewer || owner.selection).map(([tabId]) => tabId); },
    activate, cache, resetActive, close, forgetTab, setContent, setDirty, setMode,
    setSelection, setEditorContinuity, remapPath, open, openReport, save,
  };
}
