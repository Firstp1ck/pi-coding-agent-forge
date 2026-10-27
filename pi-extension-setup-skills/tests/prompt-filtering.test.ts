import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BuildSystemPromptOptions,
  Extension,
  ExtensionAPI,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import setupSkillsExtension, { collectLoadedSkills } from "../index";

// Exercise Pi's real structured serializer, which HTML exports use instead of forced prompt text.
const { buildSystemPrompt, buildSystemPromptSections, normalizeBuildSystemPromptOptions, diffSystemPromptSections } =
  await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { exportSessionToHtml } =
  await import(new URL("./core/export-html/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { Agent } = await import(Bun.resolveSync(
  "@earendil-works/pi-agent-core",
  fileURLToPath(new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"))),
));

const roots: string[] = [];
const originalSettingsFile = process.env.PI_WEBUI_SETTINGS_FILE;
const originalMarker = process.env.T3_PI_RESOURCE_PROFILES;
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => { delete process.env.T3_PI_RESOURCE_PROFILES; });

afterEach(() => {
  if (originalSettingsFile === undefined) delete process.env.PI_WEBUI_SETTINGS_FILE;
  else process.env.PI_WEBUI_SETTINGS_FILE = originalSettingsFile;
  if (originalMarker === undefined) delete process.env.T3_PI_RESOURCE_PROFILES;
  else process.env.T3_PI_RESOURCE_PROFILES = originalMarker;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(enabledSkills: string[] | null = ["enabled"], mode = "tui", argv = ["--no-skills"]) {
  const root = mkdtempSync(join(tmpdir(), "setup-skills-prompt-"));
  roots.push(root);
  const settingsFile = join(root, "resource-settings.json");
  process.env.PI_WEBUI_SETTINGS_FILE = settingsFile;
  if (argv.length === 0) {
    // Full-discovery cases must stay inside the fixture, including home roots.
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
  }
  writeFileSync(settingsFile, JSON.stringify({ resourceDefaults: { skills: { enabledSkills } } }));
  const commands = ["enabled", "disabled", "manual"].map((name) => {
    const baseDir = join(root, name);
    mkdirSync(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} skill\ndisable-model-invocation: ${name === "manual"}\n---\nSkill instructions.\n`);
    return {
      name: `skill:${name}`,
      description: `${name} skill`,
      source: "skill" as const,
      sourceInfo: { path: filePath, source: "cli", scope: "temporary" as const, origin: "top-level" as const },
    };
  });
  const skills = collectLoadedSkills(commands);
  const handlers: Extension["handlers"] = new Map();
  const notifications: string[] = [];
  const branch: { type: string; customType: string; data: unknown }[] = [];
  let sessionId = "session-one";
  const ctx = {
    cwd: root,
    mode,
    model: undefined,
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  setupSkillsExtension({
    getCommands: () => commands,
    registerCommand() {},
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as ExtensionAPI, argv);

  async function emit(name: string, event: object = {}) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  }

  async function filter(overrides: BuildSystemPromptOptions = { cwd: root }) {
    const options = normalizeBuildSystemPromptOptions({
      cwd: root,
      skills,
      selectedTools: ["read"],
      appendSystemPrompt: "Keep unrelated instructions.",
      ...overrides,
    });
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "test",
      systemPromptOptions: options,
      get systemPrompt() { return buildSystemPrompt(options); },
    };
    const result = await emit("before_agent_start", event) as BeforeAgentStartEventResult | undefined;
    if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
    return { options, result, prompt: buildSystemPrompt(options), sections: buildSystemPromptSections(options) };
  }

  await emit("session_start");
  expect(notifications).toEqual([]);
  return { root, settingsFile, skills, commands, ctx, branch, emit, filter, notifications,
    setSession: (id: string) => { sessionId = id; } };
}

function names(skills: Skill[]): string[] {
  return skills.map((skill) => skill.name);
}

function promptNames(prompt: string): string[] {
  return [...prompt.matchAll(/<name>(.*?)<\/name>/g)].map((match) => match[1]);
}

describe("skill prompt filtering", () => {
  test("updates structured skills and rendered prompt without forcing the whole prompt", async () => {
    const { filter } = await fixture();
    const { options, result, prompt, sections } = await filter();
    expect(promptNames(prompt)).toEqual(["enabled"]);
    expect(names(options.skills)).toEqual(["enabled"]);
    expect(promptNames(sections.skills)).toEqual(["enabled"]);
    expect(result).toBeUndefined();
    expect(options.forceSystemPrompt).toBeUndefined();
    expect(sections.addendum).toContain("Keep unrelated instructions.");
  });

  test("an empty selection removes the structured skill section", async () => {
    const { filter } = await fixture([]);
    const { options, prompt, sections } = await filter();
    expect(options.skills).toEqual([]);
    expect(prompt).not.toContain("<available_skills>");
    expect(sections.skills).toBeUndefined();
  });

  test("manual-only skills stay callable but are not advertised", async () => {
    const { filter, emit } = await fixture(["enabled", "manual"]);
    const { options, prompt } = await filter();
    expect(names(options.skills)).toEqual(["enabled"]);
    expect(promptNames(prompt)).toEqual(["enabled"]);
    expect(await emit("input", { text: "/skill:manual" })).toEqual({ action: "continue" });
    expect(await emit("input", { text: "/skill:disabled" })).toEqual({ action: "handled" });
  });

  test("also filters an earlier extension's forced prompt without dropping its instructions", async () => {
    const { root, skills, filter } = await fixture();
    const forced = `${buildSystemPrompt({ cwd: root, skills })}\nEarlier extension instructions.`;
    const { options, prompt, sections } = await filter({ cwd: root, forceSystemPrompt: forced });
    expect(promptNames(prompt)).toEqual(["enabled"]);
    expect(prompt).toContain("Earlier extension instructions.");
    expect(names(options.skills)).toEqual(["enabled"]);
    expect(promptNames(sections.skills)).toEqual(["enabled"]);
  });

  test("keeps filtering legacy events without structured options", async () => {
    const { root, skills, emit } = await fixture();
    const result = await emit("before_agent_start", {
      systemPrompt: buildSystemPrompt({ cwd: root, skills }),
    }) as BeforeAgentStartEventResult;
    expect(promptNames(result.systemPrompt!)).toEqual(["enabled"]);
  });

  test("branch selection changes produce structured deltas and can re-enable skills", async () => {
    const { branch, emit, filter, skills } = await fixture();
    const first = await filter();
    branch.push({ type: "custom", customType: "webui-skills-config", data: { enabledSkills: ["disabled"] } });
    await emit("session_tree");
    const next = await filter();
    expect(promptNames(next.sections.skills)).toEqual(["disabled"]);
    expect(diffSystemPromptSections(first.sections, next.sections)).toEqual({ skills: next.sections.skills });
    branch.push({ type: "custom", customType: "webui-skills-config", data: { enabledSkills: [] } });
    await emit("session_tree");
    const empty = await filter();
    expect(diffSystemPromptSections(next.sections, empty.sections)).toEqual({ skills: null });
    expect(names(skills)).toEqual(["disabled", "enabled", "manual"]);
  });

  test("HTML export reflects the corrected skill section on an existing transcript", async () => {
    const { root, skills, filter } = await fixture();
    const manager = SessionManager.create(root, join(root, "sessions"));
    const previous = buildSystemPromptSections({ cwd: root, skills, selectedTools: ["read"] });
    manager.appendMessage({ role: "system", content: "", sections: previous, timestamp: 1 });
    const { sections } = await filter();
    manager.appendMessage({
      role: "system", content: "", sections: diffSystemPromptSections(previous, sections), timestamp: 2,
    });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions",
      provider: "test", model: "test", stopReason: "stop", timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const agent = new Agent({
      initialState: { messages: manager.buildSessionContext().messages },
      streamFn: () => { throw new Error("Export test must not call a provider"); },
    });
    const outputPath = join(root, "session.html");
    await exportSessionToHtml(manager, agent.state, { outputPath });
    const encoded = readFileSync(outputPath, "utf8").match(/<script[^>]*id="session-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(encoded).toBeDefined();
    const exported = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
    expect(promptNames(exported.systemPrompt)).toEqual(["enabled"]);
  });

  test("model overrides update the structured selection and returning to global restores it", async () => {
    const { ctx, root, settingsFile, emit, filter } = await fixture();
    writeFileSync(settingsFile, JSON.stringify({ resourceDefaults: {
      skills: { enabledSkills: ["enabled"] },
      modelProfiles: [{ provider: "test", modelId: "alternate", skills: { enabledSkills: ["disabled"] } }],
    } }));
    ctx.model = { provider: "test", id: "alternate" } as ExtensionContext["model"];
    await emit("model_select", { model: ctx.model });
    expect(names((await filter()).options.skills)).toEqual(["disabled"]);
    ctx.model = undefined;
    await emit("model_select", { model: undefined });
    const { options } = await filter({ cwd: root, selectedTools: ["bash"] });
    expect(names(options.skills)).toEqual(["enabled"]);
    expect(buildSystemPrompt(options)).toContain("bash");
  });

  test("later prompt overrides retain the filtered skill list", async () => {
    const { filter } = await fixture();
    const { options, prompt } = await filter();
    options.forceSystemPrompt = `${prompt}\nLater extension instructions.`;
    expect(promptNames(buildSystemPrompt(options))).toEqual(["enabled"]);
    expect(promptNames(buildSystemPromptSections(options).skills)).toEqual(["enabled"]);
  });

  test("inherits runtime skills while excluding manual-only advertisements", async () => {
    const { filter } = await fixture(null);
    const { options } = await filter();
    expect(names(options.skills)).toEqual(["disabled", "enabled"]);
  });

  test("does not take ownership of RPC skill filtering", async () => {
    const { filter } = await fixture(["enabled"], "rpc");
    const { options, result } = await filter();
    expect(names(options.skills)).toEqual(["disabled", "enabled", "manual"]);
    expect(result).toBeUndefined();
  });
});

describe("T3 RPC skill profiles", () => {
  const own = () => { process.env.T3_PI_RESOURCE_PROFILES = `t3-v1:${process.pid}`; };
  const save = (file: string, enabledSkills: string[] | null, modelProfiles: unknown[] = []) => {
    writeFileSync(file, JSON.stringify({ resourceDefaults: { skills: { enabledSkills }, modelProfiles } }));
  };

  test.each(["t3-v1", "t3-v2:1", `t3-v1:${process.pid + 1}`, `t3-v1:0${process.pid}`])(
    "ignores invalid or descendant marker %s", async (marker) => {
      process.env.T3_PI_RESOURCE_PROFILES = marker;
      const h = await fixture([], "rpc");
      expect(names((await h.filter()).options.skills)).toEqual(["disabled", "enabled", "manual"]);
      expect(await h.emit("input", { text: "/skill:enabled" })).toEqual({ action: "continue" });
    },
  );

  test.each(["json", "print"])("does not adopt a bound marker in %s mode", async (mode) => {
    own();
    const h = await fixture([], mode);
    expect(names((await h.filter()).options.skills)).toEqual(["disabled", "enabled", "manual"]);
  });

  test("refreshes structured, forced and legacy prompts, and explicit input uses current defaults", async () => {
    own();
    const h = await fixture(["enabled"], "rpc");
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    save(h.settingsFile, ["disabled", "manual"]);
    expect(await h.emit("input", { text: "/skill:enabled" })).toEqual({ action: "handled" });
    expect(await h.emit("input", { text: "/skill:manual" })).toEqual({ action: "continue" });
    const forced = `${buildSystemPrompt({ cwd: h.root, skills: h.skills })}\nRetain this instruction.`;
    const next = await h.filter({ cwd: h.root, forceSystemPrompt: forced });
    expect(names(next.options.skills)).toEqual(["disabled"]);
    expect(promptNames(next.prompt)).toEqual(["disabled"]);
    expect(next.prompt).toContain("Retain this instruction.");
    expect(diffSystemPromptSections((await h.filter()).sections, next.sections)).toBeUndefined();
    const legacy = await h.emit("before_agent_start", { systemPrompt: forced }) as BeforeAgentStartEventResult;
    expect(promptNames(legacy.systemPrompt!)).toEqual(["disabled"]);
    save(h.settingsFile, []);
    expect((await h.filter()).options.skills).toEqual([]);
  });

  test("uses branch, exact model, global, empty and legacy disabled pins", async () => {
    own();
    const h = await fixture(["enabled"], "rpc");
    save(h.settingsFile, ["enabled"], [
      { provider: "test", modelId: "model", skills: { enabledSkills: ["disabled"] } },
      { provider: "test", modelId: "empty", skills: { enabledSkills: [] } },
    ]);
    h.ctx.model = { provider: "test", id: "model" } as never;
    await h.emit("model_select", { model: h.ctx.model });
    expect(names((await h.filter()).options.skills)).toEqual(["disabled"]);
    h.branch.push({ type: "custom", customType: "webui-skills-config", data: { enabledSkills: ["enabled"] } });
    await h.emit("session_tree");
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    h.branch.push({ type: "custom", customType: "webui-skills-config", data: { disabledSkills: ["disabled"] } });
    await h.emit("session_tree");
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    expect(await h.emit("input", { text: "/skill:disabled" })).toEqual({ action: "handled" });
    h.branch.push({ type: "custom", customType: "webui-skills-config", data: { version: 2, mode: "inherit" } });
    await h.emit("session_tree");
    expect(names((await h.filter()).options.skills)).toEqual(["disabled"]);
    h.ctx.model = { provider: "TEST", id: "model" } as never;
    await h.emit("model_select", { model: h.ctx.model });
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    h.ctx.model = { provider: "test", id: "empty" } as never;
    await h.emit("model_select", { model: h.ctx.model });
    expect((await h.filter()).options.skills).toEqual([]);
  });

  test("runtime inheritance allows later loaded skills and handles legacy prompts", async () => {
    own();
    const h = await fixture(null, "rpc");
    const filePath = join(h.root, "later.md");
    writeFileSync(filePath, "---\nname: later\ndescription: later skill\n---\nLater instructions.\n");
    h.commands.push({ name: "skill:later", description: "later skill", source: "skill",
      sourceInfo: { path: filePath, source: "cli", scope: "temporary", origin: "top-level" } });
    const later = collectLoadedSkills(h.commands).find((skill) => skill.name === "later")!;
    expect(names((await h.filter({ cwd: h.root, skills: [...h.skills, later] })).options.skills))
      .toEqual(["disabled", "enabled", "later"]);
    await h.emit("session_start");
    expect(await h.emit("input", { text: "/skill:later" })).toEqual({ action: "continue" });
    const result = await h.emit("before_agent_start", {
      systemPrompt: buildSystemPrompt({ cwd: h.root, skills: [...h.skills, later] }),
    }) as BeforeAgentStartEventResult;
    expect(promptNames(result.systemPrompt!)).toEqual(["disabled", "enabled", "later"]);
  });

  test("no-skills limits explicit profiles to actually loaded CLI skills", async () => {
    own();
    const h = await fixture(["enabled", "not-loaded"], "rpc");
    const hidden = join(h.root, ".pi", "skills", "not-loaded");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "SKILL.md"), "---\nname: not-loaded\ndescription: hidden\n---\nHidden instructions.");
    const extra = { ...h.skills[0], name: "not-loaded", filePath: join(hidden, "SKILL.md") };
    expect(names((await h.filter({ cwd: h.root, skills: [...h.skills, extra] })).options.skills)).toEqual(["enabled"]);
    expect(await h.emit("input", { text: "/skill:not-loaded" })).toEqual({ action: "continue" });
    expect(await h.emit("input", { text: "/skill:disabled" })).toEqual({ action: "handled" });
  });

  test("expands selected installed skills, preserving images, without rescanning each prompt", async () => {
    own();
    const h = await fixture([], "rpc", []);
    const hidden = join(h.root, ".pi", "skills", "installed");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "SKILL.md"), "---\nname: installed\ndescription: installed skill\n---\nInstalled instructions.\n");
    save(h.settingsFile, ["installed"]);
    await h.emit("session_tree");
    const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
    const result = await h.emit("input", { text: "/skill:installed Use these instructions", images }) as any;
    expect(result.action).toBe("transform");
    expect(result.text).toContain("Installed instructions.");
    expect(result.text).toContain("Use these instructions");
    expect(result.images).toBe(images);
    // A deleted candidate remains in the snapshot until a lifecycle discovery refresh.
    // Prompt-only profile reads must not do a fresh traversal of skill directories.
    rmSync(join(hidden, "SKILL.md"));
    expect(names((await h.filter()).options.skills)).toEqual(["installed"]);
    await h.emit("session_tree");
    expect((await h.filter()).options.skills).toEqual([]);
  });

  test("retains valid policy on failed refresh and stops on shutdown", async () => {
    own();
    const h = await fixture(["enabled"], "rpc");
    writeFileSync(h.settingsFile, "invalid JSON");
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    expect(await h.emit("input", { text: "/skill:disabled" })).toEqual({ action: "handled" });
    await h.emit("session_shutdown");
    expect(names((await h.filter()).options.skills)).toEqual(["disabled", "enabled", "manual"]);
    expect(await h.emit("input", { text: "/skill:disabled" })).toEqual({ action: "continue" });
  });

  test.each(["model", "branch", "session", "shutdown"])("retries stale async %s refresh without exposing raw skills", async (change) => {
    own();
    const h = await fixture(["enabled"], "rpc");
    save(h.settingsFile, ["disabled"]);
    const pending = h.filter();
    if (change === "model") h.ctx.model = { provider: "test", id: "other" } as never;
    if (change === "branch") h.branch.push({ type: "custom", customType: "webui-skills-config", data: { enabledSkills: [] } });
    if (change === "session") h.setSession("session-two");
    if (change === "shutdown") await h.emit("session_shutdown");
    expect(names((await pending).options.skills)).toEqual(change === "shutdown"
      ? ["disabled", "enabled", "manual"] : change === "branch" ? [] : ["disabled"]);
    // A subsequent lifecycle and prompt must still resolve normally.
    await h.emit("session_start");
    expect(names((await h.filter()).options.skills)).toEqual(change === "branch" ? [] : ["disabled"]);
  });

  test("concurrent allowed skill input is not silently dropped and the prompt stays filtered", async () => {
    own();
    const h = await fixture(["enabled"], "rpc");
    const prompt = h.filter();
    const input = h.emit("input", { text: "/skill:enabled" });
    expect(await input).toEqual({ action: "continue" });
    expect(names((await prompt).options.skills)).toEqual(["enabled"]);
  });

  test("concurrent denied skill input cannot invalidate prompt filtering", async () => {
    own();
    const h = await fixture(["enabled"], "rpc");
    const prompt = h.filter();
    const input = h.emit("input", { text: "/skill:disabled" });
    expect(await input).toEqual({ action: "handled" });
    expect(h.notifications.some((message) => message.includes("disabled by /skills"))).toBe(true);
    expect(names((await prompt).options.skills)).toEqual(["enabled"]);
  });

  test("TUI retains original prompt and invocation refresh timing with a valid marker", async () => {
    own();
    const h = await fixture(["enabled"]);
    save(h.settingsFile, []);
    expect(names((await h.filter()).options.skills)).toEqual(["enabled"]);
    expect(await h.emit("input", { text: "/skill:enabled" })).toEqual({ action: "continue" });
    await h.emit("session_tree");
    expect((await h.filter()).options.skills).toEqual([]);
  });
});
