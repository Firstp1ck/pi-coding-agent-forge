import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  collectInitialPromptCalibration,
  createInitialPromptEstimateService,
  envFlag,
  estimateStableInitialPromptFromPiContext,
  estimateTokensFromCharCount,
  formatTokens,
  formatUserPath,
  pathExists,
  normalizeTimestampMs,
  type InitialPromptEstimateSnapshot,
  type InitialPromptInputEstimate,
} from "@firstpick/pi-utils";
import { Container, Key, matchesKey, type SettingItem, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatProviderUsage,
  parseAnthropicProviderUsage,
  parseCodexProviderUsage,
  providerUsageWindows,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow,
} from "./provider-usage.ts";

type GitChangeKind = "staged" | "modified" | "untracked" | "conflicted";

type GitChangedFile = {
  kind: GitChangeKind;
  path: string;
  oldPath?: string;
  status: string;
};

type GitSnapshot = {
  branch: string;
  isDetached: boolean;
  upstream?: string;
  upstreamGone: boolean;
  hasRemotes: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changedFiles: GitChangedFile[];
  changedFilesTotal: number;
  changedFilesTruncated: boolean;
  operation?: string;
  stashCount: number;
  submoduleDirty: number;
  lastCommitAge?: string;
  worktreeCount: number;
  headTag?: string;
  signingMismatch: boolean;
};

/** Fields parsed purely from `git status --porcelain=2 --branch` output. */
export type GitPorcelainStatus = {
  branch: string;
  isDetached: boolean;
  upstream?: string;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changedFiles: GitChangedFile[];
};

type SigningDiagnostics = {
  commitSignRequired: boolean;
  signState: string;
  gpgFormat: string;
  signingKey: string;
};

const LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS = 2000;
const SESSION_SPEED_SAMPLE_MIN_INTERVAL_MS = 250;
const SESSION_SPEED_SAMPLE_LIMIT = 20_000;
const DEFAULT_GIT_AUTO_REFRESH_INTERVAL_MS = 10_000;
const GIT_INITIAL_FETCH_TIMEOUT_MS = 30_000;
const GIT_FETCH_MESSAGE_MAX_LENGTH = 240;
const GIT_CHANGED_FILES_LIMIT = 80;
const PROMPT_ESTIMATE_REFRESH_DELAY_MS = 1000;
const FOOTER_USAGE_RECOMPUTE_DELAY_MS = 1000;
const WEBUI_FOOTER_STATUS_KEY = "git-footer-webui";
const GIT_FOOTER_STATUS_KEY = "git-footer";
const CD_HISTORY_STATUS_KEY = "cd-history";
const WEBUI_FOOTER_PAYLOAD_TYPE = "firstpick.git-footer-status.footer";
const WEBUI_FOOTER_PAYLOAD_VERSION = 1;
const FOOTER_VISIBILITY_SETTINGS_VERSION = 1;
const FOOTER_VISIBILITY_SETTINGS_FILE_ENV = "PI_GIT_FOOTER_SETTINGS_FILE";

type FooterVisibilityTarget = "native" | "webui";
type FooterVisibilityScope = FooterVisibilityTarget | "all";

const FOOTER_VISIBILITY_KEYS = [
  "tokens",
  "cache",
  "pi",
  "speed",
  "speed-avg",
  "speed-low",
  "speed-max",
  "cost",
  "context",
  "usage",
  "model",
  "thinking",
  "cwd",
  "cwd-branch",
  "git-status",
  "extension-statuses",
  "git",
  "git-state",
  "sync",
  "changes",
  "git-extra",
  "worktree",
  "context-meta",
  "git-branch-indicator",
  "git-detached",
  "git-operation",
  "git-ahead",
  "git-behind",
  "git-upstream",
  "git-staged",
  "git-unstaged",
  "git-untracked",
  "git-conflicted",
  "git-clean",
  "git-stash",
  "git-submodules",
  "git-worktrees",
  "git-tag",
  "git-last-commit-age",
  "git-signing-mismatch",
  "webui-fetch-state",
  "webui-refresh-button",
  "webui-details-button",
  "webui-cwd-picker",
  "webui-pi-calibration",
  "webui-context-auto-compaction",
  "webui-branch-picker",
  "webui-git-init",
  "webui-sync-push",
  "webui-changes-modal",
  "webui-git-tools-modal",
  "webui-model-picker",
  "webui-thinking-picker",
  "webui-changed-files-popover",
] as const;

type FooterVisibilityKey = (typeof FOOTER_VISIBILITY_KEYS)[number];

const FOOTER_VISIBILITY_DEFAULTS: Record<FooterVisibilityKey, boolean> = {
  tokens: true,
  cache: true,
  pi: true,
  speed: true,
  "speed-avg": false,
  "speed-low": false,
  "speed-max": false,
  cost: true,
  context: true,
  usage: true,
  model: true,
  thinking: true,
  cwd: true,
  "cwd-branch": true,
  "git-status": true,
  "extension-statuses": true,
  git: true,
  "git-state": true,
  sync: true,
  changes: true,
  "git-extra": true,
  worktree: true,
  "context-meta": true,
  "git-branch-indicator": false,
  "git-detached": true,
  "git-operation": true,
  "git-ahead": true,
  "git-behind": true,
  "git-upstream": true,
  "git-staged": true,
  "git-unstaged": true,
  "git-untracked": true,
  "git-conflicted": true,
  "git-clean": true,
  "git-stash": true,
  "git-submodules": true,
  "git-worktrees": true,
  "git-tag": true,
  "git-last-commit-age": true,
  "git-signing-mismatch": true,
  "webui-fetch-state": true,
  "webui-refresh-button": true,
  "webui-details-button": true,
  "webui-cwd-picker": true,
  "webui-pi-calibration": true,
  "webui-context-auto-compaction": true,
  "webui-branch-picker": true,
  "webui-git-init": true,
  "webui-sync-push": true,
  "webui-changes-modal": true,
  "webui-git-tools-modal": true,
  "webui-model-picker": true,
  "webui-thinking-picker": true,
  "webui-changed-files-popover": true,
};

const FOOTER_VISIBILITY_ALIASES: Record<string, FooterVisibilityKey> = {
  "avg-speed": "speed-avg",
  "speed-average": "speed-avg",
  "speed-1-low": "speed-low",
  "speed-1%-low": "speed-low",
  "speed-onepercent-low": "speed-low",
  "max-speed": "speed-max",
  "speed-spike": "speed-max",
  branch: "git",
  "branch-card": "git",
  "branch-indicator": "git-branch-indicator",
  "git-branch": "git",
  "git-branch-card": "git",
  detached: "git-detached",
  operation: "git-operation",
  ahead: "git-ahead",
  behind: "git-behind",
  upstream: "git-upstream",
  staged: "git-staged",
  unstaged: "git-unstaged",
  modified: "git-unstaged",
  untracked: "git-untracked",
  conflicted: "git-conflicted",
  clean: "git-clean",
  stash: "git-stash",
  submodule: "git-submodules",
  submodules: "git-submodules",
  worktrees: "git-worktrees",
  tag: "git-tag",
  age: "git-last-commit-age",
  "last-commit": "git-last-commit-age",
  signing: "git-signing-mismatch",
  "signing-mismatch": "git-signing-mismatch",
  fetch: "webui-fetch-state",
  refresh: "webui-refresh-button",
  "refresh-button": "webui-refresh-button",
  details: "webui-details-button",
  "details-button": "webui-details-button",
  "cwd-picker": "webui-cwd-picker",
  calibration: "webui-pi-calibration",
  "pi-calibration": "webui-pi-calibration",
  "auto-compaction": "webui-context-auto-compaction",
  "context-toggle": "webui-context-auto-compaction",
  "branch-picker": "webui-branch-picker",
  "git-init": "webui-git-init",
  push: "webui-sync-push",
  "sync-push": "webui-sync-push",
  modal: "webui-changes-modal",
  "changes-modal": "webui-changes-modal",
  "git-modal": "webui-changes-modal",
  "git-tools": "webui-git-tools-modal",
  "git-tools-modal": "webui-git-tools-modal",
  "model-picker": "webui-model-picker",
  "thinking-picker": "webui-thinking-picker",
  "changed-files": "webui-changed-files-popover",
  "changed-files-popover": "webui-changed-files-popover",
};

const FOOTER_VISIBILITY_KEY_SET = new Set<string>(FOOTER_VISIBILITY_KEYS);
const FOOTER_VISIBILITY_SCOPES: FooterVisibilityScope[] = ["all", "native", "webui"];
const runtimeFooterVisibilityOverrides = new Map<string, boolean>();
const warnedInvalidFooterVisibilityFiles = new Set<string>();

type PersistedFooterVisibilitySettings = {
  version: typeof FOOTER_VISIBILITY_SETTINGS_VERSION;
  overrides: Record<FooterVisibilityScope, Partial<Record<FooterVisibilityKey, boolean>>>;
};

function emptyFooterVisibilitySettings(): PersistedFooterVisibilitySettings {
  return {
    version: FOOTER_VISIBILITY_SETTINGS_VERSION,
    overrides: { all: {}, native: {}, webui: {} },
  };
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

export function footerVisibilitySettingsFile(env: Record<string, string | undefined> = process.env): string {
  const configuredFile = env[FOOTER_VISIBILITY_SETTINGS_FILE_ENV]?.trim();
  if (configuredFile) return resolve(expandHomePath(configuredFile));
  const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir ? resolve(expandHomePath(configuredAgentDir)) : resolve(homedir(), ".pi", "agent");
  return resolve(agentDir, "git-footer-visibility.json");
}

function normalizeFooterVisibilityToken(value: string): string {
  return value.trim().toLowerCase().replace(/^--?/, "").replace(/[_\s]+/g, "-");
}

function normalizeFooterVisibilityKey(value: string): FooterVisibilityKey | null {
  const token = normalizeFooterVisibilityToken(value);
  if (FOOTER_VISIBILITY_KEY_SET.has(token)) return token as FooterVisibilityKey;
  return FOOTER_VISIBILITY_ALIASES[token] ?? null;
}

function parseFooterVisibilityList(raw: string | undefined): Set<FooterVisibilityKey> {
  const keys = new Set<FooterVisibilityKey>();
  for (const part of (raw || "").split(/[\s,]+/)) {
    const key = normalizeFooterVisibilityKey(part);
    if (key) keys.add(key);
  }
  return keys;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function visibilityEnvSuffix(key: FooterVisibilityKey): string {
  return key.replace(/-/g, "_").toUpperCase();
}

function visibilityOverrideKey(scope: FooterVisibilityScope, key: FooterVisibilityKey): string {
  return `${scope}:${key}`;
}

function visibilityEnvName(scope: FooterVisibilityScope, key: FooterVisibilityKey): string {
  const suffix = visibilityEnvSuffix(key);
  return scope === "all" ? `PI_GIT_FOOTER_${suffix}` : `PI_GIT_FOOTER_${scope.toUpperCase()}_${suffix}`;
}

const envFooterVisibilityHidden = {
  all: parseFooterVisibilityList(process.env.PI_GIT_FOOTER_HIDE),
  native: parseFooterVisibilityList(process.env.PI_GIT_FOOTER_NATIVE_HIDE),
  webui: parseFooterVisibilityList(process.env.PI_GIT_FOOTER_WEBUI_HIDE),
} satisfies Record<FooterVisibilityScope, Set<FooterVisibilityKey>>;

const envFooterVisibilityOverrides = new Map<string, boolean>();
for (const scope of FOOTER_VISIBILITY_SCOPES) {
  for (const key of FOOTER_VISIBILITY_KEYS) {
    const value = envBool(visibilityEnvName(scope, key));
    if (value !== undefined) envFooterVisibilityOverrides.set(visibilityOverrideKey(scope, key), value);
  }
}

function footerItemVisible(key: FooterVisibilityKey, target: FooterVisibilityTarget): boolean {
  let visible = FOOTER_VISIBILITY_DEFAULTS[key] ?? true;
  if (envFooterVisibilityHidden.all.has(key) || envFooterVisibilityHidden[target].has(key)) visible = false;
  const envAll = envFooterVisibilityOverrides.get(visibilityOverrideKey("all", key));
  if (envAll !== undefined) visible = envAll;
  const envTarget = envFooterVisibilityOverrides.get(visibilityOverrideKey(target, key));
  if (envTarget !== undefined) visible = envTarget;
  const runtimeAll = runtimeFooterVisibilityOverrides.get(visibilityOverrideKey("all", key));
  if (runtimeAll !== undefined) visible = runtimeAll;
  const runtimeTarget = runtimeFooterVisibilityOverrides.get(visibilityOverrideKey(target, key));
  if (runtimeTarget !== undefined) visible = runtimeTarget;
  return visible;
}

function nativeFooterItemVisible(key: FooterVisibilityKey): boolean {
  return footerItemVisible(key, "native");
}

function webuiFooterItemVisible(key: FooterVisibilityKey): boolean {
  return footerItemVisible(key, "webui");
}

function normalizeFooterVisibilityScope(value: string | undefined): FooterVisibilityScope | null {
  const token = normalizeFooterVisibilityToken(value || "");
  return token === "all" || token === "native" || token === "webui" ? token : null;
}

function normalizeFooterVisibilitySettings(value: unknown): PersistedFooterVisibilitySettings {
  const normalized = emptyFooterVisibilitySettings();
  if (!value || typeof value !== "object") return normalized;
  const overrides = (value as { overrides?: unknown }).overrides;
  if (!overrides || typeof overrides !== "object") return normalized;
  for (const scope of FOOTER_VISIBILITY_SCOPES) {
    const scopeOverrides = (overrides as Record<string, unknown>)[scope];
    if (!scopeOverrides || typeof scopeOverrides !== "object") continue;
    for (const [rawKey, rawVisible] of Object.entries(scopeOverrides)) {
      const key = normalizeFooterVisibilityKey(rawKey);
      if (key && typeof rawVisible === "boolean") normalized.overrides[scope][key] = rawVisible;
    }
  }
  return normalized;
}

export async function readFooterVisibilitySettings(storageFile = footerVisibilitySettingsFile()): Promise<PersistedFooterVisibilitySettings> {
  try {
    const settings = normalizeFooterVisibilitySettings(JSON.parse(await readFile(storageFile, "utf8")));
    warnedInvalidFooterVisibilityFiles.delete(storageFile);
    return settings;
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return emptyFooterVisibilitySettings();
    if (error instanceof SyntaxError) {
      if (!warnedInvalidFooterVisibilityFiles.has(storageFile)) {
        warnedInvalidFooterVisibilityFiles.add(storageFile);
        console.warn(`[git-footer-status] Ignoring malformed visibility settings at ${storageFile}: ${error.message}`);
      }
      return emptyFooterVisibilitySettings();
    }
    throw new Error(`Cannot read git footer visibility settings at ${storageFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeFooterVisibilitySettings(
  value: PersistedFooterVisibilitySettings,
  storageFile = footerVisibilitySettingsFile(),
): Promise<PersistedFooterVisibilitySettings> {
  const normalized = normalizeFooterVisibilitySettings(value);
  await mkdir(dirname(storageFile), { recursive: true, mode: 0o700 });
  const temporaryFile = `${storageFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, storageFile);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw new Error(`Cannot write git footer visibility settings at ${storageFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

function replaceRuntimeFooterVisibility(settings: PersistedFooterVisibilitySettings): void {
  runtimeFooterVisibilityOverrides.clear();
  for (const scope of FOOTER_VISIBILITY_SCOPES) {
    for (const [key, visible] of Object.entries(settings.overrides[scope])) {
      if (typeof visible === "boolean") runtimeFooterVisibilityOverrides.set(visibilityOverrideKey(scope, key as FooterVisibilityKey), visible);
    }
  }
}

async function reloadPersistedFooterVisibility(): Promise<void> {
  replaceRuntimeFooterVisibility(await readFooterVisibilitySettings());
}

async function persistFooterVisibility(): Promise<void> {
  const settings = emptyFooterVisibilitySettings();
  for (const scope of FOOTER_VISIBILITY_SCOPES) {
    for (const key of FOOTER_VISIBILITY_KEYS) {
      const visible = runtimeFooterVisibilityOverrides.get(visibilityOverrideKey(scope, key));
      if (visible !== undefined) settings.overrides[scope][key] = visible;
    }
  }
  await writeFooterVisibilitySettings(settings);
}

function clearRuntimeFooterVisibility(scope: FooterVisibilityScope, key?: FooterVisibilityKey): void {
  if (key) {
    runtimeFooterVisibilityOverrides.delete(visibilityOverrideKey(scope, key));
    return;
  }
  for (const currentKey of Array.from(runtimeFooterVisibilityOverrides.keys())) {
    if (currentKey.startsWith(`${scope}:`)) runtimeFooterVisibilityOverrides.delete(currentKey);
  }
}

function setRuntimeFooterVisibility(scope: FooterVisibilityScope, key: FooterVisibilityKey, visible: boolean): void {
  runtimeFooterVisibilityOverrides.set(visibilityOverrideKey(scope, key), visible);
}

function formatFooterVisibilityState(key: FooterVisibilityKey): string {
  const native = nativeFooterItemVisible(key) ? "on" : "off";
  const webui = webuiFooterItemVisible(key) ? "on" : "off";
  const changed = (FOOTER_VISIBILITY_DEFAULTS[key] ?? true) !== nativeFooterItemVisible(key) || (FOOTER_VISIBILITY_DEFAULTS[key] ?? true) !== webuiFooterItemVisible(key);
  return `${key}: native=${native}, webui=${webui}${changed ? " *" : ""}`;
}

function footerVisibilityUsage(): string {
  return [
    "Usage: /git-footer-visibility [select [all|native|webui]|status|keys]",
    "       /git-footer-visibility show|hide|toggle|reset [all|native|webui] <key> [key...]",
    "Native TUI: /git-footer-visibility opens an interactive selector; Ctrl+S applies changes.",
    "Examples: /git-footer-visibility select webui",
    "          /git-footer-visibility hide webui cost context model",
    "          /git-footer-visibility toggle native speed",
    "          /git-footer-visibility show all speed-avg speed-low speed-max",
    `Saved globally: ${footerVisibilitySettingsFile()}`,
    "Env: PI_GIT_FOOTER_HIDE=cost,context or PI_GIT_FOOTER_WEBUI_COST=0",
  ].join("\n");
}

type FooterVisibilitySelectorValue = "enabled" | "disabled" | "mixed";

function footerVisibilityScopeLabel(scope: FooterVisibilityScope): string {
  if (scope === "native") return "Native TUI";
  if (scope === "webui") return "WebUI";
  return "Native TUI + WebUI";
}

function footerVisibilityKeyLabel(key: FooterVisibilityKey): string {
  return key
    .split("-")
    .map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part)
    .join(" ");
}

function footerVisibilitySelectorValue(scope: FooterVisibilityScope, key: FooterVisibilityKey): FooterVisibilitySelectorValue {
  if (scope !== "all") return footerItemVisible(key, scope) ? "enabled" : "disabled";
  const native = nativeFooterItemVisible(key);
  const webui = webuiFooterItemVisible(key);
  if (native === webui) return native ? "enabled" : "disabled";
  return "mixed";
}

function footerVisibilitySelectorDescription(scope: FooterVisibilityScope, key: FooterVisibilityKey): string {
  const defaultState = FOOTER_VISIBILITY_DEFAULTS[key] ?? true ? "default on" : "default off";
  const native = nativeFooterItemVisible(key) ? "on" : "off";
  const webui = webuiFooterItemVisible(key) ? "on" : "off";
  return `${key} · ${defaultState} · native=${native}, webui=${webui}${scope === "all" ? "" : ` · editing ${scope}`}`;
}

function footerVisibilitySelectorInitialValues(scope: FooterVisibilityScope): Record<FooterVisibilityKey, FooterVisibilitySelectorValue> {
  return Object.fromEntries(FOOTER_VISIBILITY_KEYS.map((key) => [key, footerVisibilitySelectorValue(scope, key)])) as Record<FooterVisibilityKey, FooterVisibilitySelectorValue>;
}

function footerVisibilitySelectorCounts(values: Record<FooterVisibilityKey, FooterVisibilitySelectorValue>): string {
  const enabled = FOOTER_VISIBILITY_KEYS.filter((key) => values[key] === "enabled").length;
  const mixed = FOOTER_VISIBILITY_KEYS.filter((key) => values[key] === "mixed").length;
  return `${enabled}/${FOOTER_VISIBILITY_KEYS.length} enabled${mixed ? ` · ${mixed} mixed` : ""}`;
}

function footerVisibilityApplyScopes(scope: FooterVisibilityScope): FooterVisibilityTarget[] {
  return scope === "all" ? ["native", "webui"] : [scope];
}

function applyFooterVisibilitySelection(scope: FooterVisibilityScope, selected: Record<FooterVisibilityKey, FooterVisibilitySelectorValue>): number {
  let changed = 0;
  for (const key of FOOTER_VISIBILITY_KEYS) {
    const nextValue = selected[key];
    if (nextValue === "mixed") continue;
    const nextVisible = nextValue === "enabled";
    if (footerVisibilitySelectorValue(scope, key) === nextValue) continue;
    for (const updateScope of footerVisibilityApplyScopes(scope)) setRuntimeFooterVisibility(updateScope, key, nextVisible);
    changed += 1;
  }
  return changed;
}

function footerVisibilitySettingsListTheme(theme: ExtensionCommandContext["ui"]["theme"]) {
  return {
    label: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("muted", text),
    cursor: theme.fg("accent", "› "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

function footerVisibilityBorder(theme: ExtensionCommandContext["ui"]["theme"]) {
  return new (class {
    render(width: number) {
      return [theme.fg("accent", "─".repeat(Math.max(0, width)))];
    }
    invalidate() {}
  })();
}

function renderFooterVisibilitySettingsList(settingsList: SettingsList, width: number): string[] {
  const lines = settingsList.render(width);
  const hintIndex = lines.findIndex((line) => line.includes("Type to search") && line.includes("Enter/Space") && line.includes("Esc"));
  if (hintIndex < 0) return lines;
  const filtered = [...lines];
  filtered.splice(hintIndex, 1);
  if (hintIndex > 0 && visibleWidth(filtered[hintIndex - 1] ?? "") === 0) filtered.splice(hintIndex - 1, 1);
  return filtered;
}

async function openFooterVisibilitySelector(
  ctx: ExtensionCommandContext,
  scope: FooterVisibilityScope,
): Promise<Record<FooterVisibilityKey, FooterVisibilitySelectorValue> | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/git-footer-visibility select requires the native Pi TUI. Use explicit show/hide/toggle commands in WebUI/RPC mode.", "warning");
    return undefined;
  }

  const initial = footerVisibilitySelectorInitialValues(scope);
  const selected: Record<FooterVisibilityKey, FooterVisibilitySelectorValue> = { ...initial };

  return await ctx.ui.custom<Record<FooterVisibilityKey, FooterVisibilitySelectorValue> | undefined>((tui, theme, _kb, done) => {
    const items: SettingItem[] = FOOTER_VISIBILITY_KEYS.map((key) => ({
      id: key,
      label: footerVisibilityKeyLabel(key),
      description: footerVisibilitySelectorDescription(scope, key),
      currentValue: selected[key],
      values: ["enabled", "disabled"],
    }));

    const container = new Container();
    container.addChild(footerVisibilityBorder(theme));
    container.addChild(
      new (class {
        render(width: number) {
          const title = `Git footer visibility — ${footerVisibilityScopeLabel(scope)} (${footerVisibilitySelectorCounts(selected)})`;
          return [truncateToWidth(theme.fg("accent", theme.bold(title)), width), ""];
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(
      items,
      14,
      footerVisibilitySettingsListTheme(theme),
      (id, newValue) => {
        const key = normalizeFooterVisibilityKey(id);
        if (!key) return;
        selected[key] = newValue === "enabled" ? "enabled" : "disabled";
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(
      new (class {
        render(width: number) {
          return renderFooterVisibilitySettingsList(settingsList, width);
        }
        invalidate() {
          settingsList.invalidate();
        }
      })(),
    );
    container.addChild(
      new (class {
        render(width: number) {
          const help = "Ctrl+S apply • Enter/Space toggle • type to search • Esc/q cancel";
          return ["", truncateToWidth(theme.fg("dim", help), width)];
        }
        invalidate() {}
      })(),
    );
    container.addChild(footerVisibilityBorder(theme));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
          done(selected);
          return;
        }
        if (data === "q") {
          done(undefined);
          return;
        }
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

type GitStatusTone = "accent" | "warning" | "muted" | "success" | "error" | "dim";

type GitStatusItem = {
  text: string;
  tone: GitStatusTone;
};

type GitStatusSection = {
  key: "branch" | "sync" | "changes" | "extra";
  items: GitStatusItem[];
};

type GitFetchState = {
  status: "idle" | "fetching" | "ok" | "error" | "skipped";
  startedAt?: number;
  completedAt?: number;
  message?: string;
};

type FooterTelemetry = {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  speedOutputTokens: number;
  latestTokenSpeed: number | null;
  speedStats: SessionSpeedStats | null;
  promptInjectionTokens: number | null;
  promptInjectionCalibrationSamples: number;
  contextWindow: number;
  contextPercent: number | null;
  contextDisplay: string;
  modelName: string;
  modelProvider: string | null;
  showModelProvider: boolean;
  thinkingLevel: string;
  usingSubscription: boolean;
};

type WebuiFooterChangedFile = GitChangedFile;

type WebuiFooterChip = {
  key: string;
  label: string;
  value: string;
  icon?: string;
  tone?: "pink" | "blue" | "mauve" | "yellow" | "green" | "teal";
  title?: string;
  action?: "calibrate-current" | "calibrate-probe";
  files?: WebuiFooterChangedFile[];
  filesTotal?: number;
  filesTruncated?: boolean;
  contextUsage?: {
    percent: number | null;
    contextWindow: number;
  };
  usageWindows?: {
    primaryPercent?: number;
    secondaryPercent?: number;
  };
};

type WebuiFooterPayload = {
  type: typeof WEBUI_FOOTER_PAYLOAD_TYPE;
  version: typeof WEBUI_FOOTER_PAYLOAD_VERSION;
  generatedAt: number;
  providerUsage?: ProviderUsageSnapshot;
  main: WebuiFooterChip[];
  meta: WebuiFooterChip[];
  visibility: Record<FooterVisibilityKey, boolean>;
};

type GitRefreshOptions = {
  publishIfUnchanged?: boolean;
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

const GIT_AUTO_REFRESH_INTERVAL_MS = envMs("PI_GIT_FOOTER_AUTO_REFRESH_MS", DEFAULT_GIT_AUTO_REFRESH_INTERVAL_MS);
const GIT_INITIAL_FETCH_ENABLED = envFlag("PI_GIT_FOOTER_FETCH", true);
const PROMPT_ESTIMATE_ENABLED = !envFlag("PI_GIT_FOOTER_DISABLE_PROMPT_ESTIMATE", false);

function formatCwd(cwd: string): string {
  return formatUserPath(cwd);
}

function getEntryTimestampMs(entry: { type: string; timestamp: string; message?: { timestamp?: number } }): number | null {
  if (entry.type === "message" && typeof entry.message?.timestamp === "number") {
    return normalizeTimestampMs(entry.message.timestamp);
  }
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isReasonableTokenSpeed(tokensPerSecond: number): boolean {
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 && tokensPerSecond <= 1000;
}

type LiveTokenSample = {
  timestampMs: number;
  tokens: number;
};

type SessionSpeedStats = {
  avg: number;
  onePercentLow: number;
  max: number;
  sampleCount: number;
};

/**
 * FPS-style stats over live speed samples: mean, mean of the lowest 1% of
 * samples (at least one), and the maximum observed spike.
 */
function computeSessionSpeedStats(samples: number[]): SessionSpeedStats | null {
  if (samples.length === 0) return null;
  let sum = 0;
  let max = 0;
  for (const sample of samples) {
    sum += sample;
    if (sample > max) max = sample;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const lowCount = Math.max(1, Math.floor(sorted.length / 100));
  let lowSum = 0;
  for (let i = 0; i < lowCount; i++) lowSum += sorted[i];
  return {
    avg: sum / samples.length,
    onePercentLow: lowSum / lowCount,
    max,
    sampleCount: samples.length,
  };
}

type FooterUsageSnapshot = {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  historicalTokenSpeed: number | null;
};

function emptyFooterUsageSnapshot(): FooterUsageSnapshot {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    historicalTokenSpeed: null,
  };
}

function formatTokenSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond < 100) {
    if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
    return tokensPerSecond.toFixed(2);
  }
  if (tokensPerSecond < 1000) return Math.round(tokensPerSecond).toString();
  if (tokensPerSecond < 10000) return `${(tokensPerSecond / 1000).toFixed(1)}k`;
  if (tokensPerSecond < 1000000) return `${Math.round(tokensPerSecond / 1000)}k`;
  if (tokensPerSecond < 10000000) return `${(tokensPerSecond / 1000000).toFixed(1)}M`;
  return `${Math.round(tokensPerSecond / 1000000)}M`;
}

function gitReadArgs(...args: string[]): string[] {
  return ["--no-optional-locks", ...args];
}

async function runGitRead(pi: ExtensionAPI, cwd: string, args: string[], timeout = 2000): Promise<string | undefined> {
  const result = await pi.exec("git", gitReadArgs(...args), { cwd, timeout }).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  return result.stdout.trim();
}

function compactFetchMessage(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > GIT_FETCH_MESSAGE_MAX_LENGTH ? `${text.slice(0, GIT_FETCH_MESSAGE_MAX_LENGTH - 1)}…` : text;
}

function gitFetchResultMessage(result: { stdout?: string; stderr?: string; code?: number; killed?: boolean }): string {
  const output = compactFetchMessage([result.stderr, result.stdout].filter(Boolean).join("\n"));
  if (output) return output;
  if (result.killed) return "git fetch timed out";
  return result.code === 0 ? "git fetch completed" : `git fetch failed with exit code ${result.code ?? "unknown"}`;
}

function toAgeLabel(epochSeconds: number): string | undefined {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;

  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (deltaSeconds < 60) return "now";

  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export async function detectGitOperation(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const gitDirRaw = await runGitRead(pi, cwd, ["rev-parse", "--git-dir"]);
  if (!gitDirRaw) return undefined;

  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(cwd, gitDirRaw);

  if ((await pathExists(resolve(gitDir, "rebase-merge"))) || (await pathExists(resolve(gitDir, "rebase-apply")))) {
    return "REBASING";
  }
  if (await pathExists(resolve(gitDir, "MERGE_HEAD"))) return "MERGING";
  if (await pathExists(resolve(gitDir, "CHERRY_PICK_HEAD"))) return "CHERRY-PICK";
  if (await pathExists(resolve(gitDir, "REVERT_HEAD"))) return "REVERTING";
  if (await pathExists(resolve(gitDir, "BISECT_LOG"))) return "BISECT";

  return undefined;
}

function splitPorcelainFields(line: string, fieldCount: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount - 1; index++) {
    const next = line.indexOf(" ", start);
    if (next === -1) break;
    fields.push(line.slice(start, next));
    start = next + 1;
  }
  fields.push(line.slice(start));
  return fields;
}

function parsePorcelainPathField(value: string): { path: string; oldPath?: string } {
  const [path = "", oldPath] = value.split("\t");
  return oldPath ? { path, oldPath } : { path };
}

function addChangedFile(files: GitChangedFile[], kind: GitChangeKind, path: string, status: string, oldPath?: string) {
  const entry: GitChangedFile = { kind, path, status };
  if (oldPath) entry.oldPath = oldPath;
  files.push(entry);
}

function addTrackedChangedFiles(files: GitChangedFile[], xy: string, path: string, oldPath?: string) {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x !== ".") addChangedFile(files, "staged", path, xy, oldPath);
  if (y !== ".") addChangedFile(files, "modified", path, xy, oldPath);
}

export function parseGitPorcelainStatus(stdout: string): GitPorcelainStatus {
  let branch = "";
  let detachedOid: string | undefined;
  let upstream: string | undefined;
  let hasAbLine = false;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const changedFiles: GitChangedFile[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      if (oid && oid !== "(initial)") detachedOid = oid;
      continue;
    }

    if (line.startsWith("# branch.upstream ")) {
      const value = line.slice("# branch.upstream ".length).trim();
      if (value) upstream = value;
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      hasAbLine = true;
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number.parseInt(match[1] ?? "0", 10) || 0;
        behind = Number.parseInt(match[2] ?? "0", 10) || 0;
      }
      continue;
    }

    if (line.startsWith("1 ")) {
      const fields = splitPorcelainFields(line, 9);
      const xy = fields[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") staged++;
      if (y !== ".") unstaged++;
      const filePath = fields[8] ?? "";
      if (filePath) addTrackedChangedFiles(changedFiles, xy, filePath);
      continue;
    }

    if (line.startsWith("2 ")) {
      const fields = splitPorcelainFields(line, 10);
      const xy = fields[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") staged++;
      if (y !== ".") unstaged++;
      const parsedPath = parsePorcelainPathField(fields[9] ?? "");
      if (parsedPath.path) addTrackedChangedFiles(changedFiles, xy, parsedPath.path, parsedPath.oldPath);
      continue;
    }

    if (line.startsWith("u ")) {
      conflicted++;
      const fields = splitPorcelainFields(line, 11);
      const filePath = fields[10] ?? "";
      if (filePath) changedFiles.push({ kind: "conflicted", path: filePath, status: fields[1] ?? "UU" });
      continue;
    }

    if (line.startsWith("? ")) {
      untracked++;
      const filePath = line.slice(2);
      if (filePath) changedFiles.push({ kind: "untracked", path: filePath, status: "??" });
      continue;
    }
  }

  const isDetached = !branch || branch === "(detached)";
  const resolvedBranch =
    !isDetached
      ? branch
      : detachedOid
        ? `detached@${detachedOid.slice(0, 7)}`
        : "detached";

  // Upstream configured but unresolvable (deleted remote branch): porcelain=2
  // emits branch.upstream without a branch.ab line.
  const upstreamGone = Boolean(upstream) && !hasAbLine;

  return {
    branch: resolvedBranch,
    isDetached,
    upstream,
    upstreamGone,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    changedFiles,
  };
}

type GitAuxInfo = {
  stashCount: number;
  submoduleDirty: number;
  lastCommitEpoch?: number;
  worktreeCount: number;
  headTag?: string;
  signingMismatch: boolean;
  hasRemotes: boolean;
};

// Stash/submodule/worktree/tag/signing state rarely changes between refresh
// ticks; re-running those probes every 10s dominates auto-refresh cost in
// large repos. Reuse them while `git status` output (which includes the HEAD
// oid) is unchanged, bounded by a TTL so out-of-band changes (stash drop, tag
// creation) still surface within a minute.
const GIT_AUX_CACHE_TTL_MS = 60_000;
let gitAuxCache: { key: string; at: number; aux: GitAuxInfo } | null = null;

async function readGitAuxInfo(pi: ExtensionAPI, cwd: string): Promise<GitAuxInfo> {
  const [stashList, lastCommitTs, worktreeList, headTags, commitSignRequiredRaw, headSignState, remotes, toplevel] =
    await Promise.all([
      runGitRead(pi, cwd, ["stash", "list", "--format=%gd"]),
      runGitRead(pi, cwd, ["log", "-1", "--format=%ct"]),
      runGitRead(pi, cwd, ["worktree", "list", "--porcelain"]),
      runGitRead(pi, cwd, ["tag", "--points-at", "HEAD", "--sort=-creatordate"]),
      runGitRead(pi, cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
      runGitRead(pi, cwd, ["log", "-1", "--format=%G?"]),
      runGitRead(pi, cwd, ["remote"]),
      runGitRead(pi, cwd, ["rev-parse", "--show-toplevel"]),
    ]);

  // `submodule status --recursive` spawns per submodule and is by far the most
  // expensive probe; skip it entirely for the common no-submodule repo.
  const hasGitmodules = toplevel ? await pathExists(resolve(toplevel, ".gitmodules")) : false;
  const submoduleStatus = hasGitmodules ? await runGitRead(pi, cwd, ["submodule", "status", "--recursive"]) : undefined;

  const stashCount = stashList ? stashList.split(/\r?\n/).filter(Boolean).length : 0;

  const submoduleDirty = submoduleStatus
    ? submoduleStatus
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith(" "))
        .length
    : 0;

  const worktreeCount = worktreeList
    ? Math.max(
        1,
        worktreeList
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree ")).length,
      )
    : 1;

  const headTag = headTags?.split(/\r?\n/).find(Boolean);

  const lastCommitEpoch = lastCommitTs ? Number.parseInt(lastCommitTs, 10) : undefined;

  const commitSignRequired = commitSignRequiredRaw?.toLowerCase() === "true";
  const signState = headSignState?.trim().toUpperCase();
  const signingMismatch =
    commitSignRequired &&
    (!signState || signState === "N" || signState === "E");

  return {
    stashCount,
    submoduleDirty,
    lastCommitEpoch,
    worktreeCount,
    headTag,
    signingMismatch,
    hasRemotes: Boolean(remotes),
  };
}

export async function readGitSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitSnapshot | null> {
  const result = await pi
    .exec("git", gitReadArgs("status", "--porcelain=2", "--branch"), { cwd, timeout: 3000 })
    .catch(() => undefined);

  if (!result || result.code !== 0) {
    return null;
  }

  const status = parseGitPorcelainStatus(result.stdout);

  // Operation state must stay fresh (conflict UX depends on it); it is cheap
  // (one rev-parse + a few stat calls) compared to the cached aux probes.
  const operation = await detectGitOperation(pi, cwd);

  const auxKey = `${cwd} ${result.stdout}`;
  const now = Date.now();
  let aux: GitAuxInfo;
  if (gitAuxCache && gitAuxCache.key === auxKey && now - gitAuxCache.at < GIT_AUX_CACHE_TTL_MS) {
    aux = gitAuxCache.aux;
  } else {
    aux = await readGitAuxInfo(pi, cwd);
    gitAuxCache = { key: auxKey, at: now, aux };
  }

  const changedFilesTotal = status.changedFiles.length;
  const changedFiles = status.changedFiles.slice(0, GIT_CHANGED_FILES_LIMIT);

  return {
    branch: status.branch,
    isDetached: status.isDetached,
    upstream: status.upstream,
    upstreamGone: status.upstreamGone,
    hasRemotes: aux.hasRemotes,
    ahead: status.ahead,
    behind: status.behind,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
    changedFiles,
    changedFilesTotal,
    changedFilesTruncated: changedFilesTotal > changedFiles.length,
    operation,
    stashCount: aux.stashCount,
    submoduleDirty: aux.submoduleDirty,
    lastCommitAge: aux.lastCommitEpoch ? toAgeLabel(aux.lastCommitEpoch) : undefined,
    worktreeCount: aux.worktreeCount,
    headTag: aux.headTag,
    signingMismatch: aux.signingMismatch,
  };
}

async function getSigningDiagnostics(pi: ExtensionAPI, cwd: string): Promise<SigningDiagnostics> {
  const [commitSignRequiredRaw, headSignState, gpgFormatRaw, signingKeyRaw] = await Promise.all([
    runGitRead(pi, cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
    runGitRead(pi, cwd, ["log", "-1", "--format=%G?"]),
    runGitRead(pi, cwd, ["config", "--get", "gpg.format"]),
    runGitRead(pi, cwd, ["config", "--get", "user.signingkey"]),
  ]);

  return {
    commitSignRequired: commitSignRequiredRaw?.toLowerCase() === "true",
    signState: headSignState?.trim().toUpperCase() || "N",
    gpgFormat: gpgFormatRaw?.trim() || "(default:gpg)",
    signingKey: signingKeyRaw?.trim() || "(not set)",
  };
}

function isWorkingTreeClean(snapshot: GitSnapshot): boolean {
  return (
    snapshot.ahead === 0 &&
    snapshot.behind === 0 &&
    snapshot.staged === 0 &&
    snapshot.unstaged === 0 &&
    snapshot.untracked === 0 &&
    snapshot.conflicted === 0
  );
}

function gitSnapshotFingerprint(snapshot: GitSnapshot | null): string {
  if (!snapshot) return "none";
  return [
    snapshot.branch,
    snapshot.isDetached ? "1" : "0",
    snapshot.upstream ?? "",
    snapshot.upstreamGone ? "1" : "0",
    snapshot.hasRemotes ? "1" : "0",
    snapshot.changedFilesTotal,
    snapshot.changedFilesTruncated ? "1" : "0",
    snapshot.ahead,
    snapshot.behind,
    snapshot.staged,
    snapshot.unstaged,
    snapshot.untracked,
    snapshot.conflicted,
    snapshot.changedFiles.map((file) => `${file.kind}:${file.status}:${file.oldPath ? `${file.oldPath}->` : ""}${file.path}`).join("\u001e"),
    snapshot.operation ?? "",
    snapshot.stashCount,
    snapshot.submoduleDirty,
    snapshot.lastCommitAge ?? "",
    snapshot.worktreeCount,
    snapshot.headTag ?? "",
    snapshot.signingMismatch ? "1" : "0",
  ].join("\u001f");
}

function buildGitStatusSections(snapshot: GitSnapshot, target: FooterVisibilityTarget = "native"): GitStatusSection[] {
  const visible = (key: FooterVisibilityKey) => footerItemVisible(key, target);
  const branchSection: GitStatusItem[] = [];
  if (visible("git-branch-indicator")) {
    branchSection.push({ text: "", tone: "accent" }, { text: snapshot.branch, tone: "accent" });
  }
  if (visible("git-detached") && snapshot.isDetached) branchSection.push({ text: "⎇", tone: "warning" });
  if (visible("git-operation") && snapshot.operation) branchSection.push({ text: snapshot.operation, tone: "warning" });

  const syncSection: GitStatusItem[] = [];
  if (visible("git-ahead") && snapshot.ahead > 0) syncSection.push({ text: `⇡${snapshot.ahead}`, tone: "muted" });
  if (visible("git-behind") && snapshot.behind > 0) syncSection.push({ text: `⇣${snapshot.behind}`, tone: "muted" });
  if (visible("git-upstream") && !snapshot.isDetached) {
    if (snapshot.upstreamGone) syncSection.push({ text: "upstream gone", tone: "warning" });
    else if (!snapshot.upstream && snapshot.hasRemotes) syncSection.push({ text: "no upstream", tone: "muted" });
  }

  const changesSection: GitStatusItem[] = [];
  if (visible("git-staged") && snapshot.staged > 0) changesSection.push({ text: `+${snapshot.staged}`, tone: "success" });
  if (visible("git-unstaged") && snapshot.unstaged > 0) changesSection.push({ text: `✎${snapshot.unstaged}`, tone: "warning" });
  if (visible("git-untracked") && snapshot.untracked > 0) changesSection.push({ text: `◌${snapshot.untracked}`, tone: "muted" });
  if (visible("git-conflicted") && snapshot.conflicted > 0) changesSection.push({ text: `!${snapshot.conflicted}`, tone: "error" });
  if (visible("git-clean") && isWorkingTreeClean(snapshot)) changesSection.push({ text: "✅", tone: "dim" });

  const extraSection: GitStatusItem[] = [];
  if (visible("git-stash") && snapshot.stashCount > 0) extraSection.push({ text: `⚑${snapshot.stashCount}`, tone: "muted" });
  if (visible("git-submodules") && snapshot.submoduleDirty > 0) extraSection.push({ text: `✖${snapshot.submoduleDirty}`, tone: "warning" });
  if (visible("git-worktrees") && snapshot.worktreeCount > 1) extraSection.push({ text: `📦${snapshot.worktreeCount}`, tone: "muted" });
  if (visible("git-tag") && snapshot.headTag) extraSection.push({ text: `🏷${snapshot.headTag}`, tone: "accent" });
  if (visible("git-last-commit-age") && snapshot.lastCommitAge) extraSection.push({ text: `⏱ ${snapshot.lastCommitAge}`, tone: "dim" });
  if (visible("git-signing-mismatch") && snapshot.signingMismatch) extraSection.push({ text: "⚠️!", tone: "warning" });

  const sections: GitStatusSection[] = [
    { key: "branch", items: branchSection },
    { key: "sync", items: syncSection },
    { key: "changes", items: changesSection },
    { key: "extra", items: extraSection },
  ];
  return sections.filter((section) => section.items.length > 0);
}

function buildStatusText(ctx: ExtensionContext, snapshot: GitSnapshot): string {
  const t = ctx.ui.theme;
  const sectionSep = t.fg("dim", "│");
  const itemSep = t.fg("dim", "·");
  const sections = buildGitStatusSections(snapshot);

  return sections.length > 0
    ? sections
        .map((section) => section.items.map((item) => t.fg(item.tone, item.text)).join(` ${itemSep} `))
        .join(` ${sectionSep} `)
    : t.fg("dim", "git");
}

function sectionValue(section: GitStatusSection | undefined): string | undefined {
  if (!section || section.items.length === 0) return undefined;
  return section.items.map((item) => item.text).join(" · ");
}

function webuiRemoteChangeValue(snapshot: GitSnapshot, fetchState: GitFetchState): string | undefined {
  const showFetchState = webuiFooterItemVisible("webui-fetch-state");
  if (showFetchState && fetchState.status === "fetching") return "🔄 fetch";
  if (webuiFooterItemVisible("git-behind") && snapshot.behind > 0) return `⬇️ ${snapshot.behind}`;
  if (showFetchState && fetchState.status === "error") return "⚠️ fetch";
  if (showFetchState && fetchState.status === "ok") return "✓ fetch";
  return undefined;
}

function gitFetchTitle(fetchState: GitFetchState, snapshot: GitSnapshot): string | undefined {
  if (fetchState.status === "idle" || fetchState.status === "skipped") return undefined;
  const parts: string[] = [];
  if (fetchState.status === "fetching") parts.push("git fetch is running for this tab");
  else if (fetchState.status === "ok") parts.push("git fetch completed for this tab");
  else if (fetchState.status === "error") parts.push("git fetch failed for this tab");
  if (snapshot.behind > 0) parts.push(`${snapshot.behind} remote commit${snapshot.behind === 1 ? "" : "s"} to pull`);
  if (fetchState.message && !["git fetch", "git fetch completed"].includes(fetchState.message)) parts.push(fetchState.message);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function webuiChangesValue(snapshot: GitSnapshot, fetchState: GitFetchState): string | undefined {
  const parts: string[] = [];
  if (webuiFooterItemVisible("git-staged") && snapshot.staged > 0) parts.push(`🟢 ${snapshot.staged}`);
  if (webuiFooterItemVisible("git-unstaged") && snapshot.unstaged > 0) parts.push(`✏️ ${snapshot.unstaged}`);
  if (webuiFooterItemVisible("git-untracked") && snapshot.untracked > 0) parts.push(`➕ ${snapshot.untracked}`);
  if (webuiFooterItemVisible("git-conflicted") && snapshot.conflicted > 0) parts.push(`⚠️ ${snapshot.conflicted}`);
  const remoteChange = webuiRemoteChangeValue(snapshot, fetchState);
  if (remoteChange) parts.push(remoteChange);
  if (webuiFooterItemVisible("git-clean") && parts.length === 0 && isWorkingTreeClean(snapshot)) parts.push("✅");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function webuiExtraValue(snapshot: GitSnapshot): string | undefined {
  const parts: string[] = [];
  if (webuiFooterItemVisible("git-stash") && snapshot.stashCount > 0) parts.push(`📦 ${snapshot.stashCount}`);
  if (webuiFooterItemVisible("git-submodules") && snapshot.submoduleDirty > 0) parts.push(`🧩 ${snapshot.submoduleDirty}`);
  if (webuiFooterItemVisible("git-worktrees") && snapshot.worktreeCount > 1) parts.push(`🌳 ${snapshot.worktreeCount}`);
  if (webuiFooterItemVisible("git-tag") && snapshot.headTag) parts.push(`🏷️ ${snapshot.headTag}`);
  if (webuiFooterItemVisible("git-last-commit-age") && snapshot.lastCommitAge) parts.push(`🕒 ${snapshot.lastCommitAge}`);
  if (webuiFooterItemVisible("git-signing-mismatch") && snapshot.signingMismatch) parts.push("🔓");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function footerTone(tone: GitStatusTone): WebuiFooterChip["tone"] {
  switch (tone) {
    case "success":
      return "green";
    case "warning":
      return "yellow";
    case "accent":
      return "mauve";
    case "error":
      return "pink";
    case "muted":
    case "dim":
      return "blue";
  }
}

function buildWebuiGitMeta(snapshot: GitSnapshot | null, fetchState: GitFetchState): WebuiFooterChip[] {
  if (!snapshot) {
    return webuiFooterItemVisible("git") ? [{ key: "git", label: "git", value: "no repo", title: "git: no repo" }] : [];
  }

  const sections = buildGitStatusSections(snapshot, "webui");
  const state = sectionValue(sections.find((section) => section.key === "branch"));
  const sync = sectionValue(sections.find((section) => section.key === "sync"));
  const changes = webuiChangesValue(snapshot, fetchState);
  const changesFetchTitle = gitFetchTitle(fetchState, snapshot);
  const extraSection = sections.find((section) => section.key === "extra");
  const extra = webuiExtraValue(snapshot);

  const chips: WebuiFooterChip[] = [];
  if (webuiFooterItemVisible("git")) {
    chips.push({
      key: "git",
      label: "git",
      value: snapshot.branch || "detached",
      title: `git branch: ${snapshot.branch || "detached"}`,
    });
  }
  if (webuiFooterItemVisible("git-state") && state) chips.push({ key: "git-state", label: "state", value: state, title: `git state: ${state}`, tone: "yellow" });
  if (webuiFooterItemVisible("sync") && sync) chips.push({ key: "sync", label: "sync", value: sync, title: `git sync: ${sync}`, tone: "blue" });
  if (webuiFooterItemVisible("changes") && changes) {
    const chip: WebuiFooterChip = {
      key: "changes",
      label: "changes",
      value: changes,
      title: [`git changes: ${changes}`, changesFetchTitle].filter(Boolean).join("\n"),
    };
    if (webuiFooterItemVisible("webui-changed-files-popover")) {
      chip.files = snapshot.changedFiles.slice(0, GIT_CHANGED_FILES_LIMIT);
      chip.filesTotal = snapshot.changedFilesTotal;
      chip.filesTruncated = snapshot.changedFilesTruncated;
    }
    chips.push(chip);
  }
  if (webuiFooterItemVisible("git-extra") && extra) {
    chips.push({
      key: "git-extra",
      label: "git+",
      value: extra,
      title: `git extras: ${extra}`,
      tone: footerTone(extraSection?.items.find((item) => item.tone !== "dim")?.tone ?? "muted"),
    });
  }
  return chips;
}

function footerMetricValue(tokens: number): string {
  return formatTokens(tokens);
}

function footerPromptInjectionValue(tokens: number | null): string {
  return tokens === null ? "…" : `${footerMetricValue(tokens)} tok`;
}

function debugHashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function formatDebugToolNames(snapshot: InitialPromptEstimateSnapshot, limit = 16): string {
  const names = snapshot.tools.map((tool) => tool.name).filter(Boolean);
  if (names.length === 0) return "none";
  const shown = names.slice(0, limit).join(", ");
  const remaining = names.length - limit;
  return remaining > 0 ? `${shown}, … +${remaining} more` : shown;
}

function formatPromptEstimateDebugSnapshot(label: string, snapshot: InitialPromptEstimateSnapshot | null): string[] {
  if (!snapshot) return [`${label}: none`];

  const estimate = snapshot.estimate;
  const state = snapshot.settled ? "settled" : "pending";
  const range = estimate.low !== estimate.high ? ` · range ${formatTokens(estimate.low)}–${formatTokens(estimate.high)}` : "";
  const warning = snapshot.warning ? [`  warning: ${snapshot.warning}`] : [];

  return [
    `${label}: ~${formatTokens(estimate.total)} tok (${snapshot.source}, ${state}, attempts=${snapshot.attempts}${range})`,
    `  key: ${snapshot.key}`,
    `  components: prompt=${formatTokens(estimate.promptText)} · tools=${formatTokens(estimate.toolSchemas)} (${estimate.toolCount}) · framing=${formatTokens(estimate.framing)} · uncal=${formatTokens(estimate.uncalibratedTotal)}`,
    `  calibration: ×${estimate.calibrationMultiplier.toFixed(4)} · samples=${estimate.calibrationSamples} · confidence=${estimate.confidence}`,
    `  systemPrompt: ${snapshot.systemPrompt.length} chars · hash=${debugHashText(snapshot.systemPrompt)}`,
    `  tools: ${formatDebugToolNames(snapshot)}`,
    ...warning,
  ];
}

function formatProviderUsageResetAfter(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function providerUsageResetLabel(window: ProviderUsageWindow): string {
  if (window.resetAt !== undefined) return `resets ${new Date(window.resetAt).toISOString()}`;
  if (window.resetAfterSeconds !== undefined) return `resets in ${formatProviderUsageResetAfter(window.resetAfterSeconds)}`;
  return "reset time unknown";
}

function buildProviderUsageTitle(usage: ProviderUsageSnapshot): string {
  const providerLabel = usage.provider === "openai-codex" ? "OpenAI Codex" : "Anthropic";
  const plan = usage.plan ? ` · plan ${usage.plan}` : "";
  return [
    `${providerLabel} subscription usage (used share of each available window)${plan}`,
    ...providerUsageWindows(usage).map(
      (window) => `${window.label} window: ${Math.round(window.usedPercent)}% used · ${providerUsageResetLabel(window)}`,
    ),
  ].join("\n");
}

function buildWebuiVisibilityRecord(): Record<FooterVisibilityKey, boolean> {
  return Object.fromEntries(FOOTER_VISIBILITY_KEYS.map((key) => [key, webuiFooterItemVisible(key)])) as Record<FooterVisibilityKey, boolean>;
}

function buildWebuiFooterPayload(ctx: ExtensionContext, snapshot: GitSnapshot | null, telemetry: FooterTelemetry, fetchState: GitFetchState, providerUsage: ProviderUsageSnapshot | null): WebuiFooterPayload {
  const speed = telemetry.latestTokenSpeed;
  const speedValue = speed === null ? "— tok/s" : `${formatTokenSpeed(speed)} tok/s`;
  const speedStats = telemetry.speedStats;
  const speedStatParts: string[] = [];
  if (speedStats) {
    if (webuiFooterItemVisible("speed-avg")) speedStatParts.push(`avg ${formatTokenSpeed(speedStats.avg)}`);
    if (webuiFooterItemVisible("speed-low")) speedStatParts.push(`1% ${formatTokenSpeed(speedStats.onePercentLow)}`);
    if (webuiFooterItemVisible("speed-max")) speedStatParts.push(`max ${formatTokenSpeed(speedStats.max)}`);
  }
  const speedStatsSuffix = speedStatParts.length > 0 ? ` · ${speedStatParts.join(" · ")}` : "";
  const speedTitle = speedStats
    ? `Session speed stats from ${speedStats.sampleCount} live sample${speedStats.sampleCount === 1 ? "" : "s"}: avg ${formatTokenSpeed(speedStats.avg)} tok/s · 1% low ${formatTokenSpeed(speedStats.onePercentLow)} tok/s · max spike ${formatTokenSpeed(speedStats.max)} tok/s. Toggle inline stats via /git-footer-visibility (speed-avg, speed-low, speed-max).`
    : undefined;
  const providerPrefix = telemetry.showModelProvider && telemetry.modelProvider ? `(${telemetry.modelProvider}) ` : "";
  const thinkingSuffix = telemetry.thinkingLevel
    ? telemetry.thinkingLevel === "off"
      ? " • thinking off"
      : ` • ${telemetry.thinkingLevel}`
    : "";
  const piAction: WebuiFooterChip["action"] | undefined = webuiFooterItemVisible("webui-pi-calibration")
    ? "calibrate-probe"
    : undefined;
  const piCalibrationAction = piAction
    ? " Click to run /calibrate in an isolated background probe and refresh this value when it finishes."
    : "";
  const piTitle = telemetry.promptInjectionTokens === null
    ? `PI initial prompt estimate pending.${piCalibrationAction}`
    : telemetry.promptInjectionCalibrationSamples > 0
      ? `PI initial prompt estimate calibrated from ${telemetry.promptInjectionCalibrationSamples} sample${telemetry.promptInjectionCalibrationSamples === 1 ? "" : "s"}.${piCalibrationAction}`
      : `PI initial prompt estimate is uncalibrated.${piCalibrationAction}`;

  const main: WebuiFooterChip[] = [];
  if (webuiFooterItemVisible("tokens") && (telemetry.totalInput || telemetry.totalOutput)) {
    main.push({
      key: "tokens",
      icon: "🪙",
      label: "tokens",
      value: `↑${footerMetricValue(telemetry.totalInput)} · ↓${footerMetricValue(telemetry.totalOutput)}`,
      tone: "pink",
    });
  }
  if (webuiFooterItemVisible("cache") && (telemetry.totalCacheRead || telemetry.totalCacheWrite)) {
    main.push({
      key: "cache",
      icon: "💾",
      label: "cache",
      value: `R${footerMetricValue(telemetry.totalCacheRead)} · W${footerMetricValue(telemetry.totalCacheWrite)}`,
      tone: "blue",
    });
  }
  if (webuiFooterItemVisible("pi")) {
    main.push({
      key: "pi",
      icon: "π",
      label: "pi",
      value: footerPromptInjectionValue(telemetry.promptInjectionTokens),
      title: piTitle,
      action: piAction,
      tone: "mauve",
    });
  }
  if (webuiFooterItemVisible("speed")) {
    main.push({
      key: "speed",
      icon: "⚡",
      label: "speed",
      value: `${footerMetricValue(telemetry.speedOutputTokens)} tok @ ${speedValue}${speedStatsSuffix}`,
      title: speedTitle,
      tone: "yellow",
    });
  }
  if (webuiFooterItemVisible("cost")) {
    main.push({
      key: "cost",
      icon: "💸",
      label: telemetry.usingSubscription ? "sub" : "api",
      value: `$${telemetry.totalCost.toFixed(3)}`,
      tone: "green",
    });
  }
  if (webuiFooterItemVisible("context")) {
    main.push({
      key: "context",
      icon: "🧠",
      label: "context",
      value: telemetry.contextDisplay,
      tone: "teal",
      contextUsage: {
        percent: telemetry.contextPercent,
        contextWindow: telemetry.contextWindow,
      },
    });
  }
  if (webuiFooterItemVisible("usage") && providerUsage) {
    main.push({
      key: "usage",
      icon: "📊",
      label: "Usage",
      value: formatProviderUsage(providerUsage),
      title: buildProviderUsageTitle(providerUsage),
      tone: "teal",
      usageWindows: {
        ...(providerUsage.primary ? { primaryPercent: providerUsage.primary.usedPercent } : {}),
        ...(providerUsage.secondary ? { secondaryPercent: providerUsage.secondary.usedPercent } : {}),
      },
    });
  }

  const meta: WebuiFooterChip[] = [];
  if (webuiFooterItemVisible("cwd")) {
    meta.push({
      key: "cwd",
      label: "cwd",
      value: formatCwd(ctx.cwd),
      title: `cwd: ${ctx.cwd}`,
    });
  }
  if (webuiFooterItemVisible("context-meta")) {
    meta.push({
      key: "context",
      label: "context",
      value: telemetry.contextDisplay,
      title: `context: ${telemetry.contextDisplay}`,
      contextUsage: {
        percent: telemetry.contextPercent,
        contextWindow: telemetry.contextWindow,
      },
    });
  }
  meta.push(...buildWebuiGitMeta(snapshot, fetchState));
  if (webuiFooterItemVisible("model")) {
    meta.push({
      key: "model",
      label: "model",
      value: `${providerPrefix}${telemetry.modelName}${thinkingSuffix}`,
      title: `model: ${providerPrefix}${telemetry.modelName}${thinkingSuffix}`,
    });
  }

  return {
    type: WEBUI_FOOTER_PAYLOAD_TYPE,
    version: WEBUI_FOOTER_PAYLOAD_VERSION,
    generatedAt: Date.now(),
    ...(providerUsage ? { providerUsage } : {}),
    main,
    meta,
    visibility: buildWebuiVisibilityRecord(),
  };
}

export default function gitFooterStatus(pi: ExtensionAPI) {
  let refreshPromise: Promise<void> | null = null;
  let pendingRefreshOptions: GitRefreshOptions | null = null;
  let currentAssistantStartMs: number | null = null;
  let currentAssistantOutputChars = 0;
  let currentAssistantEstimatedOutputTokens = 0;
  let currentAssistantUsageOutputTokens = 0;
  let currentAssistantLiveTokenSpeed: number | null = null;
  let currentAssistantTokenSamples: LiveTokenSample[] = [];
  let latestMeasuredTokenSpeed: number | null = null;
  let sessionSpeedSamples: number[] = [];
  let lastSessionSpeedSampleMs = 0;
  let footerUsageSnapshot: FooterUsageSnapshot = emptyFooterUsageSnapshot();
  let latestProviderUsage: ProviderUsageSnapshot | null = null;
  let latestGitSnapshot: GitSnapshot | null = null;
  let latestGitSnapshotFingerprint: string | null = null;
  let latestGitFetchState: GitFetchState = { status: "idle" };
  let gitInitialFetchPromise: Promise<void> | null = null;
  let activeSessionSerial = 0;
  let latestPromptEstimateContext: ExtensionContext | null = null;
  // Timers and delayed PI-estimate callbacks can outlive the context that created them.
  // Keep the freshest context so idle git auto-refresh does not republish a stale cwd snapshot.
  let latestFooterContext: ExtensionContext | null = null;
  let latestFooterCwd = "";
  let requestFooterRender: (() => void) | null = null;
  let webuiFooterPublishTimer: ReturnType<typeof setTimeout> | null = null;
  let promptEstimateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let footerUsageRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
  let gitAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Non-UI modes (json/print) have no footer consumer; skip all background work.
  let backgroundWorkEnabled = false;
  let lastWebuiFooterPublishMs = 0;
  let accountedAssistantUsageKeys = new Set<string>();
  let promptCalibrationCache: { sessionDir: string; value: ReturnType<typeof collectInitialPromptCalibration>; checkedAt: number } | null = null;

  const getPromptCalibration = (ctx: ExtensionContext) => {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const now = Date.now();
    if (promptCalibrationCache?.sessionDir === sessionDir && now - promptCalibrationCache.checkedAt < 60_000) {
      return promptCalibrationCache.value;
    }
    const value = collectInitialPromptCalibration(sessionDir);
    promptCalibrationCache = { sessionDir, value, checkedAt: now };
    return value;
  };
  const promptEstimateService = createInitialPromptEstimateService({
    pi,
    getCalibration: getPromptCalibration,
    publishFallback: false,
    onUpdate: (_snapshot, ctx) => {
      const footerCtx = rememberFooterContext(ctx);
      requestFooterRender?.();
      publishWebuiFooter(footerCtx);
    },
  });
  let promptEstimateRefreshPromise: Promise<unknown> | null = null;

  const rememberPromptEstimateContext = (ctx: ExtensionContext) => {
    latestPromptEstimateContext = ctx;
  };

  const rememberFooterContext = (ctx: ExtensionContext): ExtensionContext => {
    const cwd = ctx.cwd || "";
    if (latestFooterCwd && cwd && latestFooterCwd !== cwd) {
      latestGitSnapshot = null;
      latestGitSnapshotFingerprint = null;
    }
    latestFooterCwd = cwd;
    latestFooterContext = ctx;
    rememberPromptEstimateContext(ctx);
    return ctx;
  };

  const getFooterContext = (fallback: ExtensionContext): ExtensionContext => latestFooterContext ?? fallback;

  // A captured pi/command ctx becomes stale after ctx.newSession(), ctx.fork(),
  // ctx.switchSession(), or ctx.reload() — which fresh-context subagents (e.g.
  // scout) trigger. Accessing a stale ctx (pi.exec, ctx.ui, ctx.cwd, ...)
  // throws synchronously, which bypasses runGitRead's `.catch(() => undefined)`
  // (the throw happens before a promise exists) and surfaces as an unhandled
  // rejection from the background timers below, killing the subagent process.
  // Detect it so timer/async refresh paths can stop the dead auto-refresh and
  // swallow instead of crashing.
  const isStaleExtensionContextError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("extension ctx is stale");
  };

  /** Returns true when the error was a stale-ctx error and has been handled. */
  const handleStaleExtensionContext = (error: unknown): boolean => {
    if (!isStaleExtensionContextError(error)) return false;
    stopGitAutoRefresh();
    return true;
  };

  /** Terminal handler for background/timer work: never throws, never rejects. */
  const swallowBackgroundError = (error: unknown): void => {
    if (handleStaleExtensionContext(error)) return;
    if (envFlag("PI_GIT_FOOTER_DEBUG", false)) {
      console.error("[git-footer-status] background task failed:", error);
    }
  };

  const mergeRefreshOptions = (current: GitRefreshOptions | null, next: GitRefreshOptions = {}): GitRefreshOptions => {
    const merged: GitRefreshOptions = {};
    if ((current === null || current.publishIfUnchanged === false) && next.publishIfUnchanged === false) merged.publishIfUnchanged = false;
    return merged;
  };

  const getEstimateContext = (fallback: ExtensionContext): ExtensionContext => latestPromptEstimateContext ?? fallback;

  const queuePromptInjectionEstimateRefresh = (ctx: ExtensionContext): Promise<unknown> => {
    if (!PROMPT_ESTIMATE_ENABLED) return Promise.resolve(null);
    const estimateCtx = getEstimateContext(ctx);
    promptEstimateRefreshPromise ??= promptEstimateService.refresh(estimateCtx).finally(() => {
      promptEstimateRefreshPromise = null;
    });
    return promptEstimateRefreshPromise;
  };

  const refreshPromptInjectionEstimate = async (ctx: ExtensionContext) => {
    if (!PROMPT_ESTIMATE_ENABLED) return;
    rememberFooterContext(ctx);
    await queuePromptInjectionEstimateRefresh(ctx);
  };

  const schedulePromptInjectionEstimateRefresh = (ctx: ExtensionContext, delayMs = PROMPT_ESTIMATE_REFRESH_DELAY_MS) => {
    if (!PROMPT_ESTIMATE_ENABLED || promptEstimateRefreshTimer || promptEstimateRefreshPromise) return;
    rememberFooterContext(ctx);
    const scheduledSerial = activeSessionSerial;
    promptEstimateRefreshTimer = setTimeout(() => {
      promptEstimateRefreshTimer = null;
      if (scheduledSerial !== activeSessionSerial) return;
      void refreshPromptInjectionEstimate(getEstimateContext(ctx)).catch(swallowBackgroundError);
    }, Math.max(0, delayMs));
    promptEstimateRefreshTimer.unref?.();
  };

  const getFooterPromptInjectionEstimate = (ctx: ExtensionContext): InitialPromptInputEstimate | null => {
    const snapshot = promptEstimateService.getSnapshot();
    if (!snapshot) schedulePromptInjectionEstimateRefresh(ctx);
    // Do not recompute/validate the estimate key from the render path. The key
    // computation walks system prompt/tool schemas and was the dominant startup
    // cost when the footer rendered before the background estimate settled.
    return snapshot?.estimate ?? null;
  };

  const buildFooterTelemetry = (ctx: ExtensionContext): FooterTelemetry => {
    const {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost,
      historicalTokenSpeed,
    } = footerUsageSnapshot;
    const activeOutputTokens = currentAssistantStartMs !== null ? currentAssistantEstimatedOutputTokens : 0;
    const speedOutputTokens = totalOutput + activeOutputTokens;
    const latestTokenSpeed = currentAssistantLiveTokenSpeed ?? latestMeasuredTokenSpeed ?? historicalTokenSpeed;
    const speedStats = computeSessionSpeedStats(sessionSpeedSamples);

    const promptInjectionEstimate = getFooterPromptInjectionEstimate(ctx);
    const contextUsage = ctx.getContextUsage();
    const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const rawContextPercent = typeof contextUsage?.percent === "number" ? contextUsage.percent : null;
    const contextDisplay = rawContextPercent === null
      ? `?/${formatTokens(contextWindow)}`
      : `${rawContextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;

    return {
      totalInput,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      totalCost,
      speedOutputTokens,
      latestTokenSpeed,
      speedStats,
      promptInjectionTokens: promptInjectionEstimate?.total ?? null,
      promptInjectionCalibrationSamples: promptInjectionEstimate?.calibrationSamples ?? 0,
      contextWindow,
      contextPercent: rawContextPercent,
      contextDisplay,
      modelName: ctx.model?.id || "no-model",
      modelProvider: ctx.model?.provider || null,
      showModelProvider: ctx.model ? true : false,
      thinkingLevel: pi.getThinkingLevel(),
      usingSubscription: ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false,
    };
  };

  const getVisibleProviderUsage = (ctx: ExtensionContext): ProviderUsageSnapshot | null => {
    if (!latestProviderUsage) return null;
    const model = ctx.model;
    if (!model) return null;
    // A snapshot is only valid for the provider it was captured from; a model
    // switch to another provider hides it instead of showing stale data.
    if (latestProviderUsage.provider !== model.provider) return null;
    // Anthropic subscription usage is only meaningful for OAuth/subscription auth.
    if (model.provider === "anthropic" && !ctx.modelRegistry.isUsingOAuth(model)) return null;
    return latestProviderUsage;
  };

  const publishWebuiFooter = (ctx: ExtensionContext, snapshot: GitSnapshot | null = latestGitSnapshot) => {
    try {
      const footerCtx = getFooterContext(ctx);
      lastWebuiFooterPublishMs = Date.now();
      const payload = buildWebuiFooterPayload(footerCtx, snapshot, buildFooterTelemetry(footerCtx), latestGitFetchState, getVisibleProviderUsage(footerCtx));
      footerCtx.ui.setStatus(WEBUI_FOOTER_STATUS_KEY, JSON.stringify(payload));
    } catch (error) {
      swallowBackgroundError(error);
    }
  };

  const scheduleWebuiFooterPublish = (ctx: ExtensionContext, delayMs = 250) => {
    if (webuiFooterPublishTimer) return;
    const elapsedMs = Date.now() - lastWebuiFooterPublishMs;
    const waitMs = Math.max(0, Math.min(delayMs, delayMs - elapsedMs));
    const scheduledSerial = activeSessionSerial;
    webuiFooterPublishTimer = setTimeout(() => {
      webuiFooterPublishTimer = null;
      if (scheduledSerial !== activeSessionSerial) return;
      // Do not capture latestGitSnapshot when scheduling. During streaming,
      // git auto-refresh can publish a newer snapshot before this throttle fires;
      // replaying the old snapshot makes Web UI CHANGES flip back and forth.
      publishWebuiFooter(ctx);
    }, waitMs);
    webuiFooterPublishTimer.unref?.();
  };

  const recomputeFooterUsageSnapshot = (ctx: ExtensionContext): FooterUsageSnapshot => {
    const snapshot = emptyFooterUsageSnapshot();
    const entries = ctx.sessionManager.getEntries();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;

      const message = entry.message as AssistantMessage;
      snapshot.totalInput += message.usage?.input ?? 0;
      snapshot.totalOutput += message.usage?.output ?? 0;
      snapshot.totalCacheRead += message.usage?.cacheRead ?? 0;
      snapshot.totalCacheWrite += message.usage?.cacheWrite ?? 0;
      snapshot.totalCost += message.usage?.cost?.total ?? 0;

      const outputTokens = message.usage?.output ?? 0;
      if (outputTokens <= 0) continue;

      const endMs = getEntryTimestampMs(entry);
      if (endMs === null) continue;

      let fallbackSpeed: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const previous = entries[j];
        if (previous.type !== "message") continue;

        // Skip assistant-to-assistant deltas (too noisy for speed).
        if (previous.message.role === "assistant") continue;

        const startMs = getEntryTimestampMs(previous);
        if (startMs === null || endMs <= startMs) continue;

        const elapsedSeconds = (endMs - startMs) / 1000;
        if (elapsedSeconds <= 0) continue;

        const speed = outputTokens / elapsedSeconds;
        if (!isReasonableTokenSpeed(speed)) continue;

        // Prefer user-anchored speed (best approximation of full turn latency).
        if (previous.message.role === "user") {
          snapshot.historicalTokenSpeed = speed;
          break;
        }

        // Keep first non-assistant speed as fallback if no user message is found.
        if (fallbackSpeed === null) fallbackSpeed = speed;
      }

      if (fallbackSpeed !== null && snapshot.historicalTokenSpeed === null) {
        snapshot.historicalTokenSpeed = fallbackSpeed;
      }
    }

    return snapshot;
  };

  const assistantUsageKey = (message: AssistantMessage): string => {
    return message.responseId || `${message.timestamp}:${message.provider}:${message.model}:${message.usage?.input ?? 0}:${message.usage?.output ?? 0}`;
  };

  const addAssistantUsageToSnapshot = (message: AssistantMessage): boolean => {
    const usage = message.usage;
    if (!usage) return false;
    const hasUsage = Boolean(
      usage.input ||
        usage.output ||
        usage.cacheRead ||
        usage.cacheWrite ||
        usage.cost?.total,
    );
    if (!hasUsage) return false;

    const key = assistantUsageKey(message);
    if (accountedAssistantUsageKeys.has(key)) return false;
    accountedAssistantUsageKeys.add(key);

    footerUsageSnapshot.totalInput += usage.input ?? 0;
    footerUsageSnapshot.totalOutput += usage.output ?? 0;
    footerUsageSnapshot.totalCacheRead += usage.cacheRead ?? 0;
    footerUsageSnapshot.totalCacheWrite += usage.cacheWrite ?? 0;
    footerUsageSnapshot.totalCost += usage.cost?.total ?? 0;
    return true;
  };

  const scheduleFooterUsageRecompute = (ctx: ExtensionContext, delayMs = FOOTER_USAGE_RECOMPUTE_DELAY_MS) => {
    if (footerUsageRecomputeTimer) return;
    rememberFooterContext(ctx);
    const scheduledSerial = activeSessionSerial;
    footerUsageRecomputeTimer = setTimeout(() => {
      footerUsageRecomputeTimer = null;
      if (scheduledSerial !== activeSessionSerial) return;
      try {
        const footerCtx = getFooterContext(ctx);
        footerUsageSnapshot = recomputeFooterUsageSnapshot(footerCtx);
        requestFooterRender?.();
        publishWebuiFooter(footerCtx);
      } catch (error) {
        swallowBackgroundError(error);
      }
    }, Math.max(0, delayMs));
    footerUsageRecomputeTimer.unref?.();
  };

  const recordAssistantSpeed = (message: AssistantMessage, endMs = Date.now()): boolean => {
    const outputTokens = message.usage?.output ?? 0;
    if (!outputTokens || currentAssistantStartMs === null || endMs <= currentAssistantStartMs) return false;

    const elapsedSeconds = (endMs - currentAssistantStartMs) / 1000;
    // Filter out impossible values caused by duplicate/misordered lifecycle events.
    if (elapsedSeconds < 0.05 || elapsedSeconds > 60 * 60) return false;

    const speed = outputTokens / elapsedSeconds;
    if (!isReasonableTokenSpeed(speed)) return false;

    latestMeasuredTokenSpeed = speed;
    return true;
  };

  const getRollingLiveTokenSpeed = (nowMs = Date.now()): number | null => {
    const cutoffMs = nowMs - LIVE_TOKEN_SPEED_ROLLING_WINDOW_MS;
    currentAssistantTokenSamples = currentAssistantTokenSamples.filter((sample) => sample.timestampMs >= cutoffMs);

    if (currentAssistantTokenSamples.length === 0) return null;

    const firstSampleMs = currentAssistantTokenSamples[0]?.timestampMs ?? nowMs;
    const windowStartMs = Math.max(currentAssistantStartMs ?? firstSampleMs, cutoffMs);
    const elapsedSeconds = (nowMs - windowStartMs) / 1000;
    if (elapsedSeconds <= 0) return null;

    const tokens = currentAssistantTokenSamples.reduce((sum, sample) => sum + sample.tokens, 0);
    const speed = tokens / elapsedSeconds;
    return isReasonableTokenSpeed(speed) ? speed : null;
  };

  const preserveLiveAssistantSpeed = () => {
    if (currentAssistantLiveTokenSpeed !== null) {
      latestMeasuredTokenSpeed = currentAssistantLiveTokenSpeed;
    }
  };

  const resetLiveAssistantState = () => {
    currentAssistantStartMs = null;
    currentAssistantOutputChars = 0;
    currentAssistantEstimatedOutputTokens = 0;
    currentAssistantUsageOutputTokens = 0;
    currentAssistantLiveTokenSpeed = null;
    currentAssistantTokenSamples = [];
  };

  const refreshOnce = async (ctx: ExtensionContext, options: GitRefreshOptions = {}) => {
    await reloadPersistedFooterVisibility();
    const footerCtx = rememberFooterContext(ctx);
    const refreshCwd = footerCtx.cwd || "";
    const snapshot = await readGitSnapshot(pi, refreshCwd);
    if (latestFooterCwd && refreshCwd && latestFooterCwd !== refreshCwd) return;

    const fingerprint = gitSnapshotFingerprint(snapshot);
    const changed = fingerprint !== latestGitSnapshotFingerprint;
    latestGitSnapshot = snapshot;
    latestGitSnapshotFingerprint = fingerprint;
    if (!changed && options.publishIfUnchanged === false) return;

    if (!snapshot) {
      footerCtx.ui.setStatus(GIT_FOOTER_STATUS_KEY, undefined);
      publishWebuiFooter(footerCtx, null);
      return;
    }

    footerCtx.ui.setStatus(GIT_FOOTER_STATUS_KEY, buildStatusText(footerCtx, snapshot));
    publishWebuiFooter(footerCtx, snapshot);
  };

  const refresh = async (ctx: ExtensionContext, options: GitRefreshOptions = {}) => {
    // A stale ctx throws synchronously from ctx.cwd here; because refresh is
    // async, that throw would reject the returned promise before the guarded
    // IIFE below is reachable, and fire-and-forget callers discard the promise.
    try {
      rememberFooterContext(ctx);
    } catch (error) {
      swallowBackgroundError(error);
      return;
    }
    pendingRefreshOptions = mergeRefreshOptions(pendingRefreshOptions, options);
    refreshPromise ??= (async () => {
      try {
        while (pendingRefreshOptions) {
          const nextOptions = pendingRefreshOptions;
          pendingRefreshOptions = null;
          await refreshOnce(getFooterContext(ctx), nextOptions);
        }
      } catch (error) {
        // readGitSnapshot -> pi.exec throws "extension ctx is stale"
        // synchronously when the session that scheduled this auto-refresh was
        // replaced/reloaded. Stop the timer so we stop poking the dead ctx;
        // the next session_start restarts it with a fresh ctx.
        swallowBackgroundError(error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const stopGitAutoRefresh = () => {
    if (!gitAutoRefreshTimer) return;
    clearInterval(gitAutoRefreshTimer);
    gitAutoRefreshTimer = null;
  };

  const startGitAutoRefresh = (ctx: ExtensionContext) => {
    rememberFooterContext(ctx);
    stopGitAutoRefresh();
    if (GIT_AUTO_REFRESH_INTERVAL_MS <= 0) return;
    const scheduledSerial = activeSessionSerial;
    gitAutoRefreshTimer = setInterval(() => {
      if (scheduledSerial !== activeSessionSerial) return;
      void refresh(getFooterContext(ctx), { publishIfUnchanged: false }).catch(swallowBackgroundError);
    }, GIT_AUTO_REFRESH_INTERVAL_MS);
    gitAutoRefreshTimer.unref?.();
  };

  const runInitialGitFetch = async (ctx: ExtensionContext, sessionSerial: number) => {
    if (!GIT_INITIAL_FETCH_ENABLED) {
      latestGitFetchState = { status: "skipped", message: "startup fetch disabled by PI_GIT_FOOTER_FETCH=0" };
      return;
    }
    if (gitInitialFetchPromise || !latestGitSnapshot) return;

    const remotes = await runGitRead(pi, ctx.cwd, ["remote"], 2000);
    if (sessionSerial !== activeSessionSerial || !remotes) return;

    latestGitFetchState = { status: "fetching", startedAt: Date.now(), message: "git fetch" };
    publishWebuiFooter(ctx);
    requestFooterRender?.();

    gitInitialFetchPromise = pi
      .exec("git", ["-c", "credential.interactive=false", "fetch", "--prune"], { cwd: ctx.cwd, timeout: GIT_INITIAL_FETCH_TIMEOUT_MS })
      .then((result) => {
        if (sessionSerial !== activeSessionSerial) return;
        latestGitFetchState = {
          status: result.code === 0 ? "ok" : "error",
          startedAt: latestGitFetchState.startedAt,
          completedAt: Date.now(),
          message: gitFetchResultMessage(result),
        };
      })
      .catch((error) => {
        if (sessionSerial !== activeSessionSerial) return;
        latestGitFetchState = {
          status: "error",
          startedAt: latestGitFetchState.startedAt,
          completedAt: Date.now(),
          message: compactFetchMessage(error instanceof Error ? error.message : String(error)),
        };
      })
      .finally(() => {
        if (sessionSerial !== activeSessionSerial) return;
        gitInitialFetchPromise = null;
        void refresh(ctx).catch(swallowBackgroundError);
        requestFooterRender?.();
      });

    await gitInitialFetchPromise;
  };

  pi.on("session_start", async (event, ctx) => {
    if (
      ctx.hasUI && (event.reason === "startup" || event.reason === "new") &&
      ctx.model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(ctx.model)
    ) {
      try {
        // ExtensionContext exposes no live transport setting; use Pi's saved
        // settings reader so defaults, agent directory, and project trust agree.
        const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
        const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
        if (settings.drainErrors().length === 0 && settings.getTransport() === "auto") {
          ctx.ui.notify(
            "Codex subscription detected with Auto transport. To show weekly usage in the footer, select SSE transport in /settings, then send a model request.",
            "warning",
          );
        }
      } catch {
        // An advisory settings check must not prevent the footer from starting.
      }
    }
    await reloadPersistedFooterVisibility();
    backgroundWorkEnabled = ctx.hasUI;
    if (!backgroundWorkEnabled) return;
    const sessionSerial = ++activeSessionSerial;
    gitInitialFetchPromise = null;
    latestGitFetchState = { status: "idle" };
    promptEstimateService.clear();
    latestPromptEstimateContext = null;
    latestFooterContext = ctx;
    latestFooterCwd = ctx.cwd || "";
    latestGitSnapshot = null;
    latestGitSnapshotFingerprint = null;
    footerUsageSnapshot = emptyFooterUsageSnapshot();
    latestProviderUsage = null;
    accountedAssistantUsageKeys = new Set<string>();
    sessionSpeedSamples = [];
    lastSessionSpeedSampleMs = 0;
    promptCalibrationCache = null;
    stopGitAutoRefresh();
    scheduleFooterUsageRecompute(ctx);
    schedulePromptInjectionEstimateRefresh(ctx);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const render = () => tui.requestRender();
      requestFooterRender = render;
      const unsub = footerData.onBranchChange(render);

      return {
        dispose() {
          unsub();
          if (requestFooterRender === render) requestFooterRender = null;
        },
        invalidate() {},
        render(width: number): string[] {
          const footerCtx = getFooterContext(ctx);
          const telemetry = buildFooterTelemetry(footerCtx);
          const contextPercentValue = telemetry.contextPercent ?? 0;

          let contextPercentStr: string;
          if (telemetry.contextPercent === null) {
            contextPercentStr = theme.fg("dim", telemetry.contextDisplay);
          } else if (contextPercentValue < 50) {
            contextPercentStr = theme.fg("success", telemetry.contextDisplay);
          } else if (contextPercentValue < 65) {
            contextPercentStr = theme.fg("accent", telemetry.contextDisplay);
          } else if (contextPercentValue < 75) {
            contextPercentStr = theme.fg("muted", telemetry.contextDisplay);
          } else if (contextPercentValue < 85) {
            contextPercentStr = theme.fg("warning", telemetry.contextDisplay);
          } else {
            contextPercentStr = theme.fg("error", telemetry.contextDisplay);
          }

          const sectionSep = theme.fg("dim", "│");
          const itemSep = theme.fg("dim", "·");

          const ioItems: string[] = [];
          if (nativeFooterItemVisible("tokens")) {
            if (telemetry.totalInput) ioItems.push(`↑${formatTokens(telemetry.totalInput)}`);
            if (telemetry.totalOutput) ioItems.push(`↓${formatTokens(telemetry.totalOutput)}`);
          }

          const cacheItems: string[] = [];
          if (nativeFooterItemVisible("cache") && (telemetry.totalCacheRead || telemetry.totalCacheWrite)) {
            cacheItems.push(`R${formatTokens(telemetry.totalCacheRead)}`, `W${formatTokens(telemetry.totalCacheWrite)}`);
          }

          const segments: string[] = [];
          if (ioItems.length > 0) segments.push(`${theme.fg("muted", "🪙")} ${ioItems.join(` ${itemSep} `)}`);
          if (cacheItems.length > 0) segments.push(`${theme.fg("muted", "💾")} ${cacheItems.join(` ${itemSep} `)}`);
          if (nativeFooterItemVisible("pi")) segments.push(telemetry.promptInjectionTokens === null ? "PI: …" : `PI: ${formatTokens(telemetry.promptInjectionTokens)} tok`);
          if (nativeFooterItemVisible("speed")) {
            const speedValue = telemetry.latestTokenSpeed === null
              ? "— tok/s"
              : `${formatTokenSpeed(telemetry.latestTokenSpeed)} tok/s`;
            const stats = telemetry.speedStats;
            const statParts: string[] = [];
            if (stats) {
              if (nativeFooterItemVisible("speed-avg")) statParts.push(`avg ${formatTokenSpeed(stats.avg)}`);
              if (nativeFooterItemVisible("speed-low")) statParts.push(`1% ${formatTokenSpeed(stats.onePercentLow)}`);
              if (nativeFooterItemVisible("speed-max")) statParts.push(`max ${formatTokenSpeed(stats.max)}`);
            }
            const statsSuffix = statParts.length > 0 ? ` ${itemSep} ${statParts.join(` ${itemSep} `)}` : "";
            segments.push(`⚡ ${formatTokens(telemetry.speedOutputTokens)} tok @ ${speedValue}${statsSuffix}`);
          }

          if (nativeFooterItemVisible("cost") && (telemetry.totalCost || telemetry.usingSubscription)) {
            segments.push(`${theme.fg("muted", "💸")} $${telemetry.totalCost.toFixed(3)}${telemetry.usingSubscription ? " (sub)" : ""}`);
          }

          if (nativeFooterItemVisible("context")) segments.push(`${theme.fg("muted", "🧠")} ${contextPercentStr}`);

          const providerUsage = getVisibleProviderUsage(footerCtx);
          if (nativeFooterItemVisible("usage") && providerUsage) {
            segments.push(`${theme.fg("muted", "📊")} ${formatProviderUsage(providerUsage)}`);
          }

          let statsLeft = segments.join(` ${sectionSep} `);
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const thinkingText = footerCtx.model?.reasoning && nativeFooterItemVisible("thinking")
            ? telemetry.thinkingLevel === "off"
              ? "thinking off"
              : telemetry.thinkingLevel
            : "";
          const rightSideWithoutProvider = nativeFooterItemVisible("model")
            ? [telemetry.modelName, thinkingText].filter(Boolean).join(" • ")
            : thinkingText;

          let rightSide = rightSideWithoutProvider;
          if (rightSide && footerData.getAvailableProviderCount() > 1 && telemetry.modelProvider && nativeFooterItemVisible("model")) {
            const withProvider = `(${telemetry.modelProvider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
              rightSide = withProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);
          const gapWidth = statsLeftWidth > 0 && rightSideWidth > 0 ? 2 : 0;
          const totalNeeded = statsLeftWidth + gapWidth + rightSideWidth;
          let tokenLine: string;

          if (totalNeeded <= width) {
            const padding = " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth));
            tokenLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - gapWidth;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              const truncatedRightWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
              tokenLine = statsLeft + padding + truncatedRight;
            } else {
              tokenLine = statsLeft;
            }
          }

          const branch = nativeFooterItemVisible("cwd-branch") ? footerData.getGitBranch() : null;
          const cwdWithBranch = `${formatCwd(footerCtx.cwd)}${branch ? ` (${branch})` : ""}`;
          const cwdText = nativeFooterItemVisible("cwd") ? theme.fg("muted", cwdWithBranch) : "";

          const statuses = footerData.getExtensionStatuses();
          const gitStatus = nativeFooterItemVisible("git-status") ? statuses.get(GIT_FOOTER_STATUS_KEY) : undefined;
          const otherStatuses = nativeFooterItemVisible("extension-statuses")
            ? Array.from(statuses.entries())
                .filter(([key, value]) =>
                  key !== GIT_FOOTER_STATUS_KEY &&
                  key !== WEBUI_FOOTER_STATUS_KEY &&
                  key !== CD_HISTORY_STATUS_KEY &&
                  Boolean(value),
                )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => key === "codex-fast-mode" && (value === "on" || value === "off")
                  ? `Codex fast: ${value}`
                  : value as string)
            : [];

          const combinedStatusParts = [gitStatus, ...otherStatuses].filter(Boolean) as string[];
          const combinedStatus = combinedStatusParts.join(` ${theme.fg("dim", "·")} `);
          const pathGitLine = cwdText && combinedStatus ? `${cwdText}${theme.fg("dim", " │ ")}${combinedStatus}` : cwdText || combinedStatus;

          // Keep default subtle-grey look even when parts contain their own ANSI colors.
          // Wrapping the whole line once is not enough because inner color resets cancel outer dim.
          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = tokenLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);

          return [truncateToWidth(dimStatsLeft + dimRemainder, width), truncateToWidth(pathGitLine, width)];
        },
      };
    });

    void refresh(ctx)
      .then(() => runInitialGitFetch(ctx, sessionSerial))
      .catch(swallowBackgroundError);
    startGitAutoRefresh(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!backgroundWorkEnabled) return;
    schedulePromptInjectionEstimateRefresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    preserveLiveAssistantSpeed();
    resetLiveAssistantState();
    requestFooterRender?.();
    schedulePromptInjectionEstimateRefresh(ctx);
    void refresh(ctx).catch(swallowBackgroundError);
  });

  pi.on("message_start", (event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role === "assistant") {
      currentAssistantStartMs = Date.now();
      currentAssistantOutputChars = 0;
      currentAssistantEstimatedOutputTokens = 0;
      currentAssistantUsageOutputTokens = 0;
      currentAssistantLiveTokenSpeed = null;
      currentAssistantTokenSamples = [];
      publishWebuiFooter(ctx);
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role !== "assistant" || currentAssistantStartMs === null) return;

    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta" &&
      streamEvent.type !== "toolcall_delta"
    ) {
      return;
    }

    const nowMs = Date.now();
    currentAssistantOutputChars += streamEvent.delta.length;

    const usageOutputTokens = streamEvent.partial.usage?.output;
    let newTokens = 0;
    if (typeof usageOutputTokens === "number" && usageOutputTokens > currentAssistantUsageOutputTokens) {
      newTokens = usageOutputTokens - currentAssistantUsageOutputTokens;
      currentAssistantUsageOutputTokens = usageOutputTokens;
      currentAssistantEstimatedOutputTokens = usageOutputTokens;
    } else if (currentAssistantUsageOutputTokens <= 0) {
      const estimatedOutputTokens = estimateTokensFromCharCount(currentAssistantOutputChars);
      newTokens = Math.max(0, estimatedOutputTokens - currentAssistantEstimatedOutputTokens);
      currentAssistantEstimatedOutputTokens = estimatedOutputTokens;
    }

    if (newTokens > 0) {
      currentAssistantTokenSamples.push({ timestampMs: nowMs, tokens: newTokens });
    }

    currentAssistantLiveTokenSpeed = getRollingLiveTokenSpeed(nowMs);
    if (
      currentAssistantLiveTokenSpeed !== null &&
      nowMs - lastSessionSpeedSampleMs >= SESSION_SPEED_SAMPLE_MIN_INTERVAL_MS
    ) {
      lastSessionSpeedSampleMs = nowMs;
      sessionSpeedSamples.push(currentAssistantLiveTokenSpeed);
      if (sessionSpeedSamples.length > SESSION_SPEED_SAMPLE_LIMIT) {
        sessionSpeedSamples.splice(0, sessionSpeedSamples.length - SESSION_SPEED_SAMPLE_LIMIT);
      }
    }
    preserveLiveAssistantSpeed();
    scheduleWebuiFooterPublish(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    if (event.message.role === "assistant") {
      const assistantMessage = event.message as AssistantMessage;
      addAssistantUsageToSnapshot(assistantMessage);
      preserveLiveAssistantSpeed();
      recordAssistantSpeed(assistantMessage);
      resetLiveAssistantState();
      publishWebuiFooter(ctx);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    // Safety net for runtimes where message_end fires before usage is populated.
    if (event.message.role === "assistant") {
      const assistantMessage = event.message as AssistantMessage;
      addAssistantUsageToSnapshot(assistantMessage);
      preserveLiveAssistantSpeed();
      recordAssistantSpeed(assistantMessage);
      resetLiveAssistantState();
    }
    requestFooterRender?.();
    schedulePromptInjectionEstimateRefresh(ctx);
    void refresh(ctx).catch(swallowBackgroundError);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    const footerCtx = getFooterContext(ctx);
    const model = footerCtx.model;
    const provider = model?.provider;
    // Passive last-seen capture only: supported providers overwrite the
    // snapshot (or clear it on absent/malformed headers so we never show
    // guessed data); other providers leave it untouched and render gating
    // keeps it hidden.
    if (provider === "openai-codex") {
      const usage = parseCodexProviderUsage(event.headers);
      latestProviderUsage = usage ? { ...usage, capturedAt: Date.now() } : null;
    } else if (provider === "anthropic" && model && footerCtx.modelRegistry.isUsingOAuth(model)) {
      const usage = parseAnthropicProviderUsage(event.headers);
      latestProviderUsage = usage ? { ...usage, capturedAt: Date.now() } : null;
    } else {
      return;
    }
    requestFooterRender?.();
    publishWebuiFooter(footerCtx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (!backgroundWorkEnabled) return;
    rememberFooterContext(ctx);
    // Model switches re-evaluate provider/auth gating; incompatible snapshots
    // are hidden by getVisibleProviderUsage without a new provider response.
    requestFooterRender?.();
    publishWebuiFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    backgroundWorkEnabled = false;
    activeSessionSerial += 1;
    gitInitialFetchPromise = null;
    latestGitFetchState = { status: "idle" };
    stopGitAutoRefresh();
    if (webuiFooterPublishTimer) {
      clearTimeout(webuiFooterPublishTimer);
      webuiFooterPublishTimer = null;
    }
    if (promptEstimateRefreshTimer) {
      clearTimeout(promptEstimateRefreshTimer);
      promptEstimateRefreshTimer = null;
    }
    if (footerUsageRecomputeTimer) {
      clearTimeout(footerUsageRecomputeTimer);
      footerUsageRecomputeTimer = null;
    }
    latestGitSnapshotFingerprint = null;
    latestFooterContext = null;
    latestFooterCwd = "";
    try {
      ctx.ui.setStatus(GIT_FOOTER_STATUS_KEY, undefined);
      ctx.ui.setStatus(WEBUI_FOOTER_STATUS_KEY, undefined);
      ctx.ui.setFooter(undefined);
    } catch (error) {
      // Shutdown can race context invalidation.
      swallowBackgroundError(error);
    }
  });

  pi.registerCommand("git-footer-refresh", {
    description: "Refresh git footer information",
    handler: async (args, ctx) => {
      try {
        const silent = /(?:^|\s)--webui-silent(?:\s|$)/.test(args || "");
        rememberFooterContext(ctx);
        // Calibration records are shared across workspace sessions. An explicit
        // refresh must bypass the 60-second cache so newly recorded samples are visible.
        promptCalibrationCache = null;
        await refreshPromptInjectionEstimate(ctx);
        await refresh(ctx);
        if (!silent) ctx.ui.notify("Git footer refreshed", "info");
      } catch (error) {
        // The WebUI can already have this command in flight when /new replaces
        // the session. There is no replacement ctx in this old command frame,
        // so stop its background polling and let the fresh session_start
        // publish the new footer instead of surfacing an extension error.
        if (handleStaleExtensionContext(error)) return;
        throw error;
      }
    },
  });

  pi.registerCommand("git-footer-visibility", {
    description: "Show/hide individual git footer cards, buttons, and modal affordances for native TUI and WebUI",
    handler: async (args, ctx) => {
      rememberFooterContext(ctx);
      await reloadPersistedFooterVisibility();
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const firstToken = tokens.shift();
      const command = normalizeFooterVisibilityToken(firstToken || "");

      const openSelector = async (scope: FooterVisibilityScope) => {
        const selected = await openFooterVisibilitySelector(ctx, scope);
        if (!selected) {
          ctx.ui.notify("Git footer visibility selector cancelled.", "info");
          return;
        }
        const changedCount = applyFooterVisibilitySelection(scope, selected);
        await persistFooterVisibility();
        requestFooterRender?.();
        publishWebuiFooter(ctx);
        await refresh(ctx);
        ctx.ui.notify(
          `Git footer visibility selector saved globally for ${footerVisibilityScopeLabel(scope)} (${changedCount} changed).`,
          changedCount > 0 ? "success" : "info",
        );
      };

      if (!firstToken && ctx.mode === "tui") {
        await openSelector("all");
        return;
      }

      if (command === "select" || command === "selector" || command === "tui" || command === "ui") {
        if (tokens.length > 1 || (tokens.length === 1 && !normalizeFooterVisibilityScope(tokens[0]))) {
          ctx.ui.notify(footerVisibilityUsage(), "warning");
          return;
        }
        await openSelector(normalizeFooterVisibilityScope(tokens[0]) ?? "all");
        return;
      }

      const scopeOnlyCommand = normalizeFooterVisibilityScope(command);
      if (scopeOnlyCommand && tokens.length === 0 && ctx.mode === "tui") {
        await openSelector(scopeOnlyCommand);
        return;
      }

      if (command === "help" || command === "--help" || command === "-h") {
        ctx.ui.notify(footerVisibilityUsage(), "info");
        return;
      }

      if (command === "keys" || command === "list") {
        ctx.ui.notify(`Git footer visibility keys:\n${FOOTER_VISIBILITY_KEYS.join("\n")}`, "info");
        return;
      }

      if (command === "status" || command === "") {
        ctx.ui.notify(`Git footer visibility (* differs from default):\n${FOOTER_VISIBILITY_KEYS.map(formatFooterVisibilityState).join("\n")}`, "info");
        return;
      }

      if (!["show", "hide", "toggle", "reset"].includes(command)) {
        ctx.ui.notify(footerVisibilityUsage(), "warning");
        return;
      }

      let scope = normalizeFooterVisibilityScope(tokens[0]) ?? "all";
      if (normalizeFooterVisibilityScope(tokens[0])) tokens.shift();

      const keys = tokens.map(normalizeFooterVisibilityKey);
      const invalidKeys = tokens.filter((token, index) => !keys[index]);
      const validKeys = keys.filter((key): key is FooterVisibilityKey => Boolean(key));
      if (invalidKeys.length > 0) {
        ctx.ui.notify(`Unknown git footer visibility key(s): ${invalidKeys.join(", ")}\n\n${footerVisibilityUsage()}`, "warning");
        return;
      }

      if (command === "reset") {
        const resetScopes = scope === "all" ? FOOTER_VISIBILITY_SCOPES : [scope];
        for (const resetScope of resetScopes) {
          if (validKeys.length === 0) clearRuntimeFooterVisibility(resetScope);
          else for (const key of validKeys) clearRuntimeFooterVisibility(resetScope, key);
        }
      } else {
        if (validKeys.length === 0) {
          ctx.ui.notify(footerVisibilityUsage(), "warning");
          return;
        }
        for (const key of validKeys) {
          const nextVisible = command === "show"
            ? true
            : command === "hide"
              ? false
              : scope === "all"
                ? !(nativeFooterItemVisible(key) && webuiFooterItemVisible(key))
                : !footerItemVisible(key, scope);
          const updateScopes = scope === "all" ? FOOTER_VISIBILITY_SCOPES : [scope];
          for (const updateScope of updateScopes) setRuntimeFooterVisibility(updateScope, key, nextVisible);
        }
      }

      await persistFooterVisibility();
      requestFooterRender?.();
      publishWebuiFooter(ctx);
      await refresh(ctx);
      const changed = validKeys.length > 0 ? validKeys.map(formatFooterVisibilityState).join("\n") : `${scope}: reset`;
      ctx.ui.notify(`Git footer visibility saved globally:\n${changed}`, "success");
    },
  });

  pi.registerCommand("git-footer-pi-debug", {
    description: "Show git footer PI initial prompt estimate diagnostics.",
    handler: async (_args, ctx) => {
      rememberFooterContext(ctx);
      const cachedBefore = promptEstimateService.getSnapshot();
      const fallbackNow = promptEstimateService.getFallbackSnapshot(ctx);
      const freshSharedEstimate = await estimateStableInitialPromptFromPiContext(pi, ctx, getPromptCalibration);
      const refreshResult = await promptEstimateService.refresh(ctx);
      const cachedAfter = promptEstimateService.getSnapshot();
      const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
      const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";

      ctx.ui.notify(
        [
          "Git footer PI estimate debug",
          `model: ${modelLabel}`,
          `session: ${sessionId}`,
          `service refresh: ${refreshResult.status}`,
          "",
          ...formatPromptEstimateDebugSnapshot("footer cached before", cachedBefore),
          "",
          ...formatPromptEstimateDebugSnapshot("live fallback now", fallbackNow),
          "",
          ...formatPromptEstimateDebugSnapshot("fresh shared estimate", freshSharedEstimate),
          "",
          ...formatPromptEstimateDebugSnapshot("footer cached after", cachedAfter),
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerShortcut("ctrl+alt+g", {
    description: "Show git signing mismatch diagnostics",
    handler: async (ctx) => {
      rememberFooterContext(ctx);
      const diagnostics = await getSigningDiagnostics(pi, ctx.cwd);
      if (!diagnostics.commitSignRequired) {
        ctx.ui.notify("Signing mismatch: commit.gpgsign is OFF", "info");
        return;
      }

      if (!["N", "E"].includes(diagnostics.signState)) {
        ctx.ui.notify("Signing mismatch: not currently triggered", "info");
        return;
      }

      ctx.ui.notify(
        `Signing mismatch details: commit.gpgsign=ON, last-sign-state=${diagnostics.signState}, gpg.format=${diagnostics.gpgFormat}, user.signingkey=${diagnostics.signingKey}`,
        "warning",
      );
    },
  });
}
