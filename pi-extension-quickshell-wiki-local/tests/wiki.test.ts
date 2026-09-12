import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import extension, { CONFIG, createWiki, parseGuide, parseSetupArgs } from "../index.ts";

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickshell-wiki-test-"));
  temporary.push(root);
  await fs.writeFile(path.join(root, "versions.json"), JSON.stringify({ default: "v0.3.0", versions: [{ name: "master" }, { name: "v0.3.0" }, { name: "v0.2.0" }, { name: "v0.1.0" }] }));
  await page(root, "v0_1_0", "index.md", "Usage Guide", "[Language](@docs/guide/qml-language#bindings)\n[Types](@docs/types/Quickshell/PanelWindow)");
  await page(root, "v0_1_0", "qml-language.md", "QML Language", "old syntax");
  await page(root, "v0_2_0", "qml-language.mdx", "QML Language", "new syntax\n## Bindings\nReactive bindings work.\n## Binding loops\nchildrenRect loops.");
  await page(root, "v0_3_0", "advanced.md", "Advanced Options", "## Environment\nDefaultEnv applies to the instance.");
  return root;
}
async function page(root: string, version: string, name: string, title: string, body: string) {
  const dir = path.join(root, "src", "guide", version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), `---\ntitle: "${title}"\nindex: 1\n---\n${body}\n`);
}

test("frontmatter title and pre-heading introduction survive", () => {
  const page = parseGuide('---\ntitle: "Installation & Setup"\n---\nWarning first.\n## Arch\nPackages here.', "/docs/install.md");
  assert.equal(page.title, "Installation & Setup");
  assert.equal(page.sections[0].text, "Warning first.");
  assert.equal(page.sections[1].title, "Arch");
  assert.ok(!page.text.includes("title:"));
});
test("nested fences and code comments are not headings", () => {
  const page = parseGuide('---\ntitle: "Code"\n---\n````qml\n# not a heading\n```\n## still code\n````\n~~~qml\n### code\n~~~\n## Real\nText', "/docs/code.md");
  assert.deepEqual(page.sections.map((s) => s.title), ["Code", "Real"]);
  assert.ok(page.text.includes("## still code"));
});
test("versions inherit pages and replace old md with newer mdx", async () => {
  const root = await fixture();
  const wiki = createWiki(root);
  assert.equal((await wiki.status()).pageCount, 3);
  const current = await wiki.read({ page: "qml-language" });
  assert.equal(current.docsVersion, "v0.3.0");
  assert.ok(current.path.endsWith("v0_2_0/qml-language.mdx"));
  assert.ok(current.text.includes("new syntax"));
  assert.ok((await createWiki(root, "v0.1.0").read({ page: "qml-language" })).text.includes("old syntax"));
  assert.equal((await createWiki(root, "master").status()).pageCount, 3);
});
test("invalid versions fail explicitly and cannot traverse directories", async () => {
  const root = await fixture();
  assert.match((await createWiki(root, "v99.0.0").status()).error!, /Unknown docs version/);
  await fs.writeFile(path.join(root, "versions.json"), JSON.stringify({ default: "../../secret", versions: [{ name: "../../secret" }] }));
  await assert.rejects(createWiki(root).search({ query: "secret" }), /Unsupported/);
});
test("missing corpus reports setup; smoke does not pretend success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickshell-missing-"));
  temporary.push(root);
  const wiki = createWiki(root);
  assert.equal((await wiki.status()).available, false);
  assert.equal((await wiki.smokeTest()).ok, false);
  await assert.rejects(wiki.search({ query: "test" }), /quickshell-wiki-local-setup/);
});
test("repository README and unrelated markdown are not indexed", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "README.md"), "# SECRET_NOISE\nNot a guide.");
  assert.deepEqual((await createWiki(root).search({ query: "SECRET_NOISE" })).results, []);
});
test("exact headings take priority and misses never return the full page", async () => {
  const wiki = createWiki(await fixture());
  const result = await wiki.extract({ page: "qml-language", section: "Bindings" });
  assert.deepEqual(result.matchedSections.map((s) => s.title), ["Bindings"]);
  assert.ok(!result.text.includes("childrenRect"));
  const miss = await wiki.extract({ page: "qml-language", section: "Absent" });
  assert.equal(miss.text, "");
  assert.equal(miss.totalMatchedSections, 0);
  assert.equal((await wiki.extract({ page: "qml-language", query: "absent" })).text, "");
});
test("all-term query filters are stricter and omission counts are correct", async () => {
  const wiki = createWiki(await fixture());
  assert.equal((await wiki.extract({ page: "qml-language", query: "reactive childrenRect", requireAllTerms: true })).text, "");
  const all = await wiki.extract({ page: "qml-language", maxSections: 1 });
  assert.equal(all.totalMatchedSections, 3);
  assert.equal(all.omittedSectionCount, 2);
  assert.equal((await wiki.sections({ page: "qml-language", maxSections: 1 })).omittedSectionCount, 2);
});
test("read and extraction respect hard character bounds", async () => {
  const root = await fixture();
  await page(root, "v0_3_0", "large.md", "Large", "## Content\n" + "x".repeat(20000));
  const wiki = createWiki(root);
  const read = await wiki.read({ page: "large", maxChars: Infinity });
  assert.equal(read.text.length, 8000);
  assert.equal(read.truncated, true);
  const extract = await wiki.extract({ page: "large", section: "Content", maxChars: 999999 });
  assert.equal(extract.text.length, 12000);
  assert.equal(extract.truncated, true);
});
test("guide aliases resolve to inherited version; missing type refs stay visible", async () => {
  const root = await fixture();
  const links = await createWiki(root).related({ page: "index" });
  assert.equal(links.links.length, 1);
  assert.ok(links.links[0].path.endsWith("v0_2_0/qml-language.mdx"));
  assert.equal(links.unavailableLocalLinkCount, 1);
  assert.ok(links.unavailableLocalLinks[0].includes("types/Quickshell"));
});
test("edits to an older-mtime file invalidate the memory cache", async () => {
  const root = await fixture();
  const file = path.join(root, "src/guide/v0_2_0/qml-language.mdx");
  const wiki = createWiki(root);
  await wiki.search({ query: "bindings" });
  await fs.appendFile(file, "\nCacheRefreshMarker\n");
  await fs.utimes(file, new Date(1000), new Date(1000));
  assert.equal((await wiki.search({ query: "CacheRefreshMarker" })).results.length, 1);
});
test("page lookup rejects empty names and external paths", async () => {
  const wiki = createWiki(await fixture());
  await assert.rejects(wiki.read({ page: "" }), /non-empty/);
  await assert.rejects(wiki.read({ page: "/etc/passwd" }), /No selected/);
  const result = await wiki.search({ query: "QML" });
  assert.equal((await wiki.read({ page: `@${result.results[0].path}` })).title, "QML Language");
});
test("routing is specific and does not hijack generic QML or Hyprland prompts", () => {
  for (const prompt of ["Quickshell setup", "edit shell.qml", "PanelWindow anchors", "IpcHandler usage"]) assert.ok(CONFIG.promptDetection.test(prompt));
  for (const prompt of ["scope the feature", "make variants", "QtQuick QML Item", "hyprctl monitors", "bash shell script"]) assert.ok(!CONFIG.promptDetection.test(prompt));
});
test("all six tools and three commands register; unrelated prompts are untouched", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let hook: any;
  extension({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, on(_event: string, handler: any) { hook = handler; } } as any);
  assert.equal(tools.size, 6);
  assert.equal(commands.size, 3);
  assert.ok(commands.has("quickshell-wiki-local-setup"));
  assert.equal(await hook({ prompt: "generic question", systemPrompt: "base", systemPromptOptions: { skills: [{ name: "quickshell-local" }] } }), undefined);
});
test("legacy checkout remains readable with an upgrade warning", async () => {
  const root = await fixture();
  const before = await fs.readFile(path.join(root, "versions.json"), "utf8");
  const status = await createWiki(root).status();
  assert.equal(status.mode, "legacy-guides");
  assert.match(status.coverage!, /newest published/);
  assert.equal(await fs.readFile(path.join(root, "versions.json"), "utf8"), before);
});
test("setup arguments select latest by default and support pinning or rollback", () => {
  assert.deepEqual(parseSetupArgs(""), {});
  assert.deepEqual(parseSetupArgs("--version v0.3.1"), { version: "v0.3.1" });
  assert.deepEqual(parseSetupArgs("--version latest"), { version: "latest" });
  assert.deepEqual(parseSetupArgs("--rollback"), { rollback: true });
  assert.throws(() => parseSetupArgs("--version ../../etc"), /Usage/);
  assert.throws(() => parseSetupArgs("--rollback --version latest"), /Usage/);
});
test("original HTML member anchors survive Markdown normalization", () => {
  const page = parseGuide("---\ntitle: API\n---\n### volume : real {#volume}\nRequires a tracker.", "/docs/audio.md");
  assert.equal(page.sections[1].title, "volume : real");
  assert.equal(page.sections[1].anchor, "volume");
});
