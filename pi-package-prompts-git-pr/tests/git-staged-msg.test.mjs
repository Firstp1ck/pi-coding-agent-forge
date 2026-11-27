import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = await readFile(join(root, "commands", "git-staged-msg.md"), "utf8");

const rootCommand = 'REPO_ROOT="$(git rev-parse --show-toplevel)"';
const diffCommand = 'git -C "$REPO_ROOT" diff --cached';

assert.ok(prompt.includes(rootCommand), "prompt should resolve the Git repository root explicitly");
assert.ok(prompt.includes(diffCommand), "prompt should inspect staged changes from the resolved repository root");
assert.ok(prompt.indexOf(rootCommand) < prompt.indexOf(diffCommand), "prompt should resolve the repository root before inspecting staged changes");
assert.match(prompt, /Do not use the process working directory, which may be a subdirectory\./, "prompt should reject the invocation directory as the repository root");
assert.match(prompt, /Use the absolute paths formed from `REPO_ROOT` for every directory-creation and file-writing tool call\./, "prompt should require absolute output paths");
assert.match(prompt, /Never write to `dev\/COMMIT` relative to the current working directory\./, "prompt should forbid subdirectory-relative output");

for (const file of ["staged-commit-short.txt", "staged-commit-long.txt"]) {
  assert.ok(prompt.includes(`$REPO_ROOT/dev/COMMIT/${file}`), `prompt should root ${file} under the repository dev/COMMIT directory`);
}

console.log("git-staged-msg.test.mjs passed");
