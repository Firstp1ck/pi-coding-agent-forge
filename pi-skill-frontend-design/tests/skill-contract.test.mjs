import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [manifest, skill, readme, technical, development, license, behavior] = await Promise.all([
  read("package.json").then(JSON.parse),
  read("skills/frontend-design/SKILL.md"),
  read("README.md"),
  read("TECHNICAL.md"),
  read("DEVELOPMENT.md"),
  read("LICENSE"),
  read("skills/frontend-design/references/expected-behavior.md"),
]);

const packagedFiles = [
  "skills/frontend-design/SKILL.md",
  "skills/frontend-design/references/expected-behavior.md",
  "README.md",
  "TECHNICAL.md",
  "DEVELOPMENT.md",
  "LICENSE",
];

test("package metadata exposes one installable Pi skill", () => {
  assert.equal(manifest.name, "@firstpick/pi-skill-frontend-design");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.license, "Apache-2.0");
  assert(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi, { skills: ["./skills"] });
  assert.deepEqual(manifest.files, packagedFiles);
  assert.equal(manifest.scripts.test, "node --test tests/skill-contract.test.mjs");
});

test("skill frontmatter follows the Agent Skills contract", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, "SKILL.md must begin with YAML frontmatter");

  assert.match(frontmatter[1], /^name: frontend-design$/m);
  assert.match(frontmatter[1], /^description: .+$/m);
  assert.match(frontmatter[1], /^license: Apache-2\.0$/m);
  assert.match(frontmatter[1], /^compatibility: .+$/m);

  const description = frontmatter[1].match(/^description: (.+)$/m)?.[1] ?? "";
  const compatibility = frontmatter[1].match(/^compatibility: (.+)$/m)?.[1] ?? "";
  assert(description.length <= 1024);
  assert.match(description, /fixing a web interface/);
  assert.match(description, /expected interaction behavior/);
  assert(compatibility.length <= 500);
});

test("skill preserves the design workflow and quality floor", () => {
  assert.match(skill, /Name the subject, its audience, and the page's single job/);
  assert.match(skill, /four to six palette colors names and hex values/);
  assert.match(skill, /Use ASCII wireframes to compare ideas/);
  assert.match(skill, /Choose the one element people should remember/);
  assert.match(skill, /Ask whether each choice could appear unchanged in any similar project/);
  assert.match(skill, /Support mobile layouts, visible keyboard focus, and reduced-motion preferences/);
  assert.match(skill, /Write from the user's side of the screen/);
});

test("skill requires behavior planning without authorizing product expansion", () => {
  assert.match(skill, /Before coding, read \[Expected interface behavior\]\(references\/expected-behavior\.md\)/);
  for (const category of ["Baseline usability", "Feature-dependent expectations", "Product decisions"]) {
    assert(skill.includes(category), `Missing behavior category: ${category}`);
  }
  assert.match(skill, /Ask before making unresolved choices/);
  assert.match(skill, /Respect explicit mockup-only or visual-only scope/);
  assert.match(skill, /Never present a mock operation as a real save/);
  assert.match(skill, /starting state, action, observable result, and failure or exit path/);
  assert.match(skill, /Inventory every visible interactive control/);
  assert.match(skill, /Preserve user input during recoverable failures/);
  assert.match(skill, /older response overwrite a newer result/);
  assert.match(skill, /frontend feedback cannot supply missing persistence, authorization, or transaction guarantees/);
  assert.match(skill, /For a focused behavior fix, reuse the existing palette, type, and layout/);
});

test("skill requires interaction evidence rather than screenshots alone", () => {
  const verification = skill.split("## Verify complete tasks before calling the work done\n")[1]
    ?.split("\n## ")[0];
  assert(verification, "The skill needs an explicit behavior verification gate");
  for (const requirement of [
    /rendered interface/,
    /project tests/,
    /failure or recovery path/,
    /keyboard-only navigation/,
    /narrow viewport, zoom, long content, and reduced motion/,
    /out-of-order results/,
    /back navigation and reload/,
    /without authorization/,
    /which checks could not run/,
    /Do not claim interaction verification from a build, static inspection, or screenshots alone/,
  ]) {
    assert.match(verification, requirement);
  }
});

test("behavior reference covers relevant triggers and their scope boundaries", () => {
  const checklist = behavior.split("## Trigger-based behavior checklist\n")[1]?.split("\n## ")[0];
  assert(checklist, "The reference needs a trigger-based checklist");
  for (const trigger of [
    "Links and navigation",
    "Forms and settings",
    "Save, send, or other writes",
    "Loading data",
    "Search, filters, sorting, or pagination",
    "Dialogs, menus, tabs, or popovers",
    "Destructive or high-consequence actions",
    "Uploads, dragging, or reordering",
    "Responsive layouts and varied input",
    "Status, permissions, and live updates",
  ]) {
    const row = checklist.split("\n").find((line) => line.startsWith(`| ${trigger} |`));
    assert(row, `Missing behavior trigger: ${trigger}`);
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 3, `${trigger} needs a trigger, expectation, and boundary`);
    assert(cells.every(Boolean), `${trigger} has an empty checklist cell`);
  }
  assert.match(behavior, /not a formal industry taxonomy/);
  assert.match(behavior, /not a complete WCAG audit/);
  assert.match(behavior, /Client file checks are not a security boundary/);
  assert.match(behavior, /Hidden or disabled UI is not authorization/);
});

test("application examples contain recovery checks and non-goals", () => {
  const scenarios = [
    ["Workspace notification settings", /forcing a save failure/, /reload and confirm daily/],
    ["Storefront product search", /size 8 finish last/, /valid page/],
    ["Cinema ticket checkout", /lost response after submission/, /exactly-once charging/],
    ["Team administration and member removal", /force a permission failure/, /focus returns/],
    ["Digital asset uploads", /Recovery targets only the failed file/, /file picker/],
    ["Task board with drag-and-drop movement", /Reject the move at the service/, /click\/tap controls without dragging/],
  ];
  for (const [heading, failureCheck, interactionCheck] of scenarios) {
    const section = behavior.split(`### ${heading}\n`)[1]?.split(/\n#{2,3} /)[0];
    assert(section, `Missing application scenario: ${heading}`);
    assert.match(section, /\*\*Brief:\*\*/);
    assert.match(section, /Expected behavior:/);
    assert.match(section, /Acceptance checks:/);
    assert.match(section, /Do not (?:infer|invent)/);
    assert.match(section, failureCheck);
    assert.match(section, interactionCheck);
  }
});

test("reference attributes guidance without claiming universal requirements", () => {
  assert.match(behavior, /engineering synthesis/);
  assert.match(behavior, /not all WCAG requirements/);
  assert.match(behavior, /informative guidance, not the normative standard/);
  assert.match(behavior, /https:\/\/www\.w3\.org\/WAI\/ARIA\/apg\/patterns\/dialog-modal\//);
  assert.match(behavior, /https:\/\/design-system\.service\.gov\.uk\/patterns\/validation\//);
  assert.match(behavior, /https:\/\/www\.nngroup\.com\/articles\/ten-usability-heuristics\//);
});

test("license and modification notice are present", () => {
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(skill, /## Modification notice/);
  assert.match(skill, /This file has been modified\./);
  assert.match(development, /keeps the complete terms in `LICENSE`/);
});

test("package documentation has working local links, balanced fences, and no banned punctuation", async () => {
  const documents = [
    ["README.md", readme],
    ["TECHNICAL.md", technical],
    ["DEVELOPMENT.md", development],
    ["skills/frontend-design/SKILL.md", skill],
    ["skills/frontend-design/references/expected-behavior.md", behavior],
  ];

  for (const [relativePath, contents] of documents) {
    assert.doesNotMatch(contents, /[—–“”‘’]/u, `${relativePath} contains banned punctuation`);
    let openFence;
    for (const line of contents.split("\n")) {
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (!fence) continue;
      if (!openFence) {
        openFence = fence[1];
      } else if (fence[1][0] === openFence[0] && fence[1].length >= openFence.length && !fence[2].trim()) {
        openFence = undefined;
      }
    }
    assert.equal(openFence, undefined, `${relativePath} has an unclosed code fence`);

    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      await access(path.resolve(root, path.dirname(relativePath), target));
    }
  }

  assert.match(readme, /pi install npm:@firstpick\/pi-skill-frontend-design/);
});

test("every declared package file exists", async () => {
  await Promise.all(packagedFiles.map((relativePath) => access(path.join(root, relativePath))));
});
