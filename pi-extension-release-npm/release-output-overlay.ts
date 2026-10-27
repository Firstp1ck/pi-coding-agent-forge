import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

export type ReleaseOutputSnapshot = {
  title: string;
  lines: string[];
  // While following, keep this line in view (about a third from the top) instead of
  // showing the newest lines at the bottom.
  focusLine?: number;
  // Lines pinned below the scrolling area, such as a progress summary.
  footer?: string[];
};

// The window keeps the same size however much output there is.
const WINDOW_WIDTH = "80%";
const WINDOW_HEIGHT_RATIO = 0.7;
// Frame (2) + header (1) + help (1).
const CHROME_ROWS = 4;

/**
 * Live release output in a fixed-size, centered, scrollable window. Pi caps
 * above-editor widgets at ten lines, so long preflight output cannot be read there.
 * The window takes keyboard focus while visible so scroll keys reach it, not Pi.
 */
class ReleaseOutputOverlay {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly getSnapshot: () => ReleaseOutputSnapshot;
  private readonly onHide: () => void;
  private readonly onAbort: () => void;
  private follow = true;
  private offset = 0;
  private bodyRows = 1;

  constructor(tui: TUI, theme: Theme, getSnapshot: () => ReleaseOutputSnapshot, onHide: () => void, onAbort: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.getSnapshot = getSnapshot;
    this.onHide = onHide;
    this.onAbort = onAbort;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("o")) || data === "q") {
      this.onHide();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onAbort();
      return;
    }
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.bodyRows);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.bodyRows);
    else if (matchesKey(data, Key.home)) {
      this.follow = false;
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) this.follow = true;
    this.tui.requestRender();
  }

  private scrollBy(delta: number): void {
    const snapshot = this.getSnapshot();
    const maxOffset = Math.max(0, snapshot.lines.length - this.bodyRows);
    const start = this.follow ? this.followOffset(snapshot) : this.offset;
    this.offset = Math.min(maxOffset, Math.max(0, start + delta));
    // Without a focus line, scrolling back to the bottom resumes following new
    // output. With one, End resumes following.
    this.follow = snapshot.focusLine === undefined && this.offset >= maxOffset;
  }

  private followOffset(snapshot: ReleaseOutputSnapshot): number {
    const maxOffset = Math.max(0, snapshot.lines.length - this.bodyRows);
    if (snapshot.focusLine === undefined) return maxOffset;
    return Math.min(maxOffset, Math.max(0, snapshot.focusLine - Math.floor(this.bodyRows / 3)));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const theme = this.theme;
    const snapshot = this.getSnapshot();
    const { title, lines } = snapshot;
    const footer = snapshot.footer ?? [];
    const terminalRows = Math.max(1, Math.floor(this.tui.terminal?.rows ?? 24));
    this.bodyRows = Math.max(1, Math.floor(terminalRows * WINDOW_HEIGHT_RATIO) - CHROME_ROWS - footer.length);

    const maxOffset = Math.max(0, lines.length - this.bodyRows);
    if (this.follow) this.offset = this.followOffset(snapshot);
    this.offset = Math.min(this.offset, maxOffset);
    const body = lines.slice(this.offset, this.offset + this.bodyRows).map((line) => line.replace(/\t/g, "  "));
    if (lines.length === 0) body.push(theme.fg("dim", "Waiting for release output..."));
    while (body.length < this.bodyRows) body.push("");

    const shown = Math.min(this.bodyRows, lines.length);
    const range = lines.length ? `lines ${this.offset + 1}-${this.offset + shown}/${lines.length}` : "no output yet";
    const header = `${title} · ${range} · ${this.follow ? "following" : "paused"}`;
    const help = "↑↓ PgUp/PgDn Home/End scroll · End follows · Esc/Ctrl+O hide · Ctrl+C abort";

    if (safeWidth < 5) return [header, ...body].map((line) => truncateToWidth(line, safeWidth, "", true));
    const border = (text: string) => theme.fg("borderAccent", text);
    const row = (line: string) => `${border("│")} ${truncateToWidth(line, safeWidth - 4, "…", true)} ${border("│")}`;
    return [
      border(`╭${"─".repeat(safeWidth - 2)}╮`),
      row(theme.fg("accent", theme.bold(header))),
      ...body.map(row),
      ...footer.map(row),
      row(theme.fg("dim", help)),
      border(`╰${"─".repeat(safeWidth - 2)}╯`),
    ];
  }

  invalidate(): void {}
}

export type ReleaseOutputWindow = {
  refresh(): void;
  /** Hide the window and return the keyboard to Pi, or show and focus it again. */
  toggle(): void;
  close(): void;
};

/** Open the live output window. Only call this in TUI mode. */
export function openReleaseOutputWindow(
  ctx: ExtensionCommandContext,
  getSnapshot: () => ReleaseOutputSnapshot,
  options: { onAbort: () => void; onHidden: () => void; onError: (message: string) => void },
): ReleaseOutputWindow {
  let handle: OverlayHandle | undefined;
  let tui: TUI | undefined;
  let finish: (() => void) | undefined;
  let closed = false;

  const setHidden = (hidden: boolean) => {
    if (!handle || closed || handle.isHidden() === hidden) return;
    // A capturing overlay gives up focus when hidden and takes it back when shown.
    handle.setHidden(hidden);
    if (!hidden) handle.focus();
    tui?.requestRender();
    if (hidden) options.onHidden();
  };

  const pending = ctx.ui.custom<void>((overlayTui, theme, _keybindings, done) => {
    tui = overlayTui;
    finish = done;
    if (closed) queueMicrotask(done);
    return new ReleaseOutputOverlay(overlayTui, theme, getSnapshot, () => setHidden(true), options.onAbort);
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: WINDOW_WIDTH, minWidth: 40, maxHeight: "90%" },
    onHandle(overlayHandle) {
      handle = overlayHandle;
    },
  });
  void pending.catch((error: unknown) => {
    options.onError(error instanceof Error ? error.message : String(error));
  });

  return {
    refresh: () => {
      if (handle && !handle.isHidden()) tui?.requestRender();
    },
    toggle: () => {
      if (handle) setHidden(!handle.isHidden());
    },
    close: () => {
      if (closed) return;
      closed = true;
      finish?.();
    },
  };
}
