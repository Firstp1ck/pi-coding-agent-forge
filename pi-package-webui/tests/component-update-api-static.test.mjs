import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [server, state, launcher, runner, trust] = await Promise.all([
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "lib", "component-update-state.mjs"), "utf8"),
  readFile(join(root, "bin", "pi-webui-launcher.mjs"), "utf8"),
  readFile(join(root, "bin", "pi-webui-native-update-runner.mjs"), "utf8"),
  readFile(join(root, "lib", "trust-boundaries.mjs"), "utf8"),
]);
assert.match(state, /validateUpdatePlanRequest[\s\S]*targets must contain exactly one value/);
assert.match(state, /validateUpdateApplyRequest[\s\S]*Apply accepts only transactionId and planDigest/);
assert.match(server, /url\.pathname === "\/api\/update\/plan"[\s\S]*requireLocalhostRoute[\s\S]*validateUpdatePlanRequest[\s\S]*sendJson\(res, 201/);
assert.match(server, /url\.pathname === "\/api\/update\/apply"[\s\S]*requireLocalhostRoute[\s\S]*validateUpdateApplyRequest[\s\S]*applyNativeServerPlan/);
assert.match(server, /createNativeServerPlan\(validation\.targets\)/);
assert.match(server, /validateNativePlan\(job\.plan, digest\)/);
assert.match(server, /url\.pathname === "\/api\/restart"[\s\S]*requireLocalhostRoute[\s\S]*assertNativeMutationAdmission\(\)/,
  "ordinary server restarts must not race a native update fence");
assert.match(server, /releaseEffectLocks\(job\.lock, \{ completionVerified: true \}\)/);
assert.match(server, /probeStartupRestore\(path\.join\(target\.installedRoot/);
assert.match(server, /Legacy update mutation is disabled/);
assert.doesNotMatch(server, /strategy: "pi-owned-optional"|"--ignore-scripts"|"managed-side-by-side"/);
assert.match(trust, /"\/api\/update\/plan"[\s\S]*"\/api\/update\/apply"[\s\S]*"\/api\/update\/rollback"/);
assert.match(server, /updateTransactionRoute && req\.method === "GET"[\s\S]*requireLocalhost\(req, "Viewing update transactions is only allowed from localhost"\)/);
assert.doesNotMatch(server, /function resolveUpdateTasks|function projectPackageRootUpdateTasks|function npmGlobalPackageRootUpdateTask|function bunGlobalPackageRootUpdateTask/);
assert.match(launcher, /migrateLegacyBootstrap\(agentDir, bootstrapRoot\)/);
for (const file of ["started.json", "receipt.json", "complete.json"]) assert.ok(runner.includes(file), `${file} evidence must be durable`);
console.log("component update API static tests passed");
