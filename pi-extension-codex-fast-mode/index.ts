import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_STATUS_KEY = "codex-fast-mode";
export const FAST_MODE_STATE_ENTRY_TYPE = "codex-fast-mode";
export const FAST_MODE_SERVICE_TIER = "priority";
export const ULTRAFAST_MODE_SERVICE_TIER = "ultrafast";
export const ULTRAFAST_MODE_MODEL_ID = "gpt-6-astra";
export const ULTRAFAST_MODE_NOTICE = "Ultrafast requires GPT-6 Astra and Pro $500 or eligible Enterprise/Edu access. It uses 8x Standard included usage or 6x purchased-credit/pay-as-you-go usage; workspace terms may differ.";

export type FastMode = "normal" | "fast" | "ultrafast";
export type FastModeState = { mode: FastMode };

export type FastModeModel = {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
};

export type FastModeCommand = "toggle" | "on" | "off" | "status" | FastMode | "invalid";

export function isFastMode(value: unknown): value is FastMode {
  return value === "normal" || value === "fast" || value === "ultrafast";
}

/** Returns true only for object records that can safely receive a shallow request rewrite. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Fast mode is limited to Pi's subscription-backed Codex Responses provider. */
export function isFastModeEligibleModel(model: FastModeModel | undefined): boolean {
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

/** Ultrafast subscription access is currently documented only for GPT-6 Astra. */
export function isUltrafastModeEligibleModel(model: FastModeModel | undefined): boolean {
  return isFastModeEligibleModel(model) && model?.id === ULTRAFAST_MODE_MODEL_ID;
}

/**
 * Applies the selected tier without mutating the serialized payload.
 * Undefined leaves the request unchanged; booleans retain the original Fast-mode contract.
 */
export function transformFastModeRequest(
  setting: FastMode | boolean,
  model: FastModeModel | undefined,
  payload: unknown,
): Record<string, unknown> | undefined {
  const mode = typeof setting === "boolean" ? (setting ? "fast" : "normal") : setting;
  if (!isFastMode(mode) || mode === "normal" || !isFastModeEligibleModel(model) || !isPlainObject(payload)) return undefined;
  if (mode === "ultrafast" && (!isUltrafastModeEligibleModel(model) || payload.model !== ULTRAFAST_MODE_MODEL_ID)) return undefined;
  return { ...payload, service_tier: mode === "ultrafast" ? ULTRAFAST_MODE_SERVICE_TIER : FAST_MODE_SERVICE_TIER };
}

/** Reconstructs the latest valid Fast-mode snapshot visible from the active session branch. */
export function reconstructFastModeState(entries: readonly unknown[]): FastModeState {
  let mode: FastMode = "normal";

  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (entry.type !== "custom" || entry.customType !== FAST_MODE_STATE_ENTRY_TYPE) continue;
    if (!isPlainObject(entry.data)) continue;
    if (Object.hasOwn(entry.data, "mode")) {
      if (isFastMode(entry.data.mode)) mode = entry.data.mode;
    } else if (typeof entry.data.enabled === "boolean") {
      mode = entry.data.enabled ? "fast" : "normal";
    }
  }

  return { mode };
}

export function parseFastModeCommand(args: string): FastModeCommand {
  const normalized = args.trim().toLowerCase();
  if (!normalized) return "toggle";
  if (normalized === "on" || normalized === "off" || normalized === "status" || isFastMode(normalized)) return normalized;
  return "invalid";
}

export function fastModeArgumentCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  return ["on", "off", "status", "normal", "fast", "ultrafast"]
    .filter((value) => value.startsWith(normalized))
    .map((value) => ({ value, label: value }));
}

function isBusy(ctx: Pick<ExtensionCommandContext, "isIdle" | "hasPendingMessages">): boolean {
  return !ctx.isIdle() || ctx.hasPendingMessages();
}

function publishStatus(ctx: Pick<ExtensionContext, "ui">, mode: FastMode): void {
  ctx.ui.setStatus(FAST_MODE_STATUS_KEY, mode === "ultrafast" ? "ultrafast" : mode === "fast" ? "on" : "off");
}

function formatStatus(mode: FastMode, model: FastModeModel | undefined): string {
  if (mode === "ultrafast") {
    const inactive = isUltrafastModeEligibleModel(model) ? "" : " Inactive for the current model.";
    return `Fast mode: ultrafast.${inactive} ${ULTRAFAST_MODE_NOTICE} This is a preference, not confirmation of upstream acceptance.`;
  }
  return `Fast mode: ${mode === "fast" ? "on" : "off"}. It only requests priority service for openai-codex/openai-codex-responses.`;
}

export default function codexFastModeExtension(pi: ExtensionAPI): void {
  let mode: FastMode = "normal";

  const restoreState = (ctx: ExtensionContext): void => {
    mode = reconstructFastModeState(ctx.sessionManager.getBranch()).mode;
    publishStatus(ctx, mode);
  };

  const setMode = (ctx: ExtensionCommandContext, nextMode: FastMode): void => {
    if (nextMode === "ultrafast" && !isUltrafastModeEligibleModel(ctx.model)) {
      ctx.ui.notify("Select GPT-6 Astra through the subscription-backed openai-codex provider before enabling Ultrafast. No setting was changed.", "warning");
      return;
    }
    if (mode === nextMode) {
      publishStatus(ctx, mode);
      ctx.ui.notify(formatStatus(mode, ctx.model), "info");
      return;
    }

    mode = nextMode;
    // Older extension versions read the boolean and safely restore any enabled tier as Fast.
    pi.appendEntry(FAST_MODE_STATE_ENTRY_TYPE, { mode, enabled: mode !== "normal" });
    publishStatus(ctx, mode);
    if (mode === "ultrafast") {
      ctx.ui.notify(`Ultrafast selected. ${ULTRAFAST_MODE_NOTICE} Upstream eligibility and acceptance remain authoritative.`, "warning");
    } else {
      ctx.ui.notify(mode === "fast"
        ? "Fast mode enabled. Supported Codex requests will request priority service."
        : "Fast mode disabled. Supported Codex requests will keep their existing service tier.", "info");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    return transformFastModeRequest(mode, ctx.model, event.payload);
  });

  pi.registerCommand("fast-mode", {
    description: "Select Codex subscription speed. Usage: /fast-mode [on|off|normal|fast|ultrafast|status]. Ultrafast uses 8x included usage or 6x purchased credits.",
    getArgumentCompletions: fastModeArgumentCompletions,
    handler: async (args, ctx) => {
      const command = parseFastModeCommand(args);

      if (command === "status") {
        publishStatus(ctx, mode);
        ctx.ui.notify(formatStatus(mode, ctx.model), "info");
        return;
      }

      if (command === "invalid") {
        ctx.ui.notify("Usage: /fast-mode [on|off|normal|fast|ultrafast|status]", "warning");
        return;
      }

      if (isBusy(ctx)) {
        ctx.ui.notify("Fast mode cannot be changed while the session is busy. Run /fast-mode status to inspect it.", "warning");
        return;
      }

      const nextMode = command === "toggle" ? (mode === "normal" ? "fast" : "normal")
        : command === "on" ? "fast"
        : command === "off" ? "normal"
        : command;
      setMode(ctx, nextMode);
    },
  });
}
