import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const dist = fileURLToPath(new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent")));
const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
const { buildSystemPromptSections } = await import(join(dist, "core/system-prompt.js"));
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
  const names = (prompt) => [...prompt.matchAll(/<name>(.*?)<\/name>/g)].map((match) => match[1]);

  for (const race of ["none", "denied-input", "model", "allowed-input"]) {
    const errors = [];
    const captured = [];
    let structured;
    const provider = fauxProvider({ provider: "fixture", api: `preflight-${race}`, models: [{ id: "a" }, { id: "b" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(provider.provider);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
      skillsOverride: () => ({ skills, diagnostics: [] }),
      extensionFactories: [{ name: "preflight-observer", factory: (pi) => {
        pi.on("before_agent_start", (event) => {
          structured = names(buildSystemPromptSections(event.systemPromptOptions).skills ?? "");
        });
      } }],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, model: provider.getModel("a"), modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: ["read"] });
    const session = created.session;
    const runner = session.extensionRunner;
    let release;
    try {
      assert.deepEqual(created.extensionsResult.errors, []);
      provider.setResponses(Array.from({ length: 2 }, () => (context, _options, _state, model) => {
        captured.push({ model: model.id, structured,
          projected: names(getCurrentSystemPrompt(context.messages)),
          user: context.messages.findLast((message) => message.role === "user").content[0].text });
        return fauxAssistantMessage("Fixture response.");
      }));
      await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
      let enteredResolve;
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
      const prompt = session.prompt("ordinary fixture prompt");
      let concurrent;
      if (race !== "none") {
        await Promise.race([entered, prompt.then(() => {
          throw new Error(`${race}: prompt completed without reaching the profile-read gate`);
        })]);
        concurrent = race === "model"
          ? session.setModel(provider.getModel("b"))
          : session.prompt(race === "allowed-input" ? "/skill:enabled arguments" : "/skill:disabled",
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
      assert.ok(captured.every((request) => request.model === (race === "model" ? "b" : "a")), race);
      assert.ok(session.messages.filter((message) => message.role === "assistant").every((message) => message.errorMessage === undefined), "Faux provider errors must fail the regression");
    } finally {
      release?.();
      fs.readFile = originalRead;
      syncBuiltinESMExports();
      await runner.emit({ type: "session_shutdown" });
      await session.abort();
      session.dispose();
    }
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
