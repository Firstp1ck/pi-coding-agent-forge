import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextWithSystemEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolsExtension from "../index";

type Messages = ContextWithSystemEvent["messages"];
type Handler = (event: any, ctx: ExtensionContext) => any;

let directory: string;
let previousSettingsFile: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pi-tools-enforcement-"));
  previousSettingsFile = process.env.PI_WEBUI_SETTINGS_FILE;
  process.env.PI_WEBUI_SETTINGS_FILE = path.join(directory, "settings.json");
});

afterEach(async () => {
  if (previousSettingsFile === undefined) delete process.env.PI_WEBUI_SETTINGS_FILE;
  else process.env.PI_WEBUI_SETTINGS_FILE = previousSettingsFile;
  await rm(directory, { recursive: true, force: true });
});

async function saveDefaults(enabledTools: string[] | null, modelProfiles: unknown[] = []) {
  await writeFile(process.env.PI_WEBUI_SETTINGS_FILE!, JSON.stringify({
    resourceDefaults: { tools: { enabledTools }, modelProfiles },
  }));
}

function harness(mode = "tui") {
  const handlers = new Map<string, Handler>();
  const available = new Set(["read", "mcp", "mcpScript"]);
  let active = [...available];
  let branch: unknown[] = [];
  const notifications: string[] = [];
  const updates: string[][] = [];
  const ctx = {
    mode,
    model: { provider: "test", id: "model" },
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  toolsExtension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand() {},
    getAllTools: () => [...available].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names.filter((name) => available.has(name));
      updates.push([...active]);
    },
  } as never);
  return {
    ctx, notifications, updates,
    active: () => [...active],
    emit: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
    register: (name: string) => { available.add(name); active.push(name); },
    activate: (names: string[]) => { active = [...new Set([...active, ...names])]; },
    deactivate: (name: string) => { active = active.filter((entry) => entry !== name); },
    setBranch: (data: unknown) => { branch = [{ type: "custom", customType: "webui-tools-config", data }]; },
  };
}

function transcript(names: string[]): Messages {
  return [
    {
      role: "system", content: "Keep this prompt", timestamp: 1,
      toolsAdded: names.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })),
    },
    { role: "user", content: "Continue", timestamp: 2 },
  ];
}

function currentNames(messages: Messages): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names];
}

async function request(h: ReturnType<typeof harness>, messages: Messages) {
  const result = await h.emit("context_with_system", { messages });
  return (result?.messages ?? messages) as Messages;
}

describe("saved tool selection enforcement", () => {
  test("removes MCP reactivation before the next run", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    expect(h.active()).toEqual(["read"]);
    h.activate(["mcp"]);
    h.register("context7_query-docs");
    await h.emit("before_agent_start");
    expect(h.active()).toEqual(["read"]);
  });

  test("filters request declarations after late registration without rewriting history", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start");
    h.activate(["mcp"]);
    h.register("context7_query-docs");
    const messages = transcript(h.active());
    const original = structuredClone(messages);
    const filtered = await request(h, messages);
    expect(h.active()).toEqual(["read"]);
    expect(currentNames(filtered)).toEqual(["read"]);
    expect(messages).toEqual(original);
    expect(filtered.slice(0, messages.length)).toEqual(messages);
    expect(filtered.at(-1)).toMatchObject({
      role: "system", content: "", toolsRemoved: [{ name: "mcp" }, { name: "context7_query-docs" }],
    });
  });

  test("enforces every continuation and blocks reactivation after request preparation", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    for (let turn = 0; turn < 3; turn++) {
      h.activate(["mcp"]);
      expect(currentNames(await request(h, transcript(h.active())))).toEqual(["read"]);
      h.activate(["mcp"]);
      expect(await h.emit("tool_call", { toolName: "mcp" })).toMatchObject({ block: true });
      expect(await h.emit("tool_call", { toolName: "read" })).toBeUndefined();
    }
  });

  test("retains late-arriving selected tools and does not reactivate selected lazy tools", async () => {
    await saveDefaults(["read", "context7_query-docs"]);
    const h = harness();
    await h.emit("session_start");
    h.register("context7_query-docs");
    expect(currentNames(await request(h, transcript(h.active())))).toEqual(["read", "context7_query-docs"]);
    expect(await h.emit("tool_call", { toolName: "context7_query-docs" })).toBeUndefined();
    h.deactivate("context7_query-docs");
    await h.emit("before_agent_start");
    await request(h, transcript(h.active()));
    expect(h.active()).toEqual(["read"]);
  });

  test("an explicit empty selection blocks all tools", async () => {
    await saveDefaults([]);
    const h = harness();
    await h.emit("session_start");
    h.activate(["mcp"]);
    h.register("late_tool");
    expect(currentNames(await request(h, transcript(h.active())))).toEqual([]);
    expect(h.active()).toEqual([]);
    expect(await h.emit("tool_call", { toolName: "late_tool" })).toMatchObject({ block: true });
  });

  test("runtime inheritance leaves dynamic activation and calls unchanged", async () => {
    await saveDefaults(null);
    const h = harness();
    await h.emit("session_start");
    h.register("late_tool");
    h.deactivate("read");
    const active = h.active();
    const messages = transcript(active);
    await h.emit("before_agent_start");
    expect(await request(h, messages)).toBe(messages);
    expect(h.active()).toEqual(active);
    expect(await h.emit("tool_call", { toolName: "late_tool" })).toBeUndefined();
  });

  test("session selection wins over model and global selections, and inheritance clears it", async () => {
    await saveDefaults(["read"], [{ provider: "test", modelId: "model", tools: { enabledTools: ["read", "mcp"] } }]);
    const h = harness();
    h.setBranch({ version: 2, mode: "explicit", enabledTools: [] });
    await h.emit("session_start");
    expect(await h.emit("tool_call", { toolName: "mcp" })).toMatchObject({ block: true });
    h.setBranch({ version: 2, mode: "inherit" });
    await h.emit("session_tree");
    expect(h.active()).toEqual(["read", "mcp"]);
    expect(await h.emit("tool_call", { toolName: "mcp" })).toBeUndefined();
    h.ctx.model = { provider: "test", id: "other" } as never;
    await h.emit("model_select", { model: h.ctx.model });
    expect(await h.emit("tool_call", { toolName: "mcp" })).toMatchObject({ block: true });
  });

  test("clearing the last override restores runtime behavior", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    await saveDefaults(null);
    await h.emit("session_tree");
    h.register("late_tool");
    await h.emit("before_agent_start");
    expect(h.active()).toContain("late_tool");
    expect(await h.emit("tool_call", { toolName: "mcp" })).toBeUndefined();
  });

  test("keeps the last valid policy after a settings read failure", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    await writeFile(process.env.PI_WEBUI_SETTINGS_FILE!, "invalid JSON");
    await h.emit("session_tree");
    h.activate(["mcp"]);
    expect(currentNames(await request(h, transcript(h.active())))).toEqual(["read"]);
    expect(await h.emit("tool_call", { toolName: "mcp" })).toMatchObject({ block: true });
    expect(h.notifications).toHaveLength(1);
  });

  test.each(["rpc", "json", "print"])("does not own tool policy in %s mode", async (mode: string) => {
    await saveDefaults([]);
    const h = harness(mode);
    await h.emit("session_start");
    h.register("late_tool");
    const active = h.active();
    const messages = transcript(active);
    await h.emit("before_agent_start");
    expect(await request(h, messages)).toBe(messages);
    expect(h.active()).toEqual(active);
    expect(await h.emit("tool_call", { toolName: "mcp" })).toBeUndefined();
    expect(h.updates).toHaveLength(0);
  });

  test("does not enforce stale selections after shutdown", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    await h.emit("session_shutdown");
    h.activate(["mcp"]);
    const messages = transcript(h.active());
    await h.emit("before_agent_start");
    expect(await request(h, messages)).toBe(messages);
    expect(await h.emit("tool_call", { toolName: "mcp" })).toBeUndefined();
  });

  test("does not append redundant removals or reset unchanged active tools", async () => {
    await saveDefaults(["read"]);
    const h = harness();
    await h.emit("session_start");
    const messages = transcript(["read", "mcp"]);
    messages.push({ role: "system", content: "", toolsRemoved: [{ name: "mcp" }], timestamp: 3 });
    expect(await request(h, messages)).toBe(messages);
    expect(h.updates).toHaveLength(1);
    messages.push(...transcript(["mcp"]));
    expect(currentNames(await request(h, messages))).toEqual(["read"]);
  });
});
