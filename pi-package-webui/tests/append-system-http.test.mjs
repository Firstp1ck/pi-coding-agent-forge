import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { terminateProcessTree } from "../lib/process-tree.mjs";
import { discoverStartAttachRpcSupervisor } from "../lib/rpc-supervisor-client.mjs";
import { readSupervisorState, supervisorPaths } from "../lib/rpc-supervisor-state.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.join(packageRoot, "bin", "pi-webui.mjs");
const fakePiFixture = path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs");
const serverSource = await readFile(serverScript, "utf8");
const rpcTransportSource = await readFile(new URL("../lib/server/rpc-transports.mjs", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker, source = serverSource) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} should remain extractable for lifecycle regression coverage`);
  return source.slice(start, end);
}

async function assertDirectProcessLifecycle() {
  const children = [];
  const PiRpcProcess = vm.runInNewContext(`
    ${sourceBetween("  class PiRpcProcess {", "\n\n  return { PiRpcProcess, SupervisorPiRpcProcess };", rpcTransportSource)}
    PiRpcProcess;
  `, {
    Buffer,
    StringDecoder,
    clearTimeout,
    console,
    mirrorPiStderr: () => {},
    PI_RPC_JSONL_LINE_MAX_BYTES: 1024,
    process: { env: {} },
    randomUUID: () => "rpc-id",
    requestTimeoutMs: 1000,
    sanitizeError: (error) => error?.message || String(error),
    setTimeout,
    spawn: () => children.shift(),
  });
  const fakeChild = (pid) => Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    pid,
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
  });

  const successfulChild = fakeChild(4321);
  children.push(successfulChild);
  const successfulRpc = new PiRpcProcess({ command: "pi", args: ["--mode", "rpc"], displayCommand: "pi --mode rpc", cwd: "/workspace" });
  const successfulEvents = [];
  successfulRpc.onEvent((event) => successfulEvents.push(event));
  const successfulStart = successfulRpc.start();
  assert.deepEqual(successfulEvents, [], "a direct process must not publish pi_process_start before the child spawn event");
  successfulChild.emit("spawn");
  await successfulStart;
  assert.deepEqual(successfulEvents.map((event) => event.type), ["pi_process_start"], "a successful direct spawn must publish exactly one start event");
  assert.equal(successfulEvents[0].pid, 4321, "the start event must carry the child pid available at spawn time");

  const failedChild = fakeChild(undefined);
  children.push(failedChild);
  const failedRpc = new PiRpcProcess({ command: "missing-pi", args: [], displayCommand: "missing-pi", cwd: "/workspace" });
  const failedEvents = [];
  failedRpc.onEvent((event) => failedEvents.push(event));
  const failedStart = failedRpc.start();
  assert.deepEqual(failedEvents, [], "a failed direct launch must not report a synchronous start");
  failedChild.emit("error", new Error("spawn missing-pi ENOENT"));
  await assert.rejects(failedStart, /ENOENT/);
  assert.deepEqual(failedEvents.map((event) => event.type), ["pi_process_error"], "a failed spawn must report an error without any start event");
}

await assertDirectProcessLifecycle();

const cwdUpdateSource = sourceBetween("async function performTabCwdUpdate(tab, cwd) {", "\nasync function restartTabRpc(");
const directSpawnSuccess = cwdUpdateSource.indexOf("await rpc.start()");
for (const publication of ["tab.cwd = nextCwd", "resetTabActivity(tab)", "workspaceFilesLiveWatcher.unsubscribe(tab.id)"]) {
  assert.ok(directSpawnSuccess >= 0 && cwdUpdateSource.indexOf(publication) > directSpawnSuccess, `${publication} must remain delayed until a direct replacement spawn succeeds`);
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const selected = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return selected;
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-append-system-http-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const otherCwd = path.join(root, "other-project");
const replacementCwd = path.join(root, "replacement-project");
const failedReplacementCwd = path.join(root, "failed-replacement-project");
const settingsFile = path.join(root, "settings.json");
const launchLog = path.join(root, "pi-launches.jsonl");
const fakePi = path.join(root, process.platform === "win32" ? "fake-pi.mjs" : "fake-pi");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let supervisorSeed;
let output = "";

async function request(host, pathname, { method = "GET", body, headers = {}, rawBody } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-type")) {
    requestHeaders["content-type"] = "application/json";
  }
  const requestBody = rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody;
  if (Object.keys(requestHeaders).some((name) => name.toLowerCase() === "host")) {
    return new Promise((resolve, reject) => {
      const pending = httpRequest({ host, port, path: pathname, method, headers: requestHeaders }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: new Headers(response.headers) });
          } catch (error) {
            reject(error);
          }
        });
      });
      pending.setTimeout(8_000, () => pending.destroy(new Error("HTTP request timed out")));
      pending.once("error", reject);
      pending.end(requestBody);
    });
  }
  const response = await fetch(`http://${host}:${port}${pathname}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
    signal: AbortSignal.timeout(8_000),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function launches() {
  const text = await readFile(launchLog, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function withDirectSpawnFailure(run) {
  const unavailableFakePi = `${fakePi}.unavailable`;
  await rename(fakePi, unavailableFakePi);
  try {
    return await run();
  } finally {
    await rename(unavailableFakePi, fakePi);
  }
}

try {
  const externalPiRoot = path.join(root, "external-pi-root");
  const externalDirectoryTarget = path.join(root, "external-directory-target");
  const externalFileTarget = path.join(root, "external-file-target", "prompt.txt");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(path.join(externalPiRoot, "global"), { recursive: true }),
    mkdir(path.join(externalPiRoot, "agent", "minimal"), { recursive: true }),
    mkdir(externalDirectoryTarget, { recursive: true }),
    mkdir(path.dirname(externalFileTarget), { recursive: true }),
    mkdir(path.join(cwd, ".pi"), { recursive: true }),
    mkdir(path.join(cwd, "zz-saved"), { recursive: true }),
    mkdir(path.join(cwd, "linked-file"), { recursive: true }),
    mkdir(otherCwd, { recursive: true }),
    mkdir(replacementCwd, { recursive: true }),
    mkdir(failedReplacementCwd, { recursive: true }),
  ]);

  const unsupportedSymlinkCodes = new Set(["EPERM", "EACCES", "EINVAL", "ENOTSUP"]);
  let rootSymlinkAvailable = true;
  try {
    await symlink(externalPiRoot, path.join(home, ".pi"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    rootSymlinkAvailable = false;
    if (!unsupportedSymlinkCodes.has(error?.code)) throw error;
    await mkdir(path.join(home, ".pi", "global"), { recursive: true });
    await mkdir(path.join(home, ".pi", "agent", "minimal"), { recursive: true });
  }
  const piStorageRoot = rootSymlinkAvailable ? externalPiRoot : path.join(home, ".pi");
  const globalDefaultCandidate = path.join(home, ".pi", "agent", "APPEND_SYSTEM.md");
  const globalCandidate = path.join(home, ".pi", "global", "APPEND_SYSTEM.md");
  const nestedGlobalCandidate = path.join(home, ".pi", "agent", "minimal", "APPEND_SYSTEM.md");
  const projectDefaultCandidate = path.join(cwd, ".pi", "APPEND_SYSTEM.md");
  const projectCandidate = path.join(cwd, "zz-saved", "APPEND_SYSTEM.md");
  const directoryAlias = path.join(cwd, "linked-directory");
  const directoryAliasCandidate = path.join(directoryAlias, "APPEND_SYSTEM.md");
  const fileAliasCandidate = path.join(cwd, "linked-file", "APPEND_SYSTEM.md");
  const outsideCandidate = path.join(root, "outside", "APPEND_SYSTEM.md");
  await mkdir(path.dirname(outsideCandidate), { recursive: true });
  await Promise.all([
    writeFile(path.join(piStorageRoot, "agent", "APPEND_SYSTEM.md"), "Pi global default must not be duplicated\n", "utf8"),
    writeFile(path.join(piStorageRoot, "global", "APPEND_SYSTEM.md"), "global prompt contents must remain private\n", "utf8"),
    writeFile(path.join(piStorageRoot, "agent", "minimal", "APPEND_SYSTEM.md"), "nested global prompt contents must remain private\n", "utf8"),
    writeFile(path.join(externalDirectoryTarget, "APPEND_SYSTEM.md"), "external directory prompt\n", "utf8"),
    writeFile(externalFileTarget, "external file prompt\n", "utf8"),
    writeFile(projectDefaultCandidate, "project-local default must remain selectable\n", "utf8"),
    writeFile(projectCandidate, "project prompt contents must remain private\n", "utf8"),
    writeFile(outsideCandidate, "outside prompt\n", "utf8"),
    ...(process.platform === "win32" ? [] : ["\n", "\r", "\t", "\u007f"].map(async (control) => {
      const unsafeCandidate = path.join(cwd, `unsafe${control}`, "APPEND_SYSTEM.md");
      await mkdir(path.dirname(unsafeCandidate), { recursive: true });
      await writeFile(unsafeCandidate, "control-character candidate contents must remain private\n", "utf8");
    })),
    writeFile(settingsFile, `${JSON.stringify({
      version: 8,
      remoteAuthEnabled: false,
      retainedFixture: { value: 7 },
      appendSystemPromptPath: globalDefaultCandidate,
      appendSystemPromptRootPath: path.join(home, ".pi"),
    })}\n`, "utf8"),
  ]);

  let directorySymlinkAvailable = true;
  try {
    await symlink(externalDirectoryTarget, directoryAlias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    directorySymlinkAvailable = false;
    if (!unsupportedSymlinkCodes.has(error?.code)) throw error;
  }
  let fileSymlinkAvailable = true;
  try {
    await symlink(externalFileTarget, fileAliasCandidate, "file");
  } catch (error) {
    fileSymlinkAvailable = false;
    if (!unsupportedSymlinkCodes.has(error?.code)) throw error;
  }
  const selectedCandidate = fileSymlinkAvailable ? fileAliasCandidate : projectCandidate;
  await writeFile(fakePi, `#!/usr/bin/env node\nimport { appendFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("0.84.0"); process.exit(0); }\nawait appendFile(process.env.APPEND_SYSTEM_LAUNCH_LOG, JSON.stringify(args) + "\\n", "utf8");\nawait import(${JSON.stringify(pathToFileURL(fakePiFixture).href)});\n`, "utf8");
  await chmod(fakePi, 0o755);

  child = spawn(process.execPath, [
    serverScript,
    "--cwd", cwd,
    "--host", "0.0.0.0",
    "--port", String(port),
    "--pi", fakePi,
    "--",
    "--append-system-prompt", "explicit-launcher-override",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
      PI_WEBUI_SETTINGS_FILE: settingsFile,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      APPEND_SYSTEM_LAUNCH_LOG: launchLog,
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });

  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (health.status === 200) break;
    } catch {
    }
    await delay(100);
  }
  assert.equal(health?.status, 200, `server should become healthy\n${output}`);

  const tabsResponse = await request("127.0.0.1", "/api/tabs");
  const initialTab = tabsResponse.body?.data?.tabs?.[0];
  const tabId = initialTab?.id;
  assert.ok(tabId);
  assert.equal(initialTab.prompt, null, "Pi default discovery must expose no tab-local override");
  assert.equal(JSON.stringify(initialTab.prompt).includes("explicit-launcher-override"), false, "arbitrary launcher prompt values must not be inferred into prompt metadata");
  const route = `/api/append-system-files?tab=${encodeURIComponent(tabId)}`;
  const discovered = await request("127.0.0.1", route);
  assert.equal(discovered.status, 200, discovered.body?.error);
  assert.equal(discovered.headers.get("cache-control"), "private, no-store");
  assert.equal(discovered.body?.data?.appendSystemPromptPath, null, "a persisted exact global default must be represented as Pi default discovery");
  assert.deepEqual(discovered.body?.data?.roots?.map(({ label }) => label), ["Pi home", "Current folder"]);
  const expectedCandidates = [globalCandidate, nestedGlobalCandidate, projectDefaultCandidate, projectCandidate];
  if (directorySymlinkAvailable) expectedCandidates.push(directoryAliasCandidate);
  if (fileSymlinkAvailable) expectedCandidates.push(fileAliasCandidate);
  assert.deepEqual(discovered.body?.data?.candidates?.map(({ path: candidatePath }) => candidatePath), expectedCandidates.sort());
  assert.equal(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => /[\u0000-\u001f\u007f]/.test(candidatePath)), false, "control-character candidates must be omitted from API discovery");
  assert.equal(JSON.stringify(discovered.body).includes("control-character candidate contents must remain private"), false, "omitted control-character candidates must not expose contents");
  assert.equal(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === globalDefaultCandidate), false, "the exact global Pi default must not be rendered as a duplicate candidate");
  assert.ok(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === nestedGlobalCandidate), "a nested global alternative must remain visible");
  assert.ok(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === projectDefaultCandidate), "a project-local default must remain visible");
  if (rootSymlinkAvailable) assert.ok(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === nestedGlobalCandidate), "a symlinked ~/.pi root must preserve its visible alias candidate");
  if (directorySymlinkAvailable) assert.ok(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === directoryAliasCandidate), "an external directory link must expose its visible candidate path");
  if (fileSymlinkAvailable) assert.ok(discovered.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === fileAliasCandidate), "an exact-name file link to a differently named external file must expose its visible alias");
  assert.equal(JSON.stringify(discovered.body).includes("prompt contents"), false, "HTTP discovery must not expose file contents");
  assert.equal((await request("127.0.0.1", route, { headers: { "sec-fetch-site": "same-origin" } })).status, 200, "same-origin GET discovery must remain accepted");
  assert.equal((await request("127.0.0.1", route, { headers: { host: "attacker.example", "sec-fetch-site": "same-origin" } })).status, 403, "same-origin metadata must not bypass the loopback Host guard");
  for (const hostAuthority of [`localhost:${port}`, `127.42.0.1:${port}`, `[::1]:${port}`]) {
    assert.equal((await request("127.0.0.1", route, { headers: { host: hostAuthority, "sec-fetch-site": "same-origin" } })).status, 200, `loopback Host ${hostAuthority} must remain accepted`);
  }
  assert.equal((await request("127.0.0.1", route, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "cross-site GET discovery must be blocked");

  const remoteHost = lanAddress();
  if (remoteHost) assert.equal((await request(remoteHost, route)).status, 403, "GET discovery must be localhost-only");

  const selectionRoute = "/api/append-system-selection";
  const crossSitePost = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
    body: { tabId, path: projectCandidate },
  });
  assert.equal(crossSitePost.status, 403, "cross-site POST selection must be blocked");
  const reboundPost = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    headers: { host: `attacker.example:${port}`, "sec-fetch-site": "same-origin" },
    body: { tabId, path: projectCandidate },
  });
  assert.equal(reboundPost.status, 403, "same-origin POST metadata must not bypass the loopback Host guard");
  const textPost = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    rawBody: JSON.stringify({ tabId, path: projectCandidate }),
  });
  assert.equal(textPost.status, 415, "text/plain POST selection must be rejected before parsing");
  const malformedPost = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    headers: { "content-type": "application/json" },
    rawBody: "{not valid JSON",
  });
  assert.equal(malformedPost.status, 400, "malformed JSON must return a controlled client error");
  for (const nonObjectBody of [null, [], "selection", 42, true, false]) {
    const rejected = await request("127.0.0.1", selectionRoute, { method: "POST", body: nonObjectBody });
    assert.equal(rejected.status, 400, `non-object body ${JSON.stringify(nonObjectBody)} must be rejected`);
  }
  assert.equal((await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: projectCandidate, unsupported: true } })).status, 400, "unsupported POST fields must be rejected");
  assert.equal((await request("127.0.0.1", selectionRoute, { method: "POST", body: { path: projectCandidate } })).status, 400, "tabId is required by the POST contract");

  for (const invalidPath of [outsideCandidate, path.join(cwd, "missing", "APPEND_SYSTEM.md")]) {
    const rejected = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: invalidPath } });
    assert.equal(rejected.status, 400, `fresh validation must reject ${invalidPath}`);
  }
  for (const control of ["\n", "\r", "\t", "\u007f", "\0"]) {
    const unsafePath = `${cwd}${path.sep}unsafe${control}${path.sep}APPEND_SYSTEM.md`;
    const rejected = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: unsafePath } });
    assert.equal(rejected.status, 400, `selection API must reject control character ${JSON.stringify(control)}`);
  }
  assert.equal((await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: 42 } })).status, 400);
  if (remoteHost) {
    assert.equal((await request(remoteHost, "/api/append-system-selection", { method: "POST", body: { tabId, path: projectCandidate } })).status, 403, "POST selection must be localhost-only");
  }

  let latestArgs = (await launches()).at(-1);
  assert.equal(latestArgs.includes(globalDefaultCandidate), false, "a persisted exact global default must not become a redundant launcher override");
  assert.equal(latestArgs.filter((arg) => arg === "--append-system-prompt").length, 1, "only the explicit launcher override should remain for Pi default discovery");

  const normalizedDefault = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    body: { tabId, path: globalDefaultCandidate },
  });
  assert.equal(normalizedDefault.status, 200, normalizedDefault.body?.error);
  assert.deepEqual({
    path: normalizedDefault.body?.data?.appendSystemPromptPath,
    changed: normalizedDefault.body?.data?.changed,
    restartRequired: normalizedDefault.body?.data?.restartRequired,
  }, { path: null, changed: true, restartRequired: true }, "submitting the exact global default must clear the redundant saved override");
  const persistedAfterDefaultNormalization = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persistedAfterDefaultNormalization.appendSystemPromptPath, null);
  assert.equal(persistedAfterDefaultNormalization.appendSystemPromptRootPath, null);

  if (rootSymlinkAvailable) {
    const rootAliasSaved = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: nestedGlobalCandidate } });
    assert.equal(rootAliasSaved.status, 200, rootAliasSaved.body?.error);
    const persistedRootAlias = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(persistedRootAlias.appendSystemPromptPath, nestedGlobalCandidate);
    assert.equal(persistedRootAlias.appendSystemPromptRootPath, path.join(home, ".pi"));
    const rootAliasTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: otherCwd, title: "symlinked root selection" } });
    assert.equal(rootAliasTab.status, 201, rootAliasTab.body?.error);
    assert.ok((await launches()).at(-1).includes(nestedGlobalCandidate), "persisted launch validation must pass the visible alias below a symlinked root");
  }
  if (directorySymlinkAvailable) {
    const directoryAliasSaved = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId, path: directoryAliasCandidate } });
    assert.equal(directoryAliasSaved.status, 200, directoryAliasSaved.body?.error);
    const persistedDirectoryAlias = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(persistedDirectoryAlias.appendSystemPromptPath, directoryAliasCandidate);
    assert.equal(persistedDirectoryAlias.appendSystemPromptRootPath, cwd);
    const directoryAliasTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: otherCwd, title: "external directory alias selection" } });
    assert.equal(directoryAliasTab.status, 201, directoryAliasTab.body?.error);
    assert.ok((await launches()).at(-1).includes(directoryAliasCandidate), "persisted launch validation must pass an external directory's visible alias");
  }

  const launchCountBeforeSave = (await launches()).length;
  const saved = await request("127.0.0.1", selectionRoute, {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: { tabId, path: selectedCandidate },
  });
  assert.equal(saved.status, 200, saved.body?.error);
  assert.equal(saved.body?.data?.appendSystemPromptPath, selectedCandidate);
  assert.equal(saved.body?.data?.changed, true);
  assert.equal(saved.body?.data?.restartRequired, true);
  await delay(150);
  assert.equal((await launches()).length, launchCountBeforeSave, "saving must not automatically restart the active tab");
  const persistedAfterSave = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persistedAfterSave.appendSystemPromptPath, selectedCandidate);
  assert.equal(persistedAfterSave.appendSystemPromptRootPath, cwd);
  assert.deepEqual(persistedAfterSave.retainedFixture, { value: 7 }, "selection writes must preserve existing settings fields");
  const unchangedInitialTab = (await request("127.0.0.1", "/api/tabs")).body?.data?.tabs?.find((tab) => tab.id === tabId);
  assert.equal(unchangedInitialTab?.prompt, null, "saving a global choice must not rewrite an already-running tab's runtime metadata");

  const sameSelection = await request("127.0.0.1", "/api/append-system-selection", { method: "POST", body: { tabId, path: selectedCandidate } });
  assert.deepEqual({ changed: sameSelection.body?.data?.changed, restartRequired: sameSelection.body?.data?.restartRequired }, { changed: false, restartRequired: false });

  await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const competitor = path.join(cwd, `candidate-${String(index).padStart(3, "0")}`, "APPEND_SYSTEM.md");
    await mkdir(path.dirname(competitor), { recursive: true });
    await writeFile(competitor, `competitor ${index}\n`, "utf8");
  }));
  const crowdedDiscovery = await request("127.0.0.1", route);
  assert.equal(crowdedDiscovery.body?.data?.limits?.truncated?.candidates, true, "the fixture must exceed fresh candidate discovery limits");
  assert.equal(crowdedDiscovery.body?.data?.candidates?.length, 256, "the hidden global default must not consume a returned candidate slot");
  assert.ok(crowdedDiscovery.body?.data?.candidates?.some(({ path: candidatePath }) => candidatePath === selectedCandidate), "the valid saved selection must remain visible despite candidate-cap crowd-out");

  const selectedTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: otherCwd, title: "selected prompt in another project" } });
  assert.equal(selectedTab.status, 201, selectedTab.body?.error);
  const otherTabId = selectedTab.body?.data?.tab?.id;
  assert.ok(otherTabId);
  assert.deepEqual(selectedTab.body?.data?.tab?.prompt, { kind: "append-system", path: selectedCandidate }, "a selected launch must expose only its bounded tab-local descriptor");
  assert.equal(JSON.stringify(selectedTab.body?.data?.tab?.prompt).includes("prompt contents must remain private"), false, "tab prompt metadata must not expose prompt contents");
  latestArgs = (await launches()).at(-1);
  const selectedIndex = latestArgs.indexOf(selectedCandidate);
  const explicitPromptIndex = latestArgs.indexOf("explicit-launcher-override");
  assert.ok(selectedIndex > 0 && latestArgs[selectedIndex - 1] === "--append-system-prompt");
  assert.ok(explicitPromptIndex > selectedIndex && latestArgs[explicitPromptIndex - 1] === "--append-system-prompt", "saved and launcher append prompts must both be passed in argument order");

  const otherRoute = `/api/append-system-files?tab=${encodeURIComponent(otherTabId)}`;
  const otherProjectDiscovery = await request("127.0.0.1", otherRoute);
  assert.ok(otherProjectDiscovery.body?.data?.candidates?.some((candidate) => candidate.path === selectedCandidate && candidate.rootLabel === "Saved selection"), "a provenance-valid global selection must remain visible outside its source project");
  const otherProjectNoOp = await request("127.0.0.1", "/api/append-system-selection", { method: "POST", body: { tabId: otherTabId, path: selectedCandidate } });
  assert.deepEqual({ changed: otherProjectNoOp.body?.data?.changed, restartRequired: otherProjectNoOp.body?.data?.restartRequired }, { changed: false, restartRequired: false });

  const defaultSavedForReload = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId: otherTabId, path: null } });
  assert.equal(defaultSavedForReload.status, 200, defaultSavedForReload.body?.error);
  const beforeReload = (await request("127.0.0.1", "/api/tabs")).body?.data?.tabs?.find((tab) => tab.id === otherTabId);
  assert.deepEqual(beforeReload?.prompt, { kind: "append-system", path: selectedCandidate }, "a settings change must leave the running tab's descriptor unchanged until replacement succeeds");
  const reloadedDefault = await request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: otherTabId, message: "/reload" } });
  assert.equal(reloadedDefault.status, 200, reloadedDefault.body?.error);
  assert.equal(reloadedDefault.body?.tab?.prompt, null, "a successful reload must replace the tab descriptor with the prompt used by the new process");

  await writeFile(settingsFile, `${JSON.stringify(persistedAfterSave)}\n`, "utf8");
  const cwdReplacement = await request("127.0.0.1", `/api/tabs/${encodeURIComponent(otherTabId)}`, { method: "PATCH", body: { cwd: replacementCwd } });
  assert.equal(cwdReplacement.status, 200, cwdReplacement.body?.error);
  assert.equal(cwdReplacement.body?.data?.changed, true);
  assert.equal(cwdReplacement.body?.data?.tab?.cwd, replacementCwd);
  assert.deepEqual(cwdReplacement.body?.data?.tab?.prompt, { kind: "append-system", path: selectedCandidate }, "a successful direct cwd replacement must publish the replacement descriptor");

  if (process.platform !== "win32") {
    const defaultBeforeFailedReload = await request("127.0.0.1", selectionRoute, { method: "POST", body: { tabId: otherTabId, path: null } });
    assert.equal(defaultBeforeFailedReload.status, 200, defaultBeforeFailedReload.body?.error);
    const failedReload = await withDirectSpawnFailure(() => request("127.0.0.1", "/api/prompt", { method: "POST", body: { tab: otherTabId, message: "/reload" } }));
    assert.equal(failedReload.status, 500, "a direct reload whose child cannot spawn must fail the request");
    assert.deepEqual(
      (await request("127.0.0.1", "/api/tabs")).body?.data?.tabs?.find((tab) => tab.id === otherTabId)?.prompt,
      { kind: "append-system", path: selectedCandidate },
      "a failed direct reload must retain the old prompt descriptor",
    );

    await writeFile(settingsFile, `${JSON.stringify(persistedAfterSave)}\n`, "utf8");
    const failedCwdReplacement = await withDirectSpawnFailure(() => request("127.0.0.1", `/api/tabs/${encodeURIComponent(tabId)}`, { method: "PATCH", body: { cwd: failedReplacementCwd } }));
    assert.equal(failedCwdReplacement.status, 502, "a direct cwd replacement whose child cannot spawn must fail the request");
    const tabAfterFailedCwdReplacement = (await request("127.0.0.1", "/api/tabs")).body?.data?.tabs?.find((tab) => tab.id === tabId);
    assert.deepEqual(
      { cwd: tabAfterFailedCwdReplacement?.cwd, prompt: tabAfterFailedCwdReplacement?.prompt },
      { cwd, prompt: null },
      "a failed direct cwd replacement must retain both the old cwd and old prompt descriptor",
    );
  }

  await writeFile(settingsFile, `${JSON.stringify({ ...persistedAfterSave, appendSystemPromptPath: outsideCandidate, appendSystemPromptRootPath: cwd })}\n`, "utf8");
  const tamperedTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: otherCwd, title: "tampered provenance" } });
  assert.equal(tamperedTab.status, 201, tamperedTab.body?.error);
  latestArgs = (await launches()).at(-1);
  assert.equal(latestArgs.includes(outsideCandidate), false, "a path outside its saved lexical root must not reach child arguments");
  const tamperedDiscovery = await request("127.0.0.1", `/api/append-system-files?tab=${encodeURIComponent(tamperedTab.body?.data?.tab?.id)}`);
  assert.ok(tamperedDiscovery.body?.data?.diagnostics?.some(({ kind, path: diagnosticPath }) => kind === "saved-selection-invalid" && diagnosticPath === outsideCandidate));
  await writeFile(settingsFile, `${JSON.stringify(persistedAfterSave)}\n`, "utf8");

  if (fileSymlinkAvailable) {
    const replacementTarget = path.join(root, "retargeted-file", "replacement.txt");
    await mkdir(path.dirname(replacementTarget), { recursive: true });
    await writeFile(replacementTarget, "retargeted regular prompt\n", "utf8");
    await rm(fileAliasCandidate);
    await symlink(replacementTarget, fileAliasCandidate, "file");
    const retargetedTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd: otherCwd, title: "retargeted symlink selection" } });
    assert.equal(retargetedTab.status, 201, retargetedTab.body?.error);
    latestArgs = (await launches()).at(-1);
    assert.ok(latestArgs.includes(fileAliasCandidate), "a saved visible alias retargeted to another regular file must still reach child arguments");
    await rm(replacementTarget);
  } else {
    await rm(projectCandidate);
  }

  const staleDiscovery = await request("127.0.0.1", route);
  assert.equal(staleDiscovery.body?.data?.appendSystemPromptPath, selectedCandidate, "a broken or deleted saved alias must stay visible for recovery");
  assert.ok(staleDiscovery.body?.data?.diagnostics?.some(({ kind, path: diagnosticPath }) => kind === "saved-selection-invalid" && diagnosticPath === selectedCandidate));
  const staleRejected = await request("127.0.0.1", "/api/append-system-selection", { method: "POST", body: { tabId, path: selectedCandidate } });
  assert.equal(staleRejected.status, 400, "a candidate broken or deleted after save must fail a new selection scan");

  const staleTab = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "stale prompt" } });
  assert.equal(staleTab.status, 201, staleTab.body?.error);
  latestArgs = (await launches()).at(-1);
  assert.equal(latestArgs.includes(selectedCandidate), false, "a missing saved path must never be passed as an inline prompt-like argument");
  assert.equal(latestArgs.filter((arg) => arg === "--append-system-prompt").length, 1, "only the explicit launcher override should remain");

  const cleared = await request("127.0.0.1", "/api/append-system-selection", { method: "POST", body: { tabId, path: null } });
  assert.equal(cleared.status, 200, cleared.body?.error);
  assert.deepEqual({ path: cleared.body?.data?.appendSystemPromptPath, changed: cleared.body?.data?.changed, restartRequired: cleared.body?.data?.restartRequired }, { path: null, changed: true, restartRequired: true });
  const persistedAfterClear = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persistedAfterClear.appendSystemPromptPath, null);
  assert.equal(persistedAfterClear.appendSystemPromptRootPath, null);
  assert.deepEqual(persistedAfterClear.retainedFixture, { value: 7 });

  const shutdown = await request("127.0.0.1", "/api/shutdown", { method: "POST", body: {} });
  assert.equal(shutdown.status, 200);
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100);
  assert.notEqual(child.exitCode, null, `server should stop after shutdown\n${output}`);

  const supervisedAgentDir = path.join(root, "supervised-agent");
  const validRestoredPath = path.join(home, ".pi", "agent", "minimal", "APPEND_SYSTEM.md");
  supervisorSeed = await discoverStartAttachRpcSupervisor({
    agentDir: supervisedAgentDir,
    port,
    environment: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: supervisedAgentDir, APPEND_SYSTEM_LAUNCH_LOG: launchLog },
  });
  const restoredPromptCases = [
    ["valid-restored", { kind: "append-system", path: validRestoredPath }, { kind: "append-system", path: validRestoredPath }],
    ["old-restored", undefined, null],
    ["relative-restored", { kind: "append-system", path: "relative/APPEND_SYSTEM.md" }, null],
    ["oversized-restored", { kind: "append-system", path: `/${"x".repeat(4096)}` }, null],
    ["newline-restored", { kind: "append-system", path: `${validRestoredPath}\nunsafe` }, null],
    ["carriage-return-restored", { kind: "append-system", path: `${validRestoredPath}\runsafe` }, null],
    ["tab-restored", { kind: "append-system", path: `${validRestoredPath}\tunsafe` }, null],
    ["del-restored", { kind: "append-system", path: `${validRestoredPath}\u007funsafe` }, null],
    ["nul-restored", { kind: "append-system", path: `${validRestoredPath}\0unsafe` }, null],
    ["unknown-kind-restored", { kind: "system", path: validRestoredPath }, null],
    ["extra-field-restored", { kind: "append-system", path: validRestoredPath, contents: "restored secret prompt contents" }, null],
  ];
  for (const [id, prompt] of restoredPromptCases) {
    await supervisorSeed.createTab({
      tabId: id,
      metadata: { index: restoredPromptCases.findIndex(([candidate]) => candidate === id) + 1, title: id, cwd, ...(prompt === undefined ? {} : { prompt }) },
      child: { command: process.execPath, args: [fakePiFixture], cwd },
    });
  }

  output = "";
  child = spawn(process.execPath, [serverScript, "--cwd", cwd, "--host", "0.0.0.0", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: supervisedAgentDir,
      PI_WEBUI_SETTINGS_FILE: settingsFile,
      PI_WEBUI_RPC_SUPERVISOR: "1",
      APPEND_SYSTEM_LAUNCH_LOG: launchLog,
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  health = undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (health.status === 200) break;
    } catch {
    }
    await delay(100);
  }
  assert.equal(health?.status, 200, `supervisor hydration server should become healthy\n${output}`);
  const restoredTabsResponse = await request("127.0.0.1", "/api/tabs");
  assert.equal(restoredTabsResponse.status, 200, restoredTabsResponse.body?.error);
  const restoredTabsById = new Map(restoredTabsResponse.body?.data?.tabs?.map((tab) => [tab.id, tab]));
  for (const [id, , expectedPrompt] of restoredPromptCases) {
    assert.deepEqual(restoredTabsById.get(id)?.prompt, expectedPrompt, `${id} must normalize restored prompt metadata fail-closed`);
  }
  assert.equal(JSON.stringify([...restoredTabsById.values()].map((tab) => tab.prompt)).includes("restored secret prompt contents"), false, "malformed restored content-like fields must not reach HTTP prompt metadata");

  await writeFile(settingsFile, `${JSON.stringify({ appendSystemPromptPath: validRestoredPath, appendSystemPromptRootPath: path.join(home, ".pi") })}\n`, "utf8");
  const supervisedLaunch = await request("127.0.0.1", "/api/tabs", { method: "POST", body: { cwd, title: "supervised selected launch" } });
  assert.equal(supervisedLaunch.status, 201, supervisedLaunch.body?.error);
  assert.deepEqual(supervisedLaunch.body?.data?.tab?.prompt, { kind: "append-system", path: validRestoredPath });
  const supervisorState = await readSupervisorState(await supervisorPaths({ agentDir: supervisedAgentDir, port }));
  const supervisedLaunchMetadata = supervisorState?.tabs?.find((tab) => tab.id === supervisedLaunch.body?.data?.tab?.id)?.metadata;
  assert.deepEqual(supervisedLaunchMetadata?.prompt, { kind: "append-system", path: validRestoredPath }, "successful supervised launches must persist the bounded descriptor with their child metadata");

  const supervisedShutdown = await request("127.0.0.1", "/api/shutdown", { method: "POST", body: {} });
  assert.equal(supervisedShutdown.status, 200);
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100);
  assert.notEqual(child.exitCode, null, `supervisor hydration server should stop after shutdown\n${output}`);
  console.log("append-system-http.test.mjs passed");
} finally {
  if (child?.exitCode === null) terminateProcessTree(child);
  if (supervisorSeed?.isConnected()) await supervisorSeed.shutdown().catch(() => {});
  supervisorSeed?.close();
  await rm(root, { recursive: true, force: true });
}
