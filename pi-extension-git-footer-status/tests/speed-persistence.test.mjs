// Regression coverage for cumulative output and average speed in both footers.
//
// Run with:
//   node --test pi-extension-git-footer-status/tests/speed-persistence.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const testRoot = await mkdtemp(path.join(tmpdir(), "git-footer-speed-"));
process.env.PI_GIT_FOOTER_SETTINGS_FILE = path.join(testRoot, "visibility.json");
process.env.PI_GIT_FOOTER_AUTO_REFRESH_MS = "0";
process.env.PI_GIT_FOOTER_FETCH = "0";
process.env.PI_GIT_FOOTER_DISABLE_PROMPT_ESTIMATE = "1";

const envFlag = (name, fallback) => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw);
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@firstpick/pi-utils") return { url: "virtual:pi-utils", shortCircuit: true };
    if (specifier === "@earendil-works/pi-tui") return { url: "virtual:pi-tui", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:pi-utils") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const collectInitialPromptCalibration = () => null;
          export const createInitialPromptEstimateService = () => ({
            refresh: async () => ({ status: "ok" }),
            getSnapshot: () => null,
            getFallbackSnapshot: () => null,
            clear: () => {},
          });
          export const envFlag = ${envFlag.toString()};
          export const normalizeTimestampMs = (timestamp) => timestamp < 1e11 ? timestamp * 1000 : timestamp > 1e14 ? Math.floor(timestamp / 1000) : timestamp;
          export const estimateStableInitialPromptFromPiContext = async () => null;
          export const estimateTokensFromCharCount = (chars) => Math.ceil(chars / 4);
          export const formatTokens = (n) => String(n);
          export const formatUserPath = (p) => String(p);
          export const pathExists = () => false;
        `,
      };
    }
    if (url === "virtual:pi-tui") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export class Container {
            addChild() {}
            render() { return []; }
            invalidate() {}
          }
          export const Key = { ctrl: (key) => \`ctrl+\${key}\` };
          export const matchesKey = (data, key) => data === key;
          export class SettingsList {
            handleInput() {}
            render() { return []; }
            invalidate() {}
          }
          export const truncateToWidth = (s) => String(s);
          export const visibleWidth = (s) => String(s).length;
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: gitFooterStatus } = await import("../index.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createHarness = (entries = []) => {
  let nativeFooter = null;
  const handlers = new Map();
  const commands = new Map();
  const statuses = [];
  const pi = {
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 1, stdout: "", stderr: "not a git repository", killed: false }),
  };

  gitFooterStatus(pi);

  const ctx = {
    hasUI: true,
    mode: "rpc",
    cwd: testRoot,
    model: null,
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ contextWindow: 128_000, percent: 0 }),
    sessionManager: {
      getEntries: () => entries,
      getSessionDir: () => testRoot,
      getSessionId: () => "speed-test",
    },
    ui: {
      setFooter(factory) {
        nativeFooter = factory?.(
          { requestRender() {} },
          { fg: (_tone, text) => text },
          {
            onBranchChange: () => () => {},
            getGitBranch: () => null,
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => new Map(),
          },
        ) ?? null;
      },
      notify() {},
      setStatus(key, value) {
        statuses.push({ key, value });
      },
    },
  };

  const emit = async (event, payload = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };

  const latestSpeedCard = () => {
    const entry = statuses.findLast(({ key, value }) => key === "git-footer-webui" && typeof value === "string");
    assert.ok(entry, "expected a published WebUI footer payload");
    const payload = JSON.parse(entry.value);
    return payload.main.find((chip) => chip.key === "speed");
  };

  const runVisibility = async (args) => {
    const command = commands.get("git-footer-visibility");
    assert.ok(command, "git-footer-visibility command should be registered");
    await command.handler(args, ctx);
  };

  const nativeSpeedValue = () => {
    assert.ok(nativeFooter, "expected a native footer component");
    const line = nativeFooter.render(400)[0];
    const match = line.match(/⚡ (\d+ tok @ (?:—|[\d.]+) tok\/s(?: · (?:avg|1%|max) [\d.]+)*)/);
    assert.ok(match, `expected a native speed item in ${line}`);
    return match[1];
  };

  return { ctx, emit, latestSpeedCard, nativeSpeedValue, runVisibility };
};

const assistantMessage = (output, timestamp) => ({
  role: "assistant",
  provider: "test",
  model: "test-model",
  timestamp,
  responseId: `response-${timestamp}`,
  usage: {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0 },
  },
});

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("Speed stays visible while idle and keeps cumulative output and average speed", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await sleep(20);

  assert.equal(harness.latestSpeedCard()?.value, "0 tok @ — tok/s", "Speed should exist before generation starts");

  const realDateNow = Date.now;
  let nowMs = realDateNow();
  Date.now = () => nowMs;

  try {
    const first = assistantMessage(12, 1);
    await harness.emit("message_start", { message: first });
    nowMs += 100;
    await harness.emit("message_update", {
      message: first,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "first streamed response",
        partial: first,
      },
    });
    await sleep(280);

    const activeSpeed = harness.latestSpeedCard().value;
    assert.match(activeSpeed, /^12 tok @ (?!—)/, "a valid live speed should be published while the agent runs");
    assert.doesNotMatch(activeSpeed, / · (?:avg|1%|max) /, "session speed stats should be hidden by default");

    await harness.runVisibility("show webui speed-avg");
    const avgOnlySpeed = harness.latestSpeedCard().value;
    assert.match(avgOnlySpeed, / · avg \S+$/, "the selected average speed should be shown");
    assert.equal(avgOnlySpeed, "12 tok @ 120 tok/s · avg 120");
    assert.doesNotMatch(avgOnlySpeed, / · 1% | · max /, "unselected speed stats should remain hidden");

    await harness.runVisibility("show webui speed-low speed-max");
    const allStatsSpeed = harness.latestSpeedCard().value;
    assert.match(allStatsSpeed, / · avg \S+ · 1% \S+ · max \S+$/, "all selected speed stats should be shown");

    nowMs += 3_000;
    await harness.emit("message_update", {
      message: first,
      assistantMessageEvent: {
        type: "toolcall_delta",
        delta: "",
        partial: first,
      },
    });
    await sleep(20);
    assert.equal(
      harness.latestSpeedCard().value,
      allStatsSpeed,
      "a streaming pause or tool transition must retain the last valid live speed and selected stats",
    );

    // Exercise the problematic ordering where agent_end clears live state before
    // message_end publishes final usage.
    await harness.emit("agent_end");
    await harness.emit("message_end", { message: first });

    const idleAfterFirst = harness.latestSpeedCard();
    assert.ok(idleAfterFirst, "Speed should remain in the footer after agent_end");
    assert.match(idleAfterFirst.value, /^12 tok @ (?!—)/, "the completed output and measured speed should remain visible");

    const second = assistantMessage(8, 2);
    await harness.emit("message_start", { message: second });
    assert.match(
      harness.latestSpeedCard().value,
      /^12 tok @ (?!—)/,
      "starting another assistant message must not reset the displayed cumulative output or speed",
    );

    nowMs += 100;
    await harness.emit("message_update", {
      message: second,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "second streamed response",
        partial: second,
      },
    });
    await harness.emit("message_end", { message: second });
    await harness.emit("turn_end", { message: second });
    await harness.emit("agent_end");

    assert.match(
      harness.latestSpeedCard().value,
      /^20 tok @ (?!—)/,
      "completed output should accumulate across assistant messages and remain visible while idle",
    );
  } finally {
    Date.now = realDateNow;
    await harness.emit("session_shutdown");
  }
});

test("main Speed uses the session sample average in both footers, including while idle", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.runVisibility("reset all speed-avg speed-low speed-max");

  const realDateNow = Date.now;
  let nowMs = realDateNow();
  Date.now = () => nowMs;

  const assertSpeed = (expected) => {
    assert.equal(harness.latestSpeedCard().value, expected);
    assert.equal(harness.nativeSpeedValue(), expected);
  };

  try {
    assertSpeed("0 tok @ — tok/s");

    const first = assistantMessage(10, 10);
    await harness.emit("message_start", { message: first });
    nowMs += 1_000;
    await harness.emit("message_update", {
      message: first,
      assistantMessageEvent: { type: "text_delta", delta: "first", partial: first },
    });
    await harness.emit("message_end", { message: first });
    assertSpeed("10 tok @ 10.0 tok/s");

    const second = assistantMessage(30, 20);
    await harness.emit("message_start", { message: second });
    assertSpeed("10 tok @ 10.0 tok/s");
    nowMs += 1_000;
    await harness.emit("message_update", {
      message: second,
      assistantMessageEvent: { type: "text_delta", delta: "second", partial: second },
    });
    await sleep(280);
    assertSpeed("40 tok @ 20.0 tok/s");
    assert.match(harness.latestSpeedCard().title, /average speed from 2 live samples/);

    // Final message latency produces 7.5 tok/s, not the sampled session mean.
    nowMs += 3_000;
    await harness.emit("message_end", { message: second });
    await harness.emit("turn_end", { message: second });
    await harness.emit("agent_end");
    assertSpeed("40 tok @ 20.0 tok/s");

    await harness.runVisibility("show all speed-avg speed-low speed-max");
    assertSpeed("40 tok @ 20.0 tok/s · avg 20.0 · 1% 10.0 · max 30.0");
    await harness.runVisibility("reset all speed-avg speed-low speed-max");
    assertSpeed("40 tok @ 20.0 tok/s");

    await harness.emit("session_start", { reason: "new" });
    await sleep(20);
    assertSpeed("0 tok @ — tok/s");

    const third = assistantMessage(40, 30);
    await harness.emit("message_start", { message: third });
    nowMs += 1_000;
    await harness.emit("message_update", {
      message: third,
      assistantMessageEvent: { type: "text_delta", delta: "third", partial: third },
    });
    await harness.emit("message_end", { message: third });
    assertSpeed("40 tok @ 40.0 tok/s");
  } finally {
    Date.now = realDateNow;
    await harness.emit("session_shutdown");
  }
});

test("Speed keeps the measured fallback when no live samples are available", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  const realDateNow = Date.now;
  let nowMs = realDateNow();
  Date.now = () => nowMs;

  try {
    const message = assistantMessage(50, 40);
    await harness.emit("message_start", { message });
    nowMs += 1_000;
    await harness.emit("message_end", { message });
    assert.equal(harness.latestSpeedCard().value, "50 tok @ 50.0 tok/s");
    assert.equal(harness.nativeSpeedValue(), "50 tok @ 50.0 tok/s");

    await harness.emit("session_start", { reason: "new" });
    await sleep(20);
    assert.equal(harness.latestSpeedCard().value, "0 tok @ — tok/s");
    assert.equal(harness.nativeSpeedValue(), "0 tok @ — tok/s");
  } finally {
    Date.now = realDateNow;
    await harness.emit("session_shutdown");
  }
});

test("Speed retains the session-history estimate until live samples are available", async () => {
  const timestamp = Date.now() - 10_000;
  const entries = [
    { type: "message", message: { role: "user", timestamp } },
    { type: "message", message: assistantMessage(60, timestamp + 2_000) },
  ];
  const harness = createHarness(entries);
  await harness.emit("session_start", { reason: "resume" });

  try {
    await sleep(1_100);
    assert.equal(harness.latestSpeedCard().value, "60 tok @ 30.0 tok/s");
    assert.equal(harness.nativeSpeedValue(), "60 tok @ 30.0 tok/s");

    const realDateNow = Date.now;
    let nowMs = realDateNow();
    Date.now = () => nowMs;
    try {
      const message = assistantMessage(20, nowMs);
      await harness.emit("message_start", { message });
      nowMs += 1_000;
      await harness.emit("message_update", {
        message,
        assistantMessageEvent: { type: "text_delta", delta: "live", partial: message },
      });
      await harness.emit("message_end", { message });
      assert.equal(harness.latestSpeedCard().value, "80 tok @ 20.0 tok/s");
      assert.equal(harness.nativeSpeedValue(), "80 tok @ 20.0 tok/s");
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    await harness.emit("session_shutdown");
  }
});
