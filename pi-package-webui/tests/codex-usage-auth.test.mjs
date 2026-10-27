import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CODEX_TOKEN_REFRESH_SKEW_MS, CODEX_USAGE_DIRECT_TOKEN_MESSAGE, codexUsageLoginGuidance, resolveCodexUsageAuth } from "../lib/codex-usage-auth.mjs";

function fakeRuntime(initial, refresh, { providerId = "openai-codex", additionalCredentials = {}, additionalProviders = {} } = {}) {
  const stored = new Map(Object.entries({ ...additionalCredentials, [providerId]: structuredClone(initial) }));
  let tail = Promise.resolve();
  const credentials = {
    async read(id) { return structuredClone(stored.get(id)); },
    modify(id, update) {
      const operation = tail.then(async () => {
        const next = await update(structuredClone(stored.get(id)));
        if (next !== undefined) stored.set(id, structuredClone(next));
        return structuredClone(stored.get(id));
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
  return {
    credentials,
    getProvider(id) {
      return id === providerId ? { auth: { oauth: { refresh, isSubscription: true } } } : additionalProviders[id];
    },
    async getAuth() { throw new Error("OAuth tests must not use ordinary auth resolution"); },
  };
}

const NOW = 2_000_000_000_000;
const oauth = (access, expires) => ({ type: "oauth", access, refresh: "fake-refresh", expires, accountId: "acct_test" });

test("a 401 forces refresh of an otherwise unexpired Codex credential", async () => {
  let refreshCalls = 0;
  const runtime = fakeRuntime(oauth("rejected", NOW + 60 * 60 * 1000), async (current) => {
    refreshCalls += 1;
    return { ...current, access: "replacement", expires: NOW + 2 * 60 * 60 * 1000 };
  });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { forceRefresh: true, now: NOW });
  assert.equal(refreshCalls, 1);
  assert.equal(result.accessToken, "replacement");
  assert.equal(result.refreshed, true);
});

test("Codex OAuth refresh uses the five-minute proactive skew", async () => {
  let refreshCalls = 0;
  const nearExpiry = fakeRuntime(oauth("near", NOW + CODEX_TOKEN_REFRESH_SKEW_MS - 1), async (current) => {
    refreshCalls += 1;
    return { ...current, access: "near-refreshed", expires: NOW + 60 * 60 * 1000 };
  });
  assert.equal((await resolveCodexUsageAuth(nearExpiry, "openai-codex", { now: NOW })).accessToken, "near-refreshed");
  assert.equal(refreshCalls, 1);

  const farExpiry = fakeRuntime(oauth("far", NOW + CODEX_TOKEN_REFRESH_SKEW_MS + 1), async () => {
    refreshCalls += 1;
    throw new Error("must not refresh");
  });
  assert.equal((await resolveCodexUsageAuth(farExpiry, "openai-codex", { now: NOW })).accessToken, "far");
  assert.equal(refreshCalls, 1);
});

test("forced refresh never returns the same rejected credential", async () => {
  const runtime = fakeRuntime(oauth("rejected", NOW + 60 * 60 * 1000), async (current) => ({ ...current }));
  await assert.rejects(
    resolveCodexUsageAuth(runtime, "openai-codex", { forceRefresh: true, now: NOW }),
    /rejected credential/,
  );
});

const mustNotRefresh = async () => { throw new Error("unexpired credentials must not refresh"); };

test("Codex usage finds ChatGPT OAuth stored under the unified OpenAI provider", async () => {
  const credential = oauth("chatgpt", NOW + 60 * 60 * 1000);
  delete credential.accountId;
  const runtime = fakeRuntime(credential, mustNotRefresh, { providerId: "openai" });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(result.providerId, "openai");
  assert.equal(result.accessToken, "chatgpt");
  assert.deepEqual(result.credential, credential, "JWT-only account metadata must remain available to the server");
  assert.equal(result.refreshed, false);
});

test("unified OpenAI credentials refresh under their own storage key", async () => {
  let refreshCalls = 0;
  const runtime = fakeRuntime(oauth("near", NOW + CODEX_TOKEN_REFRESH_SKEW_MS - 1), async (current) => {
    refreshCalls += 1;
    return { ...current, access: "replacement", expires: NOW + 60 * 60 * 1000 };
  }, { providerId: "openai" });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(refreshCalls, 1);
  assert.equal(result.providerId, "openai");
  assert.equal(result.accessToken, "replacement");
  assert.equal(result.refreshed, true);
  assert.equal((await runtime.credentials.read("openai")).access, "replacement");
  assert.equal(await runtime.credentials.read("openai-codex"), undefined, "refresh must not copy or migrate credentials");
});

test("concurrent forced refreshes reuse the newer unified OpenAI credential", async () => {
  let refreshCalls = 0;
  const runtime = fakeRuntime(oauth("rejected", NOW + 60 * 60 * 1000), async (current) => {
    refreshCalls += 1;
    return { ...current, access: "replacement", expires: NOW + 2 * 60 * 60 * 1000 };
  }, { providerId: "openai" });
  const results = await Promise.all([
    resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW, forceRefresh: true }),
    resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW, forceRefresh: true }),
  ]);
  assert.equal(refreshCalls, 1);
  assert.ok(results.every((result) => result.accessToken === "replacement" && result.refreshed));
});

test("unified OpenAI forced refresh rejects an unchanged token", async () => {
  const runtime = fakeRuntime(oauth("rejected", NOW + 60 * 60 * 1000), async (current) => ({ ...current }), { providerId: "openai" });
  await assert.rejects(resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW, forceRefresh: true }), /rejected credential/);
});

test("a usable legacy Codex login keeps precedence when both providers exist", async () => {
  const runtime = fakeRuntime(oauth("legacy", NOW + 60 * 60 * 1000), mustNotRefresh, {
    additionalCredentials: { openai: oauth("unified", NOW + 60 * 60 * 1000) },
    additionalProviders: { openai: { auth: { oauth: { isSubscription: true, refresh: mustNotRefresh } } } },
  });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(result.providerId, "openai-codex");
  assert.equal(result.accessToken, "legacy");
});

test("an orphaned legacy credential does not hide a usable unified OpenAI login", async () => {
  const runtime = fakeRuntime(oauth("unified", NOW + 60 * 60 * 1000), mustNotRefresh, {
    providerId: "openai",
    additionalCredentials: { "openai-codex": oauth("orphaned", NOW + 60 * 60 * 1000) },
  });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(result.providerId, "openai");
  assert.equal(result.accessToken, "unified");
});

test("a runtime with both providers can use unified OAuth when legacy login is absent", async () => {
  const runtime = fakeRuntime(undefined, mustNotRefresh, {
    additionalCredentials: { openai: oauth("unified", NOW + 60 * 60 * 1000) },
    additionalProviders: { openai: { auth: { oauth: { isSubscription: true, refresh: mustNotRefresh } } } },
  });
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(result.providerId, "openai");
  assert.equal(result.accessToken, "unified");
});

test("unified OpenAI API keys and environment auth are never resolved for subscription usage", async () => {
  for (const credential of [undefined, { type: "api_key", key: "fake-api-key" }]) {
    const runtime = fakeRuntime(credential, mustNotRefresh, { providerId: "openai" });
    const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
    assert.equal(result.providerId, "openai");
    assert.equal(result.accessToken, undefined);
    assert.deepEqual(result.credential, credential);
    assert.equal(result.refreshed, false);
  }
});

test("older API-key-only OpenAI providers are not treated as subscription OAuth aliases", async () => {
  const runtime = fakeRuntime(undefined, mustNotRefresh, {
    additionalCredentials: { openai: oauth("wrong-provider", NOW + 60 * 60 * 1000) },
    additionalProviders: { openai: { auth: { apiKey: {} } } },
  });
  runtime.getAuth = async (id) => { assert.equal(id, "openai-codex"); return undefined; };
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW });
  assert.equal(result.providerId, "openai-codex");
  assert.equal(result.accessToken, undefined);
});

test("login guidance follows the runtime's available subscription provider", () => {
  assert.equal(codexUsageLoginGuidance(fakeRuntime(undefined, mustNotRefresh)), "Run /login and choose ChatGPT Plus/Pro (Codex Subscription).");
  assert.equal(codexUsageLoginGuidance(fakeRuntime(undefined, mustNotRefresh, { providerId: "openai" })), "Run /login, choose OpenAI, then Sign in with ChatGPT.");
});

test("direct ChatGPT logins are recognized but never refreshed or forwarded to Codex usage", async () => {
  for (const providerId of ["openai", "openai-codex"]) {
    for (const forceRefresh of [false, true]) {
      const credential = { ...oauth("direct-access", NOW - 1), clientId: "fake-client", scopes: ["openid", "chatgpt.tokens.use.direct"] };
      delete credential.accountId;
      const runtime = fakeRuntime(credential, mustNotRefresh, { providerId });
      const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW, forceRefresh });
      assert.equal(result.providerId, providerId);
      assert.equal(result.unsupportedReason, "chatgpt-direct-token");
      assert.equal(result.accessToken, undefined);
      assert.equal(result.refreshed, false);
      assert.deepEqual(await runtime.credentials.read(providerId), credential);
    }
  }
});

test("a concurrent switch to direct ChatGPT login is rechecked under the credential lock", async () => {
  const runtime = fakeRuntime(oauth("rejected", NOW - 1), mustNotRefresh, { providerId: "openai" });
  const modify = runtime.credentials.modify;
  runtime.credentials.modify = async (id, update) => {
    await modify(id, () => ({ ...oauth("direct-access", NOW - 1), scopes: ["chatgpt.tokens.use.direct"] }));
    return modify(id, update);
  };
  const result = await resolveCodexUsageAuth(runtime, "openai-codex", { now: NOW, forceRefresh: true });
  assert.equal(result.unsupportedReason, "chatgpt-direct-token");
  assert.equal(result.accessToken, undefined);
  assert.equal(result.refreshed, false);
});

test("the legacy reader reports direct ChatGPT usage as unsupported without calling the Codex backend", async () => {
  const source = await readFile(new URL("../bin/pi-webui.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function getOpenAICodexUsageCredentials(");
  const end = source.indexOf("const getOpenAICodexUsageStatus = createCodexUsageReader", start);
  assert.ok(start >= 0 && end > start);
  for (const providerId of ["openai", "openai-codex"]) {
    const runtime = fakeRuntime({ ...oauth("direct-access", NOW - 1), scopes: ["chatgpt.tokens.use.direct"] }, mustNotRefresh, { providerId });
    const status = vm.runInNewContext(`${source.slice(start, end)}\ngetLegacyOpenAICodexUsageStatus;`, {
      authContext: async () => ({ modelRuntime: runtime }),
      CODEX_USAGE_DIRECT_TOKEN_MESSAGE,
      codexUsageLoginGuidance,
      resolveCodexUsageAuth,
      OPENAI_CODEX_PROVIDER_ID: "openai-codex",
      makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
      fetch: () => assert.fail("direct ChatGPT credentials must not reach the Codex backend"),
    });
    for (const forceRefresh of [false, true]) {
      await assert.rejects(status({ forceRefresh }), (error) => error.statusCode === 501 && error.message === CODEX_USAGE_DIRECT_TOKEN_MESSAGE);
    }
  }
});
