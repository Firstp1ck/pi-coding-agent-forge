import { afterEach, describe, expect, test } from "bun:test";
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

afterEach(() => {
  if (originalSettingsFile === undefined) delete process.env.PI_WEBUI_SETTINGS_FILE;
  else process.env.PI_WEBUI_SETTINGS_FILE = originalSettingsFile;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(enabledSkills: string[] | null = ["enabled"], mode = "tui") {
  const root = mkdtempSync(join(tmpdir(), "setup-skills-prompt-"));
  roots.push(root);
  const settingsFile = join(root, "resource-settings.json");
  process.env.PI_WEBUI_SETTINGS_FILE = settingsFile;
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
  const ctx = {
    cwd: root,
    mode,
    model: undefined,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  setupSkillsExtension({
    getCommands: () => commands,
    registerCommand() {},
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as ExtensionAPI, ["--no-skills"]);

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
  return { root, settingsFile, skills, ctx, branch, emit, filter, notifications };
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
