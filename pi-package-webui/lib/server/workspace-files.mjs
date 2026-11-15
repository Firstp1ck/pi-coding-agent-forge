import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { pathInside } from "../git-worktrees.mjs";

const FILE_VIEWER_MAX_BYTES = 2 * 1024 * 1024;
export const FILE_VIEWER_BODY_LIMIT_BYTES = FILE_VIEWER_MAX_BYTES + 64 * 1024;
const FILE_VIEWER_IMAGE_MIME_TYPES_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
});
const FILE_TREE_MAX_ENTRIES = 1200;
const FILE_TREE_ENTRY_STAT_CONCURRENCY = 32;
const FILE_SEARCH_MAX_RESULTS = 200;
const FILE_SEARCH_MAX_SCANNED = 12_000;
const FILE_SEARCH_MAX_DEPTH = 8;
const FILE_SEARCH_EXCLUDED_DIRS = new Set([".git", "node_modules"]);

export function createWorkspaceFilesService({
  defaultCwd,
  makeHttpError,
  displayPath,
  formatBytes,
  sanitizeError,
  runCommand,
  isLikelyBinaryBuffer,
  getGitRoot,
  readWorkspaceGitStatusIndex,
  readWorkspaceGitIgnoredPaths,
  withFileTreeGitStatus,
  withFileTreeGitIgnored,
  fileTreeGitStatusPayload,
}) {
  async function workspaceRoot(tab) {
    const root = path.resolve(tab?.cwd || defaultCwd);
    return { root, realRoot: await realpath(root).catch(() => root) };
  }

  async function resolveWorkspacePath(tab, value = "", { mustExist = true } = {}) {
    const { root, realRoot } = await workspaceRoot(tab);
    const text = String(value || "").trim();
    if (text.includes("\0")) throw makeHttpError(400, "Path cannot contain null bytes");
    const targetPath = text ? (path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text)) : root;
    if (targetPath !== root && !pathInside(root, targetPath)) throw makeHttpError(403, "Path must stay inside the active tab working directory");
    let info = null;
    let realTarget = targetPath;
    try {
      info = await stat(targetPath);
      realTarget = await realpath(targetPath).catch(() => targetPath);
    } catch (error) {
      if (mustExist) throw makeHttpError(error?.code === "ENOENT" ? 404 : 400, `Path not found: ${displayPath(targetPath)}`);
    }
    if (realTarget !== realRoot && !pathInside(realRoot, realTarget)) throw makeHttpError(403, "Resolved path escapes the active tab working directory");
    const relative = path.relative(root, targetPath).split(path.sep).join("/");
    return { root, realRoot, targetPath, realTarget, relative, info };
  }

  function fileViewerLanguage(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (ext === ".md" || ext === ".markdown") return "markdown";
    return "text";
  }

  function fileViewerImageMimeType(filePath) {
    return FILE_VIEWER_IMAGE_MIME_TYPES_BY_EXTENSION[path.extname(String(filePath || "")).toLowerCase()] || "";
  }

  function fileTreeEntryType(dirent, info) {
    if (info?.isDirectory?.() || dirent?.isDirectory?.()) return "directory";
    if (info?.isFile?.() || dirent?.isFile?.()) return "file";
    return dirent?.isSymbolicLink?.() ? "symlink" : "other";
  }

  async function statFileTreeEntries(dirPath, dirents, root, realRoot) {
    const ordered = [...dirents].sort((a, b) => {
      const aRank = a.isDirectory() ? 0 : a.isFile() ? 1 : 2;
      const bRank = b.isDirectory() ? 0 : b.isFile() ? 1 : 2;
      return aRank - bRank || a.name.localeCompare(b.name);
    });
    const selected = ordered.slice(0, FILE_TREE_MAX_ENTRIES);
    const entries = [];
    let cursor = 0;
    async function worker() {
      while (cursor < selected.length) {
        const dirent = selected[cursor++];
        const targetPath = path.join(dirPath, dirent.name);
        const relative = path.relative(root, targetPath).split(path.sep).join("/");
        try {
          const [info, realTarget] = await Promise.all([stat(targetPath), realpath(targetPath).catch(() => targetPath)]);
          const outsideRoot = realTarget !== realRoot && !pathInside(realRoot, realTarget);
          const type = outsideRoot ? "other" : fileTreeEntryType(dirent, info);
          entries.push({
            name: dirent.name,
            path: relative,
            type,
            directory: type === "directory",
            file: type === "file",
            symlink: dirent.isSymbolicLink(),
            outsideRoot,
            size: info.size,
            mtimeMs: info.mtimeMs,
            extension: path.extname(dirent.name).toLowerCase(),
            canOpenInWebui: type === "file",
          });
        } catch (error) {
          entries.push({ name: dirent.name, path: relative, type: "error", directory: false, file: false, error: sanitizeError(error), canOpenInWebui: false });
        }
      }
    }
    const workers = Array.from({ length: Math.min(FILE_TREE_ENTRY_STAT_CONCURRENCY, selected.length) }, () => worker());
    await Promise.all(workers);
    entries.sort((a, b) => {
      const aRank = a.type === "directory" ? 0 : a.type === "file" ? 1 : 2;
      const bRank = b.type === "directory" ? 0 : b.type === "file" ? 1 : 2;
      return aRank - bRank || a.name.localeCompare(b.name);
    });
    return { entries, truncated: ordered.length > selected.length, total: ordered.length };
  }

  async function getFileTreeData(tab, requestedPath = "") {
    const resolved = await resolveWorkspacePath(tab, requestedPath);
    if (!resolved.info?.isDirectory()) throw makeHttpError(400, "Path is not a directory");
    const dirents = await readdir(resolved.targetPath, { withFileTypes: true });
    const [listed, gitStatus] = await Promise.all([
      statFileTreeEntries(resolved.targetPath, dirents, resolved.root, resolved.realRoot),
      readWorkspaceGitStatusIndex(resolved.root),
    ]);
    const gitIgnored = await readWorkspaceGitIgnoredPaths(resolved.root, listed.entries, gitStatus?.root);
    return {
      root: resolved.root,
      displayRoot: displayPath(resolved.root),
      path: resolved.relative,
      displayPath: displayPath(resolved.targetPath),
      entries: withFileTreeGitIgnored(withFileTreeGitStatus(listed.entries, resolved.root, gitStatus), resolved.root, gitIgnored),
      gitStatus: fileTreeGitStatusPayload(resolved.root, gitStatus),
      truncated: listed.truncated,
      total: listed.total,
    };
  }

  function normalizeFileSearchQuery(value = "") {
    const query = String(value || "").trim().replace(/\s+/g, " ");
    if (query.includes("\0")) throw makeHttpError(400, "Search query cannot contain null bytes");
    if (query.length > 160) throw makeHttpError(400, "Search query is too long");
    return query;
  }

  function fileSearchMatches(entry, queryLower) {
    const name = String(entry.name || "").toLowerCase();
    const filePath = String(entry.path || "").toLowerCase();
    return name.includes(queryLower) || filePath.includes(queryLower);
  }

  async function getFileSearchData(tab, rawQuery = "") {
    const query = normalizeFileSearchQuery(rawQuery);
    if (!query) {
      const root = path.resolve(tab?.cwd || defaultCwd);
      return { root, displayRoot: displayPath(root), query, entries: [], truncated: false, total: 0, scanned: 0, maxDepth: FILE_SEARCH_MAX_DEPTH };
    }
    const resolved = await resolveWorkspacePath(tab, "");
    if (!resolved.info?.isDirectory()) throw makeHttpError(400, "Workspace root is not a directory");
    const gitStatus = await readWorkspaceGitStatusIndex(resolved.root);
    const queryLower = query.toLowerCase();
    const entries = [];
    const queue = [{ dirPath: resolved.root, relative: "", depth: 0 }];
    const visitedRealDirs = new Set([resolved.realRoot]);
    let scanned = 0;
    let truncated = false;

    while (queue.length && scanned < FILE_SEARCH_MAX_SCANNED && entries.length < FILE_SEARCH_MAX_RESULTS) {
      const current = queue.shift();
      let dirents = [];
      try {
        dirents = await readdir(current.dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => {
        const aRank = a.isDirectory() ? 0 : a.isFile() ? 1 : 2;
        const bRank = b.isDirectory() ? 0 : b.isFile() ? 1 : 2;
        return aRank - bRank || a.name.localeCompare(b.name);
      });

      for (const dirent of dirents) {
        if (scanned >= FILE_SEARCH_MAX_SCANNED || entries.length >= FILE_SEARCH_MAX_RESULTS) break;
        scanned += 1;
        const targetPath = path.join(current.dirPath, dirent.name);
        const relative = (current.relative ? `${current.relative}/${dirent.name}` : dirent.name).split(path.sep).join("/");
        const depth = current.depth + 1;
        try {
          const [info, realTarget] = await Promise.all([stat(targetPath), realpath(targetPath).catch(() => targetPath)]);
          const outsideRoot = realTarget !== resolved.realRoot && !pathInside(resolved.realRoot, realTarget);
          const type = outsideRoot ? "other" : fileTreeEntryType(dirent, info);
          const entry = {
            name: dirent.name,
            path: relative,
            type,
            directory: type === "directory",
            file: type === "file",
            symlink: dirent.isSymbolicLink(),
            outsideRoot,
            size: info.size,
            mtimeMs: info.mtimeMs,
            extension: path.extname(dirent.name).toLowerCase(),
            depth,
            canOpenInWebui: type === "file",
          };
          if (fileSearchMatches(entry, queryLower)) entries.push(entry);
          if (depth < FILE_SEARCH_MAX_DEPTH && type === "directory" && !FILE_SEARCH_EXCLUDED_DIRS.has(dirent.name) && !visitedRealDirs.has(realTarget)) {
            visitedRealDirs.add(realTarget);
            queue.push({ dirPath: targetPath, relative, depth });
          }
        } catch (error) {
          const entry = { name: dirent.name, path: relative, type: "error", directory: false, file: false, depth, error: sanitizeError(error), canOpenInWebui: false };
          if (fileSearchMatches(entry, queryLower)) entries.push(entry);
        }
      }
    }
    truncated = queue.length > 0 || scanned >= FILE_SEARCH_MAX_SCANNED || entries.length >= FILE_SEARCH_MAX_RESULTS;
    const gitIgnored = await readWorkspaceGitIgnoredPaths(resolved.root, entries, gitStatus?.root);
    return {
      root: resolved.root,
      displayRoot: displayPath(resolved.root),
      query,
      entries: withFileTreeGitIgnored(withFileTreeGitStatus(entries, resolved.root, gitStatus), resolved.root, gitIgnored),
      gitStatus: fileTreeGitStatusPayload(resolved.root, gitStatus),
      truncated,
      total: entries.length,
      scanned,
      maxDepth: FILE_SEARCH_MAX_DEPTH,
      excludedDirs: [...FILE_SEARCH_EXCLUDED_DIRS],
    };
  }

  function assertTextFileBuffer(buffer) {
    if (isLikelyBinaryBuffer(buffer)) throw makeHttpError(415, "File appears to be binary; only text files and supported raster images can be opened in WebUI");
  }

  async function getFileContentData(tab, requestedPath = "") {
    const resolved = await resolveWorkspacePath(tab, requestedPath);
    if (!resolved.info?.isFile()) throw makeHttpError(400, "Path is not a regular file");
    if (resolved.info.size > FILE_VIEWER_MAX_BYTES) throw makeHttpError(413, `File is too large to open in WebUI (limit ${formatBytes(FILE_VIEWER_MAX_BYTES)})`);
    const buffer = await readFile(resolved.targetPath);
    const extension = path.extname(resolved.targetPath).toLowerCase();
    const imageMimeType = fileViewerImageMimeType(resolved.targetPath);
    const shared = {
      root: resolved.root,
      path: resolved.relative,
      name: path.basename(resolved.targetPath),
      size: resolved.info.size,
      mtimeMs: resolved.info.mtimeMs,
      extension,
    };
    if (imageMimeType) {
      return { ...shared, kind: "image", mimeType: imageMimeType, data: buffer.toString("base64") };
    }
    assertTextFileBuffer(buffer);
    return { ...shared, kind: "text", content: buffer.toString("utf8"), language: fileViewerLanguage(resolved.targetPath) };
  }

  function aurReviewReportPathSegments(value = "") {
    const requested = String(value || "").trim();
    if (!requested || requested.length > 1024 || requested.includes("\0")) throw makeHttpError(400, "Report path must be a non-empty repo-root-relative path");
    if (path.isAbsolute(requested) || path.win32.isAbsolute(requested) || requested.includes("\\")) {
      throw makeHttpError(400, "Report path must be a repo-root-relative path");
    }
    const segments = requested.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw makeHttpError(400, "Report path cannot contain traversal segments");
    }
    return segments;
  }

  async function canonicalGitRootForTab(tab) {
    const root = await getGitRoot(tab.cwd);
    try {
      return await realpath(root);
    } catch {
      throw makeHttpError(404, "Git repository root is no longer accessible");
    }
  }

  async function readBoundedAurReviewReport(targetPath) {
    const handle = await open(targetPath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw makeHttpError(400, "Report path is not a regular file");
      if (info.size > FILE_VIEWER_MAX_BYTES) throw makeHttpError(413, `Report is too large to open in WebUI (limit ${formatBytes(FILE_VIEWER_MAX_BYTES)})`);
      const chunks = [];
      let total = 0;
      while (true) {
        const remaining = FILE_VIEWER_MAX_BYTES + 1 - total;
        if (remaining <= 0) throw makeHttpError(413, `Report is too large to open in WebUI (limit ${formatBytes(FILE_VIEWER_MAX_BYTES)})`);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      return { buffer: Buffer.concat(chunks, total), info };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** Read-only AUR-review report access rooted at the tab's canonical Git root. */
  async function getAurReviewReportContentData(tab, { path: requestedPath = "", repoRoot = "" } = {}) {
    if (typeof repoRoot !== "string" || !repoRoot || repoRoot.includes("\0")) {
      throw makeHttpError(400, "repoRoot is required for an AUR review report");
    }
    const root = await canonicalGitRootForTab(tab);
    if (repoRoot !== root) throw makeHttpError(403, "Report repoRoot does not match this tab's canonical Git root");
    const segments = aurReviewReportPathSegments(requestedPath);
    let targetPath = root;
    let info;
    for (const [index, segment] of segments.entries()) {
      targetPath = path.join(targetPath, segment);
      try {
        info = await lstat(targetPath);
      } catch (error) {
        throw makeHttpError(error?.code === "ENOENT" ? 404 : 400, `Report path not found: ${segments.join("/")}`);
      }
      if (info.isSymbolicLink()) throw makeHttpError(403, "Report path cannot contain symlinks");
      if (index < segments.length - 1 && !info.isDirectory()) throw makeHttpError(400, "Report path contains a non-directory component");
    }
    if (!info?.isFile()) throw makeHttpError(400, "Report path is not a regular file");
    const realTarget = await realpath(targetPath).catch(() => "");
    if (!realTarget || !pathInside(root, realTarget)) throw makeHttpError(403, "Resolved report path escapes the canonical Git root");
    const opened = await readBoundedAurReviewReport(targetPath);
    assertTextFileBuffer(opened.buffer);
    return {
      root,
      path: segments.join("/"),
      name: path.basename(targetPath),
      content: opened.buffer.toString("utf8"),
      size: opened.buffer.length,
      mtimeMs: opened.info.mtimeMs,
      extension: path.extname(targetPath).toLowerCase(),
      language: fileViewerLanguage(targetPath),
    };
  }

  async function saveFileContentData(tab, body = {}) {
    if (typeof body.content !== "string") throw makeHttpError(400, "File content must be a string");
    if (body.content.includes("\0")) throw makeHttpError(400, "File content cannot contain null bytes");
    if (Buffer.byteLength(body.content, "utf8") > FILE_VIEWER_MAX_BYTES) throw makeHttpError(413, `File is too large to save in WebUI (limit ${formatBytes(FILE_VIEWER_MAX_BYTES)})`);
    const resolved = await resolveWorkspacePath(tab, body.path || body.filePath || "");
    if (!resolved.info?.isFile()) throw makeHttpError(400, "Path is not a regular file");
    if (resolved.info.size > FILE_VIEWER_MAX_BYTES) throw makeHttpError(413, `File is too large to save in WebUI (limit ${formatBytes(FILE_VIEWER_MAX_BYTES)})`);
    assertTextFileBuffer(await readFile(resolved.targetPath));
    const expectedMtimeMs = Number(body.mtimeMs);
    if (Number.isFinite(expectedMtimeMs) && Math.abs(resolved.info.mtimeMs - expectedMtimeMs) > 5) {
      throw makeHttpError(409, "File changed on disk after it was opened. Reopen it before saving.");
    }
    const tmpFile = `${resolved.targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpFile, body.content, { encoding: "utf8", mode: resolved.info.mode & 0o777 });
      await rename(tmpFile, resolved.targetPath);
    } catch (error) {
      await rm(tmpFile, { force: true }).catch(() => {});
      throw error;
    }
    const nextStats = await stat(resolved.targetPath);
    return {
      path: resolved.relative,
      name: path.basename(resolved.targetPath),
      size: nextStats.size,
      mtimeMs: nextStats.mtimeMs,
      extension: path.extname(resolved.targetPath).toLowerCase(),
      language: fileViewerLanguage(resolved.targetPath),
    };
  }

  function workspaceRelativePath(root, targetPath) {
    return path.relative(root, targetPath).split(path.sep).join("/");
  }

  function fileOperationEntryType(info) {
    if (info?.isDirectory?.()) return "directory";
    if (info?.isFile?.()) return "file";
    return "other";
  }

  function assertWorkspaceEntryMutable(resolved, action) {
    if (!resolved.relative) throw makeHttpError(400, `Workspace root cannot be ${action}`);
    const type = fileOperationEntryType(resolved.info);
    if (type !== "file" && type !== "directory") throw makeHttpError(400, "Only regular files and directories can be modified from WebUI");
    return type;
  }

  async function existingDestinationStats(targetPath) {
    try {
      return await stat(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw makeHttpError(400, `Cannot access destination: ${displayPath(targetPath)}`);
    }
  }

  async function resolveWorkspaceMoveDestination(tab, source, rawDestination = "") {
    const destinationText = String(rawDestination || "").trim();
    if (!destinationText) throw makeHttpError(400, "Destination path is required");
    if (destinationText.includes("\0")) throw makeHttpError(400, "Destination path cannot contain null bytes");

    const candidatePath = path.isAbsolute(destinationText) ? path.resolve(destinationText) : path.resolve(source.root, destinationText);
    if (candidatePath !== source.root && !pathInside(source.root, candidatePath)) throw makeHttpError(403, "Destination path must stay inside the active tab working directory");

    const candidateInfo = await existingDestinationStats(candidatePath);
    let targetPath = candidatePath;
    let targetInfo = candidateInfo;
    if (candidateInfo?.isDirectory?.()) {
      targetPath = path.join(candidatePath, path.basename(source.targetPath));
      targetInfo = await existingDestinationStats(targetPath);
    }

    if (path.resolve(targetPath) === path.resolve(source.targetPath)) throw makeHttpError(400, "Source and destination are the same path");
    if (targetInfo) throw makeHttpError(409, `Destination already exists: ${workspaceRelativePath(source.root, targetPath)}`);
    if (source.info?.isDirectory?.() && pathInside(source.targetPath, targetPath)) throw makeHttpError(400, "A directory cannot be moved into itself or one of its descendants");

    const parentPath = path.dirname(targetPath);
    if (parentPath !== source.root && !pathInside(source.root, parentPath)) throw makeHttpError(403, "Destination parent must stay inside the active tab working directory");
    const parentInfo = await stat(parentPath).catch((error) => {
      if (error?.code === "ENOENT") throw makeHttpError(404, `Destination parent not found: ${displayPath(parentPath)}`);
      throw makeHttpError(400, `Cannot access destination parent: ${displayPath(parentPath)}`);
    });
    if (!parentInfo?.isDirectory?.()) throw makeHttpError(400, "Destination parent is not a directory");
    const realParent = await realpath(parentPath).catch(() => parentPath);
    if (realParent !== source.realRoot && !pathInside(source.realRoot, realParent)) throw makeHttpError(403, "Destination parent escapes the active tab working directory");

    return {
      targetPath,
      relative: workspaceRelativePath(source.root, targetPath),
      parentPath: workspaceRelativePath(source.root, parentPath),
    };
  }

  async function deleteFileSystemEntryData(tab, body = {}) {
    if (body.confirmed !== true) throw makeHttpError(409, "Deleting files or directories requires confirmed: true");
    const resolved = await resolveWorkspacePath(tab, body.path || body.filePath || "");
    const type = assertWorkspaceEntryMutable(resolved, "deleted");
    await rm(resolved.targetPath, { recursive: type === "directory" });
    return {
      path: resolved.relative,
      name: path.basename(resolved.targetPath),
      type,
      parentPath: workspaceRelativePath(resolved.root, path.dirname(resolved.targetPath)),
      deleted: true,
    };
  }

  // Create an empty file or a directory inside the tab's working directory (Files panel
  // "New file…" / "New folder…"). Never overwrites; parents must already exist.
  async function createFileSystemEntryData(tab, body = {}) {
    const kind = body.type === "directory" ? "directory" : "file";
    const resolved = await resolveWorkspacePath(tab, body.path || body.filePath || "", { mustExist: false });
    if (resolved.targetPath === resolved.root) throw makeHttpError(400, "A name is required");
    if (resolved.info) throw makeHttpError(409, `Already exists: ${resolved.relative}`);
    const parentPath = path.dirname(resolved.targetPath);
    const parentInfo = await stat(parentPath).catch(() => null);
    if (!parentInfo?.isDirectory?.()) throw makeHttpError(404, `Parent folder not found: ${workspaceRelativePath(resolved.root, parentPath) || "."}`);
    const realParent = await realpath(parentPath).catch(() => parentPath);
    if (realParent !== resolved.realRoot && !pathInside(resolved.realRoot, realParent)) throw makeHttpError(403, "Parent folder escapes the active tab working directory");
    if (kind === "directory") await mkdir(resolved.targetPath);
    else await writeFile(resolved.targetPath, "", { encoding: "utf8", flag: "wx" });
    const nextStats = await stat(resolved.targetPath);
    return {
      path: resolved.relative,
      name: path.basename(resolved.targetPath),
      type: kind,
      parentPath: workspaceRelativePath(resolved.root, parentPath),
      created: true,
      size: nextStats.size,
      mtimeMs: nextStats.mtimeMs,
    };
  }

  async function moveFileSystemEntryData(tab, body = {}) {
    if (body.confirmed !== true) throw makeHttpError(409, "Moving files or directories requires confirmed: true");
    const source = await resolveWorkspacePath(tab, body.path || body.filePath || body.sourcePath || "");
    const type = assertWorkspaceEntryMutable(source, "moved");
    const destination = await resolveWorkspaceMoveDestination(tab, source, body.toPath || body.destinationPath || body.destination || "");
    await rename(source.targetPath, destination.targetPath);
    const nextStats = await stat(destination.targetPath).catch(() => null);
    return {
      path: source.relative,
      destination: destination.relative,
      name: path.basename(destination.targetPath),
      type,
      parentPath: workspaceRelativePath(source.root, path.dirname(source.targetPath)),
      destinationParentPath: destination.parentPath,
      moved: true,
      size: nextStats?.size,
      mtimeMs: nextStats?.mtimeMs,
    };
  }

  function defaultEditorCommand(targetPath) {
    if (process.env.PI_WEBUI_OPEN_COMMAND) {
      const override = process.env.PI_WEBUI_OPEN_COMMAND;
      return [".js", ".cjs", ".mjs"].includes(path.extname(override).toLowerCase())
        ? { command: process.execPath, args: [override, targetPath] }
        : { command: override, args: [targetPath] };
    }
    if (platform() === "win32") return { command: "cmd", args: ["/c", "start", "", targetPath] };
    if (platform() === "darwin") return { command: "open", args: [targetPath] };
    return { command: "xdg-open", args: [targetPath] };
  }

  function firstCommandOutputLine(value = "") {
    return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  }

  async function queryXdgMime(args = [], cwd = defaultCwd) {
    const result = await runCommand("xdg-mime", args, { cwd, timeoutMs: 1500, maxOutputLength: 4096 });
    if (result.exitCode !== 0) return "";
    return firstCommandOutputLine(result.stdout);
  }

  async function linuxDefaultEditorCommand(targetPath, { cwd = defaultCwd, isFile = true } = {}) {
    if (process.env.PI_WEBUI_OPEN_COMMAND) return defaultEditorCommand(targetPath);
    if (!isFile) return defaultEditorCommand(targetPath);
    const fileMime = await queryXdgMime(["query", "filetype", targetPath], cwd);
    const fileDefaultDesktop = fileMime ? await queryXdgMime(["query", "default", fileMime], cwd) : "";
    if (fileDefaultDesktop) return { command: "xdg-open", args: [targetPath], mime: fileMime, desktopFile: fileDefaultDesktop, fallbackToTextEditor: false };
    const textDefaultDesktop = await queryXdgMime(["query", "default", "text/plain"], cwd);
    if (textDefaultDesktop) {
      return { command: "gio", args: ["launch", textDefaultDesktop, targetPath], mime: fileMime, desktopFile: textDefaultDesktop, fallbackToTextEditor: true };
    }
    return { ...defaultEditorCommand(targetPath), mime: fileMime, fallbackToTextEditor: false };
  }

  async function defaultEditorCommandForPath(targetPath, options = {}) {
    if (platform() === "linux") return linuxDefaultEditorCommand(targetPath, options);
    return defaultEditorCommand(targetPath);
  }

  async function openPathInDefaultEditor(tab, requestedPath = "") {
    if (!String(requestedPath || "").trim()) throw makeHttpError(400, "Path to open is required");
    const resolved = await resolveWorkspacePath(tab, requestedPath);
    const { command, args, mime, desktopFile, fallbackToTextEditor } = await defaultEditorCommandForPath(resolved.targetPath, { cwd: resolved.root, isFile: !!resolved.info?.isFile?.() });
    const child = spawn(command, args, { cwd: resolved.root, stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref?.();
    return { path: resolved.relative, command: [command, ...args].join(" "), mime, desktopFile, fallbackToTextEditor: !!fallbackToTextEditor };
  }

  return {
    getFileTreeData,
    getFileSearchData,
    getFileContentData,
    getAurReviewReportContentData,
    saveFileContentData,
    deleteFileSystemEntryData,
    createFileSystemEntryData,
    moveFileSystemEntryData,
    openPathInDefaultEditor,
  };
}
