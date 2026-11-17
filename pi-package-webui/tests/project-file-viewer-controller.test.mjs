import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProjectFileViewerController,
  gitFileDiffCategory,
  resolveFileViewerMode,
} from "../public/project-file-viewer-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const normalizePath = (value = "") => String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/g, "");
const fileDisplayName = (path) => normalizePath(path).split("/").pop();
const fileExtensionForPath = (path) => {
  const name = fileDisplayName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};
const fileLanguageForPath = (path) => [".md", ".markdown"].includes(fileExtensionForPath(path)) ? "markdown" : "text";

function fixture() {
  const alive = new Map([["a", 1], ["b", 1]]);
  let target = { tabId: "a", generation: 1, lifetime: 1 };
  const calls = [];
  const confirmations = [];
  const changes = [];
  const statuses = [];
  const selected = [];
  const refreshes = [];
  const events = [];
  let refresh = () => {};
  const controller = createProjectFileViewerController({
    api(path, options) {
      const pending = deferred();
      calls.push({ path, options, resolve: (data = {}) => pending.resolve({ ok: true, data }), reject: pending.reject });
      return pending.promise;
    },
    captureTarget: () => target,
    isTargetCurrent: (captured) => captured.tabId === target.tabId && captured.generation === target.generation
      && captured.lifetime === alive.get(captured.tabId),
    isTargetAlive: (captured) => captured.lifetime === alive.get(captured.tabId),
    confirmDiscardEdits(options) {
      const pending = deferred();
      confirmations.push({ options, ...pending });
      return pending.promise;
    },
    normalizePath,
    fileApiPath: (base, path) => `${base}?${new URLSearchParams({ path: normalizePath(path) })}`,
    fileDisplayName,
    fileExtensionForPath,
    fileLanguageForPath,
    imageDataUrl: (data) => ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(data.mimeType) && data.data
      ? `data:${data.mimeType};base64,${data.data}` : "",
    remapPath(path, source, destination) {
      if (path === source) return destination;
      return path.startsWith(`${source}/`) ? `${destination}/${path.slice(source.length + 1)}` : path;
    },
    onChange: (reason) => changes.push(reason),
    onStatus: (...args) => statuses.push(args),
    onSelectPath: (path) => selected.push(path),
    onRefreshDirectory: (path, captured) => { refreshes.push({ path, target: captured }); return refresh(); },
    addEvent: (...args) => events.push(args),
  });
  controller.activate("a");
  return {
    c: controller, calls, confirmations, changes, statuses, selected, refreshes, events, alive,
    target: () => target,
    select(tabId) {
      target = { tabId, generation: target.generation + 1, lifetime: alive.get(tabId) };
      controller.activate(tabId);
    },
    replace(tabId = target.tabId) {
      alive.set(tabId, (alive.get(tabId) || 0) + 1);
      if (target.tabId === tabId) target = { ...target, generation: target.generation + 1, lifetime: alive.get(tabId) };
    },
    refreshWith(callback) { refresh = callback; },
    async seed(path = "src/file.txt", data = {}) {
      const result = controller.open(path);
      await flush();
      calls.at(-1).resolve({ path, name: fileDisplayName(path), content: "original", size: 8, mtimeMs: 10, ...data });
      assert.equal((await result).success, true);
      return controller.viewer;
    },
  };
}

test("Git category and viewer mode helpers preserve the app rules", () => {
  for (const [input, expected] of [["staged", "staged"], [" changes ", "unstaged"], ["conflicted", "conflicted"], ["untracked", "untracked"], ["unstaged", ""], ["unknown", ""], [null, ""]]) {
    assert.equal(gitFileDiffCategory(input), expected);
  }
  assert.equal(resolveFileViewerMode(null), "source");
  assert.equal(resolveFileViewerMode({ mode: "preview", language: "markdown" }), "preview");
  assert.equal(resolveFileViewerMode({ mode: "preview", language: "text" }), "source");
  assert.equal(resolveFileViewerMode({ mode: "changes" }), "source");
  assert.equal(resolveFileViewerMode({ mode: "changes", kind: "image" }), "image");
  assert.equal(resolveFileViewerMode({ mode: "changes", kind: "image", gitChanges: {} }), "changes");
  assert.equal(resolveFileViewerMode({ mode: "source", kind: "image" }), "image");
  assert.equal(resolveFileViewerMode({ sourceAvailable: false, gitChanges: {} }), "changes");
  assert.equal(resolveFileViewerMode({ mode: "preview", sourceAvailable: false, language: "markdown" }), "source");
});

test("file open sends normalized paths and preserves the text viewer shape", async () => {
  const f = fixture();
  const pending = f.c.open("./docs\\read me.md");
  await flush();
  assert.equal(f.calls[0].path, "/api/files/content?path=docs%2Fread+me.md");
  assert.deepEqual(f.calls[0].options, { tabId: "a" });
  assert.deepEqual(f.selected, ["docs/read me.md"]);
  f.calls[0].resolve({ path: "docs/read me.md", name: "read me.md", content: "# Hi", size: "4", mtimeMs: "20", extension: ".md", language: "markdown" });
  const result = await pending;
  assert.deepEqual(result, { success: true, viewer: f.c.viewer });
  assert.deepEqual(f.c.viewer, {
    path: "docs/read me.md", name: "read me.md", content: "# Hi", size: 4, mtimeMs: 20,
    extension: ".md", language: "markdown", kind: "text", mimeType: "", imageUrl: "", mode: "preview",
    dirty: false, readOnly: false, sourceAvailable: true, gitChanges: null,
  });
  assert.deepEqual(f.c.tabIds, ["a"]);
  assert.deepEqual(f.statuses.at(-1), ["Opened in WebUI.", "success"]);
  assert.deepEqual(f.changes, ["activate", "open"]);
});

test("content, mode, selection, continuity and cached buffers retain identity per tab", async () => {
  const f = fixture();
  const first = await f.seed("a.md", { language: "markdown" });
  const selection = { path: "a.md", text: "original", start: 0, end: 8 };
  const continuity = { path: "a.md", content: "original", scrollTop: 44, selectionStart: 2, selectionEnd: 4, focused: true };
  f.c.setSelection(selection);
  f.c.cache("a", continuity);
  assert.equal(f.c.viewer, first);
  assert.equal(first.editorContinuity, continuity);
  f.c.setMode("preview");
  assert.equal(f.c.selection, selection);
  f.select("b");
  assert.equal(f.c.viewer, null);
  assert.equal(f.c.selection, null);
  await f.seed("b.txt");
  f.select("a");
  assert.equal(f.c.viewer, first);
  assert.equal(f.c.selection, selection);
  assert.equal(f.c.viewer.editorContinuity, continuity);
  f.c.setContent("é🙂");
  assert.equal(first.content, "é🙂");
  assert.equal(first.size, 6);
  assert.equal(first.dirty, true);
  assert.equal(f.changes.at(-1), "content");
  f.c.setDirty(false);
  assert.equal(first.dirty, false);
  const nextContinuity = { ...continuity, content: "é🙂" };
  f.c.setEditorContinuity(nextContinuity);
  assert.equal(first.editorContinuity, nextContinuity);
  assert.equal(f.changes.at(-1), "continuity");
  f.c.cache("b", { path: "wrong-tab" });
  assert.equal(first.editorContinuity, nextContinuity);
  f.select("b");
  assert.equal(f.c.viewer.path, "b.txt");
  assert.deepEqual(f.c.tabIds, ["a", "b"]);
  f.c.tabIds.length = 0;
  assert.deepEqual(f.c.tabIds, ["a", "b"]);
});

test("reset clears presentation and pending opens while close discards only the active cache", async () => {
  const f = fixture();
  const first = await f.seed();
  const selection = { text: "first" };
  f.c.setSelection(selection);
  const pending = f.c.open("next.txt");
  await flush();
  f.c.resetActive();
  assert.equal(f.c.viewer, null);
  assert.equal(f.c.selection, null);
  assert.deepEqual(f.c.tabIds, ["a"]);
  f.calls.at(-1).resolve({ content: "stale" });
  assert.deepEqual(await pending, { success: false, reason: "stale" });
  f.c.activate("a");
  assert.equal(f.c.viewer, first);
  assert.equal(f.c.selection, selection);
  f.select("b");
  await f.seed("b.txt");
  f.c.close();
  assert.deepEqual(f.c.tabIds, ["a"]);
  f.c.activate("b");
  assert.equal(f.c.viewer, null);
  f.select("a");
  assert.equal(f.c.viewer, first);
});

test("dirty file and report declines retain exact buffer, selection and status", async () => {
  for (const report of [false, true]) {
    const f = fixture();
    const buffer = await f.seed();
    const selection = { text: "kept" };
    f.c.setSelection(selection);
    f.c.setContent("unsaved");
    const count = f.calls.length;
    const statusCount = f.statuses.length;
    const pending = report ? f.c.openReport("reports/review.md", "/repo") : f.c.open("new.txt");
    assert.deepEqual(f.confirmations[0].options, { what: "unsaved file edits", target: "src/file.txt" });
    f.confirmations[0].resolve(false);
    assert.deepEqual(await pending, { success: false, reason: "declined" });
    assert.equal(f.calls.length, count);
    assert.equal(f.statuses.length, statusCount);
    assert.equal(f.c.viewer, buffer);
    assert.equal(f.c.selection, selection);
  }
});

test("accepting a captured discard prompt cannot open after replacement, navigation or retirement", async () => {
  for (const operation of ["file", "report"]) {
    for (const invalidate of ["replace", "navigate", "retire", "edit", "close"]) {
      const f = fixture();
      await f.seed();
      f.c.setContent("unsaved");
      const pending = operation === "file" ? f.c.open("new.txt") : f.c.openReport("report.md", "/repo");
      if (invalidate === "replace") f.replace();
      else if (invalidate === "navigate") f.select("b");
      else if (invalidate === "retire") { f.c.forgetTab("a"); f.c.activate("a"); }
      else if (invalidate === "edit") f.c.setContent("newer unsaved");
      else f.c.close();
      f.confirmations[0].resolve(true);
      assert.deepEqual(await pending, { success: false, reason: "stale" }, `${operation}/${invalidate}`);
      assert.equal(f.calls.length, 1);
    }
  }
});

test("a newer open supersedes an older prompt even when confirmations resolve in reverse", async () => {
  const f = fixture();
  await f.seed();
  f.c.setContent("dirty");
  const first = f.c.open("first.txt");
  const second = f.c.openReport("second.md", "/repo");
  f.confirmations[1].resolve(true);
  await flush();
  f.calls[1].resolve({ path: "second.md", content: "report" });
  assert.equal((await second).success, true);
  f.confirmations[0].resolve(true);
  assert.deepEqual(await first, { success: false, reason: "stale" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.c.viewer.path, "second.md");
});

test("reverse-order file and report responses cannot replace a newer open", async () => {
  for (const oldReport of [false, true]) {
    const f = fixture();
    const first = oldReport ? f.c.openReport("old.md", "/repo") : f.c.open("old.txt");
    await flush();
    const second = oldReport ? f.c.open("new.txt") : f.c.openReport("new.md", "/repo");
    await flush();
    f.calls[1].resolve({ content: "new" });
    assert.equal((await second).success, true);
    const current = f.c.viewer;
    const changes = f.changes.length;
    f.calls[0].resolve({ content: "old" });
    assert.deepEqual(await first, { success: false, reason: "stale" });
    assert.equal(f.c.viewer, current);
    assert.equal(f.c.viewer.content, "new");
    assert.equal(f.changes.length, changes);
  }
});

test("file and report reads reject late success after target replacement or new editor changes", async () => {
  for (const report of [false, true]) {
    for (const invalidate of ["session", "navigate", "edit", "move"]) {
      const f = fixture();
      const original = await f.seed();
      const pending = report ? f.c.openReport("report.md", "/repo") : f.c.open("next.txt");
      await flush();
      if (invalidate === "session") f.replace();
      else if (invalidate === "navigate") { f.select("b"); f.select("a"); }
      else if (invalidate === "edit") f.c.setContent("new edits while opening");
      else f.c.remapPath("src", "moved");
      const statuses = f.statuses.length;
      const changes = f.changes.length;
      f.calls[1].resolve({ content: "stale response" });
      assert.deepEqual(await pending, { success: false, reason: "stale" }, `${report}/${invalidate}`);
      assert.equal(f.c.viewer, original);
      assert.equal(f.statuses.length, statuses);
      assert.equal(f.changes.length, changes);
    }
  }
});

test("report requests preserve root/path encoding, read-only data and failure wording", async () => {
  const f = fixture();
  const pending = f.c.openReport("./reports/a b.md", "/repo with spaces");
  await flush();
  assert.equal(f.calls[0].path, "/api/aur-review/report-content?path=reports%2Fa+b.md&repoRoot=%2Frepo+with+spaces");
  assert.deepEqual(f.calls[0].options, { tabId: "a" });
  f.calls[0].resolve({ path: "reports/a b.md", name: "a b.md", content: "# Review", size: 8, mtimeMs: 15, extension: ".md", language: "markdown" });
  assert.equal((await pending).success, true);
  assert.deepEqual(f.c.viewer, { path: "reports/a b.md", name: "a b.md", content: "# Review", size: 8, mtimeMs: 15, extension: ".md", language: "markdown", mode: "preview", dirty: false, readOnly: true });
  assert.deepEqual(f.selected, []);
  f.c.setContent("should not edit");
  f.c.setDirty(true);
  assert.equal(f.c.viewer.content, "# Review");
  assert.equal(f.c.viewer.dirty, false);
  assert.deepEqual(await f.c.save("no"), { success: false, reason: "read-only" });
  const failure = f.c.openReport("missing.md", "/repo");
  await flush();
  const error = new Error("Report path not found");
  f.calls[1].reject(error);
  assert.deepEqual(await failure, { success: false, reason: "error", error });
  assert.equal(f.c.viewer.content, "# Review");
  assert.deepEqual(f.events, [["review report open failed: Report path not found", "error"]]);
});

test("all panel categories send the actual Git diff route and preserve snapshot metadata", async () => {
  for (const [panel, category] of [["changes", "unstaged"], ["staged", "staged"], ["conflicted", "conflicted"], ["untracked", "untracked"]]) {
    const f = fixture();
    const pending = f.c.open("src/local.txt", { gitCategory: panel, gitPath: "repo/path space.txt" });
    await flush();
    assert.equal(f.calls[0].path, `/api/git-file-diff?path=repo%2Fpath+space.txt&category=${category}`);
    assert.deepEqual(f.calls[0].options, { tabId: "a" });
    f.calls[1].resolve({ content: "file" });
    const result = await pending;
    const buffer = result.viewer;
    assert.equal(buffer.gitChanges.loading, true);
    assert.equal(buffer.gitChanges.requestSerial, 1);
    assert.equal(buffer.mode, "changes");
    const selection = { text: "clear on changes" };
    f.c.setMode("source");
    f.c.setSelection(selection);
    f.c.setMode("changes");
    assert.equal(f.c.selection, null);
    f.calls[0].resolve({ path: "canonical.txt", label: "Working tree", command: "git diff", diff: 42, truncated: true, capBytes: "500", error: "untracked content missing", entries: [{ path: "canonical.txt", contentMissing: true }] });
    await flush();
    assert.equal(f.c.viewer, buffer);
    assert.deepEqual(buffer.gitChanges, { category, path: "canonical.txt", label: "Working tree", command: "git diff", diff: "42", truncated: true, capBytes: 500, error: "", contentError: "untracked content missing", entries: [{ path: "canonical.txt", contentMissing: true }] });
    assert.equal(f.changes.at(-1), "diff");
  }
});

test("late Git diff updates its exact live background buffer without repainting the foreground", async () => {
  const f = fixture();
  const pending = f.c.open("first.txt", { gitCategory: "staged" });
  await flush();
  f.calls[1].resolve({ content: "first" });
  const buffer = (await pending).viewer;
  f.select("b");
  const second = await f.seed("second.txt");
  const changes = f.changes.length;
  f.calls[0].resolve({ diff: "first diff", label: "Staged" });
  await flush();
  assert.equal(buffer.gitChanges.diff, "first diff");
  assert.equal(f.c.viewer, second);
  assert.equal(f.changes.length, changes);
  f.select("a");
  assert.equal(f.c.viewer, buffer);
  assert.equal(f.c.viewer.gitChanges.diff, "first diff");
});

test("same-path replacement, session replacement and retired/reused IDs reject old diffs", async () => {
  for (const invalidate of ["buffer", "session", "retire", "close"]) {
    const f = fixture();
    const pending = f.c.open("same.txt", { gitCategory: "staged" });
    await flush();
    f.calls[1].resolve({ content: "old" });
    const old = (await pending).viewer;
    if (invalidate === "session") f.replace();
    else if (invalidate === "retire") { f.c.forgetTab("a"); f.c.activate("a"); }
    else if (invalidate === "close") f.c.close();
    if (invalidate !== "session") await f.seed("same.txt", { content: "replacement" });
    f.calls[0].resolve({ diff: "stale diff" });
    await flush();
    assert.equal(old.gitChanges.loading, true, invalidate);
    assert.notEqual(f.c.viewer?.gitChanges?.diff, "stale diff");
  }
});

test("a live diff repaints its original buffer after navigating away and back", async () => {
  const f = fixture();
  const pending = f.c.open("first.txt", { gitCategory: "staged" });
  await flush();
  f.calls[1].resolve({ content: "first" });
  const buffer = (await pending).viewer;
  f.select("b");
  f.select("a");
  assert.equal(f.c.viewer, buffer);
  f.calls[0].resolve({ diff: "live diff" });
  await flush();
  assert.equal(f.c.viewer.gitChanges.diff, "live diff");
  assert.equal(f.changes.at(-1), "diff");
});

test("diff failures are visible snapshots and do not reject a successful source open", async () => {
  const f = fixture();
  const pending = f.c.open("file.txt", { gitCategory: "changes" });
  await flush();
  f.calls[1].resolve({ content: "file" });
  assert.equal((await pending).success, true);
  f.calls[0].reject(new Error("Git unavailable"));
  await flush();
  assert.equal(f.c.viewer.gitChanges.error, "Git unavailable");
  assert.deepEqual(f.events, []);
});

test("deleted-source Git fallback remains read-only and cannot beat a newer open", async () => {
  const f = fixture();
  const pending = f.c.open("gone.md", { gitCategory: "changes" });
  await flush();
  f.calls[1].reject(new Error("Path not found"));
  await flush();
  f.calls[0].resolve({ diff: "-deleted", label: "Working tree" });
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.viewer.sourceAvailable, false);
  assert.equal(result.viewer.readOnly, true);
  assert.equal(result.viewer.content, "");
  assert.equal(result.viewer.extension, ".md");
  assert.equal(result.viewer.language, "markdown");
  f.c.setMode("source");
  assert.equal(f.c.viewer.mode, "changes");
  assert.deepEqual(f.statuses.at(-1), ["File content unavailable; showing Git changes (read-only).", "warn"]);
  const old = f.c.open("another.txt", { gitCategory: "staged" });
  await flush();
  f.calls[3].reject(new Error("Deleted"));
  await flush();
  await f.seed("current.txt");
  f.calls[2].resolve({ diff: "too late" });
  assert.deepEqual(await old, { success: false, reason: "stale" });
  assert.equal(f.c.viewer.path, "current.txt");
});

test("file and diff failures preserve the previous buffer and emit the original open error", async () => {
  const f = fixture();
  const previous = await f.seed();
  const pending = f.c.open("missing.txt", { gitCategory: "staged" });
  await flush();
  const error = new Error("Missing source");
  f.calls[2].reject(error);
  f.calls[1].reject(new Error("Git also missing"));
  assert.deepEqual(await pending, { success: false, reason: "error", error });
  assert.equal(f.c.viewer, previous);
  assert.deepEqual(f.events, [["file open failed: Missing source", "error"]]);
});

test("images are read-only, retain their URL/mime metadata and reject unsupported data", async () => {
  const f = fixture();
  await f.seed("photo.png", { kind: "image", mimeType: "image/png", data: "aW1hZ2U=", content: "ignored" });
  const image = f.c.viewer;
  assert.equal(image.content, "");
  assert.equal(image.imageUrl, "data:image/png;base64,aW1hZ2U=");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.language, "image");
  assert.equal(image.mode, "image");
  assert.equal(image.readOnly, true);
  assert.equal(image.sourceAvailable, false);
  f.c.setMode("source");
  f.c.setContent("no");
  assert.equal(image.mode, "image");
  assert.equal(image.content, "");
  const invalid = f.c.open("unsafe.svg");
  await flush();
  f.calls.at(-1).resolve({ kind: "image", mimeType: "image/svg+xml", data: "unsafe" });
  const result = await invalid;
  assert.equal(result.reason, "error");
  assert.equal(result.error.message, "Image preview data is invalid or unsupported");
  assert.equal(f.c.viewer, image);
});

test("save sends submitted content and mtime, refreshes with the saved file path and preserves identity", async () => {
  const f = fixture();
  const buffer = await f.seed();
  f.c.setContent("submitted");
  const captured = f.target();
  const pending = f.c.save("submitted");
  assert.equal(f.calls[1].path, "/api/files/content");
  assert.deepEqual(f.calls[1].options, { method: "POST", body: { path: "src/file.txt", content: "submitted", mtimeMs: 10 }, tabId: "a" });
  f.calls[1].resolve({ path: "src/file.txt", name: "file.txt", size: 9, mtimeMs: 55, extension: ".txt", language: "text" });
  assert.deepEqual(await pending, { success: true, viewer: buffer });
  assert.equal(f.c.viewer, buffer);
  assert.equal(buffer.mtimeMs, 55);
  assert.equal(buffer.dirty, false);
  assert.deepEqual(f.refreshes, [{ path: "src/file.txt", target: captured }]);
  assert.deepEqual(f.statuses.at(-1), ["Saved.", "success"]);
  f.c.resetActive();
  f.c.activate("a");
  assert.equal(f.c.viewer, buffer);
});

test("save retains edits typed during the POST while advancing saved mtime for the next save", async () => {
  const f = fixture();
  const buffer = await f.seed();
  f.c.setContent("submitted");
  const pending = f.c.save("submitted");
  f.c.setContent("newer é🙂");
  f.calls[1].resolve({ mtimeMs: 55, size: 9 });
  assert.equal((await pending).success, true);
  assert.equal(buffer.content, "newer é🙂");
  assert.equal(buffer.size, new Blob(["newer é🙂"]).size);
  assert.equal(buffer.mtimeMs, 55);
  assert.equal(buffer.dirty, true);
  assert.deepEqual(f.statuses.at(-1), ["Unsaved file edits.", "warn"]);
  const next = f.c.save(buffer.content);
  assert.equal(f.calls[2].options.body.mtimeMs, 55);
  f.calls[2].resolve({ mtimeMs: 66, size: buffer.size });
  assert.equal((await next).success, true);
  assert.equal(buffer.dirty, false);
});

test("save uses explicit submitted text when the editor value has not been mirrored yet", async () => {
  const f = fixture();
  await f.seed();
  const pending = f.c.save("unmirrored editor value");
  f.calls[1].resolve({ size: 22, mtimeMs: 40 });
  assert.equal((await pending).success, true);
  assert.equal(f.c.viewer.content, "unmirrored editor value");
  assert.equal(f.c.viewer.dirty, false);
});

test("save conflicts preserve edits and metadata without refreshing or clearing controls", async () => {
  const f = fixture();
  const buffer = await f.seed();
  f.c.setContent("keep");
  const pending = f.c.save("keep");
  const error = Object.assign(new Error("File changed on disk after it was opened. Reopen it before saving."), { statusCode: 409 });
  f.calls[1].reject(error);
  assert.deepEqual(await pending, { success: false, reason: "error", error });
  assert.equal(f.c.viewer, buffer);
  assert.equal(buffer.content, "keep");
  assert.equal(buffer.dirty, true);
  assert.equal(buffer.mtimeMs, 10);
  assert.deepEqual(f.refreshes, []);
  assert.deepEqual(f.statuses.at(-1), [error.message, "error"]);
});

test("late save success or failure cannot affect a replacement buffer, session or foreground", async () => {
  for (const invalidate of ["buffer", "session", "navigate", "retire", "reset", "close"]) {
    for (const fail of [false, true]) {
      const f = fixture();
      const old = await f.seed();
      const pending = f.c.save("submitted");
      if (invalidate === "session") f.replace();
      else if (invalidate === "navigate") { f.select("b"); await f.seed("b.txt"); }
      else if (invalidate === "retire") { f.c.forgetTab("a"); f.c.activate("a"); await f.seed(); }
      else if (invalidate === "reset") f.c.resetActive();
      else if (invalidate === "close") f.c.close();
      else await f.seed();
      const current = f.c.viewer;
      const changes = f.changes.length;
      const statuses = f.statuses.length;
      if (fail) f.calls[1].reject(new Error("stale save conflict"));
      else f.calls[1].resolve({ mtimeMs: 999, content: "submitted" });
      assert.deepEqual(await pending, { success: false, reason: "stale" }, `${invalidate}/${fail}`);
      assert.equal(f.c.viewer, current);
      assert.equal(old.mtimeMs, 10);
      assert.equal(old.content, "original");
      assert.equal(f.changes.length, changes);
      assert.equal(f.statuses.length, statuses);
      assert.deepEqual(f.refreshes, []);
    }
  }
});

test("reverse-order saves cannot regress metadata or clear later edits", async () => {
  const f = fixture();
  await f.seed();
  f.c.setContent("first");
  const first = f.c.save("first");
  f.c.setContent("second");
  const second = f.c.save("second");
  f.calls[2].resolve({ size: 6, mtimeMs: 30 });
  assert.equal((await second).success, true);
  f.calls[1].resolve({ size: 5, mtimeMs: 20 });
  assert.deepEqual(await first, { success: false, reason: "stale" });
  assert.equal(f.c.viewer.content, "second");
  assert.equal(f.c.viewer.mtimeMs, 30);
  assert.equal(f.c.viewer.dirty, false);
  assert.equal(f.refreshes.length, 1);
});

test("save refresh completion rechecks foreground ownership before reporting success", async () => {
  const f = fixture();
  const refresh = deferred();
  f.refreshWith(() => refresh.promise);
  const buffer = await f.seed();
  const pending = f.c.save("saved");
  f.calls[1].resolve({ size: 5, mtimeMs: 20 });
  await flush();
  assert.equal(buffer.mtimeMs, 20);
  f.select("b");
  const statuses = f.statuses.length;
  refresh.resolve();
  assert.deepEqual(await pending, { success: false, reason: "stale" });
  assert.equal(f.statuses.length, statuses);
});

test("move preserves buffer content, remaps selection and invalidates the old diff and save", async () => {
  const f = fixture();
  const pending = f.c.open("dir/file.md", { gitCategory: "staged" });
  await flush();
  f.calls[1].resolve({ content: "original", language: "markdown", mtimeMs: 10 });
  const buffer = (await pending).viewer;
  f.c.setContent("edited");
  f.c.setSelection({ text: "edited", path: "dir/file.md", fileName: "file.md", start: 0 });
  const saving = f.c.save("edited");
  f.c.remapPath("dir", "new-dir");
  assert.equal(f.c.viewer, buffer);
  assert.equal(buffer.path, "new-dir/file.md");
  assert.equal(buffer.content, "edited");
  assert.equal(buffer.dirty, true);
  assert.equal(buffer.gitChanges, null);
  assert.equal(buffer.mode, "source");
  assert.deepEqual(f.c.selection, { text: "edited", path: "new-dir/file.md", fileName: "file.md", start: 0 });
  assert.equal(f.changes.at(-1), "move");
  f.calls[0].resolve({ diff: "obsolete diff" });
  f.calls[2].resolve({ path: "dir/file.md", mtimeMs: 99 });
  assert.deepEqual(await saving, { success: false, reason: "stale" });
  assert.equal(buffer.gitChanges, null);
  assert.equal(buffer.path, "new-dir/file.md");
  assert.equal(buffer.mtimeMs, 10);
  f.c.setMode("preview");
  f.c.remapPath("new-dir/file.md", "new-dir/renamed.markdown");
  assert.equal(buffer.mode, "preview");
  assert.equal(buffer.extension, ".markdown");
  assert.equal(f.c.selection.fileName, "renamed.markdown");
  f.c.remapPath("new-dir/renamed.markdown", "file.txt");
  assert.equal(buffer.mode, "source");
  assert.equal(buffer.language, "text");
});

test("missing inputs and mismatched targets never issue requests", async () => {
  const f = fixture();
  assert.deepEqual(await f.c.open(""), { success: false, reason: "path" });
  assert.deepEqual(await f.c.openReport("report.md", ""), { success: false, reason: "path" });
  assert.deepEqual(await f.c.openReport("", "/repo"), { success: false, reason: "path" });
  assert.deepEqual(await f.c.save(""), { success: false, reason: "empty" });
  f.c.activate("b");
  assert.deepEqual(await f.c.open("file.txt"), { success: false, reason: "target" });
  assert.deepEqual(await f.c.openReport("report.md", "/repo"), { success: false, reason: "target" });
  assert.equal(f.calls.length, 0);
});

test("late open and report errors after navigation cannot emit foreground status or events", async () => {
  for (const report of [false, true]) {
    const f = fixture();
    const pending = report ? f.c.openReport("report.md", "/repo") : f.c.open("file.txt");
    await flush();
    f.select("b");
    const statuses = f.statuses.length;
    f.calls[0].reject(new Error("old target failure"));
    assert.deepEqual(await pending, { success: false, reason: "stale" });
    assert.equal(f.statuses.length, statuses);
    assert.deepEqual(f.events, []);
    assert.equal(f.c.viewer, null);
  }
});
