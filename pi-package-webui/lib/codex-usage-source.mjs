import { CodexCliUsageError } from "./codex-cli-usage.mjs";

export const CODEX_USAGE_CACHE_MS = 30_000;

/** Coalesce browser polls and cache only successful snapshots, never credentials or failures. */
export function createCodexUsageReader({ readCli, readLegacy, cacheMs = CODEX_USAGE_CACHE_MS, now = Date.now }) {
  let cached;
  let cachedAt = 0;
  let inFlight;
  return async function read(options = {}) {
    if (inFlight) return inFlight;
    if (!options.forceRefresh && cached && now() - cachedAt < cacheMs) return cached;
    inFlight = (async () => {
      let cliError;
      try {
        const result = await readCli();
        cached = result;
        cachedAt = now();
        return result;
      } catch (error) {
        cliError = error instanceof CodexCliUsageError ? error : new CodexCliUsageError("CODEX_CLI_FAILED", "Codex CLI usage is unavailable.");
      }
      try {
        const result = await readLegacy(options);
        cached = { ...result, sourceNotice: "Codex CLI usage is unavailable. Showing usage from Pi's legacy Codex login." };
        cachedAt = now();
        return cached;
      } catch {
        // Do not expose raw CLI diagnostics, Pi auth errors, account details,
        // stack traces or upstream response bodies when both readers fail.
        throw new CodexCliUsageError(cliError.code, `${cliError.message} Pi's legacy Codex usage fallback also could not provide usage. Check https://chatgpt.com/settings/usage.`, cliError.statusCode);
      }
    })();
    try { return await inFlight; } finally { inFlight = undefined; }
  };
}
