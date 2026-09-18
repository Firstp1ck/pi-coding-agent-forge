import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createReviewStorage } from "./src/storage.ts";
import { DeterministicReviewRuntime, freezeReview } from "./src/runner.ts";
import { createSessionWorkTracker } from "./src/session-work.ts";
import {
  createReviewRuntimeStore,
  createReviewSettingsStore,
  THINKING_LEVELS,
  type ReviewMode,
  type ReviewModelProfile,
  type ReviewSettings,
  type ReviewThinkingLevel,
} from "./src/settings.ts";
import {
  createReviewStatusPublisher,
  createStatusOverlayController,
  sanitizeUiText,
  showReviewSetup,
  type ReviewModelChoice,
} from "./src/tui.ts";

export const REVIEW_COMMAND = "review";
export const REVIEW_SETUP_COMMAND = "review-setup";
export const REVIEW_STATUS_COMMAND = "review-status";

function words(input: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const text = input.trim();
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\" && quote !== "'") {
      const next = text[index + 1];
      if (next && (next === "\\" || next === '"' || /\s/u.test(next))) { current += next; index += 1; }
      else current += character;
      continue;
    }
    if (quote) { if (character === quote) quote = undefined; else current += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/u.test(character)) { if (current) { output.push(current); current = ""; } continue; }
    current += character;
  }
  if (quote) throw new Error("Review arguments contain an unfinished quote.");
  if (current) output.push(current);
  return output;
}

function supportedThinking(model: Model<any>): ReviewThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return typeof mapped === "string";
    return true;
  });
}

function availableModels(ctx: ExtensionCommandContext): ReviewModelChoice[] {
  const models = ctx.scopedModels?.length ? ctx.scopedModels.map((item) => item.model) : ctx.modelRegistry.getAvailable();
  const unique = new Map<string, ReviewModelChoice>();
  for (const model of models) {
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
    const key = `${model.provider}\0${model.id}`;
    unique.set(key, {
      label: `${model.provider}/${model.id}`,
      profile: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
      supportedThinking: supportedThinking(model),
    });
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function resolveModel(ctx: ExtensionCommandContext, settings: ReviewSettings): ReviewModelProfile {
  if (settings.model) {
    const model = ctx.modelRegistry.find(settings.model.provider, settings.model.modelId);
    const inScope = !ctx.scopedModels?.length || ctx.scopedModels.some((item) => item.model.provider === settings.model!.provider && item.model.id === settings.model!.modelId);
    if (!model || !inScope || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Saved reviewer model is unavailable, out of scope, or unauthenticated: ${settings.model.provider}/${settings.model.modelId}`);
    if (!supportedThinking(model).includes(settings.model.thinkingLevel)) throw new Error(`Saved reasoning effort is unsupported by ${settings.model.provider}/${settings.model.modelId}.`);
    return settings.model;
  }
  if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("No authenticated current model is available for the reviewer. Run /review-setup.");
  const requested = THINKING_LEVELS.includes(ctx.thinkingLevel as ReviewThinkingLevel) ? ctx.thinkingLevel as ReviewThinkingLevel : "off";
  const thinkingLevel = supportedThinking(ctx.model).includes(requested) ? requested : "off";
  return { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel };
}

function selection(args: string[], settings: ReviewSettings): { action: "start"; mode: ReviewMode; paths: string[] } | { action: "resume"; reviewId?: string } | { action: "cancel"; reviewId?: string } {
  if (args.length === 0) return { action: "start", mode: settings.mode, paths: settings.paths };
  const [command, ...rest] = args;
  if (command === "resume" || command === "cancel") {
    if (rest.length > 1) throw new Error(`Usage: /review ${command} [review-id]`);
    return { action: command, reviewId: rest[0] };
  }
  if (command === "git" || command === "work") {
    if (rest.length) throw new Error(`Usage: /review ${command}`);
    return { action: "start", mode: command, paths: [] };
  }
  if (command === "paths") {
    if (!rest.length) throw new Error("Usage: /review paths <project-relative-path> [...]");
    return { action: "start", mode: "paths", paths: rest };
  }
  throw new Error("Usage: /review [git|work|paths <path>...|resume [review-id]|cancel [review-id]]");
}

export default function deterministicReviewExtension(pi: ExtensionAPI): void {
  const settingsStore = createReviewSettingsStore(getAgentDir());
  const runtimeStore = createReviewRuntimeStore(getAgentDir());
  const status = createReviewStatusPublisher();
  const overlay = createStatusOverlayController(status);
  const runtime = new DeterministicReviewRuntime(runtimeStore, status);
  const workTracker = createSessionWorkTracker();
  let launching = false;
  let shuttingDown = false;
  let commandEpoch = 0;
  let initializing = 0;
  let pendingCreation: AbortController | undefined;

  pi.on("tool_call", (event, ctx) => {
    workTracker.observeToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }, ctx.sessionManager.getLeafId());
  });
  pi.on("tool_result", (event, ctx) => {
    workTracker.observeToolResult({ toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }, ctx.cwd);
  });
  pi.on("user_bash", (_event, ctx) => { workTracker.observeUserShell(ctx.sessionManager.getLeafId()); });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    pendingCreation?.abort();
    overlay.close();
    await runtime.pauseForShutdown();
  });

  pi.registerCommand(REVIEW_SETUP_COMMAND, {
    description: "Configure deterministic review mode, model, scope, exclusions, and continuation limits",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify(`/${REVIEW_SETUP_COMMAND} takes no arguments.`, "error"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify(`/${REVIEW_SETUP_COMMAND} requires Pi's native TUI.`, "error"); return; }
      if (runtime.isActive()) { ctx.ui.notify("A review is running. Cancel or wait before changing its defaults.", "warning"); return; }
      try {
        const snapshot = await settingsStore.load();
        const models = availableModels(ctx);
        if (!models.length) throw new Error("No authenticated model is available in the current model scope.");
        const initial = snapshot.settings.model ? snapshot.settings : { ...snapshot.settings, model: resolveModel(ctx, snapshot.settings) };
        const configured = await showReviewSetup(ctx, initial, models);
        if (!configured) { ctx.ui.notify("Review setup cancelled. No settings were changed.", "info"); return; }
        await settingsStore.save(snapshot.raw, configured);
        ctx.ui.notify("Review settings saved. The main agent model and tools were not changed.", "info");
      } catch (error) {
        ctx.ui.notify(`Review setup failed: ${sanitizeUiText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });

  pi.registerCommand(REVIEW_COMMAND, {
    description: "Start, resume, or cancel an isolated deterministic code review",
    handler: async (rawArgs, ctx) => {
      let counted = false;
      try {
        if (shuttingDown) throw new Error("Review extension is shutting down.");
        const args = words(rawArgs);
        if (args[0] === "cancel" && args.length <= 2) {
          commandEpoch += 1;
          if (initializing && !args[1] && !runtime.isActive()) {
            pendingCreation?.abort();
            ctx.ui.notify("Review initialization cancelled. No reviewer model will start.", "info");
            return;
          }
        }
        const epoch = commandEpoch;
        if (args[0] !== "cancel") { initializing += 1; counted = true; }
        const saved = await settingsStore.load();
        if (shuttingDown || (args[0] !== "cancel" && epoch !== commandEpoch)) throw new Error("Review command initialization was cancelled.");
        const request = selection(args, saved.settings);
        if (request.action === "cancel") {
          if (pendingCreation && !request.reviewId) {
            pendingCreation.abort();
            ctx.ui.notify("Review snapshot cancellation requested. No reviewer model will start.", "info");
            return;
          }
          await runtime.cancel(ctx, request.reviewId);
          ctx.ui.notify("Review cancelled. Frozen evidence remains stored for inspection.", "info");
          return;
        }
        if (launching || runtime.isActive()) throw new Error("A review is already starting or running.");
        launching = true;
        try {
          if (request.action === "resume") {
            await runtime.resume(ctx, request.reviewId);
            ctx.ui.notify("Review resumed in an isolated read-only agent.", "info");
            return;
          }
          const controller = new AbortController();
          pendingCreation = controller;
          const model = resolveModel(ctx, saved.settings);
          const work = request.mode === "work" ? workTracker.snapshot(ctx, saved.settings.maxContextBytes) : undefined;
          const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
          const frozen = await freezeReview({ host: ctx, settings: saved.settings, mode: request.mode, paths: request.paths, model, work, runtimeStore, storage, signal: controller.signal });
          if (controller.signal.aborted) {
            await runtime.cancel(ctx, frozen.state.reviewId);
            ctx.ui.notify("Review snapshot was frozen but the reviewer start was cancelled. No model was called.", "info");
            return;
          }
          await runtime.startFrozen(ctx, frozen.state, frozen.record, controller.signal);
          ctx.ui.notify(`Review ${frozen.state.reviewId} froze ${frozen.state.manifest.targets.length} target(s) before model use. It is now running independently.`, "info");
        } finally {
          pendingCreation = undefined;
          launching = false;
        }
      } catch (error) {
        ctx.ui.notify(`Review command failed: ${sanitizeUiText(error instanceof Error ? error.message : String(error))}`, "error");
      } finally {
        if (counted) initializing -= 1;
      }
    },
  });

  pi.registerCommand(REVIEW_STATUS_COMMAND, {
    description: "Toggle or scroll a live deterministic review status overlay",
    handler: async (rawArgs, ctx) => {
      const argument = rawArgs.trim();
      if (argument && !["up", "down", "close"].includes(argument)) {
        ctx.ui.notify(`Usage: /${REVIEW_STATUS_COMMAND} [up|down|close]`, "error");
        return;
      }
      try {
        if (argument === "close") { overlay.close(); return; }
        if (argument === "up" || argument === "down") { overlay.scroll(argument); return; }
        await runtime.loadStatus(ctx);
        overlay.toggle(ctx);
      } catch (error) {
        ctx.ui.notify(`Review status failed: ${sanitizeUiText(error instanceof Error ? error.message : String(error))}`, "error");
      }
    },
  });
}
