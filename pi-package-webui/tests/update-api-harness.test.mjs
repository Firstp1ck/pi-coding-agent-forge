import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { persistSharedJob } from "../lib/update/coordination.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateUpdateApplyRequest, validateUpdatePlanRequest } from "../lib/component-update-state.mjs";

assert.deepEqual(validateUpdatePlanRequest({ targets: ["pi"] }), { ok: true, targets: ["pi"] });
assert.deepEqual(validateUpdatePlanRequest({ targets: ["webui"] }), { ok: true, targets: ["webui"] });
for (const invalid of [{}, { targets: [] }, { targets: ["all"] }, { targets: ["pi", "pi"] }, { targets: ["pi", "webui"] }, { targets: ["pi"], registry: "https://evil.test" }]) {
  assert.equal(validateUpdatePlanRequest(invalid).ok, false);
}
const digest = "a".repeat(64);
assert.deepEqual(validateUpdateApplyRequest({ transactionId: "tx-1", planDigest: digest }), { ok: true, transactionId: "tx-1", planDigest: digest });
for (const invalid of [{ transactionId: "tx-1" }, { transactionId: "../x", planDigest: digest }, { transactionId: "tx", planDigest: digest, command: "npm" }]) {
  assert.equal(validateUpdateApplyRequest(invalid).ok, false);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await readFile(path.join(root, "bin", "pi-webui.mjs"), "utf8");
assert.match(server, /\/api\/update\/plan[\s\S]*validateUpdatePlanRequest[\s\S]*createNativeServerPlan/);
assert.match(server, /\/api\/update\/apply[\s\S]*validateUpdateApplyRequest[\s\S]*applyNativeServerPlan/);
assert.match(server, /Legacy update mutation is disabled/);
assert.match(server, /validateNativePlan\(job\.plan, digest\)/);
assert.match(server, /bootIdentity/);
assert.doesNotMatch(server, /function resolveUpdateTasks|function projectPackageRootUpdateTasks|function npmGlobalPackageRootUpdateTask|function bunGlobalPackageRootUpdateTask/);

async function freePort() {
  const listener = createNetServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const registryPort = await freePort();
const webuiPort = await freePort();
const registry = createHttpServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/pi-latest" ? { version: "9.9.9" } : { version: "9.9.9" }));
});
await new Promise((resolve) => registry.listen(registryPort, "127.0.0.1", resolve));
const temp = await mkdtemp(path.join(tmpdir(), "pi-webui-update-api-"));
const piFixture = await mkdtemp(path.join(tmpdir(), "pi-webui-update-api-pi-"));
const fakePi = path.join(piFixture, "fake-pi-with-version.mjs");
await writeFile(fakePi, `if (process.argv.includes("--version")) { console.log("0.84.0"); process.exit(0); } await import(${JSON.stringify(pathToFileURL(path.join(root, "tests", "fixtures", "fake-pi.mjs")).href)});\n`, "utf8");
const child = spawn(process.execPath, [path.join(root, "bin", "pi-webui.mjs"), "--cwd", temp, "--host", "127.0.0.1", "--port", String(webuiPort), "--pi", fakePi], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_WEBUI_RPC_SUPERVISOR: "0",
    PI_CODING_AGENT_DIR: path.join(temp, "agent"),
    PI_WEBUI_SETTINGS_FILE: path.join(temp, "settings.json"),
    PI_WEBUI_PI_LATEST_VERSION_URL: `http://127.0.0.1:${registryPort}/pi-latest`,
    PI_WEBUI_NPM_REGISTRY_URL: `http://127.0.0.1:${registryPort}`,
    PI_WEBUI_NPM_BIN: path.join(temp, "missing-npm"),
    NODE_ENV: "test",
    PI_WEBUI_UPDATE_TEST_HOME: temp,
  },
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${webuiPort}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { health = await response.json(); break; }
    } catch {}
    await delay(100);
  }
  assert.ok(health?.bootIdentity, output);
  const request = (targets) => fetch(`http://127.0.0.1:${webuiPort}/api/update/plan`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets }),
  });
  const combined = await request(["pi", "webui"]);
  assert.equal(combined.status, 400, "combined actions must be rejected without shell execution");
  const piPlan = await request(["pi"]);
  const piData = await piPlan.json();
  assert.equal(piPlan.status, 409, JSON.stringify(piData));
  assert.match(piData.error || "", /PATH Pi|npm-global|manual/i, "explicit fake Pi is not the verified PATH Pi");
  const webuiPlan = await request(["webui"]);
  const webuiData = await webuiPlan.json();
  assert.equal(webuiPlan.status, 409, JSON.stringify(webuiData));
  assert.match(webuiData.error || "", /manual|unproven|missing/i);

  const refusedApply = await fetch(`http://127.0.0.1:${webuiPort}/api/update/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionId: "legacy-refused-only", planDigest: digest }) });
  assert.equal(refusedApply.status, 404, "legacy per-agent journals must never authorize a native update");
  const missingReceipt = await fetch(`http://127.0.0.1:${webuiPort}/api/update/transactions/legacy-refused-only`);
  assert.equal(missingReceipt.status, 404);
  const rollback = await fetch(`http://127.0.0.1:${webuiPort}/api/update/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(rollback.status, 410);
  const legacy = await fetch(`http://127.0.0.1:${webuiPort}/api/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(legacy.status, 410);

  const getStatus = async () => (await (await fetch(`http://127.0.0.1:${webuiPort}/api/update-status`)).json()).data;
  assert.deepEqual((await getStatus()).nativeJobs, { pi: null, webui: null });
  const stateRoot = path.join(temp, process.platform === "win32" ? "AppData/Local/PiWebUI/updates" : ".local/state/pi-webui-updates");
  const transactionId = randomUUID();
  const jobDir = path.join(stateRoot, "jobs", transactionId);
  await mkdir(jobDir, { recursive: true });
  const receipt = { transactionId, id: "webui:npm-global", status: "failed", exitCode: 1, stderr: "fixture failure" };
  await writeFile(path.join(jobDir, "0.receipt.json"), JSON.stringify(receipt));
  await writeFile(path.join(jobDir, "complete.json"), JSON.stringify({ transactionId, receipts: [{ id: receipt.id, status: receipt.status }] }));
  await persistSharedJob(stateRoot, { transactionId, jobDir, phase: "partial", outcome: "partial", lock: { token: "fixture-private-lock-token" },
    plan: { schemaVersion: 2, transactionId, requested: "webui", createdAt: new Date().toISOString(), targets: [{ id: receipt.id }],
      context: { agentDir: await realpath(path.join(temp, "agent")), ownerPackageRoot: await realpath(root), ownerBootIdentity: health.bootIdentity } } });
  const discovered = await getStatus();
  assert.equal(discovered.nativeJobs.webui.transactionId, transactionId, "a new browser can discover the durable job without local storage");
  assert.equal(discovered.nativeJobs.webui.phase, "partial");
  assert.equal(discovered.nativeJobs.webui.receipts[0].stderr, "fixture failure");
  assert.equal(JSON.stringify(discovered).includes("fixture-private-lock-token"), false);
  assert.equal((await getStatus()).nativeJobs.webui.transactionId, transactionId, "reconnection retains the same partial result");
  await writeFile(path.join(stateRoot, "jobs", `${randomUUID()}.json`), "invalid private record");
  const unverified = await getStatus();
  assert.ok(unverified.nativeJobDiscoveryError);
  assert.equal(unverified.canRunUpdate, false, "discovery failure cannot authorize another update");
  assert.equal(unverified.nativeJobDiscoveryError.includes("invalid private record"), false, "corrupt record contents must not leak in the error");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => registry.close(resolve));
  await rm(temp, { recursive: true, force: true });
  await rm(piFixture, { recursive: true, force: true });
}
console.log("update API harness passed");
