import {
  getSelectListTheme,
  getSettingsListTheme,
  keyHint,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader,
  Editor,
  Key,
  matchesKey,
  type OverlayOptions,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { sanitizeDiagnostic } from "./core.ts";
import {
  GUIDED_GIT_ENTRY_STAGES,
  GUIDED_GIT_MESSAGE_VARIANTS,
  GUIDED_GIT_STAGING_DEFAULTS,
  GUIDED_GIT_VERIFICATION_POLICIES,
  supportedGuidedGitThinkingLevels,
  type GuidedGitGenerationProfile,
  type GuidedGitPreferences,
  type GuidedGitThinkingLevel,
} from "./preferences.ts";

export const GUIDED_GIT_OVERLAY_OPTIONS: Readonly<OverlayOptions> = Object.freeze({
  anchor: "center",
  width: "78%",
  minWidth: 36,
  maxHeight: "85%",
  margin: 1,
});

const STAGES = ["Initialize", "Stage", "Message", "Commit", "Push"] as const;
export type StageName = (typeof STAGES)[number];
export type Action = { value: string; label: string; description?: string };

export function progressText(activeStage: StageName): string {
  const activeIndex = STAGES.indexOf(activeStage);
  return STAGES.map((stage, index) => `${index < activeIndex ? "✓" : index === activeIndex ? "●" : "○"} ${stage}`).join("  →  ");
}

function selectListTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function overlayRowBudget(tui: TUI): number {
  const terminalRows = Math.max(1, Math.floor(tui.terminal?.rows ?? 24));
  return Math.max(1, Math.min(Math.floor(terminalRows * 0.85), terminalRows - 2));
}

function nativeVisibleRows(rowBudget: number, itemCount: number): number {
  if (itemCount <= rowBudget) return Math.max(1, itemCount);
  return Math.max(1, rowBudget - 1);
}

class ActionOverlay {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly stage: StageName;
  private readonly title: string;
  private readonly detailText: string;
  private readonly items: SelectItem[];
  private readonly done: (value: string | null) => void;
  private list: SelectList;
  private listVisibleRows = 0;
  private selectedValue: string | undefined;
  private detailOffset = 0;
  private detailPageSize = 1;

  constructor(
    tui: TUI,
    theme: Theme,
    stage: StageName,
    title: string,
    detailText: string,
    items: SelectItem[],
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.stage = stage;
    this.title = title;
    this.detailText = sanitizeDiagnostic(detailText, 128 * 1024);
    this.items = items;
    this.done = done;
    this.list = this.createList(1);
  }

  private createList(visibleRows: number): SelectList {
    const list = new SelectList(this.items, visibleRows, selectListTheme(this.theme));
    const selectedIndex = this.selectedValue === undefined
      ? 0
      : Math.max(0, this.items.findIndex((item) => item.value === this.selectedValue));
    list.setSelectedIndex(selectedIndex);
    this.selectedValue = list.getSelectedItem()?.value;
    list.onSelectionChange = (item) => { this.selectedValue = item.value; };
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }

  private resizeList(visibleRows: number): void {
    if (visibleRows === this.listVisibleRows) return;
    this.selectedValue = this.list.getSelectedItem()?.value ?? this.selectedValue;
    this.list = this.createList(visibleRows);
    this.listVisibleRows = visibleRows;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) this.detailOffset = Math.max(0, this.detailOffset - this.detailPageSize);
    else if (matchesKey(data, Key.pageDown)) this.detailOffset += this.detailPageSize;
    else this.list.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const contentWidth = safeWidth >= 5 ? safeWidth - 4 : safeWidth;
    const maxRows = overlayRowBudget(this.tui);
    const desiredActionRows = Math.max(1, Math.min(this.items.length + 1, maxRows <= 5 ? 2 : Math.max(2, Math.floor(maxRows * 0.3))));
    this.resizeList(nativeVisibleRows(desiredActionRows, this.items.length));
    const listLines = this.list.render(contentWidth);
    const detailLines = new Text(this.theme.fg("muted", this.detailText), 0, 0).render(contentWidth);
    const remainingRows = Math.max(0, maxRows - listLines.length);
    const hasPreview = remainingRows >= 2;
    let optionalRows = Math.max(0, remainingRows - (hasPreview ? 2 : 0));
    const includeTitle = optionalRows-- > 0;
    const includeProgress = optionalRows-- > 0;
    const includeHelp = optionalRows-- > 0;
    const includeBorders = optionalRows >= 2;
    if (includeBorders) optionalRows -= 2;
    this.detailPageSize = hasPreview ? Math.max(1, 1 + optionalRows) : 1;
    const maxOffset = Math.max(0, detailLines.length - this.detailPageSize);
    this.detailOffset = Math.min(this.detailOffset, maxOffset);
    const visibleDetails = hasPreview ? detailLines.slice(this.detailOffset, this.detailOffset + this.detailPageSize) : [];
    const scroll = this.theme.fg("dim", detailLines.length > this.detailPageSize
      ? `Preview lines ${this.detailOffset + 1}-${this.detailOffset + visibleDetails.length} of ${detailLines.length} · PgUp/PgDn`
      : `Preview lines ${detailLines.length} of ${detailLines.length}`);
    const lines: string[] = [];
    if (includeProgress) lines.push(this.theme.fg("accent", this.theme.bold(progressText(this.stage))));
    if (includeTitle) lines.push(`${this.theme.fg("text", this.theme.bold(sanitizeDiagnostic(this.title, 300)))}${includeHelp ? "" : " · Esc cancels"}`);
    if (hasPreview) lines.push(scroll, ...visibleDetails);
    lines.push(...listLines);
    if (includeHelp) lines.push(this.theme.fg("dim", "PgUp/PgDn preview · ↑↓ actions · Enter select · Esc cancel"));
    return renderOverlayPanel(lines, safeWidth, this.theme, includeBorders);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

/** Show one bounded centered action overlay backed by Pi's native SelectList. */
export async function showActionScreen(
  ctx: ExtensionCommandContext,
  stage: StageName,
  title: string,
  details: string,
  actions: readonly Action[],
): Promise<string | null> {
  const items: SelectItem[] = actions.map((action) => ({
    value: action.value,
    label: sanitizeDiagnostic(action.label, 240).replace(/\n/gu, " "),
    description: action.description ? sanitizeDiagnostic(action.description, 500).replace(/\n/gu, " ") : undefined,
  }));
  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new ActionOverlay(tui, theme, stage, title, details, items, done), {
    overlay: true,
    overlayOptions: GUIDED_GIT_OVERLAY_OPTIONS,
  });
}

/** Confirm a mutation without making Escape equivalent to acceptance. */
export async function showConfirmationOverlay(
  ctx: ExtensionCommandContext,
  stage: StageName,
  title: string,
  details: string,
  confirmLabel: string,
): Promise<boolean> {
  return await showActionScreen(ctx, stage, title, details, [
    { value: "cancel", label: "Cancel", description: "Make no change" },
    { value: "confirm", label: confirmLabel },
  ]) === "confirm";
}

/** Native cancellable spinner inside the same panel used by workflow menus. */
export class GenerationOverlay extends CancellableLoader {
  private readonly overlayTui: TUI;
  private readonly overlayTheme: Theme;

  constructor(tui: TUI, theme: Theme, message: string) {
    super(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), message);
    this.overlayTui = tui;
    this.overlayTheme = theme;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const contentWidth = safeWidth >= 5 ? safeWidth - 4 : safeWidth;
    const maxRows = overlayRowBudget(this.overlayTui);
    const frame = maxRows >= 4;
    const bodyRows = maxRows - (frame ? 2 : 0);
    const helpRows = bodyRows >= 2 ? 1 : 0;
    // Omit the native loader's leading spacer so short terminals retain the provider notice.
    const lines = super.render(contentWidth).slice(1, 1 + bodyRows - helpRows);
    if (helpRows) lines.push(this.overlayTheme.fg("dim", keyHint("tui.select.cancel", "cancel")));
    return renderOverlayPanel(lines, safeWidth, this.overlayTheme, frame);
  }
}

class CommitEditorOverlay implements Focusable {
  private readonly editor: Editor;
  private readonly done: (value: string | null) => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private _focused = false;
  private resizeRequired = false;

  constructor(
    tui: TUI,
    theme: Theme,
    prefill: string,
    done: (value: string | null) => void,
  ) {
    this.done = done;
    this.tui = tui;
    this.theme = theme;
    this.editor = new Editor(tui, { borderColor: (text) => theme.fg("borderMuted", text), selectList: getSelectListTheme() });
    this.editor.setText(prefill);
    this.editor.onSubmit = (text) => this.done(text);
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value; }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.done(null);
    else if (!this.resizeRequired) this.editor.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const contentWidth = safeWidth >= 5 ? safeWidth - 4 : safeWidth;
    const maxRows = overlayRowBudget(this.tui);
    const heading = this.theme.fg("accent", this.theme.bold("Commit message · Enter submits · Shift+Enter/Ctrl+J newline · Esc cancels"));
    this.editor.focused = this._focused;
    const rendered = this.editor.render(contentWidth);
    if (rendered.length + 2 > maxRows) {
      this.resizeRequired = true;
      this.editor.focused = false;
      const frame = safeWidth >= 5 && maxRows >= 5;
      const lines = [
        this.theme.fg("warning", "Commit editor paused · resize terminal"),
        this.theme.fg("muted", "The native editor viewport cannot fit safely at this height."),
        this.theme.fg("dim", "Input and submit are disabled · Esc cancels"),
      ].slice(0, maxRows - (frame ? 2 : 0));
      return renderOverlayPanel(lines, safeWidth, this.theme, frame);
    }
    this.resizeRequired = false;
    const lines = [heading, ...rendered, this.theme.fg("dim", "Subject: up to 72 characters. Separate a body with a blank line.")];
    // Keep the native cursor viewport intact when only the side borders fit.
    return renderOverlayPanel(lines, safeWidth, this.theme, lines.length + 2 <= maxRows);
  }

  invalidate(): void { this.editor.invalidate(); }
}

/** Edit a commit message in a centered native Editor overlay. */
export async function showCommitEditor(ctx: ExtensionCommandContext, prefill: string): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new CommitEditorOverlay(tui, theme, prefill, done), {
    overlay: true,
    overlayOptions: GUIDED_GIT_OVERLAY_OPTIONS,
  });
}

export interface SetupModelChoice {
  key: string;
  provider: string;
  modelId: string;
  label: string;
  model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<GuidedGitThinkingLevel, string | null>> };
}

function clonePreferences(value: GuidedGitPreferences): GuidedGitPreferences {
  return {
    generation: {
      primary: value.generation.primary ? { ...value.generation.primary } : null,
      fallback: value.generation.fallback ? { ...value.generation.fallback } : null,
    },
    commit: { ...value.commit },
    staging: value.staging,
    defaultEntry: value.defaultEntry,
    verification: value.verification,
  };
}

function profileKey(profile: GuidedGitGenerationProfile | null): string {
  return profile ? `${profile.provider}\u0000${profile.modelId}` : "none";
}

function profileFromKey(key: string, choices: readonly SetupModelChoice[], currentEffort: GuidedGitThinkingLevel): GuidedGitGenerationProfile | null {
  if (key === "none") return null;
  const choice = choices.find((candidate) => candidate.key === key);
  if (!choice) return null;
  const levels = supportedGuidedGitThinkingLevels(choice.model);
  return { provider: choice.provider, modelId: choice.modelId, thinkingLevel: levels.includes(currentEffort) ? currentEffort : levels[0]! };
}

function setupChromeRows(tui: TUI): { frame: boolean; header: number; footer: number; content: number } {
  const budget = Math.max(1, Math.floor(overlayRowBudget(tui) / 1.8));
  const frame = budget >= 8;
  const innerRows = budget - (frame ? 2 : 0);
  const header = innerRows >= 8 ? 2 : innerRows >= 6 ? 1 : 0;
  const footer = innerRows >= 2 ? 1 : 0;
  return { frame, header, footer, content: Math.max(1, innerRows - header - footer) };
}

function renderOverlayPanel(lines: string[], width: number, theme: Theme, frame: boolean): string[] {
  const background = theme.getBgAnsi("customMessageBg");
  const paint = (line: string) => theme.bg("customMessageBg",
    // Native inputs and truncation can reset the background inside a row.
    line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background));
  if (width < 5) return lines.map((line) => paint(truncateToWidth(line, width, "", true)));
  const border = (text: string) => theme.fg("borderAccent", text);
  const body = lines.map((line) => paint(`${border("│")} ${truncateToWidth(line, width - 4, "…", true)} ${border("│")}`));
  if (!frame) return body;
  return [
    paint(border(`╭${"─".repeat(width - 2)}╮`)),
    ...body,
    paint(border(`╰${"─".repeat(width - 2)}╯`)),
  ];
}

function modelSubmenu(tui: TUI, theme: Theme, choices: readonly SetupModelChoice[], allowNone: boolean, done: (value?: string) => void) {
  const items: SelectItem[] = [
    ...(allowNone ? [{ value: "none", label: "None", description: "Do not use this generation profile" }] : []),
    ...choices.map((choice) => ({ value: choice.key, label: choice.label, description: `${choice.provider}/${choice.modelId}` })),
  ];
  let selectedValue = items[0]?.value;
  let visibleRows = 0;
  let list: SelectList;
  const rebuild = (nextVisibleRows: number) => {
    if (list && visibleRows === nextVisibleRows) return;
    selectedValue = list?.getSelectedItem()?.value ?? selectedValue;
    list = new SelectList(items, nextVisibleRows, selectListTheme(theme));
    list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selectedValue)));
    list.onSelectionChange = (item) => { selectedValue = item.value; };
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();
    visibleRows = nextVisibleRows;
  };
  rebuild(1);
  return {
    render(width: number) {
      const rowBudget = setupChromeRows(tui).content;
      rebuild(nativeVisibleRows(rowBudget, items.length));
      return list.render(Math.max(1, width));
    },
    invalidate() { list.invalidate(); },
    handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
  };
}

type SetupScreenResult = { kind: "save" | "cancel" | "refresh"; draft: GuidedGitPreferences };

async function showSetupSettingsScreen(
  ctx: ExtensionCommandContext,
  input: GuidedGitPreferences,
  choices: readonly SetupModelChoice[],
): Promise<SetupScreenResult> {
  const draft = clonePreferences(input);
  return await ctx.ui.custom<SetupScreenResult>((tui, theme, _keybindings, done) => {
    const currentChoice = (profile: GuidedGitGenerationProfile | null) => choices.find((choice) => choice.key === profileKey(profile));
    const primaryLevels = currentChoice(draft.generation.primary)
      ? supportedGuidedGitThinkingLevels(currentChoice(draft.generation.primary)!.model)
      : ["off"];
    const fallbackLevels = currentChoice(draft.generation.fallback)
      ? supportedGuidedGitThinkingLevels(currentChoice(draft.generation.fallback)!.model)
      : ["off"];
    const items: (SettingItem & { description: string })[] = [
      {
        id: "primary", label: "Primary generation model", currentValue: currentChoice(draft.generation.primary)?.label ?? "Active Pi model",
        description: "The active Pi model remains unchanged.",
        submenu: (_value, close) => modelSubmenu(tui, theme, choices, true, close),
      },
      {
        id: "primaryEffort", label: "Primary reasoning effort", currentValue: draft.generation.primary?.thinkingLevel ?? "off", values: primaryLevels,
        description: "Reasoning effort for the configured primary model. Select a primary model first.",
      },
      {
        id: "fallback", label: "One-shot fallback model", currentValue: currentChoice(draft.generation.fallback)?.label ?? "None",
        description: "Only eligible provider failures retry once. Evidence is sent again.",
        submenu: (_value, close) => modelSubmenu(tui, theme, choices, true, close),
      },
      {
        id: "fallbackEffort", label: "Fallback reasoning effort", currentValue: draft.generation.fallback?.thinkingLevel ?? "off", values: fallbackLevels,
        description: "Reasoning effort for the optional fallback model. Select a fallback model first.",
      },
      {
        id: "language", label: "Commit language", currentValue: draft.commit.language, values: ["en", "de"],
        description: "Generate commit messages in English or German.",
      },
      {
        id: "scope", label: "Scope policy", currentValue: draft.commit.scope, values: ["auto", "never", "required"],
        description: "Ask the model to choose a commit scope automatically, omit it, or always include it.",
      },
      {
        id: "variant", label: "Default message variant", currentValue: draft.commit.defaultVariant, values: [...GUIDED_GIT_MESSAGE_VARIANTS],
        description: "Offer the short or long commit message first when choosing generated or saved text.",
      },
      {
        id: "staging", label: "Staging default", currentValue: draft.staging, values: [...GUIDED_GIT_STAGING_DEFAULTS],
        description: "Prefer the current index or offer stage-all first. Staging all changes still requires confirmation.",
      },
      {
        id: "entry", label: "Default entry stage", currentValue: draft.defaultEntry, values: [...GUIDED_GIT_ENTRY_STAGES],
        description: "Offer this stage first when starting the workflow. You can still choose another stage.",
      },
      {
        id: "verification", label: "Verification reminder", currentValue: draft.verification, values: [...GUIDED_GIT_VERIFICATION_POLICIES],
        description: "Show or skip a reminder to review your checks before committing. This does not run checks.",
      },
    ];
    const settings = new SettingsList(items, 1, getSettingsListTheme(), (id, value) => {
      if (id === "primary") {
        draft.generation.primary = profileFromKey(value, choices, draft.generation.primary?.thinkingLevel ?? "off");
        if (!draft.generation.primary) draft.generation.fallback = null;
        done({ kind: "refresh", draft });
        return;
      }
      if (id === "fallback") {
        draft.generation.fallback = profileFromKey(value, choices, draft.generation.fallback?.thinkingLevel ?? "off");
        done({ kind: "refresh", draft });
        return;
      }
      if (id === "primaryEffort" && draft.generation.primary) draft.generation.primary.thinkingLevel = value as GuidedGitThinkingLevel;
      if (id === "fallbackEffort" && draft.generation.fallback) draft.generation.fallback.thinkingLevel = value as GuidedGitThinkingLevel;
      if (id === "language") draft.commit.language = value as GuidedGitPreferences["commit"]["language"];
      if (id === "scope") draft.commit.scope = value as GuidedGitPreferences["commit"]["scope"];
      if (id === "variant") draft.commit.defaultVariant = value as GuidedGitPreferences["commit"]["defaultVariant"];
      if (id === "staging") draft.staging = value as GuidedGitPreferences["staging"];
      if (id === "entry") draft.defaultEntry = value as GuidedGitPreferences["defaultEntry"];
      if (id === "verification") draft.verification = value as GuidedGitPreferences["verification"];
    }, () => done({ kind: "cancel", draft: input }), { enableSearch: true });
    return {
      render(width: number) {
        const safeWidth = Math.max(1, width);
        const layout = setupChromeRows(tui);
        const contentWidth = safeWidth >= 5 ? safeWidth - 4 : safeWidth;
        const descriptionRows = Math.max(...items.map((item) => wrapTextWithAnsi(item.description, Math.max(1, contentWidth - 4)).length));
        // Reserve search, scroll, description spacing, and native help rows before fitting settings.
        (settings as unknown as { maxVisible: number }).maxVisible = Math.max(1, layout.content - 6 - descriptionRows);
        const settingsLines = settings.render(contentWidth).slice(0, layout.content);
        while (settingsLines.length < layout.content) settingsLines.push("");
        const lines: string[] = [];
        if (layout.header >= 1) lines.push(theme.fg("accent", theme.bold("Guided Git setup")));
        if (layout.header >= 2) lines.push(theme.fg("muted", "Changes remain unsaved until Ctrl+S."));
        lines.push(...settingsLines);
        if (layout.footer) lines.push(theme.fg("dim", "Ctrl+S save · Esc cancel · Enter change/search"));
        return renderOverlayPanel(lines, safeWidth, theme, layout.frame);
      },
      invalidate() { settings.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s"))) done({ kind: "save", draft });
        else settings.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: GUIDED_GIT_OVERLAY_OPTIONS });
}

/** Edit all native workflow preferences, returning only an explicitly saved draft. */
export async function showSetupOverlay(
  ctx: ExtensionCommandContext,
  preferences: GuidedGitPreferences,
  choices: readonly SetupModelChoice[],
): Promise<GuidedGitPreferences | null> {
  let draft = clonePreferences(preferences);
  while (true) {
    const result = await showSetupSettingsScreen(ctx, draft, choices);
    if (result.kind === "cancel") return null;
    if (result.kind === "save") return result.draft;
    draft = result.draft;
  }
}
