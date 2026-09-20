import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_REVIEW_INPUT_MAX_CHARS,
  AUTO_REVIEW_MAX_TOKENS,
  AUTO_REVIEW_OUTPUT_MAX_CHARS,
  AUTO_REVIEW_TIMEOUT_MS,
  buildAutoReviewPrompt,
  parseAutoReviewVerdict,
  requestAutoReview,
  supportedAutoReviewThinkingLevels,
} from "../src/auto-review.ts";

const request = {
  kind: "bash",
  label: "git reset --hard",
  category: "git",
  riskLevel: "block-noninteractive",
  cwd: "/workspace",
  pendingText: "git reset --hard",
};

test("strict verdict parsing accepts only the bounded exact schema", () => {
  assert.deepEqual(parseAutoReviewVerdict('{"verdict":"allow","reason":"Scoped cleanup is explicit"}'), {
    verdict: "allow",
    reason: "Scoped cleanup is explicit",
  });
  assert.deepEqual(parseAutoReviewVerdict('{"reason":"Irreversible target","verdict":"block"}'), {
    verdict: "block",
    reason: "Irreversible target",
  });

  for (const invalid of [
    "",
    "```json\n{\"verdict\":\"allow\",\"reason\":\"ok\"}\n```",
    '{"verdict":"allow","reason":"ok"} trailing',
    '{"verdict":"approve","reason":"ok"}',
    '{"verdict":"allow","reason":"ok","extra":true}',
    '{"verdict":"allow","reason":""}',
    JSON.stringify({ verdict: "allow", reason: "x".repeat(513) }),
    JSON.stringify({ verdict: "allow", reason: "two\nlines" }),
    "x".repeat(AUTO_REVIEW_OUTPUT_MAX_CHARS + 1),
  ]) {
    assert.throws(() => parseAutoReviewVerdict(invalid));
  }
});

test("review prompt is bounded and contains only approved pending-call metadata", () => {
  const prompt = buildAutoReviewPrompt({ ...request, pendingText: `start-${"x".repeat(AUTO_REVIEW_INPUT_MAX_CHARS * 2)}-end` });
  const parsed = JSON.parse(prompt);

  assert.deepEqual(Object.keys(parsed).sort(), ["category", "cwd", "kind", "pendingToolInput", "riskLevel", "rule"]);
  assert.ok(parsed.pendingToolInput.length <= AUTO_REVIEW_INPUT_MAX_CHARS);
  assert.match(parsed.pendingToolInput, /^start-/);
  assert.match(parsed.pendingToolInput, /-end$/);
  assert.doesNotMatch(prompt, /transcript|toolResult|credential|apiKey/i);
});

test("model execution resolves auth and disables retries, cache, and tools", async () => {
  const model = { provider: "provider-a", id: "model-a", reasoning: true, thinkingLevelMap: { max: null } };
  const calls = [];
  const headers = { authorization: null, "x-fixture": "secret-header" };
  const registry = {
    find(provider, modelId) {
      assert.equal(`${provider}/${modelId}`, "provider-a/model-a");
      return model;
    },
    async getApiKeyAndHeaders(selected) {
      assert.equal(selected, model);
      return { ok: true, apiKey: "secret-key", headers, env: { TOKEN: "secret-env" } };
    },
  };
  const complete = async (...args) => {
    calls.push(args);
    return {
      stopReason: "stop",
      content: [{ type: "text", text: '{"verdict":"allow","reason":"Scoped and explicit"}' }],
    };
  };

  const outerController = new AbortController();
  const verdict = await requestAutoReview(registry, {
    provider: "provider-a",
    modelId: "model-a",
    thinkingLevel: "high",
  }, request, complete, outerController.signal);

  assert.equal(verdict.verdict, "allow");
  assert.equal(calls.length, 1);
  const [, context, options] = calls[0];
  assert.deepEqual(context.tools, []);
  assert.equal(options.apiKey, "secret-key");
  assert.equal(options.headers, headers, "forward the provider headers without rebuilding them");
  assert.equal(options.headers.authorization, null, "preserve credential-deletion markers");
  assert.equal(options.reasoning, "high");
  assert.equal(options.cacheRetention, "none");
  assert.equal(options.maxRetries, 0);
  assert.equal(options.maxTokens, AUTO_REVIEW_MAX_TOKENS);
  assert.equal(options.timeoutMs, AUTO_REVIEW_TIMEOUT_MS);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  outerController.abort();
  assert.equal(options.signal.aborted, true, "outer tool-call cancellation should abort the nested review request");
  assert.doesNotMatch(JSON.stringify(context), /secret-key|secret-header|secret-env/);
});

test("unavailable model, auth, unsupported thinking, and bad provider completion reject for prompt fallback", async () => {
  const baseModel = { provider: "p", id: "m", reasoning: false };
  await assert.rejects(() => requestAutoReview({ find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) }, {
    provider: "p", modelId: "m", thinkingLevel: "off",
  }, request, async () => { throw new Error("must not call"); }), /unavailable/);
  await assert.rejects(() => requestAutoReview({ find: () => baseModel, getApiKeyAndHeaders: async () => ({ ok: false, error: "private auth detail" }) }, {
    provider: "p", modelId: "m", thinkingLevel: "off",
  }, request, async () => { throw new Error("must not call"); }), /authentication failed/);
  await assert.rejects(() => requestAutoReview({ find: () => baseModel, getApiKeyAndHeaders: async () => ({ ok: true }) }, {
    provider: "p", modelId: "m", thinkingLevel: "high",
  }, request, async () => { throw new Error("must not call"); }), /thinking level/);
  await assert.rejects(() => requestAutoReview({ find: () => baseModel, getApiKeyAndHeaders: async () => ({ ok: true }) }, {
    provider: "p", modelId: "m", thinkingLevel: "off",
  }, request, async () => ({ stopReason: "aborted", content: [] })), /aborted/);
});

test("thinking choices honor model capabilities", () => {
  assert.deepEqual(supportedAutoReviewThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(
    supportedAutoReviewThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null } }),
    ["off", "low", "medium", "high", "xhigh"],
  );
});
