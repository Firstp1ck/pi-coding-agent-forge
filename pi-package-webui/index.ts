import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { delay, takeValue, tokenizeArgs } from "@firstpick/pi-utils";
import { detachChildProcess as releaseStartedChild, isProcessRunning, terminateChildProcess as terminateFailedChild } from "@firstpick/pi-utils/process";
import { fetchJsonWithTimeout as fetchJsonWithTimeoutBase } from "@firstpick/pi-utils/http";
import { registerSubagentGate } from "./lib/subagent-gate.mjs";
import { createRestoreFile } from "./lib/update/supervisor.mjs";
import {
  gitWorkflowPreferencesSummary,
  readGitWorkflowPreferences,
  supportedGitWorkflowThinkingLevels,
  writeGitWorkflowPreferences,
} from "./lib/git-workflow-preferences.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = __dirname;
const webuiBin = path.join(packageRoot, "bin", "pi-webui-launcher.mjs");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const nodeExecutable = ["node", "node.exe"].includes(path.basename(process.execPath).toLowerCase()) ? process.execPath : "node";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 31415;
const START_TIMEOUT_MS = 12_000;
const START_TIMEOUT_PER_RESTORED_TAB_MS = 4_000;
const START_TIMEOUT_MAX_MS = 60_000;

type WebuiAddress = {
  host: string;
  port: number;
};

type StartWebuiOptions = WebuiAddress & {
  cwd?: string;
  open: boolean;
  noSession: boolean;
  remoteAuth: boolean;
  outputMode?: "normal" | "compact-v1";
  name?: string;
  piArgs: string[];
};

type WebuiStatusOptions = WebuiAddress & {
  detailed: boolean;
};

type ExistingWebui = {
  webuiVersion?: string;
  webuiPid?: number;
  piPid?: number;
  network?: any;
  tabs?: any[];
  restorableTabs?: any[];
};

type RestorableWebuiTab = {
  id?: string;
  index?: number;
  title?: string;
  titleSource?: string;
  conversationStarted?: boolean;
  cwd?: string;
  sessionFile?: string;
};

type WebuiChild = ChildProcessByStdio<null, Readable, Readable>;

function parseStartWebuiArgs(args: string): StartWebuiOptions {
  const options: StartWebuiOptions = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: true,
    noSession: false,
    remoteAuth: false,
    piArgs: [],
  };
  const tokens = tokenizeArgs(args || "");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      options.piArgs.push(...tokens.slice(i + 1));
      break;
    }
    if (token === "--no-open") {
      options.open = false;
      continue;
    }
    if (token === "--no-session") {
      options.noSession = true;
      continue;
    }
    if (token === "--output-mode") {
      const outputMode = takeValue(tokens, i, token);
      if (outputMode !== "normal" && outputMode !== "compact-v1") throw new Error("--output-mode must be normal or compact-v1");
      options.outputMode = outputMode;
      i++;
      continue;
    }
    if (token === "--remote-auth") {
      options.remoteAuth = true;
      continue;
    }
    if (token === "--no-remote-auth") {
      options.remoteAuth = false;
      continue;
    }
    if (token === "--host") {
      options.host = takeValue(tokens, i, token);
      i++;
      continue;
    }
    if (token === "--port") {
      const port = Number.parseInt(takeValue(tokens, i, token), 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("--port must be between 1 and 65535");
      options.port = port;
      i++;
      continue;
    }
    if (token === "--name") {
      options.name = takeValue(tokens, i, token);
      i++;
      continue;
    }
    if (token === "--cwd") {
      options.cwd = takeValue(tokens, i, token);
      i++;
      continue;
    }
    if (/^\d+$/.test(token)) {
      const port = Number.parseInt(token, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("port must be between 1 and 65535");
      options.port = port;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

function parseWebuiStatusArgs(args: string): WebuiStatusOptions {
  const options: WebuiStatusOptions = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    detailed: false,
  };
  const tokens = tokenizeArgs(args || "");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (["detailed", "detail", "details", "--detailed"].includes(token.toLowerCase())) {
      options.detailed = true;
      continue;
    }
    if (token === "--host") {
      options.host = takeValue(tokens, i, token);
      i++;
      continue;
    }
    if (token === "--port") {
      const port = Number.parseInt(takeValue(tokens, i, token), 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("--port must be between 1 and 65535");
      options.port = port;
      i++;
      continue;
    }
    if (/^\d+$/.test(token)) {
      const port = Number.parseInt(token, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("port must be between 1 and 65535");
      options.port = port;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

function urlFor(options: WebuiAddress): string {
  const host = options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host;
  return `http://${host}:${options.port}/`;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 900): Promise<{ ok: boolean; status: number; body?: any }> {
  return fetchJsonWithTimeoutBase(url, init, { timeoutMs });
}

async function probeExistingWebui(url: string): Promise<ExistingWebui | null> {
  const result = await fetchJsonWithTimeout(`${url.replace(/\/$/, "")}/api/health`);
  const body = result?.body;
  if (!result?.ok || body?.ok !== true || typeof body.webuiVersion !== "string") return null;
  return body;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function restorableTabsFromStatus(tabs: unknown, options: StartWebuiOptions): RestorableWebuiTab[] {
  if (!Array.isArray(tabs)) return [];

  const restored: RestorableWebuiTab[] = [];
  const seenIds = new Set<string>();
  for (const item of tabs) {
    if (!item || typeof item !== "object") continue;
    const tab = item as any;
    const state = tab.state && typeof tab.state === "object" ? tab.state : {};
    const id = boundedString(tab.id, 128);
    const safeId = id && /^[A-Za-z0-9._:-]+$/.test(id) && !seenIds.has(id) ? id : undefined;
    if (safeId) seenIds.add(safeId);

    const restoreTab: RestorableWebuiTab = {
      id: safeId,
      title: boundedString(tab.title, 160),
      titleSource: boundedString(tab.titleSource, 32),
      cwd: boundedString(tab.cwd || tab.workspace?.cwd, 4096),
    };

    if (tab.conversationStarted === true) restoreTab.conversationStarted = true;
    if (Number.isInteger(tab.index) && tab.index > 0) restoreTab.index = tab.index;
    if (!options.noSession) restoreTab.sessionFile = boundedString(state.sessionFile || tab.sessionFile, 4096);

    restored.push(restoreTab);
    if (restored.length >= 256) break;
  }
  return restored;
}

function restorableTabKeys(tab: RestorableWebuiTab): string[] {
  const keys: string[] = [];
  if (tab.id) keys.push(`id:${tab.id}`);
  if (tab.sessionFile) keys.push(`session:${tab.sessionFile}`);
  const fallback = [tab.index || "", tab.cwd || "", tab.title || ""].join("\0");
  if (fallback.replace(/\0/g, "")) keys.push(`tab:${fallback}`);
  return keys;
}

function mergeRestorableTabDescriptor(current: RestorableWebuiTab, next: RestorableWebuiTab): RestorableWebuiTab {
  const merged: RestorableWebuiTab = { ...current };
  for (const [key, value] of Object.entries(next) as [keyof RestorableWebuiTab, RestorableWebuiTab[keyof RestorableWebuiTab]][]) {
    if (value !== undefined && value !== "") (merged as any)[key] = value;
  }
  return merged;
}

function mergeRestorableTabsFromStatusSources(sources: unknown[], options: StartWebuiOptions): RestorableWebuiTab[] {
  const merged: RestorableWebuiTab[] = [];
  const keyToIndex = new Map<string, number>();

  for (const source of sources) {
    for (const tab of restorableTabsFromStatus(source, options)) {
      const keys = restorableTabKeys(tab);
      const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index): index is number => index !== undefined);
      if (existingIndex === undefined) {
        if (merged.length >= 256) continue;
        const index = merged.length;
        merged.push(tab);
        for (const key of keys) keyToIndex.set(key, index);
      } else {
        merged[existingIndex] = mergeRestorableTabDescriptor(merged[existingIndex], tab);
        for (const key of restorableTabKeys(merged[existingIndex])) keyToIndex.set(key, existingIndex);
      }
    }
  }

  return merged.slice(0, 256);
}

async function fetchRestorableTabs(url: string, existing: ExistingWebui, options: StartWebuiOptions): Promise<RestorableWebuiTab[]> {
  const baseUrl = url.replace(/\/$/, "");
  const detailed = await fetchJsonWithTimeout(`${baseUrl}/api/webui-status?detailed=1&events=0`, {}, 7_000);
  const statusData = detailed?.ok && detailed.body?.ok === true ? detailed.body.data : undefined;

  // Restart should preserve the tabs that are currently open in the Web UI.
  // Older servers may expose recently closed tabs through `restorableTabs`, so
  // prefer explicit live tab lists whenever the running server provides them.
  const openTabSources: unknown[] = [];
  const detailedTabs = statusData?.tabs;
  if (Array.isArray(detailedTabs)) openTabSources.push(detailedTabs);
  if (Array.isArray(existing.tabs)) openTabSources.push(existing.tabs);
  if (openTabSources.length > 0) return mergeRestorableTabsFromStatusSources(openTabSources, options);

  // Legacy fallback for servers that predate `tabs` in status/health payloads.
  return mergeRestorableTabsFromStatusSources([statusData?.restorableTabs, existing.restorableTabs], options);
}

async function waitForWebuiToStop(url: string, timeoutMs = 7_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeExistingWebui(url))) return true;
    await delay(180);
  }
  return !(await probeExistingWebui(url));
}

async function requestWebuiShutdown(url: string): Promise<boolean> {
  const result = await fetchJsonWithTimeout(`${url.replace(/\/$/, "")}/api/shutdown`, { method: "POST" }, 1_500);
  return result?.ok === true && result.body?.ok === true;
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await delay(160);
  }

  try {
    if (isProcessRunning(pid)) process.kill(pid, "SIGKILL");
  } catch {
    // Ignore kill races; the restart path verifies the port separately.
  }
}

function runCommand(command: string, args: string[], timeoutMs = 1_500): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { exitCode?: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 100_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => finish({ stdout, stderr: stderr || (error instanceof Error ? error.message : String(error)) }));
    child.on("exit", (exitCode) => finish({ exitCode: exitCode ?? undefined, stdout, stderr }));
  });
}

function commandLooksLikeWebui(command: string, options: StartWebuiOptions): boolean {
  if (!command.includes("pi-webui.mjs")) return false;
  const escapedPort = String(options.port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--port\\s+${escapedPort}(?:\\s|$)`).test(command);
}

async function listProcessCommandLines(): Promise<string> {
  if (process.platform === "win32") {
    // tasklist has no command lines; CIM is the reliable way to find pi-webui.mjs --port matches.
    const result = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'],
      5_000,
    );
    return result.exitCode === 0 ? result.stdout : "";
  }
  let result = await runCommand("ps", ["-Ao", "pid=,args="], 1_500);
  if (result.exitCode !== 0) result = await runCommand("ps", ["-eo", "pid=,args="], 1_500);
  return result.exitCode === 0 ? result.stdout : "";
}

async function findWebuiPidsByCommand(options: StartWebuiOptions): Promise<number[]> {
  const processList = await listProcessCommandLines();
  const pids: number[] = [];
  for (const line of processList.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (pid !== process.pid && commandLooksLikeWebui(command, options)) pids.push(pid);
  }
  return [...new Set(pids)];
}

async function stopExistingWebui(url: string, options: StartWebuiOptions, existing: ExistingWebui): Promise<void> {
  if (await requestWebuiShutdown(url)) {
    if (await waitForWebuiToStop(url)) return;
  }

  if (Number.isInteger(existing.webuiPid)) {
    await terminatePid(existing.webuiPid!);
    if (await waitForWebuiToStop(url)) return;
  }

  for (const pid of await findWebuiPidsByCommand(options)) {
    await terminatePid(pid);
  }
  if (await waitForWebuiToStop(url)) return;

  throw new Error(`Existing Pi Web UI is still running at ${url}. Stop it manually and retry.`);
}

function openDefaultBrowser(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function startupTimeoutMs(restoreTabCount: number): number {
  const extraTabs = Math.max(0, restoreTabCount - 1);
  return Math.min(START_TIMEOUT_MAX_MS, START_TIMEOUT_MS + extraTabs * START_TIMEOUT_PER_RESTORED_TAB_MS);
}

function waitForWebuiUrl(child: WebuiChild, timeoutMs = START_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (url) releaseStartedChild(child);
      if (error) {
        terminateFailedChild(child);
        reject(error);
      } else resolve(url!);
    };

    const inspect = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > 20_000) output = output.slice(-20_000);
      const match = output.match(/Pi Web UI:\s+(https?:\/\/\S+)/);
      if (match?.[1]) finish(null, match[1]);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Pi Web UI to start. Output:\n${output.trim() || "(no output)"}`));
    }, timeoutMs);

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`Pi Web UI exited before startup (${code ?? signal ?? "unknown"}). Output:\n${output.trim() || "(no output)"}`));
    });
  });
}

async function startWebui(options: StartWebuiOptions, ctx: ExtensionCommandContext, restoreTabs: RestorableWebuiTab[] = []): Promise<string> {
  const args = [webuiBin, "--host", options.host, "--port", String(options.port)];
  if (options.cwd) args.push("--cwd", options.cwd);
  if (options.noSession) args.push("--no-session");
  if (options.remoteAuth) args.push("--remote-auth");
  if (options.outputMode) args.push("--output-mode", options.outputMode);
  if (options.name) args.push("--name", options.name);
  if (options.piArgs.length > 0) args.push("--", ...options.piArgs);

  const env = { ...process.env };
  if (restoreTabs.length > 0) env.PI_WEBUI_RESTORE_FILE = (await createRestoreFile(agentDir, restoreTabs)).file;

  const child = spawn(nodeExecutable, args, {
    cwd: ctx.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return waitForWebuiUrl(child, startupTimeoutMs(restoreTabs.length));
}

type WebuiStatusFetchResult = {
  online: boolean;
  url: string;
  endpointSupported: boolean;
  data?: any;
  error?: string;
};

async function fetchWebuiStatus(options: WebuiStatusOptions): Promise<WebuiStatusFetchResult> {
  const url = urlFor(options);
  const baseUrl = url.replace(/\/$/, "");
  const query = options.detailed ? "?detailed=1&events=40" : "";
  const statusResult = await fetchJsonWithTimeout(`${baseUrl}/api/webui-status${query}`, {}, options.detailed ? 7_000 : 1_500);
  if (statusResult?.ok && statusResult.body?.ok === true) {
    return { online: true, url, endpointSupported: true, data: statusResult.body.data };
  }

  const healthResult = await fetchJsonWithTimeout(`${baseUrl}/api/health`, {}, 1_500);
  if (healthResult?.ok && healthResult.body?.ok === true) {
    return {
      online: true,
      url,
      endpointSupported: false,
      data: {
        ...healthResult.body,
        online: true,
        pageUrl: healthResult.body.network?.localUrl || url,
        port: options.port,
      },
      error: statusResult?.body?.error,
    };
  }

  return {
    online: false,
    url,
    endpointSupported: false,
    error: statusResult?.body?.error || healthResult?.body?.error || "No Pi Web UI responded at this URL",
  };
}

function yesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function modelLabel(model: any): string {
  if (!model) return "unknown";
  return [model.provider, model.id].filter(Boolean).join("/") || "unknown";
}

function sessionLabel(state: any): string {
  return state?.sessionName || state?.sessionId || "unknown";
}

function displayPath(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  const normalized = text.replace(/\\/g, "/");
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
  return home && normalized.toLowerCase().startsWith(home.toLowerCase()) ? `~${normalized.slice(home.length)}` || "~" : normalized;
}

function compactSessionFile(value: unknown): string {
  const shown = displayPath(value);
  if (shown === "unknown") return "in-memory/unknown";
  const parts = shown.split("/");
  if (parts.length <= 4) return shown;
  return `${parts.slice(0, 3).join("/")}/…/${parts.at(-1)}`;
}

function formatStatusTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return String(value || "unknown");
  return date.toLocaleString();
}

function formatEventTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return String(value || "time?");
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function detailLine(label: string, value: unknown, indent = "  "): string {
  return `${indent}${label.padEnd(10)} ${String(value ?? "unknown")}`;
}

function formatStats(stats: any): string {
  if (!stats || typeof stats !== "object") return "unavailable";
  const parts = [];
  if (stats.userMessages !== undefined) parts.push(`${stats.userMessages} user`);
  if (stats.assistantMessages !== undefined) parts.push(`${stats.assistantMessages} assistant`);
  if (stats.toolCalls !== undefined) parts.push(`${stats.toolCalls} tool calls`);
  if (stats.toolResults !== undefined) parts.push(`${stats.toolResults} tool results`);
  if (stats.totalTokens !== undefined) parts.push(`${stats.totalTokens} tokens`);
  if (stats.costUsd !== undefined) parts.push(`$${stats.costUsd}`);
  return parts.length ? parts.join(" · ") : "available";
}

function formatProviders(models: any): string {
  const providers = Array.isArray(models?.providers) ? models.providers : [];
  const providerText = providers.length ? providers.join(", ") : "unknown";
  return models?.count ? `${models.count} models · ${providerText}` : providerText;
}

function eventDetails(event: any): string[] {
  const details = [];
  if (event.command) details.push(event.command);
  if (event.updateType) details.push(`update ${event.updateType}`);
  if (event.pid) details.push(`pid ${event.pid}`);
  if (event.code !== undefined || event.signal !== undefined) details.push(`exit ${event.code ?? event.signal}`);
  if (event.error) details.push(`error: ${event.error}`);
  if (event.text) details.push(event.text);
  return details;
}

function eventGroupKey(event: any): string {
  return JSON.stringify([event.tabTitle || "webui", event.type || "event", ...eventDetails(event)]);
}

function formatEvent(event: any, count = 1): string {
  const details = eventDetails(event);
  const repeat = count > 1 ? ` ×${count}` : "";
  return `  ${formatEventTime(event.timestamp)}  ${event.tabTitle || "webui"} · ${event.type || "event"}${repeat}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function formatEventGroups(events: any[]): string[] {
  const groups: { event: any; count: number }[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous && eventGroupKey(previous.event) === eventGroupKey(event)) {
      previous.count += 1;
    } else {
      groups.push({ event, count: 1 });
    }
  }
  return groups.map((group) => formatEvent(group.event, group.count));
}

function formatWebuiStatus(result: WebuiStatusFetchResult, requestedDetailed: boolean): string {
  if (!result.online) {
    return [
      "Pi Web UI status",
      detailLine("URL", result.url),
      detailLine("Online", "no"),
      detailLine("Network", "unknown"),
      detailLine("Error", result.error || "offline"),
      "",
      "Start it with: /webui-start",
    ].join("\n");
  }

  const data = result.data || {};
  const network = data.network || {};
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  const networkUrls = Array.isArray(network.networkUrls) ? network.networkUrls : [];
  const auth = network.auth || {};
  const pageUrl = data.pageUrl || network.localUrl || result.url;
  const networkLabel = network.open ? `open to LAN${network.opening ? " (opening)" : ""}` : network.opening ? "opening" : "local only";
  const authLabel = auth.enabled ? `remote PIN on${auth.pin ? ` · PIN ${auth.pin}` : ""}` : "remote PIN off";

  if (!requestedDetailed) {
    const lines = [
      "Pi Web UI status",
      "",
      detailLine("URL", pageUrl),
      detailLine("Online", "yes"),
      detailLine("Network", networkLabel),
      detailLine("Auth", authLabel),
      detailLine("Tabs", tabs.length || "?"),
    ];
    if (networkUrls.length) lines.push(detailLine("LAN URLs", networkUrls.join(", ")));
    if (data.webuiPid) lines.push(detailLine("Web UI PID", data.webuiPid));
    return lines.join("\n");
  }

  const lines = [
    "Pi Web UI — detailed status",
    "",
    "Summary",
    detailLine("URL", pageUrl),
    detailLine("Online", "yes"),
    detailLine("Network", networkLabel),
    detailLine("Auth", authLabel),
    detailLine("Bind", `${data.boundHost || network.host || "unknown"}:${data.port || network.port || "?"}`),
    detailLine("Version", data.webuiVersion || "unknown"),
    detailLine("PIDs", `webui ${data.webuiPid || "unknown"} · pi ${data.piPid || "unknown"}`),
    detailLine("Started", formatStatusTime(data.startedAt)),
    detailLine("Root cwd", displayPath(data.cwd)),
  ];

  if (networkUrls.length) lines.push(detailLine("LAN URLs", networkUrls.join(", ")));

  if (!result.endpointSupported) {
    lines.push("", "Detailed endpoint unavailable on the running server. Restart it with /webui-start to enable full details.");
    return lines.join("\n");
  }

  lines.push("", `Tabs (${tabs.length})`);
  if (!tabs.length) lines.push("  none");
  for (const [index, tab] of tabs.entries()) {
    const state = tab.state || {};
    const status = tab.running ? "● running" : "○ stopped";
    const activity = state.isStreaming ? "streaming" : state.isCompacting ? "compacting" : "idle";
    lines.push(
      "",
      `  ${index + 1}. ${tab.title || tab.id || "tab"}  ${status}`,
      detailLine("Process", `pid ${tab.pid || "unknown"} · clients ${tab.clientCount ?? 0} · started ${formatStatusTime(tab.startedAt)}`, "     "),
      detailLine("Workspace", displayPath(tab.workspace?.cwd || tab.cwd), "     "),
      detailLine("Session", sessionLabel(state), "     "),
      detailLine("File", compactSessionFile(state.sessionFile), "     "),
      detailLine("Model", `${modelLabel(state.model)} · thinking ${state.thinkingLevel || "unknown"}`, "     "),
      detailLine("Activity", `${activity} · messages ${state.messageCount ?? "?"} · queue ${state.pendingMessageCount ?? 0}`, "     "),
      detailLine("Providers", formatProviders(tab.models), "     "),
      detailLine("Stats", formatStats(tab.stats), "     "),
    );
    if (tab.stateError) lines.push(detailLine("State err", tab.stateError, "     "));
    if (tab.models?.error) lines.push(detailLine("Model err", tab.models.error, "     "));
    if (tab.statsError) lines.push(detailLine("Stats err", tab.statsError, "     "));
    if (tab.workspaceError) lines.push(detailLine("Work err", tab.workspaceError, "     "));
  }

  const events = Array.isArray(data.events) ? data.events.slice(-20) : [];
  lines.push("", `Recent events (latest ${events.length}; repeated adjacent events are grouped)`);
  lines.push(...(events.length ? formatEventGroups(events) : ["  none"]));
  return lines.join("\n");
}

function usage(): string {
  return [
    "Usage: /webui-start [port] [--port N] [--cwd PATH] [--no-open] [--no-session] [--remote-auth] [--output-mode normal|compact-v1] [--name NAME] [-- --model provider/model]",
    "Starts the Pi Web UI companion server, prints the localhost URL, and opens it in your default browser. Starts empty unless tabs are restored or --cwd PATH selects a project.",
  ].join("\n");
}

function statusUsage(): string {
  return [
    "Usage: /webui-status [detailed] [port] [--port N] [--host HOST]",
    "Shows the Pi Web UI URL, online state, and local-network exposure. Add 'detailed' for tabs, sessions, models/providers, and recent events.",
  ].join("\n");
}

type WebuiTreeNavigateArgs = {
  entryId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
};

function parseWebuiTreeNavigateArgs(args: string): WebuiTreeNavigateArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch (error) {
    throw new Error(`Invalid Web UI tree navigation payload: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Web UI tree navigation payload must be an object");
  const payload = parsed as Record<string, unknown>;
  const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
  if (!entryId) throw new Error("Web UI tree navigation requires entryId");
  return {
    entryId,
    summarize: payload.summarize === true,
    customInstructions: typeof payload.customInstructions === "string" ? payload.customInstructions : undefined,
    replaceInstructions: payload.replaceInstructions === true,
    label: typeof payload.label === "string" ? payload.label : undefined,
  };
}

function availableGitWorkflowModels(ctx: ExtensionCommandContext): any[] {
  return ctx.modelRegistry.getAvailable()
    .filter((model: any) => model?.provider && model?.id)
    .sort((left: any, right: any) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
}

function gitWorkflowModelLabel(model: any): string {
  return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`;
}

async function selectGitWorkflowSetupValue(
  ctx: ExtensionCommandContext,
  title: string,
  options: Array<{ value: string; label: string }>,
  current?: string,
): Promise<string | undefined> {
  const labels = options.map((option) => option.value === current ? `${option.label} (current)` : option.label);
  const selected = await ctx.ui.select(title, labels);
  if (!selected) return undefined;
  const index = labels.indexOf(selected);
  return index >= 0 ? options[index].value : undefined;
}

async function runGitWorkflowSetup(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const current = await readGitWorkflowPreferences();
    const models = availableGitWorkflowModels(ctx);
    if (!models.length) {
      ctx.ui.notify("No authenticated Pi models are available. Run /login or configure a provider before guided Git setup.", "warning");
      return;
    }

    const configuredModelKey = `${current.generation.provider}/${current.generation.modelId}`;
    const activeModelKey = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const availableModelKeys = new Set(models.map((model: any) => `${model.provider}/${model.id}`));
    const currentModelKey = availableModelKeys.has(configuredModelKey) ? configuredModelKey : activeModelKey;
    const modelOptions = models
      .map((model: any) => ({ value: `${model.provider}/${model.id}`, label: gitWorkflowModelLabel(model) }))
      .sort((left, right) => Number(right.value === currentModelKey) - Number(left.value === currentModelKey));
    const selectedModelKey = await selectGitWorkflowSetupValue(ctx, `Guided Git model\n\n${gitWorkflowPreferencesSummary(current)}`, modelOptions, currentModelKey);
    if (!selectedModelKey) return;
    const selectedModel = models.find((model: any) => `${model.provider}/${model.id}` === selectedModelKey);
    if (!selectedModel) return;

    const thinkingLevels = supportedGitWorkflowThinkingLevels(selectedModel);
    const thinkingLevel = await selectGitWorkflowSetupValue(
      ctx,
      "Reasoning effort for commit, branch, and PR text",
      thinkingLevels.map((value) => ({ value, label: value })),
      thinkingLevels.includes(current.generation.thinkingLevel) ? current.generation.thinkingLevel : "low",
    );
    if (!thinkingLevel) return;

    const language = await selectGitWorkflowSetupValue(ctx, "Generated Git text language", [
      { value: "en", label: "English" },
      { value: "de", label: "German" },
    ], current.commit.language);
    if (!language) return;

    const defaultVariant = await selectGitWorkflowSetupValue(ctx, "Default commit message", [
      { value: "short", label: "Short subject" },
      { value: "long", label: "Long subject + body" },
    ], current.commit.defaultVariant);
    if (!defaultVariant) return;

    const scope = await selectGitWorkflowSetupValue(ctx, "Conventional Commit scope", [
      { value: "auto", label: "Auto-detect when clear" },
      { value: "never", label: "Never include a scope" },
      { value: "required", label: "Always include a scope" },
    ], current.commit.scope);
    if (!scope) return;

    const stagingPolicy = await selectGitWorkflowSetupValue(ctx, "Default staging behavior", [
      { value: "review", label: "Review/select files in Git Changes" },
      { value: "preserve", label: "Use the current staged set" },
      { value: "all", label: "Stage all with git add ." },
    ], current.stagingPolicy);
    if (!stagingPolicy) return;

    const reviewProcess = await selectGitWorkflowSetupValue(ctx, "Manual review process", [
      { value: "enabled", label: "Enabled when aur-review is available" },
      { value: "disabled", label: "Disabled — continue directly to message generation" },
    ], current.reviewProcessEnabled ? "enabled" : "disabled");
    if (!reviewProcess) return;

    const deliveryMode = await selectGitWorkflowSetupValue(ctx, "Default delivery path", [
      { value: "ask", label: "Ask each workflow" },
      { value: "current", label: "Prefer the current branch" },
      { value: "pr-worktree", label: "Prefer a PR branch worktree" },
    ], current.deliveryMode);
    if (!deliveryMode) return;

    const verificationPolicy = await selectGitWorkflowSetupValue(ctx, "Pre-commit verification", [
      { value: "ask", label: "Confirm checks were reviewed before commit" },
      { value: "none", label: "Do not show a verification reminder" },
    ], current.verificationPolicy);
    if (!verificationPolicy) return;

    const next = {
      generation: {
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        thinkingLevel,
        unavailablePolicy: "ask",
      },
      commit: { language, defaultVariant, scope },
      stagingPolicy,
      reviewProcessEnabled: reviewProcess === "enabled",
      deliveryMode,
      verificationPolicy,
    };
    const confirmed = await ctx.ui.confirm("Save guided Git setup?", gitWorkflowPreferencesSummary(next));
    if (!confirmed) return;
    const saved = await writeGitWorkflowPreferences(next);
    ctx.ui.notify(`Guided Git workflow setup saved.\n\n${gitWorkflowPreferencesSummary(saved)}`, "info");
  } catch (error) {
    ctx.ui.notify(`Guided Git workflow setup failed:\n${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  const subagentGate = registerSubagentGate(pi);
  pi.on("session_shutdown", () => subagentGate.dispose());

  const startWebuiHandler = async (args: string, ctx: ExtensionCommandContext) => {
    let options: StartWebuiOptions;
    try {
      options = parseStartWebuiArgs(args);
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n${usage()}`, "error");
      return;
    }

    const url = urlFor(options);
    ctx.ui.setStatus("pi-webui", "starting webui…");
    try {
      const existing = await probeExistingWebui(url);
      let restoreTabs: RestorableWebuiTab[] = [];
      if (existing) {
        ctx.ui.setStatus("pi-webui", "capturing existing webui tabs…");
        restoreTabs = await fetchRestorableTabs(url, existing, options);
        ctx.ui.setStatus("pi-webui", "restarting existing webui…");
        await stopExistingWebui(url, options, existing);
      }

      const startedUrl = await startWebui(options, ctx, restoreTabs);
      if (options.open) openDefaultBrowser(startedUrl);
      const restoredTabsMessage = existing && restoreTabs.length > 0 ? `\nRestored ${restoreTabs.length} Web UI tab${restoreTabs.length === 1 ? "" : "s"}.` : "";
      ctx.ui.notify(`${existing ? "Pi Web UI restarted" : "Pi Web UI started"}:\n${startedUrl}${restoredTabsMessage}`, "info");
      ctx.ui.setStatus("pi-webui", startedUrl);
      setTimeout(() => ctx.ui.setStatus("pi-webui", ""), 20_000).unref?.();
    } catch (error) {
      ctx.ui.setStatus("pi-webui", "");
      ctx.ui.notify(`Failed to start Pi Web UI:\n${error instanceof Error ? error.message : String(error)}\n${usage()}`, "error");
    }
  };

  pi.registerCommand("git-workflow-setup", {
    description: "Configure the model, reasoning effort, staging, review process, and commit defaults for guided Git",
    handler: async (_args, ctx) => runGitWorkflowSetup(ctx),
  });

  pi.registerCommand("webui-start", {
    description: "Start the local Pi browser Web UI and open it",
    handler: startWebuiHandler,
  });

  pi.registerCommand("webui-status", {
    description: "Show Pi Web UI URL, online state, network exposure, and optional detailed runtime info",
    handler: async (args, ctx) => {
      let options: WebuiStatusOptions;
      try {
        options = parseWebuiStatusArgs(args);
      } catch (error) {
        ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n${statusUsage()}`, "error");
        return;
      }

      ctx.ui.setStatus("pi-webui", "checking webui status…");
      try {
        const result = await fetchWebuiStatus(options);
        ctx.ui.notify(formatWebuiStatus(result, options.detailed), result.online ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Failed to check Pi Web UI status:\n${error instanceof Error ? error.message : String(error)}\n${statusUsage()}`, "error");
      } finally {
        ctx.ui.setStatus("pi-webui", "");
      }
    },
  });

  pi.registerCommand("webui-tree-navigate", {
    description: "Internal Web UI helper for browser session-tree navigation",
    handler: async (args, ctx) => {
      let payload: WebuiTreeNavigateArgs;
      try {
        payload = parseWebuiTreeNavigateArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      try {
        await ctx.waitForIdle();
        const result = (await ctx.navigateTree(payload.entryId, {
          summarize: payload.summarize,
          customInstructions: payload.customInstructions,
          replaceInstructions: payload.replaceInstructions,
          label: payload.label,
        })) as { cancelled: boolean; editorText?: string };
        if (result.cancelled) {
          ctx.ui.notify("Web UI tree navigation cancelled.", "warning");
          return;
        }
        if (typeof result.editorText === "string") ctx.ui.setEditorText(result.editorText);
        ctx.ui.notify("Web UI navigated the session tree.", "info");
      } catch (error) {
        ctx.ui.notify(`Web UI tree navigation failed:\n${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
