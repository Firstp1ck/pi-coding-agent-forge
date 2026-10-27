import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendRunLog, createRunLog, formatElapsed, isCtrlC, isCtrlO, listRunLogs, saveRunLog, shellQuote, stripAnsi, type RunLog, type RunLogEntry } from "@firstpick/pi-utils";
import { terminateProcessTree } from "./process-tree.ts";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { showCheckPicker, showPublishPicker } from "./publish-picker.ts";
import { openReleaseOutputWindow, type ReleaseOutputWindow } from "./release-output-overlay.ts";
import { compactReleaseView, SPINNER_INTERVAL_MS, spinnerFrame, type CompactReleaseView } from "./compact-release-output.ts";

const RELEASE_STATUS_KEY = "release-npm";
const RELEASE_LOG_WIDGET_KEY = "release-npm:logs";
const COLLAPSED_LINES = 40;
const OUTPUT_RENDER_INTERVAL_MS = 80;

type RunResult = { ok: boolean; output: string; aborted: boolean };
type CommandResult = { ok: boolean; output: string; errorCode?: string };
type AbortableChild = ChildProcessWithoutNullStreams & { abortReleaseStep?: () => void };
type PlannedPublish = { name: string; version: string; action: "publish-first" | "publish-update"; label: string };
type PlannedPublishTarget = PlannedPublish & { target: string };
type ReleaseLogEntry = RunLogEntry;
type ReleaseRunLog = RunLog;

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const RELEASE_LOG_DIR = join(homedir(), ".pi", "agent", "release-npm-logs");

function releaseScriptCommand(cwd: string, scriptName: string, args: string[] = []): string {
  const localScripts = [join(cwd, "dev", "scripts", scriptName), join(cwd, scriptName)];
  const localScript = localScripts.find((candidate) => existsSync(candidate));
  const scriptPath = localScript ?? join(EXTENSION_DIR, scriptName);
  const quotedArgs = args.map(shellQuote).join(" ");
  return `PI_NPM_PACKAGES_ROOT=${shellQuote(cwd)} ${shellQuote(scriptPath)}${quotedArgs ? ` ${quotedArgs}` : ""}`;
}

function createReleaseRunLog(cwd: string): ReleaseRunLog {
  return createRunLog(cwd);
}

function appendReleaseLog(runLog: ReleaseRunLog, chunk: string): void {
  appendRunLog(runLog, chunk);
}

function saveReleaseRunLog(runLog: ReleaseRunLog, status: string, summary?: string): string | undefined {
  return saveRunLog(runLog, { logDir: RELEASE_LOG_DIR, title: "release-npm log", status, summary });
}

function listReleaseLogs(): ReleaseLogEntry[] {
  return listRunLogs(RELEASE_LOG_DIR);
}

function spawnErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function spawnErrorOutput(command: string, error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  const code = err?.code ? `${err.code}: ` : "";
  const message = err?.message || String(error);
  return `Failed to spawn ${command}: ${code}${message}`;
}

type NpmCommandCandidate = { command: string; args: string[]; options?: Record<string, unknown> };

function npmCommandCandidates(args: string[]): NpmCommandCandidate[] {
  const candidates: NpmCommandCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: NpmCommandCandidate) => {
    const key = `${candidate.command}\0${candidate.args.join("\0")}\0${JSON.stringify(candidate.options || {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) add({ command: process.execPath, args: [npmExecPath, ...args] });

  const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledNpmCli)) add({ command: process.execPath, args: [bundledNpmCli, ...args] });

  if (process.platform === "win32") add({ command: "npm.cmd", args, options: { shell: true, windowsHide: true } });
  add({ command: "npm", args });
  return candidates;
}

async function runCommand(cwd: string, command: string): Promise<CommandResult> {
  return await new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, output: spawnErrorOutput("bash", error), errorCode: spawnErrorCode(error) });
      return;
    }

    let output = "";
    let settled = false;
    const settle = (value: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("error", (error) => settle({ ok: false, output: `${output}${spawnErrorOutput("bash", error)}\n`, errorCode: spawnErrorCode(error) }));
    child.on("close", (code) => settle({ ok: code === 0, output }));
  });
}

async function runNpmCommand(cwd: string, args: string[]): Promise<CommandResult> {
  const failedSpawnAttempts: string[] = [];

  for (const candidate of npmCommandCandidates(args)) {
    const result = await new Promise<CommandResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(candidate.command, candidate.args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          ...(candidate.options || {}),
        });
      } catch (error) {
        resolve({ ok: false, output: spawnErrorOutput(candidate.command, error), errorCode: spawnErrorCode(error) });
        return;
      }

      let output = "";
      let settled = false;
      const settle = (value: CommandResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      child.stdout.on("data", (d) => { output += String(d); });
      child.stderr.on("data", (d) => { output += String(d); });
      child.on("error", (error) => {
        const code = spawnErrorCode(error);
        if (code === "ENOENT") {
          settle({ ok: false, output: "ENOENT", errorCode: code });
          return;
        }
        settle({ ok: false, output: `${output}${spawnErrorOutput(candidate.command, error)}\n`, errorCode: code });
      });
      child.on("close", (code) => settle({ ok: code === 0, output }));
    });

    if (result.ok) return result;
    if (result.errorCode === "ENOENT" || result.errorCode === "EINVAL") {
      failedSpawnAttempts.push(result.output.trim());
      continue;
    }
    return result;
  }

  return { ok: false, output: failedSpawnAttempts.length ? failedSpawnAttempts.join("\n") : "npm executable not found in PATH" };
}

async function runNpmConfigSetToken(cwd: string, token: string): Promise<CommandResult> {
  return await runNpmCommand(cwd, ["config", "set", "//registry.npmjs.org/:_authToken", token]);
}

async function verifyNpmAuth(cwd: string): Promise<CommandResult> {
  return await runNpmCommand(cwd, ["whoami"]);
}

function redactTokenLikeOutput(output: string): string {
  return output.replace(/npm_[A-Za-z0-9_=-]+/g, "npm_[redacted]").trim();
}

// Git Bash (MSYS) on Windows starts the script in a process whose Windows parent
// is not the bash that Node spawned, so `taskkill /T` misses it and the script keeps
// running. Record bash's MSYS PID and signal its process group with MSYS `kill`.
function createMsysPidFile(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    return join(mkdtempSync(join(tmpdir(), "release-npm-")), "pid");
  } catch {
    return undefined;
  }
}

function signalMsysProcessGroup(pidFile: string, signal: "INT" | "TERM" | "KILL"): void {
  let pid = "";
  try {
    pid = readFileSync(pidFile, "utf8").trim();
  } catch {
    return;
  }
  if (!/^\d+$/.test(pid)) return;
  spawnSync("bash", ["-c", `kill -${signal} -- -${pid} 2>/dev/null || kill -${signal} ${pid} 2>/dev/null`], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5000,
  });
}

async function runScriptLive(
  cwd: string,
  script: string,
  onChunk: (chunk: string) => void,
  onChild?: (child: AbortableChild) => void,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let child: AbortableChild;
    const msysPidFile = createMsysPidFile();
    try {
      child = spawn("bash", ["-lc", msysPidFile ? `echo $$ > "$RELEASE_NPM_PID_FILE"; ${script}` : script], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: msysPidFile ? { ...process.env, RELEASE_NPM_PID_FILE: msysPidFile } : process.env,
      }) as AbortableChild;
    } catch (error) {
      const output = `${spawnErrorOutput("bash", error)}\n`;
      if (msysPidFile) rmSync(dirname(msysPidFile), { recursive: true, force: true });
      onChunk(output);
      resolve({ ok: false, output, aborted: false });
      return;
    }

    let output = "";
    let aborted = false;
    let settled = false;
    const settle = (value: RunResult) => {
      if (settled) return;
      settled = true;
      if (msysPidFile) rmSync(dirname(msysPidFile), { recursive: true, force: true });
      resolve(value);
    };
    const appendChunk = (chunk: string) => {
      output += chunk;
      onChunk(chunk);
    };
    child.abortReleaseStep = () => {
      aborted = true;
      if (msysPidFile) signalMsysProcessGroup(msysPidFile, "INT");
      else terminateProcessTree(child, "SIGINT");
      setTimeout(() => {
        if (settled) return;
        if (msysPidFile) signalMsysProcessGroup(msysPidFile, "KILL");
        terminateProcessTree(child, "SIGTERM");
      }, 1500).unref();
    };

    onChild?.(child);

    child.stdout.on("data", (d) => appendChunk(String(d)));
    child.stderr.on("data", (d) => appendChunk(String(d)));
    child.on("error", (error) => {
      appendChunk(`${spawnErrorOutput("bash", error)}\n`);
      settle({ ok: false, output, aborted });
    });
    child.on("close", (code) => settle({ ok: code === 0 && !aborted, output, aborted }));
  });
}

function evaluateFailureWithLLM(pi: ExtensionAPI, step: string, output: string): void {
  const trimmed = output.slice(-12000);
  pi.sendUserMessage(
    `Release step failed: ${step}. Analyze the failure and provide: (1) root cause, (2) exact fix steps, (3) safe rerun command order.\n\nFailure output:\n${trimmed}`,
    { deliverAs: "followUp" },
  );
}

function extractSection(output: string, heading: string): string[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];

  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      if (result.length > 0) break;
      continue;
    }
    result.push(line.trimEnd());
  }
  return result;
}

function extractVersionChanges(output: string): string[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const changes: string[] = [];
  let currentPackage = "";
  let currentVersion = "";

  for (const line of lines) {
    const pkgMatch = line.match(/^\s*- package: (.+)$/);
    if (pkgMatch) {
      currentPackage = pkgMatch[1];
      currentVersion = "";
      continue;
    }

    const versionMatch = line.match(/^\s*- local version: (.+)$/);
    if (versionMatch) {
      currentVersion = versionMatch[1];
      continue;
    }

    const actionMatch = line.match(/^\s*- action: (would bump up -> .+|would reduce down -> .+|no bump \(first release\)|unchanged \(.+\))$/);
    if (actionMatch && currentPackage) {
      const from = currentVersion ? ` from ${currentVersion}` : "";
      changes.push(`${currentPackage}${from}: ${actionMatch[1]}`);
    }
  }

  return changes;
}

function splitPublishPlan(output: string): { publish: string[]; skip: string[]; blocked: string[]; other: string[] } {
  const plan = extractSection(output, "Plan summary:");
  const publish: string[] = [];
  const skip: string[] = [];
  const blocked: string[] = [];
  const other: string[] = [];

  for (const raw of plan) {
    const line = raw.trim();
    const match = line.match(/^-\s+(.+?)\s+->\s+(.+)$/);
    if (!match) {
      other.push(line);
      continue;
    }

    const item = `${match[1]} -> ${match[2]}`;
    if (match[2] === "publish-first" || match[2] === "publish-update") {
      publish.push(item);
    } else if (match[2] === "skip") {
      skip.push(item);
    } else if (match[2] === "error") {
      blocked.push(item);
    } else {
      other.push(item);
    }
  }

  return { publish, skip, blocked, other };
}

function extractPlannedPublishes(output: string): PlannedPublish[] {
  return splitPublishPlan(output).publish.flatMap((line) => {
    const match = line.match(/^((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)\s+->\s+(publish-first|publish-update)$/);
    if (!match) return [];
    return [{ name: match[1], version: match[2], action: match[3] as PlannedPublish["action"], label: `${match[1]}@${match[2]}` }];
  });
}

// Same package discovery as the release scripts: top-level, non-hidden directories with a package.json.
function listPackageDirs(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(cwd, entry.name, "package.json")))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function resolvePlannedPublishTargets(cwd: string, planned: PlannedPublish[]): { targets: PlannedPublishTarget[]; missing: PlannedPublish[] } {
  const packageNameToDir = new Map<string, string>();
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = join(cwd, entry.name, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (packageJson.name) packageNameToDir.set(packageJson.name, entry.name);
    } catch {
      // Ignore invalid package metadata here; readiness checks report it separately.
    }
  }

  const targets: PlannedPublishTarget[] = [];
  const missing: PlannedPublish[] = [];
  const seenTargets = new Set<string>();
  for (const item of planned) {
    const target = packageNameToDir.get(item.name);
    if (!target) {
      missing.push(item);
      continue;
    }
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    targets.push({ ...item, target });
  }
  return { targets, missing };
}

function formatPreflightSummary(output: string): string {
  // Packages without publishable changes make up most of the list and need no
  // decision, so leave them out and only report how many there were.
  const allVersionChanges = extractVersionChanges(output);
  const versionChanges = allVersionChanges.filter((line) => !line.endsWith(": unchanged (no publishable changes)"));
  const hiddenCount = allVersionChanges.length - versionChanges.length;
  const bumpSummaries = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => /^\s*- (would bump up|would reduce down|bumped up|reduced down|unchanged|first release \(no npm version\)|publish candidates|errors): /.test(line))
    .slice(0, 6);
  const publishPlan = splitPublishPlan(output);

  return [
    "Release preflight summary:",
    "Version changes:",
    ...(versionChanges.length ? versionChanges.map((line) => `  ${line}`) : ["  none detected"]),
    ...(hiddenCount ? [`  (${hiddenCount} package(s) without publishable changes not shown)`] : []),
    "Bump summary:",
    ...(bumpSummaries.length ? bumpSummaries.map((line) => `  ${line.trim()}`) : ["  unavailable"]),
    "Will publish:",
    ...(publishPlan.publish.length ? publishPlan.publish.map((line) => `  ${line}`) : ["  none"]),
    "Will skip:",
    ...(publishPlan.skip.length ? publishPlan.skip.map((line) => `  ${line}`) : ["  none"]),
    "Blocked:",
    ...(publishPlan.blocked.length ? publishPlan.blocked.map((line) => `  ${line}`) : ["  none"]),
    ...(publishPlan.other.length ? ["Other:", ...publishPlan.other.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

// Rows the publish selector needs besides package options: borders, spacing, the
// two-line title, key hints, the fixed choices (All, Publish selected, page
// navigation, Cancel), and Pi's footer below the selector.
const SELECTOR_RESERVED_ROWS = 20;
const MIN_TARGET_PAGE_SIZE = 3;
const NON_TTY_TARGET_PAGE_SIZE = 12;

function selectorTargetPageSize(): number {
  const rows = process.stdout.rows;
  if (!rows) return NON_TTY_TARGET_PAGE_SIZE;
  return Math.max(MIN_TARGET_PAGE_SIZE, rows - SELECTOR_RESERVED_ROWS);
}

// Package directories with staged, unstaged, or untracked changes. Empty outside a Git repository.
function listChangedPackageDirs(cwd: string, packages: string[]): Set<string> {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  const prefixResult = git(["rev-parse", "--show-prefix"]);
  const statusResult = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (prefixResult.status !== 0 || statusResult.status !== 0) return new Set();
  // Porcelain paths are relative to the repository root, not to cwd.
  const prefix = prefixResult.stdout.trim();
  const known = new Set(packages);
  const changed = new Set<string>();
  const entries = statusResult.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const paths = [entry.slice(3)];
    // Renames and copies are followed by their original path.
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++index] ?? "");
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const dir = path.slice(prefix.length).split("/")[0];
      if (known.has(dir)) changed.add(dir);
    }
  }
  return changed;
}

// Package choice before preflight checks. Every package starts selected.
async function chooseCheckTargets(ctx: ExtensionCommandContext, packages: string[]): Promise<string[] | undefined> {
  const changed = listChangedPackageDirs(ctx.cwd, packages);
  if (ctx.mode === "tui") return await showCheckPicker(ctx, packages, changed);
  if (!ctx.hasUI) return packages;
  // Remote clients get Pi's standard choice prompt, paged like the publish selector.
  const selected = new Set(packages);
  const pageSize = selectorTargetPageSize();
  const pageCount = Math.max(1, Math.ceil(packages.length / pageSize));
  const selectAllChoice = "Select all";
  const deselectAllChoice = "Deselect all";
  const cancelChoice = "Cancel";
  let page = 0;
  while (true) {
    const startChoice = `Start checks (${selected.size} selected)`;
    const nextPageChoice = `Next packages (page ${page + 2}/${pageCount})`;
    const previousPageChoice = `Previous packages (page ${page}/${pageCount})`;
    const pagePackages = packages.slice(page * pageSize, (page + 1) * pageSize);
    const optionMap = new Map(pagePackages.map((name) => [
      `${selected.has(name) ? "[x]" : "[ ]"} ${name}${changed.has(name) ? " ● uncommitted changes" : ""}`,
      name,
    ]));
    const hasPreviousPage = page > 0;
    const hasNextPage = page < pageCount - 1;
    const pageText = pageCount > 1 ? ` · page ${page + 1}/${pageCount}` : "";
    const choice = await ctx.ui.select(
      `Which packages should release-npm check? ${selected.size}/${packages.length} selected${changed.size ? ` · ${changed.size} with uncommitted changes (●)` : ""}${pageText}`,
      [
        startChoice,
        selectAllChoice,
        deselectAllChoice,
        ...optionMap.keys(),
        ...(hasPreviousPage ? [previousPageChoice] : []),
        ...(hasNextPage ? [nextPageChoice] : []),
        cancelChoice,
      ],
    );
    if (choice === cancelChoice || !choice) return undefined;
    if (choice === startChoice) {
      if (selected.size === 0) {
        ctx.ui.notify("Select at least one package, or cancel the release.", "warning");
        continue;
      }
      return packages.filter((name) => selected.has(name));
    }
    if (choice === selectAllChoice) packages.forEach((name) => selected.add(name));
    else if (choice === deselectAllChoice) selected.clear();
    else if (hasNextPage && choice === nextPageChoice) page += 1;
    else if (hasPreviousPage && choice === previousPageChoice) page -= 1;
    else {
      const name = optionMap.get(choice);
      if (!name) continue;
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
    }
  }
}

const RELEASE_OUTPUT_KEY = `${RELEASE_STATUS_KEY}:output`;
const RELEASE_FOOTER_KEY = `${RELEASE_STATUS_KEY}:footer`;
const EXPANDED_LINES = 160;

let activeReleaseRun: { abort: () => void; toggleOutput: () => void } | undefined;
let activeLogViewerCleanup: (() => void) | undefined;

export default function releaseNpmExtension(pi: ExtensionAPI) {
  pi.registerCommand("release-npm-setup", {
    description: "Configure npm auth token for release publishing",
    handler: async (_args, ctx) => {
      const token = (await ctx.ui.input("npm auth token", "Paste npm token for registry.npmjs.org"))?.trim();
      if (!token) {
        ctx.ui.notify("npm token setup cancelled: no token entered.", "warning");
        return;
      }

      ctx.ui.notify("Saving npm auth token with npm config set...", "info");
      const setResult = await runNpmConfigSetToken(ctx.cwd, token);
      if (!setResult.ok) {
        const detail = redactTokenLikeOutput(setResult.output);
        ctx.ui.notify(`Failed to save npm token.${detail ? ` ${detail}` : ""}`, "error");
        return;
      }

      const authResult = await verifyNpmAuth(ctx.cwd);
      if (!authResult.ok) {
        const detail = redactTokenLikeOutput(authResult.output);
        ctx.ui.notify(`npm token saved, but npm whoami failed.${detail ? ` ${detail}` : ""}`, "warning");
        return;
      }

      const username = authResult.output.trim();
      ctx.ui.notify(`npm token saved and verified${username ? ` as ${username}` : ""}.`, "success");
    },
  });

  pi.registerCommand("release-npm-logs", {
    description: "Select and display saved /release-npm run logs",
    handler: async (args, ctx) => {
      if (args?.trim().toLowerCase() === "close") {
        activeLogViewerCleanup?.();
        activeLogViewerCleanup = undefined;
        ctx.ui.notify("Release log viewer closed.", "info");
        return;
      }

      const logs = listReleaseLogs();
      if (logs.length === 0) {
        ctx.ui.notify(`No release logs found in ${RELEASE_LOG_DIR}.`, "info");
        return;
      }

      const choices = logs.map((log, index) => `${index + 1}. ${log.title}`);
      const choice = await ctx.ui.select("Select release log to display", [...choices, "Cancel"]);
      if (!choice || choice === "Cancel") return;

      const selectedIndex = choices.indexOf(choice);
      const selected = logs[selectedIndex];
      if (!selected) return;

      let content = "";
      try {
        content = readFileSync(selected.file, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not read release log: ${message}`, "error");
        return;
      }

      activeLogViewerCleanup?.();
      const lines = content.split(/\r?\n/);
      const renderLimit = 240;
      const unsubscribe = ctx.hasUI
        ? ctx.ui.onTerminalInput((data) => {
          if (data === "\u001b" || data === "q" || data === "Q") {
            activeLogViewerCleanup?.();
            activeLogViewerCleanup = undefined;
            return { consume: true };
          }
          return undefined;
        })
        : undefined;
      activeLogViewerCleanup = () => {
        unsubscribe?.();
        if (ctx.hasUI) ctx.ui.setWidget(RELEASE_LOG_WIDGET_KEY, undefined);
      };

      if (ctx.hasUI) {
        ctx.ui.setWidget(RELEASE_LOG_WIDGET_KEY, [
          `Release log: ${selected.title}`,
          `Path: ${selected.file} · showing last ${Math.min(renderLimit, lines.length)}/${lines.length} lines · Esc/q closes in TUI; /release-npm-logs close also closes`,
          "",
          ...lines.slice(-renderLimit),
        ], { placement: "aboveEditor" });
      }
      ctx.ui.notify(`Showing release log ${selected.title}.`, "info");
    },
  });

  pi.registerCommand("release-toggle", {
    description: "Show or hide the /release-npm output window (compact/expanded output outside the terminal UI)",
    handler: async (_args, ctx) => {
      if (!activeReleaseRun) {
        ctx.ui.notify("No active release output to toggle.", "warning");
        return;
      }
      activeReleaseRun.toggleOutput();
    },
  });

  pi.registerCommand("release-abort", {
    description: "Abort the active /release-npm subprocess",
    handler: async (_args, ctx) => {
      if (!activeReleaseRun) {
        ctx.ui.notify("No active release process to abort.", "warning");
        return;
      }
      activeReleaseRun.abort();
      ctx.ui.notify("Aborting release workflow...", "warning");
    },
  });

  pi.registerCommand("release-npm", {
    description: "Run npm release checks/workflow and confirm publish",
    handler: async (_args, ctx) => {
      if (activeReleaseRun) {
        ctx.ui.notify("A release workflow is already running. Use /release-toggle or /release-abort.", "warning");
        return;
      }

      const notifyProgress = (message: string, type: "info" | "success" | "warning" | "error" = "info") => {
        if (ctx.mode === "rpc") return;
        ctx.ui.notify(message, type);
      };

      notifyProgress("Checking npm authentication with npm whoami...", "info");
      const authResult = await verifyNpmAuth(ctx.cwd);
      if (!authResult.ok) {
        const detail = redactTokenLikeOutput(authResult.output);
        ctx.ui.notify(
          `npm whoami failed; aborting /release-npm before release preflight. Run /release-npm-setup or npm login, then retry.${detail ? ` ${detail}` : ""}`,
          "error",
        );
        return;
      }

      const username = authResult.output.trim();
      const authSummary = `npm authentication verified${username ? ` as ${username}` : ""}.`;
      notifyProgress(authSummary, "success");

      const packageDirs = listPackageDirs(ctx.cwd);
      const checkTargets = packageDirs.length ? await chooseCheckTargets(ctx, packageDirs) : packageDirs;
      if (!checkTargets) {
        ctx.ui.notify("Release cancelled before preflight checks.", "info");
        return;
      }
      const checkAll = checkTargets.length === packageDirs.length;
      const planArgs = checkAll ? ["--plan", "--all"] : ["--plan", "--targets", checkTargets.join(",")];
      const planStep = `release-workflow.sh ${checkAll ? "--plan --all" : `--plan --targets (${checkTargets.length} packages)`}`;

      const runLog = createReleaseRunLog(ctx.cwd);
      let cleanupReleaseUi: (() => void) | undefined;
      void (async () => {
      let liveBuffer = "";
      // The window shows a compact per-package view; the run log keeps the full output.
      let compactCache: { length: number; spinner: string; view: CompactReleaseView } | undefined;
      // Packages listed before their checks start, so every name shows up right away.
      let expectedDirs = checkTargets;
      let expanded = false;
      let phase = "Release preflight checks";
      const startedAtMs = Date.now();
      let currentChild: AbortableChild | undefined;
      let unsubscribeKeys: (() => void) | undefined;
      let elapsedTimer: ReturnType<typeof setInterval> | undefined;
      let renderQueued = false;
      let uiClosed = false;
      // Pi caps above-editor widgets at ten lines, so the terminal UI shows the live
      // output in a scrollable overlay instead. RPC/Web UI clients keep the widgets.
      const useOutputWindow = ctx.mode === "tui";
      let outputWindow: ReleaseOutputWindow | undefined;

      const outputView = () => {
        // The spinner only turns while a script is running.
        const spinner = currentChild ? spinnerFrame() : "";
        if (compactCache?.length !== liveBuffer.length || compactCache.spinner !== spinner) {
          const theme = ctx.ui.theme;
          const view = compactReleaseView(liveBuffer, (tone, text) => theme.fg(tone, text), { expectedDirs, spinner: spinner || undefined });
          compactCache = { length: liveBuffer.length, spinner, view };
        }
        return compactCache.view;
      };
      const outputLines = () => {
        const { lines, summary } = outputView();
        return summary ? [...lines, "", summary] : lines;
      };
      const modeText = () => {
        const total = outputLines().length;
        const shown = expanded ? Math.min(EXPANDED_LINES, total) : Math.min(COLLAPSED_LINES, total);
        return expanded ? `expanded ${shown}/${total}` : `compact ${shown}/${total}`;
      };
      const renderReleaseUiNow = () => {
        if (!ctx.hasUI || uiClosed) return;
        if (useOutputWindow) {
          outputWindow ??= openReleaseOutputWindow(
            ctx,
            () => {
              const { lines, focusLine, summary } = outputView();
              return { title: `release-npm: ${phase} · ${formatElapsed(startedAtMs)}`, lines, focusLine, footer: summary ? [summary] : [] };
            },
            {
              onAbort: abortFromUser,
              onHidden: () => ctx.ui.notify("Release output hidden; the release keeps running. Ctrl+O or /release-toggle shows it again.", "info"),
              onError: (message) => ctx.ui.notify(`Release output window failed: ${message}`, "error"),
            },
          );
          outputWindow.refresh();
          return;
        }
        const lines = outputLines();
        const limit = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
        const visibleLines = lines.slice(-limit);
        ctx.ui.setWidget(RELEASE_OUTPUT_KEY, visibleLines.length
          ? visibleLines
          : ["Waiting for release output..."], { placement: "aboveEditor" });
        ctx.ui.setWidget(RELEASE_FOOTER_KEY, [
          `release-npm: ${phase} · ${modeText()} · ${formatElapsed(startedAtMs)}`,
          "Controls: Ctrl+O or /release-toggle expands/collapses · Ctrl+C or /release-abort stops subprocess",
        ], { placement: "belowEditor" });
      };
      const renderReleaseUi = (immediate = false) => {
        if (immediate) {
          renderReleaseUiNow();
          return;
        }
        if (!ctx.hasUI || uiClosed || renderQueued) return;
        renderQueued = true;
        setTimeout(() => {
          renderQueued = false;
          renderReleaseUiNow();
        }, OUTPUT_RENDER_INTERVAL_MS);
      };
      const setPhase = (nextPhase: string) => {
        phase = nextPhase;
        renderReleaseUi(true);
      };
      const startElapsedTimer = () => {
        if (!ctx.hasUI || elapsedTimer) return;
        // The terminal window redraws often enough to animate the spinner; widgets
        // in RPC/Web UI clients update once a second to limit traffic.
        elapsedTimer = setInterval(() => renderReleaseUi(true), useOutputWindow ? SPINNER_INTERVAL_MS : 1000);
      };
      const abortCurrentStep = () => currentChild?.abortReleaseStep?.();
      const abortFromUser = () => {
        ctx.ui.notify("Aborting release workflow...", "warning");
        abortCurrentStep();
      };
      const closeReleaseUi = () => {
        uiClosed = true;
        unsubscribeKeys?.();
        unsubscribeKeys = undefined;
        if (elapsedTimer) clearInterval(elapsedTimer);
        elapsedTimer = undefined;
        activeReleaseRun = undefined;
        outputWindow?.close();
        outputWindow = undefined;
        if (ctx.hasUI) {
          ctx.ui.setWidget(RELEASE_OUTPUT_KEY, undefined);
          ctx.ui.setWidget(RELEASE_FOOTER_KEY, undefined);
          ctx.ui.setWidget(RELEASE_STATUS_KEY, undefined);
        }
      };
      cleanupReleaseUi = closeReleaseUi;
      const toggleOutput = () => {
        if (outputWindow) {
          outputWindow.toggle();
          return;
        }
        expanded = !expanded;
        renderReleaseUi(true);
      };
      const resetLiveOutput = () => {
        liveBuffer = "";
        compactCache = undefined;
        uiClosed = false;
        renderReleaseUi(true);
      };
      const finishLog = (status: string, summary?: string) => saveReleaseRunLog(runLog, status, summary);
      const appendOutput = (chunk: string) => {
        liveBuffer += chunk;
        appendReleaseLog(runLog, chunk);
        renderReleaseUi();
      };
      const subscribeReleaseKeys = () => {
        if (!ctx.hasUI || unsubscribeKeys) return;
        unsubscribeKeys = ctx.ui.onTerminalInput((data) => {
          if (isKeyRelease(data)) return undefined;
          if (isCtrlO(data) || matchesKey(data, Key.ctrl("o"))) {
            toggleOutput();
            return { consume: true };
          }
          if (isCtrlC(data) || matchesKey(data, Key.ctrl("c"))) {
            abortFromUser();
            return { consume: true };
          }
        });
      };
      const outputLocationText = useOutputWindow
        ? "Output opens in a scrollable window; Esc or Ctrl+O hides it and Ctrl+O shows it again."
        : "Output stays above input; controls are below input.";
      activeReleaseRun = { abort: abortCurrentStep, toggleOutput };

      if (ctx.hasUI) {
        ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("accent", "Release:Checking"));
        notifyProgress(`Running release preflight checks. ${outputLocationText}`, "info");
        renderReleaseUi(true);
        startElapsedTimer();
        subscribeReleaseKeys();
      }

      const planCommand = releaseScriptCommand(ctx.cwd, "release-workflow.sh", planArgs);
      notifyProgress(`Running ${planStep}...`, "info");
      appendOutput(`${authSummary}\n`);
      appendReleaseLog(runLog, `Checked packages: ${checkAll ? `all (${checkTargets.length})` : checkTargets.join(", ")}\n`);
      appendOutput(`$ ${planCommand}\n`);
      const plan = await runScriptLive(ctx.cwd, planCommand, appendOutput, (child) => { currentChild = child; });
      currentChild = undefined;

      if (plan.aborted) {
        const logPath = finishLog("aborted-preflight");
        closeReleaseUi();
        ctx.ui.notify(`Release workflow aborted.${logPath ? ` Log: ${logPath}` : ""}`, "warning");
        if (ctx.hasUI) ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("warning", "Release:Aborted"));
        return;
      }

      if (!plan.ok) {
        const logPath = finishLog("failed-preflight");
        ctx.ui.notify(`release-workflow preflight failed; publish was not offered.${logPath ? ` Log: ${logPath}` : ""}`, "error");
        if (ctx.hasUI) ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("error", "Release:Failed"));
        closeReleaseUi();
        evaluateFailureWithLLM(pi, planStep, plan.output);
        return;
      }

      closeReleaseUi();
      const plannedPublishes = extractPlannedPublishes(plan.output);
      const plannedTargetResolution = resolvePlannedPublishTargets(ctx.cwd, plannedPublishes);
      const preflightSummary = formatPreflightSummary(plan.output);
      const targetSummary = [
        "Publish targets after confirmation:",
        ...(plannedTargetResolution.targets.length
          ? plannedTargetResolution.targets.map((item) => `  ${item.target} (${item.label} -> ${item.action})`)
          : ["  none"]),
        ...(plannedTargetResolution.missing.length
          ? ["Missing local package dirs:", ...plannedTargetResolution.missing.map((item) => `  ${item.label}`)]
          : []),
      ].join("\n");
      appendReleaseLog(runLog, `\n--- preflight summary ---\n${preflightSummary}\n\n${targetSummary}\n`);
      if (plannedTargetResolution.targets.length === 0) {
        closeReleaseUi();
        if (ctx.hasUI) ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("success", "Release:NoTargets"));
        const logPath = finishLog("no-targets", `${preflightSummary}\n\n${targetSummary}`);
        ctx.ui.notify(`No publish targets were detected in the pre-confirmation plan; nothing to publish.${logPath ? ` Log: ${logPath}` : ""}`, "info");
        return;
      }

      const allTargetsChoice = `All eligible packages (${plannedTargetResolution.targets.length})`;
      const cancelChoice = "Cancel";
      const publishSelectedChoice = (count: number) => count > 0
        ? `Publish selected packages (${count})`
        : "Publish selected packages";
      const formatSelectableTarget = (target: PlannedPublishTarget, selected: boolean) => `${selected ? "[x]" : "[ ]"} ${target.target}`;
      // Outside the terminal UI (RPC, Web UI) the native selector prints its title and
      // every option without scrolling, so a long summary or package list pushes the
      // choices off-screen. Post the full summary to the chat first, keep the title
      // short, and page the package options.
      const targetPageSize = selectorTargetPageSize();
      const targetPageCount = Math.max(1, Math.ceil(plannedTargetResolution.targets.length / targetPageSize));
      const nextPageChoice = (page: number) => `Next packages (page ${page + 2}/${targetPageCount})`;
      const previousPageChoice = (page: number) => `Previous packages (page ${page}/${targetPageCount})`;
      const choosePublishTargets = async (): Promise<PlannedPublishTarget[] | undefined> => {
        // In the terminal UI, show the summary and package list in a scrollable overlay.
        if (ctx.mode === "tui") return await showPublishPicker(ctx, `${preflightSummary}\n\n${targetSummary}`, plannedTargetResolution.targets);
        ctx.ui.notify(`${preflightSummary}\n\n${targetSummary}`, "info");
        const selectedTargets = new Set<string>();
        let page = 0;
        while (true) {
          const pageTargets = plannedTargetResolution.targets.slice(page * targetPageSize, (page + 1) * targetPageSize);
          const targetOptionMap = new Map<string, PlannedPublishTarget>();
          const targetOptions = pageTargets.map((target) => {
            const option = formatSelectableTarget(target, selectedTargets.has(target.target));
            targetOptionMap.set(option, target);
            return option;
          });
          const hasPreviousPage = page > 0;
          const hasNextPage = page < targetPageCount - 1;
          const pageText = targetPageCount > 1 ? ` · packages page ${page + 1}/${targetPageCount}` : "";
          const choice = await ctx.ui.select(
            `Publish eligible packages now? ${selectedTargets.size}/${plannedTargetResolution.targets.length} selected${pageText}\nChoose All, or toggle packages and publish the selected set. The full preflight summary is in the chat above.`,
            [
              allTargetsChoice,
              publishSelectedChoice(selectedTargets.size),
              ...targetOptions,
              ...(hasPreviousPage ? [previousPageChoice(page)] : []),
              ...(hasNextPage ? [nextPageChoice(page)] : []),
              cancelChoice,
            ],
          );
          if (choice === allTargetsChoice) return plannedTargetResolution.targets;
          if (choice === cancelChoice || !choice) return undefined;
          if (hasNextPage && choice === nextPageChoice(page)) {
            page += 1;
            continue;
          }
          if (hasPreviousPage && choice === previousPageChoice(page)) {
            page -= 1;
            continue;
          }
          if (choice === publishSelectedChoice(selectedTargets.size)) {
            if (selectedTargets.size === 0) {
              ctx.ui.notify("Select at least one package, choose All, or cancel the release.", "warning");
              continue;
            }
            return plannedTargetResolution.targets.filter((target) => selectedTargets.has(target.target));
          }

          const target = targetOptionMap.get(choice);
          if (!target) continue;
          if (selectedTargets.has(target.target)) selectedTargets.delete(target.target);
          else selectedTargets.add(target.target);
        }
      };

      const selectedPublishTargets = await choosePublishTargets();
      appendReleaseLog(runLog, [
        "\n--- user publish target selection ---",
        `selected=${selectedPublishTargets?.length ? selectedPublishTargets.map((target) => target.target).join(",") : "<none>"}`,
        selectedPublishTargets?.length ? "packages:" : undefined,
        ...(selectedPublishTargets?.map((target) => `  ${target.label} (${target.action}; target=${target.target})`) || []),
      ].filter((line): line is string => line !== undefined).join("\n") + "\n");
      if (!selectedPublishTargets?.length) {
        closeReleaseUi();
        if (ctx.hasUI) {
          ctx.ui.setWidget(RELEASE_STATUS_KEY, undefined);
          ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("warning", "Release:Cancelled"));
        }
        const logPath = finishLog("cancelled", preflightSummary);
        ctx.ui.notify(`Publish cancelled after successful preflight checks.${logPath ? ` Log: ${logPath}` : ""}`, "info");
        return;
      }

      phase = "Release publishing";
      expanded = false;
      expectedDirs = selectedPublishTargets.map((target) => target.target);
      resetLiveOutput();
      activeReleaseRun = { abort: abortCurrentStep, toggleOutput };
      if (ctx.hasUI) {
        ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("accent", "Release:Publishing"));
        notifyProgress(`Starting publish workflow. ${outputLocationText}`, "info");
        renderReleaseUi(true);
        startElapsedTimer();
        subscribeReleaseKeys();
      }

      notifyProgress(`Running publish workflow for ${selectedPublishTargets.length} selected target(s)...`, "info");
      appendOutput(`Running publish workflow for ${selectedPublishTargets.length} selected target(s)...\n`);
      const updated: string[] = [];
      const skipped: string[] = [];
      const firstRelease: string[] = [];
      const failed: Array<{ pkg: string; reason: string }> = [];
      const publishActions = new Map<string, "publish-first" | "publish-update">();

      const rememberUnique = (items: string[], item: string) => {
        if (!items.includes(item)) items.push(item);
      };

      const parsePublishOutput = (output: string) => {
        const linesNow = stripAnsi(output).split(/\r?\n/).filter(Boolean);
        for (const line of linesNow) {
          const mEvent = line.match(/^RELEASE_NPM_EVENT\s+(\{.*\})$/);
          if (mEvent) {
            try {
              const event = JSON.parse(mEvent[1]) as { status?: string; name?: string; version?: string; action?: string; detail?: string };
              if (event.name && event.version) {
                const pkg = `${event.name}@${event.version}`;
                if (event.status === "published" && event.action === "publish-first") {
                  rememberUnique(firstRelease, pkg);
                } else if (event.status === "published") {
                  rememberUnique(updated, pkg);
                } else if (event.status === "skipped") {
                  rememberUnique(skipped, pkg);
                } else if (event.status === "failed") {
                  const reason = event.detail || event.action || "unknown";
                  if (!failed.some((f) => f.pkg === pkg && f.reason === reason)) failed.push({ pkg, reason });
                }
              }
            } catch {
              // Keep regex fallback below for older script output.
            }
            continue;
          }

          const mPublishing = line.match(/Publishing\s+((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)\s+\((publish-first|publish-update)\)/);
          if (mPublishing) {
            publishActions.set(`${mPublishing[1]}@${mPublishing[2]}`, mPublishing[3] as "publish-first" | "publish-update");
            continue;
          }

          const mPublished = line.match(/PASS\s+Published\s+((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)/);
          if (mPublished) {
            const name = `${mPublished[1]}@${mPublished[2]}`;
            const action = publishActions.get(name);
            if (action === "publish-first") {
              rememberUnique(firstRelease, name);
            } else {
              rememberUnique(updated, name);
            }
            continue;
          }

          const mSkipped = line.match(/INFO\s+Skipping\s+((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)\s+\(already published\)/);
          if (mSkipped) {
            rememberUnique(skipped, `${mSkipped[1]}@${mSkipped[2]}`);
            continue;
          }

          const mCheckFailed = line.match(/FAIL\s+Skipping\s+((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)\s+\(([^)]+)\)/);
          if (mCheckFailed) {
            const pkg = `${mCheckFailed[1]}@${mCheckFailed[2]}`;
            const reason = mCheckFailed[3].trim();
            if (!failed.some((f) => f.pkg === pkg && f.reason === reason)) failed.push({ pkg, reason });
            continue;
          }

          const mFailedPublish = line.match(/FAIL\s+Failed to publish\s+((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)\s+(.+)/);
          if (mFailedPublish) {
            const pkg = `${mFailedPublish[1]}@${mFailedPublish[2]}`;
            const reason = mFailedPublish[3].trim();
            if (!failed.some((f) => f.pkg === pkg && f.reason === reason)) failed.push({ pkg, reason });
          }
        }
      };

      const formatReleaseSummary = () => [
        "Release summary:",
        "Published:",
        `  - First publish: ${firstRelease.length ? firstRelease.join(", ") : "none"}`,
        `  - Updated: ${updated.length ? updated.join(", ") : "none"}`,
        "Skipped:",
        `  - Already published: ${skipped.length ? skipped.join(", ") : "none"}`,
        "Failed:",
        `  - ${failed.length ? failed.map((f) => `${f.pkg}: ${f.reason}`).join(" | ") : "none"}`,
      ].join("\n");

      for (const [index, target] of selectedPublishTargets.entries()) {
        const publishCommand = releaseScriptCommand(ctx.cwd, "release-workflow.sh", ["--publish", "--target", target.target]);
        setPhase(`Release publishing ${index + 1}/${selectedPublishTargets.length}: ${target.target}`);
        notifyProgress(`Running release-workflow.sh --publish --target ${target.target}...`, "info");
        appendOutput(`\n==> Publishing target ${index + 1}/${selectedPublishTargets.length}: ${target.target} (${target.label})\n`);
        appendOutput(`$ ${publishCommand}\n`);
        const publish = await runScriptLive(ctx.cwd, publishCommand, appendOutput, (child) => { currentChild = child; });
        currentChild = undefined;

        if (publish.aborted) {
          const logPath = finishLog("aborted-publish", `target=${target.target}`);
          closeReleaseUi();
          ctx.ui.notify(`Release workflow aborted.${logPath ? ` Log: ${logPath}` : ""}`, "warning");
          if (ctx.hasUI) ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("warning", "Release:Aborted"));
          return;
        }

        if (!publish.ok) {
          const logPath = finishLog("failed-publish", `target=${target.target}`);
          ctx.ui.notify(`release-workflow publish step failed for ${target.target}.${logPath ? ` Log: ${logPath}` : ""}`, "error");
          if (ctx.hasUI) ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("error", "Release:Failed"));
          closeReleaseUi();
          evaluateFailureWithLLM(pi, `release-workflow.sh --publish --target ${target.target}`, publish.output);
          return;
        }

        parsePublishOutput(publish.output);
      }

      if (ctx.hasUI) {
        ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("success", "Release:OK"));
        ctx.ui.setWidget(RELEASE_STATUS_KEY, undefined);
      }
      closeReleaseUi();
      const finalSummary = formatReleaseSummary();
      const logPath = finishLog("completed", finalSummary);
      ctx.ui.notify(`${finalSummary}\nRelease flow completed successfully.${logPath ? `\nLog: ${logPath}` : ""}`, "success");
      })().catch((error: unknown) => {
        cleanupReleaseUi?.();
        activeReleaseRun = undefined;
        if (ctx.hasUI) {
          ctx.ui.setWidget(RELEASE_OUTPUT_KEY, undefined);
          ctx.ui.setWidget(RELEASE_FOOTER_KEY, undefined);
          ctx.ui.setStatus(RELEASE_STATUS_KEY, ctx.ui.theme.fg("error", "Release:Failed"));
        }
        const message = error instanceof Error ? error.message : String(error);
        const logPath = saveReleaseRunLog(runLog, "crashed", message);
        ctx.ui.notify(`Release workflow crashed: ${message}${logPath ? ` Log: ${logPath}` : ""}`, "error");
      });
    },
  });
}
