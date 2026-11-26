/**
 * Host UI for Pi (earendil pi-tui components) and omp 19.2 (rows objects).
 * omp is chosen by capability (`ctx.ui.composer`, or a factory host with
 * `size()`/`requestRender()` and no Pi `terminal`) and never imports pi-tui.
 * The Pi package is a platform-specific peer loaded only on that path, with a
 * computed specifier: omp 19.2 rejects a static pi-tui import at load time.
 */
import * as codingAgent from "@earendil-works/pi-coding-agent";

export interface ThemeLike {
  fg(tone: string, text: string): string;
  bold(text: string): string;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectTheme {
  selectedPrefix?: (text: string) => string;
  selectedText?: (text: string) => string;
  description?: (text: string) => string;
  scrollInfo?: (text: string) => string;
  noMatch?: (text: string) => string;
}

export interface SelectListLike {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  getSelectedItem(): SelectItem | null;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}

export interface SettingRow {
  id: string;
  label: string;
  currentValue: string;
  values?: string[];
}

export interface OverlayComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose?(): void;
}

export interface SettingsOverlayOptions {
  theme: ThemeLike;
  items: SettingRow[];
  title: string;
  footer: string;
  onChange: (id: string, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

export interface KeyAdapter {
  matches(data: string, action: string): boolean;
  labels(action: string): string[];
}

export interface UiHost {
  kind: "pi" | "omp";
  wrap(text: string, width: number): string[];
  visibleWidth(text: string): number;
  isSaveKey(data: string): boolean;
  createSelectList(items: SelectItem[], maxVisible: number, theme: SelectTheme): SelectListLike;
  createSettingsOverlay(options: SettingsOverlayOptions): OverlayComponent;
}

interface SettingsTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

interface PiContainer {
  addChild(child: unknown): void;
  render(width: number): string[];
  invalidate(): void;
}

interface PiComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
}

interface PiSelectList extends PiComponent {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  getSelectedItem(): SelectItem | null;
}

interface PiTuiModule {
  Container: new () => PiContainer;
  Text: new (text: string, paddingX?: number, paddingY?: number) => { render(width: number): string[] };
  SelectList: new (items: SelectItem[], maxVisible: number, theme: SelectTheme) => PiSelectList;
  SettingsList: new (
    items: SettingRow[],
    maxVisible: number,
    theme: SettingsTheme,
    onChange: (id: string, value: string) => void,
    onCancel: () => void,
    options?: { enableSearch?: boolean },
  ) => PiComponent;
  Key: { ctrl(key: string): string };
  matchesKey(data: string, key: string): boolean;
  visibleWidth(text: string): number;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const DEFAULT_KEYS: Record<string, string[]> = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.pageUp": ["pageUp"],
  "tui.select.pageDown": ["pageDown"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
};
const RAW_KEYS: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\x1b": "escape",
  "\x03": "ctrl+c",
  "\x13": "ctrl+s",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  "\x1b[H": "home",
  "\x1b[F": "end",
  " ": "space",
};

export interface HostProbe {
  ui?: object | null;
  factoryUi?: object | null;
}

/** omp 19.2 exposes `composer` on the UI context, and its custom factory receives `size()`. */
export function isOmpUiHost(probe: HostProbe = {}): boolean {
  if (probe.ui && typeof probe.ui === "object" && "composer" in probe.ui) return true;
  const factoryUi = probe.factoryUi;
  if (!factoryUi || typeof factoryUi !== "object") return false;
  const host = factoryUi as { size?: unknown; requestRender?: unknown };
  return typeof host.size === "function" && typeof host.requestRender === "function" && !("terminal" in factoryUi);
}

let cached: Promise<UiHost> | undefined;
let override: UiHost | undefined;

export function setUiHostForTests(host: UiHost | undefined): void {
  override = host;
}

export function resetUiHostForTests(): void {
  override = undefined;
  cached = undefined;
}

export function loadUiHost(
  probe: HostProbe = {},
  options?: { importPiTui?: () => Promise<PiTuiModule | null> },
): Promise<UiHost> {
  if (override) return Promise.resolve(override);
  if (isOmpUiHost(probe)) return Promise.resolve(createOmpHost());
  cached ??= detectPiHost(options?.importPiTui);
  return cached;
}

export function createRowsUiHost(): UiHost {
  return createOmpHost();
}

export function terminalRows(ui: { terminal?: { rows?: number }; size?: () => { rows?: number } }): number {
  const rows = ui.terminal?.rows ?? ui.size?.().rows;
  return typeof rows === "number" && rows > 0 ? rows : 24;
}

export function decodeRawKey(data: string): string | undefined {
  const named = RAW_KEYS[data];
  if (named) return named;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(96 + code)}`;
    if (data >= " " && data <= "~") return data;
  }
  return undefined;
}

export function adaptKeys(keys: unknown): KeyAdapter {
  const record = keys as {
    matches?: (data: string, action: string) => boolean;
    getKeys?: (action: string) => string[];
    keysFor?: (action: string) => string[];
    matchesId?: (id: string, action: string) => boolean;
  } | null;
  if (record && typeof record.getKeys === "function" && typeof record.matches === "function") {
    return {
      matches: (data, action) => record.matches!(data, action),
      labels: (action) => record.getKeys!(action),
    };
  }
  if (record && typeof record.keysFor === "function" && typeof record.matchesId === "function") {
    return {
      matches: (data, action) => {
        const id = decodeRawKey(data);
        return id ? record.matchesId!(id, action) : false;
      },
      labels: (action) => record.keysFor!(action),
    };
  }
  return {
    matches: (data, action) => {
      const id = decodeRawKey(data);
      return id ? (DEFAULT_KEYS[action] ?? []).includes(id) : false;
    },
    labels: (action) => [...(DEFAULT_KEYS[action] ?? [])],
  };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function wrapAnsi(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (visibleWidth(rawLine) <= limit) {
      lines.push(rawLine);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    let open = "";
    for (const token of rawLine.split(/(\x1b\[[0-9;]*m)/)) {
      if (token.startsWith("\x1b[")) {
        current += token;
        open = token === "\x1b[0m" || token === "\x1b[m" ? "" : open + token;
        continue;
      }
      for (const char of token) {
        const charWidth = visibleWidth(char) || 1;
        if (currentWidth + charWidth > limit && currentWidth > 0) {
          lines.push(`${current}\x1b[0m`);
          current = open;
          currentWidth = 0;
        }
        current += char;
        currentWidth += charWidth;
      }
    }
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

async function detectPiHost(importPiTuiFn: (() => Promise<PiTuiModule | null>) | undefined = importPiTui): Promise<UiHost> {
  const mod = await importPiTuiFn();
  if (!mod) return createOmpHost();
  return createPiHost(mod, await loadSettingsTheme());
}

async function importPiTui(): Promise<PiTuiModule | null> {
  try {
    // Computed specifier: a static `@earendil-works/pi-tui` import is rejected by omp 19.2 at load.
    const specifier = ["@earendil-works", "pi-tui"].join("/");
    const imported = (await import(specifier)) as Partial<PiTuiModule>;
    if (
      typeof imported.SelectList !== "function" ||
      typeof imported.SettingsList !== "function" ||
      typeof imported.Text !== "function" ||
      typeof imported.Container !== "function" ||
      typeof imported.visibleWidth !== "function" ||
      typeof imported.matchesKey !== "function"
    ) {
      return null;
    }
    return imported as PiTuiModule;
  } catch {
    return null;
  }
}

async function loadSettingsTheme(): Promise<(() => SettingsTheme) | null> {
  const imported = codingAgent as { getSettingsListTheme?: () => SettingsTheme };
  return typeof imported.getSettingsListTheme === "function" ? imported.getSettingsListTheme : null;
}

function createPiHost(mod: PiTuiModule, settingsTheme: (() => SettingsTheme) | null): UiHost {
  return {
    kind: "pi",
    wrap: (text, width) => new mod.Text(text, 0, 0).render(width),
    visibleWidth: (text) => mod.visibleWidth(text),
    isSaveKey: (data) => mod.matchesKey(data, mod.Key.ctrl("s")),
    createSelectList: (items, maxVisible, theme) => {
      const list = new mod.SelectList(items, maxVisible, theme);
      return {
        render: (width) => list.render(width),
        invalidate: () => list.invalidate(),
        handleInput: (data) => list.handleInput?.(data),
        getSelectedItem: () => list.getSelectedItem(),
        set onSelect(handler) { list.onSelect = handler; },
        get onSelect() { return list.onSelect; },
        set onCancel(handler) { list.onCancel = handler; },
        get onCancel() { return list.onCancel; },
      };
    },
    createSettingsOverlay: (options) => createPiSettings(mod, settingsTheme, options),
  };
}

function createOmpHost(): UiHost {
  return {
    kind: "omp",
    wrap: wrapAnsi,
    visibleWidth,
    isSaveKey: (data) => data === "\x13" || decodeRawKey(data) === "ctrl+s",
    createSelectList: (items, _maxVisible, theme) => createRowsSelectList(items, theme),
    createSettingsOverlay: (options) => createRowsSettings(options),
  };
}

function createPiSettings(
  mod: PiTuiModule,
  settingsTheme: (() => SettingsTheme) | null,
  options: SettingsOverlayOptions,
): OverlayComponent {
  const container = new mod.Container();
  container.addChild(new mod.Text(options.title, 1, 0));
  const list = new mod.SettingsList(
    options.items,
    Math.min(options.items.length + 2, 18),
    settingsTheme?.() ?? fallbackSettingsTheme(options.theme),
    options.onChange,
    options.onCancel,
    { enableSearch: true },
  );
  container.addChild(list);
  container.addChild(new mod.Text(options.footer, 1, 0));
  return {
    render: (width) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput(data: string) {
      if (mod.matchesKey(data, mod.Key.ctrl("s"))) options.onSave();
      else if (data === "j") list.handleInput?.("\u001b[B");
      else if (data === "k") list.handleInput?.("\u001b[A");
      else list.handleInput?.(data);
    },
  };
}

function createRowsSelectList(items: SelectItem[], theme: SelectTheme): SelectListLike {
  let index = 0;
  const list: SelectListLike = {
    render(width: number) {
      return items.map((item, itemIndex) => {
        const prefix = itemIndex === index ? "→ " : "  ";
        const line = truncatePlain(`${prefix}${item.label}`, width);
        return itemIndex === index ? (theme.selectedText ?? ((text) => text))(line) : line;
      });
    },
    invalidate() { },
    getSelectedItem: () => items[index] ?? null,
    handleInput(data: string) {
      const id = decodeRawKey(data);
      if (id === "down") index = Math.min(items.length - 1, index + 1);
      else if (id === "up") index = Math.max(0, index - 1);
      else if (id === "enter") list.onSelect?.(items[index]!);
      else if (id === "escape" || id === "ctrl+c") list.onCancel?.();
    },
  };
  return list;
}

function createRowsSettings(options: SettingsOverlayOptions): OverlayComponent {
  let index = 0;
  const maxVisible = Math.min(options.items.length + 2, 18);
  return {
    render(width: number) {
      const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), options.items.length - maxVisible));
      const end = Math.min(options.items.length, start + maxVisible);
      const rows = options.items.slice(start, end).map((item, offset) => {
        const selected = start + offset === index;
        const line = truncatePlain(`${selected ? "→ " : "  "}${item.label}  ${item.currentValue}`, width);
        return selected ? options.theme.fg("accent", options.theme.bold(line)) : line;
      });
      return [...wrapAnsi(options.title, width), "", ...rows, "", ...wrapAnsi(options.footer, width)];
    },
    invalidate() { },
    handleInput(data: string) {
      if (data === "\x13" || decodeRawKey(data) === "ctrl+s") {
        options.onSave();
        return;
      }
      if (data === "j" || data === "\u001b[B") index = Math.min(options.items.length - 1, index + 1);
      else if (data === "k" || data === "\u001b[A") index = Math.max(0, index - 1);
      else if (data === "\r" || data === " " || data === "\n") cycleSetting(options, index);
      else if (data === "\x1b" || data === "\x03") options.onCancel();
    },
  };
}

function cycleSetting(options: SettingsOverlayOptions, index: number): void {
  const item = options.items[index];
  if (!item?.values?.length) return;
  const next = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length] ?? item.values[0]!;
  item.currentValue = next;
  options.onChange(item.id, next);
}

function fallbackSettingsTheme(theme: ThemeLike): SettingsTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

function truncatePlain(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char) || 1;
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out;
}
