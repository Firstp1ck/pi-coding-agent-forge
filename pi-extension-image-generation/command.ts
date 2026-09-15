import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validatePrompt, type createWorkflow, type WorkflowContext, type WorkflowResult } from "./workflow.ts";

export const COMMAND_USAGE = 'Usage: /generate-image "create an image of a cat"';

export function parseCommandPrompt(args: string): string {
  let prompt = args.trim();
  if (!prompt) throw new Error(COMMAND_USAGE);
  const quote = prompt[0];
  if (quote === '"' || quote === "'") {
    if (prompt.length < 2 || !prompt.endsWith(quote)) throw new Error(`Close the prompt's opening quote. ${COMMAND_USAGE}`);
    prompt = prompt.slice(1, -1);
  }
  return validatePrompt(prompt);
}

type CommandContext = WorkflowContext & Pick<ExtensionContext, "isIdle" | "signal"> & {
  ui: WorkflowContext["ui"] & Pick<ExtensionContext["ui"], "notify">;
};

export function createGenerateImageCommand(deps: {
  workflow: Pick<ReturnType<typeof createWorkflow>, "select" | "generate"> & Partial<Pick<ReturnType<typeof createWorkflow>, "selectForGeneration">>;
  getSignal: () => AbortSignal;
  publish: (prompt: string, result: WorkflowResult) => void;
}) {
  let running = false;
  return async (args: string, ctx: CommandContext): Promise<void> => {
    if (!ctx.hasUI) throw new Error("/generate-image requires a TUI or RPC client with extension dialogs.");
    if (running || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current operation to finish before using /generate-image.", "warning");
      return;
    }
    running = true;
    const signal = AbortSignal.any([deps.getSignal(), ...(ctx.signal ? [ctx.signal] : [])]);
    try {
      const prompt = parseCommandPrompt(args);
      signal.throwIfAborted();
      const selected = deps.workflow.selectForGeneration
        ? await deps.workflow.selectForGeneration(ctx, signal)
        : await deps.workflow.select(ctx, "", signal);
      signal.throwIfAborted();
      if (selected.details.status === "cancelled") {
        ctx.ui.notify("Image generation cancelled. No image request was sent.", "info");
        return;
      }
      const selection_id = selected.details.selection_id;
      if (!selection_id) throw new Error("No image model was selected.");
      const result = await deps.workflow.generate(ctx, { selection_id, prompt }, signal);
      // A completed image may have been saved during shutdown; never publish into a replacement session.
      if (signal.aborted) return;
      if (result.details.status === "cancelled") {
        ctx.ui.notify("Image generation cancelled. No image request was sent.", "info");
        return;
      }
      deps.publish(prompt, result);
    } catch (error) {
      if (!signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : "Image generation failed. No automatic retry was made.", "error");
    } finally {
      running = false;
    }
  };
}
