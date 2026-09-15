import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkConnection, listModels, validateOptions, type ImageModel } from "./openrouter.ts";
import { resolveImageAuth } from "./auth.ts";
import { createSettingsStore, validateSettings, type ImageSettings, type SettingsScope, type SettingsSnapshot } from "./settings.ts";
import { DIALOG_TIMEOUT_MS, type WorkflowContext } from "./workflow.ts";

export const SETUP_ACTIONS = [
  "OpenRouter authentication", "Default image model", "Model selection behavior", "Default aspect ratio",
  "Default resolution", "Output directory", "Preview privacy", "Check connection, no image generated",
  "Show current configuration", "Save settings", "Reset this scope", "Discard and close",
];
type SetupContext = WorkflowContext & Pick<ExtensionContext, "isIdle" | "signal"> & {
  ui: WorkflowContext["ui"] & Pick<ExtensionContext["ui"], "input" | "notify">;
};

export function describeSettings(settings: ImageSettings, cwd: string): string {
  return [
    `Authentication: ${settings.authentication === "environment" ? "OPENROUTER_API_KEY only" : "OPENROUTER_API_KEY, then Pi OpenRouter credentials"}`,
    `Default model: ${settings.defaultModel ?? "none"}`,
    `Model selection: ${settings.selectionBehavior === "ask" ? "ask every time" : "use saved default for /generate-image"}`,
    `Aspect ratio: ${settings.aspectRatio ?? "model default"}`,
    `Resolution: ${settings.resolution ?? "model default"}`,
    `Output directory: ${settings.outputDirectory}`,
    `Resolved output: ${resolve(cwd, settings.outputDirectory)}`,
    `Preview: ${settings.preview === "inline" ? "include image bytes in conversation" : "paths only, no image bytes"}`,
    "Final generation confirmation: always required",
  ].join("\n");
}

export function createSetupCommand(deps: {
  store: ReturnType<typeof createSettingsStore>;
  getSignal: () => AbortSignal;
  onSaved: () => void;
  fetcher?: typeof fetch;
  resolveAuth?: typeof resolveImageAuth;
}) {
  const fetcher = deps.fetcher ?? fetch;
  const auth = deps.resolveAuth ?? resolveImageAuth;
  let running = false;
  return async (args: string, ctx: SetupContext): Promise<void> => {
    if (!ctx.hasUI) throw new Error("/setup-image-generation requires a TUI or RPC client with extension dialogs.");
    if (running || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current operation to finish before opening image setup.", "warning");
      return;
    }
    if (args.trim()) { ctx.ui.notify("Usage: /setup-image-generation", "info"); return; }
    running = true;
    const signal = AbortSignal.any([deps.getSignal(), ...(ctx.signal ? [ctx.signal] : [])]);
    const trusted = () => ctx.isProjectTrusted?.() === true;
    const pick = async (title: string, options: string[]) => {
      signal.throwIfAborted();
      const answer = await ctx.ui.select(title, options, { signal, timeout: DIALOG_TIMEOUT_MS });
      signal.throwIfAborted();
      if (answer !== undefined && !options.includes(answer)) throw new Error("Setup received an unknown menu choice. Nothing was saved.");
      return answer;
    };
    const confirm = async (title: string, message: string) => {
      const answer = await ctx.ui.confirm(title, message, { signal, timeout: DIALOG_TIMEOUT_MS });
      signal.throwIfAborted();
      return answer;
    };
    try {
      const scopeAnswer = await pick("Where should image preferences be saved? Project profiles replace all global preferences for that project.",
        trusted() ? ["Global", "This project", "Cancel"] : ["Global", "Cancel"]);
      if (!scopeAnswer || scopeAnswer === "Cancel") return;
      const scope: SettingsScope = scopeAnswer === "Global" ? "global" : "project";
      const snapshot: SettingsSnapshot = await deps.store.load(ctx.cwd, trusted());
      let draft: ImageSettings = { ...(scope === "global" ? snapshot.globalSettings : snapshot.projectSettings) };
      let models: ImageModel[] | undefined;
      const catalog = async () => {
        models ??= await listModels(fetcher, signal);
        signal.throwIfAborted();
        return models;
      };
      const defaultModel = async () => {
        if (!draft.defaultModel) throw new Error("Choose a default image model first.");
        const model = (await catalog()).find((candidate) => candidate.id === draft.defaultModel);
        if (!model) throw new Error("The saved image model is unavailable. Choose a new default model.");
        return model;
      };
      for (;;) {
        const action = await pick(`Image generation setup, ${scope} draft. Changes are not saved until you choose Save settings.`, SETUP_ACTIONS);
        if (!action || action === "Discard and close") return;
        try {
          if (action === "OpenRouter authentication") {
            const choice = await pick("Keys never belong in chat or image settings. Set OPENROUTER_API_KEY before starting Pi, or enable fallback to Pi's existing OpenRouter credentials.",
              ["Environment key only", "Environment key, otherwise Pi credentials", "Back"]);
            if (choice === "Environment key only") draft.authentication = "environment";
            if (choice === "Environment key, otherwise Pi credentials") draft.authentication = "environment-or-pi";
          } else if (action === "Default image model") {
            const items = await catalog();
            const labels = items.map((model) => `${model.name} | ${model.id}`);
            const choice = await pick("Choose a default model. Changing it clears saved ratio and resolution. Pricing: https://openrouter.ai/models?output_modalities=image", ["No default model", ...labels]);
            if (choice === undefined) continue;
            const id = choice === "No default model" ? null : items[labels.indexOf(choice)].id;
            if (id !== draft.defaultModel) {
              draft = { ...draft, defaultModel: id, aspectRatio: null, resolution: null };
              if (id === null) draft.selectionBehavior = "ask";
            }
          } else if (action === "Model selection behavior") {
            const choice = await pick("Explicit show_image_model_list calls always open the picker. Final generation confirmation is always required.",
              ["Ask every time", "Use saved default for /generate-image", "Back"]);
            if (choice === "Ask every time") draft.selectionBehavior = "ask";
            if (choice === "Use saved default for /generate-image") {
              await defaultModel();
              draft.selectionBehavior = "default";
            }
          } else if (action === "Default aspect ratio" || action === "Default resolution") {
            const model = await defaultModel();
            const key = action === "Default aspect ratio" ? "aspect_ratio" : "resolution";
            const field = key === "aspect_ratio" ? "aspectRatio" : "resolution";
            const cap = model.parameters[key];
            const values = cap?.type === "enum" ? cap.values : [];
            const choice = await pick(`${action} for ${model.name}. Only advertised values are listed.`, ["Model default", ...values]);
            if (choice !== undefined) draft[field] = choice === "Model default" ? null : choice;
          } else if (action === "Output directory") {
            const path = await ctx.ui.input("Output directory, relative to each working directory or an absolute path", draft.outputDirectory, { signal, timeout: DIALOG_TIMEOUT_MS });
            signal.throwIfAborted();
            if (path !== undefined) draft = validateSettings({ ...draft, outputDirectory: path.trim() });
          } else if (action === "Preview privacy") {
            const choice = await pick("Inline previews enter session history and may reach your chat model. Paths-only omits all image bytes from results.",
              ["Include inline previews", "File paths only", "Back"]);
            if (choice === "Include inline previews") draft.preview = "inline";
            if (choice === "File paths only") draft.preview = "paths";
          } else if (action === "Check connection, no image generated") {
            const credentials = await auth(ctx, draft, signal);
            if (!credentials.apiKey) throw new Error("No OpenRouter credential is configured. Set OPENROUTER_API_KEY or configure Pi's OpenRouter login and enable fallback. Do not paste a key into chat.");
            const count = await checkConnection(credentials.apiKey, fetcher, signal);
            signal.throwIfAborted();
            ctx.ui.notify(`OpenRouter authentication verified via ${credentials.source}. ${count} image models available. No image was generated.`, "info");
            models = undefined;
          } else if (action === "Show current configuration") {
            const credentials = await auth(ctx, snapshot.settings, signal);
            await pick([
              `Saved effective profile source for every field: ${snapshot.source}`,
              `Global file: ${snapshot.globalPath}`, `Project file: ${snapshot.projectPath}`,
              `Credential source: ${credentials.source}. Keys are hidden; presence is not an authentication check.`,
              describeSettings(snapshot.settings, ctx.cwd), "", `Unsaved ${scope} draft:`, describeSettings(draft, ctx.cwd),
            ].join("\n"), ["Back"]);
          } else if (action === "Save settings") {
            validateSettings(draft);
            if (draft.defaultModel) {
              models = undefined;
              validateOptions(await defaultModel(), { aspect_ratio: draft.aspectRatio ?? undefined, resolution: draft.resolution ?? undefined });
            }
            const path = scope === "global" ? snapshot.globalPath : snapshot.projectPath;
            if (!await confirm("Save image preferences?", `${describeSettings(draft, ctx.cwd)}\n\nSave to: ${path}\n${scope === "global" && snapshot.source === "project" ? "The current project profile still overrides this global profile." : "This saves a complete profile, not individual overrides."}\nNo API keys are saved.`)) continue;
            await deps.store.save(snapshot, scope, draft, trusted(), signal);
            deps.onSaved();
            if (!signal.aborted) ctx.ui.notify(`Image preferences saved for ${scope}.`, "info");
            return;
          } else if (action === "Reset this scope") {
            if (!await confirm(`Reset ${scope} image preferences?`, `This disables the ${scope} profile. ${scope === "global" ? "Built-in defaults apply unless a project profile overrides them." : "Global preferences or built-in defaults will apply."} Credentials and generated images are unchanged.`)) continue;
            await deps.store.save(snapshot, scope, null, trusted(), signal);
            deps.onSaved();
            if (!signal.aborted) ctx.ui.notify(`${scope} image preferences reset.`, "info");
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          ctx.ui.notify(error instanceof Error ? error.message : "Image setup failed. No automatic retry was made.", "error");
        }
      }
    } catch (error) {
      if (!signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : "Could not open image setup.", "error");
    } finally { running = false; }
  };
}
