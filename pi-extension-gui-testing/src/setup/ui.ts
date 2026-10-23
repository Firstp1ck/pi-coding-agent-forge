/**
 * Prompt adapter for setup (spec §5.2 "Modes", plan invariant 11). Without a
 * UI it never calls `select`/`confirm`/`input`; a needed prompt fails with the
 * flags that would have answered it. With a UI, every dialog is bound to the
 * setup's abort signal and a timeout that aborts the whole setup.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A prompt was needed but no UI is available. */
export class MissingInputError extends Error {
  /** Flags that answer the prompt, e.g. `["--fix", "--no-fix"]`. */
  readonly missingFlags: string[];
  constructor(prompt: string, missingFlags: string[]) {
    super(`${prompt}: no interactive UI; pass ${missingFlags.join(" or ")}`);
    this.name = "MissingInputError";
    this.missingFlags = missingFlags;
  }
}

/** Default time a setup dialog may stay open before setup is cancelled. */
export const DEFAULT_DIALOG_TIMEOUT_MS = 10 * 60_000;

export interface PromptOptions {
  /** Flags that replace this prompt, listed when there is no UI. */
  flags: string[];
}

/** The subset of Pi's UI that setup uses. */
export interface SetupUi {
  readonly hasUI: boolean;
  select(title: string, options: string[], prompt: PromptOptions): Promise<string | undefined>;
  confirm(title: string, message: string, prompt: PromptOptions): Promise<boolean>;
  input(title: string, placeholder: string | undefined, prompt: PromptOptions): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Progress line; `undefined` clears it. A no-op without UI. */
  setStatus(text: string | undefined): void;
}

export interface SetupUiOptions {
  /** Setup's own controller; a dialog timeout aborts it (spec §5.2). */
  controller: AbortController;
  dialogTimeoutMs?: number;
  /** Key for `ctx.ui.setStatus`. */
  statusKey?: string;
}

/** Raised after a dialog when setup was aborted while it was open. */
function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(typeof reason === "string" ? reason : "setup cancelled"), { name: "AbortError" });
}

/** Wraps a Pi context's UI for setup. */
export function createSetupUi(ctx: Pick<ExtensionContext, "hasUI" | "ui">, options: SetupUiOptions): SetupUi {
  const { controller } = options;
  const timeoutMs = options.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS;
  const statusKey = options.statusKey ?? "gui-testing";

  const dialog = async <T>(title: string, prompt: PromptOptions, open: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!ctx.hasUI) throw new MissingInputError(title, prompt.flags);
    if (controller.signal.aborted) throw abortedError(controller.signal);
    // Our own timer, not Pi's `timeout` option: Pi resolves a timed-out confirm as
    // `false`, which would be indistinguishable from the user declining.
    const timer = setTimeout(() => controller.abort(new Error(`setup cancelled: dialog "${title}" timed out`)), timeoutMs);
    try {
      const value = await open(controller.signal);
      if (controller.signal.aborted) throw abortedError(controller.signal);
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    hasUI: ctx.hasUI,
    select: (title, items, prompt) => dialog(title, prompt, (signal) => ctx.ui.select(title, items, { signal })),
    confirm: (title, message, prompt) => dialog(title, prompt, (signal) => ctx.ui.confirm(title, message, { signal })),
    input: (title, placeholder, prompt) => dialog(title, prompt, (signal) => ctx.ui.input(title, placeholder, { signal })),
    notify: (message, type) => {
      if (ctx.hasUI) ctx.ui.notify(message, type);
    },
    setStatus: (text) => {
      if (ctx.hasUI) ctx.ui.setStatus(statusKey, text);
    },
  };
}
