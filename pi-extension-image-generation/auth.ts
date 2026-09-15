import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { API_BASE } from "./openrouter.ts";
import type { ImageSettings } from "./settings.ts";

export interface AuthContext {
  modelRegistry?: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
}
export interface ImageAuth { apiKey?: string; source: "OPENROUTER_API_KEY" | "Pi OpenRouter credentials" | "not configured" }

export async function resolveImageAuth(
  ctx: AuthContext, settings: ImageSettings, signal: AbortSignal,
  envKey: () => string | undefined = () => process.env.OPENROUTER_API_KEY,
): Promise<ImageAuth> {
  signal.throwIfAborted();
  const environment = envKey()?.trim();
  if (environment) return { apiKey: environment, source: "OPENROUTER_API_KEY" };
  if (settings.authentication === "environment" || !ctx.modelRegistry) return { source: "not configured" };
  // Pi's registry API has no signal parameter. Bound our wait and ignore late resolution.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const combined = AbortSignal.any([signal, controller.signal]);
  let onAbort: () => void = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("OpenRouter credential resolution cancelled or timed out."));
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    const resolved = await Promise.race([ctx.modelRegistry.getProviderAuth("openrouter"), aborted]);
    combined.throwIfAborted();
    const baseUrl = resolved?.auth.baseUrl;
    if (baseUrl && baseUrl.replace(/\/$/, "") !== API_BASE) throw new Error("Custom OpenRouter credential endpoints are not supported for image generation.");
    const apiKey = resolved?.auth.apiKey?.trim();
    return apiKey ? { apiKey, source: "Pi OpenRouter credentials" } : { source: "not configured" };
  } catch {
    throw new Error("Could not resolve Pi OpenRouter credentials. Check Pi's OpenRouter login and endpoint configuration, or use OPENROUTER_API_KEY.");
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
