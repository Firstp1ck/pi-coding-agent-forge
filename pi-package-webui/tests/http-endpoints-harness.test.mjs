import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentRunRegistry } from "../lib/agent-run-registry.mjs";
import { terminateProcessTree } from "../lib/process-tree.mjs";
import { deriveSupervisorRecoveryToken } from "../lib/rpc-supervisor-protocol.mjs";
import { readSupervisorState, supervisorPaths, supervisorPidIsAlive } from "../lib/rpc-supervisor-state.mjs";
import { REQUIRED_THEME_TOKENS, serializeTheme } from "../public/theme-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const port = 30000 + Math.floor(Math.random() * 20000);
const optionalFeatureFocus = process.env.PI_WEBUI_OPTIONAL_FEATURES_FOCUS === "1";

function themeFixture(name, color = "#123456") {
  return {
    name,
    colors: Object.fromEntries(REQUIRED_THEME_TOKENS.map((token) => [token, color])),
    export: { pageBg: color, cardBg: color, infoBg: color },
  };
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

async function request(host, pathname, { method = "GET", body, headers = {}, timeoutMs = 5_000 } = {}) {
  const response = await fetch(`http://${host}:${port}${pathname}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { status: response.status, body: payload, headers: response.headers };
}

async function waitForSseEvent(tabId, predicate, trigger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timed out waiting for SSE event")), 8_000);
  let triggerResult;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events?tab=${encodeURIComponent(tabId)}`, { signal: controller.signal });
    assert.equal(response.status, 200, "SSE connection should open");
    const triggerPromise = trigger ? Promise.resolve().then(trigger) : Promise.resolve(undefined);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (predicate(event)) {
          triggerResult = await triggerPromise;
          controller.abort();
          return { event, triggerResult };
        }
      }
    }
    throw new Error("SSE stream ended before the expected event");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function rmWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EPERM" && error?.code !== "ENOTEMPTY") throw error;
      await delay(Math.min(500, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function pathExists(target) {
  return !!(await stat(target).catch(() => null));
}

async function readJsonLines(target) {
  const text = await readFile(target, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function runGitFixture(args, cwd, message) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pi WebUI Test",
      GIT_AUTHOR_EMAIL: "pi-webui-test@example.invalid",
      GIT_COMMITTER_NAME: "Pi WebUI Test",
      GIT_COMMITTER_EMAIL: "pi-webui-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, `${message}\n$ git ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

const cwd = await mkdtemp(path.join(tmpdir(), "pi-webui-http-harness-"));
const harnessSideEffectsRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-http-harness-side-effects-"));
const coordinationHome = await mkdtemp(path.join(tmpdir(), "pi-webui-http-coordination-"));
const settingsFile = path.join(harnessSideEffectsRoot, "webui-settings.json");
const workflowPolicyAgentDir = path.join(harnessSideEffectsRoot, "agent");
const agentRunStateHome = path.join(harnessSideEffectsRoot, "state");
const agentRunRegistry = new AgentRunRegistry({ agentDir: workflowPolicyAgentDir, port, stateHome: agentRunStateHome });
const managedThemePackageRoot = path.join(workflowPolicyAgentDir, "npm", "node_modules", "@firstpick", "pi-themes-bundle");
const managedThemeDir = path.join(managedThemePackageRoot, "themes");
const workflowPolicyFile = path.join(workflowPolicyAgentDir, "workflow-policy.json");
const sessionSummaryConfigFile = path.join(workflowPolicyAgentDir, "session-summary.json");
const canonicalWorkflowPolicySuggestions = {
  shellAllowlist: ["git", "node", "npm"],
  networkAllowlist: ["api.github.com", "registry.npmjs.org"],
  verificationCommands: [["npm", "test"], ["npm", "run", "lint"]],
};
const openCommandLog = path.join(harnessSideEffectsRoot, "open-default.log");
const fakePiCommandLog = path.join(harnessSideEffectsRoot, "fake-pi-commands.jsonl");
const fakePiCliLog = path.join(harnessSideEffectsRoot, "fake-pi-cli.jsonl");
const fakePiCli = path.join(harnessSideEffectsRoot, "fake-pi-cli.mjs");
const recoveryEndpointToken = "test-recovery-token-6e1cc61d22d44c8dbf3c";
const openCommandScript = path.join(harnessSideEffectsRoot, "fake-open-default.mjs");
const fakeOpenBinDir = path.join(harnessSideEffectsRoot, "bin");
const artifactRoot = path.join(harnessSideEffectsRoot, "artifacts"), artifactDir = path.join(artifactRoot, "fixture-document-artifact"), artifactManifest = path.join(artifactDir, "manifest.json"), artifactDownload = path.join(artifactDir, "document.docx"), artifactPage = path.join(artifactDir, "page-1.png"), artifactExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
await mkdir(artifactDir, { recursive: true });
await writeFile(artifactDownload, Buffer.from("fixture docx download bytes"));
await writeFile(artifactPage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
await writeFile(artifactManifest, JSON.stringify({ artifact: { schema: "pi.artifact/v1", kind: "document", id: "fixture-document-artifact", revisionId: "fixture-revision", title: "fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pageCount: 1, manifestPath: artifactManifest, downloadPath: artifactDownload, expiresAt: artifactExpiresAt }, sourcePath: "/private/source.docx", sourceSha256: "a".repeat(64), renderer: { engine: "fixture" }, pages: [{ pageNum: 1, width: 10, height: 20, outputPath: artifactPage }], warnings: [] }));
await mkdir(managedThemeDir, { recursive: true });
await writeFile(path.join(managedThemePackageRoot, "package.json"), JSON.stringify({ name: "@firstpick/pi-themes-bundle", version: "0.0.0-test", pi: { themes: ["./themes"] } }));
await writeFile(path.join(managedThemeDir, "managed-fixture.json"), serializeTheme(themeFixture("managed-fixture")));
await writeFile(path.join(workflowPolicyAgentDir, "trust.json"), `${JSON.stringify({ [cwd]: true }, null, 2)}\n`);
await chmod(fakePi, 0o755);
await mkdir(fakeOpenBinDir, { recursive: true });
await writeFile(openCommandScript, `#!/usr/bin/env node\nimport { appendFile } from "node:fs/promises";\nawait appendFile(process.env.PI_WEBUI_OPEN_LOG, "custom-open\\t" + process.argv.slice(2).join("\\t") + "\\n", "utf8");\n`, "utf8");
await chmod(openCommandScript, 0o755);
await writeFile(path.join(fakeOpenBinDir, "xdg-open"), `#!/usr/bin/env node\nimport { appendFile } from "node:fs/promises";\nawait appendFile(process.env.PI_WEBUI_OPEN_LOG, "xdg-open\\t" + process.argv.slice(2).join("\\t") + "\\n", "utf8");\n`, "utf8");
await writeFile(path.join(fakeOpenBinDir, "gio"), `#!/usr/bin/env node\nimport { appendFile } from "node:fs/promises";\nawait appendFile(process.env.PI_WEBUI_OPEN_LOG, "gio\\t" + process.argv.slice(2).join("\\t") + "\\n", "utf8");\n`, "utf8");
await writeFile(path.join(fakeOpenBinDir, "xdg-mime"), `#!/usr/bin/env node\nconst [,, verb, mode, value = ""] = process.argv;\nif (verb === "query" && mode === "filetype") {\n  if (value.endsWith(".piunknown")) console.log("application/x-pi-unknown");\n  else if (value.endsWith(".md")) console.log("text/markdown");\n  else console.log("text/plain");\n  process.exit(0);\n}\nif (verb === "query" && mode === "default") {\n  if (value === "text/plain") console.log("fake-text-editor.desktop");\n  process.exit(0);\n}\nprocess.exit(1);\n`, "utf8");
await Promise.all(["xdg-open", "gio", "xdg-mime"].map((name) => chmod(path.join(fakeOpenBinDir, name), 0o755)));
await writeFile(fakePiCli, `#!/usr/bin/env node
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const log = async (entry) => appendFile(process.env.FAKE_PI_CLI_LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\\n", "utf8");
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
if (args[0] === "--version") {
  console.log("0.84.0");
} else if (args[0] === "install") {
  const source = String(args[1] || "");
  await log({ event: "start", args });
  if (source === "npm:@firstpick/pi-extension-stats") {
    console.error("fixture Pi install failure for stats");
    await log({ event: "finish", args, exitCode: 17 });
    process.exitCode = 17;
  } else {
    const packageName = source.startsWith("npm:") ? source.slice(4) : "";
    const sourceRoot = path.join(${JSON.stringify(path.dirname(root))}, packageName.split("/").at(-1));
    const installRoot = path.join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", ...packageName.split("/"));
    await mkdir(path.dirname(installRoot), { recursive: true });
    await rm(installRoot, { recursive: true, force: true });
    await cp(sourceRoot, installRoot, { recursive: true });
    const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    if (!packages.some((entry) => (typeof entry === "string" ? entry : entry?.source) === source)) packages.push(source);
    settings.packages = packages;
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\\n", "utf8");
    console.log("installed " + source);
    await log({ event: "finish", args, exitCode: 0 });
  }
} else {
  await log({ event: "rpc", args });
  await import(${JSON.stringify(pathToFileURL(fakePi).href)});
}
`, "utf8");
await chmod(fakePiCli, 0o755);

const latestPiVersion = "999.0.0";
const voiceProviderRequests = [];
const voiceProvider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  voiceProviderRequests.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], bodyLength: body.length });
  if (req.url === "/stt") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "fake transcript from local stt" }));
    return;
  }
  if (req.url === "/tts") {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from("fake mp3 bytes"));
    return;
  }
  if (req.url === "/pi-latest") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: latestPiVersion, packageName: "@earendil-works/pi-coding-agent" }));
    return;
  }
  if (req.url?.startsWith("/pi-releases/")) {
    const tagName = decodeURIComponent(req.url.slice("/pi-releases/".length));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      tag_name: tagName,
      name: `Pi ${tagName} test release`,
      body: "## Highlights\n\n- Release notes from the test GitHub endpoint.",
      published_at: "2026-07-16T12:00:00Z",
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => voiceProvider.listen(0, "127.0.0.1", resolve));
const voiceProviderPort = voiceProvider.address().port;

const startupRegistryNow = Date.now();
const startupRegistryProducers = ["startup-running", "startup-stale", "startup-lost", "startup-done"];
for (const [producerId, status, updatedAt] of [
  ["startup-running", "running", startupRegistryNow],
  ["startup-stale", "stale", startupRegistryNow - 60_000],
  ["startup-lost", "running", startupRegistryNow - 180_000],
  ["startup-done", "done", startupRegistryNow - 5_000],
]) {
  const terminal = status === "done";
  await agentRunRegistry.writeRecord(producerId, {
    version: 1,
    instanceId: producerId,
    runId: `${producerId}-run`,
    parentSessionId: null,
    launcher: "sdk",
    provider: "webui-registry",
    origin: "startup-regression-fixture",
    name: producerId,
    status,
    startedAt: updatedAt - 1_000,
    updatedAt,
    endedAt: terminal ? updatedAt : null,
    capabilities: { open: false, refresh: false, cancel: false, steer: false },
    outputRef: { kind: "none" },
  }, { recordId: `${producerId}-record` });
}

const child = spawn(process.execPath, [serverScript, "--cwd", cwd, "--host", "0.0.0.0", "--port", String(port), "--pi", fakePiCli], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Pi WebUI Test",
    GIT_AUTHOR_EMAIL: "pi-webui-test@example.invalid",
    GIT_COMMITTER_NAME: "Pi WebUI Test",
    GIT_COMMITTER_EMAIL: "pi-webui-test@example.invalid",
    PATH: `${fakeOpenBinDir}${path.delimiter}${process.env.PATH || ""}`,
    PI_CODING_AGENT_DIR: workflowPolicyAgentDir,
    NODE_ENV: "test",
    PI_WEBUI_UPDATE_TEST_HOME: coordinationHome,
    XDG_STATE_HOME: agentRunStateHome,
    PI_WEBUI_SETTINGS_FILE: settingsFile,
    PI_SESSION_SUMMARY_CONFIG_FILE: sessionSummaryConfigFile,
    PI_WEBUI_RPC_SUPERVISOR: "1",
    ...(process.platform === "linux" ? {} : { PI_WEBUI_OPEN_COMMAND: openCommandScript }),
    PI_WEBUI_OPEN_LOG: openCommandLog,
    PI_WEBUI_ARTIFACT_ROOTS: artifactRoot,
    FAKE_PI_ARTIFACT_MANIFEST: artifactManifest,
    FAKE_PI_ARTIFACT_DOWNLOAD: artifactDownload,
    FAKE_PI_LOG_FILE: fakePiCommandLog,
    FAKE_PI_CLI_LOG: fakePiCliLog,
    FAKE_PI_VOICE_SCRIPTS: "1",
    FAKE_PI_LARGE_PAYLOADS: "1",
    PI_WEBUI_RECOVERY_TOKEN: recoveryEndpointToken,
    PI_VOICE_STT_URL: `http://127.0.0.1:${voiceProviderPort}/stt`,
    PI_VOICE_TTS_URL: `http://127.0.0.1:${voiceProviderPort}/tts`,
    PI_WEBUI_PI_LATEST_VERSION_URL: `http://127.0.0.1:${voiceProviderPort}/pi-latest`,
    PI_WEBUI_PI_RELEASES_API_BASE_URL: `http://127.0.0.1:${voiceProviderPort}/pi-releases`,
  },
});
let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
child.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

async function verifyTopLevelOptionalFeatureProtection(tabId) {
  const extensionsDir = path.join(workflowPolicyAgentDir, "extensions");
  const aliasPath = path.join(extensionsDir, "aur-review-local");
  await mkdir(extensionsDir, { recursive: true });
  await rm(aliasPath, { recursive: true, force: true });
  await symlink(path.join(path.dirname(root), "pi-extension-aur-review"), aliasPath, process.platform === "win32" ? "junction" : "dir");
  try {
    const recheckResponse = await request("127.0.0.1", "/api/optional-feature-migration/recheck", { method: "POST", body: {} });
    assert.equal(recheckResponse.status, 200, recheckResponse.body?.error);
    const statusResponse = await request("127.0.0.1", "/api/optional-features");
    const status = statusResponse.body?.data?.features?.find(({ featureId }) => featureId === "aurReview");
    assert.equal(statusResponse.status, 200);
    assert.equal(status?.configured, false, "a top-level resource should remain distinct from package registration");
    assert.equal(status?.locallyConfigured, true, "an enabled top-level resource should be recognized as locally configured");
    assert.equal(status?.ready, true, "an installed top-level resource should be ready without duplicate package registration");
    assert.equal(status?.resourceConflict, false);
    assert.equal(Object.hasOwn(status || {}, "installedRoot"), false, "browser audit payloads must not expose install paths");
    assert.equal(Object.hasOwn(status || {}, "topLevelResources"), false, "browser audit payloads must not expose resource paths");
    assert.equal(status?.state, "local-resource");

    const logOffset = (await readJsonLines(fakePiCliLog)).length;
    const installResponse = await request("127.0.0.1", "/api/optional-feature-install", {
      method: "POST",
      body: { tab: tabId, featureId: "aurReview" },
    });
    assert.equal(installResponse.status, 409, "npm registration should be blocked before it can duplicate an enabled top-level resource");
    assert.equal(installResponse.body?.optionalFeatureInstall?.kind, "local-resource-conflict");
    assert.equal((await readJsonLines(fakePiCliLog)).length, logOffset, "a blocked duplicate registration must not launch Pi install");
  } finally {
    await rm(aliasPath, { recursive: true, force: true });
    await request("127.0.0.1", "/api/optional-feature-migration/recheck", { method: "POST", body: {} });
  }
}

async function runOptionalFeatureFocus() {
  const tabs = await request("127.0.0.1", "/api/tabs");
  const tabId = tabs.body?.data?.tabs?.[0]?.id;
  assert.ok(tabId, "focused optional-feature checks require the startup tab");

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.optionalDependencies, { "node-pty": "^1.1.0" });
  assert.equal(manifest.dependencies?.["@firstpick/pi-utils"], "^0.2.5");
  assert.equal(JSON.stringify(manifest.pi).includes("node_modules/@firstpick"), false);

  const initial = await request("127.0.0.1", "/api/optional-features");
  assert.equal(initial.status, 200);
  assert.equal(initial.body?.data?.features?.length, 20);
  const aurBefore = initial.body?.data?.features?.find(({ featureId }) => featureId === "aurReview");
  assert.deepEqual({ installed: aurBefore?.installed, configured: aurBefore?.configured, ready: aurBefore?.ready }, { installed: true, configured: false, ready: false });
  assert.equal(aurBefore?.expectedSpec, "^0.1.1");
  await verifyTopLevelOptionalFeatureProtection(tabId);

  const single = await request("127.0.0.1", "/api/optional-feature-install", {
    method: "POST",
    body: { tab: tabId, featureId: "aurReview" },
    timeoutMs: 10_000,
  });
  assert.equal(single.status, 200, single.body?.error);
  assert.match(single.body?.data?.command || "", /install npm:@firstpick\/pi-extension-aur-review$/);
  assert.deepEqual({
    installed: single.body?.data?.status?.installed,
    configured: single.body?.data?.status?.configured,
    ready: single.body?.data?.status?.ready,
  }, { installed: true, configured: true, ready: true });

  const conflictExtensionsDir = path.join(workflowPolicyAgentDir, "extensions");
  const conflictAliasPath = path.join(conflictExtensionsDir, "aur-review-conflict");
  await mkdir(conflictExtensionsDir, { recursive: true });
  await symlink(path.join(path.dirname(root), "pi-extension-aur-review"), conflictAliasPath, process.platform === "win32" ? "junction" : "dir");
  try {
    const conflictAudit = await request("127.0.0.1", "/api/optional-feature-migration/recheck", { method: "POST", body: {} });
    const conflictFeature = conflictAudit.body?.data?.features?.find(({ featureId }) => featureId === "aurReview");
    assert.equal(conflictFeature?.state, "conflict");
    assert.equal(conflictFeature?.resourceConflict, true);
    const conflictTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "conflict-safe optional package" } });
    assert.equal(conflictTab.status, 201, conflictTab.body?.error);
    const conflictRpcArgs = (await readJsonLines(fakePiCliLog)).filter(({ event }) => event === "rpc").at(-1)?.args || [];
    const normalizedConflictArgs = conflictRpcArgs.map((arg) => String(arg).replace(/\\/g, "/"));
    assert.equal(normalizedConflictArgs.some((arg) => arg.includes("/extensions/aur-review-conflict/")), false, "conflicting top-level alias must be excluded from RPC args");
    assert.equal(normalizedConflictArgs.filter((arg) => arg.endsWith("/pi-extension-aur-review/index.ts")).length, 1, "registered package remains canonical during a conflict");
    await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [conflictTab.body?.data?.tab?.id] } });
  } finally {
    await rm(conflictAliasPath, { recursive: true, force: true });
    await request("127.0.0.1", "/api/optional-feature-migration/recheck", { method: "POST", body: {} });
  }

  const summaryFileAlias = path.join(workflowPolicyAgentDir, "extensions", "session-summary.ts");
  await mkdir(path.dirname(summaryFileAlias), { recursive: true });
  await symlink(path.join(root, "session-summary.ts"), summaryFileAlias);
  try {
    const resourceTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "configured optional package" } });
    assert.equal(resourceTab.status, 201, resourceTab.body?.error);
    const rpcArgs = (await readJsonLines(fakePiCliLog)).filter(({ event }) => event === "rpc").at(-1)?.args || [];
    const normalizedArgs = rpcArgs.map((arg) => String(arg).replace(/\\/g, "/"));
    const normalizedSummaryAlias = summaryFileAlias.replace(/\\/g, "/");
    assert.equal(normalizedArgs.filter((arg) => arg.endsWith("/pi-extension-aur-review/index.ts")).length, 1);
    assert.equal(normalizedArgs.filter((arg) => arg.endsWith("/pi-package-webui/index.ts")).length, 1);
    assert.equal(normalizedArgs.filter((arg) => arg.endsWith("/pi-package-webui/session-summary.ts")).length, 1, "the started WebUI package should contribute one canonical summary extension");
    assert.equal(normalizedArgs.includes(normalizedSummaryAlias), false, "a top-level file symlink into the WebUI package must not duplicate the canonical summary extension");
    await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [resourceTab.body?.data?.tab?.id] } });
  } finally {
    await rm(summaryFileAlias, { force: true });
  }

  const batchPlan = await request("127.0.0.1", "/api/optional-features");
  const batchRevision = batchPlan.body?.data?.revision;
  assert.match(batchRevision || "", /^sha256:[a-f0-9]{64}$/);
  assert.equal((await request("127.0.0.1", "/api/optional-feature-install-batch", { method: "POST", body: { tab: tabId, revision: batchRevision, featureIds: "aurReview" } })).status, 400);
  assert.equal((await request("127.0.0.1", "/api/optional-feature-install-batch", { method: "POST", body: { tab: tabId, revision: batchRevision, featureIds: ["not-allowlisted"] } })).status, 400);
  assert.equal((await request("127.0.0.1", "/api/optional-feature-install-batch", { method: "POST", body: { tab: tabId, revision: batchRevision, featureIds: Array(20).fill("aurReview") } })).status, 400);
  assert.equal((await request("127.0.0.1", "/api/optional-feature-install-batch", { method: "POST", body: { tab: tabId, revision: "sha256:stale", featureIds: ["aurReview"] } })).status, 409);

  const logOffset = (await readJsonLines(fakePiCliLog)).length;
  const batch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: batchRevision, featureIds: ["bangCommandAutocomplete", "statsCommand", "bangCommandAutocomplete", "gitFooterStatus"] },
    timeoutMs: 20_000,
  });
  assert.equal(batch.status, 200, batch.body?.error);
  assert.deepEqual(batch.body?.data?.featureIds, ["bangCommandAutocomplete", "statsCommand", "gitFooterStatus"]);
  assert.deepEqual(batch.body?.data?.results?.map(({ featureId, ok }) => [featureId, ok]), [
    ["bangCommandAutocomplete", true], ["statsCommand", false], ["gitFooterStatus", true],
  ]);
  assert.deepEqual([batch.body?.data?.total, batch.body?.data?.succeeded, batch.body?.data?.failed], [3, 2, 1]);
  assert.equal(batch.body?.data?.results?.[1]?.optionalFeatureInstall?.exitCode, 17);
  assert.match(batch.body?.data?.results?.[1]?.optionalFeatureInstall?.outputTail || "", /fixture Pi install failure/);
  const sequence = (await readJsonLines(fakePiCliLog)).slice(logOffset).filter(({ event }) => event === "start" || event === "finish");
  assert.deepEqual(sequence.map(({ event, args, exitCode }) => [event, args?.[1], exitCode]), [
    ["start", "npm:@firstpick/pi-extension-bang-command-autocomplete", undefined],
    ["finish", "npm:@firstpick/pi-extension-bang-command-autocomplete", 0],
    ["start", "npm:@firstpick/pi-extension-stats", undefined],
    ["finish", "npm:@firstpick/pi-extension-stats", 17],
    ["start", "npm:@firstpick/pi-extension-git-footer-status", undefined],
    ["finish", "npm:@firstpick/pi-extension-git-footer-status", 0],
  ]);

  const progressSnapshot = (await request("127.0.0.1", "/api/optional-features")).body?.data;
  assert.equal(progressSnapshot?.phase, "partial");
  assert.deepEqual([progressSnapshot?.progress?.succeeded, progressSnapshot?.progress?.failed], [2, 1]);
  assert.equal(progressSnapshot?.progress?.results?.length, 3);

  const rpcLaunchCountBeforeSuccess = (await readJsonLines(fakePiCliLog)).filter(({ event }) => event === "rpc").length;
  const successfulBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: progressSnapshot.revision, featureIds: ["releaseAur"] },
    timeoutMs: 20_000,
  });
  assert.equal(successfulBatch.status, 200, successfulBatch.body?.error);
  assert.deepEqual(successfulBatch.body?.data?.restart, { autoRestarted: true, restartDeferred: false });
  let rpcLaunchCountAfterSuccess = rpcLaunchCountBeforeSuccess;
  for (let attempt = 0; attempt < 20 && rpcLaunchCountAfterSuccess === rpcLaunchCountBeforeSuccess; attempt++) {
    await delay(50);
    rpcLaunchCountAfterSuccess = (await readJsonLines(fakePiCliLog)).filter(({ event }) => event === "rpc").length;
  }
  assert.equal(rpcLaunchCountAfterSuccess, rpcLaunchCountBeforeSuccess + 1, "an idle tab should restart automatically after a fully successful batch");
  const completedSnapshot = (await request("127.0.0.1", "/api/optional-features")).body?.data;
  assert.equal(completedSnapshot?.phase, "complete");
  assert.equal(completedSnapshot?.progress?.autoRestarted, true);

  const lanHost = lanAddress();
  if (lanHost) assert.equal((await request(lanHost, "/api/optional-feature-install-batch", { method: "POST", body: { tab: tabId, revision: batchRevision, featureIds: ["aurReview"] } })).status, 403);

  const shutdownResponse = await request("127.0.0.1", "/api/shutdown", { method: "POST", body: {} });
  assert.equal(shutdownResponse.status, 200);
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(100);
  assert.notEqual(child.exitCode, null);
}

try {
  // Wait for the HTTP server to accept requests.
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      health = await request("127.0.0.1", "/api/health", { timeoutMs: 1_000 });
      if (health.status === 200) break;
    } catch {
      // Server not listening yet.
    }
    await delay(200);
  }
  assert.equal(health?.status, 200, `server should become healthy, output:\n${serverOutput}`);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.piRunning, true, "fake pi RPC process should be attached and running");
  assert.match(health.body.piVersion, /^\d+\.\d+\.\d+/, "health metadata should expose the installed Pi version");

  const startupSubagents = await request("127.0.0.1", "/api/subagents");
  const startupExternalAgents = startupSubagents.body?.data?.groups
    ?.find((group) => group.id === "external")?.runs
    ?.flatMap((run) => run.agents.map((agent) => ({ name: agent.name, status: agent.status }))) || [];
  assert.deepEqual(startupExternalAgents, [{ name: "startup-running", status: "running" }], "startup should attach only active registry agents, not pre-existing stale, lost, or completed records");
  await Promise.all(startupRegistryProducers.map((producer) => rm(path.join(agentRunRegistry.paths.root, producer), { recursive: true, force: true })));

  const managedThemesResponse = await request("127.0.0.1", "/api/themes");
  assert.equal(managedThemesResponse.status, 200, managedThemesResponse.body?.error);
  assert.equal(managedThemesResponse.body?.data?.source, "@firstpick/pi-themes-bundle");
  assert.deepEqual(managedThemesResponse.body?.data?.themes?.map(({ name }) => name), ["managed-fixture"], "themes installed only under PI_CODING_AGENT_DIR/npm/node_modules should be exposed to the browser");
  assert.equal(managedThemesResponse.body?.data?.themes?.[0]?.colors?.accent, "#123456");
  assert.equal(managedThemesResponse.body?.data?.themes?.[0]?.scope, "bundled");

  const themeTabs = await request("127.0.0.1", "/api/tabs");
  const themeTabId = themeTabs.body?.data?.tabs?.[0]?.id;
  assert.ok(themeTabId, "custom theme endpoint checks require the startup tab");
  const customThemePath = `/api/themes/custom?tab=${encodeURIComponent(themeTabId)}`;
  const globalTheme = themeFixture("global-fixture", "#224466");
  const createdGlobalTheme = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "global-fixture.json", theme: globalTheme, overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(createdGlobalTheme.status, 201, createdGlobalTheme.body?.error);
  assert.deepEqual({ created: createdGlobalTheme.body?.data?.created, overwritten: createdGlobalTheme.body?.data?.overwritten }, { created: true, overwritten: false });
  assert.equal(Object.hasOwn(createdGlobalTheme.body?.data || {}, "path"), false, "theme save responses must not disclose host paths");
  const globalThemeFile = path.join(workflowPolicyAgentDir, "themes", "global-fixture.json");
  assert.equal(await readFile(globalThemeFile, "utf8"), serializeTheme(globalTheme), "global themes must use canonical Pi JSON bytes");
  if (process.platform !== "win32") assert.equal((await stat(globalThemeFile)).mode & 0o777, 0o600, "saved themes must have private permissions");

  const projectTheme = themeFixture("project-fixture", "#335577");
  const createdProjectTheme = await request("127.0.0.1", customThemePath, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-site" },
    body: { scope: "project", fileName: "project-fixture.json", theme: projectTheme, overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(createdProjectTheme.status, 201, createdProjectTheme.body?.error);
  assert.equal(await readFile(path.join(cwd, ".pi", "themes", "project-fixture.json"), "utf8"), serializeTheme(projectTheme));

  const customCatalog = await request("127.0.0.1", `/api/themes?tab=${encodeURIComponent(themeTabId)}`);
  assert.equal(customCatalog.status, 200);
  assert.deepEqual(customCatalog.body?.data?.themes?.map(({ name }) => name), ["managed-fixture", "global-fixture", "project-fixture"]);
  assert.deepEqual(customCatalog.body?.data?.themes?.map(({ scope }) => scope), ["bundled", "global", "project"]);
  assert.equal(customCatalog.body?.data?.scopes?.project?.trusted, true);

  const bundledCollision = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "managed-fixture.json", theme: themeFixture("managed-fixture"), overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(bundledCollision.status, 409);
  assert.equal(bundledCollision.body?.code, "THEME_NAME_COLLISION");
  const oppositeScopeCollision = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "project-fixture.json", theme: projectTheme, overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(oppositeScopeCollision.status, 409);
  assert.equal(oppositeScopeCollision.body?.code, "THEME_NAME_COLLISION");

  const existingGlobalTheme = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "global-fixture.json", theme: globalTheme, overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(existingGlobalTheme.status, 409);
  assert.equal(existingGlobalTheme.body?.code, "THEME_EXISTS");
  assert.deepEqual(
    { scope: existingGlobalTheme.body?.details?.scope, fileName: existingGlobalTheme.body?.details?.fileName },
    { scope: "global", fileName: "global-fixture.json" },
  );
  assert.equal(typeof existingGlobalTheme.body?.details?.mtimeMs, "number");
  await delay(25);
  await writeFile(globalThemeFile, serializeTheme(themeFixture("global-fixture", "#446688")), { mode: 0o600 });
  const staleOverwrite = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "global-fixture.json", theme: globalTheme, overwrite: true, expectedMtimeMs: existingGlobalTheme.body.details.mtimeMs },
  });
  assert.equal(staleOverwrite.status, 409);
  assert.equal(staleOverwrite.body?.code, "THEME_CHANGED");
  assert.equal(await readFile(globalThemeFile, "utf8"), serializeTheme(themeFixture("global-fixture", "#446688")), "a stale overwrite must preserve current bytes");
  const refreshedConflict = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "global-fixture.json", theme: globalTheme, overwrite: false, expectedMtimeMs: null },
  });
  const overwrittenGlobalTheme = await request("127.0.0.1", customThemePath, {
    method: "POST",
    body: { scope: "global", fileName: "global-fixture.json", theme: globalTheme, overwrite: true, expectedMtimeMs: refreshedConflict.body?.details?.mtimeMs },
  });
  assert.equal(overwrittenGlobalTheme.status, 200, overwrittenGlobalTheme.body?.error);
  assert.deepEqual({ created: overwrittenGlobalTheme.body?.data?.created, overwritten: overwrittenGlobalTheme.body?.data?.overwritten }, { created: false, overwritten: true });
  assert.equal(await readFile(globalThemeFile, "utf8"), serializeTheme(globalTheme));
  assert.equal((await readdir(path.dirname(globalThemeFile))).some((name) => name.endsWith(".tmp")), false, "atomic theme saves must clean temporary artifacts");

  const rejectedThemeBodies = [
    { body: { scope: "global", fileName: "bad-name.json", theme: themeFixture("different-name"), overwrite: false, expectedMtimeMs: null }, code: "THEME_NAME_MISMATCH" },
    { body: { scope: "global", fileName: "path-field.json", theme: themeFixture("path-field"), overwrite: false, expectedMtimeMs: null, path: "/tmp/escape" }, code: "THEME_REQUEST_INVALID" },
    { body: { scope: "elsewhere", fileName: "scope.json", theme: themeFixture("scope"), overwrite: false, expectedMtimeMs: null }, code: "THEME_SCOPE_INVALID" },
    { body: { scope: "global", fileName: "invalid.json", theme: { name: "invalid", colors: {} }, overwrite: false, expectedMtimeMs: null }, code: "THEME_INVALID" },
  ];
  for (const { body, code } of rejectedThemeBodies) {
    const rejected = await request("127.0.0.1", customThemePath, { method: "POST", body });
    assert.equal(rejected.status, 400, rejected.body?.error);
    assert.equal(rejected.body?.code, code);
  }
  const nonJsonTheme = await fetch(`http://127.0.0.1:${port}${customThemePath}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(nonJsonTheme.status, 415);
  const crossSiteTheme = await request("127.0.0.1", customThemePath, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
    body: { scope: "global", fileName: "cross-site.json", theme: themeFixture("cross-site"), overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(crossSiteTheme.status, 403);
  assert.equal(crossSiteTheme.body?.code, "THEME_CROSS_SITE_BLOCKED");
  const malformedThemeJson = await fetch(`http://127.0.0.1:${port}${customThemePath}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(malformedThemeJson.status, 400);
  assert.equal((await malformedThemeJson.json()).code, "THEME_JSON_INVALID");
  const oversizedTheme = await fetch(`http://127.0.0.1:${port}${customThemePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(257 * 1024) }),
  });
  assert.equal(oversizedTheme.status, 413);

  const untrustedThemeCwd = await mkdtemp(path.join(harnessSideEffectsRoot, "untrusted-theme-"));
  const untrustedTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: untrustedThemeCwd, title: "untrusted theme fixture" } });
  assert.equal(untrustedTab.status, 201, untrustedTab.body?.error);
  const untrustedTabId = untrustedTab.body?.data?.tab?.id;
  const untrustedSave = await request("127.0.0.1", `/api/themes/custom?tab=${encodeURIComponent(untrustedTabId)}`, {
    method: "POST",
    body: { scope: "project", fileName: "untrusted.json", theme: themeFixture("untrusted"), overwrite: false, expectedMtimeMs: null },
  });
  assert.equal(untrustedSave.status, 403);
  assert.equal(untrustedSave.body?.code, "THEME_PROJECT_UNTRUSTED");
  assert.equal(await pathExists(path.join(untrustedThemeCwd, ".pi", "themes")), false, "untrusted project saves must not create .pi/themes");
  await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [untrustedTabId] } });

  const outsideTheme = path.join(harnessSideEffectsRoot, "outside-theme.json");
  await writeFile(outsideTheme, "outside bytes", "utf8");
  const symlinkThemeTarget = path.join(workflowPolicyAgentDir, "themes", "symlink-fixture.json");
  try {
    await symlink(outsideTheme, symlinkThemeTarget);
    const symlinkSave = await request("127.0.0.1", customThemePath, {
      method: "POST",
      body: { scope: "global", fileName: "symlink-fixture.json", theme: themeFixture("symlink-fixture"), overwrite: false, expectedMtimeMs: null },
    });
    assert.equal(symlinkSave.status, 409);
    assert.equal(symlinkSave.body?.code, "THEME_UNSAFE_TARGET");
    assert.equal(await readFile(outsideTheme, "utf8"), "outside bytes", "theme saves must never follow a target symlink");
  } catch (error) {
    if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
    console.log(`http-endpoints-harness: symlink unavailable (${error.code}); skipping theme target symlink check`);
  } finally {
    await rm(symlinkThemeTarget, { force: true });
  }

  const symlinkProjectCwd = await mkdtemp(path.join(harnessSideEffectsRoot, "symlink-theme-project-"));
  const outsideProjectPi = await mkdtemp(path.join(harnessSideEffectsRoot, "outside-project-pi-"));
  const symlinkProjectPi = path.join(symlinkProjectCwd, ".pi");
  let symlinkProjectTabId;
  try {
    await symlink(outsideProjectPi, symlinkProjectPi, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(workflowPolicyAgentDir, "trust.json"), `${JSON.stringify({ [cwd]: true, [symlinkProjectCwd]: true }, null, 2)}\n`);
    const symlinkProjectTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: symlinkProjectCwd, title: "symlink theme project" } });
    assert.equal(symlinkProjectTab.status, 201, symlinkProjectTab.body?.error);
    symlinkProjectTabId = symlinkProjectTab.body?.data?.tab?.id;
    const symlinkProjectSave = await request("127.0.0.1", `/api/themes/custom?tab=${encodeURIComponent(symlinkProjectTabId)}`, {
      method: "POST",
      body: { scope: "project", fileName: "escaped.json", theme: themeFixture("escaped"), overwrite: false, expectedMtimeMs: null },
    });
    assert.equal(symlinkProjectSave.status, 409);
    assert.equal(symlinkProjectSave.body?.code, "THEME_UNSAFE_TARGET");
    assert.equal(await pathExists(path.join(outsideProjectPi, "themes")), false, "a symlinked .pi directory must not receive theme writes");
  } catch (error) {
    if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
    console.log(`http-endpoints-harness: directory symlink unavailable (${error.code}); skipping theme root symlink check`);
  } finally {
    if (symlinkProjectTabId) await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [symlinkProjectTabId] } });
    await rm(symlinkProjectPi, { force: true });
  }

  const themeLanHost = lanAddress();
  if (themeLanHost) {
    const remoteThemeSave = await request(themeLanHost, customThemePath, {
      method: "POST",
      body: { scope: "global", fileName: "remote.json", theme: themeFixture("remote"), overwrite: false, expectedMtimeMs: null },
    });
    assert.equal(remoteThemeSave.status, 403, "custom theme saves must be localhost-only");
  }
  // Keep this focused persistence fixture out of the later git-workflow fixture.
  await rm(path.join(cwd, ".pi"), { recursive: true, force: true });

  if (optionalFeatureFocus) {
    await runOptionalFeatureFocus();
  } else {
  const summaryTabs = await request("127.0.0.1", "/api/tabs");
  const summaryTabId = summaryTabs.body?.data?.tabs?.[0]?.id;
  assert.ok(summaryTabId, "session-summary endpoint checks require the startup tab");

  const samplingPath = `/api/tabs/${encodeURIComponent(summaryTabId)}/sampling-parameters`;
  const initialSampling = await request("127.0.0.1", samplingPath);
  assert.equal(initialSampling.status, 200, initialSampling.body?.error);
  assert.equal(initialSampling.headers.get("cache-control"), "private, no-store");
  assert.equal(initialSampling.body?.data?.support?.supported, true);
  assert.equal(initialSampling.body?.data?.support?.api, "openai-completions");
  assert.deepEqual(initialSampling.body?.data?.support?.model, { provider: "fake", id: "fake-model", name: "Fake Model" });
  assert.equal(initialSampling.body?.data?.support?.parameters?.temperature?.supported, true);
  assert.equal(initialSampling.body?.data?.support?.parameters?.top_k?.supported, false);
  assert.equal(initialSampling.body?.data?.support?.parameters?.min_p?.source, "unsupported");
  assert.ok(Array.isArray(initialSampling.body?.data?.support?.compatibleApis), "legacy support diagnostics must remain available");

  const savedSampling = await request("127.0.0.1", samplingPath, {
    method: "PUT",
    body: { temperature: 0.3, top_k: 32, vendor_mode: "strict" },
  });
  assert.equal(savedSampling.status, 200, savedSampling.body?.error);
  assert.deepEqual(savedSampling.body?.data?.session, { temperature: 0.3, top_k: 32, vendor_mode: "strict" });
  assert.deepEqual(savedSampling.body?.data?.effective, { temperature: 0.3 }, "unsupported stored sampling values must remain inert");
  assert.equal(savedSampling.body?.data?.support?.parameters?.top_k?.supported, false);
  const resetSampling = await request("127.0.0.1", samplingPath, { method: "PUT", body: {} });
  assert.equal(resetSampling.status, 200, resetSampling.body?.error);
  assert.deepEqual(resetSampling.body?.data?.session, {});
  assert.deepEqual(resetSampling.body?.data?.effective, { temperature: 0.7 });

  const summaryPath = `/api/session-summary/preferences?tab=${encodeURIComponent(summaryTabId)}`;
  const initialSummaryPreferences = await request("127.0.0.1", summaryPath);
  assert.equal(initialSummaryPreferences.status, 200, initialSummaryPreferences.body?.error);
  assert.equal(initialSummaryPreferences.headers.get("cache-control"), "private, no-store", "summary preferences must not be cached by shared or browser caches");
  assert.equal(initialSummaryPreferences.body?.data?.version, 1);
  assert.equal(initialSummaryPreferences.body?.data?.preferences?.configured, false, "first read should not silently save setup defaults");
  assert.deepEqual(initialSummaryPreferences.body?.data?.models?.map(({ provider, id }) => [provider, id]), [["fake", "fake-model"]]);
  assert.deepEqual(initialSummaryPreferences.body?.data?.modelThinkingLevels?.["fake/fake-model"], ["off"]);
  assert.match(initialSummaryPreferences.body?.data?.disclosure?.scope || "", /user text, final assistant text, and tool names only/i);
  assert.equal(await pathExists(sessionSummaryConfigFile), false, "reading unconfigured summary setup must not create a preference file");

  const unconfiguredSummaryGenerate = await request("127.0.0.1", `/api/session-summary/generate?tab=${encodeURIComponent(summaryTabId)}`, { method: "POST", body: { refresh: true } });
  assert.equal(unconfiguredSummaryGenerate.status, 409, "direct generation must not bypass explicit setup confirmation");
  assert.match(unconfiguredSummaryGenerate.body?.error || "", /setup must be confirmed/i);

  const nonJsonSummarySave = await fetch(`http://127.0.0.1:${port}${summaryPath}`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(nonJsonSummarySave.status, 415, "summary setup must reject cross-origin-simple content types");
  const crossSiteSummarySave = await fetch(`http://127.0.0.1:${port}${summaryPath}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ confirmed: true, preferences: {} }),
  });
  assert.equal(crossSiteSummarySave.status, 403, "summary setup must reject explicit cross-site mutations");
  const unconfirmedSummarySave = await request("127.0.0.1", summaryPath, { method: "PUT", body: { confirmed: false, preferences: {} } });
  assert.equal(unconfirmedSummarySave.status, 409, "summary setup must require explicit privacy and cost confirmation");
  assert.equal(await pathExists(sessionSummaryConfigFile), false, "rejected summary setup must not persist defaults");

  const validSummaryPreferences = {
    enabled: true,
    model: { provider: "fake", modelId: "fake-model", thinkingLevel: "off" },
    prompts: { title: "Fixture title prompt", summary: "Fixture Markdown summary prompt" },
    input: { scope: "text-and-tool-names" },
    context: { injectLatest: false },
    title: { enabled: true, minSettledTurns: 3 },
  };
  const invalidSummaryShape = await request("127.0.0.1", summaryPath, {
    method: "PUT",
    body: { confirmed: true, preferences: { ...validSummaryPreferences, credentials: "forbidden" } },
  });
  assert.equal(invalidSummaryShape.status, 400, "summary setup must reject unknown fields rather than retaining secrets or future client authority");
  const invalidSummaryModel = await request("127.0.0.1", summaryPath, {
    method: "PUT",
    body: { confirmed: true, preferences: { ...validSummaryPreferences, model: { provider: "fake", modelId: "missing", thinkingLevel: "off" } } },
  });
  assert.equal(invalidSummaryModel.status, 400, "summary setup must validate against the active tab's authenticated model registry");
  const savedSummaryPreferences = await request("127.0.0.1", summaryPath, {
    method: "PUT",
    body: { confirmed: true, preferences: validSummaryPreferences },
  });
  assert.equal(savedSummaryPreferences.status, 200, savedSummaryPreferences.body?.error);
  assert.equal(savedSummaryPreferences.headers.get("cache-control"), "private, no-store");
  assert.equal(savedSummaryPreferences.body?.data?.preferences?.configured, true);
  assert.equal(savedSummaryPreferences.body?.data?.summary?.configured, true);
  const summaryReplay = await waitForSseEvent(summaryTabId, (event) => event.type === "webui_session_summary" && event.kind === "replay");
  assert.equal(summaryReplay.event.tabId, summaryTabId, "summary replay must remain scoped to the requested tab");
  assert.equal(summaryReplay.event.summary?.configured, true);
  assert.equal(Object.hasOwn(summaryReplay.event, "preferences"), false, "summary SSE replay must not expose setup prompts or model preferences");
  const persistedSummaryPreferences = JSON.parse(await readFile(sessionSummaryConfigFile, "utf8"));
  assert.equal(persistedSummaryPreferences.configured, true);
  assert.equal(persistedSummaryPreferences.model.modelId, "fake-model");
  assert.equal(Object.hasOwn(persistedSummaryPreferences, "credentials"), false, "summary preferences must not persist credentials");
  if (process.platform !== "win32") assert.equal((await stat(sessionSummaryConfigFile)).mode & 0o777, 0o600, "summary preferences must be private");
  persistedSummaryPreferences.credentials = "fixture-secret-must-not-cross-http";
  persistedSummaryPreferences.model.providerToken = "fixture-provider-token";
  await writeFile(sessionSummaryConfigFile, `${JSON.stringify(persistedSummaryPreferences, null, 2)}\n`, { mode: 0o600 });
  const sanitizedSummaryPreferences = await request("127.0.0.1", summaryPath);
  assert.equal(sanitizedSummaryPreferences.status, 200);
  assert.equal(Object.hasOwn(sanitizedSummaryPreferences.body?.data?.preferences || {}, "credentials"), false, "unknown persisted keys must not cross the browser API boundary");
  assert.equal(Object.hasOwn(sanitizedSummaryPreferences.body?.data?.preferences?.model || {}, "providerToken"), false, "unknown nested model keys must not cross the browser API boundary");
  assert.equal(JSON.parse(await readFile(sessionSummaryConfigFile, "utf8")).credentials, "fixture-secret-must-not-cross-http", "sanitized reads must not destroy unknown future persisted keys");

  const summaryPromptCountBefore = (await readJsonLines(fakePiCommandLog)).filter(({ direction, type, message }) => direction === "command" && type === "prompt" && String(message || "").startsWith("/summary")).length;
  const unavailableSummaryGenerate = await request("127.0.0.1", `/api/session-summary/generate?tab=${encodeURIComponent(summaryTabId)}`, { method: "POST", body: { refresh: true } });
  assert.equal(unavailableSummaryGenerate.status, 409, "generation should fail closed when /summary is absent from the active tab command catalog");
  const summaryPromptCountAfter = (await readJsonLines(fakePiCommandLog)).filter(({ direction, type, message }) => direction === "command" && type === "prompt" && String(message || "").startsWith("/summary")).length;
  assert.equal(summaryPromptCountAfter, summaryPromptCountBefore, "an unavailable summary command must not start a model-facing agent prompt");
  const malformedSummaryGenerate = await request("127.0.0.1", `/api/session-summary/generate?tab=${encodeURIComponent(summaryTabId)}`, { method: "POST", body: { refresh: "yes" } });
  assert.equal(malformedSummaryGenerate.status, 400, "summary refresh must be a strict boolean");
  const oversizedSummarySave = await fetch(`http://127.0.0.1:${port}${summaryPath}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: true, padding: "x".repeat(33 * 1024) }),
  });
  assert.equal(oversizedSummarySave.status, 413, "summary mutations over 32 KiB must be rejected before validation");

  const initialInterfacePreferences = await request("127.0.0.1", "/api/interface-preferences");
  assert.equal(initialInterfacePreferences.status, 200);
  assert.equal(initialInterfacePreferences.body?.data?.preferences?.sidePanelWidth, null, "a user without a saved width should receive the default preference");
  assert.equal(initialInterfacePreferences.body?.data?.layout?.version, 3);
  assert.deepEqual(initialInterfacePreferences.body?.data?.layout?.sidePanel?.sectionLayout, { order: null, leftSectionIds: null });
  assert.match(initialInterfacePreferences.body?.data?.layoutRevision || "", /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(initialInterfacePreferences.body?.data || {}, "path"), false, "preference responses must not disclose the user's settings-file path");
  const initialLayoutRevision = initialInterfacePreferences.body.data.layoutRevision;

  const savedInterfacePreferences = await request("127.0.0.1", "/api/interface-preferences", {
    method: "PUT",
    body: { sidePanelWidth: 612.4 },
  });
  assert.equal(savedInterfacePreferences.status, 200);
  assert.equal(savedInterfacePreferences.body?.data?.preferences?.sidePanelWidth, 612, "saved side-panel widths should be normalized to whole pixels");
  assert.equal(savedInterfacePreferences.body?.data?.layoutRevision, initialLayoutRevision, "width-only compatibility writes must not revise layout state");
  assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).interfacePreferences?.sidePanelWidth, 612, "the side-panel width should be saved in the private user settings file");
  const reloadedInterfacePreferences = await request("127.0.0.1", "/api/interface-preferences");
  assert.equal(reloadedInterfacePreferences.body?.data?.preferences?.sidePanelWidth, 612, "the saved width should survive subsequent user preference reads");
  const invalidInterfacePreferences = await request("127.0.0.1", "/api/interface-preferences", {
    method: "PUT",
    body: { sidePanelWidth: 100 },
  });
  assert.equal(invalidInterfacePreferences.status, 400, "out-of-range side-panel widths should be rejected");
  assert.equal((await request("127.0.0.1", "/api/interface-preferences")).body?.data?.preferences?.sidePanelWidth, 612, "invalid saves must preserve the last valid user width");

  const savedLayout = await request("127.0.0.1", "/api/interface-preferences", {
    method: "PUT",
    body: {
      sidePanelWidth: 620,
      expectedLayoutRevision: initialLayoutRevision,
      layout: {
        version: 3,
        sidePanel: {
          placement: "both",
          sectionLayout: { order: ["files", "controls", "git"], leftSectionIds: ["files"] },
          collapsedSectionIds: ["git"],
          hiddenSectionIds: [],
          collapsedPanels: { left: false, right: false },
          panelWidths: { left: 384, right: 620 },
        },
        composerActions: { order: ["new", "git", "send"], grid: { version: 2, columns: 12, positions: { new: 0, git: 1, send: 10 } } },
        footerScopedModelOrder: ["openai-codex/gpt-5.6-sol"],
        terminalTabs: { layout: "left", customGroups: { version: 1, groups: [{ id: "group-1", title: "Group 1", tabIds: ["tab-a", "tab-b"] }] }, sidebarWidth: 288 },
        fileViewerWidth: 560,
      },
    },
  });
  assert.equal(savedLayout.status, 200, savedLayout.body?.error);
  assert.equal(savedLayout.body?.data?.preferences?.sidePanelWidth, 620);
  assert.equal(savedLayout.body?.data?.layout?.sidePanel?.panelWidths?.right, 620, "one locked PUT must expose matching v3 right and legacy widths");
  assert.deepEqual(savedLayout.body?.data?.layout?.sidePanel?.sectionLayout, { order: ["files", "controls", "git"], leftSectionIds: ["files"] });
  assert.deepEqual(savedLayout.body?.data?.layout?.composerActions?.order, ["new", "git", "send"]);
  assert.equal(savedLayout.body?.data?.layout?.terminalTabs?.layout, "left");
  assert.equal(savedLayout.body?.data?.layout?.terminalTabs?.sidebarWidth, 288);
  assert.notEqual(savedLayout.body?.data?.layoutRevision, initialLayoutRevision);
  assert.equal(JSON.stringify(savedLayout.body).includes(settingsFile), false, "successful layout responses must not disclose the settings path");
  const savedLayoutRevision = savedLayout.body.data.layoutRevision;
  const persistedLayoutSettings = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persistedLayoutSettings.version, 8);
  assert.equal(persistedLayoutSettings.interfacePreferences.sidePanelWidth, 620);
  assert.equal(persistedLayoutSettings.uiLayout.sidePanel.panelWidths.right, 620, "the v3 right width and legacy mirror must persist atomically");
  assert.equal(persistedLayoutSettings.uiLayout.fileViewerWidth, 560);
  assert.deepEqual(persistedLayoutSettings.uiLayout.composerActions.grid.positions, { new: 0, git: 1, send: 10 });

  const staleLayout = await request("127.0.0.1", "/api/interface-preferences", {
    method: "PUT",
    body: { expectedLayoutRevision: initialLayoutRevision, layout: { sidePanel: { collapsedPanels: { right: true } } } },
  });
  assert.equal(staleLayout.status, 409, "stale layout revisions must be rejected without mutation");
  assert.equal(JSON.stringify(staleLayout.body).includes(settingsFile), false, "conflict errors must not disclose the settings path");
  assert.equal((await request("127.0.0.1", "/api/interface-preferences")).body?.data?.layout?.sidePanel?.collapsedPanels?.right, false);

  const partialLayout = await request("127.0.0.1", "/api/interface-preferences", {
    method: "PUT",
    body: { expectedLayoutRevision: savedLayoutRevision, layout: { sidePanel: { collapsedPanels: { right: true } }, fileViewerWidth: null } },
  });
  assert.equal(partialLayout.status, 200, partialLayout.body?.error);
  assert.deepEqual(partialLayout.body?.data?.layout?.sidePanel?.collapsedPanels, { left: false, right: true });
  assert.deepEqual(partialLayout.body?.data?.layout?.sidePanel?.sectionLayout, { order: ["files", "controls", "git"], leftSectionIds: ["files"] }, "partial layout patches must preserve omitted fields");
  assert.deepEqual(partialLayout.body?.data?.layout?.sidePanel?.panelWidths, { left: 384, right: 620 });
  assert.equal(partialLayout.body?.data?.layout?.fileViewerWidth, null);
  assert.deepEqual(partialLayout.body?.data?.layout?.composerActions?.order, ["new", "git", "send"]);

  const invalidLayoutBodies = [
    { layout: { sidePanel: { collapsedPanels: { right: false } } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { version: 1, sidePanel: { collapsed: false } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { sidePanel: { placement: "center" } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { sidePanel: { sectionLayout: { order: ["files", "files"], leftSectionIds: [] } } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { sidePanel: { sectionLayout: { order: ["files"], leftSectionIds: ["git"] } } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { sidePanel: { panelWidths: { right: 100 } } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { composerActions: { order: ["send"] } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { unknown: true } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { terminalTabs: { layout: "bottom" } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { terminalTabs: { sidebarWidth: 100 } } },
    { expectedLayoutRevision: partialLayout.body.data.layoutRevision, layout: { fileViewerWidth: 1 } },
    { sidePanelWidth: 700, unexpected: true },
    {},
  ];
  for (const body of invalidLayoutBodies) {
    const invalid = await request("127.0.0.1", "/api/interface-preferences", { method: "PUT", body });
    assert.equal(invalid.status, 400, `invalid layout input must fail closed: ${JSON.stringify(body)}`);
  }
  const afterInvalidLayout = await request("127.0.0.1", "/api/interface-preferences");
  assert.equal(afterInvalidLayout.body?.data?.layoutRevision, partialLayout.body.data.layoutRevision, "invalid requests must not mutate layout state");
  assert.equal(afterInvalidLayout.body?.data?.preferences?.sidePanelWidth, 620, "invalid mixed requests must not mutate width state");

  const wrongContentType = await fetch(`http://127.0.0.1:${port}/api/interface-preferences`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ sidePanelWidth: 700 }),
  });
  assert.equal(wrongContentType.status, 415, "non-JSON layout writes must be rejected");
  const malformedJson = await fetch(`http://127.0.0.1:${port}/api/interface-preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformedJson.status, 400, "malformed JSON must be rejected as client input");
  const oversizedLayout = await fetch(`http://127.0.0.1:${port}/api/interface-preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
  });
  assert.equal(oversizedLayout.status, 413, "layout request bodies over 32 KiB must be rejected before validation");

  // Workflow policy setup is server-scoped: missing policy reads as canonical
  // deny-default state without creating PI_CODING_AGENT_DIR or its policy file.
  const missingWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy");
  assert.equal(missingWorkflowPolicy.status, 200, `missing workflow policy should load: ${missingWorkflowPolicy.body?.error || ""}`);
  assert.equal(missingWorkflowPolicy.body?.data?.filePath, workflowPolicyFile, "workflow policy path must use server-derived PI_CODING_AGENT_DIR");
  assert.equal(missingWorkflowPolicy.body?.data?.exists, false, "missing workflow policy should report absent state");
  assert.equal(missingWorkflowPolicy.body?.data?.revision, null, "missing workflow policy should have no revision");
  assert.deepEqual(missingWorkflowPolicy.body?.data?.policy, {
    schemaVersion: 1,
    permissions: { write: false, shell: false, network: false },
    shellAllowlist: [],
    networkAllowlist: [],
    verificationCommands: [],
  }, "missing workflow policy should expose canonical deny defaults");
  assert.deepEqual(missingWorkflowPolicy.body?.data?.suggestions, canonicalWorkflowPolicySuggestions, "workflow policy GET should expose the canonical advisory catalog");
  assert.equal(await pathExists(workflowPolicyFile), false, "workflow policy GET must not create a missing file");

  const workflowPolicyToSave = {
    schemaVersion: 1,
    permissions: { write: true, shell: true, network: false },
    shellAllowlist: [" npm ", "git", "npm"],
    networkAllowlist: ["https://registry.npmjs.org", "https://npmjs.org"],
    verificationCommands: [["npm", "test"], ["node", "--check", "bin/pi-webui.mjs"]],
  };
  const savedWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: workflowPolicyToSave, expectedRevision: missingWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(savedWorkflowPolicy.status, 200, `workflow policy save should succeed: ${savedWorkflowPolicy.body?.error || ""}`);
  assert.equal(savedWorkflowPolicy.body?.data?.filePath, workflowPolicyFile);
  assert.equal(savedWorkflowPolicy.body?.data?.exists, true);
  assert.match(savedWorkflowPolicy.body?.data?.revision || "", /^sha256:[a-f0-9]{64}$/, "saved workflow policy should expose a content revision");
  assert.deepEqual(savedWorkflowPolicy.body?.data?.policy?.shellAllowlist, ["git", "npm"], "canonical writer should normalize workflow shell allowlists");
  const persistedWorkflowPolicy = JSON.parse(await readFile(workflowPolicyFile, "utf8"));
  assert.deepEqual(persistedWorkflowPolicy, savedWorkflowPolicy.body?.data?.policy, "workflow policy file should contain exactly the canonical saved policy");
  assert.equal(Object.hasOwn(savedWorkflowPolicy.body?.data?.policy || {}, "suggestions"), false, "saved v1 response policy must not persist advisory suggestions");
  assert.equal(Object.hasOwn(persistedWorkflowPolicy, "suggestions"), false, "saved v1 file must not persist advisory suggestions");
  if (process.platform !== "win32") assert.equal((await stat(workflowPolicyFile)).mode & 0o777, 0o600, "workflow policy file must be private");

  const readWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy");
  assert.equal(readWorkflowPolicy.status, 200, `saved workflow policy should reload: ${readWorkflowPolicy.body?.error || ""}`);
  assert.equal(readWorkflowPolicy.body?.data?.revision, savedWorkflowPolicy.body?.data?.revision, "workflow policy read should preserve the saved revision");
  assert.deepEqual(readWorkflowPolicy.body?.data?.policy, savedWorkflowPolicy.body?.data?.policy, "workflow policy read should preserve canonical data");
  assert.equal(Object.hasOwn(readWorkflowPolicy.body?.data?.policy || {}, "suggestions"), false, "read v1 policy must not expose persisted advisory suggestions");

  const clientSelectedPolicyPath = path.join(harnessSideEffectsRoot, "client-selected-workflow-policy.json");
  const clientPathWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: workflowPolicyToSave, expectedRevision: savedWorkflowPolicy.body?.data?.revision, agentDir: clientSelectedPolicyPath },
  });
  assert.equal(clientPathWorkflowPolicy.status, 400, "workflow policy save must reject a client-selected target path");
  assert.equal(await pathExists(clientSelectedPolicyPath), false, "client-selected workflow policy path must never be written");

  const unknownWorkflowPolicyField = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: { ...workflowPolicyToSave, unsupported: true }, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(unknownWorkflowPolicyField.status, 400, "workflow policy save must reject canonical unknown fields");

  const malformedWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: { ...workflowPolicyToSave, permissions: { ...workflowPolicyToSave.permissions, shell: "yes" } }, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(malformedWorkflowPolicy.status, 400, "workflow policy save must reject malformed canonical policy values");

  const staleWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: workflowPolicyToSave, expectedRevision: missingWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(staleWorkflowPolicy.status, 409, "workflow policy save must reject a stale read revision");

  const nonJsonWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: { policy: workflowPolicyToSave, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(nonJsonWorkflowPolicy.status, 415, "workflow policy saves must reject cross-origin-simple non-JSON content types");

  const crossOriginWorkflowPolicy = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
    body: { policy: workflowPolicyToSave, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(crossOriginWorkflowPolicy.status, 403, "workflow policy saves must reject browser cross-origin requests");

  const updateStatus = await request("127.0.0.1", "/api/update-status?refresh=1");
  assert.equal(updateStatus.status, 200);
  const expectedReleaseVersion = updateStatus.body?.data?.pi?.updateAvailable
    ? latestPiVersion : updateStatus.body?.data?.pi?.currentVersion || updateStatus.body?.data?.pi?.activeRuntimeVersion;
  assert.match(expectedReleaseVersion, /^\d+\.\d+\.\d+$/, "release identity must come from the confirmed PATH or active Pi installation");
  const releaseNotes = await request("127.0.0.1", "/api/pi-release-notes");
  assert.equal(releaseNotes.status, 200, `Pi release notes should load through the server: ${releaseNotes.body?.error || ""}`);
  assert.equal(releaseNotes.body?.data?.version, expectedReleaseVersion, "Pi release notes must follow the PATH-versus-active identity in update status");
  assert.equal(releaseNotes.body?.data?.tagName, `v${expectedReleaseVersion}`);
  assert.equal(releaseNotes.body?.data?.title, `Pi v${expectedReleaseVersion} test release`);
  assert.match(releaseNotes.body?.data?.body || "", /Release notes from the test GitHub endpoint/);
  assert.equal(releaseNotes.body?.data?.url, `https://github.com/earendil-works/pi/releases/tag/v${expectedReleaseVersion}`);
  assert.equal(releaseNotes.headers.get("cache-control"), "private, no-store", "browser caches should not retain notes across Pi upgrades");
  const cachedReleaseNotes = await request("127.0.0.1", "/api/pi-release-notes");
  assert.equal(cachedReleaseNotes.body?.data?.tagName, `v${expectedReleaseVersion}`);
  assert.equal(voiceProviderRequests.filter((item) => item.url === `/pi-releases/v${expectedReleaseVersion}`).length, 1, "the selected Pi release should be fetched only once");
  if (!updateStatus.body?.data?.pi?.updateAvailable) {
    assert.equal(voiceProviderRequests.filter((item) => item.url === `/pi-releases/v${latestPiVersion}`).length, 0,
      "an unproven PATH Pi must not be presented as updatable");
  }

  // Static assets: brotli/gzip compression plus ETag revalidation (P0-2).
  const brotliResponse = await fetch(`http://127.0.0.1:${port}/app.js`, {
    headers: { "accept-encoding": "br, gzip" },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(brotliResponse.status, 200);
  assert.equal(brotliResponse.headers.get("content-encoding"), "br", "app.js should be served brotli-compressed");
  assert.equal(brotliResponse.headers.get("cache-control"), "no-cache", "static assets should allow ETag revalidation");
  assert.equal(brotliResponse.headers.get("vary"), "Accept-Encoding");
  const appEtag = brotliResponse.headers.get("etag");
  assert.ok(appEtag, "app.js response should carry an ETag");
  // Node fetch transparently decompresses; equal size proves the brotli
  // round-trip reproduced the exact raw asset.
  const appBody = await brotliResponse.arrayBuffer();
  const rawAppSize = (await stat(join(root, "public", "app.js"))).size;
  assert.equal(appBody.byteLength, rawAppSize, "decompressed app.js should match the raw file byte-for-byte in size");

  const conditionalResponse = await fetch(`http://127.0.0.1:${port}/app.js`, {
    headers: { "if-none-match": appEtag },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(conditionalResponse.status, 304, "matching If-None-Match should return 304");
  await conditionalResponse.arrayBuffer();

  const gzipResponse = await fetch(`http://127.0.0.1:${port}/styles.css`, {
    headers: { "accept-encoding": "gzip" },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(gzipResponse.status, 200);
  assert.equal(gzipResponse.headers.get("content-encoding"), "gzip", "styles.css should fall back to gzip");
  await gzipResponse.arrayBuffer();

  // Every literal same-origin module imported by app.js is startup-critical.
  // Derive the set so adding a new import without a server allowlist entry fails
  // this harness before it can ship as a blank browser UI.
  const appSource = await readFile(join(root, "public", "app.js"), "utf8");
  const startupModuleNames = [...new Set([...appSource.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']\.\/([^"'?]+)(?:\?[^"']*)?["']/g)].map((match) => match[1]))];
  assert.ok(startupModuleNames.length >= 1, "the startup-module harness should discover app.js imports");
  const startupHosts = [...new Set(["127.0.0.1", lanAddress()].filter(Boolean))];
  for (const host of startupHosts) {
    for (const moduleName of startupModuleNames) {
      const response = await fetch(`http://${host}:${port}/${moduleName}`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${moduleName} is imported by app.js and must be served by the WebUI on ${host}`);
      assert.match(response.headers.get("content-type") || "", /text\/javascript/, `${moduleName} should use a JavaScript MIME type on ${host}`);
      assert.equal(await response.text(), await readFile(join(root, "public", moduleName), "utf8"), `served startup module ${moduleName} must match its source file on ${host}`);
    }
  }
  assert.ok(startupModuleNames.includes("stream-output-controller.mjs"), "the remote startup regression must exercise the stream output controller import");

  const mermaidModuleResponse = await fetch(`http://127.0.0.1:${port}/vendor/mermaid/mermaid.esm.min.mjs`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(mermaidModuleResponse.status, 200, "Mermaid ESM module should be served from the vendored dependency path");
  assert.match(mermaidModuleResponse.headers.get("content-type") || "", /text\/javascript/, "Mermaid ESM module should use a JavaScript MIME type");
  const mermaidModuleText = await mermaidModuleResponse.text();
  const mermaidChunkPath = mermaidModuleText.match(/\.\/(chunks\/mermaid\.esm\.min\/[A-Za-z0-9._-]+\.mjs)/)?.[1];
  assert.ok(mermaidChunkPath, "Mermaid ESM module should reference same-directory chunks");
  const mermaidChunkResponse = await fetch(`http://127.0.0.1:${port}/vendor/mermaid/${mermaidChunkPath}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(mermaidChunkResponse.status, 200, "Mermaid ESM chunks should be served for dynamic imports");
  assert.equal(await mermaidChunkResponse.text(), await readFile(join(root, "node_modules", "mermaid", "dist", mermaidChunkPath), "utf8"), "served Mermaid chunks should match the dependency files");

  const tabsResponse = await request("127.0.0.1", "/api/tabs");
  assert.equal(tabsResponse.status, 200);
  const tabList = tabsResponse.body?.data?.tabs || tabsResponse.body?.tabs || [];
  assert.equal(tabList.length, 1, "startup should create one tab for --cwd");
  const tabId = tabList[0].id;
  assert.ok(tabId, "tab should have an id");

  const dedupTabResponse = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "mobile-request-dedup" } });
  assert.equal(dedupTabResponse.status, 201, "mobile request deduplication test tab should open");
  const dedupTabId = dedupTabResponse.body?.data?.tab?.id;
  const requestId = "mobile_request_1234567890";
  const requestBody = { tab: dedupTabId, message: "mobile request dedup fixture", requestId };
  const [firstPrompt, duplicatePrompt] = await Promise.all([
    request("127.0.0.1", "/api/prompt", { method: "POST", body: requestBody }),
    request("127.0.0.1", "/api/prompt", { method: "POST", body: requestBody }),
  ]);
  assert.equal(firstPrompt.status, 200, "the first browser-identified prompt should dispatch");
  assert.equal(duplicatePrompt.status, 200, "a known browser request should return the retained result");
  const duplicateReuse = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { ...requestBody, message: "different prompt" } });
  assert.equal(duplicateReuse.status, 409, "a request ID cannot be reused for a different mutation");
  const dedupCommands = (await readJsonLines(fakePiCommandLog)).filter((entry) => entry.direction === "command" && entry.message === "mobile request dedup fixture");
  assert.equal(dedupCommands.length, 1, "duplicate browser prompt identities must reach Pi exactly once");
  const dedupTabs = await request("127.0.0.1", "/api/tabs");
  const dedupActivity = dedupTabs.body?.data?.tabs?.find((tab) => tab.id === dedupTabId)?.activity;
  assert.match(dedupActivity?.runId || "", /^[0-9a-f-]{36}$/i, "active parent work must expose a server-issued opaque run ID");
  assert.equal((await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [dedupTabId] } })).status, 200, "mobile request deduplication test tab should close");

  const runtimeQueueBefore = { steering: ["runtime steering"], followUp: ["runtime first", "runtime second", "runtime third"] };
  const runtimeQueueEdit = await waitForSseEvent(
    tabId,
    (event) => event.type === "queue_update" && event.source === "pi-runtime" && event.followUp?.[0] === "runtime edited",
    () => request("127.0.0.1", "/api/queue/mutate", {
      method: "POST",
      body: {
        tab: tabId,
        source: "pi-runtime",
        kind: "followUp",
        expected: runtimeQueueBefore,
        operation: { type: "edit", index: 0, expectedText: "runtime first", text: " runtime edited " },
      },
    }),
  );
  assert.equal(runtimeQueueEdit.triggerResult.status, 200, `runtime queue edit should succeed: ${runtimeQueueEdit.triggerResult.body?.error || ""}`);
  assert.deepEqual(runtimeQueueEdit.triggerResult.body?.data, {
    mutated: true,
    source: "pi-runtime",
    queue: { source: "pi-runtime", steering: ["runtime steering"], followUp: ["runtime edited", "runtime second", "runtime third"] },
  }, "queue mutation should return the authoritative normalized runtime snapshot");
  assert.equal(runtimeQueueEdit.event.source, "pi-runtime", "runtime queue events must retain their source");

  const staleRuntimeQueueEdit = await request("127.0.0.1", "/api/queue/mutate", {
    method: "POST",
    body: {
      tab: tabId,
      source: "pi-runtime",
      kind: "followUp",
      expected: runtimeQueueBefore,
      operation: { type: "move", from: 0, to: 2, expectedText: "runtime first" },
    },
  });
  assert.equal(staleRuntimeQueueEdit.status, 409, "stale runtime queue snapshots must conflict");
  assert.equal(staleRuntimeQueueEdit.body?.ok, false);
  assert.equal(staleRuntimeQueueEdit.body?.data?.reason, "queue-changed");
  assert.deepEqual(staleRuntimeQueueEdit.body?.data?.queue?.followUp, ["runtime edited", "runtime second", "runtime third"], "conflicts return the authoritative runtime queue");

  const runtimeQueueMove = await request("127.0.0.1", "/api/queue/mutate", {
    method: "POST",
    body: {
      tab: tabId,
      source: "pi-runtime",
      kind: "followUp",
      expected: { steering: ["runtime steering"], followUp: ["runtime edited", "runtime second", "runtime third"] },
      operation: { type: "move", from: 0, to: 2, expectedText: "runtime edited" },
    },
  });
  assert.equal(runtimeQueueMove.status, 200, "runtime queue moves should use final zero-based indices");
  assert.deepEqual(runtimeQueueMove.body?.data?.queue?.followUp, ["runtime second", "runtime third", "runtime edited"]);

  const runtimeQueueDelete = await request("127.0.0.1", "/api/queue/mutate", {
    method: "POST",
    body: {
      tab: tabId,
      source: "pi-runtime",
      kind: "followUp",
      expected: { steering: ["runtime steering"], followUp: ["runtime second", "runtime third", "runtime edited"] },
      operation: { type: "delete", index: 1, expectedText: "runtime third" },
    },
  });
  assert.equal(runtimeQueueDelete.status, 200, "runtime queue deletion should remove the selected follow-up");
  assert.deepEqual(runtimeQueueDelete.body?.data?.queue?.followUp, ["runtime second", "runtime edited"]);

  const invalidRuntimeQueueMutation = await request("127.0.0.1", "/api/queue/mutate", {
    method: "POST",
    body: { tab: tabId, source: "pi-runtime", kind: "steering", expected: { steering: [], followUp: [] }, operation: { type: "edit", index: 0, expectedText: "x", text: "y" } },
  });
  assert.equal(invalidRuntimeQueueMutation.status, 400, "queue mutation must stay follow-up-only and reject malformed source contracts");

  const extensionResponseId = `fixture-extension-response-${Date.now()}`;
  const extensionResponseStartedAt = Date.now();
  const extensionResponse = await request("127.0.0.1", "/api/extension-ui-response", {
    method: "POST",
    body: { tab: tabId, id: extensionResponseId, value: "fixture choice" },
    timeoutMs: 2_000,
  });
  const extensionResponseElapsedMs = Date.now() - extensionResponseStartedAt;
  assert.equal(extensionResponse.status, 200, `supervised extension UI response should return after the raw write: ${extensionResponse.body?.error || ""}`);
  assert.ok(extensionResponseElapsedMs < 1_500, `supervised one-way extension UI response should return promptly (took ${extensionResponseElapsedMs}ms)`);
  let extensionResponseCommands = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    extensionResponseCommands = (await readJsonLines(fakePiCommandLog)).filter((entry) => entry.direction === "command" && entry.type === "extension_ui_response" && entry.id === extensionResponseId);
    if (extensionResponseCommands.length) break;
    await delay(25);
  }
  assert.deepEqual(extensionResponseCommands, [{
    at: extensionResponseCommands[0]?.at,
    direction: "command",
    type: "extension_ui_response",
    id: extensionResponseId,
    value: "fixture choice",
    cancelled: false,
  }], "supervisor must preserve the extension request ID and write the raw response to fake Pi exactly once without a Pi reply");

  const initialUserLaunchSlots = await request("127.0.0.1", `/api/subagents/config?tab=${encodeURIComponent(tabId)}&scope=user`);
  assert.equal(initialUserLaunchSlots.status, 200, `user launch-slot config should load: ${initialUserLaunchSlots.body?.error || ""}`);
  assert.equal(initialUserLaunchSlots.body?.data?.reloadRequired, false);
  assert.equal(initialUserLaunchSlots.body?.data?.roleMetadata?.length, 8, "launch-slot config should expose the documented builtin role metadata");
  assert.deepEqual(initialUserLaunchSlots.body?.data?.roles?.reviewer, [{ id: "reviewer:base", model: null, thinking: null }], "launch-slot defaults should materialize a stable base slot");
  assert.deepEqual(initialUserLaunchSlots.body?.data?.modelThinkingLevels?.["fake/fake-model"], ["off"], "the active tab model registry should drive supported thinking choices");

  const userLaunchDraft = JSON.parse(JSON.stringify(initialUserLaunchSlots.body.data.roles));
  userLaunchDraft.reviewer[0] = { id: "reviewer:base", model: "fake/fake-model", thinking: "off" };
  userLaunchDraft.reviewer.push({ id: "reviewer-secondary", model: "fake/fake-model", thinking: "off" });
  const savedUserLaunchSlots = await request("127.0.0.1", "/api/subagents/config", {
    method: "POST",
    body: { tab: tabId, scope: "user", revision: initialUserLaunchSlots.body.data.revision, roles: userLaunchDraft },
  });
  assert.equal(savedUserLaunchSlots.status, 200, `user launch-slot config should save: ${savedUserLaunchSlots.body?.error || ""}`);
  assert.equal(savedUserLaunchSlots.body?.data?.saved, true);
  assert.equal(savedUserLaunchSlots.body?.data?.changed, true);
  assert.equal(savedUserLaunchSlots.body?.data?.reloadRequired, true, "a changed save must require active-tab reload before helper guidance changes");
  assert.deepEqual(savedUserLaunchSlots.body?.data?.roles?.reviewer, userLaunchDraft.reviewer, "same-role launch slots must retain independent explicit model specs");
  const persistedLaunchSlots = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persistedLaunchSlots.version, 8, "launch-slot persistence should retain the current private WebUI settings envelope");
  assert.deepEqual(persistedLaunchSlots.subagentLaunchSlots?.user?.roles?.reviewer, userLaunchDraft.reviewer);

  const inheritedProjectLaunchSlots = await request("127.0.0.1", `/api/subagents/config?tab=${encodeURIComponent(tabId)}&scope=project`);
  assert.equal(inheritedProjectLaunchSlots.status, 200);
  assert.equal(inheritedProjectLaunchSlots.body?.data?.inherited, true, "project scope must inherit user launch slots until customized");
  assert.deepEqual(inheritedProjectLaunchSlots.body?.data?.roles?.reviewer, userLaunchDraft.reviewer);
  const projectLaunchDraft = JSON.parse(JSON.stringify(inheritedProjectLaunchSlots.body.data.roles));
  projectLaunchDraft.reviewer[0] = { id: "reviewer:base", model: null, thinking: null };
  const savedProjectLaunchSlots = await request("127.0.0.1", "/api/subagents/config", {
    method: "POST",
    body: { tab: tabId, scope: "project", revision: inheritedProjectLaunchSlots.body.data.revision, roles: projectLaunchDraft },
  });
  assert.equal(savedProjectLaunchSlots.status, 200);
  assert.equal(savedProjectLaunchSlots.body?.data?.inherited, false, "saving project roles should create an explicit project entry");
  assert.equal(savedProjectLaunchSlots.body?.data?.roles?.reviewer?.[0]?.model, null);
  const resetProjectLaunchSlots = await request("127.0.0.1", "/api/subagents/config", {
    method: "POST",
    body: { tab: tabId, scope: "project", revision: savedProjectLaunchSlots.body.data.revision, inherit: true },
  });
  assert.equal(resetProjectLaunchSlots.status, 200);
  assert.equal(resetProjectLaunchSlots.body?.data?.inherited, true, "project inherit reset should remove only the explicit project entry");
  assert.deepEqual(resetProjectLaunchSlots.body?.data?.roles?.reviewer, userLaunchDraft.reviewer);

  const settingsBeforeStaleLaunchSave = await readFile(settingsFile, "utf8");
  const staleLaunchSave = await request("127.0.0.1", "/api/subagents/config", {
    method: "POST",
    body: { tab: tabId, scope: "user", revision: initialUserLaunchSlots.body.data.revision, roles: userLaunchDraft },
  });
  assert.equal(staleLaunchSave.status, 409, "stale launch-slot revisions must not overwrite current settings");
  assert.equal(await readFile(settingsFile, "utf8"), settingsBeforeStaleLaunchSave, "a rejected stale launch-slot save must leave the settings file byte-for-byte unchanged");
  const invalidLaunchDraft = JSON.parse(JSON.stringify(userLaunchDraft));
  invalidLaunchDraft.reviewer[0].model = "fake/fake-model:high";
  const invalidLaunchSave = await request("127.0.0.1", "/api/subagents/config", {
    method: "POST",
    body: { tab: tabId, scope: "user", revision: savedUserLaunchSlots.body.data.revision, roles: invalidLaunchDraft },
  });
  assert.equal(invalidLaunchSave.status, 400, "thinking-suffixed persisted model IDs must be rejected on save");

  const malformedInlineImage = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { tab: tabId, message: "malformed inline image fixture", images: [{ type: "image", mimeType: "image/png", data: "137,80,78,71,13,10,26,10" }] },
  });
  assert.equal(malformedInlineImage.status, 400, "comma-separated image bytes should be rejected before RPC dispatch");
  assert.match(String(malformedInlineImage.body?.error || ""), /image 1 data must be canonical base64/i);

  const unpaddedInlineImage = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { tab: tabId, message: "unpadded inline image fixture", images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo" }] },
  });
  assert.equal(unpaddedInlineImage.status, 400, "non-canonical unpadded image base64 should be rejected before RPC dispatch");
  assert.match(String(unpaddedInlineImage.body?.error || ""), /image 1 data must be canonical base64/i);

  const malformedAttachment = await request("127.0.0.1", "/api/attachments", {
    method: "POST",
    body: { tab: tabId, files: [{ id: "bad-image", name: "bad.png", mimeType: "image/png", data: "137,80,78,71" }] },
  });
  assert.equal(malformedAttachment.status, 400, "malformed attachment data should be rejected before a file is written");
  assert.match(String(malformedAttachment.body?.error || ""), /attachment data must be canonical base64/i);

  const canonicalPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const validInlineImage = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { tab: tabId, message: "canonical inline image fixture", images: [{ type: "image", mimeType: "image/png", data: canonicalPng }] },
  });
  assert.equal(validInlineImage.status, 200, `canonical inline image should reach Pi unchanged: ${validInlineImage.body?.error || ""}`);
  const imageCommands = (await readFile(fakePiCommandLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(imageCommands.some((entry) => entry.direction === "command" && entry.message === "malformed inline image fixture"), false, "malformed inline images must not reach Pi");
  assert.equal(imageCommands.some((entry) => entry.direction === "command" && entry.message === "unpadded inline image fixture"), false, "non-canonical inline images must not reach Pi");
  const validImageCommand = imageCommands.find((entry) => entry.direction === "command" && entry.message === "canonical inline image fixture");
  assert.deepEqual(validImageCommand?.images, [{ type: "image", data: canonicalPng, mimeType: "image/png" }], "canonical image bytes and MIME type should be forwarded unchanged");

  const webuiManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(webuiManifest.optionalDependencies, { "node-pty": "^1.1.0" }, "node-pty should be the only optional dependency");
  assert.equal(webuiManifest.dependencies?.["@firstpick/pi-utils"], "^0.2.5", "the required pi-utils runtime dependency must remain regular");
  assert.equal(JSON.stringify(webuiManifest.pi).includes("node_modules/@firstpick"), false, "the WebUI manifest must not claim optional companion resources");

  const optionalFeatures = await request("127.0.0.1", "/api/optional-features");
  assert.equal(optionalFeatures.status, 200, "optional feature status should load");
  assert.equal(optionalFeatures.body?.data?.features?.length, 20, "the explicit server catalog should expose every allowlisted feature");
  const guidedGitFeature = optionalFeatures.body?.data?.features?.find((feature) => feature.featureId === "gitWorkflow");
  assert.equal(guidedGitFeature?.packageName, "@firstpick/pi-extension-git-guided-workflow", "Optional Features must install the extension that bundles the prompt companion");
  assert.equal(guidedGitFeature?.expectedSpec, "^0.1.0");
  const aurReviewFeature = optionalFeatures.body?.data?.features?.find((feature) => feature.featureId === "aurReview");
  assert.equal(aurReviewFeature?.expectedSpec, "^0.1.1", "status should expose the catalog-owned compatibility spec");
  assert.equal(aurReviewFeature?.installed, true, "workspace discovery should find the local pi-extension-aur-review sibling without an npm dependency");
  assert.equal(aurReviewFeature?.configured, false, "physical discovery alone must not imply Pi registration");
  assert.equal(aurReviewFeature?.ready, false, "a physical but unregistered companion must not be ready after reload");
  assert.equal(aurReviewFeature?.state, "unknown", "physical discovery without canonical ownership must remain unknown");
  assert.equal(Object.hasOwn(aurReviewFeature || {}, "installedRoot"), false, "browser status must not expose the validated host package path");
  await verifyTopLevelOptionalFeatureProtection(tabId);

  const invalidSingleFeature = await request("127.0.0.1", "/api/optional-feature-install", {
    method: "POST",
    body: { tab: tabId, featureId: "not-allowlisted" },
  });
  assert.equal(invalidSingleFeature.status, 400, "single installs must reject feature IDs outside the server catalog");

  const installedAurReview = await request("127.0.0.1", "/api/optional-feature-install", {
    method: "POST",
    body: { tab: tabId, featureId: "aurReview" },
    timeoutMs: 10_000,
  });
  assert.equal(installedAurReview.status, 200, installedAurReview.body?.error);
  assert.match(installedAurReview.body?.data?.command || "", /install npm:@firstpick\/pi-extension-aur-review$/, "the selected Pi CLI should receive the exact unpinned npm source");
  assert.equal(installedAurReview.body?.data?.status?.installed, true);
  assert.equal(installedAurReview.body?.data?.status?.configured, true);
  assert.equal(installedAurReview.body?.data?.status?.ready, true, "successful Pi installation must verify physical presence and registration");
  const aurInstallCommands = (await readJsonLines(fakePiCliLog)).filter((entry) => entry.event === "start" && entry.args?.[1] === "npm:@firstpick/pi-extension-aur-review");
  assert.deepEqual(aurInstallCommands.map((entry) => entry.args), [["install", "npm:@firstpick/pi-extension-aur-review"]], "the feature path must invoke Pi install exactly once without npm CLI flags");

  const registeredOptionalFeatures = await request("127.0.0.1", "/api/optional-features");
  const registeredAurReview = registeredOptionalFeatures.body?.data?.features?.find((feature) => feature.featureId === "aurReview");
  assert.equal(registeredAurReview?.ready, true, "Pi registration should survive a fresh status-manager read");

  const resourceTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "configured optional package" } });
  assert.equal(resourceTab.status, 201, resourceTab.body?.error);
  const resourceTabId = resourceTab.body?.data?.tab?.id;
  const rpcLaunches = (await readJsonLines(fakePiCliLog)).filter((entry) => entry.event === "rpc");
  const configuredLaunchArgs = rpcLaunches.at(-1)?.args || [];
  const normalizedLaunchArgs = configuredLaunchArgs.map((arg) => String(arg).replace(/\\/g, "/"));
  assert.equal(normalizedLaunchArgs.filter((arg) => arg.endsWith("/pi-extension-aur-review/index.ts")).length, 1, "a separately configured optional extension should load once in a WebUI RPC tab");
  assert.equal(normalizedLaunchArgs.filter((arg) => arg.endsWith("/pi-package-webui/index.ts")).length, 1, "the WebUI package itself should remain loaded exactly once");
  assert.equal((await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [resourceTabId] } })).status, 200);

  const currentBatchPlan = await request("127.0.0.1", "/api/optional-features");
  const currentBatchRevision = currentBatchPlan.body?.data?.revision;
  const malformedBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: currentBatchRevision, featureIds: "aurReview" },
  });
  assert.equal(malformedBatch.status, 400, "batch installs must require an array");
  const unknownBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: currentBatchRevision, featureIds: ["aurReview", "not-allowlisted"] },
  });
  assert.equal(unknownBatch.status, 400, "batch installs must reject unknown IDs before starting any command");
  const oversizedBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: currentBatchRevision, featureIds: Array.from({ length: 21 }, () => "aurReview") },
  });
  assert.equal(oversizedBatch.status, 400, "batch installs must cap raw input to the catalog size");
  const staleBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: "sha256:stale", featureIds: ["aurReview"] },
  });
  assert.equal(staleBatch.status, 409, "batch installs must reject stale audit revisions");

  const batchLogStart = (await readJsonLines(fakePiCliLog)).length;
  const partialBatch = await request("127.0.0.1", "/api/optional-feature-install-batch", {
    method: "POST",
    body: { tab: tabId, revision: currentBatchRevision, featureIds: ["bangCommandAutocomplete", "statsCommand", "bangCommandAutocomplete", "gitFooterStatus"] },
    timeoutMs: 20_000,
  });
  assert.equal(partialBatch.status, 200, partialBatch.body?.error);
  assert.deepEqual(partialBatch.body?.data?.featureIds, ["bangCommandAutocomplete", "statsCommand", "gitFooterStatus"], "batch input should be deduplicated without reordering");
  assert.deepEqual(partialBatch.body?.data?.results?.map(({ featureId, ok }) => [featureId, ok]), [
    ["bangCommandAutocomplete", true],
    ["statsCommand", false],
    ["gitFooterStatus", true],
  ], "a failed Pi install must not stop later allowlisted installs");
  assert.deepEqual({ total: partialBatch.body?.data?.total, succeeded: partialBatch.body?.data?.succeeded, failed: partialBatch.body?.data?.failed }, { total: 3, succeeded: 2, failed: 1 });
  assert.equal(partialBatch.body?.data?.results?.[1]?.optionalFeatureInstall?.exitCode, 17, "batch failures should retain exit diagnostics");
  assert.match(partialBatch.body?.data?.results?.[1]?.optionalFeatureInstall?.command || "", /install npm:@firstpick\/pi-extension-stats$/, "batch failures should retain a copyable Pi command");
  assert.match(partialBatch.body?.data?.results?.[1]?.optionalFeatureInstall?.outputTail || "", /fixture Pi install failure/, "batch failures should retain bounded output diagnostics");
  const batchLog = (await readJsonLines(fakePiCliLog)).slice(batchLogStart).filter((entry) => entry.event === "start" || entry.event === "finish");
  assert.deepEqual(batchLog.map((entry) => [entry.event, entry.args?.[1], entry.exitCode]), [
    ["start", "npm:@firstpick/pi-extension-bang-command-autocomplete", undefined],
    ["finish", "npm:@firstpick/pi-extension-bang-command-autocomplete", 0],
    ["start", "npm:@firstpick/pi-extension-stats", undefined],
    ["finish", "npm:@firstpick/pi-extension-stats", 17],
    ["start", "npm:@firstpick/pi-extension-git-footer-status", undefined],
    ["finish", "npm:@firstpick/pi-extension-git-footer-status", 0],
  ], "batch commands should execute sequentially in request order");

  const lanHost = lanAddress();
  if (lanHost) {
    const remoteBatch = await request(lanHost, "/api/optional-feature-install-batch", {
      method: "POST",
      body: { tab: tabId, revision: currentBatchRevision, featureIds: ["aurReview"] },
    });
    assert.equal(remoteBatch.status, 403, "batch installs must remain localhost-only");
  }

  const sessionToolsBefore = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=session`);
  assert.equal(sessionToolsBefore.status, 200);
  assert.equal(sessionToolsBefore.body?.data?.scope, "session");
  assert.deepEqual(sessionToolsBefore.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", true]]);

  const globalToolsBefore = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=global`);
  assert.equal(globalToolsBefore.status, 200);
  assert.equal(globalToolsBefore.body?.data?.configured, false, "global tools should initially inherit the current runtime defaults");

  const saveGlobalTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "global", enabledTools: ["read"] },
  });
  assert.equal(saveGlobalTools.status, 200);
  assert.equal(saveGlobalTools.body?.data?.configured, true);
  assert.deepEqual(saveGlobalTools.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", false]]);

  const settingsWithUnavailableResources = JSON.parse(await readFile(settingsFile, "utf8"));
  settingsWithUnavailableResources.resourceDefaults.tools.enabledTools.push("future-tool");
  settingsWithUnavailableResources.resourceDefaults.skills.enabledSkills = ["future-skill"];
  await writeFile(settingsFile, `${JSON.stringify(settingsWithUnavailableResources, null, 2)}\n`, "utf8");

  const sessionToolsAfterGlobal = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=session`);
  assert.deepEqual(sessionToolsAfterGlobal.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", true]], "saving a global tool default must not rewrite the current session");

  const saveSessionTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "session", enabledTools: ["bash"] },
  });
  assert.equal(saveSessionTools.status, 200);
  assert.deepEqual(saveSessionTools.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", false], ["bash", true]]);
  const globalToolsAfterSession = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=global`);
  assert.deepEqual(globalToolsAfterSession.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", false]], "session tool changes must not rewrite the global default");

  const saveGlobalSkills = await request("127.0.0.1", "/api/skills", {
    method: "POST",
    body: { tab: tabId, scope: "global", enabledSkills: ["repo-explorer"] },
  });
  assert.equal(saveGlobalSkills.status, 200);
  assert.deepEqual(saveGlobalSkills.body?.data?.skills?.map((skill) => [skill.name, skill.enabled]), [["repo-explorer", true], ["code-security", false]]);
  const sessionSkillsAfterGlobal = await request("127.0.0.1", `/api/skills?tab=${encodeURIComponent(tabId)}&scope=session`);
  assert.deepEqual(sessionSkillsAfterGlobal.body?.data?.skills?.map((skill) => [skill.name, skill.enabled]), [["repo-explorer", true], ["code-security", true]], "saving a global skill default must not rewrite the current session");

  const persistedResourceDefaults = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.deepEqual(persistedResourceDefaults.resourceDefaults?.tools?.enabledTools, ["read", "future-tool"], "saving visible tool choices should preserve defaults for tools unavailable in the active tab");
  assert.deepEqual(persistedResourceDefaults.resourceDefaults?.skills?.enabledSkills, ["repo-explorer", "future-skill"], "saving visible skill choices should preserve defaults for skills unavailable in the active tab");
  const invalidResourceScope = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=project`);
  assert.equal(invalidResourceScope.status, 400, "resource selectors should reject unsupported scope values");

  const modelToolsBefore = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=model&provider=fake&modelId=fake-model`);
  assert.equal(modelToolsBefore.status, 200, modelToolsBefore.body?.error);
  assert.equal(modelToolsBefore.body?.data?.scope, "model");
  assert.equal(modelToolsBefore.body?.data?.configured, false, "an exact model without a saved profile should inherit");
  assert.equal(modelToolsBefore.body?.data?.source, "global", "the model scope should resolve through the saved global default");
  assert.deepEqual(modelToolsBefore.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", false]]);
  assert.deepEqual(modelToolsBefore.body?.data?.models?.map((model) => [model.provider, model.id]), [["fake", "fake-model"]], "the model scope should expose exact authenticated models");

  const missingModelIdentity = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=model`);
  assert.equal(missingModelIdentity.status, 400, "model scope must require an exact provider and modelId");
  const unknownModelIdentity = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=model&provider=fake&modelId=other-model`);
  assert.equal(unknownModelIdentity.status, 400, "model scope must reject models outside the authenticated registry");

  const saveModelTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "model", provider: "fake", modelId: "fake-model", enabledTools: ["bash"] },
  });
  assert.equal(saveModelTools.status, 200, saveModelTools.body?.error);
  assert.equal(saveModelTools.body?.data?.configured, true);
  assert.deepEqual(saveModelTools.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", false], ["bash", true]]);

  const settingsWithModelProfile = JSON.parse(await readFile(settingsFile, "utf8"));
  const modelProfile = settingsWithModelProfile.resourceDefaults?.modelProfiles?.find((profile) => profile.provider === "fake" && profile.modelId === "fake-model");
  assert.deepEqual(modelProfile?.tools?.enabledTools, ["bash"], "the exact model profile should persist under the v8 envelope");
  modelProfile.tools.enabledTools.push("future-tool");
  await writeFile(settingsFile, `${JSON.stringify(settingsWithModelProfile, null, 2)}\n`, "utf8");

  const saveModelToolsAgain = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "model", provider: "fake", modelId: "fake-model", enabledTools: ["read"] },
  });
  assert.equal(saveModelToolsAgain.status, 200, saveModelToolsAgain.body?.error);
  const persistedModelProfile = JSON.parse(await readFile(settingsFile, "utf8")).resourceDefaults?.modelProfiles?.find((profile) => profile.provider === "fake" && profile.modelId === "fake-model");
  assert.deepEqual(persistedModelProfile?.tools?.enabledTools, ["read", "future-tool"], "model-scope saves should preserve defaults for tools unavailable in the active tab");

  const sessionToolsAfterModel = await request("127.0.0.1", `/api/tools?tab=${encodeURIComponent(tabId)}&scope=session`);
  assert.deepEqual(sessionToolsAfterModel.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", false], ["bash", true]], "saving a model tool default must not rewrite the current session");

  const saveModelSkills = await request("127.0.0.1", "/api/skills", {
    method: "POST",
    body: { tab: tabId, scope: "model", provider: "fake", modelId: "fake-model", enabledSkills: ["code-security"] },
  });
  assert.equal(saveModelSkills.status, 200, saveModelSkills.body?.error);
  assert.deepEqual(saveModelSkills.body?.data?.skills?.map((skill) => [skill.name, skill.enabled]), [["repo-explorer", false], ["code-security", true]]);

  const inheritModelTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "model", provider: "fake", modelId: "fake-model", inherit: true },
  });
  assert.equal(inheritModelTools.status, 200, inheritModelTools.body?.error);
  assert.equal(inheritModelTools.body?.data?.configured, false, "model inherit should clear only the tool selection");
  const profileAfterToolInherit = JSON.parse(await readFile(settingsFile, "utf8")).resourceDefaults?.modelProfiles?.find((profile) => profile.provider === "fake" && profile.modelId === "fake-model");
  assert.equal(profileAfterToolInherit?.tools?.enabledTools, null, "model tool inherit should reset to null while retaining the skill selection");
  assert.deepEqual(profileAfterToolInherit?.skills?.enabledSkills, ["code-security"]);

  const inheritModelSkills = await request("127.0.0.1", "/api/skills", {
    method: "POST",
    body: { tab: tabId, scope: "model", provider: "fake", modelId: "fake-model", inherit: true },
  });
  assert.equal(inheritModelSkills.status, 200, inheritModelSkills.body?.error);
  const profilesAfterFullInherit = JSON.parse(await readFile(settingsFile, "utf8")).resourceDefaults?.modelProfiles || [];
  assert.deepEqual(profilesAfterFullInherit, [], "a profile with both resources inherited should be removed");

  const inheritGlobalTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "global", inherit: true },
  });
  assert.equal(inheritGlobalTools.status, 200, inheritGlobalTools.body?.error);
  assert.equal(inheritGlobalTools.body?.data?.configured, false, "global inherit should clear the saved default");
  assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).resourceDefaults?.tools?.enabledTools, null);

  const inheritSessionTools = await request("127.0.0.1", "/api/tools", {
    method: "POST",
    body: { tab: tabId, scope: "session", inherit: true },
  });
  assert.equal(inheritSessionTools.status, 200, inheritSessionTools.body?.error);
  assert.deepEqual(inheritSessionTools.body?.data?.tools?.map((tool) => [tool.name, tool.enabled]), [["read", true], ["bash", true]], "session inherit should recompute the inherited selection immediately");

  const workflowRpc = await waitForSseEvent(
    tabId,
    (event) => event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "workflow:rpc",
    () => request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture workflow inspector running" } }),
  );
  assert.equal(workflowRpc.triggerResult.status, 200, "workflow RPC fixture prompt should be accepted");
  assert.equal(workflowRpc.event.widgetLines?.[0]?.startsWith("WORKFLOW_RPC_PAYLOAD "), true, "real Pi RPC events should transport the versioned Workflow inspector payload");
  const workflowPayload = JSON.parse(workflowRpc.event.widgetLines[0].slice("WORKFLOW_RPC_PAYLOAD ".length));
  assert.equal(workflowPayload.version, 1);
  assert.equal(workflowPayload.runs[0].status, "running");
  assert.equal(workflowPayload.runs[0].phases[0].agents[0].prompt, "Inspect fixture");

  const workflowReplay = await waitForSseEvent(
    tabId,
    (event) => event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "workflow:rpc",
  );
  assert.equal(workflowReplay.event.replayed, true, "server reconnect should replay the latest Workflow inspector widget");
  assert.equal(JSON.parse(workflowReplay.event.widgetLines[0].slice("WORKFLOW_RPC_PAYLOAD ".length)).runs[0].runId, "fixture-workflow-run");

  const workflowCompleted = await waitForSseEvent(
    tabId,
    (event) => event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "workflow:rpc" && event.widgetLines?.[0]?.includes('"status":"completed"'),
    () => request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture workflow inspector completed" } }),
  );
  assert.equal(workflowCompleted.triggerResult.status, 200);
  assert.equal(JSON.parse(workflowCompleted.event.widgetLines[0].slice("WORKFLOW_RPC_PAYLOAD ".length)).runs[0].controls.canRetry, true);

  const artifactFixture = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture document artifact" } });
  assert.equal(artifactFixture.status, 200, "document artifact fixture should be accepted");
  const artifactMessages = await request("127.0.0.1", `/api/messages?tab=${encodeURIComponent(tabId)}`);
  const artifactToolResult = artifactMessages.body?.data?.messages?.findLast?.((message) => message?.role === "toolResult" && message?.toolName === "docx_render");
  const publicArtifact = artifactToolResult?.details?.artifact;
  assert.equal(publicArtifact?.schema, "pi.artifact/v1", "document artifact should survive transcript sanitization");
  assert.ok(publicArtifact?.manifestUrl, "document artifact should receive a manifest URL");
  assert.ok(publicArtifact?.downloadUrl, "document artifact should receive a download URL");
  assert.equal(JSON.stringify(artifactToolResult).includes(harnessSideEffectsRoot), false, "browser transcript must not expose artifact host paths");
  const artifactManifestResponse = await fetch(`http://127.0.0.1:${port}${publicArtifact.manifestUrl}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(artifactManifestResponse.status, 200, "artifact manifest token should resolve for its tab");
  const artifactManifestPayload = await artifactManifestResponse.json();
  assert.equal(artifactManifestPayload.data.pages[0].pageNum, 1);
  assert.equal(JSON.stringify(artifactManifestPayload).includes(harnessSideEffectsRoot), false, "artifact manifest response must not expose host paths");
  const artifactPageResponse = await fetch(`http://127.0.0.1:${port}${artifactManifestPayload.data.pages[0].imageUrl}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(artifactPageResponse.status, 200, "artifact page token should resolve");
  assert.equal(artifactPageResponse.headers.get("content-type"), "image/png");
  const artifactRangeResponse = await fetch(`http://127.0.0.1:${port}${publicArtifact.downloadUrl}`, { headers: { range: "bytes=0-6" }, signal: AbortSignal.timeout(5_000) });
  assert.equal(artifactRangeResponse.status, 206, "artifact downloads should support bounded byte ranges");
  assert.equal(artifactRangeResponse.headers.get("content-range"), `bytes 0-6/${(await stat(artifactDownload)).size}`);
  const otherArtifactTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "artifact-isolation" } });
  const wrongTabManifestUrl = new URL(publicArtifact.manifestUrl, `http://127.0.0.1:${port}`); wrongTabManifestUrl.searchParams.set("tab", otherArtifactTab.body?.data?.tab?.id);
  assert.equal((await fetch(wrongTabManifestUrl, { signal: AbortSignal.timeout(5_000) })).status, 404, "artifact tokens must be tab-bound");
  await request("127.0.0.1", `/api/tabs/${encodeURIComponent(otherArtifactTab.body?.data?.tab?.id)}`, { method: "DELETE" });
  await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture document artifact clear" } });

  const oldHelperFixture = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture subagents old-helper" } });
  assert.equal(oldHelperFixture.status, 200, "old-helper compatibility fixture should be accepted");
  let oldHelperOverview;
  for (let attempt = 0; attempt < 20; attempt++) {
    oldHelperOverview = await request("127.0.0.1", "/api/subagents");
    if (oldHelperOverview.body?.data?.totalAgents === 2) break;
    await delay(50);
  }
  assert.equal(oldHelperOverview.body?.data?.version, 2, "a new server must project an old v1-only helper status into the v2 overview");
  assert.equal(oldHelperOverview.body?.data?.groups?.find((group) => group.tabId === tabId)?.runs?.[0]?.agents?.length, 2);

  const subagentFixtureStart = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture subagents running" } });
  assert.equal(subagentFixtureStart.status, 200, "subagent fixture status should be accepted");
  let subagentsResponse;
  for (let attempt = 0; attempt < 20; attempt++) {
    subagentsResponse = await request("127.0.0.1", "/api/subagents");
    if (subagentsResponse.body?.data?.totalAgents === 2) break;
    await delay(50);
  }
  assert.equal(subagentsResponse?.status, 200, "subagent overview endpoint should respond");
  assert.equal(subagentsResponse.body?.data?.totalAgents, 2, "subagent overview should count all running agents");
  assert.equal(subagentsResponse.body?.data?.runningRuns, 1, "subagent overview should expose running run counts separately from retained totals");
  assert.equal(subagentsResponse.body?.data?.runningAgents, 2, "subagent overview should expose running agent counts separately from retained totals");
  assert.equal(subagentsResponse.body?.data?.tabs?.[0]?.runningRuns, 1);
  assert.equal(subagentsResponse.body?.data?.tabs?.[0]?.runningAgents, 2);
  assert.equal(subagentsResponse.body?.data?.tabs?.[0]?.tabId, tabId, "subagent overview should group agents under their terminal tab");
  assert.equal(subagentsResponse.body?.data?.tabs?.[0]?.runs?.[0]?.source, "async", "ordinary async overview rows should retain their source");
  assert.deepEqual(subagentsResponse.body?.data?.tabs?.[0]?.runs?.[0]?.agents?.map((agent) => agent.name), ["reviewer", "scout"], "subagent overview should preserve agent order within the session run");
  assert.deepEqual(subagentsResponse.body?.data?.tabs?.[0]?.runs?.[0]?.agents?.map((agent) => [agent.model, agent.thinking]), [["anthropic/claude-opus-4-8:high", "high"], ["openai-codex/gpt-5.6-sol", "high"]], "subagent overview should preserve bounded model and reasoning metadata");
  assert.equal(subagentsResponse.body?.data?.totalGates, 1, "subagent overview should expose retry gates independently from running children");
  assert.equal(subagentsResponse.body?.data?.tabs?.[0]?.gates?.[0]?.qualifyingSuccesses, 1, "retry gate quorum should be normalized");
  assert.deepEqual(subagentsResponse.body?.data?.tabs?.[0]?.gates?.[0]?.attempts?.map((attempt) => [attempt.status, attempt.failureKind]), [["succeeded", undefined], ["failed", "transient-provider"]], "retry gate attempts should preserve bounded status and failure classification");
  const subagentOutputResponse = await request("127.0.0.1", `/api/subagents/output?tab=${encodeURIComponent(tabId)}&run=${encodeURIComponent("fixture-run")}&agent=${encodeURIComponent("fixture-run:0")}`);
  assert.equal(subagentOutputResponse.status, 200, "running subagent output endpoint should respond");
  assert.equal(subagentOutputResponse.body?.data?.source, "async", "ordinary selected output should retain its async source");
  assert.equal(subagentOutputResponse.body?.data?.agent?.name, "reviewer", "subagent output should target the selected child agent");
  assert.deepEqual(subagentOutputResponse.body?.data?.agent?.recentOutput, ["Inspecting current implementation", "Waiting for the next tool result"], "subagent output should preserve bounded live output lines");
  assert.equal(subagentOutputResponse.body?.data?.agent?.currentToolArgs, "README.md", "subagent output should include current tool state");
  assert.equal(subagentOutputResponse.body?.data?.agent?.model, "anthropic/claude-opus-4-8:high", "subagent output should preserve the effective model");
  assert.equal(subagentOutputResponse.body?.data?.agent?.thinking, "high", "subagent output should preserve the effective reasoning effort");
  assert.deepEqual(subagentOutputResponse.body?.data?.agent?.telemetry, {
    promptInjectionTokens: 1234,
    inputTokens: 300,
    outputTokens: 100,
    tokenSpeed: 20,
    contextTokens: 240,
    contextWindow: 200_000,
    model: "anthropic/claude-opus-4-8:high",
    effort: "high",
  }, "selected output should preserve only the normalized additive telemetry contract");
  assert.equal(Object.hasOwn(subagentOutputResponse.body?.data?.agent?.telemetry || {}, "rawSessionPayload"), false, "selected output must not leak raw child-session/custom payloads");
  assert.deepEqual(subagentOutputResponse.body?.data?.agent?.transcript, [
    {
      role: "assistant",
      timestamp: "2026-07-19T12:00:00.000Z",
      content: [
        { type: "thinking", thinking: "Checking the fixture transcript." },
        { type: "text", text: "Inspecting current implementation" },
        { type: "toolCall", id: "fixture-read", name: "read", arguments: "{\"path\":\"README.md\",\"offset\":1}" },
        { type: "text", text: "Waiting for the next tool result" },
      ],
    },
    {
      role: "toolResult",
      timestamp: "2026-07-19T12:00:01.000Z",
      toolCallId: "fixture-read",
      toolName: "read",
      content: [{ type: "text", text: "# Fixture README" }],
    },
  ], "subagent output endpoint should preserve normalized structured transcript roles, order, IDs, and tool metadata");
  const canonicalHelperOutput = await request("127.0.0.1", `/api/subagents/output?group=${encodeURIComponent(`tab:${tabId}`)}&run=fixture-run&agent=fixture-run%3A0`);
  assert.equal(canonicalHelperOutput.status, 200, "the v2 output route should dispatch an opaque helper-owned handle");
  assert.equal(canonicalHelperOutput.body?.data?.agent?.name, "reviewer");
  const unknownSubagentOutput = await request("127.0.0.1", `/api/subagents/output?tab=${encodeURIComponent(tabId)}&run=missing&agent=missing`);
  assert.equal(unknownSubagentOutput.status, 404, "subagent output endpoint should reject untracked selections");

  const registryNow = Date.now();
  await agentRunRegistry.writeRecord("duplicate-provider", {
    version: 1, instanceId: "fixture-run:0", runId: "fixture-run", parentSessionId: "fake-session",
    launcher: "custom", provider: "webui-registry", name: "duplicate observer", status: "running",
    startedAt: registryNow - 2000, updatedAt: registryNow, endedAt: null,
    capabilities: { open: false, refresh: false, cancel: false, steer: false }, outputRef: { kind: "none" },
  }, { recordId: "duplicate-record" });
  await agentRunRegistry.writeRecord("external-provider", {
    version: 1, instanceId: "external-sdk", runId: "external-run", parentSessionId: null,
    launcher: "sdk", provider: "webui-registry", origin: "createAgentSession", name: "external SDK", status: "running",
    startedAt: registryNow - 1000, updatedAt: registryNow, endedAt: null,
    capabilities: { open: true, refresh: true, cancel: false, steer: false }, outputRef: { kind: "plain-log", id: "external-record" },
  }, { recordId: "external-record" });
  await agentRunRegistry.appendArtifactEvent("external-provider", "external-record", { type: "output", stream: "stdout", message: "bounded external output" });
  const corruptProducer = path.join(agentRunRegistry.paths.root, "corrupt-provider");
  await mkdir(corruptProducer, { recursive: true });
  await writeFile(path.join(corruptProducer, "corrupt-record.json"), "{not-json\n", { mode: 0o600 });
  const registryOverview = await request("127.0.0.1", "/api/subagents");
  assert.equal(registryOverview.status, 200, "registry reconciliation should isolate corrupt records");
  assert.equal(registryOverview.body?.data?.counts?.totalAgents, 3, "duplicate helper/registry identity should count once while an external agent adds one");
  assert.equal(registryOverview.body?.data?.counts?.byLauncher?.["pi-subagents"], 2);
  assert.equal(registryOverview.body?.data?.counts?.byLauncher?.sdk, 1);
  assert.equal(registryOverview.body?.data?.groups?.find((group) => group.id === "external")?.runs?.[0]?.agents?.[0]?.instanceId, "external-sdk", "an unmatched parent must group under External agents");
  assert.ok(registryOverview.body?.data?.diagnostics?.some((entry) => entry.code === "invalid-record"), "a corrupt registry record should yield only a bounded diagnostic");
  assert.equal(JSON.stringify(registryOverview.body).includes(harnessSideEffectsRoot), false, "registry overview payloads must not disclose host paths");
  const externalOutput = await request("127.0.0.1", "/api/subagents/output?group=external&run=external-run&agent=external-sdk");
  assert.equal(externalOutput.status, 200, "registry output should dispatch through its opaque server-owned record ID");
  assert.deepEqual(externalOutput.body?.data?.agent?.recentOutput, ["bounded external output"]);
  assert.equal(JSON.stringify(externalOutput.body).includes(agentRunRegistry.paths.root), false, "registry output must not expose its private path");
  const unsupportedExternalCancel = await request("127.0.0.1", "/api/subagents/cancel", { method: "POST", body: { group: "external", runId: "external-run", agentId: "external-sdk" } });
  assert.equal(unsupportedExternalCancel.status, 409, "canonical actions must reject providers without the declared capability");

  const registryDoneAt = Date.now();
  await agentRunRegistry.writeRecord("external-provider", {
    version: 1, instanceId: "external-sdk", runId: "external-run", parentSessionId: null,
    launcher: "sdk", provider: "webui-registry", origin: "createAgentSession", name: "external SDK", status: "done",
    startedAt: registryNow - 1000, updatedAt: registryDoneAt, endedAt: registryDoneAt,
    capabilities: { open: true, refresh: true, cancel: false, steer: false }, outputRef: { kind: "plain-log", id: "external-record" },
  }, { recordId: "external-record" });
  const terminalRegistryOverview = await request("127.0.0.1", "/api/subagents");
  assert.equal(terminalRegistryOverview.body?.data?.groups?.find((group) => group.id === "external")?.runs?.[0]?.status, "done", "terminal registry runs should remain visible until dismissed");
  const dismissedExternal = await request("127.0.0.1", "/api/subagents/dismiss", {
    method: "POST",
    body: { group: "external", runId: "external-run", agentId: "external-sdk" },
  });
  assert.equal(dismissedExternal.status, 200, `terminal registry projection should be dismissible: ${dismissedExternal.body?.error || ""}`);
  assert.deepEqual(dismissedExternal.body?.data, { runId: "external-run", dismissed: true });
  const afterExternalDismiss = await request("127.0.0.1", "/api/subagents");
  assert.equal(afterExternalDismiss.body?.data?.groups?.some((group) => group.id === "external"), false, "dismissed external projections should disappear from groups");
  assert.equal(afterExternalDismiss.body?.data?.counts?.totalAgents, 2, "dismissed external projections should disappear from canonical counts");
  const retainedRegistrySnapshot = await agentRunRegistry.readRecords();
  assert.ok(retainedRegistrySnapshot.records.some((record) => record.instance.instanceId === "external-sdk"), "dismissal must not delete the producer-owned registry record");
  assert.deepEqual((await agentRunRegistry.readArtifact("external-record"))?.events?.map((event) => event.message), ["bounded external output"], "dismissal must not delete producer artifacts");

  await agentRunRegistry.writeRecord("attached-provider", {
    version: 1, instanceId: "attached-session", runId: "attached-run", parentSessionId: null,
    launcher: "interactive", provider: "webui-registry", origin: "explicit-attach", name: "attached fixture", status: "stale",
    startedAt: registryNow - 70_000, updatedAt: registryNow - 60_000, endedAt: null,
    capabilities: { open: false, refresh: false, cancel: false, steer: false }, outputRef: { kind: "none" },
  }, { recordId: "attached-record" });
  const attachedOverview = await request("127.0.0.1", "/api/subagents");
  assert.equal(attachedOverview.body?.data?.groups?.find((group) => group.id === "external")?.runs?.find((run) => run.id === "attached-run")?.status, "stale", "explicit attached sessions should remain visibly stale until manually detached");
  const detachedAttachedSession = await request("127.0.0.1", "/api/subagents/dismiss", {
    method: "POST",
    body: { group: "external", runId: "attached-run", agentId: "attached-session" },
  });
  assert.equal(detachedAttachedSession.status, 200, `stale explicit attach projection should be detachable: ${detachedAttachedSession.body?.error || ""}`);
  const afterAttachedDetach = await request("127.0.0.1", "/api/subagents");
  assert.equal(afterAttachedDetach.body?.data?.groups?.some((group) => group.runs?.some((run) => run.id === "attached-run")), false, "detached attached-session projections should disappear from the overview");
  assert.ok((await agentRunRegistry.readRecords()).records.some((record) => record.instance.instanceId === "attached-session"), "detaching must not delete the persisted-session registry record");
  await Promise.all(["duplicate-provider", "external-provider", "attached-provider", "corrupt-provider"].map((producer) => rm(path.join(agentRunRegistry.paths.root, producer), { recursive: true, force: true })));

  const dismissRunningSubagent = await request("127.0.0.1", "/api/subagents/dismiss", {
    method: "POST",
    body: { tab: tabId, runId: "fixture-run" },
  });
  assert.equal(dismissRunningSubagent.status, 400, "dismiss endpoint should reject running runs through the helper");
  const cancelUnknownSubagent = await request("127.0.0.1", "/api/subagents/cancel", {
    method: "POST",
    body: { tab: tabId, runId: "missing" },
  });
  assert.equal(cancelUnknownSubagent.status, 400, "cancel endpoint should return helper errors for unknown runs");

  const cancelledSubagent = await request("127.0.0.1", "/api/subagents/cancel", {
    method: "POST",
    body: { tab: tabId, runId: "fixture-run", reason: "Taking too long", note: "Use the existing result instead." },
  });
  assert.equal(cancelledSubagent.status, 200, `cancel endpoint should relay helper cancellation: ${cancelledSubagent.body?.error || ""}`);
  assert.deepEqual(cancelledSubagent.body?.data, {
    runId: "fixture-run",
    state: "cancelled",
    delivery: "context",
    rpcMethod: "stop",
  }, "cancel endpoint should preserve the helper cancellation response contract");
  for (let attempt = 0; attempt < 20; attempt++) {
    subagentsResponse = await request("127.0.0.1", "/api/subagents");
    if (subagentsResponse.body?.data?.tabs?.[0]?.runs?.[0]?.status === "cancelled") break;
    await delay(50);
  }
  const cancelledRun = subagentsResponse.body?.data?.tabs?.[0]?.runs?.find((run) => run.id === "fixture-run");
  assert.deepEqual(cancelledRun && {
    status: cancelledRun.status,
    endedAt: typeof cancelledRun.endedAt,
    cancelledBy: cancelledRun.cancelledBy,
    cancelReason: cancelledRun.cancelReason,
    cancelNote: cancelledRun.cancelNote,
    agentStatuses: cancelledRun.agents.map((agent) => agent.status),
  }, {
    status: "cancelled",
    endedAt: "number",
    cancelledBy: "user",
    cancelReason: "Taking too long",
    cancelNote: "Use the existing result instead.",
    agentStatuses: ["cancelled", "cancelled"],
  }, "subagent normalization should retain cancelled run and agent metadata");
  assert.equal(subagentsResponse.body?.data?.totalRuns, 1, "retained runs should remain included in total counts");
  assert.equal(subagentsResponse.body?.data?.runningRuns, 0, "retained cancelled runs should not count as running");
  assert.equal(subagentsResponse.body?.data?.runningAgents, 0, "retained cancelled agents should not count as running");
  const retainedCancelledOutput = await request("127.0.0.1", `/api/subagents/output?tab=${encodeURIComponent(tabId)}&run=fixture-run&agent=fixture-run%3A0`);
  assert.equal(retainedCancelledOutput.status, 200, "subagent output should remain accessible for retained cancelled runs");
  assert.equal(retainedCancelledOutput.body?.data?.agent?.status, "cancelled");
  const duplicateCancel = await request("127.0.0.1", "/api/subagents/cancel", {
    method: "POST",
    body: { tab: tabId, runId: "fixture-run" },
  });
  assert.equal(duplicateCancel.status, 400, "cancel endpoint should reject an already-finished run");

  const dismissedSubagent = await request("127.0.0.1", "/api/subagents/dismiss", {
    method: "POST",
    body: { tab: tabId, runId: "fixture-run" },
  });
  assert.equal(dismissedSubagent.status, 200, `dismiss endpoint should relay helper dismissal: ${dismissedSubagent.body?.error || ""}`);
  assert.deepEqual(dismissedSubagent.body?.data, { runId: "fixture-run", dismissed: true });
  subagentsResponse = await request("127.0.0.1", "/api/subagents");
  assert.equal(subagentsResponse.body?.data?.totalRuns, 0, "dismissed runs should be removed from the overview");

  const retainedFixture = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture subagents retained" } });
  assert.equal(retainedFixture.status, 200, "retained subagent fixture should be accepted");
  for (let attempt = 0; attempt < 20; attempt++) {
    subagentsResponse = await request("127.0.0.1", "/api/subagents");
    if (subagentsResponse.body?.data?.totalRuns === 2) break;
    await delay(50);
  }
  assert.equal(subagentsResponse.body?.data?.totalRuns, 2, "finished runs should survive payload normalization");
  assert.equal(subagentsResponse.body?.data?.totalAgents, 2, "finished agents should remain represented in retained totals");
  assert.equal(subagentsResponse.body?.data?.runningRuns, 0);
  assert.equal(subagentsResponse.body?.data?.runningAgents, 0);
  const normalizedDoneRun = subagentsResponse.body?.data?.tabs?.[0]?.runs?.find((run) => run.id === "fixture-done");
  const normalizedCancelledRun = subagentsResponse.body?.data?.tabs?.[0]?.runs?.find((run) => run.id === "fixture-cancelled");
  assert.deepEqual(normalizedDoneRun && { status: normalizedDoneRun.status, endedAt: typeof normalizedDoneRun.endedAt, agentStatus: normalizedDoneRun.agents[0]?.status }, {
    status: "done", endedAt: "number", agentStatus: "done",
  }, "normalization should retain completed run state and final agent status");
  assert.deepEqual(normalizedCancelledRun && {
    status: normalizedCancelledRun.status,
    cancelledBy: normalizedCancelledRun.cancelledBy,
    cancelReason: normalizedCancelledRun.cancelReason,
    cancelNote: normalizedCancelledRun.cancelNote,
    agentStatus: normalizedCancelledRun.agents[0]?.status,
  }, {
    status: "cancelled",
    cancelledBy: "user",
    cancelReason: "Taking too long",
    cancelNote: "Use the existing result instead.",
    agentStatus: "cancelled",
  }, "normalization should retain bounded user cancellation metadata");
  const retainedDoneOutput = await request("127.0.0.1", `/api/subagents/output?tab=${encodeURIComponent(tabId)}&run=fixture-done&agent=fixture-done%3A0`);
  assert.equal(retainedDoneOutput.status, 200, "subagent output should remain accessible for retained completed runs");
  assert.equal(retainedDoneOutput.body?.data?.agent?.status, "done");

  const subagentFixtureClear = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: tabId, message: "fixture subagents clear" } });
  assert.equal(subagentFixtureClear.status, 200, "subagent fixture clear should be accepted");
  for (let attempt = 0; attempt < 20; attempt++) {
    subagentsResponse = await request("127.0.0.1", "/api/subagents");
    if (subagentsResponse.body?.data?.totalAgents === 0) break;
    await delay(50);
  }
  assert.equal(subagentsResponse.body?.data?.totalAgents, 0, "an empty helper snapshot should clear retained subagent rows");
  assert.equal(subagentsResponse.body?.data?.totalGates, 0, "cleared retry gates should disappear from the overview");

  const state = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(tabId)}`);
  assert.equal(state.status, 200);
  assert.equal(state.body?.data?.model?.provider, "fake", "state should come from the fake pi RPC");

  const newSessionTitleTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd } });
  assert.equal(newSessionTitleTab.status, 201, `new-session title test tab should open: ${newSessionTitleTab.body?.error || ""}`);
  const newSessionTitleTabId = newSessionTitleTab.body?.data?.tab?.id;
  const defaultNewSessionTabTitle = newSessionTitleTab.body?.data?.tab?.title;
  assert.ok(newSessionTitleTabId && defaultNewSessionTabTitle, "new-session title test tab should include default metadata");
  const autoNamedTab = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { tab: newSessionTitleTabId, message: "verify new session terminal title refresh" },
  });
  assert.equal(autoNamedTab.status, 200, "the title test prompt should be accepted");
  assert.notEqual(autoNamedTab.body?.tab?.title, defaultNewSessionTabTitle, "the first prompt should auto-name the test tab");
  assert.equal(autoNamedTab.body?.tab?.titleSource, "auto", "the generated title should be marked automatic");
  const freshSession = await request("127.0.0.1", "/api/new-session", {
    method: "POST",
    body: { tab: newSessionTitleTabId },
  });
  assert.equal(freshSession.status, 200, `new session should succeed: ${freshSession.body?.error || ""}`);
  assert.equal(freshSession.body?.tab?.title, defaultNewSessionTabTitle, "new-session responses should immediately reset automatic terminal-tab titles");
  assert.equal(freshSession.body?.tab?.titleSource, "default", "a reset title should be eligible for the new session's first-prompt naming");
  assert.equal(freshSession.body?.tab?.conversationStarted, false, "the new session should reset conversation-title tracking");
  const closeNewSessionTitleTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [newSessionTitleTabId] } });
  assert.equal(closeNewSessionTitleTab.status, 200, "new-session title test tab should close before later endpoint checks");

  const forkSourceTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "fork-running-source" } });
  assert.equal(forkSourceTab.status, 201, `fork source tab should open: ${forkSourceTab.body?.error || ""}`);
  const forkSourceTabId = forkSourceTab.body?.data?.tab?.id;
  assert.ok(forkSourceTabId, "fork source tab should have an id");
  const runningPrompt = "voice test slow fork fixture";
  const runningPromptResponse = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { message: runningPrompt, tab: forkSourceTabId }, timeoutMs: 10_000 });
  assert.equal(runningPromptResponse.status, 200, `slow scripted prompt should start: ${runningPromptResponse.body?.error || ""}`);
  let streamingState;
  for (let attempt = 0; attempt < 30; attempt++) {
    streamingState = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(forkSourceTabId)}`);
    if (streamingState.body?.data?.isStreaming === true) break;
    await delay(100);
  }
  assert.equal(streamingState?.body?.data?.isStreaming, true, "source tab should still be running before fork");
  const forkMessagesWhileRunning = await request("127.0.0.1", `/api/fork-messages?tab=${encodeURIComponent(forkSourceTabId)}`);
  assert.equal(forkMessagesWhileRunning.status, 200, "fork selector data should load while the source tab is running");
  const runningForkPoint = (forkMessagesWhileRunning.body?.data?.messages || []).find((item) => item.text === runningPrompt);
  assert.ok(runningForkPoint?.entryId, "running prompt should be available as a fork point");
  const forkWhileRunning = await request("127.0.0.1", "/api/fork", { method: "POST", body: { tab: forkSourceTabId, entryId: runningForkPoint.entryId }, timeoutMs: 10_000 });
  assert.equal(forkWhileRunning.status, 200, `fork while running should succeed: ${forkWhileRunning.body?.error || ""}`);
  const forkedTabId = forkWhileRunning.body?.data?.tab?.id;
  assert.ok(forkedTabId, "fork response should include the opened fork tab");
  assert.notEqual(forkedTabId, forkSourceTabId, "forking should create a new tab instead of replacing the running source tab");
  assert.equal(forkWhileRunning.body?.data?.text, runningPrompt, "fork response should restore the selected prompt text for editing");
  assert.ok((forkWhileRunning.body?.data?.tabs || []).some((tab) => tab.id === forkSourceTabId), "fork response should keep the original running tab in the tab list");
  assert.ok((forkWhileRunning.body?.data?.tabs || []).some((tab) => tab.id === forkedTabId), "fork response should include the new fork tab in the tab list");
  assert.match(String(forkWhileRunning.body?.data?.sessionFile || ""), /\.jsonl$/, "fork response should include the new session file");
  const forkSessionFile = forkWhileRunning.body.data.sessionFile;
  const forkSessionContent = await readFile(forkSessionFile, "utf8");
  assert.match(forkSessionContent, /"type":"session"/, "forked session file should be written before opening its tab");
  const closeOriginalForkTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [forkedTabId] }, timeoutMs: 10_000 });
  assert.equal(closeOriginalForkTab.status, 200, "the original fork tab should close before testing session resume");
  const resumedWhileSourceRuns = await request("127.0.0.1", "/api/switch-session", {
    method: "POST",
    body: { tab: forkSourceTabId, sessionPath: forkSessionFile },
    timeoutMs: 10_000,
  });
  assert.equal(resumedWhileSourceRuns.status, 200, `session resume should open a new tab while the source runs: ${resumedWhileSourceRuns.body?.error || ""}`);
  const resumedTabId = resumedWhileSourceRuns.body?.data?.tab?.id;
  assert.ok(resumedTabId, "session resume should return the new terminal tab");
  assert.notEqual(resumedTabId, forkSourceTabId, "session resume must not replace the source terminal");
  assert.equal(resumedWhileSourceRuns.body?.data?.sourceTab?.id, forkSourceTabId, "session resume should identify the unchanged source terminal");
  assert.ok((resumedWhileSourceRuns.body?.data?.tabs || []).some((tab) => tab.id === forkSourceTabId), "session resume should keep the source terminal open");
  assert.ok((resumedWhileSourceRuns.body?.data?.tabs || []).some((tab) => tab.id === resumedTabId), "session resume should include the new terminal in the tab list");
  const resumedState = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(resumedTabId)}`);
  assert.equal(resumedState.status, 200, "the resumed terminal should respond independently");
  assert.equal(resumedState.body?.data?.sessionFile, forkSessionFile, "the new terminal should load the selected persisted session");
  const sourceAfterFork = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(forkSourceTabId)}`);
  assert.equal(sourceAfterFork.status, 200, "source tab should still respond after forking and resuming elsewhere");
  for (let attempt = 0; attempt < 40 && sourceAfterFork.body?.data?.isStreaming; attempt++) {
    const next = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(forkSourceTabId)}`);
    if (!next.body?.data?.isStreaming) break;
    await delay(100);
  }
  const closeForkTestTabs = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [forkSourceTabId, resumedTabId] }, timeoutMs: 10_000 });
  assert.equal(closeForkTestTabs.status, 200, "fork and resume test tabs should close before continuing baseline endpoint checks");

  const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  if (gitAvailable) {
    const gitInit = await request("127.0.0.1", "/api/git-workflow/init", { method: "POST", body: { tab: tabId } });
    assert.equal(gitInit.status, 200);
    assert.equal(gitInit.body?.ok, true, "git init endpoint should initialize a temp repository");

    const initFileStatus = await request("127.0.0.1", `/api/git-workflow/init-files-status?tab=${encodeURIComponent(tabId)}`);
    assert.equal(initFileStatus.status, 200);
    assert.equal(initFileStatus.body?.ok, true, "init files status endpoint should check README.md and .gitignore");
    assert.equal(initFileStatus.body?.data?.readmeExists, false);
    assert.equal(initFileStatus.body?.data?.gitignoreExists, false);

    const gitReadme = await request("127.0.0.1", "/api/git-workflow/readme", { method: "POST", body: { repoName: "pi-webui-http-harness", stack: "Node.js / TypeScript", tab: tabId } });
    assert.equal(gitReadme.status, 200);
    assert.equal(gitReadme.body?.ok, true, "README endpoint should create/stage README.md and .gitignore");
    assert.equal(gitReadme.body?.data?.readme?.created, true);
    assert.equal(gitReadme.body?.data?.gitignore?.created, true);

    const gitReadmeAgain = await request("127.0.0.1", "/api/git-workflow/readme", { method: "POST", body: { repoName: "pi-webui-http-harness", stack: "Node.js / TypeScript", tab: tabId } });
    assert.equal(gitReadmeAgain.status, 200);
    assert.equal(gitReadmeAgain.body?.ok, true, "README endpoint should re-check existing files without overwriting");
    assert.equal(gitReadmeAgain.body?.data?.readme?.created, false);
    assert.equal(gitReadmeAgain.body?.data?.gitignore?.created, false);

    const bypassCommit = await request("127.0.0.1", `/api/git-workflow/initial-commit?tab=${encodeURIComponent(tabId)}`);
    assert.equal(bypassCommit.status, 405, "GET on a mutating git workflow path should be refused with 405");
    assert.equal(bypassCommit.body?.ok, false, "GET bypass refusal should carry ok: false");
    const headAfterBypass = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    assert.notEqual(headAfterBypass.status, 0, "GET bypass attempt must not create a commit");

    const bypassPush = await request("127.0.0.1", `/api/git-workflow/push?tab=${encodeURIComponent(tabId)}`);
    assert.equal(bypassPush.status, 405, "GET /api/git-workflow/push should be refused with 405");

    const bypassAdd = await request("127.0.0.1", `/api/git-workflow/add?tab=${encodeURIComponent(tabId)}`);
    assert.equal(bypassAdd.status, 405, "GET /api/git-workflow/add should be refused with 405");

    const postReadonly = await request("127.0.0.1", "/api/git-workflow/default-commit-message", { method: "POST", body: { tab: tabId } });
    assert.equal(postReadonly.status, 405, "POST on a read-only git workflow path should be refused with 405");

    const gitCommit = await request("127.0.0.1", "/api/git-workflow/initial-commit", { method: "POST", body: { tab: tabId } });
    assert.equal(gitCommit.status, 200);
    assert.equal(gitCommit.body?.ok, true, "initial commit endpoint should commit the staged README.md");

    const gitMain = await request("127.0.0.1", "/api/git-workflow/main-branch", { method: "POST", body: { tab: tabId } });
    assert.equal(gitMain.status, 200);
    assert.equal(gitMain.body?.ok, true, "main branch endpoint should rename the branch");

    const bypassPublish = await request("127.0.0.1", `/api/git-workflow/publish?tab=${encodeURIComponent(tabId)}`);
    assert.equal(bypassPublish.status, 405, "GET /api/git-workflow/publish should be refused with 405");

    const pushWithoutRemote = await request("127.0.0.1", "/api/git-workflow/push", { method: "POST", body: { tab: tabId } });
    assert.equal(pushWithoutRemote.status, 200);
    assert.equal(pushWithoutRemote.body?.ok, false, "push without a configured destination should fail closed");
    assert.equal(pushWithoutRemote.body?.code, "NO_REMOTE", "remote-less push should have a stable recovery code");
    assert.match(String(pushWithoutRemote.body?.hint || ""), /publish this repository|add a Git remote/i);
    assert.match(String(pushWithoutRemote.body?.data?.stderr || ""), /No configured push destination/i, "classified failures should preserve process output");
    assert.equal(pushWithoutRemote.body?.data?.repoName, path.basename(cwd), "remote-less push should report the local Git root directory name for publication");

    const unconfirmedPublish = await request("127.0.0.1", "/api/git-workflow/publish", {
      method: "POST",
      body: { tab: tabId, repoName: "client-selected-name", visibility: "private" },
    });
    assert.equal(unconfirmedPublish.status, 200);
    assert.equal(unconfirmedPublish.body?.ok, false, "publication should require exact server-side confirmation");
    assert.match(String(unconfirmedPublish.body?.error || ""), /confirmed: true/);
    assert.match(String(unconfirmedPublish.body?.error || ""), new RegExp(`GitHub repository ${path.basename(cwd)} as private`), "publication confirmation should use the server-derived Git root directory name");
    assert.doesNotMatch(String(unconfirmedPublish.body?.error || ""), /client-selected-name/, "publication should ignore client-supplied repository names");

    const invalidVisibilityPublish = await request("127.0.0.1", "/api/git-workflow/publish", {
      method: "POST",
      body: { tab: tabId, visibility: "internal", confirmed: true },
    });
    assert.equal(invalidVisibilityPublish.body?.ok, false, "publication should reject visibility outside public/private");
    assert.match(String(invalidVisibilityPublish.body?.error || ""), /visibility must be 'public' or 'private'/);
    assert.equal(runGitFixture(["remote"], cwd, "guarded publication requests must not configure a remote"), "");

    const initialWorktrees = await request("127.0.0.1", `/api/git-worktrees?tab=${encodeURIComponent(tabId)}`);
    assert.equal(initialWorktrees.status, 200);
    assert.equal(initialWorktrees.body?.ok, true, "worktree list endpoint should return data for a git repository");
    assert.ok(initialWorktrees.body?.data?.worktrees?.some((worktree) => worktree.isMainWorktree && worktree.current), "worktree list should include the current main worktree");

    const originMainBase = runGitFixture(["rev-parse", "HEAD"], cwd, "origin/main base fixture should resolve current HEAD");
    runGitFixture(["update-ref", "refs/remotes/origin/main", originMainBase], cwd, "origin/main base fixture should create a remote-tracking ref");
    await writeFile(path.join(cwd, "workspace-head.txt"), "current workspace only\n");
    runGitFixture(["add", "workspace-head.txt"], cwd, "workspace HEAD fixture should stage its marker");
    runGitFixture(["commit", "-m", "test: advance workspace head"], cwd, "workspace HEAD fixture should advance main beyond origin/main");
    const workspaceHead = runGitFixture(["rev-parse", "HEAD"], cwd, "workspace HEAD fixture should resolve advanced HEAD");
    assert.notEqual(workspaceHead, originMainBase, "workspace HEAD should differ from origin/main for base selection coverage");

    const originBasedBranch = "feat/origin-main-base";
    const originBasedWorktree = await request("127.0.0.1", "/api/git-worktrees", {
      method: "POST",
      body: { tab: tabId, branchName: originBasedBranch, baseRef: "origin/main", sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(originBasedWorktree.status, 200);
    assert.equal(originBasedWorktree.body?.ok, true, `origin/main-based worktree should be created: ${originBasedWorktree.body?.error || ""}`);
    const originBasedWorktreePath = originBasedWorktree.body?.data?.worktree?.path || originBasedWorktree.body?.data?.path;
    const originBasedWorktreeTabId = originBasedWorktree.body?.data?.tab?.id;
    assert.equal(runGitFixture(["rev-parse", "HEAD"], originBasedWorktreePath, "origin/main-based worktree should resolve its HEAD"), originMainBase, "explicit baseRef should create the branch from origin/main rather than the current workspace HEAD");
    const closeOriginBasedTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [originBasedWorktreeTabId] }, timeoutMs: 10_000 });
    assert.equal(closeOriginBasedTab.body?.ok, true, "origin/main-based worktree tab should close before cleanup");
    const removeOriginBasedWorktree = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: tabId, path: originBasedWorktreePath, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(removeOriginBasedWorktree.body?.ok, true, "origin/main-based worktree should be removable after the tab closes");

    await writeFile(path.join(cwd, "guided.txt"), "guided worktree flow\n");
    runGitFixture(["add", "guided.txt"], cwd, "source checkout should stage guided workflow changes");
    await mkdir(path.join(cwd, "dev", "COMMIT"), { recursive: true });
    await writeFile(path.join(cwd, "dev", "COMMIT", "staged-commit-short.txt"), "feat: guided worktree branch\n");
    await writeFile(path.join(cwd, "dev", "COMMIT", "staged-commit-long.txt"), "feat: guided worktree branch\n- feat: cover guided branch worktrees\n");
    const guidedBranch = "feat/guided-worktree";
    const guidedWorktree = await request("127.0.0.1", "/api/git-workflow/branch", {
      method: "POST",
      body: { tab: tabId, branch: guidedBranch, sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(guidedWorktree.status, 200);
    assert.equal(guidedWorktree.body?.ok, true, `guided branch worktree endpoint should return ok: ${guidedWorktree.body?.error || ""}`);
    assert.equal(guidedWorktree.body?.data?.created, true, "guided branch flow should create a worktree instead of switching in place");
    assert.equal(guidedWorktree.body?.data?.branch, guidedBranch);
    assert.equal(guidedWorktree.body?.data?.carriedStagedChanges, true, "guided branch worktree should copy staged changes into the worktree index");
    assert.ok(guidedWorktree.body?.data?.copiedMessageFiles?.includes("dev/COMMIT/staged-commit-short.txt"), "guided branch worktree should copy short commit message file");
    assert.ok(guidedWorktree.body?.data?.copiedMessageFiles?.includes("dev/COMMIT/staged-commit-long.txt"), "guided branch worktree should copy long commit message file");
    const guidedWorktreePath = guidedWorktree.body?.data?.worktree?.path || guidedWorktree.body?.data?.path;
    const guidedWorktreeTabId = guidedWorktree.body?.data?.tab?.id;
    assert.ok(guidedWorktreePath, "guided branch worktree response should include the worktree path");
    assert.ok(guidedWorktreeTabId, "guided branch worktree should open a Web UI tab");
    assert.equal(guidedWorktree.body?.data?.tab?.cwd, guidedWorktreePath, "guided worktree tab should be rooted at the worktree path");
    assert.equal(guidedWorktree.body?.data?.tab?.gitWorkspace?.branch, guidedBranch, "guided worktree tab metadata should record the branch");
    assert.equal(runGitFixture(["branch", "--show-current"], cwd, "source checkout should stay on main after guided worktree creation"), "main");
    assert.match(runGitFixture(["status", "--short"], guidedWorktreePath, "guided worktree should have copied staged changes"), /^A  guided\.txt/m);
    const guidedCommit = await request("127.0.0.1", "/api/git-workflow/commit", { method: "POST", body: { variant: "short", tab: guidedWorktreeTabId }, timeoutMs: 20_000 });
    assert.equal(guidedCommit.status, 200);
    assert.equal(guidedCommit.body?.ok, true, "guided worktree tab should continue the commit flow with copied message files");
    assert.equal(runGitFixture(["branch", "--show-current"], guidedWorktreePath, "guided worktree should remain on the PR branch"), guidedBranch);
    const closeGuidedWorktreeTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [guidedWorktreeTabId] }, timeoutMs: 10_000 });
    assert.equal(closeGuidedWorktreeTab.status, 200);
    assert.equal(closeGuidedWorktreeTab.body?.ok, true, "guided worktree tab should close before cleanup");
    const removeGuidedWorktree = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: tabId, path: guidedWorktreePath, confirmed: true, force: true }, timeoutMs: 20_000 });
    assert.equal(removeGuidedWorktree.status, 200);
    assert.equal(removeGuidedWorktree.body?.ok, true, "guided worktree should be removable after the tab is closed");
    runGitFixture(["reset", "--hard"], cwd, "source checkout should clean staged guided workflow fixture changes");
    await rm(path.join(cwd, "dev"), { recursive: true, force: true });

    const worktreeBranch = "feat/http-worktree";
    const createWorktree = await request("127.0.0.1", "/api/git-worktrees", {
      method: "POST",
      body: { tab: tabId, branchName: worktreeBranch, baseRef: "HEAD", sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(createWorktree.status, 200);
    assert.equal(createWorktree.body?.ok, true, `worktree create endpoint should return ok: ${createWorktree.body?.error || ""}`);
    assert.equal(createWorktree.body?.data?.created, true, "creating a new branch worktree should report created=true");
    assert.equal(createWorktree.body?.data?.branch, worktreeBranch);
    const worktreePath = createWorktree.body?.data?.worktree?.path || createWorktree.body?.data?.path;
    const worktreeTabId = createWorktree.body?.data?.tab?.id;
    assert.ok(worktreePath, "created worktree response should include a worktree path");
    assert.ok(worktreeTabId, "creating a branch worktree should open a tab by default");
    assert.equal(createWorktree.body?.data?.tab?.cwd, worktreePath, "opened worktree tab should be rooted at the worktree path");
    assert.equal(createWorktree.body?.data?.tab?.gitWorkspace?.branch, worktreeBranch, "opened tab metadata should record the worktree branch");
    assert.equal(createWorktree.body?.data?.tab?.gitWorkspace?.worktreePath, worktreePath, "opened tab metadata should record the worktree path");
    assert.equal(runGitFixture(["rev-parse", "HEAD"], worktreePath, "current-HEAD-based worktree should resolve its HEAD"), workspaceHead, "explicit HEAD baseRef should create the branch from the active workspace commit");

    const branchesWithWorktree = await request("127.0.0.1", `/api/git-branches?tab=${encodeURIComponent(tabId)}`);
    assert.equal(branchesWithWorktree.status, 200);
    assert.equal(branchesWithWorktree.body?.ok, true, "git branch list should still load after creating a worktree");
    const occupiedBranch = branchesWithWorktree.body?.data?.branches?.find((branch) => branch.name === worktreeBranch);
    assert.equal(occupiedBranch?.occupied, true, "branch list should mark branches checked out in a worktree");
    assert.equal(occupiedBranch?.worktreePath, worktreePath, "branch list should point occupied branches at their worktree");
    assert.equal(occupiedBranch?.worktreeCurrent, false, "main checkout should see the new branch as checked out elsewhere");
    assert.ok(branchesWithWorktree.body?.data?.occupiedBranches?.some((branch) => branch.branch === worktreeBranch && branch.path === worktreePath), "occupied branch summary should include the new worktree");

    const occupiedSwitch = await request("127.0.0.1", "/api/git-branch", { method: "POST", body: { tab: tabId, branch: worktreeBranch } });
    assert.equal(occupiedSwitch.status, 200);
    assert.equal(occupiedSwitch.body?.ok, false, "switching to a branch checked out in another worktree should be refused");
    assert.equal(occupiedSwitch.body?.code, "BRANCH_CHECKED_OUT_ELSEWHERE");
    assert.match(String(occupiedSwitch.body?.error || ""), /Open that worktree instead/);

    const duplicateWorktree = await request("127.0.0.1", "/api/git-worktrees", {
      method: "POST",
      body: { tab: tabId, branchName: worktreeBranch, sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(duplicateWorktree.status, 200);
    assert.equal(duplicateWorktree.body?.ok, true, "creating an already checked out branch should reuse the existing worktree");
    assert.equal(duplicateWorktree.body?.data?.created, false);
    assert.equal(duplicateWorktree.body?.data?.openedExisting, true);
    assert.equal(duplicateWorktree.body?.data?.openedExistingTab, true, "already-open worktree tab should be reused");
    assert.equal(duplicateWorktree.body?.data?.tab?.id, worktreeTabId);

    const openedWorktree = await request("127.0.0.1", "/api/git-worktrees/open", {
      method: "POST",
      body: { tab: tabId, path: worktreePath, sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(openedWorktree.status, 200);
    assert.equal(openedWorktree.body?.ok, true, "opening an existing worktree should return ok");
    assert.equal(openedWorktree.body?.data?.openedExistingTab, true, "opening an already-open worktree should reuse its tab");
    assert.equal(openedWorktree.body?.data?.tab?.id, worktreeTabId);

    const unconfirmedRemove = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: tabId, path: worktreePath } });
    assert.equal(unconfirmedRemove.status, 200);
    assert.equal(unconfirmedRemove.body?.ok, false, "worktree removal should require explicit confirmation");
    assert.match(String(unconfirmedRemove.body?.error || ""), /requires confirmed: true/);

    const busyRemove = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: tabId, path: worktreePath, confirmed: true } });
    assert.equal(busyRemove.status, 200);
    assert.equal(busyRemove.body?.ok, false, "worktree removal should be refused while a Web UI tab is open inside it");
    assert.equal(busyRemove.body?.code, "WORKTREE_BUSY");

    const closeWorktreeTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [worktreeTabId] }, timeoutMs: 10_000 });
    assert.equal(closeWorktreeTab.status, 200);
    assert.equal(closeWorktreeTab.body?.ok, true, "worktree tab should close before removal");
    assert.ok(closeWorktreeTab.body?.data?.closedIds?.includes(worktreeTabId), "close response should include the worktree tab id");

    const removedWorktree = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: tabId, path: worktreePath, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(removedWorktree.status, 200);
    assert.equal(removedWorktree.body?.ok, true, `confirmed worktree removal should succeed: ${removedWorktree.body?.error || ""}`);
    assert.equal(removedWorktree.body?.data?.removed, true);
    assert.equal(removedWorktree.body?.data?.path, worktreePath);

    const worktreesAfterRemoval = await request("127.0.0.1", `/api/git-worktrees?tab=${encodeURIComponent(tabId)}`);
    assert.equal(worktreesAfterRemoval.status, 200);
    assert.equal(worktreesAfterRemoval.body?.ok, true);
    assert.equal(worktreesAfterRemoval.body?.data?.worktrees?.some((worktree) => worktree.path === worktreePath), false, "removed worktree should disappear from list output");
    assert.equal(worktreesAfterRemoval.body?.data?.occupiedBranches?.some((branch) => branch.branch === worktreeBranch), false, "removed worktree should disappear from occupied branch output");

    const remoteFixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-git-remote-"));
    const remoteBare = path.join(remoteFixtureRoot, "origin.git");
    const localRepo = path.join(remoteFixtureRoot, "local");
    const remoteWork = path.join(remoteFixtureRoot, "remote-work");
    runGitFixture(["init", "--bare", remoteBare], remoteFixtureRoot, "remote fixture should initialize a bare origin");
    runGitFixture(["init", localRepo], remoteFixtureRoot, "remote fixture should initialize a local repo");
    runGitFixture(["config", "user.name", "Pi WebUI Test"], localRepo, "local repo should set a user name");
    runGitFixture(["config", "user.email", "pi-webui-test@example.invalid"], localRepo, "local repo should set a user email");
    await writeFile(path.join(localRepo, "incoming.txt"), "base\n");
    runGitFixture(["add", "incoming.txt"], localRepo, "local repo should stage base content");
    runGitFixture(["commit", "-m", "base"], localRepo, "local repo should commit base content");
    runGitFixture(["branch", "-M", "main"], localRepo, "local repo should rename main branch");
    runGitFixture(["remote", "add", "origin", remoteBare], localRepo, "local repo should add bare origin");
    runGitFixture(["push", "-u", "origin", "main"], localRepo, "local repo should push main to bare origin");
    runGitFixture(["symbolic-ref", "HEAD", "refs/heads/main"], remoteBare, "bare origin should advertise main as HEAD");
    runGitFixture(["clone", remoteBare, remoteWork], remoteFixtureRoot, "remote worktree should clone bare origin");
    runGitFixture(["config", "user.name", "Pi WebUI Test"], remoteWork, "remote worktree should set a user name");
    runGitFixture(["config", "user.email", "pi-webui-test@example.invalid"], remoteWork, "remote worktree should set a user email");
    await writeFile(path.join(remoteWork, "incoming.txt"), "base\nremote one\n");
    runGitFixture(["commit", "-am", "remote one"], remoteWork, "remote worktree should commit first incoming change");
    await writeFile(path.join(remoteWork, "incoming.txt"), "base\nremote one\nremote two\n");
    runGitFixture(["commit", "-am", "remote two"], remoteWork, "remote worktree should commit second incoming change");
    runGitFixture(["push", "origin", "main"], remoteWork, "remote worktree should push incoming commits");

    const remoteOnlySwitchBranch = "feature/remote-only-switch";
    runGitFixture(["switch", "-c", remoteOnlySwitchBranch], remoteWork, "remote worktree should create the switch fixture branch");
    await writeFile(path.join(remoteWork, "remote-switch.txt"), "switch fixture\n");
    runGitFixture(["add", "remote-switch.txt"], remoteWork, "remote switch fixture should stage its marker");
    runGitFixture(["commit", "-m", "remote switch fixture"], remoteWork, "remote switch fixture should commit its marker");
    runGitFixture(["push", "-u", "origin", remoteOnlySwitchBranch], remoteWork, "remote switch fixture should push its branch");
    runGitFixture(["switch", "main"], remoteWork, "remote worktree should return to main after the switch fixture");

    const remoteOnlyWorktreeBranch = "feature/remote-only-worktree";
    runGitFixture(["switch", "-c", remoteOnlyWorktreeBranch], remoteWork, "remote worktree should create the worktree fixture branch");
    await writeFile(path.join(remoteWork, "remote-worktree.txt"), "worktree fixture\n");
    runGitFixture(["add", "remote-worktree.txt"], remoteWork, "remote worktree fixture should stage its marker");
    runGitFixture(["commit", "-m", "remote worktree fixture"], remoteWork, "remote worktree fixture should commit its marker");
    runGitFixture(["push", "-u", "origin", remoteOnlyWorktreeBranch], remoteWork, "remote worktree fixture should push its branch");
    runGitFixture(["switch", "main"], remoteWork, "remote worktree should return to main after the worktree fixture");

    const remoteOnlyCreateBranch = "feature/remote-only-create";
    runGitFixture(["branch", remoteOnlyCreateBranch], remoteWork, "remote worktree should create the local-create compatibility fixture branch");
    runGitFixture(["push", "origin", remoteOnlyCreateBranch], remoteWork, "remote create fixture should push its branch");
    const staleRemoteBranch = "feature/remote-only-stale";
    runGitFixture(["branch", staleRemoteBranch], remoteWork, "remote worktree should create the stale fixture branch");
    runGitFixture(["push", "origin", staleRemoteBranch], remoteWork, "remote stale fixture should push its branch");

    runGitFixture(["remote", "add", "mirror", remoteBare], localRepo, "local repo should add a second configured remote for exact-ref coverage");
    runGitFixture(["remote", "add", "team/mirror", remoteBare], localRepo, "local repo should add a slash-named remote for exact local-name derivation coverage");

    const remoteTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: localRepo, title: "remote-behind-fixture" } });
    assert.equal(remoteTab.status, 201);
    const remoteTabId = remoteTab.body?.data?.tab?.id;
    assert.ok(remoteTabId, "remote fixture tab should have an id");

    const fetchedRemoteBranches = await request("127.0.0.1", "/api/git-fetch", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 20_000 });
    assert.equal(fetchedRemoteBranches.status, 200);
    assert.equal(fetchedRemoteBranches.body?.ok, true, `git fetch --prune should reveal remote-only branches: ${fetchedRemoteBranches.body?.error || ""}`);
    runGitFixture(["fetch", "mirror"], localRepo, "remote fixture should fetch the second remote for exact-ref collision coverage");
    runGitFixture(["fetch", "team/mirror"], localRepo, "remote fixture should fetch the slash-named remote for prefix matching coverage");
    runGitFixture(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], localRepo, "remote fixture should create a symbolic remote HEAD alias");
    runGitFixture(["branch", "origin/main", "main"], localRepo, "remote fixture should create a local ref that makes refname:short ambiguous");

    const listedRemoteBranches = await request("127.0.0.1", `/api/git-branches?tab=${encodeURIComponent(remoteTabId)}`);
    assert.equal(listedRemoteBranches.status, 200);
    assert.equal(listedRemoteBranches.body?.ok, true, "branch listing should include fetched remote-only branches");
    const branchRecords = listedRemoteBranches.body?.data?.branches || [];
    const originRemoteSwitch = branchRecords.find((branch) => branch.remote === true && branch.remoteRef === `origin/${remoteOnlySwitchBranch}`);
    assert.deepEqual(originRemoteSwitch, {
      name: remoteOnlySwitchBranch,
      current: false,
      remote: true,
      remoteRef: `origin/${remoteOnlySwitchBranch}`,
      remoteName: "origin",
      displayName: `origin/${remoteOnlySwitchBranch}`,
    }, "remote-only rows should carry explicit local and exact remote metadata");
    const sameNameRemoteRefs = branchRecords
      .filter((branch) => branch.remote === true && branch.name === remoteOnlySwitchBranch)
      .map((branch) => branch.remoteRef)
      .sort();
    assert.deepEqual(sameNameRemoteRefs, [`mirror/${remoteOnlySwitchBranch}`, `origin/${remoteOnlySwitchBranch}`, `team/mirror/${remoteOnlySwitchBranch}`], "same-name remote-only branches should remain distinct by exact ref even when a remote name contains a slash");
    assert.equal(branchRecords.some((branch) => branch.remote === true && branch.remoteRef === "origin/HEAD"), false, "symbolic remote HEAD aliases must not be listed");
    assert.equal(branchRecords.some((branch) => branch.remote === true && branch.name === "main"), false, "a local branch should hide same-named remote rows");
    assert.ok(branchRecords.some((branch) => branch.remote !== true && branch.name === "origin/main"), "local branch names must not change when refname shortening would be ambiguous");
    assert.equal(listedRemoteBranches.body?.data?.remoteBranchesTruncated, false, "complete remote branch output should not be marked truncated");

    const implicitRemoteSwitch = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: remoteOnlySwitchBranch },
    });
    assert.equal(implicitRemoteSwitch.body?.ok, false, "remote-only names without an exact remoteRef must not trigger Git DWIM tracking creation");
    assert.match(String(implicitRemoteSwitch.body?.error || ""), /Unknown local git branch/, "implicit remote selection should retain the local-only API guard");
    assert.equal(runGitFixture(["branch", "--list", remoteOnlySwitchBranch], localRepo, "implicit remote switch should not create a local branch"), "");

    const localCreateOverRemote = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: remoteOnlyCreateBranch, create: true },
      timeoutMs: 20_000,
    });
    assert.equal(localCreateOverRemote.body?.ok, true, "explicit local branch creation should remain available when a same-named remote-only branch exists");
    assert.equal(runGitFixture(["branch", "--show-current"], localRepo, "local create compatibility path should switch to its new branch"), remoteOnlyCreateBranch);
    const createdUpstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: localRepo, encoding: "utf8" });
    assert.notEqual(createdUpstream.status, 0, "explicit local creation should not silently track the same-named remote branch");
    runGitFixture(["switch", "main"], localRepo, "local repo should return to main after local-create compatibility coverage");

    runGitFixture(["push", "origin", "--delete", staleRemoteBranch], remoteWork, "remote fixture should delete the stale branch upstream");
    const prunedRemoteBranches = await request("127.0.0.1", "/api/git-fetch", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 20_000 });
    assert.equal(prunedRemoteBranches.body?.ok, true, "git fetch --prune should remove the deleted origin tracking ref");
    const staleRemoteSwitch = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: staleRemoteBranch, remoteRef: `origin/${staleRemoteBranch}` },
    });
    assert.equal(staleRemoteSwitch.body?.ok, false, "acting on a remote ref removed by prune must fail closed");
    assert.match(String(staleRemoteSwitch.body?.error || ""), /Unknown remote git branch/, "stale remote actions should explain that the advertised ref no longer exists");
    assert.equal(runGitFixture(["branch", "--list", staleRemoteBranch], localRepo, "stale remote action should not create a local branch"), "");

    const mismatchedRemoteSwitch = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: remoteOnlySwitchBranch, remoteRef: `origin/${remoteOnlyWorktreeBranch}` },
    });
    assert.equal(mismatchedRemoteSwitch.status, 200);
    assert.equal(mismatchedRemoteSwitch.body?.ok, false, "a remote ref must match its submitted local branch name");
    assert.equal(runGitFixture(["branch", "--list", remoteOnlySwitchBranch], localRepo, "mismatched remote switch should not create a local branch"), "");

    const switchedRemoteBranch = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: remoteOnlySwitchBranch, remoteRef: `origin/${remoteOnlySwitchBranch}` },
      timeoutMs: 20_000,
    });
    assert.equal(switchedRemoteBranch.status, 200);
    assert.equal(switchedRemoteBranch.body?.ok, true, `remote-only switch should create a tracking branch: ${switchedRemoteBranch.body?.error || ""}`);
    assert.equal(runGitFixture(["branch", "--show-current"], localRepo, "remote-only switch should remain attached"), remoteOnlySwitchBranch);
    assert.equal(runGitFixture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], localRepo, "remote-only switch should configure its upstream"), `origin/${remoteOnlySwitchBranch}`);

    const collisionRemoteSwitch = await request("127.0.0.1", "/api/git-branch", {
      method: "POST",
      body: { tab: remoteTabId, branch: remoteOnlySwitchBranch, remoteRef: `mirror/${remoteOnlySwitchBranch}` },
    });
    assert.equal(collisionRemoteSwitch.status, 200);
    assert.equal(collisionRemoteSwitch.body?.ok, false, "a newly materialized local branch should reject a same-name remote selection");
    assert.equal(runGitFixture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], localRepo, "collision rejection must preserve the original upstream"), `origin/${remoteOnlySwitchBranch}`);

    const switchedBackToMain = await request("127.0.0.1", "/api/git-branch", { method: "POST", body: { tab: remoteTabId, branch: "main" }, timeoutMs: 20_000 });
    assert.equal(switchedBackToMain.status, 200);
    assert.equal(switchedBackToMain.body?.ok, true, "local branch switching should remain unchanged after remote switching");

    const mismatchedRemoteWorktree = await request("127.0.0.1", "/api/git-worktrees", {
      method: "POST",
      body: { tab: remoteTabId, branchName: remoteOnlyWorktreeBranch, remoteRef: `origin/${remoteOnlySwitchBranch}`, sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(mismatchedRemoteWorktree.status, 200);
    assert.equal(mismatchedRemoteWorktree.body?.ok, false, "a worktree remote ref must match its submitted local branch name");
    assert.equal(runGitFixture(["branch", "--list", remoteOnlyWorktreeBranch], localRepo, "mismatched remote worktree should not create a local branch"), "");

    const remoteTrackingWorktree = await request("127.0.0.1", "/api/git-worktrees", {
      method: "POST",
      body: { tab: remoteTabId, branchName: remoteOnlyWorktreeBranch, remoteRef: `team/mirror/${remoteOnlyWorktreeBranch}`, sessionMode: "empty", openTab: true },
      timeoutMs: 20_000,
    });
    assert.equal(remoteTrackingWorktree.status, 200);
    assert.equal(remoteTrackingWorktree.body?.ok, true, `remote-only worktree should create a tracking branch: ${remoteTrackingWorktree.body?.error || ""}`);
    const remoteTrackingWorktreePath = remoteTrackingWorktree.body?.data?.worktree?.path || remoteTrackingWorktree.body?.data?.path;
    const remoteTrackingWorktreeTabId = remoteTrackingWorktree.body?.data?.tab?.id;
    assert.ok(remoteTrackingWorktreePath, "remote-only worktree response should include its path");
    assert.ok(remoteTrackingWorktreeTabId, "remote-only worktree should open a tab");
    assert.equal(runGitFixture(["branch", "--show-current"], remoteTrackingWorktreePath, "remote-only worktree should remain attached"), remoteOnlyWorktreeBranch);
    assert.equal(runGitFixture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], remoteTrackingWorktreePath, "remote-only worktree should configure its upstream"), `team/mirror/${remoteOnlyWorktreeBranch}`);
    const closeRemoteTrackingWorktreeTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [remoteTrackingWorktreeTabId] }, timeoutMs: 10_000 });
    assert.equal(closeRemoteTrackingWorktreeTab.body?.ok, true, "remote-only worktree tab should close before cleanup");
    const removeRemoteTrackingWorktree = await request("127.0.0.1", "/api/git-worktrees", { method: "DELETE", body: { tab: remoteTabId, path: remoteTrackingWorktreePath, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(removeRemoteTrackingWorktree.body?.ok, true, "remote-only tracking worktree should be removable after the tab closes");

    const incomingChanges = await request("127.0.0.1", `/api/git-changes?tab=${encodeURIComponent(remoteTabId)}`);
    assert.equal(incomingChanges.status, 200);
    assert.equal(incomingChanges.body?.ok, true, "git changes endpoint should load a fetched-behind repo");
    assert.equal(incomingChanges.body?.data?.summary?.behind, 2, "git changes endpoint should report two fetched commits behind");
    assert.equal(incomingChanges.body?.data?.remote?.canPull, true, "git changes endpoint should mark fetched commits as pullable");
    assert.ok(incomingChanges.body?.data?.sections?.some((section) => section.key === "incoming"), "git changes endpoint should include an incoming diff section");

    const pullIncoming = await request("127.0.0.1", "/api/git-changes/pull", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 20_000 });
    assert.equal(pullIncoming.status, 200);
    assert.equal(pullIncoming.body?.ok, true, "pull endpoint should fast-forward fetched incoming commits");
    assert.equal(pullIncoming.body?.data?.changes?.summary?.behind, 0, "pull endpoint should refresh changes with no remote commits left behind");

    const gitRemote = await request("127.0.0.1", "/api/git-workflow/remote", { method: "POST", body: { username: "Firstp1ck", repoName: "pi-webui-http-harness", tab: tabId } });
    assert.equal(gitRemote.status, 200);
    assert.equal(gitRemote.body?.ok, true, "remote endpoint should add origin without pushing");
    assert.equal(gitRemote.body?.data?.remoteUrl, "https://github.com/Firstp1ck/pi-webui-http-harness.git");

    if (process.platform === "win32") {
      const ordinaryPath = path.join(cwd, "preflight-should-not-stage.txt");
      const reservedPath = path.toNamespacedPath(path.join(cwd, "NUL"));
      await writeFile(ordinaryPath, "ordinary untracked file\n");
      await writeFile(reservedPath, "accidental device-name file\n");
      try {
        const reservedAdd = await request("127.0.0.1", "/api/git-workflow/add", { method: "POST", body: { tab: tabId } });
        assert.equal(reservedAdd.status, 200);
        assert.equal(reservedAdd.body?.ok, false, "git add endpoint should reject Windows-reserved paths before staging");
        assert.equal(reservedAdd.body?.code, "INVALID_WORKTREE_PATH");
        assert.match(String(reservedAdd.body?.error || ""), /Windows-reserved path "NUL"/);
        assert.match(String(reservedAdd.body?.hint || ""), /Delete or rename "NUL"/);
        assert.equal(runGitFixture(["diff", "--cached", "--name-only"], cwd, "reserved-path preflight should leave the index untouched"), "");
      } finally {
        await rm(reservedPath, { force: true });
        await rm(ordinaryPath, { force: true });
      }
    }

    await writeFile(path.join(cwd, "single.txt"), "created\n");
    const gitAddCreated = await request("127.0.0.1", "/api/git-workflow/add", { method: "POST", body: { tab: tabId } });
    assert.equal(gitAddCreated.status, 200);
    assert.equal(gitAddCreated.body?.ok, true, "git add endpoint should stage a new single file");
    const createdDefault = await request("127.0.0.1", `/api/git-workflow/default-commit-message?tab=${encodeURIComponent(tabId)}`);
    assert.equal(createdDefault.status, 200);
    assert.equal(createdDefault.body?.ok, true, "default commit message endpoint should return ok for a staged single file");
    assert.equal(createdDefault.body?.data?.message, "created single.txt");
    const createdCommit = await request("127.0.0.1", "/api/git-workflow/commit", { method: "POST", body: { variant: "input", message: createdDefault.body?.data?.message, tab: tabId } });
    assert.equal(createdCommit.status, 200);
    assert.equal(createdCommit.body?.ok, true, "input commit endpoint should accept the generated single-file default");

    await writeFile(path.join(cwd, "single.txt"), "updated\n");
    const gitAddUpdated = await request("127.0.0.1", "/api/git-workflow/add", { method: "POST", body: { tab: tabId } });
    assert.equal(gitAddUpdated.status, 200);
    assert.equal(gitAddUpdated.body?.ok, true, "git add endpoint should stage a single-file update");
    const updatedDefault = await request("127.0.0.1", `/api/git-workflow/default-commit-message?tab=${encodeURIComponent(tabId)}`);
    assert.equal(updatedDefault.status, 200);
    assert.equal(updatedDefault.body?.data?.message, "updated single.txt");
    const updatedCommit = await request("127.0.0.1", "/api/git-workflow/commit", { method: "POST", body: { variant: "input", message: updatedDefault.body?.data?.message, tab: tabId } });
    assert.equal(updatedCommit.status, 200);
    assert.equal(updatedCommit.body?.ok, true, "input commit endpoint should accept the update default");

    await rm(path.join(cwd, "single.txt"));
    const gitAddDeleted = await request("127.0.0.1", "/api/git-workflow/add", { method: "POST", body: { tab: tabId } });
    assert.equal(gitAddDeleted.status, 200);
    assert.equal(gitAddDeleted.body?.ok, true, "git add endpoint should stage a single-file deletion");
    const deletedDefault = await request("127.0.0.1", `/api/git-workflow/default-commit-message?tab=${encodeURIComponent(tabId)}`);
    assert.equal(deletedDefault.status, 200);
    assert.equal(deletedDefault.body?.data?.message, "deleted single.txt");

    await writeFile(path.join(cwd, "multi-a.txt"), "a\n");
    await writeFile(path.join(cwd, "multi-b.txt"), "b\n");
    const gitAddMultiple = await request("127.0.0.1", "/api/git-workflow/add", { method: "POST", body: { tab: tabId } });
    assert.equal(gitAddMultiple.status, 200);
    assert.equal(gitAddMultiple.body?.ok, true, "git add endpoint should stage multiple files");
    const multipleDefault = await request("127.0.0.1", `/api/git-workflow/default-commit-message?tab=${encodeURIComponent(tabId)}`);
    assert.equal(multipleDefault.status, 200);
    assert.equal(multipleDefault.body?.ok, true, "default commit message endpoint should still return ok when no default is available");
    assert.equal(multipleDefault.body?.data?.message, "", "multiple staged files should not get a default commit message");

    // ---- Git action endpoints: staging, operations, stash, fetch/divergence, undo, tags, prune ----

    const gitFixturesRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-git-actions-"));
    const makeFixtureRepo = async (name) => {
      const dir = path.join(gitFixturesRoot, name);
      await mkdir(dir, { recursive: true });
      runGitFixture(["init", "-b", "main", dir], gitFixturesRoot, `${name} fixture should initialize`);
      runGitFixture(["config", "core.autocrlf", "false"], dir, `${name} fixture should keep line endings deterministic`);
      runGitFixture(["config", "user.name", "Pi WebUI Test"], dir, `${name} fixture should set user name`);
      runGitFixture(["config", "user.email", "pi-webui-test@example.invalid"], dir, `${name} fixture should set user email`);
      await writeFile(path.join(dir, "file.txt"), "base\n");
      runGitFixture(["add", "file.txt"], dir, `${name} fixture should stage base`);
      runGitFixture(["commit", "-m", "base"], dir, `${name} fixture should commit base`);
      return dir;
    };
    const openFixtureTab = async (dir, title) => {
      const created = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: dir, title } });
      assert.equal(created.status, 201, `${title} tab should open`);
      const id = created.body?.data?.tab?.id;
      assert.ok(id, `${title} tab should have an id`);
      return id;
    };
    const addToGitignore = (tab, targetPath, kind) => request("127.0.0.1", "/api/git-changes/add-to-gitignore", {
      method: "POST",
      body: { tab, path: targetPath, kind },
    });

    // Add-to-gitignore mutation: literal entries, idempotence, line endings, validation, and target safety.
    const gitignoreRepo = await makeFixtureRepo("add-to-gitignore");
    const gitignoreTab = await openFixtureTab(gitignoreRepo, "add-to-gitignore-fixture");
    await mkdir(path.join(gitignoreRepo, "generated"), { recursive: true });
    await writeFile(path.join(gitignoreRepo, "generated", "output.log"), "generated\n");
    await mkdir(path.join(gitignoreRepo, "build"), { recursive: true });
    await writeFile(path.join(gitignoreRepo, "build", "bundle.js"), "bundle\n");
    const indexBeforeGitignore = runGitFixture(["diff", "--cached", "--raw"], gitignoreRepo, "gitignore fixture should start with an unchanged index");

    const addIgnoredFile = await addToGitignore(gitignoreTab, "generated/output.log", "file");
    assert.equal(addIgnoredFile.status, 200);
    assert.equal(addIgnoredFile.body?.ok, true, `adding a file to .gitignore should succeed: ${addIgnoredFile.body?.error || ""}`);
    assert.deepEqual({
      root: addIgnoredFile.body?.data?.root,
      path: addIgnoredFile.body?.data?.path,
      kind: addIgnoredFile.body?.data?.kind,
      entry: addIgnoredFile.body?.data?.entry,
      added: addIgnoredFile.body?.data?.added,
    }, {
      root: gitignoreRepo,
      path: "generated/output.log",
      kind: "file",
      entry: "/generated/output.log",
      added: true,
    }, "file mutations should return the approved normalized contract");
    assert.equal((await readFile(path.join(gitignoreRepo, ".gitignore"), "utf8")), "/generated/output.log\n", "a missing root .gitignore should be created with one LF-terminated entry");
    assert.equal(addIgnoredFile.body?.data?.changes?.untracked?.some((entry) => entry.path === ".gitignore"), true, "the mutation response should contain refreshed Git status including .gitignore");
    assert.equal(addIgnoredFile.body?.data?.changes?.untracked?.some((entry) => entry.path === "generated/output.log"), false, "the refreshed snapshot should no longer list the newly ignored file");

    const bytesBeforeRepeat = await readFile(path.join(gitignoreRepo, ".gitignore"));
    const repeatIgnoredFile = await addToGitignore(gitignoreTab, "generated/output.log", "file");
    assert.equal(repeatIgnoredFile.body?.data?.added, false, "an exact repeated entry should report a no-op");
    assert.deepEqual(await readFile(path.join(gitignoreRepo, ".gitignore")), bytesBeforeRepeat, "an exact repeated entry must be byte-idempotent");

    const addIgnoredFolder = await addToGitignore(gitignoreTab, "build", "folder");
    assert.equal(addIgnoredFolder.body?.data?.entry, "/build/", "folder entries should receive exactly one trailing slash");
    assert.equal(await readFile(path.join(gitignoreRepo, ".gitignore"), "utf8"), "/generated/output.log\n/build/\n", "folder entries should append without rewriting existing content");

    const concurrentResults = await Promise.all([
      addToGitignore(gitignoreTab, "concurrent/cache.bin", "file"),
      addToGitignore(gitignoreTab, "concurrent/cache.bin", "file"),
    ]);
    assert.deepEqual(concurrentResults.map((result) => result.body?.data?.added).sort(), [false, true], "per-repository serialization should add one copy under concurrent requests");
    assert.equal((await readFile(path.join(gitignoreRepo, ".gitignore"), "utf8")).split("/concurrent/cache.bin").length - 1, 1, "serialized concurrent requests should leave one exact line");

    const normalizedSeparators = await addToGitignore(gitignoreTab, "nested\\windows.log", "file");
    assert.equal(normalizedSeparators.body?.data?.path, "nested/windows.log", "backslash separators should normalize to repository-style slashes");
    assert.equal(normalizedSeparators.body?.data?.entry, "/nested/windows.log");

    await writeFile(path.join(gitignoreRepo, "file.txt"), "tracked modification\n");
    const addTrackedFile = await addToGitignore(gitignoreTab, "file.txt", "file");
    assert.equal(addTrackedFile.body?.data?.added, true, "a tracked path may receive an ignore entry");
    assert.equal(runGitFixture(["ls-files", "--error-unmatch", "--", "file.txt"], gitignoreRepo, "tracked file must remain in the index"), "file.txt", "adding a tracked path to .gitignore must not untrack it");
    assert.match(addTrackedFile.body?.data?.changes?.status || "", /(^|\n) M file\.txt(?=\n|$)/, "the refreshed snapshot should keep a modified tracked file visible after adding its ignore entry");

    assert.equal(runGitFixture(["diff", "--cached", "--raw"], gitignoreRepo, "gitignore mutation must not change the index"), indexBeforeGitignore, "add-to-gitignore must not stage any files");
    assert.equal(runGitFixture(["ls-files", "--stage", "--", ".gitignore"], gitignoreRepo, "gitignore mutation must leave .gitignore untracked"), "", ".gitignore must remain unstaged and untracked");

    const lfRepo = await makeFixtureRepo("gitignore-lf");
    const lfTab = await openFixtureTab(lfRepo, "gitignore-lf-fixture");
    await writeFile(path.join(lfRepo, ".gitignore"), "# existing\n", "utf8");
    assert.equal((await addToGitignore(lfTab, "lf-output.txt", "file")).body?.data?.added, true);
    assert.equal(await readFile(path.join(lfRepo, ".gitignore"), "utf8"), "# existing\n/lf-output.txt\n", "LF files should retain LF when appending");

    const noFinalNewlineRepo = await makeFixtureRepo("gitignore-no-final-newline");
    const noFinalNewlineTab = await openFixtureTab(noFinalNewlineRepo, "gitignore-no-final-newline-fixture");
    await writeFile(path.join(noFinalNewlineRepo, ".gitignore"), "# existing", "utf8");
    await addToGitignore(noFinalNewlineTab, "separated.txt", "file");
    assert.equal(await readFile(path.join(noFinalNewlineRepo, ".gitignore"), "utf8"), "# existing\n/separated.txt\n", "append should add a separator when existing content has no final newline");

    const crlfRepo = await makeFixtureRepo("gitignore-crlf");
    const crlfTab = await openFixtureTab(crlfRepo, "gitignore-crlf-fixture");
    await writeFile(path.join(crlfRepo, ".gitignore"), Buffer.from("# existing\r\n", "utf8"));
    await addToGitignore(crlfTab, "crlf-output.txt", "file");
    assert.deepEqual(await readFile(path.join(crlfRepo, ".gitignore")), Buffer.from("# existing\r\n/crlf-output.txt\r\n", "utf8"), "CRLF files should retain CRLF when appending");

    const literalRepo = await makeFixtureRepo("gitignore-literal-pattern");
    const literalTab = await openFixtureTab(literalRepo, "gitignore-literal-pattern-fixture");
    const literalPath = "literal [x] *?.txt";
    const addLiteral = await addToGitignore(literalTab, literalPath, "file");
    assert.equal(addLiteral.body?.data?.entry, "/literal\\ \\[x\\]\\ \\*\\?.txt", "spaces and Git pattern metacharacters should be escaped literally");
    assert.equal(await readFile(path.join(literalRepo, ".gitignore"), "utf8"), "/literal\\ \\[x\\]\\ \\*\\?.txt\n");
    const intendedLiteralCheck = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", literalPath], { cwd: literalRepo });
    assert.equal(intendedLiteralCheck.status, 0, "the escaped entry should ignore the intended special-character path");
    const broaderLiteralCheck = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "literal x anything.txt"], { cwd: literalRepo });
    assert.notEqual(broaderLiteralCheck.status, 0, "the escaped entry must not broaden into wildcard or character-class matching");

    const outsideMarker = path.join(gitFixturesRoot, "outside-gitignore-marker.txt");
    await writeFile(outsideMarker, "outside unchanged\n");
    const validationBytesBefore = await readFile(path.join(gitignoreRepo, ".gitignore"));
    const rejectedGitignoreInputs = [
      { path: "", kind: "file", label: "empty path" },
      { path: ".", kind: "folder", label: "repository root" },
      { path: "/absolute.txt", kind: "file", label: "POSIX absolute path" },
      { path: "C:\\absolute.txt", kind: "file", label: "Windows absolute path" },
      { path: "../outside-gitignore-marker.txt", kind: "file", label: "traversal" },
      { path: "nested/../outside.txt", kind: "file", label: "embedded traversal" },
      { path: "bad\npath.txt", kind: "file", label: "newline control character" },
      { path: "bad\0path.txt", kind: "file", label: "NUL control character" },
      { path: "valid.txt", kind: "directory", label: "invalid kind" },
      { path: "valid.txt", kind: "", label: "empty kind" },
    ];
    for (const invalid of rejectedGitignoreInputs) {
      const rejected = await addToGitignore(gitignoreTab, invalid.path, invalid.kind);
      assert.equal(rejected.status, 400, `${invalid.label} should be rejected`);
      assert.equal(rejected.body?.ok, false, `${invalid.label} should return a structured failure`);
    }
    assert.deepEqual(await readFile(path.join(gitignoreRepo, ".gitignore")), validationBytesBefore, "validation failures must leave .gitignore byte-for-byte unchanged");
    assert.equal(await readFile(outsideMarker, "utf8"), "outside unchanged\n", "traversal attempts must not write outside the repository");

    const unsafeRepo = await makeFixtureRepo("gitignore-unsafe-target");
    const unsafeTab = await openFixtureTab(unsafeRepo, "gitignore-unsafe-target-fixture");
    const unsafeGitignore = path.join(unsafeRepo, ".gitignore");
    await mkdir(unsafeGitignore);
    const directoryTarget = await addToGitignore(unsafeTab, "blocked.txt", "file");
    assert.equal(directoryTarget.status, 409, "a non-regular root .gitignore target should fail closed");
    await rm(unsafeGitignore, { recursive: true, force: true });

    const hardlinkTarget = path.join(gitFixturesRoot, "outside-hardlink-target.txt");
    await writeFile(hardlinkTarget, "hard-link target unchanged\n");
    let hardlinkSupported = true;
    try {
      await link(hardlinkTarget, unsafeGitignore);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOSYS" || error?.code === "EXDEV") hardlinkSupported = false;
      else throw error;
    }
    if (hardlinkSupported) {
      const hardlinkResponse = await addToGitignore(unsafeTab, "blocked.txt", "file");
      assert.equal(hardlinkResponse.status, 409, "a root .gitignore hard link should fail closed");
      assert.equal(await readFile(hardlinkTarget, "utf8"), "hard-link target unchanged\n", "a rejected .gitignore hard link must not modify its outside target");
      await rm(unsafeGitignore, { force: true });
    }

    const symlinkTarget = path.join(gitFixturesRoot, "outside-symlink-target.txt");
    await writeFile(symlinkTarget, "symlink target unchanged\n");
    let symlinkSupported = true;
    try {
      await symlink(symlinkTarget, unsafeGitignore, "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOSYS") symlinkSupported = false;
      else throw error;
    }
    if (symlinkSupported) {
      const symlinkResponse = await addToGitignore(unsafeTab, "blocked.txt", "file");
      assert.equal(symlinkResponse.status, 409, "a root .gitignore symlink should fail closed");
      assert.equal(await readFile(symlinkTarget, "utf8"), "symlink target unchanged\n", "a rejected .gitignore symlink must not be followed");
      await rm(unsafeGitignore, { force: true });
    }

    await writeFile(unsafeGitignore, Buffer.alloc(5 * 1024 * 1024 + 1, 0x23));
    const oversizedResponse = await addToGitignore(unsafeTab, "blocked.txt", "file");
    assert.equal(oversizedResponse.status, 409, "an oversized root .gitignore should be rejected as an unsafe server-side file state before it is read into memory");
    assert.equal((await stat(unsafeGitignore)).size, 5 * 1024 * 1024 + 1, "oversized refusal must leave .gitignore unchanged");

    // File-scoped Git diff endpoint: staged, unstaged, untracked, empty, deleted, and rejected inputs.
    const fileDiffRepo = await makeFixtureRepo("file-diff");
    const fileDiffTab = await openFixtureTab(fileDiffRepo, "file-diff-fixture");
    await writeFile(path.join(fileDiffRepo, "unchanged.txt"), "unchanged\n");
    await writeFile(path.join(fileDiffRepo, "deleted.txt"), "deleted\n");
    runGitFixture(["add", "unchanged.txt", "deleted.txt"], fileDiffRepo, "file-diff fixture should stage unchanged and deleted bases");
    runGitFixture(["commit", "-m", "additional file-diff bases"], fileDiffRepo, "file-diff fixture should commit unchanged and deleted bases");
    await writeFile(path.join(fileDiffRepo, "file.txt"), "staged\n");
    runGitFixture(["add", "file.txt"], fileDiffRepo, "file-diff fixture should stage a file-scoped change");

    const gitFileDiffPath = (file, category) => `/api/git-file-diff?tab=${encodeURIComponent(fileDiffTab)}&path=${encodeURIComponent(file)}&category=${encodeURIComponent(category)}`;
    const stagedFileDiff = await request("127.0.0.1", gitFileDiffPath("file.txt", "staged"));
    assert.equal(stagedFileDiff.status, 200);
    assert.equal(stagedFileDiff.body?.ok, true, "git-file-diff should read a staged file diff");
    assert.equal(stagedFileDiff.body?.data?.root, fileDiffRepo);
    assert.equal(stagedFileDiff.body?.data?.path, "file.txt");
    assert.equal(stagedFileDiff.body?.data?.category, "staged");
    assert.equal(stagedFileDiff.body?.data?.label, "Staged");
    assert.match(stagedFileDiff.body?.data?.command || "", /^git diff --cached --no-ext-diff --no-textconv --no-color --unified=3 --src-prefix=a\/ --dst-prefix=b\/ -- file\.txt$/);
    assert.match(stagedFileDiff.body?.data?.diff || "", /-base\n\+staged/, "staged diff should compare the index against HEAD for only the requested path");
    assert.equal(stagedFileDiff.body?.data?.truncated, false);
    assert.ok(Number(stagedFileDiff.body?.data?.capBytes) > 0, "staged file diff should expose its output cap");

    await writeFile(path.join(fileDiffRepo, "file.txt"), "unstaged\n");
    const unstagedFileDiff = await request("127.0.0.1", gitFileDiffPath("file.txt", "unstaged"));
    assert.equal(unstagedFileDiff.status, 200);
    assert.equal(unstagedFileDiff.body?.ok, true, "git-file-diff should read an unstaged file diff");
    assert.equal(unstagedFileDiff.body?.data?.category, "unstaged");
    assert.equal(unstagedFileDiff.body?.data?.label, "Unstaged");
    assert.match(unstagedFileDiff.body?.data?.command || "", /^git diff --no-ext-diff --no-textconv --no-color --unified=3 --src-prefix=a\/ --dst-prefix=b\/ -- file\.txt$/);
    assert.match(unstagedFileDiff.body?.data?.diff || "", /-staged\n\+unstaged/, "unstaged diff should compare the worktree against the index for only the requested path");

    await writeFile(path.join(fileDiffRepo, "loose.txt"), "loose\n");
    const untrackedFileDiff = await request("127.0.0.1", gitFileDiffPath("loose.txt", "untracked"));
    assert.equal(untrackedFileDiff.status, 200);
    assert.equal(untrackedFileDiff.body?.ok, true, "git-file-diff should return verified untracked content");
    assert.equal(untrackedFileDiff.body?.data?.category, "untracked");
    assert.equal(untrackedFileDiff.body?.data?.label, "Untracked");
    assert.equal(untrackedFileDiff.body?.data?.command, "git ls-files --others --exclude-standard -- loose.txt");
    assert.equal(untrackedFileDiff.body?.data?.diff, "");
    assert.equal(untrackedFileDiff.body?.data?.path, "loose.txt");
    assert.equal(untrackedFileDiff.body?.data?.binary, false);
    assert.equal(untrackedFileDiff.body?.data?.size, 6);
    assert.equal(untrackedFileDiff.body?.data?.content, "loose\n");
    assert.equal(untrackedFileDiff.body?.data?.truncated, false);
    assert.ok(Number(untrackedFileDiff.body?.data?.capBytes) > 0, "untracked file response should expose its output cap");

    const fileDiffCap = Number(untrackedFileDiff.body?.data?.capBytes) || 500_000;
    await writeFile(path.join(fileDiffRepo, "large-loose.txt"), "x".repeat(fileDiffCap + 1));
    const largeUntrackedFileDiff = await request("127.0.0.1", gitFileDiffPath("large-loose.txt", "untracked"));
    assert.equal(largeUntrackedFileDiff.status, 200);
    assert.equal(largeUntrackedFileDiff.body?.ok, true, "oversized untracked previews should remain a structured response");
    assert.equal(largeUntrackedFileDiff.body?.data?.size, fileDiffCap + 1);
    assert.equal(largeUntrackedFileDiff.body?.data?.content, "", "oversized untracked previews must not read file content into the response");
    assert.match(largeUntrackedFileDiff.body?.data?.error || "", /too large to preview/i, "oversized untracked previews should explain the output bound");

    const emptyFileDiff = await request("127.0.0.1", gitFileDiffPath("unchanged.txt", "unstaged"));
    assert.equal(emptyFileDiff.status, 200);
    assert.equal(emptyFileDiff.body?.ok, true, "git-file-diff should return an empty diff for an unchanged file");
    assert.equal(emptyFileDiff.body?.data?.diff, "");

    await rm(path.join(fileDiffRepo, "deleted.txt"));
    const deletedFileDiff = await request("127.0.0.1", gitFileDiffPath("deleted.txt", "unstaged"));
    assert.equal(deletedFileDiff.status, 200);
    assert.equal(deletedFileDiff.body?.ok, true, "git-file-diff should return a diff for a deleted tracked file");
    assert.match(deletedFileDiff.body?.data?.diff || "", /deleted file mode/, "deleted tracked files should retain a readable diff");

    const invalidGitFileDiffCategory = await request("127.0.0.1", gitFileDiffPath("file.txt", "modified"));
    assert.equal(invalidGitFileDiffCategory.status, 200);
    assert.equal(invalidGitFileDiffCategory.body?.ok, false, "git-file-diff must allowlist categories");
    assert.match(String(invalidGitFileDiffCategory.body?.error || ""), /category must be staged, unstaged, conflicted, or untracked/i);
    const escapedGitFileDiff = await request("127.0.0.1", gitFileDiffPath("../outside.txt", "unstaged"));
    assert.equal(escapedGitFileDiff.status, 200);
    assert.equal(escapedGitFileDiff.body?.ok, false, "git-file-diff must reject paths escaping the repository root");
    assert.match(String(escapedGitFileDiff.body?.error || ""), /Git path escapes repository/i);

    // Staging endpoints
    const stagingRepo = await makeFixtureRepo("staging");
    const stagingTab = await openFixtureTab(stagingRepo, "staging-fixture");
    await writeFile(path.join(stagingRepo, "file.txt"), "modified\n");
    await writeFile(path.join(stagingRepo, "loose.txt"), "loose\n");

    const gitRoot = await request("127.0.0.1", `/api/git-root?tab=${encodeURIComponent(stagingTab)}`);
    assert.equal(gitRoot.body?.ok, true, "git-root endpoint should discover the tab repository");
    assert.equal(gitRoot.body?.data?.root, stagingRepo, "git-root should return the canonical fixture root");

    const liveFile = path.join(stagingRepo, "live-update.txt");
    const renamedLiveFile = path.join(stagingRepo, "live-update-renamed.txt");
    const isLiveGitEvent = (event) => event.type === "webui_git_changed" && event.root === stagingRepo;
    const createdLiveEvent = await waitForSseEvent(stagingTab, isLiveGitEvent, () => writeFile(liveFile, "created\n"));
    assert.match(createdLiveEvent.event.changedAt || "", /^\d{4}-\d{2}-\d{2}T/, "file creation should broadcast a timestamped Git invalidation");
    await waitForSseEvent(stagingTab, isLiveGitEvent, () => writeFile(liveFile, "modified\n"));
    await waitForSseEvent(stagingTab, isLiveGitEvent, () => rename(liveFile, renamedLiveFile));
    await waitForSseEvent(stagingTab, isLiveGitEvent, () => rm(renamedLiveFile));

    const gitPanel = await request("127.0.0.1", `/api/git-panel?tab=${encodeURIComponent(stagingTab)}`);
    assert.equal(gitPanel.body?.ok, true, "git-panel endpoint should return compact local status and history");
    assert.equal(gitPanel.body?.data?.root, stagingRepo);
    assert.equal(gitPanel.body?.data?.history?.length, 1, "git-panel should include the bounded recent commit history");
    assert.equal(gitPanel.body?.data?.history?.[0]?.subject, "base");
    const modifiedPanelEntry = gitPanel.body?.data?.changes?.find((entry) => entry.path === "file.txt");
    assert.equal(modifiedPanelEntry?.unstaged, true, "git-panel should classify modified tracked files");
    assert.equal(modifiedPanelEntry?.additions, 1, "git-panel should report unstaged additions from numstat");
    assert.equal(modifiedPanelEntry?.deletions, 1, "git-panel should report unstaged deletions from numstat");
    assert.equal(gitPanel.body?.data?.changes?.find((entry) => entry.path === "loose.txt")?.untracked, true, "git-panel should classify untracked files");
    assert.equal(Object.prototype.hasOwnProperty.call(gitPanel.body?.data?.changes?.[0] || {}, "content"), false, "compact git-panel entries must not include file contents");

    const fixtureHead = runGitFixture(["rev-parse", "HEAD"], stagingRepo, "staging fixture should expose its full HEAD hash");
    const gitPanelCommit = await request("127.0.0.1", `/api/git-commit?tab=${encodeURIComponent(stagingTab)}&hash=${encodeURIComponent(fixtureHead)}`);
    assert.equal(gitPanelCommit.body?.ok, true, "git-commit endpoint should return a bounded read-only commit diff");
    assert.equal(gitPanelCommit.body?.data?.commit?.hash, fixtureHead);
    assert.match(gitPanelCommit.body?.data?.sections?.[0]?.diff || "", /diff --git a\/file\.txt b\/file\.txt/, "git-commit should include the selected commit patch");
    const invalidCommit = await request("127.0.0.1", `/api/git-commit?tab=${encodeURIComponent(stagingTab)}&hash=HEAD`);
    assert.equal(invalidCommit.status, 400, "git-commit should reject symbolic or abbreviated revisions");

    const stageAll = await request("127.0.0.1", "/api/git-changes/stage-all", { method: "POST", body: { tab: stagingTab } });
    assert.equal(stageAll.body?.ok, true, "stage-all endpoint should stage the selected repository");
    const stagedPanel = await request("127.0.0.1", `/api/git-panel?tab=${encodeURIComponent(stagingTab)}`);
    assert.equal(stagedPanel.body?.data?.summary?.staged, 2, "stage-all should stage tracked and untracked changes");
    const unstageAll = await request("127.0.0.1", "/api/git-changes/unstage-all", { method: "POST", body: { tab: stagingTab } });
    assert.equal(unstageAll.body?.ok, true, "unstage-all endpoint should clear the selected repository index");
    const unstagedPanel = await request("127.0.0.1", `/api/git-panel?tab=${encodeURIComponent(stagingTab)}`);
    assert.equal(unstagedPanel.body?.data?.summary?.staged, 0, "unstage-all should leave no staged changes");
    assert.equal(unstagedPanel.body?.data?.changes?.find((entry) => entry.path === "loose.txt")?.untracked, true, "unstage-all should restore newly added files to untracked state");

    const stageFile = await request("127.0.0.1", "/api/git-changes/stage-file", { method: "POST", body: { tab: stagingTab, path: "file.txt" } });
    assert.equal(stageFile.status, 200);
    assert.equal(stageFile.body?.ok, true, "stage-file endpoint should stage a modified file");
    assert.equal(stageFile.body?.data?.changes?.summary?.staged, 1, "stage-file should report one staged file afterwards");

    await writeFile(path.join(stagingRepo, "file.txt"), "modified again\n");
    const mixedPanel = await request("127.0.0.1", `/api/git-panel?tab=${encodeURIComponent(stagingTab)}`);
    const mixedEntry = mixedPanel.body?.data?.changes?.find((entry) => entry.path === "file.txt");
    assert.equal(mixedEntry?.staged, true, "mixed index/worktree files should remain staged");
    assert.equal(mixedEntry?.unstaged, true, "mixed index/worktree files should also remain unstaged");
    assert.equal(mixedEntry?.stagedAdditions, 1, "Git panel should preserve staged additions separately");
    assert.equal(mixedEntry?.stagedDeletions, 1, "Git panel should preserve staged deletions separately");
    assert.equal(mixedEntry?.unstagedAdditions, 1, "Git panel should preserve unstaged additions separately");
    assert.equal(mixedEntry?.unstagedDeletions, 1, "Git panel should preserve unstaged deletions separately");

    const unstageFile = await request("127.0.0.1", "/api/git-changes/unstage-file", { method: "POST", body: { tab: stagingTab, path: "file.txt" } });
    assert.equal(unstageFile.status, 200);
    assert.equal(unstageFile.body?.ok, true, "unstage-file endpoint should unstage the file");
    assert.equal(unstageFile.body?.data?.changes?.summary?.staged, 0, "unstage-file should report zero staged files afterwards");

    const discardUnconfirmed = await request("127.0.0.1", "/api/git-changes/discard-file", { method: "POST", body: { tab: stagingTab, path: "file.txt" } });
    assert.equal(discardUnconfirmed.status, 409, "discard-file without confirmed: true should be refused");
    const discardConfirmed = await request("127.0.0.1", "/api/git-changes/discard-file", { method: "POST", body: { tab: stagingTab, path: "file.txt", confirmed: true } });
    assert.equal(discardConfirmed.status, 200);
    assert.equal(discardConfirmed.body?.ok, true, "confirmed discard-file should restore the file");
    assert.equal(await readFile(path.join(stagingRepo, "file.txt"), "utf8"), "base\n", "discard-file should restore committed content");

    const escapeStage = await request("127.0.0.1", "/api/git-changes/stage-file", { method: "POST", body: { tab: stagingTab, path: "../outside.txt" } });
    assert.equal(escapeStage.body?.ok, false, "stage-file must reject paths escaping the repository root");

    const deleteTracked = await request("127.0.0.1", "/api/git-changes/delete-untracked", { method: "POST", body: { tab: stagingTab, path: "file.txt", confirmed: true } });
    assert.equal(deleteTracked.status, 409, "delete-untracked must refuse tracked files");
    const deleteUnconfirmed = await request("127.0.0.1", "/api/git-changes/delete-untracked", { method: "POST", body: { tab: stagingTab, path: "loose.txt" } });
    assert.equal(deleteUnconfirmed.status, 409, "delete-untracked without confirmed: true should be refused");
    const deleteConfirmed = await request("127.0.0.1", "/api/git-changes/delete-untracked", { method: "POST", body: { tab: stagingTab, path: "loose.txt", confirmed: true } });
    assert.equal(deleteConfirmed.status, 200);
    assert.equal(deleteConfirmed.body?.ok, true, "confirmed delete-untracked should delete the file");
    assert.equal(await readFile(path.join(stagingRepo, "loose.txt"), "utf8").then(() => true, () => false), false, "delete-untracked should remove the file from disk");

    // Diff truncation transparency: a diff larger than the 500KB cap must be flagged.
    const truncationRepo = await makeFixtureRepo("diff-truncation");
    const truncationTab = await openFixtureTab(truncationRepo, "diff-truncation-fixture");
    const bigLines = Array.from({ length: 24_000 }, (_, index) => `line ${index} ${"x".repeat(24)}`).join("\n");
    await writeFile(path.join(truncationRepo, "big.txt"), `${bigLines}\n`);
    runGitFixture(["add", "big.txt"], truncationRepo, "truncation fixture should stage the big file");
    runGitFixture(["commit", "-m", "big base"], truncationRepo, "truncation fixture should commit the big file");
    const flipped = Array.from({ length: 24_000 }, (_, index) => `LINE ${index} ${"y".repeat(24)}`).join("\n");
    await writeFile(path.join(truncationRepo, "big.txt"), `${flipped}\n`);
    const truncatedChanges = await request("127.0.0.1", `/api/git-changes?tab=${encodeURIComponent(truncationTab)}`, { timeoutMs: 20_000 });
    assert.equal(truncatedChanges.body?.ok, true, "git changes should load the oversized diff repo");
    const unstagedSection = (truncatedChanges.body?.data?.sections || []).find((section) => section.key === "unstaged");
    assert.ok(unstagedSection, "unstaged section should exist for the oversized diff");
    assert.equal(unstagedSection.truncated, true, "oversized diffs must carry a structured truncated flag");
    assert.ok(Number(unstagedSection.capBytes) > 0, "truncated sections must report the cap size");
    const stagedSection = (truncatedChanges.body?.data?.sections || []).find((section) => section.key === "staged");
    assert.equal(stagedSection?.truncated, false, "small diffs must not be flagged as truncated");

    // Merge conflict lifecycle
    const makeConflictRepo = async (name) => {
      const dir = await makeFixtureRepo(name);
      runGitFixture(["checkout", "-b", "side"], dir, `${name} fixture should branch`);
      await writeFile(path.join(dir, "file.txt"), "side\n");
      runGitFixture(["commit", "-am", "side"], dir, `${name} fixture should commit side`);
      runGitFixture(["checkout", "main"], dir, `${name} fixture should return to main`);
      await writeFile(path.join(dir, "file.txt"), "main\n");
      runGitFixture(["commit", "-am", "main"], dir, `${name} fixture should commit main`);
      const merge = spawnSync("git", ["merge", "side"], { cwd: dir, encoding: "utf8" });
      assert.notEqual(merge.status, 0, `${name} fixture merge should conflict`);
      return dir;
    };

    const mergeRepo = await makeConflictRepo("merge-conflict");
    const mergeTab = await openFixtureTab(mergeRepo, "merge-conflict-fixture");
    const conflictedFileDiff = await request("127.0.0.1", `/api/git-file-diff?tab=${encodeURIComponent(mergeTab)}&path=file.txt&category=conflicted`);
    assert.equal(conflictedFileDiff.status, 200);
    assert.equal(conflictedFileDiff.body?.ok, true, "git-file-diff should return a combined diff for an unmerged path");
    assert.equal(conflictedFileDiff.body?.data?.category, "conflicted");
    assert.match(conflictedFileDiff.body?.data?.command || "", /^git diff --cc --no-ext-diff --no-textconv --no-color --unified=3 /, "conflicted file diff should use the bounded combined-diff command");
    assert.match(conflictedFileDiff.body?.data?.diff || "", /diff --cc file\.txt[\s\S]*@@@ /, "conflicted file diff should include combined hunk syntax for the raw viewer fallback");
    const operationSnapshot = await request("127.0.0.1", `/api/git-operation?tab=${encodeURIComponent(mergeTab)}`);
    assert.equal(operationSnapshot.status, 200);
    assert.equal(operationSnapshot.body?.ok, true, "operation endpoint should read a merging repo");
    assert.equal(operationSnapshot.body?.data?.operation, "merge");
    assert.equal(operationSnapshot.body?.data?.canContinue, false, "merge with conflicts must not be continuable");
    assert.equal(operationSnapshot.body?.data?.conflicts?.[0]?.path, "file.txt");
    assert.equal(operationSnapshot.body?.data?.conflicts?.[0]?.status, "UU");
    assert.equal(operationSnapshot.body?.data?.conflicts?.[0]?.preview?.hasMarkers, true, "conflict preview should detect conflict markers");

    const conflictAgent = await request("127.0.0.1", "/api/git-operation/resolve-with-agent", { method: "POST", body: { tab: mergeTab }, timeoutMs: 20_000 });
    const conflictAgentTabId = conflictAgent.body?.data?.tab?.id;
    assert.equal(conflictAgent.status, 200);
    assert.equal(conflictAgent.body?.ok, true, `conflict handoff should open an agent tab: ${conflictAgent.body?.error || ""}`);
    assert.ok(conflictAgentTabId, "conflict handoff should create a separate tab");
    assert.notEqual(conflictAgentTabId, mergeTab, "conflict handoff should create a separate tab");
    assert.equal(conflictAgent.body?.data?.tab?.cwd, mergeRepo, "conflict agent should use the conflicted repository root");
    assert.equal(conflictAgent.body?.data?.tab?.title, "Resolve merge conflicts");
    assert.deepEqual(conflictAgent.body?.data?.operation?.conflicts, [{ path: "file.txt", status: "UU" }]);
    const loggedCommands = (await readFile(fakePiCommandLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const handoffPrompt = loggedCommands.findLast((entry) => entry.direction === "command" && entry.type === "prompt" && /Resolve the current Git merge conflicts/.test(entry.message || ""));
    assert.ok(handoffPrompt, "conflict agent should receive a resolution prompt");
    assert.match(handoffPrompt.message, /Conflicted files:\n- UU "file\.txt"/, "handoff prompt should identify each conflicted path and status");
    assert.match(handoffPrompt.message, /Do not continue, skip, abort, commit, reset, or push the merge/, "handoff prompt should keep operation completion under user control");
    assert.match(handoffPrompt.message, /git diff --name-only --diff-filter=U is empty/, "handoff prompt should require unmerged-path verification");

    const continueBlocked = await request("127.0.0.1", "/api/git-operation/continue", { method: "POST", body: { tab: mergeTab } });
    assert.equal(continueBlocked.status, 200);
    assert.equal(continueBlocked.body?.ok, false, "continue with unmerged paths must fail");
    assert.equal(continueBlocked.body?.code, "UNMERGED_PATHS");

    await writeFile(path.join(mergeRepo, "file.txt"), "resolved\n");
    const markResolved = await request("127.0.0.1", "/api/git-operation/stage-file", { method: "POST", body: { tab: mergeTab, path: "file.txt" } });
    assert.equal(markResolved.status, 200);
    assert.equal(markResolved.body?.ok, true, "operation stage-file should mark the conflict as resolved");
    assert.equal(markResolved.body?.data?.operation?.canContinue, true, "after staging the only conflict, continue should be possible");

    const continueMerge = await request("127.0.0.1", "/api/git-operation/continue", { method: "POST", body: { tab: mergeTab }, timeoutMs: 20_000 });
    assert.equal(continueMerge.status, 200);
    assert.equal(continueMerge.body?.ok, true, `continue should commit the resolved merge: ${continueMerge.body?.error || ""}`);
    assert.equal(continueMerge.body?.data?.operation?.operation, null, "after continuing, no operation should remain");

    const abortRepo = await makeConflictRepo("merge-abort");
    const abortTab = await openFixtureTab(abortRepo, "merge-abort-fixture");
    const abortUnconfirmed = await request("127.0.0.1", "/api/git-operation/abort", { method: "POST", body: { tab: abortTab } });
    assert.equal(abortUnconfirmed.status, 409, "abort without confirmed: true should be refused");
    const abortConfirmed = await request("127.0.0.1", "/api/git-operation/abort", { method: "POST", body: { tab: abortTab, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(abortConfirmed.status, 200);
    assert.equal(abortConfirmed.body?.ok, true, "confirmed abort should stop the merge");
    assert.equal(abortConfirmed.body?.data?.operation?.operation, null, "after aborting, no operation should remain");
    assert.equal(await readFile(path.join(abortRepo, "file.txt"), "utf8"), "main\n", "abort should restore the pre-merge content");

    // Rebase lifecycle: skip support + abort
    const rebaseRepo = await makeFixtureRepo("rebase-conflict");
    runGitFixture(["checkout", "-b", "side"], rebaseRepo, "rebase fixture should branch");
    await writeFile(path.join(rebaseRepo, "file.txt"), "side\n");
    runGitFixture(["commit", "-am", "side"], rebaseRepo, "rebase fixture should commit side");
    runGitFixture(["checkout", "main"], rebaseRepo, "rebase fixture should return to main");
    await writeFile(path.join(rebaseRepo, "file.txt"), "main\n");
    runGitFixture(["commit", "-am", "main"], rebaseRepo, "rebase fixture should commit main");
    runGitFixture(["checkout", "side"], rebaseRepo, "rebase fixture should return to side");
    const rebaseStart = spawnSync("git", ["rebase", "main"], { cwd: rebaseRepo, encoding: "utf8" });
    assert.notEqual(rebaseStart.status, 0, "rebase fixture should conflict");
    const rebaseTab = await openFixtureTab(rebaseRepo, "rebase-conflict-fixture");
    const rebaseSnapshot = await request("127.0.0.1", `/api/git-operation?tab=${encodeURIComponent(rebaseTab)}`);
    assert.equal(rebaseSnapshot.body?.data?.operation, "rebase");
    assert.equal(rebaseSnapshot.body?.data?.canSkip, true, "rebase should support skip");
    const rebaseAbort = await request("127.0.0.1", "/api/git-operation/abort", { method: "POST", body: { tab: rebaseTab, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(rebaseAbort.body?.ok, true, "confirmed rebase abort should succeed");

    // Bisect lifecycle
    const bisectRepo = await makeFixtureRepo("bisect");
    runGitFixture(["bisect", "start"], bisectRepo, "bisect fixture should start");
    const bisectTab = await openFixtureTab(bisectRepo, "bisect-fixture");
    const bisectSnapshot = await request("127.0.0.1", `/api/git-operation?tab=${encodeURIComponent(bisectTab)}`);
    assert.equal(bisectSnapshot.body?.data?.operation, "bisect");
    const bisectInvalid = await request("127.0.0.1", "/api/git-operation/bisect", { method: "POST", body: { tab: bisectTab, verdict: "evil" } });
    assert.equal(bisectInvalid.status, 400, "invalid bisect verdicts must be rejected");
    const bisectResetUnconfirmed = await request("127.0.0.1", "/api/git-operation/bisect", { method: "POST", body: { tab: bisectTab, verdict: "reset" } });
    assert.equal(bisectResetUnconfirmed.status, 409, "bisect reset without confirmed: true should be refused");
    const bisectReset = await request("127.0.0.1", "/api/git-operation/bisect", { method: "POST", body: { tab: bisectTab, verdict: "reset", confirmed: true }, timeoutMs: 20_000 });
    assert.equal(bisectReset.body?.ok, true, "confirmed bisect reset should succeed");
    assert.equal(bisectReset.body?.data?.operation?.operation, null, "after reset, no bisect should remain");

    // Stash lifecycle
    const stashRepo = await makeFixtureRepo("stash");
    const stashTab = await openFixtureTab(stashRepo, "stash-fixture");
    await writeFile(path.join(stashRepo, "file.txt"), "stash me\n");
    await writeFile(path.join(stashRepo, "new-file.txt"), "untracked\n");
    const stashSave = await request("127.0.0.1", "/api/git-stash/save", { method: "POST", body: { tab: stashTab, includeUntracked: true, message: "harness stash" } });
    assert.equal(stashSave.status, 200);
    assert.equal(stashSave.body?.ok, true, `stash save should succeed: ${stashSave.body?.error || ""}`);
    assert.equal(stashSave.body?.data?.stashes?.length, 1, "stash save should leave one stash entry");

    const stashList = await request("127.0.0.1", `/api/git-stash?tab=${encodeURIComponent(stashTab)}`);
    assert.equal(stashList.body?.ok, true);
    assert.equal(stashList.body?.data?.stashes?.[0]?.ref, "stash@{0}");
    assert.match(stashList.body?.data?.stashes?.[0]?.subject || "", /harness stash/);

    const stashShow = await request("127.0.0.1", `/api/git-stash/show?ref=${encodeURIComponent("stash@{0}")}&tab=${encodeURIComponent(stashTab)}`);
    assert.equal(stashShow.body?.ok, true, "stash show should return a preview");
    assert.match(stashShow.body?.data?.stat || "", /file\.txt/, "stash preview should mention the stashed file");

    const stashBadRef = await request("127.0.0.1", `/api/git-stash/show?ref=${encodeURIComponent("stash@{0}; rm -rf /")}&tab=${encodeURIComponent(stashTab)}`);
    assert.equal(stashBadRef.status, 400, "malformed stash refs must be rejected");

    const stashApply = await request("127.0.0.1", "/api/git-stash/apply", { method: "POST", body: { tab: stashTab, ref: "stash@{0}" } });
    assert.equal(stashApply.body?.ok, true, `stash apply should succeed: ${stashApply.body?.error || ""}`);
    assert.equal(await readFile(path.join(stashRepo, "file.txt"), "utf8"), "stash me\n", "stash apply should restore the stashed content");

    const stashDropUnconfirmed = await request("127.0.0.1", "/api/git-stash/drop", { method: "POST", body: { tab: stashTab, ref: "stash@{0}" } });
    assert.equal(stashDropUnconfirmed.status, 409, "stash drop without confirmed: true should be refused");
    const stashDrop = await request("127.0.0.1", "/api/git-stash/drop", { method: "POST", body: { tab: stashTab, ref: "stash@{0}", confirmed: true } });
    assert.equal(stashDrop.body?.ok, true, "confirmed stash drop should succeed");
    assert.equal(stashDrop.body?.data?.stashes?.length, 0, "dropping the only stash should empty the list");

    // Both footer Sync and Guided Git use this push endpoint. Even when a
    // feature branch mistakenly tracks origin/main, push its current HEAD to
    // the same-named remote branch without changing remote main.
    const mismatchedPushBranch = "feature/current-branch-push";
    const remoteMainBeforeCurrentBranchPush = runGitFixture(["rev-parse", "refs/heads/main"], remoteBare, "current-branch push fixture should record remote main");
    runGitFixture(["switch", "-c", mismatchedPushBranch], localRepo, "current-branch push fixture should create its feature branch");
    runGitFixture(["config", `branch.${mismatchedPushBranch}.remote`, "origin"], localRepo, "current-branch push fixture should configure the upstream remote");
    runGitFixture(["config", `branch.${mismatchedPushBranch}.merge`, "refs/heads/main"], localRepo, "current-branch push fixture should reproduce the mismatched upstream branch");
    await writeFile(path.join(localRepo, "current-branch-push.txt"), "feature branch only\n");
    runGitFixture(["add", "current-branch-push.txt"], localRepo, "current-branch push fixture should stage its marker");
    runGitFixture(["commit", "-m", "current branch push fixture"], localRepo, "current-branch push fixture should commit its marker");
    const currentBranchHead = runGitFixture(["rev-parse", "HEAD"], localRepo, "current-branch push fixture should record feature HEAD");

    const pushCurrentBranch = await request("127.0.0.1", "/api/git-workflow/push", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 30_000 });
    assert.equal(pushCurrentBranch.body?.ok, true, `push should target the checked-out branch despite a mismatched upstream: ${pushCurrentBranch.body?.error || ""}`);
    assert.equal(pushCurrentBranch.body?.data?.branch, mismatchedPushBranch);
    assert.equal(pushCurrentBranch.body?.data?.remote, "origin");
    assert.equal(runGitFixture(["rev-parse", `refs/heads/${mismatchedPushBranch}`], remoteBare, "current-branch push fixture should create the same-named remote branch"), currentBranchHead);
    assert.equal(runGitFixture(["rev-parse", "refs/heads/main"], remoteBare, "current-branch push fixture should leave remote main unchanged"), remoteMainBeforeCurrentBranchPush);
    assert.equal(
      runGitFixture(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], localRepo, "current-branch push fixture should read the repaired upstream"),
      `origin/${mismatchedPushBranch}`,
      "push should replace origin/main tracking with the same-named remote feature branch",
    );
    const currentBranchStatus = runGitFixture(["status", "--porcelain=v2", "--branch"], localRepo, "current-branch push fixture should read synchronized status");
    assert.match(currentBranchStatus, new RegExp(`^# branch\\.upstream origin/${mismatchedPushBranch}$`, "m"));
    assert.match(currentBranchStatus, /^# branch\.ab \+0 -0$/m, "the repaired upstream should leave no phantom outgoing Sync count");
    runGitFixture(["switch", "main"], localRepo, "current-branch push fixture should restore main");

    // Fetch, divergence classification, integrate, push classification
    await writeFile(path.join(remoteWork, "incoming.txt"), "base\nremote one\nremote two\nremote three\n");
    runGitFixture(["commit", "-am", "remote three"], remoteWork, "remote worktree should commit third incoming change");
    runGitFixture(["push", "origin", "main"], remoteWork, "remote worktree should push the third commit");
    await writeFile(path.join(localRepo, "local-only.txt"), "local\n");
    runGitFixture(["add", "local-only.txt"], localRepo, "local repo should stage local divergence");
    runGitFixture(["commit", "-m", "local divergence"], localRepo, "local repo should commit local divergence");

    const fetchResult = await request("127.0.0.1", "/api/git-fetch", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 30_000 });
    assert.equal(fetchResult.status, 200);
    assert.equal(fetchResult.body?.ok, true, `fetch endpoint should fetch from the bare origin: ${fetchResult.body?.error || ""}`);
    assert.equal(fetchResult.body?.data?.changes?.summary?.behind, 1, "fetch should reveal the remote commit");
    assert.equal(fetchResult.body?.data?.changes?.remote?.diverged, true, "fetch should reveal divergence");
    assert.equal(fetchResult.body?.data?.changes?.remote?.canPull, false, "diverged branches must not offer one-click pull");

    const divergedPull = await request("127.0.0.1", "/api/git-changes/pull", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 30_000 });
    assert.equal(divergedPull.body?.ok, false, "ff-only pull must fail on diverged branches");
    assert.equal(divergedPull.body?.code, "DIVERGED", "diverged pull failures should be classified");
    assert.ok(divergedPull.body?.hint, "diverged pull failures should carry a hint");

    const integrateUnconfirmed = await request("127.0.0.1", "/api/git-changes/integrate", { method: "POST", body: { tab: remoteTabId, mode: "merge" } });
    assert.equal(integrateUnconfirmed.status, 409, "integrate without confirmed: true should be refused");
    const integrateMerge = await request("127.0.0.1", "/api/git-changes/integrate", { method: "POST", body: { tab: remoteTabId, mode: "merge", confirmed: true }, timeoutMs: 30_000 });
    assert.equal(integrateMerge.body?.ok, true, `confirmed merge integrate should succeed: ${integrateMerge.body?.error || ""}`);
    assert.equal(integrateMerge.body?.data?.changes?.summary?.behind, 0, "after integrating, nothing should remain behind");

    const pushDiverged = await request("127.0.0.1", "/api/git-workflow/push", { method: "POST", body: { tab: remoteTabId }, timeoutMs: 30_000 });
    assert.equal(pushDiverged.body?.ok, true, `push should succeed after integration: ${pushDiverged.body?.error || ""}`);
    assert.equal(pushDiverged.body?.data?.branch, "main");
    assert.equal(pushDiverged.body?.data?.protectedBranch, true, "pushing main should be flagged as a protected branch");

    // Undo guards: pushed commits must not be undoable
    const undoPushedState = await request("127.0.0.1", `/api/git-undo?tab=${encodeURIComponent(remoteTabId)}`);
    assert.equal(undoPushedState.body?.ok, true);
    assert.equal(undoPushedState.body?.data?.canUndoLastCommit, false, "a pushed HEAD must not be undoable");
    const undoPushed = await request("127.0.0.1", "/api/git-undo/last-commit", { method: "POST", body: { tab: remoteTabId, confirmed: true } });
    assert.equal(undoPushed.status, 409, "undoing a pushed commit must be refused");

    // Undo/amend on an unpushed repo
    const undoRepo = await makeFixtureRepo("undo");
    const undoTab = await openFixtureTab(undoRepo, "undo-fixture");
    await writeFile(path.join(undoRepo, "file.txt"), "second\n");
    runGitFixture(["commit", "-am", "second"], undoRepo, "undo fixture should commit a second change");

    const undoState = await request("127.0.0.1", `/api/git-undo?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(undoState.body?.ok, true);
    assert.equal(undoState.body?.data?.canUndoLastCommit, true, "an unpushed commit with a parent should be undoable");
    assert.equal(undoState.body?.data?.lastCommit?.subject, "second");

    const undoUnconfirmed = await request("127.0.0.1", "/api/git-undo/last-commit", { method: "POST", body: { tab: undoTab } });
    assert.equal(undoUnconfirmed.status, 409, "undo without confirmed: true should be refused");
    const undoConfirmed = await request("127.0.0.1", "/api/git-undo/last-commit", { method: "POST", body: { tab: undoTab, confirmed: true } });
    assert.equal(undoConfirmed.body?.ok, true, `confirmed undo should soft-reset: ${undoConfirmed.body?.error || ""}`);
    assert.equal(undoConfirmed.body?.data?.restoreCommand, "git reset --soft ORIG_HEAD");
    assert.equal(undoConfirmed.body?.data?.changes?.summary?.staged, 1, "soft reset should keep the change staged");
    assert.equal(runGitFixture(["log", "-1", "--format=%s"], undoRepo, "undo fixture should read HEAD subject"), "base", "undo should move HEAD back to the base commit");

    const undoNoParent = await request("127.0.0.1", "/api/git-undo/last-commit", { method: "POST", body: { tab: undoTab, confirmed: true } });
    assert.equal(undoNoParent.status, 409, "undoing the root commit must be refused");

    const amendWithStaged = await request("127.0.0.1", "/api/git-undo/amend-message", { method: "POST", body: { tab: undoTab, confirmed: true, message: "nope" } });
    assert.equal(amendWithStaged.status, 409, "amending with staged changes must be refused");
    runGitFixture(["commit", "-m", "second again"], undoRepo, "undo fixture should re-commit the staged change");
    const amendUnconfirmed = await request("127.0.0.1", "/api/git-undo/amend-message", { method: "POST", body: { tab: undoTab, message: "amended subject" } });
    assert.equal(amendUnconfirmed.status, 409, "amend without confirmed: true should be refused");
    const amendConfirmed = await request("127.0.0.1", "/api/git-undo/amend-message", { method: "POST", body: { tab: undoTab, confirmed: true, message: "amended subject" } });
    assert.equal(amendConfirmed.body?.ok, true, `confirmed amend should rewrite the message: ${amendConfirmed.body?.error || ""}`);
    assert.equal(runGitFixture(["log", "-1", "--format=%s"], undoRepo, "undo fixture should read amended subject"), "amended subject");

    const reflog = await request("127.0.0.1", `/api/git-reflog?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(reflog.body?.ok, true, "reflog endpoint should return entries");
    assert.ok((reflog.body?.data?.entries || []).length >= 3, "reflog should include the undo/amend history");
    assert.match(reflog.body?.data?.entries?.[0]?.selector || "", /^HEAD@\{0\}$/);

    // Tags
    const tagInvalid = await request("127.0.0.1", "/api/git-tags/create", { method: "POST", body: { tab: undoTab, confirmed: true, name: "bad tag" } });
    assert.equal(tagInvalid.status, 400, "invalid tag names must be rejected");
    const tagUnconfirmed = await request("127.0.0.1", "/api/git-tags/create", { method: "POST", body: { tab: undoTab, name: "v0.0.1-harness", message: "harness tag" } });
    assert.equal(tagUnconfirmed.status, 409, "tag creation without confirmed: true should be refused");
    const tagCreate = await request("127.0.0.1", "/api/git-tags/create", { method: "POST", body: { tab: undoTab, confirmed: true, name: "v0.0.1-harness", message: "harness tag" } });
    assert.equal(tagCreate.body?.ok, true, `confirmed tag creation should succeed: ${tagCreate.body?.error || ""}`);
    const tagList = await request("127.0.0.1", `/api/git-tags?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(tagList.body?.ok, true);
    const createdTag = (tagList.body?.data?.tags || []).find((tag) => tag.name === "v0.0.1-harness");
    assert.ok(createdTag, "created tag should appear in the tag list");
    assert.equal(createdTag.annotated, true, "created tag should be annotated");
    assert.equal(createdTag.atHead, true, "created tag should point at HEAD");

    // Signing diagnostics + submodule status (read-only)
    const signing = await request("127.0.0.1", `/api/git-signing?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(signing.body?.ok, true, "signing diagnostics should load");
    assert.equal(signing.body?.data?.mismatch, false, "fixture repo should not report a signing mismatch");
    const submodules = await request("127.0.0.1", `/api/git-submodules?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(submodules.body?.ok, true, "submodule status should load");
    assert.equal(submodules.body?.data?.hasSubmodules, false, "fixture repo has no submodules");

    // Worktree prune (dry run + confirmed)
    const pruneDryRun = await request("127.0.0.1", `/api/git-worktrees/prune?tab=${encodeURIComponent(undoTab)}`);
    assert.equal(pruneDryRun.body?.ok, true, "prune dry run should load");
    assert.equal(pruneDryRun.body?.data?.dryRun, true);
    const pruneUnconfirmed = await request("127.0.0.1", "/api/git-worktrees/prune", { method: "POST", body: { tab: undoTab } });
    assert.equal(pruneUnconfirmed.status, 409, "prune without confirmed: true should be refused");
    const pruneConfirmed = await request("127.0.0.1", "/api/git-worktrees/prune", { method: "POST", body: { tab: undoTab, confirmed: true }, timeoutMs: 20_000 });
    assert.equal(pruneConfirmed.body?.ok, true, `confirmed prune should succeed: ${pruneConfirmed.body?.error || ""}`);

    const closeGitActionTabs = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [gitignoreTab, lfTab, noFinalNewlineTab, crlfTab, literalTab, unsafeTab, fileDiffTab, stagingTab, truncationTab, mergeTab, conflictAgentTabId, abortTab, rebaseTab, bisectTab, stashTab, undoTab] }, timeoutMs: 10_000 });
    assert.equal(closeGitActionTabs.status, 200, "git action fixture tabs should close");
    await rmWithRetry(gitFixturesRoot);

    // AUR-review paths are repo-root-relative even when a tab starts in a
    // subdirectory. The dedicated read-only route must not reuse cwd-scoped
    // workspace file access.
    const reportRepo = await mkdtemp(path.join(tmpdir(), "pi-webui-aur-report-"));
    let reportTabId = "";
    try {
      const reportSubdir = path.join(reportRepo, "subdir");
      const reportPath = path.join(reportRepo, "reports", "audit.md");
      const oversizedReportPath = path.join(reportRepo, "reports", "oversized.md");
      await mkdir(reportSubdir, { recursive: true });
      await mkdir(path.dirname(reportPath), { recursive: true });
      runGitFixture(["init", "-b", "main"], reportRepo, "report fixture should initialize");
      await writeFile(reportPath, "# Audit report\n\nCanonical repo-root report.\n", "utf8");
      const reportTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: reportSubdir, title: "aur-report-subdir" } });
      assert.equal(reportTab.status, 201, `subdirectory report tab should open: ${reportTab.body?.error || ""}`);
      reportTabId = reportTab.body?.data?.tab?.id || "";
      assert.ok(reportTabId, "subdirectory report tab should have an id");
      const reportRequestPath = (reportFile, repoRoot = reportRepo) => `/api/aur-review/report-content?tab=${encodeURIComponent(reportTabId)}&path=${encodeURIComponent(reportFile)}&repoRoot=${encodeURIComponent(repoRoot)}`;

      const cwdScopedMiss = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(reportTabId)}&path=${encodeURIComponent("reports/audit.md")}`);
      assert.equal(cwdScopedMiss.status, 404, "generic workspace file access must remain scoped to the tab subdirectory");
      const openedReport = await request("127.0.0.1", reportRequestPath("reports/audit.md"));
      assert.equal(openedReport.status, 200, `repo-root report should open from a subdirectory tab: ${openedReport.body?.error || ""}`);
      assert.equal(openedReport.body?.data?.root, reportRepo, "report endpoint should return the canonical Git root");
      assert.equal(openedReport.body?.data?.path, "reports/audit.md", "report endpoint should retain the repo-relative report path");
      assert.equal(openedReport.body?.data?.content, "# Audit report\n\nCanonical repo-root report.\n");
      assert.equal(openedReport.body?.data?.language, "markdown", "repo-root reports should use the existing Markdown viewer metadata");

      const wrongRoot = await request("127.0.0.1", reportRequestPath("reports/audit.md", reportSubdir));
      assert.equal(wrongRoot.status, 403, "report endpoint must require the payload repoRoot to equal the canonical Git root");
      const traversal = await request("127.0.0.1", reportRequestPath("../reports/audit.md"));
      assert.equal(traversal.status, 400, "report endpoint must reject traversal paths");
      const absolute = await request("127.0.0.1", reportRequestPath(reportPath));
      assert.equal(absolute.status, 400, "report endpoint must reject absolute report paths");
      const nonRegular = await request("127.0.0.1", reportRequestPath("reports"));
      assert.equal(nonRegular.status, 400, "report endpoint must reject non-regular paths");
      await writeFile(oversizedReportPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      const oversized = await request("127.0.0.1", reportRequestPath("reports/oversized.md"));
      assert.equal(oversized.status, 413, "report endpoint must reject oversized reports before returning content");
      try {
        await symlink(reportPath, path.join(reportRepo, "reports", "audit-link.md"));
        const symlinked = await request("127.0.0.1", reportRequestPath("reports/audit-link.md"));
        assert.equal(symlinked.status, 403, "report endpoint must reject symlinked reports even when their targets stay in the repository");
      } catch (error) {
        if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
        console.log(`http-endpoints-harness: symlink unavailable (${error.code}); skipping report symlink check`);
      }
    } finally {
      if (reportTabId) await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [reportTabId] }, timeoutMs: 10_000 });
      await rmWithRetry(reportRepo);
    }
  } else {
    console.log("http-endpoints-harness: git not available; skipping git init workflow endpoint checks");
  }

  // Delta transcript endpoint (P1-1): ?since= returns only the tail plus merge metadata.
  const fullMessages = await request("127.0.0.1", `/api/messages?tab=${encodeURIComponent(tabId)}`);
  assert.equal(fullMessages.status, 200);
  assert.equal((fullMessages.body?.data?.messages || []).length, 3, "fake pi should provide a 3-message transcript");
  assert.equal(fullMessages.body?.data?.totalCount, undefined, "full fetches should keep the legacy payload shape");

  const deltaMessages = await request("127.0.0.1", `/api/messages?since=2&tab=${encodeURIComponent(tabId)}`);
  assert.equal(deltaMessages.status, 200);
  assert.equal(deltaMessages.body?.data?.since, 2);
  assert.equal(deltaMessages.body?.data?.totalCount, 3);
  assert.equal((deltaMessages.body?.data?.messages || []).length, 1, "since=2 should return only the tail message");
  assert.equal(deltaMessages.body?.data?.messages?.[0]?.content, "fake follow-up");

  const clampedMessages = await request("127.0.0.1", `/api/messages?since=99&tab=${encodeURIComponent(tabId)}`);
  assert.equal(clampedMessages.status, 200);
  assert.equal(clampedMessages.body?.data?.since, 3, "since beyond the transcript should clamp to the total count");
  assert.equal((clampedMessages.body?.data?.messages || []).length, 0);

  const expectedLargeRpcText = "large-rpc-payload:" + "λ".repeat(70_000);
  assert.ok(Buffer.byteLength(expectedLargeRpcText) > 64 * 1024 && Buffer.byteLength(expectedLargeRpcText) < 32 * 1024 * 1024, "large RPC fixture must exceed the former sanitizer limit while staying within the transport bound");
  const largePayloadResponse = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { tab: tabId, message: "fixture large rpc payload" },
    timeoutMs: 10_000,
  });
  assert.equal(largePayloadResponse.status, 200, "supervised live command must round-trip a large bounded response");
  assert.equal(largePayloadResponse.body?.data?.output, expectedLargeRpcText, "large multibyte live output must remain byte-exact");
  assert.deepEqual(largePayloadResponse.body?.data?.tokens, { input: 123456, output: 654321 }, "live token fields must not be stripped");
  assert.equal(largePayloadResponse.body?.data?.samples?.length, 300, "live response arrays above metadata caps must not be truncated");
  const largeStats = await request("127.0.0.1", `/api/stats?tab=${encodeURIComponent(tabId)}`);
  assert.deepEqual(largeStats.body?.data?.tokens, { input: 123456, output: 654321, total: 777777 }, "supervised token statistics must round-trip intact");
  assert.equal(largeStats.body?.data?.samples?.length, 300, "supervised statistics samples must remain complete");
  const largeTranscript = await request("127.0.0.1", `/api/messages?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 10_000 });
  assert.equal(largeTranscript.body?.data?.messages?.at(-1)?.content?.[0]?.text, expectedLargeRpcText, "authoritative transcript must preserve the large multibyte assistant output");

  // Project-local shell and Python discovery paths use a version-2 config without replacing custom runners.
  const searchToolsDir = path.join(cwd, "runner-tools");
  const searchNestedDir = path.join(cwd, "runner-nested", "scripts");
  const searchBuiltInDir = path.join(cwd, "scripts");
  const staleSearchDir = path.join(cwd, "stale-runner-tools");
  await Promise.all([
    mkdir(path.join(searchToolsDir, "deep"), { recursive: true }),
    mkdir(searchNestedDir, { recursive: true }),
    mkdir(searchBuiltInDir, { recursive: true }),
    mkdir(staleSearchDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(searchToolsDir, "alpha.sh"), "#!/usr/bin/env bash\nprintf 'configured alpha cwd=%s\\n' \"$PWD\"\n"),
    writeFile(path.join(searchToolsDir, "beta.bash"), "#!/usr/bin/env bash\nprintf 'configured beta\\n'\n"),
    writeFile(path.join(searchToolsDir, "gamma.zsh"), "#!/usr/bin/env zsh\nprintf 'configured gamma\\n'\n"),
    writeFile(path.join(searchToolsDir, "delta.fish"), "#!/usr/bin/env fish\nprintf 'configured delta\\n'\n"),
    writeFile(path.join(searchToolsDir, "shebang-run"), "#!/bin/sh\nprintf 'configured shebang\\n'\n"),
    writeFile(path.join(searchToolsDir, "ignored.txt"), "#!/bin/sh\nprintf 'not detected by existing extensionless semantics\\n'\n"),
    writeFile(path.join(searchToolsDir, "python-tool.py"), "import os\nprint(f'configured python cwd={os.getcwd()}')\n"),
    writeFile(path.join(searchToolsDir, "python-shebang"), "#!/usr/bin/env python3\nprint('configured python shebang')\n"),
    writeFile(path.join(searchToolsDir, "ignored-python.txt"), "#!/usr/bin/env python3\nprint('unsupported Python filename')\n"),
    writeFile(path.join(searchToolsDir, "deep", "recursive.sh"), "#!/usr/bin/env bash\nprintf 'not recursive\\n'\n"),
    writeFile(path.join(searchToolsDir, "deep", "recursive.py"), "print('not recursive')\n"),
    writeFile(path.join(searchNestedDir, "nested.sh"), "#!/usr/bin/env bash\nprintf 'configured nested\\n'\n"),
    writeFile(path.join(searchBuiltInDir, "shared.sh"), "#!/usr/bin/env bash\nprintf 'built-in and configured once\\n'\n"),
    writeFile(path.join(cwd, "root-search.sh"), "#!/usr/bin/env bash\nprintf 'configured root\\n'\n"),
    writeFile(path.join(cwd, "root-search.py"), "print('configured root python')\n"),
    writeFile(path.join(staleSearchDir, "stale.sh"), "#!/usr/bin/env bash\nprintf 'stale\\n'\n"),
  ]);

  // Custom app runners: save failures must be explicit, saved runners must be runnable,
  // and stale saved runners must explain why they are not shown in the Run menu.
  await writeFile(path.join(cwd, "custom-runner.mjs"), "console.log('custom runner ok')\n");
  const missingCommandRunner = await request("127.0.0.1", "/api/app-runner-config", {
    method: "POST",
    body: { tab: tabId, runner: { label: "Broken custom", command: "definitely-missing-pi-webui-runner", path: "custom-runner.mjs" } },
  });
  assert.equal(missingCommandRunner.status, 400, "saving a custom runner with a missing command should fail visibly");
  assert.match(String(missingCommandRunner.body?.error || ""), /Command is not available: definitely-missing-pi-webui-runner/);

  const savedCustomRunner = await request("127.0.0.1", "/api/app-runner-config", {
    method: "POST",
    body: { tab: tabId, runner: { label: "Custom node", command: process.execPath, path: "custom-runner.mjs" } },
    timeoutMs: 10_000,
  });
  assert.equal(savedCustomRunner.status, 200, `saving a valid custom runner should succeed: ${savedCustomRunner.body?.error || ""}`);
  const customConfigRunner = savedCustomRunner.body?.data?.customRunnerConfig?.runners?.find((runner) => runner.label === "Custom node");
  assert.equal(customConfigRunner?.available, true, "saved custom runner config should mark runnable entries available");
  const customRunner = savedCustomRunner.body?.data?.runners?.find((runner) => runner.custom === true && runner.label === "Custom node");
  assert.ok(customRunner?.id, "saved available custom runner should appear in detected app runners");

  const savedSearchPaths = await request("127.0.0.1", "/api/app-runner-config", {
    method: "POST",
    body: { tab: tabId, searchPaths: ["./runner-tools", "runner-nested/scripts", "scripts", ".", "stale-runner-tools"] },
    timeoutMs: 10_000,
  });
  assert.equal(savedSearchPaths.status, 200, `saving project discovery paths should succeed: ${savedSearchPaths.body?.error || ""}`);
  const expectedSearchPaths = ["runner-tools", "runner-nested/scripts", "scripts", ".", "stale-runner-tools"];
  assert.deepEqual(savedSearchPaths.body?.data?.customRunnerConfig?.searchPaths, expectedSearchPaths, "search paths should be slash-normalized while preserving user order");
  assert.equal(savedSearchPaths.body?.data?.customRunnerConfig?.version, 2, "search-path saves should expose the version-2 config contract");
  assert.ok(savedSearchPaths.body?.data?.customRunnerConfig?.runners?.some((runner) => runner.label === "Custom node"), "search-path saves must preserve custom runners");
  const persistedSearchConfig = JSON.parse(await readFile(path.join(cwd, ".pi-webui-runners.json"), "utf8"));
  assert.equal(persistedSearchConfig.version, 2, "search-path saves should write version 2");
  assert.deepEqual(persistedSearchConfig.searchPaths, expectedSearchPaths, "version-2 config should persist normalized search paths");
  assert.ok(persistedSearchConfig.runners.some((runner) => runner.label === "Custom node"), "version-2 config should retain existing custom runners");

  const commandAvailable = (command) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;
  const availableShells = new Set(["bash", "zsh", "fish"].filter(commandAvailable));
  const configuredShellExpectations = [
    ["runner-tools/alpha.sh", "bash"],
    ["runner-tools/beta.bash", "bash"],
    ["runner-tools/gamma.zsh", "zsh"],
    ["runner-tools/delta.fish", "fish"],
    ["runner-tools/shebang-run", "bash"],
    ["runner-nested/scripts/nested.sh", "bash"],
    ["scripts/shared.sh", "bash"],
    ["root-search.sh", "bash"],
  ];
  const detectedSearchRunners = savedSearchPaths.body?.data?.runners || [];
  for (const [projectFile, shell] of configuredShellExpectations) {
    const candidate = detectedSearchRunners.find((runner) => runner.kind === "shell" && runner.projectFile === projectFile);
    if (availableShells.has(shell)) {
      assert.equal(candidate?.command, shell, `${projectFile} should be detected with its supported ${shell} interpreter`);
      if (projectFile.startsWith("runner-")) assert.equal(candidate?.cwd, cwd, `${projectFile} should run from the project root`);
    } else {
      assert.equal(candidate, undefined, `${projectFile} should not be offered when ${shell} is unavailable`);
    }
  }
  assert.equal(detectedSearchRunners.filter((runner) => runner.kind === "shell" && runner.projectFile === "scripts/shared.sh").length, availableShells.has("bash") ? 1 : 0, "configured paths overlapping built-in directories must not duplicate candidates");
  assert.equal(detectedSearchRunners.some((runner) => runner.projectFile === "runner-tools/deep/recursive.sh"), false, "configured discovery must not recurse into child directories");
  assert.equal(detectedSearchRunners.some((runner) => runner.projectFile === "runner-tools/ignored.txt"), false, "configured discovery must retain existing extensionless shell semantics");

  const uvAvailable = commandAvailable("uv");
  const pythonCommand = commandAvailable("python3") ? "python3" : commandAvailable("python") ? "python" : "";
  for (const projectFile of ["runner-tools/python-tool.py", "runner-tools/python-shebang", "root-search.py"]) {
    const candidates = detectedSearchRunners.filter((runner) => runner.kind === "python" && runner.projectFile === projectFile);
    assert.equal(candidates.some((runner) => runner.command === "uv" && runner.args?.[0] === "run" && runner.args?.[1] === projectFile), uvAvailable, `${projectFile} should expose uv run when uv is available`);
    assert.equal(candidates.some((runner) => runner.command === pythonCommand && runner.args?.[0] === projectFile), Boolean(pythonCommand), `${projectFile} should expose the available Python interpreter`);
    assert.equal(candidates.length, Number(uvAvailable) + Number(Boolean(pythonCommand)), `${projectFile} should expose every applicable Python runtime once`);
    for (const candidate of candidates) assert.equal(candidate.cwd, cwd, `${projectFile} should run from the project root`);
  }
  assert.equal(detectedSearchRunners.some((runner) => runner.projectFile === "runner-tools/deep/recursive.py"), false, "configured Python discovery must not recurse into child directories");
  assert.equal(detectedSearchRunners.some((runner) => runner.projectFile === "runner-tools/ignored-python.txt"), false, "Python shebang detection must remain limited to extensionless files");

  if (pythonCommand) {
    const pythonRunner = detectedSearchRunners.find((runner) => runner.kind === "python" && runner.command === pythonCommand && runner.projectFile === "runner-tools/python-tool.py");
    let pythonRunState = await request("127.0.0.1", "/api/app-runner", {
      method: "POST",
      body: { tab: tabId, runnerId: pythonRunner?.id },
      timeoutMs: 10_000,
    });
    assert.equal(pythonRunState.status, 200, `configured Python runner should start: ${pythonRunState.body?.error || ""}`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (pythonRunState.body?.data?.activeRun?.status && pythonRunState.body.data.activeRun.status !== "running") break;
      await delay(100);
      pythonRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
    }
    assert.equal(pythonRunState.body?.data?.activeRun?.status, "done", "configured Python runner should complete");
    assert.match((pythonRunState.body?.data?.activeRun?.lines || []).join("\n"), new RegExp(`configured python cwd=${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "configured Python runners should execute at the project root");
    await request("127.0.0.1", "/api/app-runner/clear", { method: "POST", body: { tab: tabId } });
  }

  const configBeforeRejectedSearchPathSave = await readFile(path.join(cwd, ".pi-webui-runners.json"), "utf8");
  for (const [searchPaths, expectation] of [
    ["runner-tools", /searchPaths must be an array/i],
    [["runner-tools", "runner-tools"], /Duplicate search path/i],
    [["../outside"], /cannot contain . or \.\. segments/i],
    [[path.join(cwd, "runner-tools")], /must be relative/i],
    [["C:\\runner-tools"], /must be relative/i],
    [["runner-tools\0bad"], /null bytes/i],
    [["missing-runner-tools"], /does not exist/i],
    [["custom-runner.mjs"], /not a directory/i],
    [[...Array.from({ length: 25 }, (_, index) => `many-runner-paths-${index}`)], /limit reached/i],
  ]) {
    const rejected = await request("127.0.0.1", "/api/app-runner-config", {
      method: "POST",
      body: { tab: tabId, searchPaths },
    });
    assert.equal(rejected.status, 400, `invalid search path mutation should fail atomically: ${JSON.stringify(searchPaths)}`);
    assert.match(String(rejected.body?.error || ""), expectation);
    assert.equal(await readFile(path.join(cwd, ".pi-webui-runners.json"), "utf8"), configBeforeRejectedSearchPathSave, "a rejected search-path mutation must not change the config file");
  }

  let symlinkSearchPathAvailable = false;
  const escapedSearchRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-runner-search-escape-"));
  try {
    await writeFile(path.join(escapedSearchRoot, "escaped.sh"), "#!/usr/bin/env bash\nprintf 'escaped\\n'\n");
    await symlink(escapedSearchRoot, path.join(cwd, "escaped-runner-tools"));
    symlinkSearchPathAvailable = true;
    const escapedSearchPath = await request("127.0.0.1", "/api/app-runner-config", {
      method: "POST",
      body: { tab: tabId, searchPaths: ["escaped-runner-tools"] },
    });
    assert.equal(escapedSearchPath.status, 400, "a configured directory symlink escaping the project root must be rejected");
    assert.match(String(escapedSearchPath.body?.error || ""), /outside the project root/i);
    assert.equal(await readFile(path.join(cwd, ".pi-webui-runners.json"), "utf8"), configBeforeRejectedSearchPathSave, "an escaped symlink mutation must not change the config file");
    await symlink(path.join(escapedSearchRoot, "escaped.sh"), path.join(searchToolsDir, "escaped-file.sh"));
    const escapedDiscoveredFile = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 10_000 });
    assert.equal(escapedDiscoveredFile.body?.data?.runners?.some((runner) => runner.projectFile === "runner-tools/escaped-file.sh"), false, "a discovered file symlink escaping the project root must not become a candidate");
  } catch (error) {
    if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
    console.log(`http-endpoints-harness: symlink unavailable (${error.code}); skipping app-runner search-path escape check`);
  } finally {
    if (symlinkSearchPathAvailable) {
      await rm(path.join(cwd, "escaped-runner-tools"), { force: true });
      await rm(path.join(searchToolsDir, "escaped-file.sh"), { force: true });
    }
    await rmWithRetry(escapedSearchRoot);
  }

  if (availableShells.has("bash")) {
    const nestedSearchTab = await request("127.0.0.1", "/api/tabs", {
      method: "POST",
      body: { cwd: path.join(searchToolsDir, "deep"), title: "search-path-nested" },
    });
    assert.equal(nestedSearchTab.status, 201, `nested app-runner tab should open: ${nestedSearchTab.body?.error || ""}`);
    const nestedSearchTabId = nestedSearchTab.body?.data?.tab?.id;
    try {
      const nestedSearchRunners = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(nestedSearchTabId)}`, { timeoutMs: 10_000 });
      const nestedAlpha = nestedSearchRunners.body?.data?.runners?.find((runner) => runner.kind === "shell" && runner.projectFile === "runner-tools/alpha.sh");
      assert.equal(nestedAlpha?.cwd, cwd, "configured candidates from a nested tab must retain the project-root cwd");
      const nestedSearchStart = await request("127.0.0.1", "/api/app-runner", {
        method: "POST",
        body: { tab: nestedSearchTabId, runnerId: nestedAlpha?.id },
        timeoutMs: 10_000,
      });
      assert.equal(nestedSearchStart.status, 200, `configured shell runner should start from a nested tab: ${nestedSearchStart.body?.error || ""}`);
      let nestedSearchState = nestedSearchStart;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (nestedSearchState.body?.data?.activeRun?.status && nestedSearchState.body.data.activeRun.status !== "running") break;
        await delay(100);
        nestedSearchState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(nestedSearchTabId)}`, { timeoutMs: 5_000 });
      }
      assert.equal(nestedSearchState.body?.data?.activeRun?.status, "done", "configured shell runner should complete");
      const expectedShellCwd = process.platform === "win32"
        ? cwd.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`)
        : cwd;
      assert.match((nestedSearchState.body?.data?.activeRun?.lines || []).join("\n"), new RegExp(`configured alpha cwd=${expectedShellCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "configured shell runners should execute at the project root");
    } finally {
      if (nestedSearchTabId) await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [nestedSearchTabId] }, timeoutMs: 10_000 });
    }
  }

  await rmWithRetry(staleSearchDir);
  const staleSearchPaths = await request("127.0.0.1", "/api/app-runner-config", { timeoutMs: 10_000 });
  assert.deepEqual(staleSearchPaths.body?.data?.searchPaths, expectedSearchPaths, "stale on-disk search paths should remain visible so users can remove them");
  assert.ok(staleSearchPaths.body?.data?.diagnostics?.some((diagnostic) => diagnostic.path === "stale-runner-tools" && /does not exist/i.test(diagnostic.message)), "stale configured paths should surface a diagnostic");
  assert.equal(staleSearchPaths.body?.data?.runners?.some((runner) => runner.projectFile === "stale-runner-tools/stale.sh"), false, "stale configured paths must not be scanned");

  const temporaryCustomRunner = await request("127.0.0.1", "/api/app-runner-config", {
    method: "POST",
    body: { tab: tabId, runner: { label: "Temporary search-path custom", command: process.execPath, path: "custom-runner.mjs" } },
    timeoutMs: 10_000,
  });
  assert.equal(temporaryCustomRunner.status, 200, `custom runner saves should preserve search paths: ${temporaryCustomRunner.body?.error || ""}`);
  assert.deepEqual(temporaryCustomRunner.body?.data?.customRunnerConfig?.searchPaths, expectedSearchPaths, "custom-runner POST must preserve search paths");
  const temporaryCustomRunnerId = temporaryCustomRunner.body?.data?.customRunnerConfig?.runners?.find((runner) => runner.label === "Temporary search-path custom")?.id;
  const deletedTemporaryCustomRunner = await request("127.0.0.1", "/api/app-runner-config", {
    method: "DELETE",
    body: { tab: tabId, id: temporaryCustomRunnerId },
    timeoutMs: 10_000,
  });
  assert.equal(deletedTemporaryCustomRunner.status, 200, `custom runner deletion should preserve search paths: ${deletedTemporaryCustomRunner.body?.error || ""}`);
  assert.deepEqual(deletedTemporaryCustomRunner.body?.data?.customRunnerConfig?.searchPaths, expectedSearchPaths, "custom-runner DELETE must preserve search paths");

  const customRunStart = await request("127.0.0.1", "/api/app-runner", {
    method: "POST",
    body: { tab: tabId, runnerId: customRunner.id },
    timeoutMs: 10_000,
  });
  assert.equal(customRunStart.status, 200, `custom runner start should return ok: ${customRunStart.body?.error || ""}`);
  let customRunState = customRunStart;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (customRunState.body?.data?.activeRun?.status && customRunState.body.data.activeRun.status !== "running") break;
    await delay(100);
    customRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
  }
  assert.equal(customRunState.body?.data?.activeRun?.status, "done", "custom runner should finish successfully");
  assert.match((customRunState.body?.data?.activeRun?.lines || []).join("\n"), /custom runner ok/, "custom runner output should be captured");
  await request("127.0.0.1", "/api/app-runner/clear", { method: "POST", body: { tab: tabId } });

  await writeFile(path.join(cwd, "interactive-runner.mjs"), [
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "console.log(`interactive ready; stdin tty=${Boolean(process.stdin.isTTY)}`);",
    "rl.question('name? ', (answer) => {",
    "  console.log(`hello ${answer}`);",
    "  rl.close();",
    "});",
    "",
  ].join("\n"));
  const savedInteractiveRunner = await request("127.0.0.1", "/api/app-runner-config", {
    method: "POST",
    body: { tab: tabId, runner: { label: "Interactive node", command: process.execPath, path: "interactive-runner.mjs" } },
    timeoutMs: 10_000,
  });
  assert.equal(savedInteractiveRunner.status, 200, `saving an interactive custom runner should succeed: ${savedInteractiveRunner.body?.error || ""}`);
  const interactiveRunner = savedInteractiveRunner.body?.data?.runners?.find((runner) => runner.custom === true && runner.label === "Interactive node");
  assert.ok(interactiveRunner?.id, "interactive custom runner should appear in detected app runners");
  const interactiveRunStart = await request("127.0.0.1", "/api/app-runner", {
    method: "POST",
    body: { tab: tabId, runnerId: interactiveRunner.id },
    timeoutMs: 10_000,
  });
  assert.equal(interactiveRunStart.status, 200, `interactive runner start should return ok: ${interactiveRunStart.body?.error || ""}`);
  if (process.platform === "win32") {
    assert.equal(interactiveRunStart.body?.data?.activeRun?.executionMode, "conpty", "Windows interactive runners should use the node-pty ConPTY backend");
  }
  let interactiveRunState = interactiveRunStart;
  for (let attempt = 0; attempt < 50; attempt++) {
    interactiveRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
    const output = [
      ...(interactiveRunState.body?.data?.activeRun?.lines || []),
      interactiveRunState.body?.data?.activeRun?.pendingLine || "",
    ].join("\n");
    if (/name\?/.test(output)) break;
    await delay(100);
  }
  assert.match([
    ...(interactiveRunState.body?.data?.activeRun?.lines || []),
    interactiveRunState.body?.data?.activeRun?.pendingLine || "",
  ].join("\n"), /name\?/, "interactive app runner should expose a prompt without waiting for a newline");
  const interactiveInput = await request("127.0.0.1", "/api/app-runner/input", {
    method: "POST",
    body: { tab: tabId, text: "webui", closeStdin: true },
    timeoutMs: 10_000,
  });
  assert.equal(interactiveInput.status, 200, `interactive app runner input should be accepted: ${interactiveInput.body?.error || ""}`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (interactiveRunState.body?.data?.activeRun?.status && interactiveRunState.body.data.activeRun.status !== "running") break;
    await delay(100);
    interactiveRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
  }
  assert.equal(interactiveRunState.body?.data?.activeRun?.status, "done", "interactive custom runner should finish after stdin");
  const interactiveOutput = (interactiveRunState.body?.data?.activeRun?.lines || []).join("\n");
  assert.match(interactiveOutput, /hello webui/, "interactive custom runner should receive stdin from the app-runner input endpoint");
  if (process.platform === "win32") assert.match(interactiveOutput, /stdin tty=true/, "Windows ConPTY runners should expose a real TTY to the child process");
  assert.match(interactiveOutput, /# stdin sent \(5 chars\) and closed/, "app runner output should show that stdin was sent without echoing the input text itself");
  await request("127.0.0.1", "/api/app-runner/clear", { method: "POST", body: { tab: tabId } });

  const scriptVersion = spawnSync("script", ["--version"], { encoding: "utf8" });
  const utilLinuxScriptAvailable = process.platform !== "win32" && scriptVersion.status === 0 && /util-linux/i.test(`${scriptVersion.stdout}\n${scriptVersion.stderr}`);
  const bashAvailable = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
  if ((utilLinuxScriptAvailable || process.platform === "win32") && bashAvailable) {
    await mkdir(path.join(cwd, "qa"), { recursive: true });
    await writeFile(path.join(cwd, "qa", "read-p-runner.sh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "read -r -p 'choice? ' answer",
      "printf 'selected:%s\\n' \"$answer\"",
      "",
    ].join("\n"));
    const savedReadPromptRunner = await request("127.0.0.1", "/api/app-runner-config", {
      method: "POST",
      body: { tab: tabId, runner: { label: "Read prompt bash", command: "bash", path: "qa/read-p-runner.sh" } },
      timeoutMs: 10_000,
    });
    assert.equal(savedReadPromptRunner.status, 200, `saving a bash read -p runner should succeed: ${savedReadPromptRunner.body?.error || ""}`);
    const readPromptRunner = savedReadPromptRunner.body?.data?.runners?.find((runner) => runner.custom === true && runner.label === "Read prompt bash");
    assert.ok(readPromptRunner?.id, "bash read -p runner should appear in detected app runners");
    const readPromptStart = await request("127.0.0.1", "/api/app-runner", {
      method: "POST",
      body: { tab: tabId, runnerId: readPromptRunner.id },
      timeoutMs: 10_000,
    });
    assert.equal(readPromptStart.status, 200, `bash read -p runner start should return ok: ${readPromptStart.body?.error || ""}`);
    const expectedPtyMode = process.platform === "win32" ? "conpty" : "pty";
    assert.equal(readPromptStart.body?.data?.activeRun?.executionMode, expectedPtyMode, "bash read -p runner should use the platform PTY-backed execution path");
    let readPromptState = readPromptStart;
    for (let attempt = 0; attempt < 50; attempt++) {
      readPromptState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
      const output = [
        ...(readPromptState.body?.data?.activeRun?.lines || []),
        readPromptState.body?.data?.activeRun?.pendingLine || "",
      ].join("\n");
      if (/choice\?/.test(output)) break;
      await delay(100);
    }
    assert.match([
      ...(readPromptState.body?.data?.activeRun?.lines || []),
      readPromptState.body?.data?.activeRun?.pendingLine || "",
    ].join("\n"), /choice\?/, "bash read -p prompts should be captured before a trailing newline");
    const readPromptInput = await request("127.0.0.1", "/api/app-runner/input", {
      method: "POST",
      body: { tab: tabId, text: "alpha", closeStdin: true },
      timeoutMs: 10_000,
    });
    assert.equal(readPromptInput.status, 200, `bash read -p runner input should be accepted: ${readPromptInput.body?.error || ""}`);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (readPromptState.body?.data?.activeRun?.status && readPromptState.body.data.activeRun.status !== "running") break;
      await delay(100);
      readPromptState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
    }
    assert.equal(readPromptState.body?.data?.activeRun?.status, "done", "bash read -p runner should finish after stdin");
    const readPromptOutput = (readPromptState.body?.data?.activeRun?.lines || []).join("\n");
    assert.match(readPromptOutput, /selected:alpha/, "bash read -p runner should receive stdin from the app-runner input endpoint");
    if (process.platform !== "win32") assert.doesNotMatch(readPromptOutput, /^alpha$/m, "script-backed PTY runner should not echo raw stdin into captured output");
    await request("127.0.0.1", "/api/app-runner/clear", { method: "POST", body: { tab: tabId } });
  }

  if (process.platform !== "win32") {
    await writeFile(path.join(cwd, "signal-runner.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGINT', () => { writeFileSync('signal-result.txt', 'SIGINT\\n'); process.exit(130); });",
      "process.on('SIGTERM', () => { writeFileSync('signal-result.txt', 'SIGTERM\\n'); process.exit(143); });",
      "console.log('signal runner ready');",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    const savedSignalRunner = await request("127.0.0.1", "/api/app-runner-config", {
      method: "POST",
      body: { tab: tabId, runner: { label: "Signal node", command: process.execPath, path: "signal-runner.mjs" } },
      timeoutMs: 10_000,
    });
    assert.equal(savedSignalRunner.status, 200, `saving a signal custom runner should succeed: ${savedSignalRunner.body?.error || ""}`);
    const signalRunner = savedSignalRunner.body?.data?.runners?.find((runner) => runner.custom === true && runner.label === "Signal node");
    assert.ok(signalRunner?.id, "signal custom runner should appear in detected app runners");
    let signalRunState = await request("127.0.0.1", "/api/app-runner", {
      method: "POST",
      body: { tab: tabId, runnerId: signalRunner.id },
      timeoutMs: 10_000,
    });
    assert.equal(signalRunState.status, 200, `signal runner start should return ok: ${signalRunState.body?.error || ""}`);
    for (let attempt = 0; attempt < 50; attempt++) {
      signalRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
      const output = [
        ...(signalRunState.body?.data?.activeRun?.lines || []),
        signalRunState.body?.data?.activeRun?.pendingLine || "",
      ].join("\n");
      if (/signal runner ready/.test(output)) break;
      await delay(100);
    }
    assert.match([
      ...(signalRunState.body?.data?.activeRun?.lines || []),
      signalRunState.body?.data?.activeRun?.pendingLine || "",
    ].join("\n"), /signal runner ready/, "signal app runner should start before stop is requested");
    const signalStop = await request("127.0.0.1", "/api/app-runner/stop", { method: "POST", body: { tab: tabId }, timeoutMs: 10_000 });
    assert.equal(signalStop.status, 200, `signal runner stop should return ok: ${signalStop.body?.error || ""}`);
    assert.match((signalStop.body?.data?.activeRun?.lines || []).join("\n"), /sending Ctrl\+C/, "Web UI stop should document Ctrl+C-equivalent interruption");
    let signalResult = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      signalRunState = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 5_000 });
      try {
        signalResult = await readFile(path.join(cwd, "signal-result.txt"), "utf8");
      } catch {
        signalResult = "";
      }
      const signalRunStopped = signalRunState.body?.data?.activeRun?.status && signalRunState.body.data.activeRun.status !== "running";
      if (signalResult && signalRunStopped) break;
      await delay(100);
    }
    assert.equal(signalResult.trim(), "SIGINT", "Web UI app-runner stop should deliver SIGINT like terminal Ctrl+C, not SIGTERM");
    assert.notEqual(signalRunState.body?.data?.activeRun?.status, "running", "signal app runner should fully stop before cleanup continues");
    await request("127.0.0.1", "/api/app-runner/clear", { method: "POST", body: { tab: tabId } });
  }

  await writeFile(path.join(cwd, ".pi-webui-runners.json"), `${JSON.stringify({
    version: 2,
    searchPaths: ["runner-tools", "missing-stored-runner-tools", "../malformed-runner-tools", "runner-tools"],
    runners: [{ id: "broken-custom", label: "Broken custom", command: "definitely-missing-pi-webui-runner", path: "custom-runner.mjs" }],
  }, null, 2)}\n`);
  const staleCustomRunner = await request("127.0.0.1", `/api/app-runners?tab=${encodeURIComponent(tabId)}`, { timeoutMs: 10_000 });
  assert.equal(staleCustomRunner.status, 200);
  const brokenConfigRunner = staleCustomRunner.body?.data?.customRunnerConfig?.runners?.find((runner) => runner.label === "Broken custom");
  assert.equal(brokenConfigRunner?.available, false, "unavailable saved custom runners should be flagged in config data");
  assert.match(String(brokenConfigRunner?.unavailableReason || ""), /Command is not available: definitely-missing-pi-webui-runner/);
  assert.equal(staleCustomRunner.body?.data?.runners?.some((runner) => runner.label === "Broken custom"), false, "unavailable custom runners should not appear in runnable menu data");
  assert.deepEqual(staleCustomRunner.body?.data?.customRunnerConfig?.searchPaths, ["runner-tools", "missing-stored-runner-tools"], "stored search paths should normalize and de-duplicate malformed config data");
  assert.ok(staleCustomRunner.body?.data?.customRunnerConfig?.diagnostics?.some((diagnostic) => diagnostic.path === "missing-stored-runner-tools" && /does not exist/i.test(diagnostic.message)), "missing stored search paths should report diagnostics");
  assert.ok(staleCustomRunner.body?.data?.customRunnerConfig?.diagnostics?.some((diagnostic) => /Invalid search path ignored/i.test(diagnostic.message)), "malformed stored search paths should report diagnostics");
  assert.ok(staleCustomRunner.body?.data?.customRunnerConfig?.diagnostics?.some((diagnostic) => diagnostic.path === "runner-tools" && /Duplicate search path/i.test(diagnostic.message)), "duplicate stored search paths should report diagnostics");

  // Native slash command routed through the adapter (/copy → get_last_assistant_text).
  const copy = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { message: "/copy", tab: tabId },
  });
  assert.equal(copy.status, 200);
  assert.equal(copy.body?.data?.status, "succeeded", "native /copy should succeed through the adapter");
  assert.equal(copy.body?.data?.copyText, "fake last text");

  // File tree/viewer APIs stay scoped to the requested tab cwd and reject unsafe content.
  const filesRoot = path.join(cwd, "files-fixture");
  const viewerRelative = "files-fixture/viewer.txt";
  const markdownRelative = "files-fixture/docs/readme.md";
  const imageRelative = "files-fixture/pixel.png";
  const binaryRelative = "files-fixture/binary.bin";
  const noDefaultRelative = "files-fixture/no-default.piunknown";
  const largeRelative = "files-fixture/large.txt";
  const movableFileRelative = "files-fixture/move-me.txt";
  const movedFileRelative = "files-fixture/docs/moved-file.txt";
  const movableDirectoryRelative = "files-fixture/move-dir";
  const movedDirectoryRelative = "files-fixture/docs/move-dir";
  const deleteFileRelative = "files-fixture/delete-me.txt";
  const deleteDirectoryRelative = "files-fixture/delete-dir";
  const ignoredFileRelative = "files-fixture/ignored-note.txt";
  const ignoredDirectoryRelative = "files-fixture/ignored-output";
  const ignoredNestedFileRelative = "files-fixture/ignored-output/recursive-ignored-result.txt";
  const trackedPatternRelative = "files-fixture/tracked-pattern.txt";
  const depthEightFileRelative = "deep-search/f1/f2/f3/f4/f5/f6/depth-eight-file.txt";
  const depthEightDirectoryRelative = "deep-search/d1/d2/d3/d4/d5/d6/depth-eight-dir";
  const depthNineFileRelative = "deep-search/t1/t2/t3/t4/t5/t6/t7/too-deep-file.txt";
  await mkdir(path.join(filesRoot, "docs"), { recursive: true });
  await mkdir(path.join(cwd, path.dirname(depthEightFileRelative)), { recursive: true });
  await mkdir(path.join(cwd, depthEightDirectoryRelative), { recursive: true });
  await mkdir(path.join(cwd, path.dirname(depthNineFileRelative)), { recursive: true });
  await writeFile(path.join(cwd, viewerRelative), "hello file viewer\nsecond line\n", "utf8");
  await writeFile(path.join(cwd, markdownRelative), "# File Viewer\n\nMarkdown preview support.\n", "utf8");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(path.join(cwd, imageRelative), imageBytes);
  await writeFile(path.join(cwd, noDefaultRelative), "unknown extension should use text/plain editor fallback\n", "utf8");
  await writeFile(path.join(cwd, depthEightFileRelative), "depth 8 search fixture\n", "utf8");
  await writeFile(path.join(cwd, depthNineFileRelative), "depth 9 search fixture\n", "utf8");
  await writeFile(path.join(cwd, binaryRelative), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(cwd, largeRelative), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  await writeFile(path.join(cwd, movableFileRelative), "move me\n", "utf8");
  await mkdir(path.join(cwd, movableDirectoryRelative), { recursive: true });
  await writeFile(path.join(cwd, movableDirectoryRelative, "nested.txt"), "nested move\n", "utf8");
  await writeFile(path.join(cwd, deleteFileRelative), "delete me\n", "utf8");
  await mkdir(path.join(cwd, deleteDirectoryRelative), { recursive: true });
  await writeFile(path.join(cwd, deleteDirectoryRelative, "nested.txt"), "nested delete\n", "utf8");
  await writeFile(path.join(cwd, ignoredFileRelative), "ignored file remains visible\n", "utf8");
  await mkdir(path.join(cwd, ignoredDirectoryRelative), { recursive: true });
  await writeFile(path.join(cwd, ignoredNestedFileRelative), "recursive ignored search fixture\n", "utf8");
  await writeFile(path.join(cwd, trackedPatternRelative), "tracked files remain normal\n", "utf8");
  if (gitAvailable) {
    const gitignorePath = path.join(cwd, ".gitignore");
    const gitignore = await readFile(gitignorePath, "utf8");
    await writeFile(gitignorePath, `${gitignore.replace(/\n?$/, "\n")}/files-fixture/ignored-note.txt\n/files-fixture/ignored-output/\n/files-fixture/tracked-pattern.txt\n`, "utf8");
    runGitFixture(["add", "-f", "--", trackedPatternRelative], cwd, "tracked ignore-pattern fixture should enter the Git index");
  }

  const fileTree = await request("127.0.0.1", `/api/files?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent("files-fixture")}`);
  assert.equal(fileTree.status, 200, `file tree endpoint should list workspace directories: ${fileTree.body?.error || ""}`);
  assert.equal(fileTree.body?.ok, true);
  const fileTreeEntries = fileTree.body?.data?.entries || [];
  assert.equal(fileTreeEntries.find((entry) => entry.name === "docs")?.type, "directory", "file tree should identify subdirectories");
  const normalFileTreeEntry = fileTreeEntries.find((entry) => entry.name === "viewer.txt");
  assert.equal(normalFileTreeEntry?.type, "file", "file tree should identify regular files");
  assert.equal(normalFileTreeEntry?.gitIgnored, undefined, "ordinary file tree entries should omit the Git-ignore decoration");
  if (gitAvailable) {
    const ignoredFileEntry = fileTreeEntries.find((entry) => entry.path === ignoredFileRelative);
    const ignoredDirectoryEntry = fileTreeEntries.find((entry) => entry.path === ignoredDirectoryRelative);
    assert.equal(ignoredFileEntry?.type, "file", "ignored files should remain present in file tree responses");
    assert.equal(ignoredFileEntry?.gitIgnored, true, "Git-ignored files should be decorated");
    assert.equal(ignoredDirectoryEntry?.type, "directory", "ignored directories should remain present in file tree responses");
    assert.equal(ignoredDirectoryEntry?.gitIgnored, true, "Git-ignored directories should be decorated");
    assert.equal(fileTreeEntries.find((entry) => entry.path === trackedPatternRelative)?.gitIgnored, undefined, "tracked files that match an ignore pattern should remain normal");
  }

  const fileSearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=${encodeURIComponent("readme")}`);
  assert.equal(fileSearch.status, 200, `file search endpoint should search workspace files: ${fileSearch.body?.error || ""}`);
  assert.equal(fileSearch.body?.ok, true);
  const fileSearchEntries = fileSearch.body?.data?.entries || [];
  assert.equal(fileSearchEntries.find((entry) => entry.path === markdownRelative)?.type, "file", "file search should find matching files recursively");
  assert.equal(fileSearchEntries.find((entry) => entry.path === markdownRelative)?.gitIgnored, undefined, "ordinary search results should omit the Git-ignore decoration");

  if (gitAvailable) {
    const ignoredSearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=${encodeURIComponent("ignored")}`);
    assert.equal(ignoredSearch.status, 200, `file search should retain Git-ignored entries: ${ignoredSearch.body?.error || ""}`);
    const ignoredSearchEntries = ignoredSearch.body?.data?.entries || [];
    assert.equal(ignoredSearchEntries.find((entry) => entry.path === ignoredFileRelative)?.gitIgnored, true, "ignored file search results should be decorated");
    assert.equal(ignoredSearchEntries.find((entry) => entry.path === ignoredDirectoryRelative)?.gitIgnored, true, "ignored directory search results should be decorated");
    assert.equal(ignoredSearchEntries.find((entry) => entry.path === ignoredNestedFileRelative)?.gitIgnored, true, "recursive search should descend into and decorate ignored directories");

    const trackedPatternSearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=${encodeURIComponent("tracked-pattern")}`);
    assert.equal(trackedPatternSearch.status, 200, "tracked ignore-pattern search should be accepted");
    assert.equal(trackedPatternSearch.body?.data?.entries?.find((entry) => entry.path === trackedPatternRelative)?.gitIgnored, undefined, "tracked search results that match an ignore pattern should remain normal");
  }

  const directorySearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=${encodeURIComponent("docs")}`);
  assert.equal(directorySearch.status, 200, `file search endpoint should search directories: ${directorySearch.body?.error || ""}`);
  assert.equal(directorySearch.body?.data?.entries?.find((entry) => entry.path === "files-fixture/docs")?.type, "directory", "file search should find matching directories");

  const depthLimitedSearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=${encodeURIComponent("depth")}`);
  assert.equal(depthLimitedSearch.status, 200, `file search endpoint should honor depth-limited recursive search: ${depthLimitedSearch.body?.error || ""}`);
  assert.equal(depthLimitedSearch.body?.data?.maxDepth, 8, "file search should advertise the recursive depth cap");
  assert.equal(depthLimitedSearch.body?.data?.entries?.find((entry) => entry.path === depthEightFileRelative)?.type, "file", "file search should find matching files at depth 8");
  assert.equal(depthLimitedSearch.body?.data?.entries?.find((entry) => entry.path === depthEightDirectoryRelative)?.type, "directory", "file search should find matching directories at depth 8");
  assert.equal(depthLimitedSearch.body?.data?.entries?.some((entry) => entry.path === depthNineFileRelative), false, "file search should not descend past depth 8");

  const emptyFileSearch = await request("127.0.0.1", `/api/files/search?tab=${encodeURIComponent(tabId)}&q=`);
  assert.equal(emptyFileSearch.status, 200, "empty file search should be accepted");
  assert.deepEqual(emptyFileSearch.body?.data?.entries, [], "empty file search should not scan the workspace");

  const textContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(viewerRelative)}`);
  assert.equal(textContent.status, 200, `text file should open in WebUI: ${textContent.body?.error || ""}`);
  assert.equal(textContent.body?.data?.content, "hello file viewer\nsecond line\n");
  assert.equal(textContent.body?.data?.language, "text");

  const markdownContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(markdownRelative)}`);
  assert.equal(markdownContent.status, 200, `markdown file should open in WebUI: ${markdownContent.body?.error || ""}`);
  assert.equal(markdownContent.body?.data?.language, "markdown", "markdown files should get markdown viewer support metadata");

  const imageContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(imageRelative)}`);
  assert.equal(imageContent.status, 200, `supported images should open in WebUI: ${imageContent.body?.error || ""}`);
  assert.equal(imageContent.body?.data?.kind, "image", "image responses should identify their viewer kind");
  assert.equal(imageContent.body?.data?.mimeType, "image/png", "image responses should expose an allowlisted MIME type");
  assert.equal(imageContent.body?.data?.data, imageBytes.toString("base64"), "image responses should preserve the bounded file bytes as base64");
  assert.equal(imageContent.body?.data?.content, undefined, "image responses should not reinterpret binary bytes as editable text");

  const emptyDefaultOpen = await request("127.0.0.1", "/api/files/open-default", { method: "POST", body: { tab: tabId, path: "" } });
  assert.equal(emptyDefaultOpen.status, 400, "default editor opens should reject empty paths instead of opening the workspace root");
  assert.match(String(emptyDefaultOpen.body?.error || ""), /Path to open is required/i);

  const defaultOpen = await request("127.0.0.1", "/api/files/open-default", { method: "POST", body: { tab: tabId, path: viewerRelative } });
  assert.equal(defaultOpen.status, 200, `default editor should open the requested file: ${defaultOpen.body?.error || ""}`);
  assert.equal(defaultOpen.body?.data?.path, viewerRelative, "default editor endpoint should report the requested file path");
  const openedAbsolutePath = path.join(cwd, viewerRelative);
  let openLog = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    openLog = await readFile(openCommandLog, "utf8").catch(() => "");
    if (openLog.includes(openedAbsolutePath)) break;
    await delay(50);
  }
  assert.ok(openLog.includes(openedAbsolutePath), "default editor command should receive the currently opened file path");

  if (process.platform === "linux") {
    const fallbackOpen = await request("127.0.0.1", "/api/files/open-default", { method: "POST", body: { tab: tabId, path: noDefaultRelative } });
    assert.equal(fallbackOpen.status, 200, `default editor should fall back to the .txt editor for unassociated files: ${fallbackOpen.body?.error || ""}`);
    assert.equal(fallbackOpen.body?.data?.path, noDefaultRelative, "default editor fallback should report the requested file path");
    assert.equal(fallbackOpen.body?.data?.fallbackToTextEditor, true, "unassociated files should be opened through the text/plain fallback");
    assert.equal(fallbackOpen.body?.data?.desktopFile, "fake-text-editor.desktop", "fallback should use the text/plain desktop app association");
    const fallbackAbsolutePath = path.join(cwd, noDefaultRelative);
    for (let attempt = 0; attempt < 20; attempt++) {
      openLog = await readFile(openCommandLog, "utf8").catch(() => "");
      if (openLog.includes(`gio\tlaunch\tfake-text-editor.desktop\t${fallbackAbsolutePath}`)) break;
      await delay(50);
    }
    assert.ok(openLog.includes(`gio\tlaunch\tfake-text-editor.desktop\t${fallbackAbsolutePath}`), "default editor fallback should invoke the text/plain editor for the requested file");
  }

  const savedFile = await request("127.0.0.1", "/api/files/content", {
    method: "POST",
    body: { tab: tabId, path: viewerRelative, content: "updated from WebUI\n", mtimeMs: textContent.body?.data?.mtimeMs },
  });
  assert.equal(savedFile.status, 200, `file save should succeed from localhost: ${savedFile.body?.error || ""}`);
  assert.equal(await readFile(path.join(cwd, viewerRelative), "utf8"), "updated from WebUI\n", "file save endpoint should write UTF-8 text content");

  const moveUnconfirmed = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: movableFileRelative, toPath: movedFileRelative } });
  assert.equal(moveUnconfirmed.status, 409, "file moves require explicit confirmation");

  const moveFile = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: movableFileRelative, toPath: movedFileRelative, confirmed: true } });
  assert.equal(moveFile.status, 200, `file move should succeed from localhost: ${moveFile.body?.error || ""}`);
  assert.equal(moveFile.body?.data?.destination, movedFileRelative, "move endpoint should report the new relative file path");
  assert.equal(await readFile(path.join(cwd, movedFileRelative), "utf8"), "move me\n", "move endpoint should relocate file contents");
  assert.equal(await pathExists(path.join(cwd, movableFileRelative)), false, "move endpoint should remove the original file path");

  const moveDirectory = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: movableDirectoryRelative, toPath: "files-fixture/docs", confirmed: true } });
  assert.equal(moveDirectory.status, 200, `directory move should succeed from localhost: ${moveDirectory.body?.error || ""}`);
  assert.equal(moveDirectory.body?.data?.destination, movedDirectoryRelative, "moving to an existing directory should place the source under that directory");
  assert.equal(await readFile(path.join(cwd, movedDirectoryRelative, "nested.txt"), "utf8"), "nested move\n", "move endpoint should relocate directory contents");
  assert.equal(await pathExists(path.join(cwd, movableDirectoryRelative)), false, "directory move endpoint should remove the original directory path");

  const moveExistingDestination = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: movedFileRelative, toPath: markdownRelative, confirmed: true } });
  assert.equal(moveExistingDestination.status, 409, "move endpoint should refuse to overwrite an existing destination");

  const deleteUnconfirmed = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: deleteFileRelative } });
  assert.equal(deleteUnconfirmed.status, 409, "file deletes require explicit confirmation");

  const deleteFile = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: deleteFileRelative, confirmed: true } });
  assert.equal(deleteFile.status, 200, `file delete should succeed from localhost: ${deleteFile.body?.error || ""}`);
  assert.equal(deleteFile.body?.data?.deleted, true, "delete endpoint should report successful file deletion");
  assert.equal(await pathExists(path.join(cwd, deleteFileRelative)), false, "delete endpoint should remove regular files");

  const deleteDirectory = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: deleteDirectoryRelative, confirmed: true } });
  assert.equal(deleteDirectory.status, 200, `directory delete should succeed from localhost: ${deleteDirectory.body?.error || ""}`);
  assert.equal(deleteDirectory.body?.data?.type, "directory", "delete endpoint should report directory deletions");
  assert.equal(await pathExists(path.join(cwd, deleteDirectoryRelative)), false, "delete endpoint should remove directories recursively");

  const deleteWorkspaceRoot = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: "", confirmed: true } });
  assert.equal(deleteWorkspaceRoot.status, 400, "delete endpoint must refuse deleting the active workspace root");

  const binaryContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(binaryRelative)}`);
  assert.equal(binaryContent.status, 415, "binary files should be rejected by the WebUI file viewer");
  assert.match(String(binaryContent.body?.error || ""), /binary/i);

  const oversizedContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(largeRelative)}`);
  assert.equal(oversizedContent.status, 413, "oversized files should be rejected by the WebUI file viewer");
  assert.match(String(oversizedContent.body?.error || ""), /too large/i);

  const outsideRoot = await mkdtemp(path.join(tmpdir(), "pi-webui-files-outside-"));
  try {
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await writeFile(outsideFile, "outside\n", "utf8");
    const outsideAbsolute = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(outsideFile)}`);
    assert.equal(outsideAbsolute.status, 403, "absolute paths outside the active tab cwd should be rejected");
    assert.match(String(outsideAbsolute.body?.error || ""), /active tab working directory/i);

    const outsideDelete = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: outsideFile, confirmed: true } });
    assert.equal(outsideDelete.status, 403, "delete endpoint should reject absolute paths outside the active tab cwd");

    const outsideMoveDestination = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: movedFileRelative, toPath: outsideFile, confirmed: true } });
    assert.equal(outsideMoveDestination.status, 403, "move endpoint should reject destinations outside the active tab cwd");

    const symlinkPath = path.join(filesRoot, "outside-link.txt");
    try {
      await symlink(outsideFile, symlinkPath);
      const symlinkEscape = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent("files-fixture/outside-link.txt")}`);
      assert.equal(symlinkEscape.status, 403, "symlinks resolving outside the active tab cwd should be rejected");
      assert.match(String(symlinkEscape.body?.error || ""), /escapes the active tab working directory/i);
    } catch (error) {
      if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
      console.log(`http-endpoints-harness: symlink unavailable (${error.code}); skipping file symlink confinement check`);
    }
  } finally {
    await rmWithRetry(outsideRoot);
  }

  const filesTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: filesRoot, title: "files-fixture" } });
  assert.equal(filesTab.status, 201, `file fixture tab should open: ${filesTab.body?.error || ""}`);
  const filesTabId = filesTab.body?.data?.tab?.id;
  assert.ok(filesTabId, "file fixture tab should have an id");
  const scopedFileContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(filesTabId)}&path=${encodeURIComponent("viewer.txt")}`);
  assert.equal(scopedFileContent.status, 200, "file paths should resolve against the requested tab cwd");
  const wrongTabContent = await request("127.0.0.1", `/api/files/content?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent("viewer.txt")}`);
  assert.equal(wrongTabContent.status, 404, "file paths should not bleed across tab cwd scopes");
  const closeFilesTab = await request("127.0.0.1", "/api/tabs/close", { method: "POST", body: { ids: [filesTabId] }, timeoutMs: 10_000 });
  assert.equal(closeFilesTab.status, 200, "file fixture tab should close after scoped file checks");

  // Codex subscription Fast mode: exact status is extension-owned and every mutation must be
  // idle, explicit, tab-scoped, and confirmed by the extension status event.
  const initialCodexFastMode = await request("127.0.0.1", `/api/codex-fast-mode?tab=${encodeURIComponent(tabId)}`);
  assert.equal(initialCodexFastMode.status, 200);
  assert.equal(initialCodexFastMode.body?.data?.available, true, "fake /fast-mode command should make Codex Fast mode available");
  assert.equal(initialCodexFastMode.body?.data?.statusKnown, false, "server must not infer Fast mode before the extension publishes status");

  const invalidCodexFastMode = await request("127.0.0.1", "/api/codex-fast-mode", {
    method: "PUT",
    body: { enabled: "yes", tab: tabId },
  });
  assert.equal(invalidCodexFastMode.status, 400, "Codex Fast mode should require an explicit boolean");

  const codexFastModeOn = await request("127.0.0.1", "/api/codex-fast-mode", {
    method: "PUT",
    body: { enabled: true, tab: tabId },
  });
  assert.equal(codexFastModeOn.status, 200, `Codex Fast mode on should succeed: ${codexFastModeOn.body?.error || ""}`);
  assert.equal(codexFastModeOn.body?.data?.statusKnown, true);
  assert.equal(codexFastModeOn.body?.data?.enabled, true, "PUT should return only extension-confirmed on state");

  const rejectNextCodexFastMode = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { message: "fixture reject next codex fast mode mutation", tab: tabId },
  });
  assert.equal(rejectNextCodexFastMode.status, 200);
  const rejectedCodexFastModeOff = await request("127.0.0.1", "/api/codex-fast-mode", {
    method: "PUT",
    body: { enabled: false, tab: tabId },
    timeoutMs: 5_000,
  });
  assert.equal(rejectedCodexFastModeOff.status, 409, "RPC success without matching extension status should fail closed");
  assert.match(String(rejectedCodexFastModeOff.body?.error || ""), /did not confirm off/i);
  const codexFastModeStillOn = await request("127.0.0.1", `/api/codex-fast-mode?tab=${encodeURIComponent(tabId)}`);
  assert.equal(codexFastModeStillOn.body?.data?.enabled, true, "a rejected mutation must not become optimistic off state");

  const busyFixturePrompt = await request("127.0.0.1", "/api/prompt", {
    method: "POST",
    body: { message: "voice test slow", tab: tabId },
  });
  assert.equal(busyFixturePrompt.status, 200);
  await delay(80);
  const busyCodexFastModeOff = await request("127.0.0.1", "/api/codex-fast-mode", {
    method: "PUT",
    body: { enabled: false, tab: tabId },
  });
  assert.equal(busyCodexFastModeOff.status, 409, "Codex Fast mode changes should be rejected during a running turn");
  assert.match(String(busyCodexFastModeOff.body?.error || ""), /busy|running turn/i);
  let settledCodexFastMode;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    settledCodexFastMode = await request("127.0.0.1", `/api/codex-fast-mode?tab=${encodeURIComponent(tabId)}`);
    if (settledCodexFastMode.body?.data?.busy === false) break;
    await delay(150);
  }
  assert.equal(settledCodexFastMode?.body?.data?.busy, false, "fake running turn should settle before the retry");

  const codexFastModeOff = await request("127.0.0.1", "/api/codex-fast-mode", {
    method: "PUT",
    body: { enabled: false, tab: tabId },
  });
  assert.equal(codexFastModeOff.status, 200, `Codex Fast mode off should succeed after the tab settles: ${codexFastModeOff.body?.error || ""}`);
  assert.equal(codexFastModeOff.body?.data?.enabled, false);
  assert.equal(codexFastModeOff.body?.data?.statusKnown, true, "off response should be extension-confirmed");

  // Natural Conversation shell: /talk availability drives per-tab status and safety guards.
  const conversationFeature = await request("127.0.0.1", `/api/features/natural-conversation?tab=${encodeURIComponent(tabId)}`);
  assert.equal(conversationFeature.status, 200);
  assert.equal(conversationFeature.body?.data?.available, true, "fake /talk command should make Natural Conversation available");
  assert.ok(conversationFeature.body?.data?.commands?.includes("talk"), "Natural Conversation feature data should expose loaded /talk commands");
  assert.equal(conversationFeature.body?.data?.mode?.enabled, false, "Natural Conversation should start disabled per tab");

  const conversationVoices = await request("127.0.0.1", `/api/conversation-voices?tab=${encodeURIComponent(tabId)}`);
  assert.equal(conversationVoices.status, 200);
  assert.ok(Array.isArray(conversationVoices.body?.data?.voices), "conversation-voices should return a voices array");
  assert.ok(
    conversationVoices.body.data.voices.some((voice) => voice.id === "de_DE-thorsten-medium"),
    "conversation-voices should include the mirrored Piper catalog",
  );
  const badVoice = await request("127.0.0.1", "/api/conversation-voice", {
    method: "POST",
    body: { voice: "../etc/passwd; rm -rf", tab: tabId },
  });
  assert.equal(badVoice.status, 400, "conversation-voice must reject ids that are not plain voice names");

  const conversationOn = await request("127.0.0.1", "/api/conversation-mode", {
    method: "POST",
    body: { enabled: true, tab: tabId },
  });
  assert.equal(conversationOn.status, 200, `conversation-mode on should succeed: ${conversationOn.body?.error || ""}`);
  assert.equal(conversationOn.body?.data?.mode?.enabled, true, "conversation-mode on should update tab-local mode state");
  assert.equal(conversationOn.body?.tab?.conversationMode?.enabled, true, "conversation mode should be included in returned tab metadata");

  const conversationState = await request("127.0.0.1", `/api/state?tab=${encodeURIComponent(tabId)}`);
  assert.equal(conversationState.status, 200);
  assert.equal(conversationState.body?.data?.thinkingLevel, "off", "Natural Conversation shell should keep thinking forced off");

  const blockedSlash = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { message: "/copy", tab: tabId } });
  assert.equal(blockedSlash.status, 409, "non-/talk slash commands should be blocked while Natural Conversation is active");
  assert.match(String(blockedSlash.body?.error || ""), /Natural Conversation Mode is active; slash commands are blocked/);

  const blockedSettings = await request("127.0.0.1", "/api/settings", { method: "POST", body: { thinkingLevel: "high", tab: tabId } });
  assert.equal(blockedSettings.status, 409, "settings changes should be blocked while Natural Conversation is active");
  assert.match(String(blockedSettings.body?.error || ""), /settings changes are blocked/);

  const blockedWorkflowPolicySave = await request("127.0.0.1", "/api/workflow-policy", {
    method: "POST",
    body: { policy: workflowPolicyToSave, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
  });
  assert.equal(blockedWorkflowPolicySave.status, 409, "workflow policy changes should be blocked while Natural Conversation is active");
  assert.match(String(blockedWorkflowPolicySave.body?.error || ""), /workflow policy changes are blocked/);

  const blockedBash = await request("127.0.0.1", "/api/bash", { method: "POST", body: { command: "echo blocked", tab: tabId } });
  assert.equal(blockedBash.status, 409, "user bash should be blocked while Natural Conversation is active");
  assert.match(String(blockedBash.body?.error || ""), /bash is blocked|Natural Conversation Mode is active/);

  const blockedFileSave = await request("127.0.0.1", "/api/files/content", { method: "POST", body: { tab: tabId, path: viewerRelative, content: "blocked by conversation mode\n" } });
  assert.equal(blockedFileSave.status, 409, "file edits should be blocked while Natural Conversation is active");
  assert.equal(blockedFileSave.body?.error, "file edits are blocked");

  const blockedFileDelete = await request("127.0.0.1", "/api/files", { method: "DELETE", body: { tab: tabId, path: viewerRelative, confirmed: true } });
  assert.equal(blockedFileDelete.status, 409, "file deletes should be blocked while Natural Conversation is active");
  assert.match(String(blockedFileDelete.body?.error || ""), /file deletion is blocked/i);

  const blockedFileMove = await request("127.0.0.1", "/api/files/move", { method: "POST", body: { tab: tabId, path: viewerRelative, toPath: "files-fixture/blocked-move.txt", confirmed: true } });
  assert.equal(blockedFileMove.status, 409, "file moves should be blocked while Natural Conversation is active");
  assert.match(String(blockedFileMove.body?.error || ""), /file moves are blocked/i);

  const allowedConversationPrompt = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { message: "Explain the current repo briefly", tab: tabId } });
  assert.equal(allowedConversationPrompt.status, 200, "ordinary prompts remain allowed while Natural Conversation is active");

  const localStt = await request("127.0.0.1", "/api/stt/transcribe", { method: "POST", body: { tab: tabId, provider: "local", mimeType: "audio/webm", audioBase64: Buffer.from("fake audio").toString("base64") } });
  assert.equal(localStt.status, 200, `local STT fallback should transcribe through the configured endpoint: ${localStt.body?.error || ""}`);
  assert.equal(localStt.body?.data?.provider, "local");
  assert.equal(localStt.body?.data?.text, "fake transcript from local stt");
  assert.ok(voiceProviderRequests.some((item) => item.url === "/stt" && /multipart\/form-data/.test(String(item.contentType || ""))), "local STT should receive a multipart audio upload");

  const localTts = await request("127.0.0.1", "/api/tts/speech", { method: "POST", body: { tab: tabId, provider: "local", text: "Say this aloud" } });
  assert.equal(localTts.status, 200, `local TTS fallback should synthesize through the configured endpoint: ${localTts.body?.error || ""}`);
  assert.equal(localTts.body?.data?.provider, "local");
  assert.equal(localTts.body?.data?.contentType, "audio/mpeg");
  assert.equal(Buffer.from(localTts.body?.data?.audioBase64 || "", "base64").toString("utf8"), "fake mp3 bytes");
  assert.ok(voiceProviderRequests.some((item) => item.url === "/tts" && /application\/json/.test(String(item.contentType || ""))), "local TTS should receive a JSON text synthesis request");

  const conversationOff = await request("127.0.0.1", "/api/conversation-mode", {
    method: "POST",
    body: { enabled: false, tab: tabId },
  });
  assert.equal(conversationOff.status, 200, `conversation-mode off should succeed: ${conversationOff.body?.error || ""}`);
  assert.equal(conversationOff.body?.data?.mode?.enabled, false, "conversation-mode off should restore normal WebUI actions");

  // Bash FIFO queue: concurrent requests must execute serially on the RPC.
  const [bashA, bashB] = await Promise.all([
    request("127.0.0.1", "/api/bash", { method: "POST", body: { command: "echo a", tab: tabId }, timeoutMs: 10_000 }),
    request("127.0.0.1", "/api/bash", { method: "POST", body: { command: "echo b", tab: tabId }, timeoutMs: 10_000 }),
  ]);
  assert.equal(bashA.status, 200);
  assert.equal(bashB.status, 200);
  for (const result of [bashA, bashB]) {
    assert.equal(result.body?.data?.output, "peak:1", "bash queue must never run two commands concurrently");
  }

  // Session-dir confinement: traversal targets are rejected even from localhost.
  const traversalDelete = await request("127.0.0.1", "/api/session-delete", {
    method: "POST",
    body: { sessionPath: path.join(cwd, "outside.jsonl"), confirmed: true, tab: tabId },
  });
  assert.equal(traversalDelete.status, 403, "session delete outside the session dir must return 403");
  assert.match(String(traversalDelete.body?.error || ""), /session directory/i);

  const networkQr = await request("127.0.0.1", "/api/network/qr");
  assert.equal(networkQr.status, 200, "localhost can generate a /remote QR payload");
  assert.equal(networkQr.body?.ok, true);
  assert.match(String(networkQr.body?.data?.url || ""), /^http:\/\//, "remote QR payload should include a display URL");
  assert.ok(Array.isArray(networkQr.body?.data?.qrLines), "remote QR payload should include terminal QR lines");
  assert.equal(networkQr.body?.data?.network?.open, true, "remote QR payload should describe current network state");

  const initialAuth = await request("127.0.0.1", "/api/remote-auth");
  assert.equal(initialAuth.status, 200);
  assert.equal(initialAuth.body?.data?.auth?.enabled, false, "remote PIN auth should be off by default");

  const combinedUpdatePlan = await request("127.0.0.1", "/api/update/plan", {
    method: "POST", body: { targets: ["pi", "webui"] },
  });
  assert.equal(combinedUpdatePlan.status, 400, "a combined action must not reach native shell planning");
  const missingNativeJob = await request("127.0.0.1", "/api/update/apply", {
    method: "POST", body: { transactionId: "missing-fixture-job", planDigest: "a".repeat(64) },
  });
  assert.equal(missingNativeJob.status, 404, "native apply must require a server-owned confirmed job");
  const nativeRollback = await request("127.0.0.1", "/api/update/rollback", { method: "POST", body: {} });
  assert.equal(nativeRollback.status, 410, "native updates cannot claim managed-pointer rollback");

  const lan = lanAddress();
  if (lan) {
    const remoteHealthBeforeAuth = await request(lan, "/api/health");
    assert.equal(remoteHealthBeforeAuth.status, 200, "LAN clients should connect without a PIN while auth is off");

    const remoteWorkflowPolicyRead = await request(lan, "/api/workflow-policy");
    assert.equal(remoteWorkflowPolicyRead.status, 403, "workflow policy reads must be localhost-only");

    const remoteUpdatePlan = await request(lan, "/api/update/plan", { method: "POST", body: { targets: ["pi"] } });
    assert.equal(remoteUpdatePlan.status, 403, "update plans must be localhost-only before target resolution");
    const remoteUpdateApply = await request(lan, "/api/update/apply", { method: "POST", body: { transactionId: "remote", planDigest: "a".repeat(64) } });
    assert.equal(remoteUpdateApply.status, 403, "update apply must be localhost-only before native job lookup");
    const remoteUpdateTransaction = await request(lan, "/api/update/transactions/remote");
    assert.equal(remoteUpdateTransaction.status, 403, "update transaction receipts must be localhost-only");
    const remoteUpdateRollback = await request(lan, "/api/update/rollback", { method: "POST", body: { transactionId: "remote", planDigest: "a".repeat(64) } });
    assert.equal(remoteUpdateRollback.status, 403, "retired rollback must remain localhost-only before a 410 response");

    const remoteWorkflowPolicySave = await request(lan, "/api/workflow-policy", {
      method: "POST",
      body: { policy: workflowPolicyToSave, expectedRevision: savedWorkflowPolicy.body?.data?.revision },
    });
    assert.equal(remoteWorkflowPolicySave.status, 403, "workflow policy saves must be localhost-only before the request body is processed");

    const remoteSttWithoutConsent = await request(lan, "/api/stt/transcribe", {
      method: "POST",
      body: { tab: tabId, provider: "local", mimeType: "audio/webm", audioBase64: Buffer.from("fake remote audio").toString("base64") },
    });
    assert.equal(remoteSttWithoutConsent.status, 403, "remote STT uploads must require explicit microphone streaming consent");
    assert.match(String(remoteSttWithoutConsent.body?.error || ""), /explicit.*remote microphone streaming consent/i);

    const remoteSttWithConsent = await request(lan, "/api/stt/transcribe", {
      method: "POST",
      body: { tab: tabId, provider: "local", mimeType: "audio/webm", audioBase64: Buffer.from("fake remote audio").toString("base64"), remoteMicStreamingConsentAccepted: true },
    });
    assert.equal(remoteSttWithConsent.status, 200, "remote STT uploads should proceed after explicit per-request consent");
    assert.equal(remoteSttWithConsent.body?.data?.text, "fake transcript from local stt");

    const remoteDelete = await request(lan, "/api/session-delete", {
      method: "POST",
      body: { sessionPath: path.join(cwd, "outside.jsonl"), confirmed: true, tab: tabId },
    });
    assert.equal(remoteDelete.status, 403, "session delete must be localhost-only");

    const remoteFileSave = await request(lan, "/api/files/content", {
      method: "POST",
      body: { tab: tabId, path: viewerRelative, content: "remote save should be blocked\n" },
    });
    assert.equal(remoteFileSave.status, 403, "file saves must be localhost-only");

    const remoteLaunchSlotSave = await request(lan, "/api/subagents/config", {
      method: "POST",
      body: { tab: tabId, scope: "user", revision: "remote-request-must-not-read", roles: {} },
    });
    assert.equal(remoteLaunchSlotSave.status, 403, "launch-slot saves must be localhost-only before the request body is processed");

    const remoteSubagentCancel = await request(lan, "/api/subagents/cancel", {
      method: "POST",
      body: { tab: tabId, runId: "remote-request-must-not-dispatch" },
    });
    assert.equal(remoteSubagentCancel.status, 403, "subagent cancellation must be localhost-only before helper dispatch");
    const remoteSubagentDismiss = await request(lan, "/api/subagents/dismiss", {
      method: "POST",
      body: { tab: tabId, runId: "remote-request-must-not-dispatch" },
    });
    assert.equal(remoteSubagentDismiss.status, 403, "subagent dismissal must be localhost-only before helper dispatch");

    const remoteFileOpenDefault = await request(lan, "/api/files/open-default", {
      method: "POST",
      body: { tab: tabId, path: viewerRelative },
    });
    assert.equal(remoteFileOpenDefault.status, 403, "opening files in the default editor must be localhost-only");

    const remoteFileDelete = await request(lan, "/api/files", {
      method: "DELETE",
      body: { tab: tabId, path: viewerRelative, confirmed: true },
    });
    assert.equal(remoteFileDelete.status, 403, "file deletes must be localhost-only");

    const remoteFileMove = await request(lan, "/api/files/move", {
      method: "POST",
      body: { tab: tabId, path: viewerRelative, toPath: "files-fixture/remote-move.txt", confirmed: true },
    });
    assert.equal(remoteFileMove.status, 403, "file moves must be localhost-only");

    const remoteExport = await request(lan, "/api/prompt", {
      method: "POST",
      body: { message: "/export", tab: tabId },
    });
    assert.equal(remoteExport.status, 200, "guarded slash commands return blocked adapter cards, not raw HTTP errors");
    assert.equal(remoteExport.body?.data?.status, "blocked", "guards-driven dispatch must block /export for LAN clients");

    const remoteClose = await request(lan, "/api/network/close", { method: "POST" });
    assert.equal(remoteClose.status, 403, "network close must be localhost-only");

    const remoteQr = await request(lan, "/api/network/qr");
    assert.equal(remoteQr.status, 403, "remote QR generation must be localhost-only because it can embed the PIN");

    const remoteWorktreeRemove = await request(lan, "/api/git-worktrees", {
      method: "DELETE",
      body: { path: path.join(cwd, "irrelevant-worktree"), confirmed: true, tab: tabId },
    });
    assert.equal(remoteWorktreeRemove.status, 403, "worktree removal must be localhost-only");

    const enableAuth = await request("127.0.0.1", "/api/remote-auth/settings", { method: "POST", body: { enabled: true } });
    assert.equal(enableAuth.status, 200, "localhost can enable remote PIN auth");
    const pin = enableAuth.body?.data?.auth?.pin;
    assert.match(pin, /^\d{4}$/, "enabling remote auth should generate a 4-digit PIN");

    const remoteHealthWithAuth = await request(lan, "/api/health");
    assert.equal(remoteHealthWithAuth.status, 401, "unauthenticated LAN clients should be challenged while remote auth is on");

    const wrongPin = pin === "0000" ? "0001" : "0000";
    const badLogin = await request(lan, "/api/remote-auth", { method: "POST", body: { pin: wrongPin } });
    assert.equal(badLogin.status, 403, "wrong remote PIN should be rejected");

    const loginResponse = await fetch(`http://${lan}:${port}/api/remote-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(loginResponse.status, 200, "correct remote PIN should be accepted");
    const authCookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(authCookie, "remote auth login should set an auth cookie");

    const authedHealth = await fetch(`http://${lan}:${port}/api/health`, {
      headers: { cookie: authCookie },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(authedHealth.status, 200, "authenticated LAN client should reach guarded APIs");
    await authedHealth.json();

    const remoteSettings = await fetch(`http://${lan}:${port}/api/remote-auth/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authCookie },
      body: JSON.stringify({ enabled: false }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(remoteSettings.status, 403, "remote clients must not toggle remote PIN auth settings");
    await remoteSettings.json().catch(() => undefined);

    const disableAuth = await request("127.0.0.1", "/api/remote-auth/settings", { method: "POST", body: { enabled: false } });
    assert.equal(disableAuth.status, 200, "localhost can disable remote PIN auth");
    const remoteHealthAfterDisable = await request(lan, "/api/health");
    assert.equal(remoteHealthAfterDisable.status, 200, "LAN clients should reconnect without a PIN after auth is disabled");
  } else {
    const enableAuth = await request("127.0.0.1", "/api/remote-auth/settings", { method: "POST", body: { enabled: true } });
    assert.equal(enableAuth.status, 200, "localhost can enable remote PIN auth");
    assert.match(enableAuth.body?.data?.auth?.pin, /^\d{4}$/);
    const disableAuth = await request("127.0.0.1", "/api/remote-auth/settings", { method: "POST", body: { enabled: false } });
    assert.equal(disableAuth.status, 200, "localhost can disable remote PIN auth");
    console.log("http-endpoints-harness: no LAN address detected; skipping remote-client checks");
  }

  const recoveryTabsBefore = await request("127.0.0.1", "/api/tabs");
  const sourceTabId = recoveryTabsBefore.body?.data?.tabs?.[0]?.id;
  assert.ok(sourceTabId, "recovery endpoint test needs an active source tab");
  const recoveryBody = {
    prompt: "Inspect the Anthropic compatibility patch and run status/plan only.",
    cwd,
    model: { provider: "fake", id: "fake-model" },
    mode: "plan-only",
  };
  const unauthenticatedRecovery = await request("127.0.0.1", "/api/recovery/plan", { method: "POST", body: recoveryBody });
  assert.equal(unauthenticatedRecovery.status, 401, "recovery endpoint must reject missing bearer credentials");
  const wrongCredentialRecovery = await request("127.0.0.1", "/api/recovery/plan", {
    method: "POST",
    headers: { authorization: "Bearer wrong-recovery-token" },
    body: recoveryBody,
  });
  assert.equal(wrongCredentialRecovery.status, 401, "recovery endpoint must reject an incorrect bearer credential");
  const liveRecoverySupervisorState = await readSupervisorState(await supervisorPaths({ agentDir: workflowPolicyAgentDir, port }));
  assert.ok(liveRecoverySupervisorState?.token, "recovery endpoint test needs the active supervisor credential");
  const retainedChildRecoveryToken = deriveSupervisorRecoveryToken(liveRecoverySupervisorState.token);
  const invalidModeRecovery = await request("127.0.0.1", "/api/recovery/plan", {
    method: "POST",
    headers: { authorization: `Bearer ${retainedChildRecoveryToken}` },
    body: { ...recoveryBody, mode: "apply" },
  });
  assert.equal(invalidModeRecovery.status, 400, "recovery endpoint must accept the stable managed-child credential and plan-only mode exclusively");
  if (lan) {
    const remoteRecovery = await request(lan, "/api/recovery/plan", {
      method: "POST",
      headers: { authorization: `Bearer ${recoveryEndpointToken}` },
      body: recoveryBody,
    });
    assert.equal(remoteRecovery.status, 403, "even a credentialed LAN client must not open recovery plans");
  }
  const rejectedRecovery = await request("127.0.0.1", "/api/recovery/plan", {
    method: "POST",
    headers: { authorization: `Bearer ${recoveryEndpointToken}` },
    body: { ...recoveryBody, model: { provider: "fake", id: "missing-model" } },
  });
  assert.equal(rejectedRecovery.status, 409, "an unavailable recovery model should be rejected");
  const recoveryTabsAfterRejection = await request("127.0.0.1", "/api/tabs");
  assert.equal(recoveryTabsAfterRejection.body?.data?.tabs?.length, recoveryTabsBefore.body?.data?.tabs?.length, "failed recovery initialization must discard its temporary tab");
  const recoveryOpened = await waitForSseEvent(
    sourceTabId,
    (event) => event.type === "webui_recovery_opened",
    () => request("127.0.0.1", "/api/recovery/plan", {
      method: "POST",
      headers: { authorization: `Bearer ${recoveryEndpointToken}` },
      body: recoveryBody,
    }),
  );
  assert.equal(recoveryOpened.triggerResult.status, 201, `recovery endpoint should create a tab: ${recoveryOpened.triggerResult.body?.error || ""}`);
  assert.equal(recoveryOpened.triggerResult.body?.requestId, recoveryOpened.event.recoveryTabId);
  assert.equal(recoveryOpened.event.model?.provider, "fake");
  const recoveryTabs = await request("127.0.0.1", "/api/tabs");
  const recoveryTab = recoveryTabs.body?.data?.tabs?.find((tab) => tab.id === recoveryOpened.event.recoveryTabId);
  assert.equal(recoveryTab?.title, "Anthropic compatibility recovery");
  assert.equal(recoveryTab?.cwd, cwd);
  assert.equal(recoveryTab?.activity?.isWorking, true);
  const recoveryCommands = (await readFile(fakePiCommandLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(recoveryCommands.some((entry) => entry.direction === "startup" && entry.recoveryUrl === `http://127.0.0.1:${port}/api/recovery/plan` && entry.recoveryTokenConfigured), "Pi RPC children should receive the internal recovery URL and a credential");
  const recoveryModelIndex = recoveryCommands.findIndex((entry) => entry.direction === "command" && entry.type === "set_model" && entry.provider === "fake" && entry.modelId === "fake-model");
  const recoveryPromptIndex = recoveryCommands.findIndex((entry) => entry.direction === "command" && entry.type === "prompt" && entry.message === recoveryBody.prompt);
  assert.ok(recoveryModelIndex >= 0 && recoveryPromptIndex > recoveryModelIndex, "recovery should select the requested model before sending the plan-only prompt");

  const localClose = await request("127.0.0.1", "/api/network/close", { method: "POST" });
  assert.equal(localClose.status, 202, "network close from localhost should be accepted");

  const shutdownResponse = await request("127.0.0.1", "/api/shutdown", { method: "POST" });
  assert.equal(shutdownResponse.status, 200);

  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
    await delay(100);
  }
  assert.notEqual(child.exitCode, null, "server should exit after /api/shutdown");
  }
} finally {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await new Promise((resolve) => voiceProvider.close(() => resolve()));
  const testSupervisorPaths = await supervisorPaths({ agentDir: workflowPolicyAgentDir, port });
  const testSupervisorState = await readSupervisorState(testSupervisorPaths);
  if (testSupervisorState && supervisorPidIsAlive(testSupervisorState.pid)) {
    terminateProcessTree({
      pid: testSupervisorState.pid,
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        process.kill(testSupervisorState.pid, signal);
        return true;
      },
    }, "SIGKILL");
    for (let attempt = 0; attempt < 50 && supervisorPidIsAlive(testSupervisorState.pid); attempt++) await delay(100);
  }
  await rmWithRetry(cwd);
  await rmWithRetry(harnessSideEffectsRoot);
  await rmWithRetry(coordinationHome);
}

console.log("http-endpoints-harness.test.mjs passed");
