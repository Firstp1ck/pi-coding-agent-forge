import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initializeT3ResourceProfilesCompatibility, isLegacyT3ResourceLaunch, scopeDiscoveryTool } from "../src/t3-resource-profiles-compat.ts";
import { isT3NativeTool } from "../src/t3-native-tools.ts";

const chat = {
  mode: "rpc",
  extensions: ["/tmp/t3-provider-cache/pi-t3-mcp-extension.ts"],
};
const environment = {
  T3_MCP_URL: "http://127.0.0.1:3773/api/mcp",
  T3_MCP_BEARER_TOKEN: "test-only-not-a-credential",
  T3_PI_RUNTIME_MODE: "full-access",
};

describe("legacy T3 resource-profile ownership", () => {
  it("leaves TUI startup synchronous and does not register compatibility hooks", () => {
    const env = { ...environment };
    const pi = { on() { throw new Error("Unexpected TUI hook"); }, registerTool() { throw new Error("Unexpected TUI tool"); } };
    assert.equal(initializeT3ResourceProfilesCompatibility(pi, { ...chat, mode: "tui" }, env), undefined);
    assert.equal(env.T3_PI_RESOURCE_PROFILES, undefined);
  });

  it("initializes native discovery through the package for eligible legacy chat", async () => {
    const registered = [];
    const env = { ...environment };
    const pi = {
      on() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      registerFlag() {},
      getFlag() {},
      registerTool(tool) { registered.push(tool.name); },
    };
    await initializeT3ResourceProfilesCompatibility(pi, chat, env);
    assert.equal(env.T3_PI_RESOURCE_PROFILES, `t3-v1:${process.pid}`);
    assert.deepEqual(registered.sort(), ["codemode", "tool_search"]);
  });

  it("recognizes normal installed T3 chat launches", () => {
    assert.equal(isLegacyT3ResourceLaunch(chat, environment), true);
    assert.equal(isLegacyT3ResourceLaunch({ ...chat, extensions: ["C:\\t3\\pi-t3-mcp-extension.ts"] }, environment), true);
  });

  for (const mode of ["tui", "print", "json", undefined]) {
    it(`does not own ${mode ?? "unspecified"} mode`, () => {
      assert.equal(isLegacyT3ResourceLaunch({ ...chat, mode }, environment), false);
    });
  }

  for (const flag of ["noSession", "noExtensions", "noTools"]) {
    it(`does not own a helper with ${flag}`, () => {
      assert.equal(isLegacyT3ResourceLaunch({ ...chat, [flag]: true }, environment), false);
    });
  }

  it("requires the explicitly injected T3 bridge", () => {
    for (const extensions of [undefined, [], ["/tmp/other-extension.ts"], ["/tmp/pi-t3-mcp-extension.ts.backup"]]) {
      assert.equal(isLegacyT3ResourceLaunch({ ...chat, extensions }, environment), false);
    }
  });

  it("requires the T3 launch environment", () => {
    for (const key of ["T3_MCP_URL", "T3_MCP_BEARER_TOKEN", "T3_PI_RUNTIME_MODE"]) {
      assert.equal(isLegacyT3ResourceLaunch(chat, { ...environment, [key]: undefined }), false);
    }
    assert.equal(isLegacyT3ResourceLaunch(chat, { ...environment, T3_PI_RUNTIME_MODE: "unknown" }), false);
  });

  it("does not replace new-protocol or inherited markers", () => {
    for (const marker of ["t3-v1", `t3-v1:${process.pid}`, `t3-v1:${process.pid + 1}`, "", "invalid"]) {
      assert.equal(isLegacyT3ResourceLaunch(chat, { ...environment, T3_PI_RESOURCE_PROFILES: marker }), false);
    }
  });
});

describe("T3 native namespace matching", () => {
  it("accepts only the canonical and normalized T3 namespace with a tool suffix", () => {
    for (const name of ["mcp__t3-code__delegate_task", "mcp__t3_code__preview_status"]) {
      assert.equal(isT3NativeTool(name), true);
    }
    for (const name of ["delegate_task", "mcp__other__delegate_task", "mcp__t3-code_extra__task_status",
      "mcp__t3_code_extra__task_status", "mcp__t3-code__", "mcp__t3_code__", "mcp__t3_code__has space"]) {
      assert.equal(isT3NativeTool(name), false);
    }
  });
});

describe("scoped native discovery", () => {
  const tools = [{ name: "read" }, { name: "write" }, { name: "disabled_mcp" }];
  const loadout = { declared: tools, callable: tools, registered: tools, getExposure: () => "deferred" };
  const context = { tools, executeTool: () => {}, modelRegistry: {} };

  function definition(observe = () => {}) {
    return {
      name: "codemode",
      parameters: { type: "object", properties: {} },
      defaultActive: false,
      prepareLoadout: (value) => {
        observe(value);
        return { descriptions: { codemode: value.callable.map((tool) => tool.name).join(",") } };
      },
      execute: async (_id, _params, _signal, _update, ctx) => ctx,
    };
  }

  it("filters declared, callable, and registered catalogs without changing the input", () => {
    let received;
    const original = definition((value) => { received = value; });
    const selected = new Set(["read"]);
    const scoped = scopeDiscoveryTool(original, () => selected, async () => selected);
    assert.deepEqual(scoped.prepareLoadout(loadout), { descriptions: { codemode: "read" } });
    for (const key of ["declared", "callable", "registered"]) {
      assert.deepEqual(received[key], [{ name: "read" }]);
      assert.equal(loadout[key], tools);
    }
    assert.equal(received.getExposure, loadout.getExposure);
    assert.equal(scoped.parameters, original.parameters);
    assert.equal(scoped.defaultActive, false);
  });

  it("refreshes selection at execution and retains the native context methods", async () => {
    const scoped = scopeDiscoveryTool(definition(), () => new Set(["read"]), async () => new Set(["write"]));
    const result = await scoped.execute("test", {}, undefined, undefined, context);
    assert.deepEqual(result.tools, [{ name: "write" }]);
    assert.equal(result.executeTool, context.executeTool);
    assert.equal(result.modelRegistry, context.modelRegistry);
    assert.equal(context.tools, tools);
  });

  it("retains non-enumerable SDK methods and lazy context getters", async () => {
    let model = { id: "first" };
    const executeTool = async (name) => ({ name });
    const nativeContext = Object.defineProperties({}, {
      tools: { get: () => tools },
      executeTool: { value: executeTool },
      model: { get: () => model },
    });
    const selected = new Set(["read"]);
    const scoped = scopeDiscoveryTool(definition(), () => selected, async () => selected);
    const result = await scoped.execute("test", {}, undefined, undefined, nativeContext);
    assert.equal(result.executeTool, executeTool);
    assert.deepEqual(await result.executeTool("read"), { name: "read" });
    assert.deepEqual(result.tools, [{ name: "read" }]);
    model = { id: "second" };
    assert.equal(result.model, model);
    assert.equal(nativeContext.tools, tools);
  });

  it("leaves runtime inheritance untouched", async () => {
    let received;
    const scoped = scopeDiscoveryTool(definition((value) => { received = value; }), () => null, async () => null);
    scoped.prepareLoadout(loadout);
    assert.equal(received.callable, tools);
    assert.equal(await scoped.execute("test", {}, undefined, undefined, context), context);
  });

  it("an empty selection exposes no catalog entries", async () => {
    const scoped = scopeDiscoveryTool(definition(), () => new Set(), async () => new Set());
    assert.deepEqual(scoped.prepareLoadout(loadout), { descriptions: { codemode: "" } });
    const result = await scoped.execute("test", {}, undefined, undefined, context);
    assert.deepEqual(result.tools, []);
  });

  it("retains T3 tools in every discovery catalog even with an empty Pi selection", async () => {
    const native = [
      { name: "mcp__t3-code__delegate_task", exposure: "direct" },
      { name: "mcp__t3_code__preview_open", exposure: "deferred" },
      { name: "mcp__t3_code__withdrawn", exposure: "hidden" },
    ];
    const entries = [...tools, ...native, { name: "mcp__t3_code_extra__delegate_task" }];
    let received;
    const scoped = scopeDiscoveryTool(definition((value) => { received = value; }), () => new Set(), async () => new Set());
    scoped.prepareLoadout({ ...loadout, declared: entries, callable: entries, registered: entries });
    for (const key of ["declared", "callable", "registered"]) assert.deepEqual(received[key], native);
    const result = await scoped.execute("test", {}, undefined, undefined, { ...context, tools: entries });
    assert.deepEqual(result.tools, native);
    assert.equal(result.tools[2].exposure, "hidden");
    assert.deepEqual(entries.slice(0, tools.length), tools);
  });

  it("applies refreshed Pi selections while retaining late T3 registrations", async () => {
    const selected = new Set(["read"]);
    const entries = [...tools];
    const scoped = scopeDiscoveryTool(definition(), () => selected, async () => new Set(["write"]));
    entries.push({ name: "mcp__t3_code__task_status" });
    const result = await scoped.execute("test", {}, undefined, undefined, { ...context, tools: entries });
    assert.deepEqual(result.tools.map((tool) => tool.name), ["write", "mcp__t3_code__task_status"]);
    assert.deepEqual([...selected], ["read"]);
  });

  it("fails before native execution when no policy can be resolved", async () => {
    let executed = false;
    const original = { ...definition(), execute: async () => { executed = true; } };
    const scoped = scopeDiscoveryTool(original, () => new Set(), async () => { throw new Error("policy unavailable"); });
    await assert.rejects(scoped.execute("test", {}, undefined, undefined, context), /policy unavailable/);
    assert.equal(executed, false);
  });
});
