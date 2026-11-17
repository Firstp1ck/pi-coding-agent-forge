import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child;
let baseURL;
let tempRoot;
let output = "";

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wait for the isolated real server and fake RPC fixture.
    }
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
}

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-guided-git-browser-"));
  const fakePi = join(tempRoot, "fake-pi.mjs");
  const logFile = join(tempRoot, "rpc.jsonl");
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
const logFile = process.env.GUIDED_GIT_BROWSER_LOG;
const fallbackSuccessFlag = process.env.GUIDED_GIT_BROWSER_FALLBACK_SUCCESS;
const artifactRoot = process.env.GUIDED_GIT_BROWSER_ARTIFACT_ROOT;
let model = { provider: "fake", id: "original" };
let thinkingLevel = "high";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function log(value) { appendFileSync(logFile, JSON.stringify(value) + "\\n"); }
function fallbackSuccessEnabled() { return existsSync(fallbackSuccessFlag); }
function event(value) { send(value); }
function writeCommitArtifacts() {
  const directory = join(artifactRoot, "dev", "COMMIT");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "staged-commit-short.txt"), "fallback short\\n");
  writeFileSync(join(directory, "staged-commit-long.txt"), "fallback long\\n");
}
const models = [
  { provider: "fake", id: "original", name: "Original", reasoning: true },
  { provider: "fake", id: "primary", name: "Primary", reasoning: true },
  { provider: "fake", id: "fallback", name: "Fallback", reasoning: false },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (!command?.id) return;
  const encodedProfile = command.type === "prompt" && command.message?.match(/--firstpick-webui-generation-profile=([A-Za-z0-9_-]+)/)?.[1];
  const generationProfile = encodedProfile ? JSON.parse(Buffer.from(encodedProfile, "base64url").toString("utf8")) : null;
  log({ type: command.type, modelId: command.modelId, activeModel: model.id, message: command.message, generationProfile });
  const response = { type: "response", id: command.id, command: command.type, success: true };
  if (command.type === "get_state") send({ ...response, data: { model, thinkingLevel, isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: "browser", sessionName: "browser" } });
  else if (command.type === "get_available_models") send({ ...response, data: { models } });
  else if (command.type === "get_commands") send({ ...response, data: { commands: [
    { name: "git-guided-workflow", source: "extension", description: "Start Guided Git" },
    { name: "git-staged-msg", source: "extension", description: "Generate commit messages" },
    { name: "git-branch-name", source: "extension", description: "Generate branch names" },
    { name: "pr", source: "extension", description: "Generate PR text" },
  ] } });
  else if (command.type === "get_messages") send({ ...response, data: { messages: [] } });
  else if (command.type === "set_model") { model = { provider: command.provider, id: command.modelId }; send({ ...response, data: model }); }
  else if (command.type === "set_thinking_level") { thinkingLevel = command.level; send({ ...response, data: { level: thinkingLevel } }); }
  else if (command.type === "prompt" && command.message === "/git-guided-workflow") {
    send({ ...response, data: {} });
    const statusKey = "git-guided-workflow:webui-start";
    const statusText = JSON.stringify({ type: "firstpick.pi-extension-git-guided-workflow.start", version: 1, action: "start", requestId: randomUUID() });
    event({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText });
    event({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey });
  }
  else if (generationProfile?.modelId === "primary" && fallbackSuccessEnabled()) {
    send({ ...response, data: {} });
    setTimeout(() => event({ type: "extension_error", event: "command", extensionPath: "command:git-staged-msg", error: "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE fixture failure" }), 20);
  }
  else if (generationProfile?.modelId === "primary") send({ ...response, success: false, error: "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE SECRET primary failure at /private/provider.mjs:12" });
  else if (generationProfile?.modelId === "fallback" && !fallbackSuccessEnabled()) send({ ...response, success: false, error: "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE SECRET fallback failure at /private/provider.mjs:44" });
  else if (generationProfile?.modelId === "fallback") {
    setTimeout(writeCommitArtifacts, 450);
    setTimeout(() => send({ ...response, data: {} }), 600);
  }
  else send({ ...response, data: {} });
});
`, "utf8");
  await chmod(fakePi, 0o755);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: tempRoot }).status, 0);
  await writeFile(join(tempRoot, "guided-git-browser.txt"), "browser fixture\n", "utf8");
  const settingsFile = join(tempRoot, "settings.json");
  await writeFile(settingsFile, `${JSON.stringify({
    version: 8,
    gitWorkflow: {
      reviewProcessEnabled: false,
      stagingPolicy: "all",
      generation: {
        provider: "fake",
        modelId: "primary",
        thinkingLevel: "low",
        unavailablePolicy: "ask",
        fallback: { provider: "fake", modelId: "fallback", thinkingLevel: "off" },
      },
    },
  }, null, 2)}\n`, "utf8");
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: settingsFile,
      GUIDED_GIT_BROWSER_LOG: logFile,
      GUIDED_GIT_BROWSER_FALLBACK_SUCCESS: join(tempRoot, "fallback-success"),
      GUIDED_GIT_BROWSER_ARTIFACT_ROOT: tempRoot,
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitForServer();
});

test.afterAll(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

test("pre-response fallback lifecycle survives correlation and remains browser-observation-only", async ({ page }) => {
  const browserModelRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/prompt", "/api/model", "/api/thinking"].includes(pathname)) {
      browserModelRequests.push({ pathname, body: request.postDataJSON() });
    }
  });
  await page.route("**/api/commands?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { commands: [
        { name: "git-guided-workflow", source: "extension", description: "Start Guided Git" },
        { name: "git-staged-msg", source: "extension", description: "Generate commit messages" },
        { name: "git-branch-name", source: "extension", description: "Generate branch names" },
        { name: "pr", source: "extension", description: "Generate PR text" },
      ] } }),
    });
  });
  await page.goto(baseURL);
  const guidedGit = page.locator("#gitWorkflowButton");
  await expect(guidedGit).toBeVisible();
  await expect(guidedGit).toBeEnabled();
  await guidedGit.click();

  const panel = page.locator("#gitWorkflowPanel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Run git add ." }).click();
  await expect(panel.getByRole("button", { name: "Generate commit message" })).toBeVisible();
  await panel.getByRole("button", { name: "Generate commit message" }).click();

  const outputText = page.locator("#gitWorkflowOutput");
  await expect(outputText).toContainText("Generation continued with the fallback fake/fallback");
  await expect(outputText).toContainText("The fallback Git-writing model fake/fallback at off effort also failed");
  await expect(outputText).toContainText("Guided Git generation failed after the configured model attempts.");
  await expect(outputText).not.toContainText("SECRET");
  await expect(outputText).not.toContainText("/private/provider.mjs");

  const log = (await import("node:fs/promises")).readFile(join(tempRoot, "rpc.jsonl"), "utf8");
  const entries = (await log).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.type === "prompt" && entry.generationProfile?.modelId === "fallback").length, 1, "the browser must not dispatch another fallback prompt");
  assert.deepEqual(entries.filter((entry) => entry.generationProfile).map((entry) => entry.generationProfile), [
    { version: 1, provider: "fake", modelId: "primary", thinkingLevel: "low" },
    { version: 1, provider: "fake", modelId: "fallback", thinkingLevel: "off" },
  ]);
  assert.equal(entries.filter((entry) => ["set_model", "set_thinking_level"].includes(entry.type)).length, 0, "browser generation must leave model and effort changes to the extension");
  assert.equal(browserModelRequests.length, 1, "the browser may activate the extension but must not dispatch generation attempts or model changes");
  assert.equal(browserModelRequests[0].pathname, "/api/prompt");
  assert.equal(browserModelRequests[0].body.message, "/git-guided-workflow");
});

test("a slow successful fallback opens the generated message preview automatically", async ({ page }) => {
  await writeFile(join(tempRoot, "fallback-success"), "enabled\n", "utf8");
  await page.route("**/app.js?v=*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    assert.match(source, /GIT_WORKFLOW_MESSAGE_POLL_TIMEOUT_MS = 30_000/);
    await route.fulfill({ response, body: source.replace("GIT_WORKFLOW_MESSAGE_POLL_TIMEOUT_MS = 30_000", "GIT_WORKFLOW_MESSAGE_POLL_TIMEOUT_MS = 100") });
  });
  await page.route("**/api/commands?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { commands: [
        { name: "git-guided-workflow", source: "extension", description: "Start Guided Git" },
        { name: "git-staged-msg", source: "extension", description: "Generate commit messages" },
        { name: "git-branch-name", source: "extension", description: "Generate branch names" },
        { name: "pr", source: "extension", description: "Generate PR text" },
      ] } }),
    });
  });
  await page.goto(baseURL);
  await page.locator("#gitWorkflowButton").click();

  const panel = page.locator("#gitWorkflowPanel");
  await panel.getByRole("button", { name: "Run git add ." }).click();
  await panel.getByRole("button", { name: "Generate commit message" }).click();

  const outputText = page.locator("#gitWorkflowOutput");
  await expect(outputText).toContainText("fallback short");
  await expect(outputText).toContainText("fallback long");
  await expect(panel.getByRole("button", { name: "Commit short (default)", exact: true })).toBeVisible();
  await expect(outputText).not.toContainText("Preview current message files");
});
