import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isT3ResourceProfileContext,
  readResourceDefaults,
  resolveResourceSelection,
  setExactModelProfile,
  updateResourceDefaults,
} from "../src/resource-management.mjs";

const bound = { T3_PI_RESOURCE_PROFILES: `t3-v1:${process.pid}` };
assert.equal(isT3ResourceProfileContext({ mode: "rpc" }, bound), true);
for (const mode of ["tui", "json", "print", undefined]) {
  assert.equal(isT3ResourceProfileContext({ mode }, bound), false);
}
for (const marker of [undefined, "t3-v1", `t3-v2:${process.pid}`, `t3-v1:0${process.pid}`, `t3-v1:${process.pid + 1}`, ` t3-v1:${process.pid}`]) {
  assert.equal(isT3ResourceProfileContext({ mode: "rpc", hasUI: true }, { T3_PI_RESOURCE_PROFILES: marker }), false);
}
const moduleUrl = new URL("../src/resource-management.mjs", import.meta.url).href;
assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e",
  `import { isT3ResourceProfileContext } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(isT3ResourceProfileContext({mode:'rpc'})));`,
], { env: { ...process.env, ...bound }, encoding: "utf8" }), "false", "descendants must not inherit ownership");

const root = await mkdtemp(path.join(tmpdir(), "pi-resource-management-"));
const settingsFile = path.join(root, "settings.json");

try {
  await writeFile(settingsFile, `${JSON.stringify({ version: 8, retained: { ok: true }, resourceDefaults: { tools: { enabledTools: ["read"] } } })}\n`);
  await updateResourceDefaults((current) => ({
    ...current,
    skills: { ...current.skills, enabledSkills: ["repo-explorer"] },
    modelProfiles: setExactModelProfile(current, "provider", "model", "tools", []),
  }), settingsFile);

  const defaults = await readResourceDefaults(settingsFile);
  assert.deepEqual(defaults.tools.enabledTools, ["read"]);
  assert.deepEqual(defaults.skills.enabledSkills, ["repo-explorer"]);
  assert.deepEqual(resolveResourceSelection(defaults, "tools", "provider", "model", ["runtime"]), { names: [], source: "model" });

  const raw = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.deepEqual(raw.retained, { ok: true }, "resource writes must preserve unrelated WebUI settings");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("resource-management.test.mjs passed");
