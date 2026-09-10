import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
  SAFETY_GUARD_CATEGORIES,
  SAFETY_GUARD_CONTEXT_LINES_MAX,
  SAFETY_GUARD_CONTEXT_LINES_MIN,
  assertSafetyGuardConfigPatch,
  defaultSafetyGuardConfig,
  normalizeSafetyGuardConfig,
  readSafetyGuardConfig,
  safetyGuardConfigFile,
  safetyGuardConfigSummary,
  writeSafetyGuardConfig,
} from "./src/config.mjs";
import type { SafetyGuardCategory, SafetyGuardConfig, SafetyGuardConfigPatch } from "./src/config.mjs";
import {
  requestAutoReview,
  AUTO_REVIEW_INPUT_MAX_CHARS,
  supportedAutoReviewThinkingLevels,
  type AutoReviewRequest,
} from "./src/auto-review.ts";
import { matchingCommandExcerpt } from "./src/excerpt.ts";
import { bashRuleGrant, ruleAllowKey, operationRule, operationAllowKey, globalOperationAllowKey, operationRuleAllowKey, type BashRuleGrant } from "./src/approvals.ts";
import { ApprovalPersistence, allowKey, normalizeCwd, projectApprovalFile, type AllowEntry, type AllowStore } from "./src/approval-store.ts";
import { SessionApprovals } from "./src/session-approvals.ts";
import { analyzeShell, type ShellAnalysis } from "./src/shell-analysis.ts";
import { buildBashPrompt, type BashChoice } from "./src/bash-prompt.ts";
import { showBashPrompt } from "./src/bash-dialog.ts";
import { operationMatchRange, patternMatchRange, type CommandTrigger } from "./src/trigger.ts";

const STATUS_KEY = "safety-guard";
const AUTO_REVIEW_STATUS_KEY = "safety-guard-auto-review";
const AUTO_REVIEW_WIDGET_KEY = "safety-guard-auto-review";
const PROMPT_WIDGET_KEY = "safety-guard-prompt";

type RiskLevel = "prompt" | "strong-confirm" | "block-noninteractive";
type RuleCategory = SafetyGuardCategory;

type CommandRule = {
  pattern: RegExp;
  label: string;
  category: RuleCategory;
  level: RiskLevel;
};

type AllowScope = "session" | "permanent";
type AllowDecision = { block: true; reason: string } | { allow: true; scope?: AllowScope } | undefined;
const ALLOW_STORE_PATH = path.join(getAgentDir(), "safety-guard-allow.json");
const CATEGORY_LABELS: Record<RuleCategory, string> = {
  git: "Git history and destructive operations",
  filesystem: "Filesystem deletion and overwrite",
  docker: "Docker and Podman destruction",
  package: "Package removal",
  system: "System state and permissions",
  database: "Dangerous SQL",
  secrets: "Secret file access",
};
const CONTEXT_LINE_VALUES = Array.from(
  { length: SAFETY_GUARD_CONTEXT_LINES_MAX - SAFETY_GUARD_CONTEXT_LINES_MIN + 1 },
  (_, index) => String(index + SAFETY_GUARD_CONTEXT_LINES_MIN),
);

const GIT_RULES: CommandRule[] = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard", category: "git", level: "block-noninteractive" },
  { pattern: /\bgit\s+reset\s+(?:--soft|--mixed|--merge|--keep)\b/i, label: "git reset history rewrite", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+reset\s+(?:HEAD[~^]|[a-f0-9]{7,40}\b)/i, label: "git reset to revision", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+clean\b[^\n;&|]*\s-[^\s;&|]*f/i, label: "git clean -f", category: "git", level: "block-noninteractive" },
  { pattern: /\bgit\s+checkout\s+--\s+/i, label: "git checkout -- <path>", category: "git", level: "prompt" },
  { pattern: /\bgit\s+switch\b/i, label: "git switch", category: "git", level: "prompt" },
  { pattern: /\bgit\s+restore\b/i, label: "git restore", category: "git", level: "prompt" },
  { pattern: /\bgit\s+branch\s+-(?:d|D)\b/i, label: "git branch delete", category: "git", level: "prompt" },
  { pattern: /\bgit\s+tag\s+-d\b/i, label: "git tag delete", category: "git", level: "prompt" },
  { pattern: /\bgit\s+push\b[^\n;&|]*--force(?:-with-lease)?\b/i, label: "git push --force", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+push\b[^\n;&|]*(?:--delete|:refs\/heads\/)/i, label: "git push delete branch", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+rebase\b/i, label: "git rebase", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+filter-(?:branch|repo)\b/i, label: "git history filtering", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+commit\b[^\n;&|]*--amend\b/i, label: "git commit --amend", category: "git", level: "prompt" },
  { pattern: /\bgit\s+commit\b[^\n;&|]*--(?:fixup|squash)\b/i, label: "git commit fixup/squash", category: "git", level: "prompt" },
  { pattern: /\bgit\s+replace\b/i, label: "git replace", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+notes\s+(?:remove|prune)\b/i, label: "git notes remove/prune", category: "git", level: "prompt" },
  { pattern: /\bgit\s+update-ref\b/i, label: "git update-ref", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+reflog\s+expire\b/i, label: "git reflog expire", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+gc\b[^\n;&|]*--prune(?:=|\s+)?(?:now|all)?\b/i, label: "git gc --prune", category: "git", level: "strong-confirm" },
  { pattern: /\bgit\s+prune\b/i, label: "git prune", category: "git", level: "strong-confirm" },
];

const FILESYSTEM_RULES: CommandRule[] = [
  { pattern: /(^|[^\w-])rm\s+[^\n;&|]*-[^\s;&|]*r[^\s;&|]*f?\b/i, label: "recursive rm", category: "filesystem", level: "prompt" },
  { pattern: /(^|[^\w-])rm\s+[^\n;&|]*-[^\s;&|]*f[^\s;&|]*r\b/i, label: "recursive force rm", category: "filesystem", level: "prompt" },
  { pattern: /(^|[^\w-])rm\s+[^\n;&|]*(?:-[^\s;&|]*(?:r|f)[^\s;&|]*(?:r|f)[^\s;&|]*\s+)?(?:\/|~|\$HOME|\.)(?:\s|$|[;&|])/i, label: "rm targeting root/home/current directory", category: "filesystem", level: "block-noninteractive" },
  { pattern: /(^|[^\w-])rm\s+[^\n;&|]*\*/i, label: "rm with glob", category: "filesystem", level: "prompt" },
  { pattern: /\bfind\b[^\n;&|]*\s-delete\b/i, label: "find -delete", category: "filesystem", level: "prompt" },
  { pattern: /\bfind\b[^\n;&|]*\s-exec\s+rm\b/i, label: "find -exec rm", category: "filesystem", level: "prompt" },
  { pattern: /\bxargs\b[^\n;&|]*\brm\b/i, label: "xargs rm", category: "filesystem", level: "prompt" },
  { pattern: /\btruncate\s+-s\s+0\b/i, label: "truncate file to zero", category: "filesystem", level: "prompt" },
  { pattern: /\bshred\b/i, label: "shred", category: "filesystem", level: "strong-confirm" },
  { pattern: /\bdd\b[^\n;&|]*\bof=\/dev\//i, label: "dd to block device", category: "filesystem", level: "block-noninteractive" },
  { pattern: /\bdd\b/i, label: "dd", category: "filesystem", level: "prompt" },
  { pattern: /\bmkfs(?:\.|\b)/i, label: "mkfs", category: "filesystem", level: "block-noninteractive" },
  { pattern: /\b(?:wipefs|parted|fdisk|sfdisk|sgdisk)\b/i, label: "disk partition/filesystem tool", category: "filesystem", level: "block-noninteractive" },
];

const DOCKER_RULES: CommandRule[] = [
  { pattern: /\bdocker\s+(?:rm|rmi)\b/i, label: "docker remove", category: "docker", level: "prompt" },
  { pattern: /\bdocker\s+volume\s+(?:rm|prune)\b/i, label: "docker volume removal/prune", category: "docker", level: "block-noninteractive" },
  { pattern: /\bdocker\s+system\s+prune\b/i, label: "docker system prune", category: "docker", level: "strong-confirm" },
  { pattern: /\bdocker\s+compose\s+down\b[^\n;&|]*(?:-v|--volumes)\b/i, label: "docker compose down --volumes", category: "docker", level: "block-noninteractive" },
  { pattern: /\bdocker-compose\s+down\b[^\n;&|]*(?:-v|--volumes)\b/i, label: "docker-compose down --volumes", category: "docker", level: "block-noninteractive" },
  { pattern: /\bpodman\s+(?:rm|rmi)\b/i, label: "podman remove", category: "docker", level: "prompt" },
  { pattern: /\bpodman\s+system\s+prune\b/i, label: "podman system prune", category: "docker", level: "strong-confirm" },
];

const PACKAGE_MANAGER_RULES: CommandRule[] = [
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|prune|autoclean)\b/i, label: "JS package removal", category: "package", level: "prompt" },
  { pattern: /\b(?:pip|uv|cargo)\s+(?:uninstall|remove)\b/i, label: "package removal", category: "package", level: "prompt" },
  { pattern: /\b(?:pacman|paru|yay)\s+-R/i, label: "Arch package removal", category: "package", level: "strong-confirm" },
  { pattern: /\bapt(?:-get)?\s+(?:remove|purge|autoremove)\b/i, label: "APT package removal", category: "package", level: "strong-confirm" },
  { pattern: /\bdnf\s+remove\b/i, label: "DNF package removal", category: "package", level: "strong-confirm" },
];

const SYSTEM_RULES: CommandRule[] = [
  { pattern: /\bsudo\b/i, label: "sudo", category: "system", level: "prompt" },
  { pattern: /\b(?:shutdown|reboot|poweroff)\b/i, label: "shutdown/reboot", category: "system", level: "block-noninteractive" },
  { pattern: /\bsystemctl\s+(?:stop|disable|mask|restart)\b/i, label: "systemctl service change", category: "system", level: "prompt" },
  { pattern: /\b(?:killall|pkill)\b/i, label: "process kill", category: "system", level: "prompt" },
  { pattern: /\bkill\s+-9\b/i, label: "kill -9", category: "system", level: "prompt" },
  { pattern: /\b(?:umount|mount|swapon|swapoff)\b/i, label: "mount/swap change", category: "system", level: "prompt" },
  { pattern: /\b(?:chmod|chown)\b[^\n;&|]*\s-R\b/i, label: "recursive chmod/chown", category: "system", level: "prompt" },
  { pattern: /\bchmod\b[^\n;&|]*\s777\b/i, label: "chmod 777", category: "system", level: "prompt" },
  { pattern: /\bsetfacl\b/i, label: "ACL change", category: "system", level: "prompt" },
  { pattern: /:\(\)\s*\{/i, label: "fork bomb", category: "system", level: "block-noninteractive" },
];

const DATABASE_RULES: CommandRule[] = [
  { pattern: /\bDROP\s+(?:DATABASE|SCHEMA)\b/i, label: "SQL drop database/schema", category: "database", level: "block-noninteractive" },
  { pattern: /\bDROP\s+TABLE\b/i, label: "SQL drop table", category: "database", level: "strong-confirm" },
  { pattern: /\bDROP\s+INDEX\b/i, label: "SQL drop index", category: "database", level: "strong-confirm" },
  { pattern: /\bTRUNCATE\s+(?:TABLE\s+)?[\w.`\"\[\]-]+/i, label: "SQL truncate table", category: "database", level: "strong-confirm" },
  { pattern: /\bDELETE\s+FROM\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)/i, label: "SQL delete without WHERE", category: "database", level: "strong-confirm" },
  { pattern: /\bUPDATE\s+[\w.`\"\[\]-]+\s+SET\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)/i, label: "SQL update without WHERE", category: "database", level: "strong-confirm" },
  { pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i, label: "SQL alter table drop", category: "database", level: "strong-confirm" },
];

const SECRET_EXPOSURE_RULES: CommandRule[] = [
  { pattern: /\b(?:cat|grep|rg|awk|sed|cp)\b[^\n;&|]*(?:\.env(?:\.[^\s;&|]+)?|id_rsa|id_ed25519|\.git-credentials|auth\.json|\.npmrc|\.pypirc|\.netrc|credentials|hosts\.yml|\.pem|\.key|\.p12|\.kdbx)/i, label: "possible secret file access", category: "secrets", level: "prompt" },
];

const DANGEROUS_BASH_RULES: CommandRule[] = [
  ...GIT_RULES,
  ...FILESYSTEM_RULES,
  ...DOCKER_RULES,
  ...PACKAGE_MANAGER_RULES,
  ...SYSTEM_RULES,
  ...SECRET_EXPOSURE_RULES,
];

function formatAllowEntry(entry: AllowEntry): string {
  const target = `${entry.matchType ?? "exact"} ${entry.label}`;
  return `${entry.kind} ${target} @ ${entry.matchType === "operation-global" ? "EVERYWHERE" : entry.cwd}`;
}

function allowedScope(decision: AllowDecision): AllowScope | undefined {
  return decision && "allow" in decision ? decision.scope : undefined;
}

export function isProtectedPath(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, targetPath);
  const lower = resolved.toLowerCase().replace(/\\/g, "/");

  if (/(^|\/)safety-guard-allow\.json(?:\.receipts\.json|\.legacy-[^/]+\.bak)?$/.test(lower)) return true;
  if (/(^|\/)\.ssh(\/|$)/.test(lower)) return true;
  if (/(^|\/)\.git-credentials$/.test(lower)) return true;
  if (/(^|\/)auth\.json$/.test(lower)) return true;
  if (/(^|\/)id_(rsa|ed25519)(\.pub)?$/.test(lower)) return true;
  if (/(^|\/)\.env(\..+)?$/.test(lower)) return true;
  if (/(^|\/)\.envrc$/.test(lower)) return true;
  if (/(^|\/)\.npmrc$/.test(lower)) return true;
  if (/(^|\/)\.pypirc$/.test(lower)) return true;
  if (/(^|\/)\.netrc$/.test(lower)) return true;
  if (/(^|\/)\.kube\/config$/.test(lower)) return true;
  if (/(^|\/)\.aws\/(credentials|config)$/.test(lower)) return true;
  if (/(^|\/)\.config\/gh\/hosts\.yml$/.test(lower)) return true;
  if (/(^|\/)\.config\/gcloud(\/|$)/.test(lower)) return true;
  if (/\.(pem|key|p12|kdbx)$/.test(lower)) return true;

  return false;
}

async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  message: string,
  nonInteractiveReason: string,
  options: { kind: "write" | "edit" },
): Promise<AllowDecision> {
  if (!ctx.hasUI) {
    return { block: true, reason: nonInteractiveReason };
  }

  return await new Promise<AllowDecision>((resolveDecision) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const finish = (decision: AllowDecision) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      ctx.ui.setWidget(PROMPT_WIDGET_KEY, undefined);
      resolveDecision(decision);
    };

    const promptTitle = [
      ctx.ui.theme.fg("warning", `⚠ ${title}`),
      "",
      message,
    ].join("\n");

    const exactChoice = `Always allow ${options.kind} to this path in this cwd`;
    void ctx.ui.select(promptTitle, [
      "Block",
      "Allow once",
      "Allow for this session",
      exactChoice,
    ]).then((choice) => {
      switch (choice) {
        case "Allow once":
          finish({ allow: true });
          break;
        case "Allow for this session":
          finish({ allow: true, scope: "session" });
          break;
        case exactChoice:
          finish({ allow: true, scope: "permanent" });
          break;
        default:
          finish({ block: true, reason: "Blocked by safety-guard extension" });
          break;
      }
    }).catch(() => finish({ block: true, reason: "Blocked by safety-guard extension" }));
  });
}

function maskHeredocBodies(command: string): string {
  let terminator: string | undefined;
  return command.split("\n").map((line) => {
    if (terminator) {
      if (line.trim() === terminator) terminator = undefined;
      // Retain source offsets and line numbers for exact pattern highlighting.
      return line.replace(/[^\r]/g, " ");
    }
    const match = line.match(/<<-?\s*(?:['"]?)([A-Za-z_][A-Za-z0-9_]*)(?:['"]?)/);
    if (match) terminator = match[1];
    return line;
  }).join("\n");
}

function formatRuleContext(rule: CommandRule, command: string, config: SafetyGuardConfig): string {
  return `${rule.label}\n${matchingCommandExcerpt(rule, command, (value) => value, {
    linesBefore: config.contextLines.before,
    linesAfter: config.contextLines.after,
  })}`.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/gu, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function onOff(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

function modelKey(model: any): string {
  return `${model?.provider || ""}/${model?.id || ""}`;
}

function availableAutoReviewModels(ctx: ExtensionContext): any[] {
  return ctx.modelRegistry.getAvailable()
    .filter((model: any) => model?.provider && model?.id)
    .sort((left: any, right: any) => modelKey(left).localeCompare(modelKey(right)));
}

async function selectSetupValue(
  ctx: ExtensionContext,
  title: string,
  options: Array<{ value: string; label: string }>,
  current?: string,
): Promise<string | undefined> {
  const labels = options.map((option) => option.value === current ? `${option.label} (current)` : option.label);
  const selected = await ctx.ui.select(title, labels);
  if (!selected) return undefined;
  const index = labels.indexOf(selected);
  return index < 0 ? undefined : options[index].value;
}

async function configureAutoReviewModel(
  ctx: ExtensionContext,
  values: SafetyGuardConfig,
): Promise<SafetyGuardConfig | undefined> {
  if (!values.autoReview.enabled) return values;
  const models = availableAutoReviewModels(ctx);
  if (!models.length) {
    ctx.ui.notify("No authenticated Pi models are available. Run /login or configure a provider before enabling safety-guard auto-review.", "warning");
    return undefined;
  }

  const configuredKey = `${values.autoReview.model.provider}/${values.autoReview.model.modelId}`;
  const availableKeys = new Set(models.map(modelKey));
  const selectedKey = await selectSetupValue(
    ctx,
    "Safety guard auto-review model",
    models.map((model: any) => ({
      value: modelKey(model),
      label: `${modelKey(model)}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`,
    })),
    availableKeys.has(configuredKey) ? configuredKey : undefined,
  );
  if (!selectedKey) return undefined;
  const selectedModel = models.find((model: any) => modelKey(model) === selectedKey);
  if (!selectedModel) return undefined;

  const levels = supportedAutoReviewThinkingLevels(selectedModel);
  const selectedThinking = await selectSetupValue(
    ctx,
    "Safety guard auto-review reasoning effort",
    levels.map((level) => ({ value: level, label: level })),
    levels.includes(values.autoReview.model.thinkingLevel) ? values.autoReview.model.thinkingLevel : levels[0],
  );
  if (!selectedThinking) return undefined;
  values.autoReview.model = {
    provider: selectedModel.provider,
    modelId: selectedModel.id,
    thinkingLevel: selectedThinking,
  };
  return values;
}

async function configureSafetyGuardSetup(
  ctx: ExtensionContext,
  initial: SafetyGuardConfig,
): Promise<SafetyGuardConfig | undefined> {
  const values = normalizeSafetyGuardConfig(initial);
  if (!ctx.hasUI) return undefined;

  if (ctx.mode !== "tui") {
    const edited = await ctx.ui.editor(
      "Safety guard setup (JSON)",
      JSON.stringify(values, null, 2),
    );
    if (edited === undefined) return undefined;
    try {
      const parsed = JSON.parse(edited) as unknown;
      assertSafetyGuardConfigPatch(parsed);
      return await configureAutoReviewModel(ctx, normalizeSafetyGuardConfig(parsed));
    } catch (error) {
      ctx.ui.notify(`Invalid safety guard setup: ${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
  }

  const result = await ctx.ui.custom<"save" | undefined>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = [
      { id: "enabled", label: "General · Guard enabled", currentValue: onOff(values.enabled), values: ["on", "off"] },
      { id: "autoReview.enabled", label: "Auto-review · Review matched calls with a model", currentValue: onOff(values.autoReview.enabled), values: ["on", "off"] },
      { id: "context.before", label: "Preview · Lines before a match", currentValue: String(values.contextLines.before), values: CONTEXT_LINE_VALUES },
      { id: "context.after", label: "Preview · Lines after a match", currentValue: String(values.contextLines.after), values: CONTEXT_LINE_VALUES },
      ...SAFETY_GUARD_CATEGORIES.map((category): SettingItem => ({
        id: `category.${category}`,
        label: `Commands · ${CATEGORY_LABELS[category]}`,
        currentValue: onOff(values.categories[category]),
        values: ["on", "off"],
      })),
      { id: "protected.write", label: "Protected paths · Guard writes", currentValue: onOff(values.protectedPaths.write), values: ["on", "off"] },
      { id: "protected.edit", label: "Protected paths · Guard edits", currentValue: onOff(values.protectedPaths.edit), values: ["on", "off"] },
    ];

    const container = new Container();
    container.addChild(new Text(
      `${theme.fg("accent", theme.bold("Safety guard setup"))}\n${theme.fg("dim", `Saved globally in ${safetyGuardConfigFile()}`)}`,
      1,
      0,
    ));
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        if (id === "enabled") values.enabled = newValue === "on";
        else if (id === "autoReview.enabled") values.autoReview.enabled = newValue === "on";
        else if (id === "context.before") values.contextLines.before = Number.parseInt(newValue, 10);
        else if (id === "context.after") values.contextLines.after = Number.parseInt(newValue, 10);
        else if (id === "protected.write") values.protectedPaths.write = newValue === "on";
        else if (id === "protected.edit") values.protectedPaths.edit = newValue === "on";
        else if (id.startsWith("category.")) {
          const category = id.slice("category.".length) as RuleCategory;
          if (SAFETY_GUARD_CATEGORIES.includes(category)) values.categories[category] = newValue === "on";
        }
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "  ↑/↓ move · Enter/Space change · Ctrl+S save · Esc cancel"), 1, 0));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s"))) done("save");
        else if (data === "j") settingsList.handleInput?.("\u001b[B");
        else if (data === "k") settingsList.handleInput?.("\u001b[A");
        else settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  return result === "save" ? await configureAutoReviewModel(ctx, normalizeSafetyGuardConfig(values)) : undefined;
}

function updateStatus(ctx: ExtensionContext, config: SafetyGuardConfig): void {
  if (!ctx.hasUI) return;
  if (config.enabled) {
    ctx.ui.setStatus(STATUS_KEY, "");
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "🔓!"));
}

export function createSafetyGuardExtension({
  requestAutoReviewFn = requestAutoReview,
  allowStorePath = ALLOW_STORE_PATH,
  analyzeShellFn = analyzeShell,
}: {
  requestAutoReviewFn?: typeof requestAutoReview;
  allowStorePath?: string;
  analyzeShellFn?: typeof analyzeShell;
} = {}) {
  return function safetyGuard(pi: ExtensionAPI) {
  let config = defaultSafetyGuardConfig();
  let lastConfigError = "";
  const persistence = new ApprovalPersistence(allowStorePath);
  const sessionApprovals = new SessionApprovals();
  const sessionAllow = sessionApprovals.entries;
  const reportedStorageIssues = new Set<string>();
  const activeReviewTokens = new Set<symbol>();
  let permanentAllow: AllowStore = { version: 1, entries: [] };

  const renderAutoReviewIndicator = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const count = activeReviewTokens.size;
    if (!count) {
      ctx.ui.setStatus(AUTO_REVIEW_STATUS_KEY, undefined);
      ctx.ui.setWidget(AUTO_REVIEW_WIDGET_KEY, undefined);
      return;
    }
    const suffix = count === 1 ? "tool call" : `${count} tool calls`;
    ctx.ui.setStatus(AUTO_REVIEW_STATUS_KEY, `🔎 reviewing ${count}`);
    ctx.ui.setWidget(AUTO_REVIEW_WIDGET_KEY, [`🔎 Safety guard is auto-reviewing ${suffix}…`], { placement: "aboveEditor" });
  };

  const beginAutoReview = (ctx: ExtensionContext): (() => void) => {
    const token = Symbol("safety-guard-auto-review");
    activeReviewTokens.add(token);
    renderAutoReviewIndicator(ctx);
    let cleared = false;
    return () => {
      if (cleared) return;
      cleared = true;
      activeReviewTokens.delete(token);
      renderAutoReviewIndicator(ctx);
    };
  };

  const refreshConfig = (ctx?: ExtensionContext): SafetyGuardConfig => {
    const wasEnabled = config.enabled;
    try {
      config = readSafetyGuardConfig();
      lastConfigError = "";
    } catch (error) {
      config = defaultSafetyGuardConfig();
      const message = error instanceof Error ? error.message : String(error);
      if (ctx?.hasUI && message !== lastConfigError) {
        ctx.ui.notify(`${message}\nUsing fail-safe defaults with every guard enabled.`, "error");
      }
      lastConfigError = message;
    }
    if (ctx && config.enabled !== wasEnabled) updateStatus(ctx, config);
    return config;
  };

  const persistConfig = (patch: SafetyGuardConfigPatch, ctx: ExtensionContext): SafetyGuardConfig | undefined => {
    try {
      config = writeSafetyGuardConfig(patch);
      lastConfigError = "";
      updateStatus(ctx, config);
      return config;
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not save safety guard setup: ${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
  };

  refreshConfig();

  const refreshApprovals = (ctx: ExtensionContext): void => {
    sessionApprovals.ensure(ctx.sessionManager);
    const loaded = persistence.load(ctx.cwd);
    permanentAllow = { version: 1, entries: loaded.entries };
    for (const issue of loaded.issues) {
      if (!reportedStorageIssues.has(issue) && ctx.hasUI) {
        reportedStorageIssues.add(issue);
        try { ctx.ui.notify(issue, "warning"); } catch { /* Reporting must not authorize an operation. */ }
      }
    }
  };

  const isAllowed = (key: string): boolean => sessionAllow.has(key)
    || permanentAllow.entries.some((entry) => entry.key === key);

  const isRuleAllowed = (rule: BashRuleGrant, cwd: string): boolean => permanentAllow.entries.some((entry) => (
    entry.matchType === "rule" && entry.ruleId === rule.id && entry.key === ruleAllowKey(rule.id, cwd)
  ));

  const autoReviewOrPrompt = async (
    ctx: ExtensionContext,
    request: AutoReviewRequest,
    fallback: () => Promise<AllowDecision>,
  ): Promise<AllowDecision> => {
    if (!config.autoReview.enabled) return await fallback();

    const clearIndicator = beginAutoReview(ctx);
    try {
      const verdict = await requestAutoReviewFn(ctx.modelRegistry, { ...config.autoReview.model }, request, undefined, ctx.signal);
      clearIndicator();
      if (verdict.verdict === "allow") return { allow: true };
      if (ctx.hasUI) ctx.ui.notify(`Safety guard auto-review blocked ${request.kind}: ${request.label}`, "warning");
      return { block: true, reason: `Blocked by safety guard auto-review (${request.label})` };
    } catch {
      clearIndicator();
      return await fallback();
    } finally {
      clearIndicator();
    }
  };

  const rememberAllows = (entries: Omit<AllowEntry, "createdAt">[], scope: AllowScope, ctx: ExtensionContext): void => {
    const next = entries.map((entry) => ({ ...entry, createdAt: new Date().toISOString() }));
    if (scope === "session") {
      sessionApprovals.save(next, ctx.sessionManager, (type, data) => pi.appendEntry(type, data));
    } else {
      persistence.save(next, ctx.cwd);
      refreshApprovals(ctx);
    }
    if (ctx.hasUI) {
      try { ctx.ui.notify(`Allowed ${scope === "session" ? "for this session" : "permanently"}:\n${next.map(formatAllowEntry).join("\n")}`, "info"); }
      catch { /* A notification failure must not change an already committed approval. */ }
    }
  };
  const rememberAllow = (entry: Omit<AllowEntry, "createdAt">, scope: AllowScope, ctx: ExtensionContext): void => rememberAllows([entry], scope, ctx);

  pi.registerCommand("safety-guard", {
    description: "Safety guard control: on | off | status | allow-list | allow-clear-session | allow-clear-permanent",
    handler: async (args, ctx) => {
      const cmd = args?.trim().toLowerCase();
      if (!cmd || cmd === "status") {
        refreshConfig(ctx);
        refreshApprovals(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(`${safetyGuardConfigSummary(config)}\nAllows: ${sessionAllow.size} session, ${permanentAllow.entries.length} permanent.`, "info");
        }
        updateStatus(ctx, config);
        return;
      }
      if (cmd === "on") {
        if (persistConfig({ enabled: true }, ctx) && ctx.hasUI) ctx.ui.notify("Safety guard enabled globally", "info");
        return;
      }
      if (cmd === "off") {
        if (persistConfig({ enabled: false }, ctx) && ctx.hasUI) ctx.ui.notify("Safety guard disabled globally", "warning");
        return;
      }
      if (cmd === "allow-list") {
        refreshApprovals(ctx);
        const lines = [
          "Session allows:",
          ...(sessionAllow.size ? [...sessionAllow.values()].map(formatAllowEntry) : ["(none)"]),
          "",
          `Permanent allows: global ${allowStorePath}; current cwd ${projectApprovalFile(ctx.cwd)}`,
          ...(permanentAllow.entries.length ? permanentAllow.entries.map(formatAllowEntry) : ["(none)"]),
        ];
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (cmd === "allow-clear-session") {
        try {
          sessionApprovals.clear(ctx.sessionManager, (type, data) => pi.appendEntry(type, data));
          if (ctx.hasUI) ctx.ui.notify("Cleared safety guard session allow-list", "info");
        } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Could not clear session approvals: ${String(error)}`, "error"); }
        return;
      }
      if (cmd === "allow-clear-permanent") {
        try {
          persistence.clear(ctx.cwd);
          refreshApprovals(ctx);
          if (ctx.hasUI) ctx.ui.notify("Cleared global EVERYWHERE and current-directory permanent approvals; other directories unchanged", "info");
        } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Could not clear permanent approvals: ${String(error)}`, "error"); }
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Usage: /safety-guard on|off|status|allow-list|allow-clear-session|allow-clear-permanent", "warning");
    },
  });

  pi.registerCommand("safety-guard-setup", {
    description: "Configure guards and optional authenticated model auto-review",
    handler: async (args, ctx) => {
      if (args?.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /safety-guard-setup", "warning");
        return;
      }
      refreshConfig(ctx);
      const next = await configureSafetyGuardSetup(ctx, config);
      if (!next) return;
      const saved = persistConfig(next, ctx);
      if (saved && ctx.hasUI) {
        ctx.ui.notify(`Safety guard setup saved to ${safetyGuardConfigFile()}\n\n${safetyGuardConfigSummary(saved)}`, "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx);
    sessionApprovals.restore(ctx.sessionManager);
    refreshApprovals(ctx);
    updateStatus(ctx, config);
  });

  pi.on("tool_call", async (event, ctx) => {
    refreshConfig(ctx);
    if (!config.enabled) return;
    if (["bash", "write", "edit"].includes(event.toolName)) refreshApprovals(ctx);
    const approvalSessionId = ctx.sessionManager.getSessionId();
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      if (ctx.signal?.aborted) return { block: true, reason: "Safety guard approval cancelled" };
      const cwd = normalizeCwd(ctx.cwd);
      const exactKey = allowKey("bash", command, cwd);
      if (isAllowed(exactKey)) return;
      const legacyRule = config.categories.git ? bashRuleGrant(command) : undefined;
      if (legacyRule && isRuleAllowed(legacyRule, cwd)) return;

      const analysis = await analyzeShellFn(command).catch((): ShellAnalysis => ({ supported: false, reason: "Shell parser unavailable" }));
      if (ctx.signal?.aborted) return { block: true, reason: "Safety guard approval cancelled" };
      const commandForMatching = analysis.supported ? command : maskHeredocBodies(command);
      const sourceOperations = analysis.supported ? analysis.operations : [{ text: command, argv: [] as string[], inPipeline: false, argumentRanges: [] }];
      const operations = sourceOperations.map((operation) => {
        const matchingText = analysis.supported ? operation.argv.join(" ") : commandForMatching;
        const matches = DANGEROUS_BASH_RULES.filter((entry) => {
          if (!config.categories[entry.category]) return false;
          const match = entry.pattern.exec(matchingText);
          return !!match && (!analysis.supported || match.index === 0);
        });
        // Printed SQL is harmless only outside pipelines. The receiver may execute it.
        if (config.categories.database && (!analysis.supported || operation.inPipeline || !["echo", "printf"].includes(operation.argv[0]))) {
          matches.push(...DATABASE_RULES.filter((entry) => entry.pattern.test(analysis.supported ? operation.argv.join(" ") : command)));
        }
        const rule = analysis.supported && matches.length === 1 && matches[0].category === "git" ? operationRule(operation.argv) : undefined;
        // Pipeline SQL permissions must include the receiver, not just the producer's argv.
        const pipelineSql = operation.inPipeline && matches.some((match) => match.category === "database");
        const approved = analysis.supported && !pipelineSql && (isAllowed(operationAllowKey(operation.argv, cwd))
          || isAllowed(globalOperationAllowKey(operation.argv))
          || !!rule && isAllowed(operationRuleAllowKey(rule.id, cwd)));
        const risks = matches.map((match) => match.label);
        return { ...operation, matches, risks, rule, approved, pipelineSql };
      });
      const pending = operations.filter((operation) => operation.risks.length && !operation.approved);
      if (!pending.length) return;
      const allMatches = pending.flatMap((operation) => operation.matches);
      const labels = [...new Set(pending.flatMap((operation) => operation.risks))].join(", ");
      const categories = [...new Set(allMatches.map((match) => match.category))].join(",") || "shell";
      const first = allMatches[0];
      const nonInteractiveReason = allMatches.length === 1 && analysis.supported
        ? `Blocked ${first.category} command (${first.label}) in non-interactive mode`
        : "Blocked bash command with unapproved operations in non-interactive mode";
      let selected: BashChoice | undefined;
      const context = [...new Map(allMatches.map((match) => [match.label, match])).values()]
        .map((match) => formatRuleContext(match, match.category === "database" ? command : commandForMatching, config)).join("\n\n");
      const wholeCommandReason = !analysis.supported ? "Matched risk requires complete-command approval; reusable operation analysis is unavailable"
        : operations.some((operation) => operation.pipelineSql) ? "SQL in a pipeline requires approval of the complete command, including its receiver" : undefined;
      const triggers: CommandTrigger[] = pending.flatMap((operation) => operation.matches.map((match) => ({
        reason: match.label,
        range: analysis.supported ? operationMatchRange(command, operation, match.pattern)
          : patternMatchRange(match.category === "database" ? command : commandForMatching, match.pattern),
      })));
      const prompt = buildBashPrompt(command, operations, wholeCommandReason, context, triggers);
      const fallback = async (): Promise<AllowDecision> => {
        if (!ctx.hasUI) return { block: true, reason: nonInteractiveReason };
        try {
          const choice = await showBashPrompt(ctx, prompt);
          selected = choice ? prompt.choices.get(choice) : undefined;
          return selected ? { allow: true } : { block: true, reason: "Blocked by safety-guard extension" };
        } catch { return { block: true, reason: "Blocked by safety-guard extension" }; }
      };
      const request: AutoReviewRequest = {
        kind: "bash", label: labels, category: categories,
        riskLevel: allMatches.some((match) => match.level === "block-noninteractive") ? "block-noninteractive"
          : allMatches.some((match) => match.level === "strong-confirm") ? "strong-confirm" : "prompt",
        cwd, pendingText: command,
      };
      const decision = command.length > AUTO_REVIEW_INPUT_MAX_CHARS ? await fallback() : await autoReviewOrPrompt(ctx, request, fallback);
      if (!decision || "block" in decision) return decision ?? { block: true, reason: "Blocked by safety-guard extension" };
      if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== approvalSessionId || normalizeCwd(ctx.cwd) !== cwd) {
        return { block: true, reason: "Safety guard approval cancelled or context changed" };
      }
      if (selected?.lifetime) {
        const base = { kind: "bash" as const, cwd, value: command, label: labels };
        const entries: Omit<AllowEntry, "createdAt">[] = pending.map((operation) => selected!.scope === "operation-rule" && operation.rule
            ? { ...base, value: operation.text, label: operation.rule.label, matchType: "operation-rule" as const,
              ruleId: operation.rule.id, key: operationRuleAllowKey(operation.rule.id, cwd) }
            : { ...base, value: operation.text, label: operation.risks.join(", "),
              matchType: selected!.scope === "operation-global" ? "operation-global" as const : "operation" as const,
              cwd: selected!.scope === "operation-global" ? "" : cwd, argv: operation.argv,
              key: selected!.scope === "operation-global" ? globalOperationAllowKey(operation.argv) : operationAllowKey(operation.argv, cwd) });
        try { rememberAllows([...new Map(entries.map((entry) => [entry.key, entry])).values()], selected.lifetime, ctx); }
        catch (error) { return { block: true, reason: `Could not save safety guard approval; command was not allowed: ${String(error)}` }; }
      }
      return;
    }

    if (isToolCallEventType("write", event)) {
      if (!config.protectedPaths.write || !isProtectedPath(event.input.path, ctx.cwd)) return;

      const resolvedPath = path.resolve(ctx.cwd, event.input.path);
      const entry = {
        key: allowKey("write", resolvedPath, ctx.cwd),
        kind: "write" as const,
        value: resolvedPath,
        cwd: normalizeCwd(ctx.cwd),
        label: resolvedPath,
      };
      if (isAllowed(entry.key)) return;

      const decision = await autoReviewOrPrompt(ctx, {
        kind: "write",
        label: "protected file write",
        category: "protected-path",
        riskLevel: "prompt",
        cwd: normalizeCwd(ctx.cwd),
        pendingText: event.input.path,
      }, () => confirmOrBlock(
        ctx,
        "Protected file write",
        `Write to protected path '${event.input.path}'?`,
        `Blocked write to protected path '${event.input.path}' in non-interactive mode`,
        { kind: "write" },
      ));
      if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== approvalSessionId || normalizeCwd(ctx.cwd) !== entry.cwd) {
        return { block: true, reason: "Safety guard approval cancelled or context changed" };
      }
      const scope = allowedScope(decision);
      try { if (scope) rememberAllow(entry, scope, ctx); }
      catch (error) { return { block: true, reason: `Could not save safety guard approval: ${String(error)}` }; }
      if (decision && "block" in decision) return decision;
      return;
    }

    if (isToolCallEventType("edit", event)) {
      if (!config.protectedPaths.edit || !isProtectedPath(event.input.path, ctx.cwd)) return;

      const resolvedPath = path.resolve(ctx.cwd, event.input.path);
      const entry = {
        key: allowKey("edit", resolvedPath, ctx.cwd),
        kind: "edit" as const,
        value: resolvedPath,
        cwd: normalizeCwd(ctx.cwd),
        label: resolvedPath,
      };
      if (isAllowed(entry.key)) return;

      const decision = await autoReviewOrPrompt(ctx, {
        kind: "edit",
        label: "protected file edit",
        category: "protected-path",
        riskLevel: "prompt",
        cwd: normalizeCwd(ctx.cwd),
        pendingText: event.input.path,
      }, () => confirmOrBlock(
        ctx,
        "Protected file edit",
        `Edit protected path '${event.input.path}'?`,
        `Blocked edit to protected path '${event.input.path}' in non-interactive mode`,
        { kind: "edit" },
      ));
      if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== approvalSessionId || normalizeCwd(ctx.cwd) !== entry.cwd) {
        return { block: true, reason: "Safety guard approval cancelled or context changed" };
      }
      const scope = allowedScope(decision);
      try { if (scope) rememberAllow(entry, scope, ctx); }
      catch (error) { return { block: true, reason: `Could not save safety guard approval: ${String(error)}` }; }
      if (decision && "block" in decision) return decision;
      return;
    }
  });
  };
}

export default createSafetyGuardExtension();
