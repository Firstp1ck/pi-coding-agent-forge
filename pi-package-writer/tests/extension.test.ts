import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import writerExtension from "../index.ts";
import { createProject, createUnit, selectProject } from "../src/store.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

async function harness(t: TestContext, cwd?: string) {
  if (!cwd) {
    cwd = await mkdtemp(join(tmpdir(), "pi-writer-command-"));
    const path = cwd;
    t.after(() => rm(path, { recursive: true, force: true }));
  }
  let handler: Handler | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let completions: ((prefix: string) => unknown) | undefined;
  const messages: string[] = [], notices: string[] = [], replies: Array<string | boolean | undefined> = [];
  let idle = true, trusted = true;
  let tools = ["read", "write", "edit"];
  const pi = {
    on: (_name: string, callback: () => Promise<void>) => { shutdown = callback; },
    registerCommand(name: string, options: { handler: Handler; getArgumentCompletions: typeof completions }) {
      assert.equal(name, "writer"); handler = options.handler; completions = options.getArgumentCompletions;
    },
    getActiveTools: () => tools,
    sendUserMessage: (message: string) => { messages.push(message); },
    sendMessage: ({ content }: { content: string }) => { notices.push(content); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, hasUI: true, model: { id: "test-model" },
    isIdle: () => idle, isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async () => replies.shift(), input: async () => replies.shift(), confirm: async () => replies.shift() ?? false,
    },
  } as unknown as ExtensionCommandContext;
  writerExtension(pi);
  return { cwd, ctx, messages, notices, replies, run: async (args: string) => handler!(args, ctx), shutdown: async () => shutdown!(),
    complete: (value: string) => completions!(value), setIdle: (value: boolean) => { idle = value; },
    setTrusted: (value: boolean) => { trusted = value; }, setTools: (value: string[]) => { tools = value; } };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else result[name] = await readFile(join(path, entry.name), "utf8");
    }
  }
  await visit(root, "");
  return result;
}

test("new book plans first, then a new extension instance resumes the saved project", async (t) => {
  const h = await harness(t);
  await h.run('new book "Ash & Snow" --format light-novel --style "emotional, epic"');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /stop for author approval/i);
  assert.match(h.messages[0], /writer-light-novel/);
  const restarted = await harness(t, h.cwd);
  await restarted.run("continue");
  assert.equal(restarted.messages.length, 1);
  assert.match(restarted.messages[0], /Resume the saved project, not just this chat/);
  assert.match(restarted.messages[0], /ash-snow/);
  await restarted.run('new chapter "The Gate" --project ash-snow');
  assert.equal(restarted.messages.length, 2);
  assert.match(restarted.messages[1], /chapter-0001\.md/);
  assert.match(await readFile(join(h.cwd, "writing", "ash-snow", "chapters", "chapter-0001.md"), "utf8"), /writer:planned/);
});

test("beginner menu accepts an empty title and idea without asking advanced questions", async (t) => {
  const h = await harness(t);
  h.replies.push("Help me begin a story", "", "", "Not sure yet, try prose", true);
  await h.run("");
  assert.equal(h.replies.length, 0);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-beginner/);
  assert.match(h.messages[0], /ask at most one plain-language question/);
  const root = join(h.cwd, "writing", "my-first-story");
  assert.equal(JSON.parse(await readFile(join(root, "writer.json"), "utf8")).guidance, "beginner");
  assert.match(await readFile(join(root, "learning.md"), "utf8"), /No exercises completed/);
  assert.deepEqual(await readdir(join(root, "chapters")), []);
  assert.ok(h.complete("start"));
  assert.ok(h.complete("coa"));
});

test("beginner guidance survives restart and can be skipped for one task", async (t) => {
  const h = await harness(t);
  await h.run('start "Harbor" --brief "A child finds a stranded whale" --format light-novel --language Deutsch');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-beginner/);
  assert.match(h.messages[0], /writer-light-novel/);
  assert.doesNotMatch(h.messages[0], /writer-outline/);
  const root = join(h.cwd, "writing", "harbor");
  assert.match(await readFile(join(root, "brief.md"), "utf8"), /Deutsch/);
  await writeFile(join(root, "learning.md"), "# Current exercise\nChoose what she wants to do before the tide rises.\n");
  const before = await snapshot(h.cwd);
  const resumed = await harness(t, h.cwd);
  await resumed.run("continue");
  assert.match(resumed.messages[0], /writer-beginner/);
  assert.match(resumed.messages[0], /continue the recorded exercise/);
  assert.deepEqual(await snapshot(h.cwd), before);
  await resumed.run("continue --guidance standard");
  assert.doesNotMatch(resumed.messages[1], /writer-beginner/);
  assert.match(resumed.messages[1], /Standard guidance for this task/);
  assert.deepEqual(await snapshot(h.cwd), before);
  await resumed.run("new chapter");
  assert.match(resumed.messages[2], /writer-beginner/);
  assert.match(resumed.messages[2], /must not block a requested chapter/);
});

test("coach supports existing projects without changing their default or creating notes itself", async (t) => {
  const h = await harness(t);
  await createProject(h.cwd, { title: "Existing" });
  await h.run("open existing");
  const before = await snapshot(h.cwd);
  await h.run('coach --project existing --brief "Help me make the opening clearer"');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-beginner/);
  assert.match(h.messages[0], /do not restart the book/);
  assert.match(h.messages[0], /missing learning notes are normal/);
  assert.deepEqual(await snapshot(h.cwd), before);
  await h.run("continue");
  assert.doesNotMatch(h.messages[1], /writer-beginner/);
  await h.run("continue --guidance beginner");
  assert.match(h.messages[2], /writer-beginner/);
});

test("coaching review stays read-only even for a beginner project", async (t) => {
  const h = await harness(t);
  await h.run('start "Review practice"');
  const before = await snapshot(h.cwd);
  h.setTools(["read"]);
  await h.run("review");
  assert.match(h.messages[1], /writer-beginner/);
  assert.match(h.messages[1], /This task is read-only/);
  assert.doesNotMatch(h.messages[1], /Save brief learning notes/);
  assert.deepEqual(await snapshot(h.cwd), before);
});

test("each beginner dialog can be cancelled without creating a project", async (t) => {
  const h = await harness(t);
  for (const replies of [[undefined], ["Working", undefined], ["Working", "A seed", undefined], ["Working", "A seed", "Novel / Roman", false]]) {
    h.replies.push(...replies);
    await h.run("start");
    assert.equal(h.replies.length, 0);
    assert.deepEqual(await readdir(h.cwd), []);
    assert.equal(h.messages.length, 0);
  }
});

test("beginner inputs are bounded and starting twice never overwrites the project", async (t) => {
  const h = await harness(t);
  h.replies.push("Working", "x".repeat(4001), "Novel / Roman");
  await h.run("start");
  assert.match(h.notices.at(-1)!, /4000/);
  assert.deepEqual(await readdir(h.cwd), []);
  await h.run('start "Working"');
  const before = await snapshot(h.cwd);
  await h.run('start "Working"');
  assert.match(h.notices.at(-1)!, /already exists/);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(await snapshot(h.cwd), before);
});

test("beginner start supports explicit headless requests and explains missing titles", async (t) => {
  const h = await harness(t);
  h.ctx.hasUI = false;
  await h.run("start");
  assert.match(h.notices.at(-1)!, /Working title/);
  assert.deepEqual(await readdir(h.cwd), []);
  await h.run('start "First attempt"');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-beginner/);
});

test("normal book wizard preserves an explicit beginner preference", async (t) => {
  const h = await harness(t);
  h.replies.push("First", "novel", "", "", "", "", true);
  await h.run("new book --guidance beginner");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-beginner/);
  assert.doesNotMatch(h.messages[0], /writer-outline/);
});

test("beginner confirmation rechecks busy state and session lifetime before writes", async (t) => {
  const h = await harness(t);
  h.replies.push("First", "A seed", "Novel / Roman");
  h.ctx.ui.confirm = async () => { h.setIdle(false); return true; };
  await h.run("start");
  assert.deepEqual(await readdir(h.cwd), []);
  h.setIdle(true);
  h.replies.push("First", "A seed", "Novel / Roman");
  h.ctx.ui.confirm = async () => { await h.shutdown(); return true; };
  await h.run("start");
  assert.deepEqual(await readdir(h.cwd), []);
  assert.equal(h.messages.length, 0);
});

test("canceling the menu or book wizard leaves no files and sends no prompt", async (t) => {
  const h = await harness(t);
  await h.run("");
  assert.deepEqual(await readdir(h.cwd), []);
  h.replies.push("New book", "Ash", "novel", "epic", "fantasy", "English", "A lost crown", false);
  await h.run("");
  assert.deepEqual(await readdir(h.cwd), []);
  assert.deepEqual(h.messages, []);
  h.replies.push("New book", "Ash", undefined);
  await h.run("");
  assert.deepEqual(await readdir(h.cwd), []);
});

test("dialog task inputs obey the same limits as explicit arguments", async (t) => {
  const h = await harness(t);
  h.replies.push("Outline", "x".repeat(4001));
  await h.run("");
  assert.match(h.notices.at(-1)!, /4000/);
  assert.deepEqual(await readdir(h.cwd), []);
  assert.equal(h.messages.length, 0);
});

test("guided book workflow captures format, genre, language, and voice", async (t) => {
  const h = await harness(t);
  h.replies.push("New book", "Ash", "manga", "emotional", "fantasy", "Deutsch", "A lost crown", true);
  await h.run("");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /writer-manga/);
  assert.match(await readFile(join(h.cwd, "writing", "ash", "brief.md"), "utf8"), /Deutsch/);
});

test("busy and untrusted workspaces fail before writes; help still works", async (t) => {
  const h = await harness(t);
  h.setIdle(false);
  await h.run('new book "Ash"');
  assert.match(h.notices.at(-1)!, /busy/);
  h.setIdle(true); h.setTrusted(false);
  await h.run('new book "Ash"');
  assert.match(h.notices.at(-1)!, /Trust/);
  await h.run("help");
  assert.match(h.notices.at(-1)!, /Writer workflows/);
  assert.deepEqual(await readdir(h.cwd), []);
  assert.equal(h.messages.length, 0);
});

test("missing model or tools does not reserve work or change tool configuration", async (t) => {
  const h = await harness(t);
  h.setTools(["read"]);
  await h.run('new book "Ash"');
  assert.match(h.notices.at(-1)!, /write and edit/);
  h.setTools(["write", "edit"]);
  await h.run('new book "Ash"');
  assert.match(h.notices.at(-1)!, /read tool/);
  h.setTools(["read", "write", "edit"]);
  h.ctx.model = undefined;
  await h.run('new book "Ash"');
  assert.match(h.notices.at(-1)!, /model/);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("review keeps every file unchanged, including the active selection and checkpoint", async (t) => {
  const h = await harness(t);
  const p = await createProject(h.cwd, { title: "Ash" });
  const other = await createProject(h.cwd, { title: "Snow" });
  await selectProject(h.cwd, other.book.id);
  await createUnit(h.cwd, p, "chapter");
  const before = await snapshot(h.cwd);
  h.setTools(["read"]);
  await h.run('review --project ash --target "chapters/chapter-0001.md"');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /This task is read-only/);
  assert.match(h.messages[0], /including progress\.md/);
  assert.deepEqual(await snapshot(h.cwd), before);
});

test("open, list, and status do not trigger the model", async (t) => {
  const h = await harness(t);
  await createProject(h.cwd, { title: "Ash" });
  await h.run("list");
  await h.run("open ash");
  await h.run("status");
  assert.equal(h.messages.length, 0);
  assert.match(h.notices.join("\n"), /No manuscript has been drafted/);
  assert.match(h.notices.join("\n"), /Selected Ash/);
  assert.ok(h.complete("new c"));
});

test("invalid targets and missing import sources do not dispatch or reserve work", async (t) => {
  const h = await harness(t);
  await createProject(h.cwd, { title: "Ash" });
  await h.run("open ash");
  const before = await snapshot(h.cwd);
  await h.run("revise --target ../outside.md");
  await h.run("import");
  await h.run("import --source missing.md");
  assert.equal(h.messages.length, 0);
  assert.deepEqual(await snapshot(h.cwd), before);
});

test("adapt and import select the right skills and preserve original files", async (t) => {
  const h = await harness(t);
  const p = await createProject(h.cwd, { title: "Ash" });
  await selectProject(h.cwd, p.book.id);
  const chapter = await createUnit(h.cwd, p, "chapter");
  await h.run(`adapt --target ${chapter} --format webtoon --brief "One episode"`);
  assert.match(h.messages[0], /writer-adaptation/);
  assert.match(h.messages[0], /writer-manga/);
  assert.match(h.messages[0], /No image generation/);
  const source = join(h.cwd, "existing draft.md");
  await writeFile(source, "The old manuscript.");
  await h.run('import --source "existing draft.md"');
  assert.match(h.messages[1], /writer-import/);
  assert.equal(await readFile(source, "utf8"), "The old manuscript.");
});

test("headless explicit commands work, while menus report help without a model call", async (t) => {
  const h = await harness(t);
  h.ctx.hasUI = false;
  await h.run("");
  assert.match(h.notices[0], /Writer workflows/);
  await h.run('new book "Ash" --format novel');
  assert.equal(h.messages.length, 1);
  await h.run("status ash");
  assert.match(h.notices.at(-1)!, /Writing checkpoint/);
});

test("closed sessions cannot create work from stale dialog callbacks", async (t) => {
  const h = await harness(t);
  h.replies.push("New book", "Ash", "novel", "epic", "fantasy", "English", "A lost crown");
  h.ctx.ui.confirm = async () => { await h.shutdown(); return true; };
  await h.run("");
  assert.deepEqual(await readdir(h.cwd), []);
  assert.equal(h.messages.length, 0);
});

test("reentrant commands cannot start a second workflow while a dialog is open", async (t) => {
  const h = await harness(t);
  h.ctx.ui.select = async () => {
    await h.run('new book "Nested"');
    return undefined;
  };
  await h.run("");
  assert.match(h.notices.at(-1)!, /already active/);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("busy state after a dialog cancels before project creation", async (t) => {
  const h = await harness(t);
  h.replies.push("New book", "Ash", "novel", "epic", "fantasy", "English", "A lost crown");
  h.ctx.ui.confirm = async () => { h.setIdle(false); return true; };
  await h.run("");
  assert.deepEqual(await readdir(h.cwd), []);
  assert.equal(h.messages.length, 0);
});
