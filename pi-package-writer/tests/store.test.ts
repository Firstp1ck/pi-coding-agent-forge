import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { activeProject, createProject, createUnit, importSource, inventory, listProjects, loadProject, projectId, safePath, selectProject, slug, status, targetFile } from "../src/store.ts";

async function workspace(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-writer-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("creates a portable project and restores it from disk without session memory", async (t) => {
  const cwd = await workspace(t);
  const project = await createProject(cwd, { title: "Ash & Snow", format: "light-novel", style: "emotional, epic", language: "Deutsch", genre: "fantasy", brief: "A broken promise." });
  assert.equal(project.book.id, "ash-snow");
  assert.equal(await activeProject(cwd), undefined);
  await selectProject(cwd, project.book.id);
  assert.deepEqual(await activeProject(cwd), project);
  assert.match(await readFile(join(project.root, "style.md"), "utf8"), /emotional, epic/);
  assert.match(await readFile(join(project.root, "brief.md"), "utf8"), /Deutsch/);
  assert.match(await readFile(join(project.root, "progress.md"), "utf8"), /No manuscript/);
  assert.equal((await listProjects(cwd)).projects.length, 1);
});

test("beginner projects save guidance, a learning notebook, and a small next step", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "My first story", guidance: "beginner" });
  assert.equal(p.book.guidance, "beginner");
  assert.equal((await loadProject(cwd, p.book.id)).book.guidance, "beginner");
  assert.match(await readFile(join(p.root, "learning.md"), "utf8"), /No exercises completed yet/);
  assert.match(await readFile(join(p.root, "progress.md"), "utf8"), /one small first exercise/);
  assert.match(await readFile(join(p.root, "brief.md"), "utf8"), /do not need a whole-book plan/);
  assert.match(await status(cwd, p), /Guidance: beginner/);
});

test("standard and legacy projects do not require learning notes or migrate silently", async (t) => {
  const cwd = await workspace(t);
  const legacy = await createProject(cwd, { title: "Legacy" });
  const original = await readFile(join(legacy.root, "writer.json"), "utf8");
  assert.equal((await loadProject(cwd, "legacy")).book.guidance, undefined);
  await assert.rejects(readFile(join(legacy.root, "learning.md")), { code: "ENOENT" });
  assert.equal(await readFile(join(legacy.root, "writer.json"), "utf8"), original);
  const standard = await createProject(cwd, { title: "Standard", guidance: "standard" });
  assert.equal((await loadProject(cwd, "standard")).book.guidance, "standard");
  await assert.rejects(readFile(join(standard.root, "learning.md")), { code: "ENOENT" });
});

test("invalid guidance fails before creation and invalid saved guidance is rejected", async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(createProject(cwd, { title: "Invalid", guidance: "expert" }), /Guidance/);
  assert.equal((await listProjects(cwd)).projects.length, 0);
  const p = await createProject(cwd, { title: "Valid" });
  for (const value of ["expert", null, true, {}]) {
    await writeFile(join(p.root, "writer.json"), JSON.stringify({ ...p.book, guidance: value }));
    await assert.rejects(loadProject(cwd, "valid"), /Guidance/);
  }
});

test("learning notebooks have the same link protection as other project notes", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Learning", guidance: "beginner" });
  await link(join(p.root, "learning.md"), join(cwd, "linked-learning.md"));
  await assert.rejects(loadProject(cwd, "learning"), /multiply linked/);
});

test("collisions and invalid options do not overwrite or partially create projects", async (t) => {
  const cwd = await workspace(t);
  const project = await createProject(cwd, { title: "Ash" });
  await writeFile(join(project.root, "outline.md"), "Keep this draft");
  await assert.rejects(createProject(cwd, { title: "Ash" }), /already exists/);
  await assert.rejects(createProject(cwd, { title: "Other", style: "x".repeat(241) }), /Style/);
  assert.equal(await readFile(join(project.root, "outline.md"), "utf8"), "Keep this draft");
  assert.equal((await listProjects(cwd)).projects.length, 1);
});

test("reserves numbered units without treating them as drafts", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  const first = await createUnit(cwd, p, "chapter", "Opening", "End on a difficult decision.");
  assert.match(await readFile(join(p.root, first), "utf8"), /End on a difficult decision/);
  await writeFile(join(p.root, first), "# Completed chapter\nDo not replace.");
  const second = await createUnit(cwd, p, "chapter");
  assert.equal(first, "chapters/chapter-0001.md");
  assert.equal(second, "chapters/chapter-0002.md");
  assert.match(await readFile(join(p.root, first), "utf8"), /Do not replace/);
  assert.match(await readFile(join(p.root, second), "utf8"), /writer:planned/);
  assert.equal(await createUnit(cwd, p, "scene"), "scenes/scene-0001.md");
  assert.equal(await createUnit(cwd, p, "volume"), "volumes/volume-0001.md");
  assert.equal((await inventory(cwd, p)).length, 4);
  assert.match(await status(cwd, p), /not a completion count/);
});

test("concurrent reservations use exclusive creation", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  const files = await Promise.all(Array.from({ length: 8 }, () => createUnit(cwd, p, "chapter")));
  assert.equal(new Set(files).size, 8);
  assert.equal((await inventory(cwd, p)).length, 8);
});

test("rejects traversal, absolute targets, Windows aliases, and invalid IDs", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  for (const id of ["..", "A", "a/b", "a\\b", "con", "nul", "lpt1", "x".repeat(65)]) assert.throws(() => projectId(id));
  for (const target of ["../outside.md", "chapters/../../outside.md", "C:\\outside.md", "/outside.md", "chapters//a.md", "chapters/.. /outside.md", "CON.md", "brief.md:stream", "writer.json"]) {
    await assert.rejects(targetFile(cwd, p, target), undefined, target);
  }
  assert.equal(await targetFile(cwd, p, "brief.md"), "brief.md");
  assert.equal(slug("Über dem Meer"), "uber-dem-meer");
  assert.match(slug("星の手紙"), /^book-[a-f0-9]{8}$/);
});

test("reports corrupt, future-version, mismatched, and oversized manifests without migration", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  const file = join(p.root, "writer.json");
  for (const content of ["{", JSON.stringify({ ...p.book, version: 2 }), JSON.stringify({ ...p.book, id: "elsewhere" }), "x".repeat(16385)]) {
    await writeFile(file, content);
    await assert.rejects(loadProject(cwd, "ash"));
    const list = await listProjects(cwd);
    assert.equal(list.projects.length, 0);
    assert.equal(list.warnings.length, 1);
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("explicit open recovers a corrupt active selection but never silently chooses another book", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  await writeFile(join(cwd, "writing", ".active.json"), "broken");
  await assert.rejects(activeProject(cwd), /Invalid/);
  await selectProject(cwd, p.book.id);
  assert.equal((await activeProject(cwd))?.book.id, "ash");
  await writeFile(join(cwd, "writing", ".active.json"), JSON.stringify({ version: 1, id: "missing" }));
  await assert.rejects(activeProject(cwd), /Cannot open/);
});

test("directory junctions cannot redirect project storage or unit writes", async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await symlink(outside, join(cwd, "writing"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createProject(cwd, { title: "Ash" }), /symlinks or junctions/);
  await assert.rejects(listProjects(cwd), /symlinks or junctions/);
  await rm(join(cwd, "writing"));
  const p = await createProject(cwd, { title: "Ash" });
  await rm(join(p.root, "chapters"), { recursive: true });
  await symlink(outside, join(p.root, "chapters"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createUnit(cwd, p, "chapter"), /symlinks or junctions/);
});

test("hard-linked control and project files are rejected", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  await link(join(p.root, "style.md"), join(cwd, "linked-style.md"));
  await assert.rejects(loadProject(cwd, "ash"), /multiply linked/);
});

test("imports only explicitly named text files without copying or modifying them", async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, "old draft.md");
  await writeFile(source, "Private manuscript.");
  assert.equal(await importSource(cwd, "old draft.md"), source);
  assert.equal(await readFile(source, "utf8"), "Private manuscript.");
  await assert.rejects(importSource(cwd, "old.pdf"), /Markdown and plain text/);
  await assert.rejects(importSource(cwd, "missing.md"));
});

test("oversized checkpoint reports an explicit limit instead of loading unlimited context", async (t) => {
  const cwd = await workspace(t);
  const p = await createProject(cwd, { title: "Ash" });
  await writeFile(join(p.root, "progress.md"), "x".repeat(16385));
  assert.match(await status(cwd, p), /Checkpoint unavailable.*16384/);
  await assert.rejects(safePath(cwd, ["writing", "..", "oops"]));
});

test("missing and incomplete workspaces are reported without silent replacement", async (t) => {
  const cwd = await workspace(t);
  assert.deepEqual(await listProjects(cwd), { projects: [], warnings: [] });
  await mkdir(join(cwd, "writing", "partial"), { recursive: true });
  const list = await listProjects(cwd);
  assert.equal(list.warnings.length, 1);
  await assert.rejects(createProject(cwd, { title: "Partial" }), /already exists/);
});
