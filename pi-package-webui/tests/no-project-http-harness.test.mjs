import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { terminateProcessTree } from "../lib/process-tree.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakePi = path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs");

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(80);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function identity(tab) {
  return { id: tab.id, cwd: tab.cwd, workspaceKind: tab.workspaceKind, noProjectId: tab.noProjectId };
}

async function scenario({ supervised, noSession = false, compacting = false }) {
  const work = await mkdtemp(path.join(tmpdir(), "webui-no-project-http-"));
  const project = path.join(work, "project");
  const agentDir = path.join(work, "agent");
  const sessions = path.join(work, "sessions");
  const failFile = path.join(work, "fail-launch");
  const argvLog = path.join(work, "argv.jsonl");
  const commandLog = path.join(work, "commands.jsonl");
  const wrapper = path.join(work, "fake-wrapper.mjs");
  const port = await freePort();
  const children = [];
  const output = [];
  let latestServerPid;
  const env = {
    ...process.env,
    HOME: path.join(work, "home"),
    XDG_CONFIG_HOME: path.join(work, "config"),
    XDG_CACHE_HOME: path.join(work, "cache"),
    XDG_STATE_HOME: path.join(work, "state"),
    XDG_DATA_HOME: path.join(work, "data"),
    XDG_RUNTIME_DIR: path.join(work, "runtime"),
    npm_config_cache: path.join(work, "npm-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEBUI_SETTINGS_FILE: path.join(work, "settings.json"),
    PI_WEBUI_WORKSPACES_FILE: path.join(work, "workspaces.json"),
    PI_WEBUI_UPDATE_TEST_HOME: path.join(work, "update"),
    PI_WEBUI_SESSION_SUMMARY_DIR: path.join(work, "summaries"),
    PI_WEBUI_RPC_SUPERVISOR: supervised ? "1" : "0",
    FAKE_PI_SESSION_OWNERSHIP: "1",
    FAKE_PI_LOG_FILE: commandLog,
    FAKE_PI_GUIDED_GIT_STATE: compacting ? "compacting" : "",
    NODE_ENV: "test",
  };
  async function request(route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function health() {
    const value = await request("/api/health");
    if (value.status !== 200 || !value.body.ok || value.body.optionalFeatures?.ready === false) return null;
    latestServerPid = value.body.webuiPid;
    return value.body;
  }
  async function tabs() {
    const value = await request("/api/tabs");
    assert.equal(value.status, 200);
    return value.body.data.tabs;
  }
  async function create(body = { workspaceKind: "no-project" }) {
    const value = await request("/api/tabs", body);
    assert.equal(value.status, 201, JSON.stringify(value));
    return value.body.data.tab;
  }
  async function log(file) {
    return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  function launch() {
    const args = [path.join(packageRoot, "bin", "pi-webui.mjs"), "--cwd", project, "--host", "127.0.0.1", "--port", String(port), "--pi", wrapper];
    if (noSession) args.push("--no-session");
    args.push("--", "--session", path.join(sessions, "inherited.jsonl"), "--continue", "--resume", "--model", "fake/fake-model", "--thinking", "off", "--session-dir", sessions, "initial inherited input", "@inherited.txt");
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    return child;
  }
  try {
    for (const directory of [project, agentDir, sessions, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR]) await mkdir(directory, { recursive: true });
    await writeFile(env.PI_WEBUI_SETTINGS_FILE, "{}\n");
    await writeFile(path.join(sessions, "inherited.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "project-startup", timestamp: new Date().toISOString(), cwd: project })}\n`);
    await writeFile(wrapper, `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid}) + "\\n");
if (process.cwd() !== ${JSON.stringify(project)} && existsSync(${JSON.stringify(failFile)})) process.exit(42);
await new Promise(resolve => setTimeout(resolve, 100));
await import(${JSON.stringify(pathToFileURL(fakePi).href)});
`);
    let child = launch();
    await waitFor("isolated server health", health);
    await waitFor("tab creation readiness", async () => {
      const value = await request("/api/tabs", { workspaceKind: "typo" });
      return value.status === 400;
    });
    const initial = (await tabs())[0];
    assert.equal(initial.cwd, project);
    assert.equal(initial.workspaceKind, undefined);
    const first = await create();
    const second = await create();
    assert.notEqual(first.cwd, second.cwd);
    assert.notEqual(first.noProjectId, second.noProjectId);
    assert.equal(first.workspaceKind, "no-project");
    assert.equal(first.cwd, path.join(agentDir, "webui", "no-project", first.noProjectId));
    assert.deepEqual(await readdir(first.cwd), []);
    assert.equal((await stat(first.cwd)).isDirectory(), true);
    await writeFile(path.join(first.cwd, "retained.txt"), "source work");
    const firstState = (await request(`/api/state?tab=${first.id}`)).body.data;
    const startup = (await log(argvLog)).find((entry) => entry.cwd === first.cwd);
    assert.ok(startup, "child actually launches in the allocated leaf");
    for (const removed of ["--session", "--continue", "--resume", "initial inherited input", "@inherited.txt"]) assert.equal(startup.args.includes(removed), false, removed);
    assert.equal(startup.args[startup.args.indexOf("--model") + 1], "fake/fake-model");
    assert.equal(startup.args[startup.args.indexOf("--session-dir") + 1], sessions);
    assert.equal(startup.args.includes("--no-session"), noSession);
    const count = (await tabs()).length;
    for (const body of [{ workspaceKind: "typo" }, { workspaceKind: "no-project", cwd: project }, { workspaceKind: "no-project", sessionFile: "ignored" }, { workspaceKind: "no-project", noProjectId: first.noProjectId }, { cwd: first.cwd }]) {
      assert.equal((await request("/api/tabs", body)).status, 400);
    }
    assert.equal((await tabs()).length, count);
    const post = (route, tab, extra = {}) => request(route, { tab: tab.id, ...extra });

    if (compacting) {
      for (const route of ["/api/new-session", "/api/prompt"]) {
        const value = await post(route, first, route === "/api/prompt" ? { message: "/new" } : {});
        assert.equal(value.status, 409, JSON.stringify(value));
      }
      assert.equal((await tabs()).length, count);
      return;
    }

    assert.equal((await post("/api/prompt", first, { message: "ordinary stable prompt" })).status, 200);
    assert.deepEqual(identity((await tabs()).find((tab) => tab.id === first.id)), identity(first));
    assert.equal((await post("/api/prompt", first, { message: "/talk on" })).status, 200);
    await waitFor("natural conversation admission", async () => (await tabs()).find((tab) => tab.id === first.id)?.conversationMode.enabled);
    assert.equal((await post("/api/new-session", first)).status, 409);
    assert.equal((await post("/api/prompt", first, { message: "/new" })).status, 409);
    assert.equal((await post("/api/prompt", first, { message: "/talk off" })).status, 200);
    await waitFor("natural conversation off", async () => !(await tabs()).find((tab) => tab.id === first.id)?.conversationMode.enabled);

    const reset = await post("/api/new-session", first);
    assert.equal(reset.status, 200, JSON.stringify(reset));
    assert.equal(reset.body.command, "new_session");
    assert.equal(reset.body.success, true);
    assert.equal(reset.body.tab.id, first.id, "outer compatibility tab identifies source request context");
    assert.equal(reset.body.data.nextTabId, reset.body.data.tab.id);
    assert.equal(reset.body.data.sourceTab.id, first.id);
    assert.notEqual(reset.body.data.tab.cwd, first.cwd);
    assert.equal((await request(`/api/state?tab=${first.id}`)).body.data.sessionId, firstState.sessionId, "source RPC session is never reset");
    assert.equal((await tabs()).find((tab) => tab.id === first.id).pid, first.pid);
    const slashReset = await post("/api/prompt", second, { message: "/new" });
    assert.equal(slashReset.status, 200, JSON.stringify(slashReset));
    assert.equal(slashReset.body.command, "native_slash_command");
    assert.equal(slashReset.body.data.command, "new");
    assert.equal(slashReset.body.data.status, "succeeded");
    assert.equal(slashReset.body.data.nextTabId, slashReset.body.data.tab.id);
    assert.equal(slashReset.body.data.sourceTab.id, second.id);
    assert.notEqual(slashReset.body.data.tab.cwd, second.cwd);
    const duplicate = await Promise.all([post("/api/new-session", first), post("/api/new-session", first)]);
    assert.deepEqual(duplicate.map((value) => value.status).sort(), [200, 409]);
    assert.equal((await log(commandLog)).filter((entry) => entry.direction === "command" && entry.type === "new_session").length, 0, "No Project reset never sends new_session to any RPC");
    const projectReset = await post("/api/new-session", initial);
    assert.equal(projectReset.status, 200);
    assert.equal(projectReset.body.data.nextTabId, undefined);
    assert.equal(projectReset.body.tab.cwd, project);

    const beforeFailure = (await tabs()).map(identity);
    const leavesBeforeFailure = await readdir(path.dirname(first.cwd));
    await writeFile(failFile, "fail");
    const failure = await post("/api/new-session", first);
    assert.equal(failure.status, 500, JSON.stringify(failure));
    assert.deepEqual((await tabs()).map(identity), beforeFailure);
    const retainedFailedLeaves = (await readdir(path.dirname(first.cwd))).filter((leaf) => !leavesBeforeFailure.includes(leaf));
    assert.equal(retainedFailedLeaves.length, 1, "failed launches retain their allocated leaf");
    assert.equal((await request(`/api/state?tab=${first.id}`)).body.data.sessionId, firstState.sessionId);
    await rm(failFile);

    if (!noSession) {
      const resumeFile = path.join(sessions, "resume.jsonl");
      await writeFile(resumeFile, `${JSON.stringify({ type: "session", version: 3, id: "owned-resume", timestamp: new Date().toISOString(), cwd: first.cwd })}\n`);
      const resumed = await post("/api/switch-session", initial, { sessionPath: resumeFile });
      assert.equal(resumed.status, 200, JSON.stringify(resumed));
      assert.equal(resumed.body.data.tab.cwd, first.cwd);
      assert.equal(resumed.body.data.tab.noProjectId, first.noProjectId);
      const messages = (await request(`/api/fork-messages?tab=${first.id}`)).body.data.messages;
      const forked = await post("/api/fork", first, { entryId: messages[0].entryId });
      assert.equal(forked.status, 200, JSON.stringify(forked));
      assert.equal(forked.body.data.tab.cwd, first.cwd);
      assert.equal(forked.body.data.tab.noProjectId, first.noProjectId);
    }

    assert.equal((await post("/api/prompt", first, { message: "/reload" })).status, 200);
    assert.deepEqual(identity((await tabs()).find((tab) => tab.id === first.id)), identity(first));
    const saved = await request("/api/workspaces", { name: "Owned work", activeTabId: first.id });
    assert.equal(saved.status, 201, JSON.stringify(saved));
    const savedId = saved.body.data.workspace.id;
    const savedDocument = JSON.parse(await readFile(env.PI_WEBUI_WORKSPACES_FILE, "utf8"));
    assert.equal(savedDocument.workspaces[0].tabs.find((tab) => tab.id === first.id).noProjectId, first.noProjectId);

    const beforeRestart = (await tabs()).map(identity);
    const oldPid = latestServerPid;
    const restarted = await request("/api/restart", {});
    assert.equal(restarted.status, 200, JSON.stringify(restarted));
    latestServerPid = restarted.body.nextWebuiPid;
    await waitFor("private restore/supervisor restart", async () => { const value = await health(); return value?.webuiPid !== oldPid && value; });
    assert.deepEqual((await tabs()).map(identity), beforeRestart);
    if (supervised) {
      const managedBefore = (await tabs()).map((tab) => ({ ...identity(tab), pid: tab.pid }));
      process.kill(latestServerPid, "SIGKILL");
      await delay(250);
      child = launch();
      await waitFor("supervisor reattach after abrupt HTTP exit", health);
      assert.deepEqual((await tabs()).map((tab) => ({ ...identity(tab), pid: tab.pid })), managedBefore);
    }

    const loaded = await request(`/api/workspaces/${savedId}/load`, { replaceOpenTabs: true, discardCurrent: true });
    assert.equal(loaded.status, 200, JSON.stringify(loaded));
    assert.deepEqual(loaded.body.data.warnings, []);
    const reopenedFirst = loaded.body.data.tabs.find((tab) => tab.noProjectId === first.noProjectId);
    assert.ok(reopenedFirst);
    assert.equal(reopenedFirst.cwd, first.cwd);
    const closed = await request("/api/tabs/close", { ids: [reopenedFirst.id] });
    assert.equal(closed.status, 200);
    assert.equal(await readFile(path.join(first.cwd, "retained.txt"), "utf8"), "source work");
    const reopened = await request("/api/tabs/reopen", { id: reopenedFirst.id });
    assert.equal(reopened.status, 201, JSON.stringify(reopened));
    assert.equal(reopened.body.data.tab.cwd, first.cwd);
    assert.equal(reopened.body.data.tab.noProjectId, first.noProjectId);

    const missing = `${first.cwd}.missing`;
    await rename(first.cwd, missing);
    const missingLoad = await request(`/api/workspaces/${savedId}/load`, { replaceOpenTabs: true, discardCurrent: true });
    assert.equal(missingLoad.status, 200);
    assert.ok(missingLoad.body.data.warnings.some((warning) => /owned working directory is missing/.test(warning.message)));
    assert.equal(missingLoad.body.data.tabs.some((tab) => tab.noProjectId === first.noProjectId), false);
    await symlink(project, first.cwd, "dir");
    const escaped = await request(`/api/workspaces/${savedId}/load`, { replaceOpenTabs: true, discardCurrent: true });
    assert.equal(escaped.status, 200);
    assert.ok(escaped.body.data.warnings.some((warning) => /canonical owned leaf/.test(warning.message)));
    assert.equal(escaped.body.data.tabs.some((tab) => tab.noProjectId === first.noProjectId), false);
    await rm(first.cwd);
    await rename(missing, first.cwd);
    assert.equal(await readFile(path.join(first.cwd, "retained.txt"), "utf8"), "source work");

    if (!noSession) {
      const lone = await create();
      const otherIds = (await tabs()).filter((tab) => tab.id !== lone.id).map((tab) => tab.id);
      assert.equal((await request("/api/tabs/close", { ids: otherIds })).status, 200);
      const unavailable = `${lone.cwd}.unavailable`;
      await rename(lone.cwd, unavailable);
      if (supervised) {
        process.kill(latestServerPid, "SIGTERM");
        await waitFor("HTTP detach before invalid managed restore", async () => {
          try { return (await request("/api/health")).status !== 200; } catch { return true; }
        });
        const invalidRestore = launch();
        latestServerPid = invalidRestore.pid;
        await waitFor("missing managed cwd rejects startup", () => invalidRestore.exitCode !== null);
        assert.notEqual(invalidRestore.exitCode, 0);
        assert.match(output.join(""), /owned working directory is missing/);
        await rename(unavailable, lone.cwd);
        child = launch();
        await waitFor("managed restore after directory recovery", health);
        assert.deepEqual((await tabs()).map(identity), [identity(lone)]);
      } else {
        const retiringPid = latestServerPid;
        const restartMissing = await request("/api/restart", {});
        assert.equal(restartMissing.status, 200);
        latestServerPid = restartMissing.body.nextWebuiPid;
        await waitFor("missing private restore finishes without project fallback", async () => {
          const value = await health();
          return value?.webuiPid !== retiringPid && value;
        });
        assert.deepEqual(await tabs(), [], "missing owned restore must not fall back to startup project");
        assert.match(output.join(""), /owned working directory is missing/);
        await rename(unavailable, lone.cwd);
      }
    }
    console.log(`No Project HTTP lifecycle passed: ${supervised ? "supervised" : "direct"}${noSession ? ", no-session" : ""}`);
  } catch (error) {
    error.message += `\nIsolated server output:\n${output.join("").slice(-12000)}`;
    throw error;
  } finally {
    await request("/api/shutdown", {}).catch(() => {});
    await delay(400);
    if (latestServerPid) { try { process.kill(latestServerPid, "SIGTERM"); } catch {} }
    for (const child of children) terminateProcessTree(child, "SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
}

await scenario({ supervised: false });
await scenario({ supervised: true });
await scenario({ supervised: false, noSession: true });
await scenario({ supervised: true, noSession: true });
await scenario({ supervised: false, compacting: true });
console.log("No Project HTTP admission and lifecycle tests passed");
