import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuidedGitError } from "../src/core.ts";
import {
  DEFAULT_GUIDED_GIT_PREFERENCES,
  createGuidedGitPreferencesStore,
  supportedGuidedGitThinkingLevels,
  validateGuidedGitPreferences,
} from "../src/preferences.ts";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function temp(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `guided-git-preferences-${label}-`));
  roots.push(root);
  return root;
}

function configured() {
  return {
    generation: {
      primary: { provider: "openai", modelId: "gpt-test", thinkingLevel: "medium" },
      fallback: { provider: "anthropic", modelId: "claude-test", thinkingLevel: "high" },
    },
    commit: { language: "de", scope: "required", defaultVariant: "long" },
    staging: "all",
    defaultEntry: "push",
    verification: "none",
  };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof GuidedGitError && error.code === code);
}

async function assertRejectCode(value, code) {
  await assert.rejects(value, (error) => error instanceof GuidedGitError && error.code === code);
}

test("preferences validate complete typed defaults, profiles, and supported model efforts", () => {
  assert.deepEqual(validateGuidedGitPreferences(DEFAULT_GUIDED_GIT_PREFERENCES), DEFAULT_GUIDED_GIT_PREFERENCES);
  assert.deepEqual(validateGuidedGitPreferences(configured()), configured());
  assert.deepEqual(supportedGuidedGitThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedGuidedGitThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null } }), ["off", "low", "medium", "high", "xhigh"]);
});

test("preferences fail closed on unknown, incomplete, unsafe, duplicate fallback, and unsupported values", () => {
  const valid = configured();
  for (const invalid of [
    { ...valid, secret: "must-not-be-stored" },
    { ...valid, generation: { primary: valid.generation.primary } },
    { ...valid, generation: { primary: null, fallback: valid.generation.fallback } },
    { ...valid, generation: { primary: valid.generation.primary, fallback: { ...valid.generation.primary } } },
    { ...valid, generation: { ...valid.generation, primary: { ...valid.generation.primary, provider: " bad" } } },
    { ...valid, generation: { ...valid.generation, primary: { ...valid.generation.primary, thinkingLevel: "ultra" } } },
    { ...valid, commit: { ...valid.commit, language: "fr" } },
    { ...valid, defaultEntry: "initialize" },
  ]) assertCode(() => validateGuidedGitPreferences(invalid), "INVALID_PREFERENCES");
});

test("preference store uses bounded strict JSON, private atomic writes, and optimistic snapshots", async () => {
  const root = await temp("store");
  const agentDir = path.join(root, "agent");
  let queueCalls = 0;
  const store = createGuidedGitPreferencesStore(agentDir, async (key, work) => {
    queueCalls += 1;
    assert.equal(key, path.join(agentDir, "git-guided-workflow.json"));
    return await work();
  });
  const initial = await store.load();
  assert.equal(initial.source, "defaults");
  assert.equal(initial.raw, null);
  assert.deepEqual(initial.preferences, DEFAULT_GUIDED_GIT_PREFERENCES);

  const saved = await store.save(initial, configured());
  assert.equal(saved.source, "saved");
  assert.deepEqual(saved.preferences, configured());
  assert.equal(queueCalls, 1);
  assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
  const disk = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(disk.version, 1);
  assert.deepEqual(disk.preferences, configured());
  assert.equal(Object.hasOwn(disk, "secret"), false);

  await writeFile(store.path, `${JSON.stringify({ version: 1, preferences: { ...configured(), verification: "ask" } })}\n`, { mode: 0o600 });
  await assertRejectCode(store.save(saved, configured()), "PREFERENCES_CHANGED");
});

test("preference store refuses invalid files, oversize input, symlinks, and cancelled saves", async () => {
  const root = await temp("invalid");
  const agentDir = path.join(root, "agent");
  const store = createGuidedGitPreferencesStore(agentDir);
  const initial = await store.load();
  const controller = new AbortController();
  controller.abort();
  await assertRejectCode(store.save(initial, configured(), controller.signal), "PREFERENCES_SAVE_CANCELLED");

  await mkdir(agentDir);
  await writeFile(store.path, "{invalid", { mode: 0o600 });
  await assertRejectCode(store.load(), "INVALID_PREFERENCES");
  await writeFile(store.path, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
  await assertRejectCode(store.load(), "PREFERENCES_TOO_LARGE");

  await rm(store.path);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, store.path);
  await assertRejectCode(store.load(), "UNSAFE_PREFERENCES_PATH");
  await chmod(outside, 0o600);
});
