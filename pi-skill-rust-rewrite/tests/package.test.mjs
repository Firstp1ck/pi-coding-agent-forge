import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json"));
const skillDir = "skills/rewrite-in-rust";
const skillPath = `${skillDir}/SKILL.md`;
const referenceDir = `${skillDir}/references`;
const references = readdirSync(path.join(root, referenceDir))
  .sort()
  .map((name) => `${referenceDir}/${name}`);
const documents = ["README.md", "TECHNICAL.md", "DEVELOPMENT.md"];
const markdownFiles = [...documents, skillPath, ...references];
const publishedFiles = [skillPath, ...references, ...documents, "LICENSE"];

// GitHub-style heading anchors: lowercase, drop punctuation except underscores and
// hyphens, spaces to hyphens. Headings inside fenced code blocks are not anchors.
const slug = (heading) =>
  heading.toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
const anchorsOf = (relative) => {
  const anchors = new Set();
  let fence = null;
  for (const line of read(relative).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) anchors.add(slug(heading[1]));
  }
  return anchors;
};

test("manifest declares a public, discoverable skill package", () => {
  assert.equal(manifest.name, "@firstpick/pi-skill-rust-rewrite");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 0);
  assert.equal(manifest.license, "MIT");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.repository.directory, path.basename(root));
  assert.match(manifest.repository.url, /^git\+https:\/\//);
  assert.match(manifest.homepage, /^https:\/\//);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi, { skills: ["./skills"] });
});

test("package ships the skill, its references, and documentation without runtime code", () => {
  for (const field of [
    "dependencies", "optionalDependencies", "peerDependencies",
    "bundledDependencies", "bundleDependencies", "bin",
  ]) {
    assert.equal(manifest[field], undefined, field);
  }
  assert.deepEqual(manifest.scripts, { test: "node --test tests/package.test.mjs" });
  assert.deepEqual([...manifest.files].sort(), [...publishedFiles].sort());
  for (const file of publishedFiles) {
    assert.ok(statSync(path.join(root, file)).isFile(), file);
  }
  assert.deepEqual(readdirSync(path.join(root, "skills")), ["rewrite-in-rust"]);
  assert.deepEqual(readdirSync(path.join(root, skillDir)).sort(), ["SKILL.md", "references"]);
  assert.ok(references.length > 0, "the skill bundles at least one reference");
  for (const file of references) {
    assert.match(file, /\.md$/, `${file}: references are Markdown documents, not scripts`);
  }
  assert.equal(existsSync(path.join(root, "SKILL.md")), false);
});

test("SKILL.md names every bundled reference and no missing one", () => {
  const skill = read(skillPath);
  for (const file of references) {
    const relative = path.relative(skillDir, file);
    assert.ok(
      skill.includes(`\`${relative}\``) || skill.includes(`](${relative})`),
      `${relative} is never referenced from SKILL.md`,
    );
  }
  for (const match of skill.matchAll(/references\/([A-Z-]+\.md)/g)) {
    assert.ok(
      existsSync(path.join(root, referenceDir, match[1])),
      `SKILL.md names a missing reference: ${match[1]}`,
    );
  }
});

test("skill frontmatter is portable and matches the resource directory", () => {
  const content = read(skillPath);
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, "YAML frontmatter is required");
  const name = frontmatter[1].match(/^name: (.+)$/m)?.[1];
  const description = frontmatter[1].match(/^description: (.+)$/m)?.[1];
  const license = frontmatter[1].match(/^license: (.+)$/m)?.[1];
  assert.equal(name, path.basename(skillDir));
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  assert.ok(description?.length > 0 && description.length <= 1024);
  assert.equal(license, "MIT");
  for (const file of [skillPath, ...references]) {
    assert.doesNotMatch(read(file), /\/home\/|\/Users\/|[A-Z]:\\Users\\/, `${file}: private path`);
  }
});

test("decision IDs are well-formed, defined once, and used consistently", () => {
  const catalogue = read(`${referenceDir}/DECISIONS.md`);
  const definitions = [...catalogue.matchAll(/\*\*(D-[A-Z]+-(?:\d\d|nn)) /g)].map((match) => match[1]);
  const defined = new Set(definitions);
  assert.ok(defined.size > 0, "the catalogue defines decision IDs");
  assert.equal(definitions.length, defined.size, "a decision ID is defined more than once");
  for (const file of [skillPath, ...references]) {
    for (const match of read(file).matchAll(/\bD-[A-Z]+-[A-Za-z0-9]+\b/g)) {
      assert.match(match[0], /^D-[A-Z]+-(?:\d\d|nn)$/, `${file}: malformed decision ID ${match[0]}`);
      assert.ok(defined.has(match[0]), `${file}: undefined decision ${match[0]}`);
    }
  }
});

test("step references point at numbered workflow sections", () => {
  const steps = new Set([...read(skillPath).matchAll(/^## (\d)\. /gm)].map((match) => match[1]));
  assert.ok(steps.size >= 8, "the workflow has numbered steps");
  for (const file of [skillPath, ...references]) {
    for (const match of read(file).matchAll(/\bsteps?\s+((?:\d|,|\s|and|to)+)/gi)) {
      for (const digit of match[1].match(/\d/g) ?? []) {
        assert.ok(steps.has(digit), `${file}: refers to step ${digit}, which has no heading`);
      }
    }
  }
});

test("the Pi adapter offers Grill Me without launching it", () => {
  const skill = read(skillPath);
  const adapter = skill.slice(skill.indexOf("## Pi adapter"));
  assert.ok(adapter.length > 0, "SKILL.md has a Pi adapter section");
  assert.ok(adapter.includes("/grill-me"));
  assert.ok(adapter.includes("Never issue the command yourself"));
  assert.ok(adapter.includes("never answer its questionnaires yourself"));
  assert.ok(adapter.includes("migration/PILOT.md"), "round two has its own plan document");
});

test("user documentation explains installation and the correct skill command", () => {
  const readme = read("README.md");
  for (const heading of [
    "Helpful when", "What to share with Pi", "Try asking",
    "What you’ll get", "Keep in mind", "Install", "Technical details",
  ]) {
    assert.ok(readme.includes(`## ${heading}`), heading);
  }
  assert.ok(readme.includes(`pi install npm:${manifest.name}`));
  assert.ok(readme.includes("/skill:rewrite-in-rust"));
  for (const file of ["TECHNICAL.md", "DEVELOPMENT.md"]) {
    assert.ok(read(file).includes("(README.md)"), file);
  }
  assert.match(read("LICENSE"), /^MIT License/m);
});

test("all local Markdown links and anchors resolve", () => {
  for (const file of markdownFiles) {
    const content = read(file);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [relative, anchor = ""] = target.split("#");
      const targetFile = relative === "" ? file : path.relative(root, path.resolve(root, path.dirname(file), decodeURIComponent(relative)));
      const resolved = path.join(root, targetFile);
      assert.ok(existsSync(resolved), `${file}: ${target}`);
      assert.ok(!targetFile.startsWith("..") && !path.isAbsolute(targetFile),
        `${file}: link must remain usable inside the npm archive: ${target}`);
      if (anchor !== "") {
        assert.ok(anchorsOf(targetFile).has(anchor), `${file}: anchor #${anchor} not found in ${targetFile}`);
      }
    }
  }
});

test("Markdown code fences are balanced", () => {
  for (const file of markdownFiles) {
    let open = null;
    for (const line of read(file).split(/\r?\n/)) {
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (!fence) continue;
      if (!open) {
        open = fence[1];
      } else if (
        fence[1][0] === open[0] &&
        fence[1].length >= open.length &&
        fence[2].trim() === ""
      ) {
        open = null;
      }
    }
    assert.equal(open, null, `${file}: unclosed code fence`);
  }
});
