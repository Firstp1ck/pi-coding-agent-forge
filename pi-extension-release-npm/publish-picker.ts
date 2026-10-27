import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";

export type PublishPickerTarget = { target: string; label: string; action: string };

const PUBLISH_PICKER_OVERLAY_OPTIONS: Readonly<OverlayOptions> = Object.freeze({
  anchor: "center",
  width: "85%",
  minWidth: 40,
  maxHeight: "90%",
  margin: 1,
});

type Pane = "summary" | "packages";

/**
 * Publish target picker with two independently scrollable panes: the preflight
 * summary and the package checklist. Tab switches the focused pane.
 */
class PublishPickerOverlay<T extends PublishPickerTarget> {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly summary: string;
  private readonly targets: readonly T[];
  private readonly done: (result: T[] | undefined) => void;
  private readonly selected = new Set<number>();
  private focus: Pane = "packages";
  private summaryOffset = 0;
  private summaryPageSize = 1;
  private summaryLineCount = 0;
  private cursor = 0;
  private listOffset = 0;
  private listPageSize = 1;
  private message = "";

  constructor(tui: TUI, theme: Theme, summary: string, targets: readonly T[], done: (result: T[] | undefined) => void) {
    this.tui = tui;
    this.theme = theme;
    this.summary = summary;
    this.targets = targets;
    this.done = done;
  }

  handleInput(data: string): void {
    this.message = "";
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected.size === 0) {
        this.message = "Nothing selected. Space toggles a package, A selects all, Esc cancels.";
      } else {
        this.done(this.targets.filter((_target, index) => this.selected.has(index)));
        return;
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.focus = this.focus === "packages" ? "summary" : "packages";
    } else if (data === "a" || data === "A") {
      if (this.selected.size === this.targets.length) this.selected.clear();
      else this.targets.forEach((_target, index) => this.selected.add(index));
    } else if (this.focus === "packages") {
      this.handlePackageInput(data);
    } else {
      this.handleSummaryInput(data);
    }
    this.tui.requestRender();
  }

  private handlePackageInput(data: string): void {
    const last = this.targets.length - 1;
    if (matchesKey(data, Key.space)) {
      if (this.selected.has(this.cursor)) this.selected.delete(this.cursor);
      else this.selected.add(this.cursor);
    } else if (matchesKey(data, Key.up) || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.cursor = Math.min(last, this.cursor + 1);
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.listPageSize);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(last, this.cursor + this.listPageSize);
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = last;
  }

  private handleSummaryInput(data: string): void {
    const maxOffset = Math.max(0, this.summaryLineCount - this.summaryPageSize);
    if (matchesKey(data, Key.up) || data === "k") this.summaryOffset -= 1;
    else if (matchesKey(data, Key.down) || data === "j") this.summaryOffset += 1;
    else if (matchesKey(data, Key.pageUp)) this.summaryOffset -= this.summaryPageSize;
    else if (matchesKey(data, Key.pageDown)) this.summaryOffset += this.summaryPageSize;
    else if (matchesKey(data, Key.home)) this.summaryOffset = 0;
    else if (matchesKey(data, Key.end)) this.summaryOffset = maxOffset;
    this.summaryOffset = Math.min(maxOffset, Math.max(0, this.summaryOffset));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const contentWidth = Math.max(1, safeWidth - 4);
    const theme = this.theme;
    const terminalRows = Math.max(1, Math.floor(this.tui.terminal?.rows ?? 24));
    // Frame (2) + title (1) + two pane headers (2) + help/message (1).
    const paneRows = Math.max(2, Math.floor(terminalRows * 0.9) - 6);

    const summaryLines = this.summary.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, contentWidth));
    this.summaryLineCount = summaryLines.length;
    const listRows = Math.max(1, Math.min(this.targets.length, Math.ceil(paneRows / 2), paneRows - 1));
    const summaryRows = Math.max(1, Math.min(summaryLines.length, paneRows - listRows));
    // Give rows the summary does not need back to the package list.
    this.listPageSize = Math.max(1, Math.min(this.targets.length, paneRows - summaryRows));
    this.summaryPageSize = summaryRows;
    this.summaryOffset = Math.min(this.summaryOffset, Math.max(0, summaryLines.length - summaryRows));
    if (this.cursor < this.listOffset) this.listOffset = this.cursor;
    if (this.cursor >= this.listOffset + this.listPageSize) this.listOffset = this.cursor - this.listPageSize + 1;
    this.listOffset = Math.min(this.listOffset, Math.max(0, this.targets.length - this.listPageSize));

    const header = (pane: Pane, label: string, from: number, to: number, total: number) => {
      const focused = this.focus === pane;
      const range = total > to - from ? ` ${from + 1}-${to}/${total}` : ` (${total})`;
      const text = `${focused ? "▸" : " "} ${label}${range}`;
      return focused ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
    };

    const visibleSummary = summaryLines.slice(this.summaryOffset, this.summaryOffset + summaryRows);
    const visibleTargets = this.targets.slice(this.listOffset, this.listOffset + this.listPageSize);
    const lines = [
      theme.fg("text", theme.bold(`Publish npm packages · ${this.selected.size}/${this.targets.length} selected`)),
      header("summary", "Preflight summary", this.summaryOffset, this.summaryOffset + visibleSummary.length, summaryLines.length),
      ...visibleSummary.map((line) => theme.fg("muted", line)),
      header("packages", "Packages", this.listOffset, this.listOffset + visibleTargets.length, this.targets.length),
      ...visibleTargets.map((target, offset) => {
        const index = this.listOffset + offset;
        const isCursor = index === this.cursor && this.focus === "packages";
        const text = `${isCursor ? "→" : " "} ${this.selected.has(index) ? "[x]" : "[ ]"} ${target.label} (${target.action})`;
        return isCursor ? theme.fg("accent", text) : theme.fg("text", text);
      }),
      this.message
        ? theme.fg("warning", this.message)
        : theme.fg("dim", "Tab pane · ↑↓ PgUp/PgDn scroll · Space toggle · A all/none · Enter publish · Esc cancel"),
    ];
    return renderPanel(lines, safeWidth, theme);
  }

  invalidate(): void {}
}

function renderPanel(lines: string[], width: number, theme: Theme): string[] {
  if (width < 5) return lines.map((line) => truncateToWidth(line, width, "", true));
  const border = (text: string) => theme.fg("borderAccent", text);
  return [
    border(`╭${"─".repeat(width - 2)}╮`),
    ...lines.map((line) => `${border("│")} ${truncateToWidth(line, width - 4, "…", true)} ${border("│")}`),
    border(`╰${"─".repeat(width - 2)}╯`),
  ];
}

/**
 * Package checklist shown before preflight checks start. Every package starts
 * selected; Ctrl+A selects all and Ctrl+X clears the selection.
 */
class CheckPickerOverlay {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly packages: readonly string[];
  private readonly changed: ReadonlySet<string>;
  private readonly done: (result: string[] | undefined) => void;
  private readonly selected: Set<number>;
  private cursor = 0;
  private listOffset = 0;
  private listPageSize = 1;
  private message = "";

  constructor(tui: TUI, theme: Theme, packages: readonly string[], changed: ReadonlySet<string>, done: (result: string[] | undefined) => void) {
    this.tui = tui;
    this.theme = theme;
    this.packages = packages;
    this.changed = changed;
    this.done = done;
    this.selected = new Set(packages.map((_name, index) => index));
  }

  handleInput(data: string): void {
    this.message = "";
    const last = this.packages.length - 1;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected.size === 0) {
        this.message = "Nothing selected. Space toggles a package, Ctrl+A selects all, Esc cancels.";
      } else {
        this.done(this.packages.filter((_name, index) => this.selected.has(index)));
        return;
      }
    } else if (matchesKey(data, Key.ctrl("a"))) this.packages.forEach((_name, index) => this.selected.add(index));
    else if (matchesKey(data, Key.ctrl("x"))) this.selected.clear();
    else if (matchesKey(data, Key.space)) {
      if (this.selected.has(this.cursor)) this.selected.delete(this.cursor);
      else this.selected.add(this.cursor);
    } else if (matchesKey(data, Key.up) || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.cursor = Math.min(last, this.cursor + 1);
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.listPageSize);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(last, this.cursor + this.listPageSize);
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = last;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const theme = this.theme;
    const terminalRows = Math.max(1, Math.floor(this.tui.terminal?.rows ?? 24));
    // Frame (2) + title (1) + list header (1) + help/message (1).
    this.listPageSize = Math.max(1, Math.min(this.packages.length, Math.floor(terminalRows * 0.9) - 5));
    if (this.cursor < this.listOffset) this.listOffset = this.cursor;
    if (this.cursor >= this.listOffset + this.listPageSize) this.listOffset = this.cursor - this.listPageSize + 1;
    this.listOffset = Math.min(this.listOffset, Math.max(0, this.packages.length - this.listPageSize));

    const visible = this.packages.slice(this.listOffset, this.listOffset + this.listPageSize);
    const range = this.packages.length > visible.length
      ? ` ${this.listOffset + 1}-${this.listOffset + visible.length}/${this.packages.length}`
      : ` (${this.packages.length})`;
    const changedText = this.changed.size ? ` · ${this.changed.size} with uncommitted changes` : "";
    const lines = [
      theme.fg("text", theme.bold(`Check npm packages · ${this.selected.size}/${this.packages.length} selected`)) + theme.fg("warning", changedText),
      theme.fg("accent", theme.bold(`▸ Packages${range}`)),
      ...visible.map((name, offset) => {
        const index = this.listOffset + offset;
        const isCursor = index === this.cursor;
        const text = `${isCursor ? "→" : " "} ${this.selected.has(index) ? "[x]" : "[ ]"} ${name}`;
        // Packages with staged, unstaged, or untracked changes are marked so they stand out.
        const marker = this.changed.has(name) ? theme.fg("warning", " ● uncommitted changes") : "";
        if (isCursor) return theme.fg("accent", text) + marker;
        return (this.changed.has(name) ? theme.fg("warning", text) : theme.fg("text", text)) + marker;
      }),
      this.message
        ? theme.fg("warning", this.message)
        : theme.fg("dim", "↑↓ PgUp/PgDn move · Space toggle · Ctrl+A all · Ctrl+X none · Enter start checks · Esc cancel"),
    ];
    return renderPanel(lines, safeWidth, theme);
  }

  invalidate(): void {}
}

/** Let the user pick which packages to check in an overlay. Resolves undefined on cancel. */
export async function showCheckPicker(
  ctx: ExtensionCommandContext,
  packages: readonly string[],
  changed: ReadonlySet<string> = new Set(),
): Promise<string[] | undefined> {
  return await ctx.ui.custom<string[] | undefined>(
    (tui, theme, _keybindings, done) => new CheckPickerOverlay(tui, theme, packages, changed, done),
    { overlay: true, overlayOptions: PUBLISH_PICKER_OVERLAY_OPTIONS },
  );
}

/** Let the user pick publish targets in a scrollable overlay. Resolves undefined on cancel. */
export async function showPublishPicker<T extends PublishPickerTarget>(
  ctx: ExtensionCommandContext,
  summary: string,
  targets: readonly T[],
): Promise<T[] | undefined> {
  return await ctx.ui.custom<T[] | undefined>(
    (tui, theme, _keybindings, done) => new PublishPickerOverlay(tui, theme, summary, targets, done),
    { overlay: true, overlayOptions: PUBLISH_PICKER_OVERLAY_OPTIONS },
  );
}
