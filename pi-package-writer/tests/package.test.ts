import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SKILLS, skillsFor, buildPrompt, guidanceFor } from "../src/workflow.ts";
import { FORMATS, TASKS, type Request } from "../src/command.ts";
import type { Project } from "../src/store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const project: Project = { root: "/workspace/writing/example", book: { version: 1, id: "example", title: "Example", format: "novel", createdAt: "2026-01-01T00:00:00.000Z" } };

async function markdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

test("package declares the complete self-contained skill suite and extension", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "@firstpick/pi-package-writer");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.equal(pkg.dependencies, undefined);
  for (const name of ["src", "skills", "references", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]) {
    assert.ok(pkg.files.includes(name));
    await stat(join(ROOT, name));
  }
  assert.deepEqual((await readdir(join(ROOT, "skills"))).sort(), [...SKILLS].sort());
});

test("skills follow the portable profile and include specific workflows and verification", async () => {
  for (const name of SKILLS) {
    const content = await readFile(join(ROOT, "skills", name, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`^---\nname: ${name}\n`));
    const description = content.match(/^description: (.+)$/m)?.[1];
    assert.ok(description && description.length <= 1024, name);
    assert.match(content, /^license: MIT$/m);
    for (const heading of ["When to use", "Inputs and assumptions", "Portable workflow", "Safety and side effects", "Scripts, references, and dependencies", "Verification", "Pi adapter"]) {
      assert.ok(content.includes(`## ${heading}\n`), `${name}: ${heading}`);
    }
    const core = content.split("## Pi adapter")[0];
    // Sibling skill links such as ../writer-beginner/SKILL.md are portable.
    assert.doesNotMatch(core, /\/writer(?=$|[\s`])|\/skill:|~\/\.pi/m, name);
  }
});

test("all workflow routes use existing skills and keep prompts bounded", () => {
  for (const medium of FORMATS) {
    const p = { ...project, book: { ...project.book, format: medium } };
    for (const action of TASKS) {
      const request: Request = { action, options: {} };
      for (const name of skillsFor(request, p)) assert.ok((SKILLS as readonly string[]).includes(name));
      const prompt = buildPrompt(request, p, Array.from({ length: 1000 }, (_, i) => `chapters/chapter-${String(i).padStart(4, "0")}.md`));
      assert.ok(prompt.length < 12000);
      assert.match(prompt, /only the relevant/);
      assert.match(prompt, /story data/);
      assert.match(prompt, /"totalUnitFiles": 1000/);
      assert.doesNotMatch(prompt, /chapter-0000\.md/);
    }
  }
});

test("guidance routing is opt-in, persisted, and overridable without changing story format", () => {
  const guided: Project = { ...project, book: { ...project.book, guidance: "beginner" } };
  assert.equal(guidanceFor({ action: "continue", options: {} }, project), "standard");
  assert.equal(guidanceFor({ action: "continue", options: {} }, guided), "beginner");
  assert.equal(guidanceFor({ action: "continue", options: { guidance: "standard" } }, guided), "standard");
  for (const medium of FORMATS) {
    const p = { ...guided, book: { ...guided.book, format: medium } };
    for (const action of ["start", "coach", "continue", "review", "new"] as const) {
      const request: Request = { action, ...(action === "new" ? { unit: "book" as const } : {}), options: {} };
      assert.ok(skillsFor(request, p).includes("writer-beginner"));
      const prompt = buildPrompt(request, p, []);
      assert.match(prompt, /Teach one concept at a time/);
      assert.match(prompt, /Never complete their exercise for them unless asked/);
      assert.match(prompt, /learning\.md/);
      assert.match(prompt, new RegExp(`"format": "${medium}"`));
      if (action === "review") assert.doesNotMatch(prompt, /Save brief learning notes/);
      if (medium === "manga" || medium === "webtoon") assert.ok(skillsFor(request, p).includes("writer-manga"));
    }
  }
});

test("local Markdown links resolve and fenced blocks are balanced", async () => {
  for (const file of await markdownFiles(ROOT)) {
    const content = await readFile(file, "utf8");
    const fences = content.match(/^```/gm) ?? [];
    assert.equal(fences.length % 2, 0, `Unbalanced fence in ${file}`);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].split("#")[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      await stat(resolve(dirname(file), decodeURIComponent(link)));
    }
  }
});
