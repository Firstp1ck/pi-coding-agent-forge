import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CodexCliUsageError } from "../lib/codex-cli-usage.mjs";
import { createCodexUsageReader } from "../lib/codex-usage-source.mjs";

const unavailable = () => { throw new CodexCliUsageError("CODEX_CLI_NOT_FOUND", "Codex CLI was not found."); };

test("CLI usage has precedence and does not touch Pi authentication", async () => {
  const snapshot = { source: "codex-cli", selected: { primary: { usedPercent: 25 } } };
  const reader = createCodexUsageReader({ readCli: async () => snapshot, readLegacy: () => assert.fail("CLI success must not resolve Pi auth") });
  assert.equal(await reader({ forceRefresh: true }), snapshot);
});

test("a compatible legacy login supplies an explicitly labelled fallback", async () => {
  let received;
  const reader = createCodexUsageReader({ readCli: unavailable, readLegacy: async (options) => { received = options; return { source: "chatgpt.com", selected: {} }; } });
  const result = await reader({ forceRefresh: true });
  assert.deepEqual(received, { forceRefresh: true });
  assert.equal(result.source, "chatgpt.com");
  assert.match(result.sourceNotice, /Pi's legacy Codex login/);
});

test("concurrent polls coalesce and refresh bypasses only the completed cache", async () => {
  let calls = 0;
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const reader = createCodexUsageReader({ readCli: async () => { calls++; return pending; }, readLegacy: () => assert.fail("must not fall back") });
  const first = reader();
  const second = reader({ forceRefresh: true });
  assert.equal(calls, 1);
  complete({ source: "codex-cli" });
  assert.deepEqual(await first, await second);
  await reader();
  assert.equal(calls, 1);
  await reader({ forceRefresh: true });
  assert.equal(calls, 2);
});

test("successful caches expire, while failures never enter the cache", async () => {
  let now = 100;
  let calls = 0;
  const reader = createCodexUsageReader({ readCli: async () => ({ source: "codex-cli", count: ++calls }), readLegacy: unavailable, cacheMs: 30, now: () => now });
  assert.equal((await reader()).count, 1);
  now = 129;
  assert.equal((await reader()).count, 1);
  now = 130;
  assert.equal((await reader()).count, 2);
  let failures = 0;
  const failing = createCodexUsageReader({ readCli: async () => { failures++; unavailable(); }, readLegacy: async () => { throw new Error("private-token"); } });
  for (let index = 0; index < 2; index++) await assert.rejects(failing(), (error) => error.code === "CODEX_CLI_NOT_FOUND" && !error.message.includes("private-token"));
  assert.equal(failures, 2);
});

test("unexpected CLI errors and legacy exceptions never expose raw diagnostics", async () => {
  const reader = createCodexUsageReader({ readCli: async () => { throw new Error("Bearer private-cli-token"); }, readLegacy: async () => { throw new Error("private-refresh-token"); } });
  await assert.rejects(reader(), (error) => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /legacy Codex usage fallback/);
    assert.doesNotMatch(error.message, /private-|Bearer/);
    return true;
  });
});

const serverSource = await readFile(new URL("../bin/pi-webui.mjs", import.meta.url), "utf8");
function serverUsageReader(readCli, fetchLegacy, resolveAuth) {
  const start = serverSource.indexOf("function firstDefined(");
  const end = serverSource.indexOf("const CLAUDE_USAGE_MONTHS", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${serverSource.slice(start, end)}\ngetOpenAICodexUsageStatus;`, {
    Buffer, AbortController, setTimeout, clearTimeout,
    createCodexUsageReader,
    readCodexCliUsage: readCli,
    fetch: fetchLegacy,
    OPENAI_CODEX_PROVIDER_ID: "openai-codex",
    OPENAI_CODEX_USAGE_ENDPOINT: "https://fixture.invalid/usage",
    CODEX_USAGE_TIMEOUT_MS: 1000,
    CODEX_USAGE_DIRECT_TOKEN_MESSAGE: "Direct ChatGPT login cannot supply legacy usage.",
    codexUsageLoginGuidance: () => "Run /login.",
    authContext: async () => ({ modelRuntime: {} }),
    resolveCodexUsageAuth: resolveAuth,
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
  });
}

test("the server normalizes CLI weekly-only usage and records its source", async () => {
  const reader = serverUsageReader(async () => ({ planType: "plus", rateLimits: { limitId: "codex", primary: null, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2_000_500_000 } } }), () => assert.fail("must not call legacy backend"), () => assert.fail("must not resolve Pi auth"));
  const data = await reader();
  assert.equal(data.source, "codex-cli");
  assert.equal(data.auth.source, "codex-cli");
  assert.equal(data.planType, "plus");
  assert.equal(data.selected.primary, null);
  assert.equal(data.selected.secondary.usedPercent, 42);
  assert.equal(data.snapshots.length, 1);
  assert.equal(data.selected.secondary.resetsAt, new Date(2_000_500_000 * 1000).toISOString());
});

test("the server retains legacy usage as a fallback with no CLI credentials involved", async () => {
  let legacyCalls = 0;
  const reader = serverUsageReader(unavailable, async (_url, options) => {
    legacyCalls++;
    assert.equal(options.headers.authorization, "Bearer fixture-legacy-token");
    return { ok: true, text: async () => JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } }) };
  }, async () => ({ providerId: "openai-codex", accessToken: "fixture-legacy-token", credential: { type: "oauth", accountId: "fixture-account" } }));
  const data = await reader();
  assert.equal(legacyCalls, 1);
  assert.equal(data.source, "chatgpt.com");
  assert.equal(data.selected.primary.usedPercent, 12);
  assert.match(data.sourceNotice, /legacy Codex login/);
  assert.doesNotMatch(JSON.stringify(data), /fixture-legacy-token|fixture-account/);
});

test("the server gives a sanitized combined error when CLI and direct-flow Pi fallback fail", async () => {
  const reader = serverUsageReader(unavailable, () => assert.fail("direct-flow token must not reach backend"), async () => ({ unsupportedReason: "chatgpt-direct-token" }));
  await assert.rejects(reader(), (error) => error.code === "CODEX_CLI_NOT_FOUND" && /legacy Codex usage fallback/.test(error.message));
});

test("the browser labels the usage account and redraws when source changes", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const signatureStart = source.indexOf("function codexUsageStructureSignature(");
  const signatureEnd = source.indexOf("function updateCodexUsageValues(", signatureStart);
  const renderStart = source.indexOf("function renderCodexUsage(");
  const renderEnd = source.indexOf("async function refreshCodexUsage(", renderStart);
  const nodes = [];
  let rebuilds = 0;
  const box = { replaceChildren: () => { nodes.length = 0; rebuilds++; }, classList: { toggle() {} }, append: (...items) => nodes.push(...items) };
  const context = vm.createContext({
    latestCodexUsage: { source: "codex-cli", planType: "plus" },
    codexUsageLoading: false, codexUsageError: null, codexUsageRenderSignature: "",
    elements: { codexUsageBox: box },
    formatCodexPlanType: (value) => value,
    codexUsageBuckets: () => [],
    updateCodexUsageValues: () => true,
    make: (_tag, _className, text) => ({ text, append() {} }),
  });
  vm.runInContext(`${source.slice(signatureStart, signatureEnd)}\n${source.slice(renderStart, renderEnd)}\nrenderCodexUsage();`, context);
  assert.ok(nodes.some((node) => /Codex CLI account/.test(node.text)));
  assert.ok(nodes.some((node) => /separate from Pi/.test(node.text)));
  context.latestCodexUsage = { source: "chatgpt.com", planType: "plus", sourceNotice: "Showing fallback usage." };
  vm.runInContext("renderCodexUsage()", context);
  assert.equal(rebuilds, 2, "source changes must invalidate the structural cache");
  assert.ok(nodes.some((node) => /Pi's legacy Codex login/.test(node.text)));
  assert.ok(nodes.some((node) => node.text === "Showing fallback usage."));
});
