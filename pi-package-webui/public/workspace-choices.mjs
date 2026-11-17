export const WORKSPACE_CHOICE_FOLDER_LIMIT = 12;

/**
 * Returns a comparison key for a folder path: trimmed, forward slashes, no
 * trailing slash (roots keep theirs). Windows drive paths compare
 * case-insensitively. Returns "" for an empty path.
 */
export function workspacePathKey(path) {
  const text = String(path ?? "").trim().replace(/\\/g, "/");
  if (!text) return "";
  let key = text.replace(/\/+$/, "") || "/";
  if (/^[a-z]:$/i.test(key)) key += "/";
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key;
}

/** Returns the last path segment for display, or the whole path for roots. */
export function workspaceFolderName(path) {
  const display = String(path ?? "").trim().replace(/\\/g, "/");
  return display.replace(/\/+$/, "").split("/").filter(Boolean).pop() || display;
}

function folderSource(item) {
  if (typeof item === "string") return { cwd: item.trim(), display: item.trim() };
  const cwd = typeof item?.cwd === "string" ? item.cwd.trim() : "";
  const display = typeof item?.displayCwd === "string" && item.displayCwd.trim() ? item.displayCwd.trim() : cwd;
  return { cwd, display };
}

/**
 * Builds the ordered folder choices for starting or retargeting a thread draft.
 *
 * Order: the current folder, "No project", the draft's selected folder when no
 * other source lists it, pinned folders, recent folders, then the "Browse…"
 * action and, when `includeWorktree` is set, the "Branch worktree…" action.
 * Folders are deduplicated by `workspacePathKey`; the first occurrence keeps
 * its position and later sources only add their flag. At most `limit` current,
 * pinned and recent folders are returned; the selected folder is always kept
 * so the draft's own choice stays visible.
 *
 * @param {object} input
 * @param {string} [input.currentCwd] Active thread folder, or the last real thread's folder on a draft.
 * @param {string|null} [input.selectedCwd] Draft folder to mark selected; "" marks "No project"; null marks nothing.
 * @param {Array<string|{cwd: string, displayCwd?: string}>} [input.pinned] Path fast picks in their saved order.
 * @param {Array<string|{cwd: string, displayCwd?: string}>} [input.recent] Open thread folders, most recent first.
 * @param {boolean} [input.includeWorktree] Adds the eager "Branch worktree…" action.
 * @param {number} [input.limit] Maximum folder entries.
 * @returns {Array<{id: string, kind: "folder"|"no-project"|"browse"|"worktree", label: string, path: string, tag: string, cwd?: string, selected: boolean}>}
 */
export function buildWorkspaceChoices({ currentCwd = "", selectedCwd = null, pinned = [], recent = [], includeWorktree = false, limit = WORKSPACE_CHOICE_FOLDER_LIMIT } = {}) {
  const selectedKey = selectedCwd ? workspacePathKey(selectedCwd) : "";
  const folders = new Map();
  const addFolder = (item, source) => {
    const { cwd, display } = folderSource(item);
    const key = workspacePathKey(cwd);
    if (!key) return;
    const existing = folders.get(key);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    if (folders.size >= limit) return;
    folders.set(key, { key, cwd, path: display.replace(/\\/g, "/"), sources: new Set([source]) });
  };
  addFolder(currentCwd, "current");
  for (const item of Array.isArray(pinned) ? pinned : []) addFolder(item, "pinned");
  for (const item of Array.isArray(recent) ? recent : []) addFolder(item, "recent");
  const ordered = [...folders.values()];
  if (selectedKey && !folders.has(selectedKey)) {
    const { cwd, display } = folderSource(selectedCwd);
    const selected = { key: selectedKey, cwd, path: display.replace(/\\/g, "/"), sources: new Set(["selected"]) };
    ordered.splice(ordered[0]?.sources.has("current") ? 1 : 0, 0, selected);
  }

  const folderChoices = ordered.map(folder => ({
    id: `folder:${folder.key}`,
    kind: "folder",
    cwd: folder.cwd,
    label: workspaceFolderName(folder.path),
    path: folder.path,
    tag: folder.sources.has("current") ? "Current" : folder.sources.has("pinned") ? "Pinned" : folder.sources.has("recent") ? "Recent" : "Folder",
    selected: !!selectedKey && folder.key === selectedKey,
  }));
  const currentChoices = folderChoices[0]?.tag === "Current" ? folderChoices.splice(0, 1) : [];
  return [
    ...currentChoices,
    { id: "no-project", kind: "no-project", label: "No project", path: "Own folder for files and tools", tag: "Isolated", selected: selectedCwd === "" },
    ...folderChoices,
    { id: "browse", kind: "browse", label: "Browse…", path: "Choose any folder", tag: "Action", selected: false },
    ...(includeWorktree ? [{ id: "worktree", kind: "worktree", label: "Branch worktree…", path: "Isolated Git checkout on a branch", tag: "Git", selected: false }] : []),
  ];
}

/**
 * Filters choices by a case-insensitive substring of a folder's name or path,
 * or of "No project". The "Browse…" and "Branch worktree…" actions always
 * remain so a search without folder matches can still reach any folder.
 */
export function filterWorkspaceChoices(choices, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(choice => choice.kind === "browse" || choice.kind === "worktree"
    || choice.label.toLowerCase().includes(needle)
    || (choice.kind === "folder" && choice.path.toLowerCase().includes(needle)));
}
