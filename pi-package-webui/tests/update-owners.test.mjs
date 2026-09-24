import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { npmGlobalWebuiTarget, piUserWebuiTarget, selfUpdateCommand, userWebuiNpmSource } from "../lib/update/native-targets.mjs";
import { classifyPackageOwner, ownershipRefusalGuidance } from "../lib/update/owners.mjs";

const ownerRoot = path.resolve("tmp", "agent", "npm", "node_modules");
const packageRoot = path.join(ownerRoot, "@firstpick", "pi-package-webui");
for (const manager of ["npm", "bun"]) {
  const owner = classifyPackageOwner({ manager, ownerRoot, packageRoot, topLevel: true });
  assert.equal(owner.accepted, true, `${manager} exact top-level ownership should be accepted`);
  assert.equal(owner.manager, manager);
}
const delegatedPi = classifyPackageOwner({ manager: "pi", ownerRoot: packageRoot, packageRoot, topLevel: true });
assert.equal(delegatedPi.accepted, true, "an exact verified Pi executable may own its delegated self-update");
assert.equal(delegatedPi.manager, "pi");
for (const manager of ["pnpm", "yarn", "unknown"]) {
  const owner = classifyPackageOwner({ manager, ownerRoot, packageRoot });
  assert.equal(owner.accepted, false);
  assert.equal(owner.code, manager === "unknown" ? "unknown" : manager);
  assert.ok(owner.guidance.length > 10 && owner.guidance.length <= 320);
}
assert.equal(classifyPackageOwner({ manager: "npm", ownerRoot, packageRoot, linked: true }).code, "linked");
assert.equal(classifyPackageOwner({ manager: "npm", ownerRoot, packageRoot, sourceCheckout: true }).code, "source");
assert.equal(classifyPackageOwner({ manager: "npm", ownerRoot, packageRoot, topLevel: false }).code, "nested");
assert.equal(classifyPackageOwner({ manager: "npm", ownerRoot, packageRoot, optional: true, piOwned: false }).code, "optional");
assert.equal(classifyPackageOwner({ manager: "npm", ownerRoot, packageRoot: path.resolve("tmp", "other") }).code, "opaque");
assert.match(ownershipRefusalGuidance("source"), /never mutated automatically/i);
const testRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-native-owners-"));
try {
  const agentDir = path.join(testRoot, "agent");
  const globalPrefix = path.join(testRoot, "global");
  const packageParts = ["@firstpick", "pi-package-webui"];
  const globalModules = path.join(globalPrefix, ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]));
  const globalRoot = path.join(globalModules, ...packageParts);
  const userRoot = path.join(agentDir, "npm", "node_modules", ...packageParts);
  await mkdir(globalRoot, { recursive: true });
  await mkdir(userRoot, { recursive: true });
  const manifest = JSON.stringify({ name: "@firstpick/pi-package-webui", version: "0.10.6" });
  await writeFile(path.join(globalRoot, "package.json"), manifest);
  await writeFile(path.join(userRoot, "package.json"), manifest);
  const npm = { command: path.join(testRoot, "node"), args: [path.join(testRoot, "npm-cli.js")] };
  const global = await npmGlobalWebuiTarget({ nodeModulesRoot: globalModules, prefix: globalPrefix, npmInvocation: npm });
  assert.equal(global.eligible, true);
  assert.deepEqual(global.command.args.slice(-3), ["-g", "update", "@firstpick/pi-package-webui"]);
  const pi = { eligible: true, invocation: { command: npm.command, args: [path.join(testRoot, "pi-cli.js")] }, packageRoot: testRoot, prefix: globalPrefix, version: "0.87.1" };
  const selected = await piUserWebuiTarget({ agentDir, pathPi: pi, settings: { packages: ["npm:@firstpick/pi-package-webui@^0.10.0"] } });
  assert.equal(selected.eligible, true);
  assert.deepEqual(selected.command.args.slice(-4), ["update", "--extension", "npm:@firstpick/pi-package-webui@^0.10.0", "--no-approve"]);
  assert.deepEqual(selfUpdateCommand(pi).command.args.slice(-1), ["update"]);
  assert.equal(userWebuiNpmSource({ packages: ["npm:@firstpick/pi-package-webui@0.10.6"] }).eligible, false);
  assert.equal(userWebuiNpmSource({ packages: ["git:example", "npm:@firstpick/pi-package-webui@next"] }).eligible, true);
  assert.equal(userWebuiNpmSource({ packages: ["npm:@firstpick/pi-package-webui", "npm:@firstpick/pi-package-webui@next"] }).eligible, false);
  await rm(globalRoot, { recursive: true });
  await symlink(userRoot, globalRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await npmGlobalWebuiTarget({ nodeModulesRoot: globalModules, prefix: globalPrefix, npmInvocation: npm })).eligible, false);
} finally { await rm(testRoot, { recursive: true, force: true }); }
console.log("update-owners.test.mjs passed");
