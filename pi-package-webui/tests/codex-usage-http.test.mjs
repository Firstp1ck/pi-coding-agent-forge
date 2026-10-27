import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "../lib/process-tree.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "pi-webui-codex-usage-http-"));
const children = [];
const legacyRequests = [];
const legacy = createServer((req, res) => {
  legacyRequests.push(req.headers.authorization);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000 } }, accountId: "fixture-private-account", accessToken: "fixture-private-token" }));
});
await new Promise((resolve) => legacy.listen(0, "127.0.0.1", resolve));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(port, pathname, method = "GET") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

async function start(name, codex, credentials = {}) {
  const agentDir = path.join(root, name, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(credentials));
  const log = path.join(root, name, "codex.jsonl");
  const port = await freePort();
  // Omit --cwd so this harness needs no Pi child or model turn.
  const child = spawn(process.execPath, [path.join(packageRoot, "bin", "pi-webui.mjs"), "--host", "127.0.0.1", "--port", String(port), "--pi", path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs")], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEBUI_SETTINGS_FILE: path.join(root, name, "settings.json"),
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_WEBUI_UPDATE_TEST_HOME: path.join(root, "coordination"),
      PI_WEBUI_CODEX_BIN: codex,
      PI_WEBUI_CODEX_USAGE_URL: `http://127.0.0.1:${legacy.address().port}/usage`,
      FAKE_CODEX_MODE: "success",
      FAKE_CODEX_LOG: log,
    },
  });
  children.push(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65536); });
  let ready = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try { if ((await request(port, "/api/health")).status === 200) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `isolated WebUI should start\n${output}`);
  return { child, port, log };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  try { await request(server.port, "/api/shutdown", "POST"); } catch {}
  for (let attempt = 0; attempt < 100 && server.child.exitCode === null; attempt++) await delay(50);
  terminateProcessTree(server.child, "SIGKILL");
}

async function launches(log) {
  return (await readFile(log, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter((entry) => entry.kind === "start");
}

try {
  const cli = await start("cli", path.join(packageRoot, "tests", "fixtures", "fake-codex-app-server.mjs"));
  const [first, simultaneous] = await Promise.all([request(cli.port, "/api/codex-usage"), request(cli.port, "/api/codex-usage")]);
  assert.equal(first.status, 200);
  assert.equal(simultaneous.status, 200);
  assert.equal(first.body.data.source, "codex-cli");
  assert.equal(first.body.data.selected.primary.usedPercent, 25);
  assert.equal(first.body.data.selected.secondary.usedPercent, 42);
  assert.doesNotMatch(JSON.stringify(first.body), /private-|fixture-.*secret|email|accessToken|accountId/);
  assert.equal((await launches(cli.log)).length, 1, "concurrent HTTP requests must share one CLI process");
  await request(cli.port, "/api/codex-usage");
  assert.equal((await launches(cli.log)).length, 1, "normal reads use the successful cache");
  assert.equal((await request(cli.port, "/api/codex-usage?refresh=1")).status, 200);
  assert.equal((await launches(cli.log)).length, 2, "explicit refresh bypasses the completed cache");
  assert.equal(legacyRequests.length, 0, "CLI success must not touch the legacy endpoint");
  await stop(cli);

  const credential = { type: "oauth", access: "fixture-legacy-access", refresh: "fixture-legacy-refresh", expires: Date.now() + 60 * 60 * 1000, accountId: "fixture-legacy-account" };
  const fallback = await start("fallback", path.join(root, "missing-codex.exe"), { "openai-codex": credential });
  const legacyResult = await request(fallback.port, "/api/codex-usage");
  assert.equal(legacyResult.status, 200);
  assert.equal(legacyResult.body.data.source, "chatgpt.com");
  assert.equal(legacyResult.body.data.selected.primary.usedPercent, 8);
  assert.match(legacyResult.body.data.sourceNotice, /legacy Codex login/);
  assert.deepEqual(legacyRequests, ["Bearer fixture-legacy-access"]);
  assert.doesNotMatch(JSON.stringify(legacyResult.body), /fixture-legacy|fixture-private/);
  await stop(fallback);

  const unavailable = await start("unavailable", path.join(root, "missing-codex.exe"));
  const error = await request(unavailable.port, "/api/codex-usage");
  assert.equal(error.status, 503);
  assert.match(error.body.error, /Codex CLI was not found/);
  assert.match(error.body.error, /legacy Codex usage fallback/);
  assert.doesNotMatch(error.body.error, /stack|fixture-|auth\.json|AppData/);
  await stop(unavailable);
  console.log("codex-usage-http.test.mjs passed");
} finally {
  for (const child of children) terminateProcessTree(child, "SIGKILL");
  await new Promise((resolve) => legacy.close(resolve));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (attempt === 19 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error; await delay(100); }
  }
}
