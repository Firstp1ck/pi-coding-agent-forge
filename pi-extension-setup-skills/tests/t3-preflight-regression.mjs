import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const dist = fileURLToPath(new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(join(dist, "core/extensions/loader.js"));
const { ExtensionRunner } = await import(join(dist, "core/extensions/runner.js"));
const { SessionManager } = await import(join(dist, "core/session-manager.js"));
const { AgentSession } = await import(join(dist, "core/agent-session.js"));
for (const member of ["prompt", "setModel", "_runInputHandlers", "_expandSkillCommand", "_preparePromptAndToolLoadout", "_installAgentForcedPromptProjection"]) {
  assert.equal(typeof AgentSession.prototype[member], "function",
    `Pi Core preflight contract changed at ${member}; revalidate the regression against the installed Pi version (verified on 1.1).`);
}
const { buildSystemPrompt, buildSystemPromptSections } = await import(join(dist, "core/system-prompt.js"));
const root = await fs.mkdtemp("/tmp/pi-t3-preflight-regression-");
const originalRead = fs.readFile;
const savedEnvironment = { ...process.env };
const savedNetwork = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect,
  http: http.request, https: https.request };
let networkAttempts = 0;
const forbidNetwork = () => { networkAttempts += 1; throw new Error("Preflight regression forbids network"); };
globalThis.fetch = forbidNetwork;
net.Socket.prototype.connect = forbidNetwork;
http.request = forbidNetwork;
https.request = forbidNetwork;
syncBuiltinESMExports();

try {
  Object.assign(process.env, {
    HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_WEBUI_SETTINGS_FILE: join(root, "profiles.json"), PI_OFFLINE: "1",
    T3_PI_RESOURCE_PROFILES: `t3-v1:${process.pid}`,
  });
  await fs.mkdir(process.env.PI_CODING_AGENT_DIR);
  await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}");
  await fs.writeFile(process.env.PI_WEBUI_SETTINGS_FILE, JSON.stringify({ resourceDefaults: {
    skills: { enabledSkills: ["enabled"] },
    modelProfiles: [{ provider: "fixture", modelId: "b", skills: { enabledSkills: [] } }],
  } }));
  const skills = [];
  for (const name of ["enabled", "disabled"]) {
    const baseDir = join(root, name);
    await fs.mkdir(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    await fs.writeFile(filePath, `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name} instructions.\n`);
    skills.push({ name, description: name, baseDir, filePath });
  }
  const commands = skills.map((skill) => ({ name: `skill:${skill.name}`, source: "skill",
    sourceInfo: { path: skill.filePath, source: "cli", scope: "temporary", origin: "top-level" } }));
  const names = (prompt) => [...prompt.matchAll(/<name>(.*?)<\/name>/g)].map((match) => match[1]);

  for (const race of ["none", "denied-input", "model", "allowed-input"]) {
    const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], root);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.getCommands = () => commands;
    const manager = SessionManager.inMemory(root);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, {});
    runner.setUIContext(undefined, "rpc");
    const errors = [];
    runner.onError((error) => errors.push(error));
    const captured = [];
    const session = {
      agent: { state: { messages: [], model: { provider: "fixture", id: "a" } } },
      sessionManager: manager, get model() { return this.agent.state.model; },
      get isStreaming() { return false; }, get resourceLoader() { return this._resourceLoader; },
      promptTemplates: [], _resourceLoader: { getSkills: () => ({ skills }) }, _extensionRunner: runner,
      _baseSystemPromptOptions: { cwd: root, skills, selectedTools: ["read"] },
      _pendingNextTurnMessages: [], _hiddenDeclarations: new Set(),
      _modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => "fixture" },
      _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _findLastAssistantMessage() {},
      getActiveToolNames: () => ["read"], _applyToolLoadout: () => [{ name: "read" }],
      _getThinkingLevelForModelSwitch: () => "off", setThinkingLevel() {},
      _runInputHandlers: AgentSession.prototype._runInputHandlers,
      _tryExecuteExtensionCommand: AgentSession.prototype._tryExecuteExtensionCommand,
      _expandSkillCommand: AgentSession.prototype._expandSkillCommand,
      _normalizePromptImages: AgentSession.prototype._normalizePromptImages,
      _preparePromptAndToolLoadout: AgentSession.prototype._preparePromptAndToolLoadout,
      _emitModelSelect: AgentSession.prototype._emitModelSelect,
      // Stop at the provider boundary. No stream or model service is constructed.
      async _runAgentPrompt(messages) {
        AgentSession.prototype._installAgentForcedPromptProjection.call(this);
        const options = this._runSystemPromptOptions;
        const projected = this.agent.transformContext
          ? await this.agent.transformContext(messages, new AbortController().signal) : messages;
        captured.push({ model: this.model.id,
          structured: names(buildSystemPromptSections(options).skills ?? ""),
          projected: names(options.forceSystemPrompt ? projected[0].content : buildSystemPrompt(options)),
          user: projected.find((message) => message.role === "user").content[0].text });
      },
    };
    runner.getModel = () => session.model;
    await runner.emit({ type: "session_start", reason: "new" });
    let enteredResolve;
    let release;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let armed = race !== "none";
    fs.readFile = async function (path, ...args) {
      if (armed && path === process.env.PI_WEBUI_SETTINGS_FILE) {
        armed = false;
        enteredResolve();
        await gate;
      }
      return originalRead.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const prompt = AgentSession.prototype.prompt.call(session, "ordinary fixture prompt");
    let concurrent;
    if (race !== "none") {
      await entered;
      concurrent = race === "model"
        ? AgentSession.prototype.setModel.call(session, { provider: "fixture", id: "b" })
        : AgentSession.prototype.prompt.call(session, race === "allowed-input" ? "/skill:enabled arguments" : "/skill:disabled",
          { streamingBehavior: "steer", source: "rpc" });
      release();
    }
    await Promise.all([prompt, concurrent]);
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    assert.deepEqual(errors, []);
    const expected = race === "model" ? [] : ["enabled"];
    for (const request of captured) {
      assert.deepEqual(request.structured, expected, race);
      assert.deepEqual(request.projected, expected, race);
    }
    assert.equal(captured.length, race === "allowed-input" ? 2 : 1, race);
    if (race === "allowed-input") assert.ok(captured.some((request) => request.user.includes('<skill name="enabled"') && request.user.includes("arguments")));
    await runner.emit({ type: "session_shutdown" });
    console.log(`Real Core preflight regression: ${race} PASS`);
  }
  assert.equal(networkAttempts, 0);
} finally {
  fs.readFile = originalRead;
  globalThis.fetch = savedNetwork.fetch;
  net.Socket.prototype.connect = savedNetwork.connect;
  http.request = savedNetwork.http;
  https.request = savedNetwork.https;
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  await fs.rm(root, { recursive: true, force: true });
}
