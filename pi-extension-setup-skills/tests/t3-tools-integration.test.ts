import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolsExtension from "../../pi-extension-tools/index.ts";
import setupSkillsExtension, { collectLoadedSkills } from "../index.ts";

const environmentKeys = ["PI_WEBUI_SETTINGS_FILE", "T3_PI_RESOURCE_PROFILES", "T3_MCP_URL", "T3_MCP_BEARER_TOKEN", "T3_PI_RUNTIME_MODE"] as const;
let previousEnvironment: Map<string, string | undefined>;
let previousArgv: string[];
let root: string;

beforeEach(() => {
  previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  previousArgv = process.argv;
  root = mkdtempSync(join(tmpdir(), "t3-tools-skills-integration-"));
  process.env.PI_WEBUI_SETTINGS_FILE = join(root, "settings.json");
  process.env.T3_MCP_URL = "http://127.0.0.1:3773/mcp";
  process.env.T3_MCP_BEARER_TOKEN = "test-only-not-a-credential";
  process.env.T3_PI_RUNTIME_MODE = "full-access";
  delete process.env.T3_PI_RESOURCE_PROFILES;
  process.argv = ["node", "pi", "--mode", "rpc", "--extension", join(root, "pi-t3-mcp-extension.ts"), "--no-skills"];
});

afterEach(() => {
  process.argv = previousArgv;
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function fixture(skillsFirst: boolean, enabledSkills: string[]) {
  writeFileSync(process.env.PI_WEBUI_SETTINGS_FILE!, JSON.stringify({
    resourceDefaults: { tools: { enabledTools: ["read", "codemode"] }, skills: { enabledSkills } },
  }));
  const commands = ["enabled", "disabled"].map((name) => {
    const directory = join(root, name);
    mkdirSync(directory);
    const filePath = join(directory, "SKILL.md");
    writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\nSkill instructions.\n`);
    return { name: `skill:${name}`, description: `${name} skill`, source: "skill" as const,
      sourceInfo: { path: filePath, source: "cli", scope: "temporary" as const, origin: "top-level" as const } };
  });
  const native = "mcp__t3-code__delegate_task";
  const tools = new Map<string, any>(["read", "write", native].map((name) => [name, {
    name, description: name, parameters: { type: "object", properties: {} }, exposure: "direct",
  }]));
  const definitions = new Map<string, any>();
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
  let active = [...tools.keys()];
  const notifications: string[] = [];
  const pi = {
    getCommands: () => commands,
    getSettings: () => ({ codemode: { mode: "only" } }),
    registerCommand() {},
    registerFlag() {},
    getFlag() {},
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names.filter((name) => tools.has(name)); },
    registerTool: (definition: any) => {
      tools.set(definition.name, definition);
      definitions.set(definition.name, definition);
      active.push(definition.name);
    },
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, mode: "rpc", model: { provider: "test", id: "model" },
    sessionManager: { getBranch: () => [], getSessionId: () => "t3-test-session" },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;

  if (skillsFirst) setupSkillsExtension(pi, ["--no-skills"]);
  await toolsExtension(pi);
  if (!skillsFirst) setupSkillsExtension(pi, ["--no-skills"]);

  async function emit(name: string, event: object = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  }
  const skills = collectLoadedSkills(commands);
  await emit("session_start");
  return { native, active: () => active, ctx, definitions, tools, skills, emit, notifications };
}

describe("T3 tools and skills integration", () => {
  test.each([true, false])("preserves selected skills and native tools with skills-first=%s", async (skillsFirst) => {
    const h = await fixture(skillsFirst, ["enabled"]);
    expect(process.env.T3_PI_RESOURCE_PROFILES).toBe(`t3-v1:${process.pid}`);
    expect(h.active()).toEqual(["read", "codemode", h.native]);
    const options = { skills: [...h.skills] };
    await h.emit("before_agent_start", { systemPromptOptions: options });
    expect(options.skills.map((skill) => skill.name)).toEqual(["enabled"]);
    expect(await h.emit("input", { text: "/skill:disabled" })).toEqual({ action: "handled" });
    expect(await h.emit("input", { text: "/skill:enabled" })).toEqual({ action: "continue" });
    expect(await h.emit("tool_call", { toolName: h.native })).toBeUndefined();
    expect(await h.emit("tool_call", { toolName: "write" })).toMatchObject({ block: true });

    const codemode = h.definitions.get("codemode");
    const entries = [...h.tools.values()];
    const prepared = codemode.prepareLoadout({
      declared: entries, callable: entries, registered: entries,
      getExposure: (name: string) => h.tools.get(name)?.exposure,
      getNamespace: () => undefined,
      getPromptGuidelines: () => [],
    });
    const description = prepared.descriptions.codemode;
    expect(description).toContain(h.native);
    expect(description).not.toContain("tools.write(");
    expect(h.notifications).toHaveLength(1);
  });

  test("retaining T3 tools does not enable any skill in an empty skill selection", async () => {
    const h = await fixture(true, []);
    const options = { skills: [...h.skills] };
    await h.emit("before_agent_start", { systemPromptOptions: options });
    expect(options.skills).toEqual([]);
    expect(await h.emit("input", { text: "/skill:enabled" })).toEqual({ action: "handled" });
    expect(await h.emit("tool_call", { toolName: h.native })).toBeUndefined();
    expect(h.active()).toContain(h.native);
  });
});
