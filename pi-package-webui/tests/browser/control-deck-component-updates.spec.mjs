import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin/pi-webui.mjs");
const fakePi = join(root, "tests/fixtures/fake-pi.mjs");
async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
let child, baseURL, tempRoot;
test.beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-component-updates-"));
  baseURL = `http://127.0.0.1:${await freePort()}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", new URL(baseURL).port, "--pi", fakePi], {
    stdio: "ignore",
    env: { ...process.env, PI_WEBUI_RPC_SUPERVISOR: "0", PI_WEBUI_UPDATE_TEST_HOME: join(tempRoot, "coordination"), PI_CODING_AGENT_DIR: join(tempRoot, "agent"), PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json") },
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("fixture server did not become healthy");
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(8_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(tempRoot, { recursive: true, force: true });
});

test("Pi and Web UI actions confirm independent native targets and show durable receipts", async ({ page }) => {
  const requests = [];
  const jobs = { pi: null, webui: null };
  const status = () => ({ updateAvailable: true, updateInProgress: Object.values(jobs).some((job) => job?.phase === "running"), canRunUpdate: !Object.values(jobs).some((job) => job?.phase === "running"), nativeJobs: jobs, nativeJobDiscoveryError: "", pi: { checked: true, currentVersion: "0.87.1", activeRuntimeVersion: "0.80.10", pathInstallationVersion: "0.87.1", latestVersion: "0.88.0", updateAvailable: true }, webui: { checked: true, currentVersion: "0.8.1", latestVersion: "0.8.2", updateAvailable: true } });
  await page.route("**/api/update-status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: status() }) }));
  await page.route("**/api/pi-release-notes", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { version: "0.88.0", body: "Fixture release notes" } }) }));
  const plan = (target) => ({ requested: target, transactionId: `fixture-${target}`, digest: "a".repeat(64), active: { pi: "0.80.10", piRoot: "/active/pi", webui: "0.8.1", webuiRoot: "/active/webui" }, pathPi: { eligible: true, version: "0.87.1", packageRoot: "/safe/path-pi", executable: "/usr/bin/node", cli: "/safe/path-pi/cli.js", guidance: "" }, context: { shell: "/bin/bash", cwd: "/safe/state", agentDir: "/safe/agent", npmPrefix: "/safe/prefix" }, targets: target === "pi" ? [{ id: "pi", packageName: "Pi", beforeVersion: "0.87.1", installedRoot: "/safe/path-pi", effectRoot: "/safe/prefix", command: { command: "/usr/bin/node", args: ["/safe/path-pi/cli.js", "update"] } }] : [{ id: "webui:npm-global", packageName: "Web UI", beforeVersion: "0.8.1", installedRoot: "/safe/npm/webui", effectRoot: "/safe/prefix", command: { command: "/usr/bin/node", args: ["/safe/npm-cli.js", "-g", "update", "@firstpick/pi-package-webui"] } }, { id: "webui:pi-user", packageName: "Web UI", beforeVersion: "0.8.1", installedRoot: "/safe/agent/npm/webui", effectRoot: "/safe/agent/npm", command: { command: "/usr/bin/node", args: ["/safe/path-pi/cli.js", "update", "--extension", "npm:@firstpick/pi-package-webui", "--no-approve"] } }], refusals: ["Project installation needs manual update."], warning: "Native lifecycle scripts run with existing configuration; not sandboxed." });
  await page.route("**/api/update/plan", (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, data: { plan: plan(body.targets[0]) } }) });
  });
  await page.route("**/api/update/apply", (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const target = body.transactionId.endsWith("pi") ? "pi" : "webui";
    jobs[target] = { transactionId: body.transactionId, plan: plan(target), phase: "running", receipts: [], verifiedTargets: [] };
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, data: { transactionId: body.transactionId, phase: "running" } }) });
  });
  await page.route("**/api/update/transactions/*", (route) => {
    const job = Object.values(jobs).find((item) => item?.transactionId === route.request().url().split("/").pop());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: job }) });
  });
  await page.goto(baseURL);
  await page.locator("#piVersionButton").click();
  await page.locator("#piComponentUpdateButton").click();
  await expect(page.locator("#confirmationSummary")).toContainText("/safe/path-pi/cli.js");
  await expect(page.locator("#confirmationSummary")).toContainText("0.80.10");
  await expect(page.locator("#confirmationSummary")).toContainText("Confirmed PATH Pi: 0.87.1 at /safe/path-pi");
  await expect(page.locator("#confirmationSummary")).toContainText("/safe/agent");
  await expect(page.locator("#confirmationSummary")).toContainText("Native lifecycle scripts");
  await page.locator("#confirmationConfirmButton").click();
  await expect(page.locator("#piComponentUpdateStatus")).toContainText("fixture-pi");
  await expect(page.locator("#piComponentUpdateStatus")).toHaveAttribute("data-update-running");
  jobs.pi = { ...jobs.pi, phase: "unchanged", receipts: [{ id: "pi", status: "unchanged", stdout: "Already current", stderr: "" }] };
  await expect(page.locator("#piComponentUpdateStatus")).toContainText("No automatic restart", { timeout: 8_000 });
  await expect(page.locator("#piComponentUpdateOutput")).toContainText("Already current");
  await page.locator("#piReleaseNotesCloseButton").click();
  await page.locator("#webuiVersionButton").click();
  await page.locator("#webuiComponentUpdateButton").click();
  await expect(page.locator("#confirmationSummary")).toContainText("/safe/npm/webui");
  await expect(page.locator("#confirmationSummary")).toContainText("/safe/agent/npm/webui");
  await expect(page.locator("#confirmationSummary")).toContainText("Confirmed PATH Pi: 0.87.1 at /safe/path-pi");
  await expect(page.locator("#confirmationSummary")).toContainText("Project installation needs manual update");
  await page.locator("#confirmationConfirmButton").click();
  jobs.webui = { ...jobs.webui, phase: "partial", outcome: "partial", receipts: [{ id: "webui:npm-global", status: "changed", stdout: "updated" }, { id: "webui:pi-user", status: "failed", stderr: "fixture failure" }], verifiedTargets: [{ id: "webui:npm-global", status: "healthy" }] };
  await expect(page.locator("#webuiComponentUpdateStatus")).toContainText("partial result", { timeout: 8_000 });
  await expect(page.locator("#webuiComponentUpdateOutput")).toContainText("fixture failure");
  assert.deepEqual(requests, [{ targets: ["pi"] }, { transactionId: "fixture-pi", planDigest: "a".repeat(64) }, { targets: ["webui"] }, { transactionId: "fixture-webui", planDigest: "a".repeat(64) }]);
});

test("ambiguous apply observes confirmed ID before authoritative discovery clears retry block", async ({ page }) => {
  let applyCount = 0;
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const plan = { requested: "pi", transactionId: "uncertain-pi-job", digest: "b".repeat(64),
    active: { pi: "0.80.10", piRoot: "/active/pi" }, pathPi: { eligible: true, version: "0.87.1", packageRoot: "/path/pi", executable: "/node", cli: "/path/pi/cli.js" },
    context: { cwd: "/state", agentDir: "/agent", shell: "/bin/bash", npmPrefix: "/prefix" },
    targets: [{ id: "pi", installedRoot: "/path/pi", effectRoot: "/prefix", beforeVersion: "0.87.1", command: { command: "/node", args: ["/path/pi/cli.js", "update"] } }], refusals: [], warning: "Lifecycle scripts run." };
  await page.route("**/api/update-status*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: {
    canRunUpdate: true, updateInProgress: false, nativeJobs: { pi: null, webui: null }, nativeJobDiscoveryError: "",
    pi: { currentVersion: "0.87.1", activeRuntimeVersion: "0.80.10", latestVersion: "0.88.0", checked: true, updateAvailable: true }, webui: {},
  } }) }));
  await page.route("**/api/pi-release-notes", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { version: "0.88.0", body: "Release notes" } }) }));
  await page.route("**/api/update/plan", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, data: { plan } }) }));
  await page.route("**/api/update/apply", (route) => { applyCount += 1; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Reply lost after launch attempt" }) }); });
  await page.route("**/api/update/transactions/*", async (route) => {
    await receiptGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { transactionId: plan.transactionId, plan, phase: "planned", receipts: [], verifiedTargets: [] } }) });
  });
  try {
    await page.goto(baseURL);
    await page.locator("#piVersionButton").click();
    await page.locator("#piComponentUpdateButton").click();
    await page.locator("#confirmationConfirmButton").click();
    await expect(page.locator("#piComponentUpdateButton")).toBeDisabled();
    await expect(page.locator("#piComponentUpdateStatus")).toContainText("uncertain-pi-job");
    assert.equal(applyCount, 1, "no second apply before job inspection");
  } finally { releaseReceipt(); }
  await expect(page.locator("#piComponentUpdateButton")).toBeEnabled({ timeout: 8_000 });
  assert.equal(applyCount, 1, "authoritative planned/no-running discovery does not apply automatically");
});
