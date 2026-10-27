import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../skills/patch-md/SKILL.md", import.meta.url), "utf8");
const location = skill.split("## App-specific package location\n")[1]?.split("## Lifecycle Commands\n")[0];

test("app patches use a verified configuration home as the canonical location", () => {
  assert.ok(location);
  assert.match(location, /app's verified configuration\/home directory is the canonical package location/);
  assert.match(location, /<app-config>\/patches\/<patch-id>\//);
  assert.match(location, /documented runtime settings, launch options, or verified environment overrides/);
  assert.match(location, /Ask when the location cannot be established safely/);
});

test("canonical packages retain all reconstruction files and portable dependencies", () => {
  assert.match(location, /complete reconstructable package/);
  for (const expected of ["PATCH.md", "manifest", "lifecycle handlers", "profiles/assets", "documentation", "tests/fixtures"]) {
    assert.ok(location.includes(expected), expected);
  }
  assert.match(location, /repository may retain a development mirror/i);
  assert.match(location, /runtime assets package-relative/);
  assert.match(location, /verify the copied package independently/);
});

test("T3 patch storage is outside live userdata and respects its configured home", () => {
  assert.match(location, /T3CODE_HOME/);
  assert.match(location, /~\/\.t3\/patches\/<patch-id>\//);
  assert.match(location, /outside live `userdata`/);
  assert.match(location, /never authorizes editing app settings or runtime state/);
});

test("storage does not migrate rollback state or authorize silent application", () => {
  assert.match(location, /Do not silently move existing patches, receipts, or backups/);
  assert.match(location, /Preserve their explicit state directory for rollback/);
  assert.match(location, /Patch storage is not patch application/);
  assert.match(location, /fresh read-only status\/plan/);
  assert.match(location, /never silently reapply/);
});
