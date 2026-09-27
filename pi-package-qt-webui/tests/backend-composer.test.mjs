import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeMessageWithTexts, createAttachmentStore } from "../lib/backend/attachments.mjs";
import { HIGHLIGHT_LANGUAGES, highlightCode, highlightSupported, TOKEN_KINDS } from "../lib/backend/highlight.mjs";
import { renderMarkdown } from "../lib/backend/markdown.mjs";
import { normalizeCommands } from "../lib/backend/pi-session.mjs";
import { LIMITS, REQUEST_TYPES, makeErrorResponse, makeResponse, validatePromptSettlement, validateRequest } from "../lib/backend/protocol.mjs";
import { createSequenceStore, validateSequences } from "../lib/backend/sequences.mjs";
import { createStateStore, temporaryDraftKey, validateState } from "../lib/backend/state.mjs";
import { confinePath, createWorkspaceIndex, resolveInsideWorkspace } from "../lib/backend/workspace.mjs";
import { startBackend } from "./helpers/backend-client.mjs";
import { bridgeHarness } from "./helpers/qml-functions.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function temporaryWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qt-webui-composer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// ---- highlighting --------------------------------------------------------------------------

test("highlighting emits escaped semantic tokens for known languages and nothing for unknown ones", () => {
  const { tokens } = highlightCode("js", "const a = \"<b>\" // c\nfoo(1)");
  assert(tokens.every(([kind]) => TOKEN_KINDS.includes(kind)));
  assert.deepEqual(tokens.filter(([kind]) => kind !== "text").map(([kind]) => kind), ["keyword", "operator", "string", "comment", "function", "punctuation", "number", "punctuation"]);
  assert.equal(tokens.find(([kind]) => kind === "string")[1], "&quot;&lt;b&gt;&quot;");
  assert(!tokens.some(([, text]) => /[<>]/.test(text)), "no raw angle brackets survive");
  assert.equal(tokens.map(([, text]) => text).join("").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), "const a = \"<b>\" // c\nfoo(1)", "tokens concatenate to the original text");
  assert.equal(highlightCode("brainfuck", "+++").tokens, null);
  assert.equal(highlightCode("js", "").tokens, null);
  assert(highlightSupported("TypeScript"));
  assert(!highlightSupported("cobol"));
  assert(HIGHLIGHT_LANGUAGES.includes("python") && HIGHLIGHT_LANGUAGES.includes("bash") && HIGHLIGHT_LANGUAGES.includes("diff"));
  for (const [language, source, kind] of [
    ["python", "def f():\n  return None", "keyword"], ["bash", "echo $HOME", "variable"], ["json", "{\"k\": 1}", "attribute"],
    ["yaml", "key: v", "attribute"], ["html", "<a href=\"x\">", "tag"], ["sql", "select 1", "keyword"], ["diff", "+added", "string"], ["css", ".a { color: red }", "attribute"], ["toml", "[table]\nk = 1", "tag"], ["rust", "fn main() {}", "keyword"],
  ]) assert(highlightCode(language, source).tokens.some(([tokenKind]) => tokenKind === kind), `${language} should produce a ${kind} token`);
});

test("highlighting stays within its character and token budgets", () => {
  assert.notEqual(highlightCode("js", "a".repeat(LIMITS.maxHighlightCharacters)).tokens, null);
  assert.equal(highlightCode("js", "a".repeat(LIMITS.maxHighlightCharacters + 1)).tokens, null);
  const busy = highlightCode("js", "a+".repeat(LIMITS.maxHighlightTokens));
  assert.equal(busy.tokens, null);
  assert.equal(busy.truncated, true);
  const started = process.hrtime.bigint();
  highlightCode("js", `${"/*".repeat(2000)}${"\"".repeat(4000)}`);
  highlightCode("html", "<".repeat(8000));
  assert(Number(process.hrtime.bigint() - started) / 1e6 < 1000, "adversarial highlighting must stay fast");
  const { blocks } = renderMarkdown("```ts\nconst x: number = 1\n```\n\n```nope\nplain\n```");
  assert(Array.isArray(blocks[0].tokens) && blocks[0].tokens.length > 0);
  assert.equal(blocks[1].tokens, null);
  assert.equal(blocks[0].text, "const x: number = 1", "copy still returns the original text");
});

// ---- protocol ------------------------------------------------------------------------------

test("validateRequest bounds drafts, sequences, attachments, and completion requests", () => {
  for (const type of ["draft_get", "draft_set", "sequences_list", "sequence_save", "sequence_delete", "sequence_run", "commands_list", "attachment_add", "attachment_update", "attachment_remove", "path_complete"]) {
    assert(REQUEST_TYPES.includes(type), `${type} must be a request type`);
  }
  const valid = (type, fields) => validateRequest({ v: 1, id: "x", type, ...fields });
  assert.deepEqual(valid("prompt", { message: "hi", attachments: ["a"] }).attachments, ["a"]);
  assert.deepEqual(valid("prompt", { message: "hi" }).attachments, []);
  assert.throws(() => valid("prompt", { message: "hi", attachments: Array.from({ length: LIMITS.maxAttachments + 1 }, () => "a") }), (error) => error.code === "limit_exceeded");
  assert.throws(() => valid("prompt", { message: "hi", attachments: [""] }), /non-empty strings/);
  assert.throws(() => valid("prompt", { message: "hi", attachments: ["a", "a"] }), /must be unique/);
  assert.equal(valid("draft_set", { key: "/w", text: "x".repeat(LIMITS.maxDraftCharacters) }).text.length, LIMITS.maxDraftCharacters);
  assert.throws(() => valid("draft_set", { key: "/w", text: "x".repeat(LIMITS.maxDraftCharacters + 1) }), (error) => error.code === "limit_exceeded");
  assert.throws(() => valid("draft_get", { key: "" }), /requires a key/);
  const save = (fields) => valid("sequence_save", { name: "Daily", entries: ["one"], ...fields });
  assert.equal(save({}).sequenceId, "");
  assert.equal(save({ sequenceId: "seq-1" }).sequenceId, "seq-1");
  assert.equal(save({ entries: Array.from({ length: LIMITS.maxSequenceEntries }, () => "e") }).entries.length, LIMITS.maxSequenceEntries);
  assert.throws(() => save({ entries: Array.from({ length: LIMITS.maxSequenceEntries + 1 }, () => "e") }), (error) => error.code === "limit_exceeded");
  assert.throws(() => save({ entries: [] }), /at least one entry/);
  assert.throws(() => save({ entries: ["  "] }), /entry 1 must be/);
  assert.throws(() => save({ entries: ["x".repeat(LIMITS.maxMessageCharacters + 1)] }), (error) => error.code === "limit_exceeded");
  assert.throws(() => save({ name: " " }), /requires a name/);
  assert.throws(() => save({ name: "n".repeat(LIMITS.maxSequenceNameCharacters + 1) }), (error) => error.code === "limit_exceeded");
  assert.throws(() => valid("sequence_run", {}), /string sequenceId/);
  assert.equal(valid("attachment_add", { path: "/tmp/a.png" }).granted, false);
  assert.equal(valid("attachment_add", { path: "/tmp/a.png", granted: true }).granted, true);
  assert.throws(() => valid("attachment_add", { path: "relative.png" }), /absolute/);
  assert.throws(() => valid("attachment_add", { path: "/x", granted: "yes" }), /granted must be boolean/);
  assert.throws(() => valid("attachment_update", { attachmentId: "a", text: "x".repeat(LIMITS.maxTextAttachmentBytes + 1) }), (error) => error.code === "limit_exceeded");
  assert.equal(valid("path_complete", {}).query, "");
  assert.throws(() => valid("path_complete", { query: "q".repeat(LIMITS.maxCompletionQueryCharacters + 1) }), (error) => error.code === "limit_exceeded");
});

test("commands from Pi are normalized, deduplicated, and bounded", () => {
  const { commands, omitted } = normalizeCommands([
    { name: "review", description: "Review [31m![0m", source: "extension", path: "/tmp/r.ts" },
    { name: "review", description: "dup" }, { name: "bad name" }, { name: "" }, "text", { name: "skill:x", source: "skill", location: "user", path: "relative/SKILL.md" },
    ...Array.from({ length: LIMITS.maxCommands + 5 }, (_, index) => ({ name: `c${index}`, source: "prompt", location: "nowhere" })),
  ]);
  assert.equal(commands.length, LIMITS.maxCommands);
  assert.equal(omitted, 7);
  assert.deepEqual(commands[0], { name: "review", description: "Review !", source: "extension", location: "", path: "/tmp/r.ts" });
  assert.deepEqual(commands[1], { name: "skill:x", description: "", source: "skill", location: "user", path: "" });
  assert.equal(commands[2].location, "");
});

// ---- state and sequences -------------------------------------------------------------------

test("state store keeps bounded drafts, recents, and tabs under XDG_STATE_HOME with private permissions", async (t) => {
  const home = await temporaryWorkspace(t);
  let clock = 1000;
  const store = createStateStore({ env: { XDG_STATE_HOME: home }, now: () => (clock += 1) });
  assert.equal(store.path, path.join(home, "qt-webui", "state.json"));
  assert.equal(store.getDraft("/w"), "");
  assert.equal(store.setDraft("/w", "hello"), "hello");
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal(store.getDraft("/w"), "hello");
  assert.equal(store.setDraft("/w", ""), "");
  assert.equal(store.getDraft("/w"), "");
  for (let index = 0; index < LIMITS.maxDrafts + 3; index += 1) store.setDraft(`/d${index}`, `draft ${index}`);
  const drafts = store.read().value.drafts;
  assert.equal(Object.keys(drafts).length, LIMITS.maxDrafts, "oldest drafts are evicted");
  assert.equal(drafts["/d0"], undefined);
  assert.equal(drafts[`/d${LIMITS.maxDrafts + 2}`].text, `draft ${LIMITS.maxDrafts + 2}`);
  assert.deepEqual(store.pushRecent("recentDirectories", "/a"), ["/a"]);
  assert.deepEqual(store.pushRecent("recentDirectories", "/b"), ["/b", "/a"]);
  assert.deepEqual(store.pushRecent("recentDirectories", "/a"), ["/a", "/b"]);
  assert.deepEqual(store.togglePinned("/a"), ["/a"]);
  assert.deepEqual(store.togglePinned("/a"), []);
  store.saveTabs([{ cwd: "/a", sessionFile: "/s.jsonl", name: "one" }, { cwd: "" }], 0);
  assert.deepEqual(store.read().value.tabs, [{ cwd: "/a", sessionFile: "/s.jsonl", name: "one" }]);
  await writeFile(store.path, JSON.stringify({ drafts: [], recentDirectories: "x", tabs: 3 }));
  const recovered = store.read();
  assert.deepEqual(recovered.value.drafts, {});
  assert.deepEqual(recovered.value.recentDirectories, []);
  await writeFile(store.path, `{"drafts":{},"pad":"${"x".repeat(LIMITS.maxStateFileBytes)}"}`);
  assert.match(store.read().problems[0], /exceeds/);
  assert.deepEqual(validateState(null).value.tabs, []);
});

test("temporary draft owners stay distinct, restore, migrate once, and expire on tab close", async (t) => {
  const home = await temporaryWorkspace(t);
  const store = createStateStore({ env: { XDG_STATE_HOME: home } });
  const a = "12886aa2-d379-45d6-921b-e760f139b002";
  const b = "12886aa2-d379-45d6-921b-e760f139b003";
  const keyA = temporaryDraftKey(a);
  const keyB = temporaryDraftKey(b);
  const tabs = [{ cwd: "/w", sessionFile: "", name: "A", draftId: a }, { cwd: "/w", sessionFile: "", name: "B", draftId: b }];
  store.saveTabs(tabs, 0);
  store.setDraft("/w", "legacy");
  store.setDraft(keyA, "A pending");
  store.adoptLegacyDraft("/w", keyA);
  assert.equal(store.getDraft(keyA), "A pending", "an existing temporary draft wins over the legacy key");
  assert.equal(store.getDraft("/w"), "legacy", "an occupied tab cannot consume the legacy draft");
  store.adoptLegacyDraft("/w", keyB);
  assert.equal(store.getDraft(keyB), "legacy", "the next empty tab adopts the legacy text");
  assert.equal(store.getDraft("/w"), "", "legacy workspace text goes to at most one tab");
  store.setDraft(keyB, "B pending");
  store.setDraft(keyA, "A pending");
  assert.deepEqual(store.read().value.tabs.map(tab => tab.draftId), [a, b], "owners survive state reload");
  assert.equal(store.getDraft(keyA), "A pending");
  assert.equal(store.getDraft(keyB), "B pending");
  store.setDraft("/saved.jsonl", "older file draft");
  store.moveDraft(keyA, "/saved.jsonl");
  assert.equal(store.getDraft(keyA), "");
  assert.equal(store.getDraft("/saved.jsonl"), "A pending", "the newly created file takes the tab's unsent text on collision");
  store.saveTabs([{ ...tabs[0], sessionFile: "/saved.jsonl" }], 0);
  assert.equal(store.getDraft(keyB), "", "closed tab's temporary draft is removed");
  assert.equal(store.getDraft("/saved.jsonl"), "A pending", "saved-file keys remain readable");
  assert.equal(store.setDraft("/saved.jsonl", ""), "", "an intentional clear removes the draft");
  const invalid = validateState({ tabs: [{ ...tabs[0], draftId: "bad" }, tabs[0], tabs[0]] }).value.tabs;
  assert.equal(invalid[0].draftId, undefined);
  assert.equal(invalid[1].draftId, a);
  assert.equal(invalid[2].draftId, undefined, "duplicate owners cannot be restored");
});

test("sequence store validates, bounds, orders, and removes sequences", async (t) => {
  const home = await temporaryWorkspace(t);
  const store = createSequenceStore({ env: { XDG_CONFIG_HOME: home }, now: () => 5 });
  assert.equal(store.path, path.join(home, "qt-webui", "sequences.json"));
  assert.deepEqual(store.list().sequences, []);
  const first = store.save({ name: "  Morning  ", entries: ["one", "two"] });
  assert.match(first.id, /^seq-[0-9a-f]{12}$/);
  assert.equal(first.name, "Morning");
  const second = store.save({ name: "Second", entries: ["x"] });
  assert.deepEqual(store.list().sequences.map((sequence) => sequence.id), [first.id, second.id]);
  const renamed = store.save({ id: first.id, name: "Renamed", entries: ["one"] });
  assert.deepEqual({ id: renamed.id, name: renamed.name, entries: renamed.entries }, { id: first.id, name: "Renamed", entries: ["one"] });
  assert.deepEqual(store.list().sequences.map((sequence) => sequence.id), [first.id, second.id], "editing keeps the position");
  assert.deepEqual(store.move(second.id, -1).map((sequence) => sequence.id), [second.id, first.id]);
  assert.deepEqual(store.move(second.id, -5).map((sequence) => sequence.id), [second.id, first.id], "moves clamp");
  assert.throws(() => store.save({ id: "seq-missing", name: "x", entries: ["y"] }), (error) => error.code === "stale_request");
  assert.equal(store.remove(second.id).id, second.id);
  assert.throws(() => store.remove(second.id), (error) => error.code === "stale_request");
  for (let index = store.list().sequences.length; index < LIMITS.maxSequences; index += 1) store.save({ name: `s${index}`, entries: ["e"] });
  assert.throws(() => store.save({ name: "over", entries: ["e"] }), (error) => error.code === "limit_exceeded");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await writeFile(store.path, JSON.stringify({ sequences: [{ id: "ok-1", name: "ok", entries: ["a", "", 3] }, { id: "bad id!", name: "x", entries: ["a"] }, { id: "ok-1", name: "dup", entries: ["b"] }, "junk"] }));
  const recovered = store.list();
  assert.deepEqual(recovered.sequences.map((sequence) => [sequence.id, sequence.entries]), [["ok-1", ["a"]]]);
  assert.equal(recovered.problems.length, 2);
  assert.deepEqual(validateSequences("nope").value.sequences, []);
});

// ---- attachments ---------------------------------------------------------------------------

test("attachments enforce workspace confinement, size, type, and exact-once consumption", async (t) => {
  const root = await temporaryWorkspace(t);
  const outside = await temporaryWorkspace(t);
  await writeFile(path.join(root, "notes.txt"), "hello <world>");
  await writeFile(path.join(root, "pic.png"), PNG);
  await writeFile(path.join(root, "fake.png"), "not an image");
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0x68, 0x00, 0x69]));
  await writeFile(path.join(root, "latin.txt"), Buffer.from([0xff, 0xfe, 0x41]));
  await writeFile(path.join(root, "big.txt"), "x".repeat(LIMITS.maxTextAttachmentBytes + 1));
  await writeFile(path.join(root, "exact.txt"), "x".repeat(LIMITS.maxTextAttachmentBytes));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await mkdir(path.join(root, "dir"));
  const store = createAttachmentStore({ workspaceRoot: root });

  const text = store.add({ path: path.join(root, "notes.txt") });
  assert.deepEqual({ name: text.name, kind: text.kind, mimeType: text.mimeType, size: text.size, text: text.text, edited: text.edited }, { name: "notes.txt", kind: "text", mimeType: "text/plain", size: 13, text: "hello <world>", edited: false });
  const image = store.add({ path: path.join(root, "pic.png") });
  assert.deepEqual({ kind: image.kind, mimeType: image.mimeType, text: image.text }, { kind: "image", mimeType: "image/png", text: "" });
  assert.throws(() => store.add({ path: path.join(root, "fake.png") }), /not a valid image\/png/);
  assert.throws(() => store.add({ path: path.join(root, "binary.txt") }), /binary files/);
  assert.throws(() => store.add({ path: path.join(root, "latin.txt") }), /valid UTF-8/);
  assert.throws(() => store.add({ path: path.join(root, "big.txt") }), (error) => error.code === "limit_exceeded");
  assert.equal(store.add({ path: path.join(root, "exact.txt") }).size, LIMITS.maxTextAttachmentBytes);
  assert.throws(() => store.add({ path: path.join(root, "missing.txt") }), /does not exist/);
  assert.throws(() => store.add({ path: path.join(root, "dir") }), /regular files/);
  assert.throws(() => store.add({ path: path.join(outside, "secret.txt") }), /outside the workspace/);
  assert.throws(() => store.add({ path: path.join(root, "link.txt") }), /outside the workspace/, "symlinks resolve before confinement");
  assert.throws(() => store.add({ path: path.join(root, "..", path.basename(outside), "secret.txt") }), /outside the workspace/);
  const granted = store.add({ path: path.join(outside, "secret.txt"), granted: true });
  assert.equal(granted.text, "secret");
  assert.equal(store.size, 4);
  for (let index = store.size; index < LIMITS.maxAttachments; index += 1) store.add({ path: path.join(root, "notes.txt") });
  assert.throws(() => store.add({ path: path.join(root, "notes.txt") }), (error) => error.code === "limit_exceeded");
  store.remove(granted.id);
  assert.throws(() => store.remove(granted.id), (error) => error.code === "stale_request");
  const edited = store.update(text.id, "edited text");
  assert.deepEqual({ text: edited.text, edited: edited.edited, size: edited.size }, { text: "edited text", edited: true, size: 11 });
  assert.throws(() => store.update(image.id, "x"), /Only text attachments/);
  const taken = store.take([text.id, image.id]);
  assert.deepEqual(taken.names, ["notes.txt", "pic.png"]);
  assert.deepEqual(taken.texts, [{ name: "notes.txt", text: "edited text" }]);
  assert.deepEqual(taken.images.map((entry) => [entry.type, entry.mimeType, entry.data.length > 0]), [["image", "image/png", true]]);
  assert.throws(() => store.take([text.id]), (error) => error.code === "stale_request", "consumed attachments cannot be sent twice");
  assert.equal(composeMessageWithTexts("Look", [{ name: "a.txt", text: "x\n````\ny" }]), "Look\n\nAttached file: a.txt\n`````\nx\n````\ny\n`````");
  assert.equal(composeMessageWithTexts("Look", []), "Look");
});

// ---- workspace -----------------------------------------------------------------------------

test("workspace confinement rejects traversal, absolute escapes, and symlinks out of the root", async (t) => {
  const root = await temporaryWorkspace(t);
  const outside = await temporaryWorkspace(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.txt"), "a");
  await symlink(outside, path.join(root, "escape"));
  assert.equal(confinePath(root, "src/a.txt"), path.join(await realpath(root), "src", "a.txt"));
  assert.equal(confinePath(root, "src/new.txt"), path.join(await realpath(root), "src", "new.txt"), "missing leaf is allowed");
  assert.equal(confinePath(root, "../x"), null);
  assert.equal(confinePath(root, "src/../../x"), null);
  assert.equal(confinePath(root, outside), null);
  assert.equal(confinePath(root, "escape"), null);
  assert.equal(confinePath(root, "escape/file"), null);
  assert.equal(confinePath(root, "a\0b"), null);
  assert.equal(confinePath(root, "x".repeat(LIMITS.maxPathCharacters + 1)), null);
  assert.equal(resolveInsideWorkspace(root, await realpath(root)), true);
  assert.equal(resolveInsideWorkspace(root, `${await realpath(root)}-sibling`), false);
});

async function realpath(target) {
  const { realpath: real } = await import("node:fs/promises");
  return real(target);
}

test("workspace index lists files without a repository, respects Git ignores with one, and ranks completions", async (t) => {
  const root = await temporaryWorkspace(t);
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "index.mjs"), "");
  await writeFile(path.join(root, "src", "deep", "util.mjs"), "");
  await writeFile(path.join(root, "README.md"), "");
  await writeFile(path.join(root, "node_modules", "pkg", "x.js"), "");
  const walked = createWorkspaceIndex({ root, now: () => 0 });
  const snapshot = await walked.snapshot();
  assert.equal(snapshot.source, "walk");
  assert.deepEqual(snapshot.files, ["README.md", "src/deep/util.mjs", "src/index.mjs"]);
  assert.deepEqual(snapshot.directories, ["src", "src/deep"]);
  const completion = await walked.complete("@util");
  assert.deepEqual(completion.suggestions, [{ path: "src/deep/util.mjs", directory: false }]);
  const everything = await walked.complete("");
  assert.equal(everything.total, 5);
  assert.deepEqual((await walked.complete("src")).suggestions.map((entry) => entry.path), ["src", "src/deep", "src/index.mjs", "src/deep/util.mjs"]);
  assert.deepEqual((await walked.complete("sdu")).suggestions.map((entry) => entry.path), ["src/deep/util.mjs"], "subsequence matches rank last but match");

  let calls = 0;
  const fakeGit = createWorkspaceIndex({
    root,
    now: () => 0,
    spawnImpl: (command, args, options) => {
      calls += 1;
      assert.equal(command, "git");
      assert.equal(options.shell, false);
      assert(args.includes("--exclude-standard"));
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("tracked.txt\0src/kept.mjs\0node_modules/ignored.js\0"));
        child.emit("close", 0);
      });
      return child;
    },
  });
  await mkdir(path.join(root, ".git"));
  const gitSnapshot = await fakeGit.snapshot();
  assert.equal(gitSnapshot.source, "git");
  assert.deepEqual(gitSnapshot.files, ["src/kept.mjs", "tracked.txt"], "node_modules entries and untracked-ignored files are dropped");
  await fakeGit.snapshot();
  assert.equal(calls, 1, "the index is cached inside the TTL");
  fakeGit.invalidate();
  await fakeGit.snapshot();
  assert.equal(calls, 2);
});


// ---- backend integration -------------------------------------------------------------------

async function readyBackend(t, options = {}) {
  const backend = await startBackend({ startupTimeoutMs: 1_000, ...options });
  t.after(async () => {
    if (backend.exit) return;
    backend.kill("SIGKILL");
    await backend.exitPromise;
  });
  await backend.waitForEvent("pi.status", (event) => event.statusKind === "ready");
  return backend;
}

test("backend keeps two unsaved same-workspace draft keys separate through restart and close", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const env = { XDG_STATE_HOME: path.join(cwd, ".state") };
  const backend = await readyBackend(t, { cwd, env });
  const first = (await backend.send("tabs_list")).data.tabs[0];
  const second = (await backend.send("tab_open", { cwd })).data.tab;
  const a = temporaryDraftKey(first.draftId);
  const b = temporaryDraftKey(second.draftId);
  assert.notEqual(a, b);
  assert.equal((await backend.send("draft_set", { key: a, text: "first" })).ok, true);
  assert.equal((await backend.send("draft_set", { key: b, text: "second" })).ok, true);
  assert.equal((await backend.send("draft_get", { key: a })).data.text, "first");
  assert.equal((await backend.send("draft_get", { key: b })).data.text, "second");
  await backend.send("shutdown");
  await backend.exitPromise;
  const restarted = await readyBackend(t, { cwd, env });
  const restored = (await restarted.send("tabs_list")).data.tabs;
  assert.deepEqual(restored.map(tab => tab.draftId), [first.draftId, second.draftId]);
  assert.equal((await restarted.send("draft_get", { key: a })).data.text, "first");
  assert.equal((await restarted.send("draft_get", { key: b })).data.text, "second");
  await restarted.waitForEvent("pi.status", event => event.tab === restored[1].id && event.ready === true);
  assert.equal((await restarted.send("session_new", { tab: restored[1].id })).ok, true);
  assert.equal((await restarted.send("draft_set", { key: b, text: "second flush" })).ok, true,
    "a retired owner can finish its in-flight replacement flush");
  assert.equal((await restarted.send("tab_close", { tab: restored[1].id })).ok, true);
  assert.equal((await restarted.send("draft_set", { key: b, text: "late save" })).error.code, "stale_request");
  assert.equal((await restarted.send("draft_get", { key: b })).data.text, "");
  assert.equal((await restarted.send("draft_get", { key: a })).data.text, "first");
});

test("backend serves commands, drafts, sequences, completion, and attachments over the protocol", async (t) => {
  const root = await temporaryWorkspace(t);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.mjs"), "export {}\n");
  await writeFile(path.join(root, "pic.png"), PNG);
  const backend = await readyBackend(t, { cwd: root, env: { XDG_STATE_HOME: path.join(root, ".state") } });

  const commands = await backend.send("commands_list");
  assert.deepEqual(commands.data.commands.map((command) => [command.name, command.source, command.description]), [
    ["review", "extension", "Review the current diff"], ["fix-tests", "prompt", "Fix failing tests !"], ["skill:brave-search", "skill", "Web search"],
  ]);

  assert.equal((await backend.send("draft_get", { key: root })).data.text, "");
  assert.equal((await backend.send("draft_set", { key: root, text: "unsent idea" })).data.text, "unsent idea");
  assert.equal((await backend.send("draft_get", { key: root })).data.text, "unsent idea");
  const stateFile = JSON.parse(await readFile(path.join(root, ".state", "qt-webui", "state.json"), "utf8"));
  assert.equal(stateFile.drafts[root].text, "unsent idea");

  const completion = await backend.send("path_complete", { query: "main" });
  assert.deepEqual(completion.data.suggestions, [{ path: "src/main.mjs", directory: false }]);

  const saved = await backend.send("sequence_save", { name: "Smoke", entries: ["__QT_WEBUI_IMMEDIATE__", "second step", "third step"] });
  assert.equal(saved.ok, true);
  const listed = await backend.send("sequences_list");
  assert.deepEqual(listed.data.sequences.map((sequence) => sequence.name), ["Smoke"]);
  const run = await backend.send("sequence_run", { sequenceId: saved.data.sequence.id });
  assert.deepEqual({ sent: run.data.sent, queued: run.data.queued }, { sent: 1, queued: 2 });
  const users = backend.events.filter((event) => event.type === "message.user");
  assert.deepEqual(users.map((event) => [event.text, event.mode]), [["__QT_WEBUI_IMMEDIATE__", "send"], ["second step", "followUp"], ["third step", "followUp"]]);
  const missing = await backend.send("sequence_run", { sequenceId: "seq-missing" });
  assert.equal(missing.error.code, "stale_request");
  assert.equal((await backend.send("sequence_delete", { sequenceId: saved.data.sequence.id })).data.sequences.length, 0);

  const outside = path.join(os.tmpdir(), `qt-webui-outside-${process.pid}.txt`);
  await writeFile(outside, "outside text");
  t.after(() => rm(outside, { force: true }));
  const refused = await backend.send("attachment_add", { path: outside });
  assert.equal(refused.error.code, "rejected");
  const grantedAdd = await backend.send("attachment_add", { path: outside, granted: true });
  assert.equal(grantedAdd.data.attachment.text, "outside text");
  const imageAdd = await backend.send("attachment_add", { path: path.join(root, "pic.png") });
  assert.equal(imageAdd.data.attachments.length, 2);
  const updated = await backend.send("attachment_update", { attachmentId: grantedAdd.data.attachment.id, text: "edited" });
  assert.equal(updated.data.attachment.edited, true);
  await backend.waitForEvent("pi.status", (event) => event.statusKind === "ready" && event.seq > backend.events.filter((entry) => entry.type === "message.user").at(-1).seq);
  const sent = await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__", attachments: [grantedAdd.data.attachment.id, imageAdd.data.attachment.id] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual(sent.consumedAttachmentIds, [grantedAdd.data.attachment.id, imageAdd.data.attachment.id]);
  const userWithAttachments = backend.events.filter((event) => event.type === "message.user").at(-1);
  assert.deepEqual(userWithAttachments.attachments, [path.basename(outside), "pic.png"]);
  assert.equal(userWithAttachments.text, "__QT_WEBUI_IMMEDIATE__", "the transcript shows the typed prompt, not the appended file text");
  await backend.waitForEvent("pi.status", (event) => event.statusKind === "ready" && event.active === false && event.seq > userWithAttachments.seq);
  const stale = await backend.send("prompt", { message: "again", attachments: [grantedAdd.data.attachment.id] });
  assert.equal(stale.error.code, "stale_request");
  assert.deepEqual(stale.consumedAttachmentIds, []);
  assert.equal((await backend.send("attachment_remove", { attachmentId: imageAdd.data.attachment.id })).error.code, "stale_request", "consumed attachments are gone");
  const captured = (await backend.readCapture()).filter((command) => command.type === "prompt");
  const withImages = captured.at(-1);
  const fence = "````";
  assert.equal(withImages.message, `__QT_WEBUI_IMMEDIATE__\n\nAttached file: ${path.basename(outside)}\n${fence}\nedited\n${fence}`);
  assert.deepEqual(withImages.images.map((image) => [image.type, image.mimeType]), [["image", "image/png"]]);
  assert.equal(captured.filter((command) => command.images).length, 1);
  const followUps = (await backend.readCapture()).filter((command) => command.type === "follow_up").map((command) => command.message);
  assert.deepEqual(followUps, ["second step", "third step"]);
});

test("prompt responses report only ids taken, even across a later add and tab switch", async (t) => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "A");
  await writeFile(path.join(cwd, "b.txt"), "B");
  const backend = await readyBackend(t, { cwd });
  const first = (await backend.send("tabs_list")).data.tabs[0].id;
  const a = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt"), tab: first })).data.attachment.id;
  const pending = backend.send("prompt", { message: "__QT_WEBUI_ACCEPT_DELAY__", attachments: [a], tab: first });
  await backend.waitForEvent("message.user", event => event.tab === first && event.text === "__QT_WEBUI_ACCEPT_DELAY__");
  const b = (await backend.send("attachment_add", { path: path.join(cwd, "b.txt"), tab: first })).data.attachment.id;
  const second = (await backend.send("tab_open", { cwd })).data.tab.id;
  const other = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt"), tab: second })).data.attachment.id;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumedAttachmentIds, [a]);
  assert.deepEqual((await backend.send("attachments_list", { tab: first })).data.attachments.map(item => item.id), [b]);
  assert.deepEqual((await backend.send("attachments_list", { tab: second })).data.attachments.map(item => item.id), [other]);
  const captured = (await backend.readCapture()).filter(command => command.type === "prompt");
  assert.equal(captured.length, 1);
  assert.match(captured[0].message, /Attached file: a.txt/);
  assert.doesNotMatch(captured[0].message, /Attached file: b.txt/);
});

test("rejection after take reports A; busy refusal reports no consumed ids and keeps B", async (t) => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "A");
  await writeFile(path.join(cwd, "b.txt"), "B");
  const backend = await readyBackend(t, { cwd });
  const a = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt") })).data.attachment.id;
  const b = (await backend.send("attachment_add", { path: path.join(cwd, "b.txt") })).data.attachment.id;
  const rejected = await backend.send("prompt", { message: "__QT_WEBUI_FAIL__", attachments: [a] });
  assert.equal(rejected.error.code, "pi_error");
  assert.deepEqual(rejected.consumedAttachmentIds, [a]);
  assert.deepEqual((await backend.send("attachments_list")).data.attachments.map(item => item.id), [b]);
  await backend.send("prompt", { message: "__QT_WEBUI_DELAYED_ABORT__" });
  const busy = await backend.send("prompt", { message: "second", attachments: [b] });
  assert.equal(busy.error.code, "busy");
  assert.deepEqual(busy.consumedAttachmentIds, []);
  assert.deepEqual((await backend.send("attachments_list")).data.attachments.map(item => item.id), [b]);
  assert.equal((await backend.readCapture()).filter(command => command.type === "prompt" && command.message.startsWith("second")).length, 0);
});

test("consumed id response field is optional, bounded, and unique", () => {
  assert.equal(Object.hasOwn(makeResponse("x", {}), "consumedAttachmentIds"), false);
  assert.deepEqual(makeErrorResponse("x", "busy", "wait", []).consumedAttachmentIds, []);
  assert.throws(() => makeResponse("x", {}, Array(9).fill("a")), /Too many consumed/);
  assert.throws(() => makeErrorResponse("x", "busy", "wait", ["a", "a"]), /duplicate/);
});

test("duplicate prompt attachment ids are rejected before take and never reach Pi", async t => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "A");
  const backend = await readyBackend(t, { cwd });
  const id = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt") })).data.attachment.id;
  const response = await backend.send("prompt", { message: "duplicate", attachments: [id, id] });
  assert.equal(response.error.code, "invalid_request");
  assert.deepEqual(response.consumedAttachmentIds, []);
  assert.deepEqual((await backend.send("attachments_list")).data.attachments.map(item => item.id), [id]);
  assert.equal((await backend.readCapture()).filter(command => command.type === "prompt").length, 0);
});

test("timed-out preflight has unknown consumption, then emits one final scoped outcome", async t => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "A");
  const backend = await readyBackend(t, { cwd, env: {
    QT_WEBUI_SMOKE_PROMPT_PREFLIGHT_DELAY_MS: "250",
    QT_WEBUI_SMOKE_PROMPT_TIMEOUT_MS: "80",
  } });
  const tab = (await backend.send("tabs_list")).data.tabs[0].id;
  const id = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt") })).data.attachment.id;
  const timedOut = await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__", attachments: [id], tab }, { id: "delayed-preflight" });
  assert.equal(timedOut.error.code, "timeout");
  assert.equal(Object.hasOwn(timedOut, "consumedAttachmentIds"), false, "the handler has not yet reached take");
  const { context: view, frames } = await bridgeHarness();
  view.activeTabId = tab;
  view.tabs = [{ id: tab, draftId: "draft-origin" }];
  view.attachments = [{ id }];
  view.sendPrompt("__QT_WEBUI_IMMEDIATE__", "send");
  view.settlePending(frames[0].id, timedOut);
  assert.deepEqual(view.attachments.map(item => item.id), [id], "unknown consumption must not clear the view");
  assert.deepEqual((await backend.send("attachments_list", { tab })).data.attachments.map(item => item.id), [id]);
  const final = await backend.waitForEvent("prompt.settled", event => event.requestId === "delayed-preflight", 5_000);
  assert.equal(final.tab, tab);
  assert.equal(final.ok, true);
  assert.deepEqual(final.consumedAttachmentIds, [id]);
  view.settleTimedOutPrompt({ ...final, requestId: frames[0].id });
  assert.deepEqual(view.attachments, [], "the final confirmed outcome reconciles the view");
  assert.equal(view.attachmentLocked(id), false);
  assert.equal(backend.events.filter(event => event.type === "prompt.settled" && event.requestId === "delayed-preflight").length, 1);
  assert.deepEqual((await backend.send("attachments_list", { tab })).data.attachments, []);
  assert.equal((await backend.readCapture()).filter(command => command.type === "prompt").length, 1);
});

test("prompt settlement event validates its bounded tab, request id, outcome and ids", () => {
  const input = { requestId: "q-1", tab: "tab-1", ok: true, consumedAttachmentIds: ["att-a"] };
  assert.deepEqual(validatePromptSettlement(input), input);
  assert.throws(() => validatePromptSettlement({ ...input, consumedAttachmentIds: ["att-a", "att-a"] }), /duplicate/);
  assert.throws(() => validatePromptSettlement({ ...input, tab: "x".repeat(LIMITS.maxTabIdCharacters + 1) }), /bounded tab/);
  assert.throws(() => validatePromptSettlement({ ...input, ok: false, errorCode: "x".repeat(LIMITS.maxPromptErrorCodeCharacters + 1) }), /bounded error code/);
});

test("late Pi rejection reports consumed ids in one scoped settlement event", async t => {
  const cwd = await temporaryWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "A");
  const backend = await readyBackend(t, { cwd, env: { QT_WEBUI_SMOKE_PROMPT_TIMEOUT_MS: "80" } });
  const tab = (await backend.send("tabs_list")).data.tabs[0].id;
  const id = (await backend.send("attachment_add", { path: path.join(cwd, "a.txt") })).data.attachment.id;
  const timedOut = await backend.send("prompt", { message: "__QT_WEBUI_FAIL_DELAY__", attachments: [id], tab }, { id: "late-reject" });
  assert.equal(timedOut.error.code, "timeout");
  assert.deepEqual(timedOut.consumedAttachmentIds, [id], "take already completed before timeout");
  const final = await backend.waitForEvent("prompt.settled", event => event.requestId === "late-reject", 5_000);
  assert.equal(final.tab, tab);
  assert.equal(final.ok, false);
  assert.equal(final.errorCode, "pi_error");
  assert.deepEqual(final.consumedAttachmentIds, [id]);
  assert.equal(backend.events.filter(event => event.type === "prompt.settled" && event.requestId === "late-reject").length, 1);
  assert.deepEqual((await backend.send("attachments_list", { tab })).data.attachments, []);
});
