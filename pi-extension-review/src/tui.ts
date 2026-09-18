import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSettings, ReviewModelProfile, ReviewThinkingLevel } from "./settings.ts";
import { THINKING_LEVELS, validateReviewSettings } from "./settings.ts";

export type ReviewModelChoice = { label: string; profile: ReviewModelProfile; supportedThinking: ReviewThinkingLevel[] };
export type ReviewStatusSnapshot = { title: string; lines: string[] };

type StatusListener = (snapshot: ReviewStatusSnapshot) => void;

export function sanitizeUiText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

async function chooseNumber(ctx: ExtensionCommandContext, title: string, current: number, minimum: number, maximum: number): Promise<number | null> {
  const raw = await ctx.ui.input(title, String(current));
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    ctx.ui.notify(`${title} must be an integer from ${minimum} to ${maximum}.`, "error");
    return null;
  }
  return value;
}

/** Run a native, cancellable setup flow. The caller persists only the confirmed result. */
export async function showReviewSetup(
  ctx: ExtensionCommandContext,
  initial: ReviewSettings,
  models: readonly ReviewModelChoice[],
): Promise<ReviewSettings | null> {
  const mode = await ctx.ui.select("Review mode", ["git", "work", "paths"]);
  if (!mode) return null;
  let paths = initial.paths;
  if (mode === "paths") {
    const raw = await ctx.ui.input("Paths, separated by commas", initial.paths.join(", "));
    if (raw === undefined) return null;
    paths = parseList(raw);
    if (paths.length === 0) {
      ctx.ui.notify("Paths mode needs at least one project-relative path.", "error");
      return null;
    }
  }
  const modelLabels = models.map((item) => item.label);
  const selectedLabel = await ctx.ui.select("Reviewer model", modelLabels);
  if (!selectedLabel) return null;
  const selected = models.find((item) => item.label === selectedLabel);
  if (!selected) return null;
  const thinking = await ctx.ui.select("Reviewer reasoning effort", selected.supportedThinking);
  if (!thinking || !THINKING_LEVELS.includes(thinking as ReviewThinkingLevel)) return null;
  const exclusionInput = await ctx.ui.input("Extra exclusions, separated by commas", initial.exclusions.join(", "));
  if (exclusionInput === undefined) return null;
  const contextLines = await chooseNumber(ctx, "Git context lines", initial.contextLines, 1, 100);
  if (contextLines === null) return null;
  const maxTurns = await chooseNumber(ctx, "Maximum turns per attempt", initial.maxTurns, 1, 1_000);
  if (maxTurns === null) return null;
  const timeoutSeconds = await chooseNumber(ctx, "Attempt timeout in seconds", Math.floor(initial.timeoutMs / 1_000), 1, 3_600);
  if (timeoutSeconds === null) return null;
  const maxNoProgress = await chooseNumber(ctx, "Consecutive no-progress completions", initial.maxNoProgress, 1, 20);
  if (maxNoProgress === null) return null;
  const candidate = validateReviewSettings({
    ...initial,
    mode,
    paths,
    exclusions: parseList(exclusionInput),
    model: { ...selected.profile, thinkingLevel: thinking },
    contextLines,
    maxTurns,
    timeoutMs: timeoutSeconds * 1_000,
    maxNoProgress,
  });
  const summary = [
    `Mode: ${candidate.mode}${candidate.mode === "paths" ? ` (${candidate.paths.join(", ")})` : ""}`,
    `Model: ${candidate.model!.provider}/${candidate.model!.modelId} (${candidate.model!.thinkingLevel})`,
    `Context: ${candidate.contextLines} lines`,
    `Limits: ${candidate.maxTurns} turns, ${timeoutSeconds}s, ${candidate.maxNoProgress} no-progress completions`,
    `Exclusions: ${candidate.exclusions.length ? candidate.exclusions.join(", ") : "none beyond defaults"}`,
  ].join("\n");
  return await ctx.ui.confirm("Save review settings?", summary) ? candidate : null;
}

export function createReviewStatusPublisher(initial: ReviewStatusSnapshot = { title: "Review status", lines: ["No review selected."] }) {
  let snapshot = initial;
  const listeners = new Set<StatusListener>();
  return {
    get: () => snapshot,
    publish(next: ReviewStatusSnapshot): void {
      snapshot = { title: sanitizeUiText(next.title), lines: next.lines.map(sanitizeUiText) };
      for (const listener of listeners) listener(snapshot);
    },
    subscribe(listener: StatusListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
  };
}

export type ReviewStatusPublisher = ReturnType<typeof createReviewStatusPublisher>;

export class ReviewStatusComponent {
  private snapshot: ReviewStatusSnapshot;
  private scroll = 0;
  private readonly requestRender: () => void;
  private readonly close: () => void;
  constructor(snapshot: ReviewStatusSnapshot, requestRender: () => void, close: () => void) {
    this.snapshot = snapshot;
    this.requestRender = requestRender;
    this.close = close;
  }
  update(snapshot: ReviewStatusSnapshot): void {
    this.snapshot = snapshot;
    this.scroll = Math.min(this.scroll, Math.max(0, snapshot.lines.length - 1));
    this.requestRender();
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.close();
    else if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, Key.down)) this.scroll = Math.min(Math.max(0, this.snapshot.lines.length - 1), this.scroll + 1);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 5);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(Math.max(0, this.snapshot.lines.length - 1), this.scroll + 5);
    this.requestRender();
  }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (safeWidth < 5) return [truncateToWidth("review", safeWidth, "")];
    const inner = safeWidth - 2;
    const body = this.snapshot.lines.slice(this.scroll, this.scroll + 12);
    const lines = [
      `╭${"─".repeat(inner)}╮`,
      `│${truncateToWidth(` ${this.snapshot.title}`, inner, "…").padEnd(inner)}│`,
      ...body.map((line) => `│${truncateToWidth(` ${line}`, inner, "…").padEnd(inner)}│`),
      `│${truncateToWidth(` ${this.scroll + 1}-${Math.min(this.snapshot.lines.length, this.scroll + body.length)}/${this.snapshot.lines.length} · /review-status toggles · up/down subcommands scroll`, inner, "…").padEnd(inner)}│`,
      `╰${"─".repeat(inner)}╯`,
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }
  invalidate(): void {}
}

/** Own one fire-and-forget status overlay without awaiting reviewer or main-agent activity. */
export function createStatusOverlayController(publisher: ReviewStatusPublisher) {
  let done: (() => void) | undefined;
  let component: ReviewStatusComponent | undefined;
  let unsubscribe: (() => void) | undefined;
  let activeId: symbol | undefined;
  const close = () => {
    const finish = done;
    done = undefined;
    component = undefined;
    activeId = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    finish?.();
  };
  return {
    isOpen: () => Boolean(done),
    close,
    scroll(direction: "up" | "down"): void { component?.handleInput(direction === "up" ? "\x1b[A" : "\x1b[B"); },
    toggle(ctx: ExtensionCommandContext): void {
      if (done) { close(); return; }
      if (ctx.mode !== "tui") {
        const snapshot = publisher.get();
        ctx.ui.notify([snapshot.title, ...snapshot.lines].join("\n"), "info");
        return;
      }
      const overlayId = Symbol("review-status-overlay");
      activeId = overlayId;
      const pending = ctx.ui.custom<void>((tui, _theme, _keybindings, finish) => {
        let settled = false;
        done = () => { if (!settled) { settled = true; finish(); } };
        component = new ReviewStatusComponent(publisher.get(), () => tui.requestRender(), close);
        unsubscribe = publisher.subscribe((snapshot) => component?.update(snapshot));
        return component;
      }, {
        overlay: true,
        overlayOptions: { anchor: "top-right", width: "45%", minWidth: 20, maxHeight: "70%", margin: 1 },
        onHandle(handle) { handle.unfocus(); },
      });
      void pending.catch((error) => {
        if (activeId === overlayId) close();
        ctx.ui.notify(`Review status overlay failed: ${sanitizeUiText(error instanceof Error ? error.message : String(error))}`, "error");
      }).finally(() => {
        if (activeId === overlayId) close();
      });
    },
  };
}
