export const CODEX_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const CODEX_USAGE_DIRECT_TOKEN_MESSAGE = "Your ChatGPT login is configured, but Codex usage reporting is unavailable for Pi's Sign in with ChatGPT authentication. Check https://chatgpt.com/settings/usage. Logging in again will not enable this panel.";

function isDirectChatGPTCredential(credential) {
  return credential?.type === "oauth" && Array.isArray(credential.scopes) && credential.scopes.includes("chatgpt.tokens.use.direct");
}

function unsupportedDirectAuth(providerId, credential) {
  return { providerId, credential, accessToken: undefined, refreshed: false, unsupportedReason: "chatgpt-direct-token" };
}

function privateCredentialStore(modelRuntime) {
  // Compatibility adapter: ModelRuntime intentionally does not expose a
  // force-refresh API. Its RuntimeCredentials store still provides the
  // lock-safe modify() primitive used by normal OAuth resolution.
  const credentials = modelRuntime?.credentials;
  if (!credentials || typeof credentials.read !== "function" || typeof credentials.modify !== "function") {
    throw new Error("Codex OAuth force refresh is unavailable in this Pi version.");
  }
  return credentials;
}

export function codexUsageLoginGuidance(modelRuntime) {
  return modelRuntime.getProvider("openai")?.auth?.oauth?.isSubscription === true
    ? "Run /login, choose OpenAI, then Sign in with ChatGPT."
    : "Run /login and choose ChatGPT Plus/Pro (Codex Subscription).";
}

export async function resolveCodexUsageAuth(modelRuntime, providerId, options = {}) {
  const now = options.now ?? Date.now();
  const forceRefresh = options.forceRefresh === true;
  const credentials = privateCredentialStore(modelRuntime);
  let provider = modelRuntime.getProvider(providerId);
  let stored = await credentials.read(providerId);
  // Newer Pi versions store ChatGPT OAuth under the unified OpenAI provider.
  // Only select that alias when the runtime supports subscription OAuth.
  if (providerId === "openai-codex" && (stored?.type !== "oauth" || !provider?.auth?.oauth)) {
    const openai = modelRuntime.getProvider("openai");
    if (openai?.auth?.oauth?.isSubscription === true) {
      const current = await credentials.read("openai");
      if (current?.type === "oauth" || !provider?.auth?.oauth) {
        providerId = "openai";
        provider = openai;
        stored = current;
      }
    }
  }
  // Sign in with ChatGPT tokens target api.openai.com, not the legacy Codex
  // usage endpoint. Do not refresh or forward them just to report this limit.
  if (isDirectChatGPTCredential(stored)) return unsupportedDirectAuth(providerId, stored);
  let refreshed = false;

  if (stored?.type === "oauth") {
    const oauth = provider?.auth?.oauth;
    if (!oauth || typeof oauth.refresh !== "function") throw new Error("Codex OAuth refresh is unavailable.");
    const rejectedAccess = forceRefresh ? stored.access : undefined;
    const expires = Number(stored.expires);
    const shouldRefresh = forceRefresh || !Number.isFinite(expires) || now + CODEX_TOKEN_REFRESH_SKEW_MS >= expires;

    if (shouldRefresh) {
      await credentials.modify(providerId, async (current) => {
        if (current?.type !== "oauth" || isDirectChatGPTCredential(current)) return undefined;
        // Another process may have refreshed while this caller waited for the
        // auth-file lock. Reuse that newer token rather than refreshing twice.
        if (forceRefresh && current.access !== rejectedAccess) return undefined;
        const currentExpires = Number(current.expires);
        if (!forceRefresh && Number.isFinite(currentExpires) && now + CODEX_TOKEN_REFRESH_SKEW_MS < currentExpires) return undefined;
        const next = await oauth.refresh(current, options.signal);
        if (!next || next.type !== "oauth") throw new Error("Codex OAuth refresh returned no credential.");
        refreshed = true;
        return next;
      });
      stored = await credentials.read(providerId);
    }

    if (isDirectChatGPTCredential(stored)) return unsupportedDirectAuth(providerId, stored);
    if (forceRefresh && stored?.type === "oauth" && stored.access === rejectedAccess) {
      throw new Error("Codex OAuth refresh returned the rejected credential.");
    }
    return {
      providerId,
      accessToken: stored?.type === "oauth" ? stored.access : undefined,
      credential: stored,
      refreshed: refreshed || (forceRefresh && stored?.type === "oauth" && stored.access !== rejectedAccess),
    };
  }

  // OpenAI API keys are not ChatGPT subscription credentials. Never resolve
  // the unified provider's API key or environment fallback for usage requests.
  const resolved = providerId === "openai" ? undefined : await modelRuntime.getAuth(providerId);
  return {
    providerId,
    accessToken: resolved?.auth?.apiKey,
    credential: stored,
    refreshed: false,
  };
}
