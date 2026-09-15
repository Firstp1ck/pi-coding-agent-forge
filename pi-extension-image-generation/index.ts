import { type ExtensionAPI, type ExtensionCommandContext, CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_PROMPT_LENGTH } from "./openrouter.ts";
import { createWorkflow } from "./workflow.ts";
import { createGenerateImageCommand } from "./command.ts";
import { createSettingsStore } from "./settings.ts";
import { resolveImageAuth } from "./auth.ts";
import { createSetupCommand } from "./setup.ts";

export default function imageGeneration(pi: ExtensionAPI) {
  const store = createSettingsStore(getAgentDir(), CONFIG_DIR_NAME, withFileMutationQueue);
  const workflow = createWorkflow({
    mutate: withFileMutationQueue,
    getSettings: async (ctx) => (await store.load(ctx.cwd, ctx.isProjectTrusted?.() === true)).settings,
    resolveAuth: resolveImageAuth,
  });
  let commandRunning = false;
  const guardCommand = (handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) =>
    async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) throw new Error("Image commands require a TUI or RPC client with extension dialogs.");
      if (commandRunning || workflow.isBusy() || !ctx.isIdle()) {
        ctx.ui.notify("Wait for the current operation to finish before using image commands.", "warning");
        return;
      }
      commandRunning = true;
      try { await handler(args, ctx); } finally { commandRunning = false; }
    };
  const requireNoCommand = () => {
    if (commandRunning) throw new Error("An image command is running. Wait for it to finish before calling image tools.");
  };
  let commandLifecycle = new AbortController();
  const reset = () => {
    commandLifecycle.abort();
    commandLifecycle = new AbortController();
    workflow.reset();
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.registerCommand("setup-image-generation", {
    description: "Configure OpenRouter authentication, image defaults, output, and privacy",
    handler: guardCommand(createSetupCommand({ store, getSignal: () => commandLifecycle.signal, onSaved: () => workflow.reset() })),
  });

  pi.registerCommand("generate-image", {
    description: 'Generate an image directly: /generate-image "create an image of a cat"',
    handler: guardCommand(createGenerateImageCommand({
      workflow,
      getSignal: () => commandLifecycle.signal,
      publish: (prompt, result) => pi.sendMessage({
        customType: "image-generation",
        content: [{ type: "text", text: `Prompt: ${prompt}` }, ...result.content],
        display: true,
        details: { ...result.details, usage: result.usage },
      }, { triggerTurn: false }),
    })),
  });

  pi.registerTool({
    name: "show_image_model_list",
    label: "Choose an image model",
    description: "Fetch OpenRouter's live text-to-image model list and ask the user to select a model in a native dialog. Returns a one-use selection_id and supported options. No image is generated. Requires an interactive TUI or RPC client with extension dialogs.",
    promptSnippet: "Let the user choose an OpenRouter image generation model",
    promptGuidelines: [
      "Before generating an image, call show_image_model_list and wait for the user's choice. Never choose the image model yourself or invent a selection_id.",
      "If show_image_model_list or generate_image_with_openrouter is cancelled, stop. Do not reopen the picker or retry generation unless the user asks.",
    ],
    parameters: Type.Object({
      search: Type.Optional(Type.String({ maxLength: 100, description: "Optional case-insensitive model name or ID filter. Omit to show all text-to-image models." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireNoCommand();
      return workflow.select(ctx, params.search, signal);
    },
  });

  pi.registerTool({
    name: "generate_image_with_openrouter",
    label: "Generate an image with OpenRouter",
    description: "Generate one image with the model the user chose through show_image_model_list. Requires its fresh selection_id and a final user confirmation. Sends only the prompt and options, saves a unique file in the configured output directory, and returns a raster preview up to 5 MiB unless paths-only privacy is enabled. PNG, JPEG, WebP and GIF only, max 20 MiB. No automatic retry or model override. Selection expires after one attempt or 15 minutes.",
    promptSnippet: "Generate and save one image using the user's OpenRouter model choice",
    promptGuidelines: [
      "Use generate_image_with_openrouter only for a user-requested image. Use the exact selection_id from show_image_model_list and only its supported aspect_ratio or resolution values.",
      "Do not retry generate_image_with_openrouter automatically after a failure. Report the failure and wait for the user to request another attempt.",
      "Respect image preview privacy. When generate_image_with_openrouter returns a paths-only result, do not read or attach its image unless the user asks.",
    ],
    parameters: Type.Object({
      selection_id: Type.String({ minLength: 1, maxLength: 100, description: "Exact one-use ID returned by show_image_model_list." }),
      prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Describe the requested image. The user reviews this prompt before it is sent." }),
      aspect_ratio: Type.Optional(Type.String({ maxLength: 32, description: "Use a supported value or omit to use saved model-specific preferences, then the model default." })),
      resolution: Type.Optional(Type.String({ maxLength: 32, description: "Use a supported value or omit to use saved model-specific preferences, then the model default." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireNoCommand();
      return workflow.generate(ctx, params, signal);
    },
  });
}
