import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(testDir);
const { default: statsExtension } = await import(pathToFileURL(join(packageDir, "index.ts")).href);

function localDayKey(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKey(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return localDayKey(date);
}

function usageEntry(day, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens, cost = 0, provider = "test", model = "model" } = {}) {
  return {
    type: "message",
    timestamp: `${day}T12:00:00.000`,
    message: {
      role: "assistant",
      provider,
      model,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: totalTokens ?? input + output + cacheRead + cacheWrite,
        cost: { total: cost },
      },
    },
  };
}

async function buildPayload(files, args, fixture = {}) {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-stats-payload-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, entries]) =>
        writeFile(join(sessionDir, `${name}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
      ),
    );

    const commands = new Map();
    const eventHandlers = new Map();
    const notifications = [];
    let payload;
    const tools = fixture.tools ?? [];
    const pi = {
      appendEntry(customType, data) { fixture.appendedEntries?.push({ customType, data }); },
      getActiveTools() { return fixture.activeTools ?? tools.map((tool) => tool.name); },
      getAllTools() { return tools; },
      on(name, handler) { eventHandlers.set(name, handler); },
      registerCommand(name, definition) { commands.set(name, definition); },
    };
    statsExtension(pi);

    const ctx = {
      getContextUsage() { return fixture.contextUsage ?? null; },
      getSystemPrompt() { return fixture.systemPrompt ?? ""; },
      sessionManager: {
        getBranch() {
          if (fixture.branchError) throw new Error("branch unavailable");
          return fixture.branch ?? [];
        },
        getLeafId() { return fixture.leafId ?? null; },
        getSessionDir() { return sessionDir; },
        getSessionId() { return "stats-payload-test"; },
      },
      ui: {
        notify(message, level) { notifications.push({ message, level }); },
        setStatus(_key, value) {
          if (value) payload = JSON.parse(value);
        },
      },
    };

    if (fixture.systemPromptOptions) {
      await eventHandlers.get("before_agent_start")?.({
        systemPrompt: fixture.systemPrompt ?? "",
        systemPromptOptions: fixture.systemPromptOptions,
        ...(fixture.messageType === "custom"
          ? { messageType: "custom", message: { customType: "continuation", content: "Continue", display: false } }
          : { messageType: "user", prompt: "test", images: [] }),
      }, ctx);
    }
    if (fixture.resetAfterOptions) await eventHandlers.get("session_start")?.({}, ctx);
    if (fixture.assistantMessage) await eventHandlers.get("message_end")?.({ message: fixture.assistantMessage }, ctx);

    const commandName = fixture.commandName ?? "stats-webui";
    await commands.get(commandName).handler(args, ctx);
    if (commandName !== "stats-webui") return { notifications, payload };
    assert.ok(payload, "stats-webui should publish a payload before clearing its transport status");
    return payload;
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

const sparseFiles = {
  old: [
    usageEntry(dayKey(-20), { input: 50, output: 50, totalTokens: 100, cost: 1, model: "old" }),
    usageEntry(dayKey(-8), { input: 50, output: 50, totalTokens: 100, cost: 2, model: "old" }),
  ],
  currentA: [usageEntry(dayKey(-2), { input: 100, output: 50, cacheRead: 100, totalTokens: 250, cost: 4, model: "a" })],
  currentB: [usageEntry(dayKey(0), { input: 100, output: 50, cacheRead: 300, cacheWrite: 100, totalTokens: 550, cost: 6, model: "b" })],
};

test("range payload uses scoped sessions, nullable-safe formulas, and equal spend windows", async () => {
  const payload = await buildPayload(sparseFiles, "7");

  assert.equal(payload.version, 1);
  assert.equal(payload.sessionCount, 3, "legacy sessionCount remains the workspace file count");
  assert.equal(payload.scopedSessionCount, 2);
  assert.equal(payload.dayCount, 7);
  assert.deepEqual(payload.costInfo, {
    source: "session-recorded",
    status: "complete",
    isEstimate: false,
    ollamaCloudMessageCount: 0,
    unpricedMessageCount: 0,
    warning: null,
  });
  assert.equal(payload.totals.unpricedMessages, 0);
  assert.equal(payload.summary.promptSideTokens, 700);
  assert.equal(payload.summary.cachedInputShare, (400 / 700) * 100);
  assert.equal(payload.summary.effectiveCostPerMillionTokens, 12_500);
  assert.equal(payload.summary.averageCostPerSession, 5);
  assert.equal(payload.summary.averageTokensPerSession, 400);
  assert.equal(payload.summary.spendComparison.windowDays, 7);
  assert.equal(payload.summary.spendComparison.recentCost, 10);
  assert.equal(payload.summary.spendComparison.priorCost, 2);
  assert.equal(payload.summary.spendComparison.changeCost, 8);
  assert.equal(payload.summary.spendComparison.changePercent, 400);
  assert.equal(payload.summary.topModelCostShare, 60);
  assert.equal(payload.summary.topSessionCostShare, 60);
  assert.equal(payload.models.length, 2);
  assert.equal(payload.expensiveSessions.length, 2);
  assert.doesNotMatch(payload.lines.cache.join("\n"), /cache hit|cache savings/i);
  assert.match(payload.lines.cache[0], /^Cached-input share:/);
});

test("Ollama Cloud estimates expose partial coverage instead of reporting token-bearing zero costs as free", async () => {
  const payload = await buildPayload({
    ollama: [
      usageEntry(dayKey(0), { provider: "ollama-cloud", model: "deepseek-v4-flash:0731", input: 1_000, cost: 1 }),
      usageEntry(dayKey(0), { provider: "ollama-cloud", model: "deepseek-v4-flash:0731", output: 500, cost: 0 }),
    ],
    other: [usageEntry(dayKey(0), { provider: "test", model: "free-fixture", input: 100, cost: 0 })],
  }, "all");

  assert.equal(payload.costInfo.source, "session-recorded");
  assert.equal(payload.costInfo.status, "partial");
  assert.equal(payload.costInfo.isEstimate, true);
  assert.equal(payload.costInfo.ollamaCloudMessageCount, 2);
  assert.equal(payload.costInfo.unpricedMessageCount, 1);
  assert.match(payload.costInfo.warning, /recorded estimates/);
  assert.match(payload.costInfo.warning, /1 token-bearing message has no recorded cost/);
  assert.equal(payload.totals.cost, 1);
  assert.equal(payload.totals.unpricedMessages, 1);
  assert.equal(payload.daily.at(-1).unpricedMessages, 1);

  const ollamaModel = payload.models.find((model) => model.model === "ollama-cloud/deepseek-v4-flash:0731");
  assert.equal(ollamaModel.unpricedMessages, 1);
  assert.match(payload.lines.graph.join("\n"), /\$1\.000 recorded \+ unavailable/);
  assert.match(payload.lines.modelComparison.join("\n"), /unavailable\/1M tok/);
  assert.match(payload.lines.expensiveSessions.join("\n"), /recorded \+ unavailable/);
});

test("terminal stats shows one report-level Ollama Cloud cost warning", async () => {
  const result = await buildPayload({
    ollama: [usageEntry(dayKey(0), { provider: "ollama-cloud", model: "deepseek-v4-flash:0731", input: 1_000, cost: 0 })],
  }, "all", { commandName: "stats" });

  assert.equal(result.notifications.length, 1);
  const output = result.notifications[0].message;
  assert.equal((output.match(/Cost note:/g) ?? []).length, 1);
  assert.match(output, /1 token-bearing message has no recorded cost/);
  assert.match(output, /unavailable/);
  assert.doesNotMatch(output, /\$0\.000/);
});

test("Ollama Cloud non-zero recorded costs remain estimates without making the total partial", async () => {
  const payload = await buildPayload({
    ollama: [usageEntry(dayKey(0), { provider: "ollama-cloud", model: "deepseek-v4-flash:0731", input: 1_000, cost: 1 })],
  }, "all");

  assert.equal(payload.costInfo.status, "complete");
  assert.equal(payload.costInfo.isEstimate, true);
  assert.equal(payload.costInfo.ollamaCloudMessageCount, 1);
  assert.equal(payload.costInfo.unpricedMessageCount, 0);
  assert.match(payload.costInfo.warning, /may differ from current pricing/);
  assert.equal(payload.totals.unpricedMessages, 0);
});

test("all scope spans every local calendar day between sparse usage records", async () => {
  const payload = await buildPayload(sparseFiles, "all");

  assert.equal(payload.dayCount, 21);
  assert.equal(payload.daily.length, 21);
  assert.equal(payload.daily[0].day, dayKey(-20));
  assert.equal(payload.daily.at(-1).day, dayKey(0));
  assert.equal(payload.daily.find((day) => day.day === dayKey(-19)).total, 0);
  assert.equal(payload.scopedSessionCount, 3);
  assert.equal(payload.summary.spendComparison.windowDays, 7);
  assert.equal(payload.summary.spendComparison.recentCost, 10);
  assert.equal(payload.summary.spendComparison.priorCost, 2);
});

test("usage after the UTC date boundary stays on the local calendar day", async () => {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    const timestamp = new Date();
    timestamp.setHours(22, 19, 0, 0);
    const expectedDay = localDayKey(timestamp);
    assert.notEqual(timestamp.toISOString().slice(0, 10), expectedDay);

    const entry = usageEntry(expectedDay, { input: 10, totalTokens: 10, cost: 1 });
    entry.timestamp = timestamp.toISOString();
    const files = { boundary: [entry] };
    const allPayload = await buildPayload(files, "all");
    const todayPayload = await buildPayload(files, "1");

    for (const payload of [allPayload, todayPayload]) {
      assert.equal(payload.dayCount, 1);
      assert.equal(payload.daily[0].day, expectedDay);
      assert.equal(payload.daily[0].total, 10);
      assert.equal(payload.expensiveSessions[0].day, expectedDay);
    }
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("local day ranges cross daylight-saving changes without skipping dates", async () => {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    const payload = await buildPayload({
      before: [usageEntry("2026-03-07", { input: 1, totalTokens: 1 })],
      after: [usageEntry("2026-03-09", { input: 1, totalTokens: 1 })],
    }, "all");

    assert.deepEqual(payload.daily.map((day) => day.day), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("zero denominators produce finite values or null, never NaN or Infinity", async () => {
  const payload = await buildPayload({ zero: [usageEntry(dayKey(0))] }, "all");

  assert.equal(payload.scopedSessionCount, 1);
  assert.equal(payload.summary.cachedInputShare, null);
  assert.equal(payload.summary.effectiveCostPerMillionTokens, null);
  assert.equal(payload.summary.averageCostPerSession, 0);
  assert.equal(payload.summary.averageTokensPerSession, 0);
  assert.equal(payload.summary.spendComparison.changePercent, null);
  assert.equal(payload.summary.topModelCostShare, null);
  assert.equal(payload.summary.topSessionCostShare, null);
  assert.doesNotMatch(JSON.stringify(payload), /NaN|Infinity/);
});

test("all scope ignores future-dated records instead of materializing an unbounded calendar range", async () => {
  const payload = await buildPayload({
    current: [usageEntry(dayKey(-1), { input: 10, totalTokens: 10, cost: 1 })],
    future: [usageEntry("9999-01-01", { input: 10, totalTokens: 10, cost: 1 })],
  }, "all");

  assert.equal(payload.daily[0].day, dayKey(-1));
  assert.equal(payload.daily.at(-1).day, dayKey(0));
  assert.equal(payload.dayCount, 2);
  assert.equal(payload.scopedSessionCount, 1);
  assert.equal(payload.totals.cost, 1);
});

test("structured prompt context has exact calibrated totals, semantic sources, bounded inventory, and actual usage", async () => {
  const tools = Array.from({ length: 15 }, (_, index) => ({
    name: `tool-${String(index).padStart(2, "0")}`,
    description: `Tool ${index} description ${"x".repeat(220)}`,
    parameters: {
      type: "object",
      properties: { [`PRIVATE_SCHEMA_FIELD_${index}`]: { type: "string" } },
      required: [`PRIVATE_SCHEMA_FIELD_${index}`],
    },
  }));
  const toolPromptLines = Array.from({ length: 27 }, (_, index) => `- prompt-tool-${index}: safe summary`).join("\n");
  const skillPrompt = Array.from({ length: 12 }, (_, index) => `
<skill>
<name>skill-${index}</name>
<description>Skill ${index} description</description>
<location>/private/skills/skill-${index}/SKILL.md</location>
</skill>`).join("");
  const systemPrompt = `Available tools:\n${toolPromptLines}\n\nIn addition to the tools above
# APPEND_SYSTEM.md
RAW_SYSTEM_PROMPT_SECRET
<available_skills>${skillPrompt}
</available_skills>
Current date: 2026-08-02
Current working directory: /workspace/project`;
  const contextFiles = Array.from({ length: 30 }, (_, index) => ({
    path: index === 0 ? "/workspace/project/AGENTS.md" : `/private/context-${index}.md`,
    content: `RAW_CONTEXT_SECRET_${index}`,
  }));
  const branch = [
    { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "RAW_USER_MESSAGE_SECRET" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "test", model: "fixture", content: "RAW_ASSISTANT_MESSAGE_SECRET", toolCalls: [{ name: "tool-00", arguments: { secret: "RAW_TOOL_ARGUMENT_SECRET" } }] } },
    { type: "message", id: "t1", parentId: "a1", timestamp: new Date().toISOString(), message: { role: "tool", name: "tool-00", content: "RAW_TOOL_RESULT_SECRET" } },
  ];
  const payload = await buildPayload({ current: [usageEntry(dayKey(0), { input: 1, totalTokens: 1 })] }, "all", {
    systemPrompt,
    tools,
    branch,
    leafId: "t1",
    contextUsage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
    systemPromptOptions: {
      selectedTools: ["tool-00"],
      toolSnippets: { "tool-00": "safe summary" },
      appendSystemPrompt: "RAW_SYSTEM_PROMPT_SECRET",
      promptGuidelines: ["one", "two"],
      contextFiles,
      skills: Array.from({ length: 12 }, (_, index) => ({
        name: `skill-${index}`,
        description: `Skill ${index} description`,
        filePath: `/private/skills/skill-${index}/SKILL.md`,
      })),
    },
  });

  assert.equal(payload.version, 1);
  assert.ok(payload.promptContext);
  const { initialPrompt, snapshot, currentContext } = payload.promptContext;
  assert.equal(initialPrompt.totalTokens, payload.promptEstimate.total);
  assert.equal(initialPrompt.components.reduce((sum, component) => sum + component.tokens, 0), initialPrompt.totalTokens);
  assert.ok(Math.abs(initialPrompt.components.reduce((sum, component) => sum + (component.percent ?? 0), 0) - 100) < 1e-9);
  assert.ok(initialPrompt.components.length <= 24);
  assert.equal(new Set(initialPrompt.components.map((component) => component.id)).size, initialPrompt.components.length);
  assert.ok(initialPrompt.components.every((component) => typeof component.kind === "string" && typeof component.id === "string"));
  assert.ok(initialPrompt.components.some((component) => component.id === "other-omitted"));

  assert.deepEqual(currentContext.usage, { tokens: 50_000, contextWindow: 100_000, percent: 50 });
  assert.equal(currentContext.breakdown.reconstruction, "complete");
  assert.equal(currentContext.breakdown.actualMinusEstimatedTokens, 50_000 - currentContext.breakdown.estimatedTotalTokens);
  assert.equal(currentContext.breakdown.sources.reduce((sum, source) => sum + source.estimatedTokens, 0), currentContext.breakdown.estimatedTotalTokens);
  assert.ok(Math.abs(currentContext.breakdown.sources.reduce((sum, source) => sum + (source.percent ?? 0), 0) - 100) < 1e-9);
  assert.ok(currentContext.breakdown.sources.length <= 24);
  assert.ok(currentContext.breakdown.sources.some((source) => source.kind === "user-messages"));
  assert.ok(currentContext.breakdown.sources.some((source) => source.kind === "assistant-tool-calls"));
  assert.ok(currentContext.breakdown.sources.some((source) => source.kind === "tool-results"));

  assert.deepEqual([snapshot.tools.items.length, snapshot.tools.omittedCount], [12, 3]);
  assert.deepEqual([snapshot.toolPromptEntries.names.length, snapshot.toolPromptEntries.omittedCount], [24, 3]);
  assert.deepEqual([snapshot.skills.items.length, snapshot.skills.omittedCount], [10, 2]);
  assert.deepEqual([snapshot.contextFiles.items.length, snapshot.contextFiles.omittedCount], [8, 22]);
  assert.equal(snapshot.metadata.cwdDisplay, "project");
  assert.equal(snapshot.metadata.extraGuidelineCount, 2);
  assert.equal(snapshot.contextFiles.items.find((item) => item.displayPath === "AGENTS.md")?.chars, "RAW_CONTEXT_SECRET_0".length);
  assert.ok(snapshot.tools.items.every((item) => item.description === null || item.description.length <= 160));

  const structuredJson = JSON.stringify(payload.promptContext);
  for (const forbidden of [
    "RAW_SYSTEM_PROMPT_SECRET",
    "RAW_CONTEXT_SECRET",
    "RAW_USER_MESSAGE_SECRET",
    "RAW_ASSISTANT_MESSAGE_SECRET",
    "RAW_TOOL_ARGUMENT_SECRET",
    "RAW_TOOL_RESULT_SECRET",
    "PRIVATE_SCHEMA_FIELD",
    "/private/skills/",
    "/private/context-",
  ]) {
    assert.doesNotMatch(structuredJson, new RegExp(forbidden));
  }
  assert.ok(structuredJson.length < 40_000, `structured promptContext should stay bounded, got ${structuredJson.length} bytes`);
  assert.ok(Array.isArray(payload.lines.promptInjection) && payload.lines.promptInjection.length > 0);
  assert.ok(Array.isArray(payload.lines.promptDetailed) && payload.lines.promptDetailed.length > 0);
  assert.ok(Array.isArray(payload.lines.tokenBreakdown) && payload.lines.tokenBreakdown.length > 0);
});

test("structured prompt context preserves real zeroes, rejects malformed usage, and reports reconstruction failure", async () => {
  const zeroPayload = await buildPayload({ zero: [usageEntry(dayKey(0))] }, "all", {
    contextUsage: { tokens: 0, contextWindow: 0, percent: 0 },
    branchError: true,
  });
  assert.deepEqual(zeroPayload.promptContext.currentContext.usage, { tokens: 0, contextWindow: 0, percent: 0 });
  assert.equal(zeroPayload.promptContext.currentContext.breakdown.reconstruction, "unavailable");
  assert.equal(zeroPayload.promptContext.currentContext.breakdown.actualMinusEstimatedTokens, 0);

  const malformedPayload = await buildPayload({ zero: [usageEntry(dayKey(0))] }, "all", {
    contextUsage: { tokens: Number.NaN, contextWindow: -1, percent: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(malformedPayload.promptContext.currentContext.usage, { tokens: null, contextWindow: null, percent: null });
  assert.doesNotMatch(JSON.stringify(malformedPayload), /NaN|Infinity/);
});

test("structured context paths use portable relative or basename-only display values", async () => {
  const payload = await buildPayload({ zero: [usageEntry(dayKey(0))] }, "all", {
    systemPrompt: "Current working directory: C:\\Users\\private-user\\project",
    systemPromptOptions: {
      contextFiles: [
        { path: "C:\\Users\\private-user\\project\\docs\\AGENTS.md", content: "inside" },
        { path: "D:\\private\\external.md", content: "outside" },
        { path: "nested/guide.md", content: "relative" },
      ],
    },
  });

  assert.equal(payload.promptContext.snapshot.metadata.cwdDisplay, "project");
  assert.deepEqual(
    payload.promptContext.snapshot.contextFiles.items.map((item) => item.displayPath),
    ["docs\\AGENTS.md", "external.md", "nested/guide.md"],
  );
  assert.doesNotMatch(JSON.stringify(payload.promptContext), /private-user|D:\\\\private/);
});

test("Pi 1.2 custom starts retain prompt inventory but do not calibrate a nonexistent user prompt", async () => {
  const fixture = {
    systemPrompt: "Starting instructions. ".repeat(200),
    systemPromptOptions: { skills: [{ name: "current-skill", description: "Current", filePath: "/skills/current/SKILL.md" }] },
    assistantMessage: { role: "assistant", provider: "test", model: "test", usage: { input: 1200 } },
    appendedEntries: [],
  };
  await buildPayload({}, "all", fixture);
  assert.equal(fixture.appendedEntries.length, 1, "a real first user turn should still produce a calibration sample");
  fixture.appendedEntries = [];
  const payload = await buildPayload({}, "all", { ...fixture, messageType: "custom" });
  assert.equal(fixture.appendedEntries.length, 0, "custom-message usage must not calibrate user prompt estimates");
  assert.equal(payload.promptContext.snapshot.skills.items[0].name, "current-skill");
});

test("session start clears stale system prompt options before building structured inventory", async () => {
  const payload = await buildPayload({ zero: [usageEntry(dayKey(0))] }, "all", {
    systemPrompt: "plain current prompt",
    systemPromptOptions: {
      contextFiles: [{ path: "/private/stale-context.md", content: "STALE_CONTEXT_CONTENT" }],
      skills: [{ name: "stale-skill", description: "stale", filePath: "/private/stale/SKILL.md" }],
    },
    resetAfterOptions: true,
  });

  assert.equal(payload.promptContext.snapshot.contextFiles.totalCount, 0);
  assert.equal(payload.promptContext.snapshot.skills.totalCount, 0);
  assert.doesNotMatch(JSON.stringify(payload.promptContext), /stale-context|stale-skill|STALE_CONTEXT_CONTENT/);
});

test("structured prompt context is deterministic apart from transport metadata", async () => {
  const fixture = {
    systemPrompt: "Current date: 2026-08-02\nCurrent working directory: /workspace/project\nStable prompt",
    contextUsage: { tokens: 123, contextWindow: 456, percent: 27 },
    tools: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
  };
  const files = { current: [usageEntry(dayKey(0), { input: 1, totalTokens: 1 })] };
  const first = await buildPayload(files, "all", fixture);
  const second = await buildPayload(files, "all", fixture);
  assert.deepEqual(first.promptContext, second.promptContext);
});

test("README describes token-share semantics without unsupported savings claims", async () => {
  const readme = await readFile(join(packageDir, "README.md"), "utf8");
  assert.match(readme, /Cached-input share/);
  assert.doesNotMatch(readme, /estimated cache savings|Cache hit rate:/i);
});
