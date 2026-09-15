import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS, type ImageSettings } from "./settings.ts";
import type { AuthContext, ImageAuth } from "./auth.ts";
import {
  generateImage, listModels, MAX_PROMPT_LENGTH, validateOptions,
  type GeneratedImage, type GenerationOptions, type ImageModel,
} from "./openrouter.ts";

export const DIALOG_TIMEOUT_MS = 300_000;
export const SELECTION_TTL_MS = 900_000;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export type WorkflowContext = Pick<ExtensionContext, "hasUI" | "cwd"> & AuthContext & {
  isProjectTrusted?: () => boolean;
  ui: Pick<ExtensionContext["ui"], "select" | "confirm">;
};
export type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;
export interface GenerationInput extends GenerationOptions {
  selection_id: string;
  prompt: string;
}
export interface WorkflowResult {
  content: (TextContent | ImageContent)[];
  details: {
    status: "selected" | "cancelled" | "generated";
    model?: string;
    selection_id?: string;
    parameters?: ImageModel["parameters"];
    path?: string;
    mimeType?: string;
    previewIncluded?: boolean;
  };
  usage?: Usage;
}

const cancelled = (): WorkflowResult => ({
  content: [{ type: "text", text: "User cancelled or the dialog timed out. No image request was sent. Stop; do not reopen the picker unless the user asks." }],
  details: { status: "cancelled" },
});

export function validatePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt must contain 1-${MAX_PROMPT_LENGTH} characters.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(prompt)) {
    throw new Error("Prompt contains control or bidirectional formatting characters that cannot be safely reviewed. Remove them and request a fresh model choice.");
  }
  return prompt;
}

export async function saveImage(cwd: string, image: GeneratedImage, mutate: MutationQueue, outputDirectory = "generated-images"): Promise<string> {
  const root = resolve(cwd, outputDirectory);
  await mkdir(root, { recursive: true });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("generated-images must be a real directory, not a symbolic link.");
  const directory = await mkdtemp(join(root, "generation-"));
  const path = join(directory, `image.${image.extension}`);
  try {
    await mutate(path, () => writeFile(path, image.bytes, { flag: "wx", mode: 0o600 }));
    return path;
  } catch {
    // Only remove the directory this call created, never an existing output.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error("The image was generated, but saving it failed. Check disk space and permissions; do not automatically regenerate.");
  }
}

export function createWorkflow(deps: {
  mutate: MutationQueue;
  fetcher?: typeof fetch;
  getApiKey?: () => string | undefined;
  getSettings?: (ctx: WorkflowContext) => Promise<ImageSettings>;
  resolveAuth?: (ctx: WorkflowContext, settings: ImageSettings, signal: AbortSignal) => Promise<ImageAuth>;
  now?: () => number;
}) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const getApiKey = deps.getApiKey ?? (() => process.env.OPENROUTER_API_KEY);
  const getSettings = deps.getSettings ?? (async () => ({ ...DEFAULT_SETTINGS }));
  let selection: { id: string; model: ImageModel; expires: number; cwd: string } | undefined;
  let lifecycle = new AbortController();
  let busy = false;

  async function exclusive<T>(signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (busy) throw new Error("An image operation is already running. Wait for it to finish.");
    busy = true;
    const combined = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      return await task(combined);
    } finally {
      busy = false;
    }
  }

  function requireUI(ctx: WorkflowContext): void {
    if (!ctx.hasUI) throw new Error("Image generation requires a user model choice and confirmation. Use Pi TUI or an RPC client with extension dialogs; print and JSON modes are not supported.");
  }

  const workflow = {
    isBusy: () => busy,
    reset() {
      selection = undefined;
      lifecycle.abort();
      lifecycle = new AbortController();
    },

    async selectForGeneration(ctx: WorkflowContext, signal?: AbortSignal): Promise<WorkflowResult> {
      return workflow.select(ctx, "", signal, true);
    },

    async select(ctx: WorkflowContext, query = "", signal?: AbortSignal, useConfiguredDefault = false): Promise<WorkflowResult> {
      return exclusive(signal, async (signal) => {
        selection = undefined;
        requireUI(ctx);
        if (query.length > 100) throw new Error("Model search is limited to 100 characters.");
        const settings = await getSettings(ctx);
        signal.throwIfAborted();
        const models = await listModels(fetcher, signal);
        const needle = query.trim().toLowerCase();
        const matches = models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(needle));
        if (matches.length === 0) throw new Error("No text-to-image models match. Try show_image_model_list without a search filter.");
        matches.sort((a, b) => Number(b.id === settings.defaultModel) - Number(a.id === settings.defaultModel));
        let model: ImageModel;
        if (useConfiguredDefault && settings.selectionBehavior === "default") {
          const saved = matches.find((candidate) => candidate.id === settings.defaultModel);
          if (!saved) throw new Error("The saved image model is unavailable. Use /setup-image-generation to choose another; no substitute was selected.");
          model = saved;
        } else {
          const labels = matches.map((candidate) => `${candidate.name} | ${candidate.id}${candidate.id === settings.defaultModel ? " [saved default]" : ""}`);
          const answer = await ctx.ui.select(
            "Choose an OpenRouter image model for one generation. Charges vary by model.",
            labels, { signal, timeout: DIALOG_TIMEOUT_MS },
          );
          signal.throwIfAborted();
          if (answer === undefined) return cancelled();
          const index = labels.indexOf(answer);
          if (index < 0) throw new Error("The dialog returned an unknown model. No model was selected.");
          model = matches[index];
        }
        selection = { id: randomUUID(), model, expires: now() + SELECTION_TTL_MS, cwd: resolve(ctx.cwd) };
        return {
          content: [{ type: "text", text: JSON.stringify({
            selected_model: model.id,
            selection_id: selection.id,
            supported_options: model.parameters,
            next: "Call generate_image_with_openrouter with this selection_id and the requested prompt. This choice permits one attempt and expires in 15 minutes. The user must confirm before sending.",
            pricing: `https://openrouter.ai/${model.id}`,
          }) }],
          details: { status: "selected", model: model.id, selection_id: selection.id, parameters: model.parameters },
        };
      });
    },

    async generate(ctx: WorkflowContext, input: GenerationInput, signal?: AbortSignal): Promise<WorkflowResult> {
      return exclusive(signal, async (signal) => {
        requireUI(ctx);
        const chosen = selection;
        if (!chosen || chosen.id !== input.selection_id || chosen.expires <= now() || chosen.cwd !== resolve(ctx.cwd)) {
          throw new Error("A fresh user model choice is required. Call show_image_model_list and wait for the user; do not choose a model yourself.");
        }
        // Consume before any await so a duplicate or failed call cannot spend again.
        selection = undefined;
        const prompt = validatePrompt(input.prompt);
        const settings = await getSettings(ctx);
        signal.throwIfAborted();
        const sameModel = settings.defaultModel === chosen.model.id;
        const options = {
          aspect_ratio: input.aspect_ratio ?? (sameModel ? settings.aspectRatio ?? undefined : undefined),
          resolution: input.resolution ?? (sameModel ? settings.resolution ?? undefined : undefined),
        };
        validateOptions(chosen.model, options);
        const apiKey = deps.resolveAuth ? (await deps.resolveAuth(ctx, settings, signal)).apiKey : getApiKey()?.trim();
        signal.throwIfAborted();
        if (!apiKey) throw new Error("Set OPENROUTER_API_KEY or enable Pi credentials in /setup-image-generation. Never paste the key into chat or tool arguments.");
        const root = resolve(ctx.cwd, settings.outputDirectory);
        // Catch the common output failures before making a paid request.
        await mkdir(root, { recursive: true });
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("generated-images must be a real directory, not a symbolic link.");
        const approved = await ctx.ui.confirm(
          `Generate one image with ${chosen.model.name}?`,
          [
            `Model: ${chosen.model.id}`,
            `Pricing: https://openrouter.ai/${chosen.model.id}`,
            "This sends the prompt to OpenRouter and its model provider and may spend API credits. No automatic retries.",
            `Aspect ratio: ${options.aspect_ratio ?? "model default"}. Resolution: ${options.resolution ?? "model default"}.`,
            `Save under: ${root}`,
            settings.preview === "inline"
              ? "A raster preview up to 5 MiB will enter the Pi transcript and may be sent to your chat model. SVG outputs are not supported."
              : "Paths-only mode: no image bytes will enter the result or session history. SVG outputs are not supported.",
            "", "Prompt:", prompt,
          ].join("\n"),
          { signal, timeout: DIALOG_TIMEOUT_MS },
        );
        signal.throwIfAborted();
        if (!approved) return cancelled();
        const generated = await generateImage(chosen.model, prompt, options, apiKey, signal, fetcher);
        // Preserve a completed, potentially billed result even if cancellation arrives during the local save.
        let path: string;
        try {
          path = await saveImage(ctx.cwd, generated.image, deps.mutate, settings.outputDirectory);
        } catch {
          throw new Error("The image was generated, but saving it failed. Check generated-images permissions and disk space. Check OpenRouter activity before retrying; do not automatically regenerate.");
        }
        const previewIncluded = settings.preview === "inline" && generated.image.bytes.length <= MAX_PREVIEW_BYTES;
        const previewNote = settings.preview === "paths"
          ? " Preview omitted by privacy settings. Do not read or attach the image unless the user asks."
          : " Preview omitted because the image exceeds 5 MiB. Use read to inspect the saved file if needed.";
        const cost = generated.costUsd !== undefined ? ` Reported cost: $${generated.costUsd.toFixed(6)}.` : " Cost was not reported.";
        const content: WorkflowResult["content"] = [{
          type: "text", text: `Generated with ${chosen.model.id}. Saved: ${path}.${cost}${previewIncluded ? "" : previewNote}`,
        }];
        if (previewIncluded) content.push({ type: "image", data: generated.image.data, mimeType: generated.image.mimeType });
        return {
          content,
          details: { status: "generated", model: chosen.model.id, path, mimeType: generated.image.mimeType, previewIncluded },
          usage: generated.usage,
        };
      });
    },
  };
  return workflow;
}
