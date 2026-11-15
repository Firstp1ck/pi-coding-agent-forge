import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceFilesService, FILE_VIEWER_BODY_LIMIT_BYTES } from "../lib/server/workspace-files.mjs";

const MAX_BYTES = 2 * 1024 * 1024;

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-webui-w6-files-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  const service = (overrides = {}) => createWorkspaceFilesService({
    defaultCwd: root,
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    displayPath: (value) => `display:${value}`,
    formatBytes: (value) => `${value} bytes`,
    sanitizeError: (error) => `sanitized:${error.code || error.message}`,
    runCommand: async () => { throw new Error("Unexpected command execution"); },
    isLikelyBinaryBuffer: (buffer) => Buffer.isBuffer(buffer) && buffer.includes(0),
    getGitRoot: async () => root,
    readWorkspaceGitStatusIndex: async () => null,
    readWorkspaceGitIgnoredPaths: async () => null,
    withFileTreeGitStatus: (entries) => entries,
    withFileTreeGitIgnored: (entries) => entries,
    fileTreeGitStatusPayload: () => null,
    ...overrides,
  });
  return { base, root, outside, tab: { cwd: root }, service };
}

async function expectError(promise, statusCode, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message, message);
    return true;
  });
}

async function link(t, target, destination, type = "file") {
  try {
    await symlink(target, destination, type === "dir" && process.platform === "win32" ? "junction" : type);
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    t.diagnostic(`Symlink checks skipped: ${error.code}`);
    return false;
  }
}

test("factory exports only the existing service operations and HTTP body limit", async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual(Object.keys(service()), [
    "getFileTreeData", "getFileSearchData", "getFileContentData", "getAurReviewReportContentData",
    "saveFileContentData", "deleteFileSystemEntryData", "createFileSystemEntryData",
    "moveFileSystemEntryData", "openPathInDefaultEditor",
  ]);
  assert.equal(FILE_VIEWER_BODY_LIMIT_BYTES, MAX_BYTES + 64 * 1024);
});

test("tree sorts directories before files, reports metadata, and passes exact Git boundary values", async (t) => {
  const { root, tab, service } = await fixture(t);
  await Promise.all([mkdir(path.join(root, "z-dir")), writeFile(path.join(root, "b.txt"), "b"), writeFile(path.join(root, "a.md"), "# A")]);
  const gitStatus = { root, entries: new Map() };
  const gitIgnored = { root, paths: new Set(["b.txt"]) };
  const payload = { root, entries: [{ path: "a.md", changed: true }] };
  const calls = [];
  let listedEntries;
  let decoratedEntries;
  const files = service({
    readWorkspaceGitStatusIndex: async (cwd) => { assert.equal(cwd, root); calls.push("status"); return gitStatus; },
    readWorkspaceGitIgnoredPaths: async (cwd, entries, gitRoot) => {
      assert.equal(cwd, root); assert.equal(gitRoot, root); listedEntries = entries; calls.push("ignored"); return gitIgnored;
    },
    withFileTreeGitStatus: (entries, cwd, status) => {
      assert.equal(entries, listedEntries); assert.equal(cwd, root); assert.equal(status, gitStatus);
      calls.push("decorate-status"); decoratedEntries = entries.map((entry) => ({ ...entry, gitStatus: { changed: true } })); return decoratedEntries;
    },
    withFileTreeGitIgnored: (entries, cwd, ignored) => {
      assert.equal(entries, decoratedEntries); assert.equal(cwd, root); assert.equal(ignored, gitIgnored);
      calls.push("decorate-ignored"); return entries.map((entry) => entry.path === "b.txt" ? { ...entry, gitIgnored: true } : entry);
    },
    fileTreeGitStatusPayload: (cwd, status) => { assert.equal(cwd, root); assert.equal(status, gitStatus); calls.push("payload"); return payload; },
  });
  const result = await files.getFileTreeData(tab);
  assert.deepEqual(Object.keys(result), ["root", "displayRoot", "path", "displayPath", "entries", "gitStatus", "truncated", "total"]);
  assert.equal(result.root, root);
  assert.equal(result.displayRoot, `display:${root}`);
  assert.equal(result.displayPath, `display:${root}`);
  assert.equal(result.path, "");
  assert.deepEqual(result.entries.map(({ name, type }) => [name, type]), [["z-dir", "directory"], ["a.md", "file"], ["b.txt", "file"]]);
  assert.deepEqual(result.entries[1], {
    name: "a.md", path: "a.md", type: "file", directory: false, file: true, symlink: false, outsideRoot: false,
    size: 3, mtimeMs: (await stat(path.join(root, "a.md"))).mtimeMs, extension: ".md", canOpenInWebui: true, gitStatus: { changed: true },
  });
  assert.equal(result.entries[2].gitIgnored, true);
  assert.equal(result.gitStatus, payload);
  assert.equal(result.truncated, false);
  assert.equal(result.total, 3);
  assert.deepEqual(calls, ["status", "ignored", "decorate-status", "decorate-ignored", "payload"]);
  await expectError(files.getFileTreeData(tab, "a.md"), 400, "Path is not a directory");
  assert.equal((await files.getFileTreeData(undefined, "z-dir")).path, "z-dir");
});

test("tree caps listings at 1200 while reporting the uncapped total", async (t) => {
  const { root, tab, service } = await fixture(t);
  for (let start = 0; start < 1201; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 1201 - start) }, (_, index) => writeFile(path.join(root, `file-${String(start + index).padStart(4, "0")}`), "")));
  }
  const result = await service().getFileTreeData(tab);
  assert.equal(result.entries.length, 1200);
  assert.equal(result.total, 1201);
  assert.equal(result.truncated, true);
  assert.equal(result.entries[0].path, "file-0000");
  assert.equal(result.entries.at(-1).path, "file-1199");
});

test("workspace resolution enforces lexical and canonical containment while listing outside and broken links", async (t) => {
  const { base, root, outside, tab, service } = await fixture(t);
  const files = service();
  await writeFile(path.join(root, "inside.txt"), "inside");
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await expectError(files.getFileContentData(tab, "inside\0.txt"), 400, "Path cannot contain null bytes");
  for (const requested of ["../outside/secret.txt", path.join(outside, "secret.txt")]) {
    await expectError(files.getFileContentData(tab, requested), 403, "Path must stay inside the active tab working directory");
  }
  await expectError(files.getFileContentData(tab, "missing"), 404, `Path not found: display:${path.join(root, "missing")}`);
  if (!await link(t, path.join(root, "inside.txt"), path.join(root, "inside-link"))) return;
  await symlink(path.join(outside, "secret.txt"), path.join(root, "outside-link"));
  await symlink(path.join(root, "missing"), path.join(root, "broken-link"));
  await symlink(outside, path.join(root, "outside-dir"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await files.getFileContentData(tab, " inside-link ")).content, "inside");
  await expectError(files.getFileContentData(tab, "outside-link"), 403, "Resolved path escapes the active tab working directory");
  await expectError(files.getFileTreeData(tab, "outside-dir"), 403, "Resolved path escapes the active tab working directory");
  const entries = (await files.getFileTreeData(tab)).entries;
  for (const name of ["outside-link", "outside-dir"]) {
    const entry = entries.find((item) => item.name === name);
    assert.equal(entry.type, "other"); assert.equal(entry.outsideRoot, true); assert.equal(entry.symlink, true); assert.equal(entry.canOpenInWebui, false);
  }
  const broken = entries.find((entry) => entry.name === "broken-link");
  assert.equal(broken.type, "error"); assert.equal(broken.error, "sanitized:ENOENT"); assert.equal(broken.canOpenInWebui, false);
  const alias = path.join(base, "workspace-alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const aliased = await files.getFileContentData({ cwd: alias }, path.join(alias, "inside.txt"));
  assert.equal(aliased.root, alias); assert.equal(aliased.path, "inside.txt"); assert.equal(aliased.content, "inside");
});

test("search normalizes queries, skips empty scans, and preserves Git decoration order", async (t) => {
  const { root, tab, service } = await fixture(t);
  await mkdir(path.join(root, "Some Folder"));
  await writeFile(path.join(root, "Some Folder", "Needle.MD"), "# match");
  const calls = [];
  const files = service({
    readWorkspaceGitStatusIndex: async (cwd) => { assert.equal(cwd, root); calls.push("status"); return null; },
    readWorkspaceGitIgnoredPaths: async (cwd, entries, gitRoot) => {
      assert.equal(cwd, root); assert.equal(gitRoot, undefined); assert.ok(entries.length); calls.push("ignored"); return null;
    },
    withFileTreeGitStatus: (entries, cwd, status) => { assert.equal(cwd, root); assert.equal(status, null); calls.push("decorate-status"); return entries; },
    withFileTreeGitIgnored: (entries, cwd, ignored) => { assert.equal(cwd, root); assert.equal(ignored, null); calls.push("decorate-ignored"); return entries; },
    fileTreeGitStatusPayload: (cwd, status) => { assert.equal(cwd, root); assert.equal(status, null); calls.push("payload"); return null; },
  });
  assert.deepEqual(await files.getFileSearchData(undefined), {
    root, displayRoot: `display:${root}`, query: "", entries: [], truncated: false, total: 0, scanned: 0, maxDepth: 8,
  });
  assert.deepEqual(calls, []);
  const result = await files.getFileSearchData(tab, "  sOME\n  FOLDER  ");
  assert.equal(result.query, "sOME FOLDER");
  assert.deepEqual(result.entries.map(({ path: entryPath, depth }) => [entryPath, depth]), [["Some Folder", 1], ["Some Folder/Needle.MD", 2]]);
  assert.equal(result.scanned, 2); assert.equal(result.total, 2); assert.equal(result.truncated, false);
  assert.deepEqual(result.excludedDirs, [".git", "node_modules"]);
  assert.deepEqual(calls, ["status", "ignored", "decorate-status", "decorate-ignored", "payload"]);
  await expectError(files.getFileSearchData(tab, "x\0"), 400, "Search query cannot contain null bytes");
  await expectError(files.getFileSearchData(tab, "x".repeat(161)), 400, "Search query is too long");
  const missing = path.join(root, "absent");
  assert.equal((await files.getFileSearchData({ cwd: missing }, " ")).root, missing);
  await writeFile(path.join(root, "not-directory"), "file");
  await expectError(files.getFileSearchData({ cwd: path.join(root, "not-directory") }, "file"), 400, "Workspace root is not a directory");
});

test("search respects depth, excluded folders, result and scan caps", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  const depth7 = path.join(root, ...Array.from({ length: 7 }, (_, index) => `d${index}`));
  await mkdir(path.join(depth7, "depth8-folder"), { recursive: true });
  await writeFile(path.join(depth7, "depth8-file"), "visible");
  await writeFile(path.join(depth7, "depth8-folder", "depth9-file"), "hidden");
  for (const name of [".git", "node_modules"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "depth-hidden"), "hidden");
    assert.equal((await files.getFileSearchData(tab, name)).entries[0].type, "directory");
  }
  const depth = await files.getFileSearchData(tab, "depth");
  assert.deepEqual(depth.entries.map((entry) => entry.name), ["depth8-folder", "depth8-file"]);
  assert.ok(depth.entries.every((entry) => entry.depth === 8));
  assert.equal(depth.maxDepth, 8);
  await mkdir(path.join(root, "cap"));
  for (let start = 0; start < 201; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 201 - start) }, (_, index) => writeFile(path.join(root, "cap", `match-${String(start + index).padStart(3, "0")}`), "")));
  }
  const capped = await files.getFileSearchData(tab, "match-");
  assert.equal(capped.total, 200); assert.equal(capped.entries.length, 200); assert.equal(capped.truncated, true);
  const scanRoot = path.join(root, "scan");
  await mkdir(scanRoot);
  for (let start = 0; start < 12001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 12001 - start) }, (_, index) => writeFile(path.join(scanRoot, `entry-${String(start + index).padStart(5, "0")}`), "")));
  }
  const scanned = await files.getFileSearchData({ cwd: scanRoot }, "never-matches");
  assert.equal(scanned.scanned, 12000); assert.equal(scanned.total, 0); assert.equal(scanned.truncated, true);
});

test("search visits a canonical directory only once and does not traverse outside symlinks", async (t) => {
  const { root, outside, tab, service } = await fixture(t);
  await mkdir(path.join(root, "actual"));
  await writeFile(path.join(root, "actual", "needle.txt"), "inside");
  await writeFile(path.join(outside, "needle-secret"), "outside");
  if (!await link(t, root, path.join(root, "loop"), "dir")) return;
  await symlink(path.join(root, "actual"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await symlink(outside, path.join(root, "needle-outside"), process.platform === "win32" ? "junction" : "dir");
  await symlink(path.join(root, "missing"), path.join(root, "needle-broken"));
  const result = await service().getFileSearchData(tab, "needle");
  assert.deepEqual(result.entries.map((entry) => entry.path), ["needle-broken", "needle-outside", "actual/needle.txt"]);
  assert.equal(result.entries[0].type, "error"); assert.equal(result.entries[0].error, "sanitized:ENOENT");
  assert.equal(result.entries[1].outsideRoot, true); assert.equal(result.entries[1].type, "other");
  assert.equal(result.scanned, 6); assert.equal(result.truncated, false);
});

test("content preserves text/image payloads, language metadata and binary/size refusal", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  const content = "# Héllo\n";
  await writeFile(path.join(root, "notes.MARKDOWN"), content);
  const info = await stat(path.join(root, "notes.MARKDOWN"));
  assert.deepEqual(await files.getFileContentData(tab, "notes.MARKDOWN"), {
    root, path: "notes.MARKDOWN", name: "notes.MARKDOWN", size: Buffer.byteLength(content), mtimeMs: info.mtimeMs,
    extension: ".markdown", kind: "text", content, language: "markdown",
  });
  await writeFile(path.join(root, "empty.txt"), "");
  assert.equal((await files.getFileContentData(undefined, "empty.txt")).content, "");
  const image = Buffer.from([0, 255, 1, 2]);
  for (const [extension, mimeType] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"], ["avif", "image/avif"]]) {
    const name = `image.${extension.toUpperCase()}`;
    await writeFile(path.join(root, name), image);
    const result = await files.getFileContentData(tab, name);
    assert.deepEqual(Object.keys(result), ["root", "path", "name", "size", "mtimeMs", "extension", "kind", "mimeType", "data"]);
    assert.equal(result.kind, "image"); assert.equal(result.mimeType, mimeType); assert.equal(result.data, image.toString("base64"));
  }
  await writeFile(path.join(root, "binary.svg"), image);
  await expectError(files.getFileContentData(tab, "binary.svg"), 415, "File appears to be binary; only text files and supported raster images can be opened in WebUI");
  await writeFile(path.join(root, "exact.txt"), Buffer.alloc(MAX_BYTES, 0x61));
  assert.equal((await files.getFileContentData(tab, "exact.txt")).size, MAX_BYTES);
  await writeFile(path.join(root, "large.png"), Buffer.alloc(MAX_BYTES + 1, 0x61));
  await expectError(files.getFileContentData(tab, "large.png"), 413, `File is too large to open in WebUI (limit ${MAX_BYTES} bytes)`);
  await expectError(files.getFileContentData(tab), 400, "Path is not a regular file");
});

test("save replaces existing text through a sibling rename, preserves mode and enforces 5ms conflicts", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  const target = path.join(root, "note.md");
  await writeFile(target, "old");
  await chmod(target, 0o640);
  await utimes(target, 1_700_000_000, 1_700_000_000);
  const before = await stat(target);
  await expectError(files.saveFileContentData(tab, { path: "note.md", content: "lost", mtimeMs: before.mtimeMs - 6 }), 409, "File changed on disk after it was opened. Reopen it before saving.");
  assert.equal(await readFile(target, "utf8"), "old");
  const result = await files.saveFileContentData(tab, { filePath: "note.md", content: "new λ\n", mtimeMs: before.mtimeMs - 5 });
  const after = await stat(target);
  assert.deepEqual(result, { path: "note.md", name: "note.md", size: Buffer.byteLength("new λ\n"), mtimeMs: after.mtimeMs, extension: ".md", language: "markdown" });
  assert.equal(await readFile(target, "utf8"), "new λ\n");
  if (process.platform !== "win32") {
    assert.equal(after.mode & 0o777, 0o640);
    assert.notEqual(after.ino, before.ino, "saving replaces the inode rather than truncating the original file");
  }
  assert.deepEqual(await readdir(root), ["note.md"]);
  await files.saveFileContentData(tab, { path: "note.md", content: "no mtime required", mtimeMs: "not-numeric" });
  assert.equal(await readFile(target, "utf8"), "no mtime required");
  await expectError(files.saveFileContentData(tab), 400, "File content must be a string");
  await expectError(files.saveFileContentData(tab, { path: "note.md", content: "bad\0" }), 400, "File content cannot contain null bytes");
  await expectError(files.saveFileContentData(tab, { path: "note.md", content: "λ".repeat(MAX_BYTES / 2 + 1) }), 413, `File is too large to save in WebUI (limit ${MAX_BYTES} bytes)`);
  await expectError(files.saveFileContentData(tab, { path: "missing", content: "new" }), 404, `Path not found: display:${path.join(root, "missing")}`);
  await expectError(files.saveFileContentData(tab, { content: "new" }), 400, "Path is not a regular file");
  await writeFile(path.join(root, "binary.png"), Buffer.from([1, 0, 2]));
  await expectError(files.saveFileContentData(tab, { path: "binary.png", content: "replacement" }), 415, "File appears to be binary; only text files and supported raster images can be opened in WebUI");
  await writeFile(path.join(root, "large"), Buffer.alloc(MAX_BYTES + 1, 0x61));
  await expectError(files.saveFileContentData(tab, { path: "large", content: "replacement" }), 413, `File is too large to save in WebUI (limit ${MAX_BYTES} bytes)`);
});

test("create is exclusive, requires existing contained parents, and returns existing payloads", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  const folder = await files.createFileSystemEntryData(tab, { path: "folder", type: "directory" });
  assert.equal(folder.type, "directory"); assert.equal(folder.created, true); assert.equal(folder.parentPath, "");
  assert.deepEqual(Object.keys(folder), ["path", "name", "type", "parentPath", "created", "size", "mtimeMs"]);
  const created = await files.createFileSystemEntryData(tab, { filePath: "folder/new.txt", type: "unknown" });
  const info = await stat(path.join(root, "folder", "new.txt"));
  assert.deepEqual(created, { path: "folder/new.txt", name: "new.txt", type: "file", parentPath: "folder", created: true, size: 0, mtimeMs: info.mtimeMs });
  await expectError(files.createFileSystemEntryData(tab, { path: "folder/new.txt" }), 409, "Already exists: folder/new.txt");
  await expectError(files.createFileSystemEntryData(tab), 400, "A name is required");
  await expectError(files.createFileSystemEntryData(tab, { path: "missing/new" }), 404, "Parent folder not found: missing");
  await expectError(files.createFileSystemEntryData(tab, { path: "folder/new.txt/child" }), 404, "Parent folder not found: folder/new.txt");
  await expectError(files.createFileSystemEntryData(tab, { path: "../escape" }), 403, "Path must stay inside the active tab working directory");
  if (await link(t, path.join(root, "missing-target"), path.join(root, "dangling"))) {
    await assert.rejects(files.createFileSystemEntryData(tab, { path: "dangling" }), { code: "EEXIST" });
    assert.equal((await lstat(path.join(root, "dangling"))).isSymbolicLink(), true);
  }
});

test("move preserves aliases and directory-target semantics, refusing overwrite, root, descendants and escapes", async (t) => {
  const { root, outside, tab, service } = await fixture(t);
  const files = service();
  await writeFile(path.join(root, "source.txt"), "move me");
  await mkdir(path.join(root, "dest"));
  await expectError(files.moveFileSystemEntryData(tab), 409, "Moving files or directories requires confirmed: true");
  await expectError(files.moveFileSystemEntryData(tab, { path: "source.txt", toPath: "dest", confirmed: "true" }), 409, "Moving files or directories requires confirmed: true");
  const moved = await files.moveFileSystemEntryData(tab, { sourcePath: "source.txt", destination: "dest", confirmed: true });
  const info = await stat(path.join(root, "dest", "source.txt"));
  assert.deepEqual(moved, { path: "source.txt", destination: "dest/source.txt", name: "source.txt", type: "file", parentPath: "", destinationParentPath: "dest", moved: true, size: info.size, mtimeMs: info.mtimeMs });
  assert.equal(await readFile(path.join(root, "dest", "source.txt"), "utf8"), "move me");
  await assert.rejects(stat(path.join(root, "source.txt")), { code: "ENOENT" });
  await mkdir(path.join(root, "folder", "child"), { recursive: true });
  await writeFile(path.join(root, "folder", "nested.txt"), "nested");
  const movedDir = await files.moveFileSystemEntryData(tab, { filePath: "folder", destinationPath: "renamed", confirmed: true });
  assert.equal(movedDir.type, "directory"); assert.equal(movedDir.destination, "renamed");
  assert.equal(await readFile(path.join(root, "renamed", "nested.txt"), "utf8"), "nested");
  const move = (toPath, entryPath = "dest/source.txt") => files.moveFileSystemEntryData(tab, { path: entryPath, toPath, confirmed: true });
  await expectError(move("renamed/nested.txt"), 409, "Destination already exists: renamed/nested.txt");
  await expectError(move("dest/source.txt"), 400, "Source and destination are the same path");
  await expectError(move("dest"), 400, "Source and destination are the same path");
  await expectError(move(""), 400, "Destination path is required");
  await expectError(move("bad\0"), 400, "Destination path cannot contain null bytes");
  await expectError(move(path.join(outside, "file")), 403, "Destination path must stay inside the active tab working directory");
  await expectError(move("missing/new"), 404, `Destination parent not found: display:${path.join(root, "missing")}`);
  await expectError(move("renamed/child/new", "renamed"), 400, "A directory cannot be moved into itself or one of its descendants");
  await expectError(move("dest", ""), 400, "Workspace root cannot be moved");
  await files.moveFileSystemEntryData(tab, { path: "dest/source.txt", toPath: path.join(root, "absolute.txt"), confirmed: true });
  assert.equal(await readFile(path.join(root, "absolute.txt"), "utf8"), "move me");
});

test("delete requires boolean confirmation, refuses roots, and removes files and nested directories", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder", "file.txt"), "delete me");
  await expectError(files.deleteFileSystemEntryData(tab), 409, "Deleting files or directories requires confirmed: true");
  await expectError(files.deleteFileSystemEntryData(tab, { path: "folder", confirmed: 1 }), 409, "Deleting files or directories requires confirmed: true");
  await expectError(files.deleteFileSystemEntryData(tab, { path: ".", confirmed: true }), 400, "Workspace root cannot be deleted");
  assert.deepEqual(await files.deleteFileSystemEntryData(tab, { filePath: "folder/file.txt", confirmed: true }), {
    path: "folder/file.txt", name: "file.txt", type: "file", parentPath: "folder", deleted: true,
  });
  await writeFile(path.join(root, "folder", "nested"), "recursive");
  assert.deepEqual(await files.deleteFileSystemEntryData(tab, { path: "folder", confirmed: true }), {
    path: "folder", name: "folder", type: "directory", parentPath: "", deleted: true,
  });
  await assert.rejects(stat(path.join(root, "folder")), { code: "ENOENT" });
});

test("mutations reject external symlinks and preserve the ordinary in-root alias behavior", async (t) => {
  const { root, outside, tab, service } = await fixture(t);
  const files = service();
  const outsideFile = path.join(outside, "secret.txt");
  await writeFile(outsideFile, "outside");
  await writeFile(path.join(root, "source.txt"), "source");
  if (!await link(t, outside, path.join(root, "escape"), "dir")) return;
  await symlink(outsideFile, path.join(root, "escape-file"));
  await expectError(files.createFileSystemEntryData(tab, { path: "escape/new" }), 403, "Parent folder escapes the active tab working directory");
  await expectError(files.moveFileSystemEntryData(tab, { path: "source.txt", toPath: "escape/new", confirmed: true }), 403, "Destination parent escapes the active tab working directory");
  await expectError(files.moveFileSystemEntryData(tab, { path: "escape-file", toPath: "new", confirmed: true }), 403, "Resolved path escapes the active tab working directory");
  await expectError(files.deleteFileSystemEntryData(tab, { path: "escape-file", confirmed: true }), 403, "Resolved path escapes the active tab working directory");
  await expectError(files.saveFileContentData(tab, { path: "escape-file", content: "bad" }), 403, "Resolved path escapes the active tab working directory");
  assert.equal(await readFile(outsideFile, "utf8"), "outside");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
  await symlink(path.join(root, "source.txt"), path.join(root, "alias.txt"));
  await files.saveFileContentData(tab, { path: "alias.txt", content: "replacement" });
  assert.equal((await lstat(path.join(root, "alias.txt"))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "source");
  await symlink(path.join(root, "source.txt"), path.join(root, "delete-alias"));
  const deleted = await files.deleteFileSystemEntryData(tab, { path: "delete-alias", confirmed: true });
  assert.equal(deleted.type, "file");
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "source");
});

test("AUR reports use canonical Git roots instead of the tab subdirectory and retain their distinct payload", async (t) => {
  const { base, root, tab, service } = await fixture(t);
  const subdir = path.join(root, "subdir");
  await mkdir(subdir); await mkdir(path.join(root, "reports"));
  const content = "# Audit\n";
  const target = path.join(root, "reports", "audit.md");
  await writeFile(target, content);
  const calls = [];
  const files = service({ getGitRoot: async (cwd) => { calls.push(cwd); return root; } });
  await expectError(files.getFileContentData({ cwd: subdir }, "reports/audit.md"), 404, `Path not found: display:${path.join(subdir, "reports", "audit.md")}`);
  const info = await stat(target);
  assert.deepEqual(await files.getAurReviewReportContentData({ cwd: subdir }, { path: " reports/audit.md ", repoRoot: root }), {
    root, path: "reports/audit.md", name: "audit.md", content, size: Buffer.byteLength(content), mtimeMs: info.mtimeMs, extension: ".md", language: "markdown",
  });
  assert.deepEqual(calls, [subdir]);
  await expectError(files.getAurReviewReportContentData(tab, { path: "reports/audit.md", repoRoot: subdir }), 403, "Report repoRoot does not match this tab's canonical Git root");
  const inaccessible = service({ getGitRoot: async () => path.join(root, "missing") });
  await expectError(inaccessible.getAurReviewReportContentData(tab, { path: "audit.md", repoRoot: root }), 404, "Git repository root is no longer accessible");
  const failure = new Error("not a git repository");
  await assert.rejects(service({ getGitRoot: async () => { throw failure; } }).getAurReviewReportContentData(tab, { path: "audit.md", repoRoot: root }), (error) => error === failure);
  const alias = path.join(base, "repo-alias");
  if (await link(t, root, alias, "dir")) {
    const aliased = service({ getGitRoot: async () => alias });
    assert.equal((await aliased.getAurReviewReportContentData(tab, { path: "reports/audit.md", repoRoot: root })).root, root);
    await expectError(aliased.getAurReviewReportContentData(tab, { path: "reports/audit.md", repoRoot: alias }), 403, "Report repoRoot does not match this tab's canonical Git root");
  }
});

test("AUR validates every path segment and refuses symlinks even within the canonical root", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  for (const repoRoot of [undefined, "", 7, `${root}\0`]) {
    await expectError(files.getAurReviewReportContentData(tab, { path: "audit.md", repoRoot }), 400, "repoRoot is required for an AUR review report");
  }
  await expectError(files.getAurReviewReportContentData(tab), 400, "repoRoot is required for an AUR review report");
  for (const requested of ["", "a".repeat(1025), "bad\0path"]) {
    await expectError(files.getAurReviewReportContentData(tab, { path: requested, repoRoot: root }), 400, "Report path must be a non-empty repo-root-relative path");
  }
  for (const requested of [path.join(root, "report.md"), "C:\\report.md", "reports\\report.md", "\\\\server\\report.md"]) {
    await expectError(files.getAurReviewReportContentData(tab, { path: requested, repoRoot: root }), 400, "Report path must be a repo-root-relative path");
  }
  for (const requested of ["../report.md", "./report.md", "reports//report.md", "reports/../report.md", "reports/./report.md", "reports/"]) {
    await expectError(files.getAurReviewReportContentData(tab, { path: requested, repoRoot: root }), 400, "Report path cannot contain traversal segments");
  }
  await mkdir(path.join(root, "reports"));
  await writeFile(path.join(root, "reports", "audit.md"), "report");
  await expectError(files.getAurReviewReportContentData(tab, { path: "missing.md", repoRoot: root }), 404, "Report path not found: missing.md");
  await expectError(files.getAurReviewReportContentData(tab, { path: "reports", repoRoot: root }), 400, "Report path is not a regular file");
  await expectError(files.getAurReviewReportContentData(tab, { path: "reports/audit.md/child", repoRoot: root }), 400, "Report path contains a non-directory component");
  if (!await link(t, path.join(root, "reports", "audit.md"), path.join(root, "report-link"))) return;
  await symlink(path.join(root, "reports"), path.join(root, "reports-link"), process.platform === "win32" ? "junction" : "dir");
  for (const requested of ["report-link", "reports-link/audit.md"]) {
    await expectError(files.getAurReviewReportContentData(tab, { path: requested, repoRoot: root }), 403, "Report path cannot contain symlinks");
  }
  assert.equal((await files.getFileContentData(tab, "report-link")).content, "report");
});

test("AUR bounded reads accept the exact limit, reject oversized/binary data, and close opened handles", async (t) => {
  const { root, tab, service } = await fixture(t);
  const files = service();
  await writeFile(path.join(root, "exact.md"), Buffer.alloc(MAX_BYTES, 0x61));
  await writeFile(path.join(root, "large.md"), Buffer.alloc(MAX_BYTES + 1, 0x61));
  await writeFile(path.join(root, "binary.png"), Buffer.from([1, 0, 2]));
  await writeFile(path.join(root, "empty.txt"), "");
  for (let attempt = 0; attempt < 4; attempt++) {
    const exact = await files.getAurReviewReportContentData(tab, { path: "exact.md", repoRoot: root });
    assert.equal(exact.size, MAX_BYTES); assert.equal(exact.content.length, MAX_BYTES);
    await expectError(files.getAurReviewReportContentData(tab, { path: "large.md", repoRoot: root }), 413, `Report is too large to open in WebUI (limit ${MAX_BYTES} bytes)`);
    await expectError(files.getAurReviewReportContentData(tab, { path: "binary.png", repoRoot: root }), 415, "File appears to be binary; only text files and supported raster images can be opened in WebUI");
  }
  const empty = await files.getAurReviewReportContentData(tab, { path: "empty.txt", repoRoot: root });
  assert.equal(empty.size, 0); assert.equal(empty.content, ""); assert.equal(empty.language, "text");
  if (process.platform === "linux") {
    const descriptors = await readdir("/proc/self/fd");
    const targets = await Promise.all(descriptors.map((fd) => realpath(`/proc/self/fd/${fd}`).catch(() => "")));
    assert.equal(targets.some((target) => target.startsWith(`${root}${path.sep}`)), false, "success and refusal paths must release report handles");
  } else {
    t.diagnostic("Open-handle observation requires Linux /proc/self/fd; read/refusal cases still ran");
  }
});

async function withEnvironment(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await action(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function editorLog(target) {
  const logPath = `${target}.editor-log`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(logPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(20);
  }
  assert.fail(`Disposable editor did not record ${target}`);
}

test("default editor validates paths and spawns only a disposable explicit Node override", async (t) => {
  const { base, root, tab, service } = await fixture(t);
  const files = service();
  const target = path.join(root, "file with spaces.txt");
  await writeFile(target, "content");
  const editor = path.join(base, "editor.mjs");
  await writeFile(editor, 'import { writeFileSync } from "node:fs"; const target = process.argv.at(-1); writeFileSync(`${target}.editor-log`, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n');
  await withEnvironment({ PI_WEBUI_OPEN_COMMAND: editor }, async () => {
    await expectError(files.openPathInDefaultEditor(tab), 400, "Path to open is required");
    await expectError(files.openPathInDefaultEditor(tab, "  "), 400, "Path to open is required");
    await expectError(files.openPathInDefaultEditor(tab, "../outside"), 403, "Path must stay inside the active tab working directory");
    const result = await files.openPathInDefaultEditor(tab, "file with spaces.txt");
    assert.deepEqual(result, { path: "file with spaces.txt", command: `${process.execPath} ${editor} ${target}`, mime: undefined, desktopFile: undefined, fallbackToTextEditor: false });
    assert.deepEqual(await editorLog(target), { args: [target], cwd: root });
  });
});

test("Linux editor probes MIME associations and falls back to text/plain using disposable launchers", { skip: process.platform !== "linux" }, async (t) => {
  const { base, root, tab, service } = await fixture(t);
  const bin = path.join(base, "bin");
  await mkdir(bin);
  const launcher = `#!${process.execPath}\nconst { writeFileSync } = require("node:fs"); const path = require("node:path"); const target = process.argv.at(-1); writeFileSync(target + ".editor-log", JSON.stringify({ launcher: path.basename(process.argv[1]), args: process.argv.slice(2), cwd: process.cwd() }));\n`;
  for (const name of ["xdg-open", "gio"]) await writeFile(path.join(bin, name), launcher, { mode: 0o755 });
  await withEnvironment({ PATH: bin, PI_WEBUI_OPEN_COMMAND: undefined }, async () => {
    for (const scenario of ["associated", "text-fallback", "unassociated", "query-error", "directory"]) {
      const target = path.join(root, scenario);
      if (scenario === "directory") await mkdir(target);
      else await writeFile(target, "content");
      const queries = [];
      const files = service({ runCommand: async (command, args, options) => {
        assert.equal(command, "xdg-mime");
        assert.deepEqual(options, { cwd: root, timeoutMs: 1500, maxOutputLength: 4096 });
        queries.push(args);
        if (scenario === "query-error") return { exitCode: 1, stdout: "must-be-ignored" };
        if (args[1] === "filetype") return { exitCode: 0, stdout: "\n application/x-fixture \nignored-line\n" };
        if (args[2] === "application/x-fixture") return { exitCode: 0, stdout: scenario === "associated" ? " fixture.desktop\nignored.desktop" : "" };
        assert.equal(args[2], "text/plain");
        return { exitCode: 0, stdout: scenario === "text-fallback" ? " text.desktop \n" : "" };
      } });
      const result = await files.openPathInDefaultEditor(tab, scenario);
      const fallback = scenario === "text-fallback";
      const expectedLauncher = fallback ? "gio" : "xdg-open";
      const args = fallback ? ["launch", "text.desktop", target] : [target];
      assert.equal(result.command, [expectedLauncher, ...args].join(" "));
      assert.equal(result.fallbackToTextEditor, fallback);
      assert.equal(result.desktopFile, fallback ? "text.desktop" : scenario === "associated" ? "fixture.desktop" : undefined);
      assert.equal(result.mime, scenario === "directory" ? undefined : scenario === "query-error" ? "" : "application/x-fixture");
      assert.deepEqual(await editorLog(target), { launcher: expectedLauncher, args, cwd: root });
      assert.deepEqual(queries, scenario === "directory" ? [] : scenario === "query-error" ? [["query", "filetype", target], ["query", "default", "text/plain"]] : [
        ["query", "filetype", target], ["query", "default", "application/x-fixture"], ...(scenario === "associated" ? [] : [["query", "default", "text/plain"]]),
      ]);
    }
  });
});
