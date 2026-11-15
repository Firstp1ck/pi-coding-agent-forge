import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { terminateProcessTree } from "../process-tree.mjs";
import { consumeAppRunnerTerminalChunk } from "../app-runner-terminal.mjs";

const APP_RUNNER_CONFIG_FILE = ".pi-webui-runners.json";
const APP_RUNNER_CUSTOM_LIMIT = 48;
const APP_RUNNER_CUSTOM_ARG_LIMIT = 32;
const APP_RUNNER_SEARCH_PATH_LIMIT = 24;
const APP_RUNNER_SEARCH_PATH_MAX_CHARS = 4_096;
const APP_RUNNER_FILE_PICKER_LIMIT = 500;
const APP_RUNNER_DETECTION_TIMEOUT_MS = 1_200;
const APP_RUNNER_COMMAND_CACHE_TTL_MS = 30_000;
const APP_RUNNER_OUTPUT_LINE_LIMIT = 1_000;
const APP_RUNNER_OUTPUT_MAX_CHARS = 240_000;
const APP_RUNNER_INPUT_MAX_CHARS = 16_000;
const APP_RUNNER_CONTEXT_DEFAULT_LINES = 80;
const APP_RUNNER_CONTEXT_MAX_LINES = APP_RUNNER_OUTPUT_LINE_LIMIT;
const APP_RUNNER_STOP_GRACE_MS = 2_500;
const APP_RUNNER_PTY_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const APP_RUNNER_PTY_SCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
const APP_RUNNER_PYTHON_ENTRIES = ["Main.py", "main.py", "src/main.py", "src/Main.py", "app.py", "src/app.py"];
const APP_RUNNER_JS_ENTRIES = ["main.js", "src/main.js", "index.js", "src/index.js", "server.js", "src/server.js", "app.js", "src/app.js"];
const APP_RUNNER_ZIG_ENTRIES = ["src/main.zig", "main.zig"];
const APP_RUNNER_C_ENTRIES = ["main.c", "src/main.c"];
const APP_RUNNER_CPP_ENTRIES = ["main.cpp", "src/main.cpp", "main.cc", "src/main.cc", "main.cxx", "src/main.cxx"];
const APP_RUNNER_DOCKER_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const APP_RUNNER_SHELL_SCRIPT_DIRS = ["", "dev", "scripts", "dev/scripts"];
const APP_RUNNER_SHELL_SCRIPT_LIMIT = 24;
const APP_RUNNER_PYTHON_SCRIPT_LIMIT = 24;
const APP_RUNNER_CONFIGURED_SCRIPT_SCAN_LIMIT = (APP_RUNNER_SHELL_SCRIPT_LIMIT + APP_RUNNER_PYTHON_SCRIPT_LIMIT) * 2;
const APP_RUNNER_SHELL_EXTENSIONS = new Map([
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "zsh"],
  [".fish", "fish"],
]);

function formatCommandForDisplay(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/**
 * Create one runner owner per server. Runs and timers stay on the supplied tab
 * records; the caller stops them when a tab, cwd or server is retired.
 */
export function createAppRunnerService({
  defaultCwd,
  runCommand,
  resolveCwd,
  normalizeSuggestionPath,
  readJsonFileIfExists,
  makeHttpError,
  formatCliError,
  sanitizeError,
  displayPath,
  stripAnsi,
  hasTab,
  broadcastTabEvent,
  tabActivitySnapshot,
  recordEvent,
  sendWebuiHelperCommand,
}) {
  const appRunnerCommandAvailability = new Map();
  let appRunnerPtyScriptAvailability = { available: false, expiresAt: 0 };
  let appRunnerNodePtyPromise = null;

  async function fileStatsIfExists(filePath) {
    try {
      return await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    }
  }

  async function appRunnerFileExists(cwd, relativePath) {
    const stats = await fileStatsIfExists(path.join(cwd, relativePath));
    return !!stats?.isFile();
  }

  async function appRunnerDirectoryExists(cwd, relativePath) {
    const stats = await fileStatsIfExists(path.join(cwd, relativePath));
    return !!stats?.isDirectory();
  }

  async function appRunnerTextIfExists(cwd, relativePath, maxLength = 120_000) {
    try {
      const text = await readFile(path.join(cwd, relativePath), "utf8");
      return text.slice(0, maxLength);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
      return "";
    }
  }

  async function appRunnerFilePrefix(filePath, maxLength = 256) {
    let handle;
    try {
      handle = await open(filePath, "r");
      const buffer = Buffer.alloc(maxLength);
      const { bytesRead } = await handle.read(buffer, 0, maxLength, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function firstExistingRunnerFile(cwd, candidates) {
    for (const candidate of candidates) {
      if (await appRunnerFileExists(cwd, candidate)) return candidate;
    }
    return "";
  }

  async function appRunnerCommandAvailable(command, cwd) {
    const name = String(command || "").trim();
    if (!name) return false;
    const key = `${name}\0${cwd || ""}`;
    const cached = appRunnerCommandAvailability.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.available;

    const result = await runCommand(name, ["--version"], {
      cwd,
      timeoutMs: APP_RUNNER_DETECTION_TIMEOUT_MS,
      maxOutputLength: 2_000,
    });
    const available = !result.error && !result.timedOut && (result.exitCode === 0 || Boolean(result.stdout || result.stderr));
    appRunnerCommandAvailability.set(key, { available, expiresAt: now + APP_RUNNER_COMMAND_CACHE_TTL_MS });
    return available;
  }

  function appRunnerPtyDisabled() {
    return APP_RUNNER_PTY_DISABLED_VALUES.has(String(process.env.PI_WEBUI_APP_RUNNER_PTY || "").trim().toLowerCase());
  }

  async function appRunnerWindowsPty() {
    if (process.platform !== "win32" || appRunnerPtyDisabled()) return null;
    if (!appRunnerNodePtyPromise) {
      appRunnerNodePtyPromise = import("node-pty")
        .then((module) => module?.spawn ? module : module?.default?.spawn ? module.default : null)
        .catch(() => null);
    }
    return appRunnerNodePtyPromise;
  }

  async function resolveWindowsAppRunnerExecutable(command, cwd) {
    const value = String(command || "").trim();
    if (process.platform !== "win32" || !value) return value;
    const hasDirectory = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
    const bases = hasDirectory
      ? [path.isAbsolute(value) ? value : path.resolve(cwd, value)]
      : String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, value));
    const extensions = path.extname(value)
      ? [""]
      : String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => extension.toLowerCase()).concat("");
    for (const base of bases) {
      for (const extension of extensions) {
        const candidate = `${base}${extension}`;
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Keep searching PATH/PATHEXT.
        }
      }
    }
    return value;
  }

  async function appRunnerScriptPtyAvailable(cwd) {
    if (process.platform === "win32" || appRunnerPtyDisabled()) return false;
    const now = Date.now();
    if (appRunnerPtyScriptAvailability.expiresAt > now) return appRunnerPtyScriptAvailability.available;
    const result = await runCommand("script", ["--version"], {
      cwd,
      timeoutMs: APP_RUNNER_DETECTION_TIMEOUT_MS,
      maxOutputLength: 4_000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const available = !result.error && !result.timedOut && /util-linux/i.test(output);
    appRunnerPtyScriptAvailability = { available, expiresAt: now + APP_RUNNER_PTY_SCRIPT_CACHE_TTL_MS };
    return available;
  }

  function appRunnerPackageScripts(pkg) {
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  }

  function preferredPackageScript(pkg) {
    const scripts = appRunnerPackageScripts(pkg);
    for (const script of ["dev", "start", "serve"]) {
      if (typeof scripts[script] === "string" && scripts[script].trim()) return script;
    }
    return "";
  }

  function packageDependencyNames(pkg) {
    return new Set([
      ...Object.keys(pkg?.dependencies || {}),
      ...Object.keys(pkg?.devDependencies || {}),
      ...Object.keys(pkg?.optionalDependencies || {}),
    ]);
  }

  function appRunnerId(...parts) {
    return parts
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(":")
      .replace(/[^a-z0-9_.:-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160);
  }

  function shellQuote(value) {
    return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
  }

  function appRunnerShellCommandLine(command, args = []) {
    return [command, ...args].map(shellQuote).join(" ");
  }

  async function spawnAppRunnerChild(run) {
    const baseOptions = {
      cwd: run.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    const windowsPty = await appRunnerWindowsPty();
    if (windowsPty) {
      run.executionMode = "conpty";
      const command = await resolveWindowsAppRunnerExecutable(run.command, run.cwd);
      return windowsPty.spawn(command, run.args || [], {
        name: process.env.TERM || "xterm-256color",
        cols: Math.max(20, Number.parseInt(process.env.COLUMNS || "120", 10) || 120),
        rows: Math.max(5, Number.parseInt(process.env.LINES || "40", 10) || 40),
        cwd: run.cwd,
        env: process.env,
        useConpty: true,
      });
    }
    if (await appRunnerScriptPtyAvailable(run.cwd)) {
      run.executionMode = "pty";
      return spawn("script", [
        "-q",
        "-e",
        "-f",
        "-c",
        `stty -echo 2>/dev/null || true; exec ${appRunnerShellCommandLine(run.command, run.args || [])}`,
        "/dev/null",
      ], {
        ...baseOptions,
        env: {
          ...process.env,
          TERM: process.env.TERM || "xterm-256color",
          COLUMNS: process.env.COLUMNS || "120",
          LINES: process.env.LINES || "40",
        },
      });
    }
    run.executionMode = "pipe";
    return spawn(run.command, run.args || [], baseOptions);
  }

  function appRunnerCandidate({ id, label, kind, command, args = [], projectFile = "", description = "", shortDisplayCommand = "", priority = 100, cwd = "", custom = false, configFile = "" }) {
    return {
      id,
      label,
      kind,
      command,
      args,
      displayCommand: formatCommandForDisplay(command, args),
      shortDisplayCommand,
      projectFile,
      description,
      priority,
      cwd,
      custom,
      configFile,
    };
  }

  function addAppRunner(runners, runner) {
    if (!runner?.id || !runner.command) return;
    if (runners.some((item) => item.id === runner.id)) return;
    const duplicateIndex = runners.findIndex((item) => item.displayCommand === runner.displayCommand);
    if (duplicateIndex >= 0) {
      if (runner.custom && !runners[duplicateIndex].custom) runners.splice(duplicateIndex, 1, runner);
      return;
    }
    runners.push(runner);
  }

  function appRunnerPathInside(root, target) {
    const relative = path.relative(root, target);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function normalizeAppRunnerSearchPath(value) {
    if (typeof value !== "string") throw makeHttpError(400, "Search path must be a string");
    const raw = normalizeSuggestionPath(value).trim();
    if (!raw) throw makeHttpError(400, "Search path is required");
    if (raw.includes("\0")) throw makeHttpError(400, "Search path cannot contain null bytes");
    if (raw.length > APP_RUNNER_SEARCH_PATH_MAX_CHARS) throw makeHttpError(400, `Search path is too long; limit is ${APP_RUNNER_SEARCH_PATH_MAX_CHARS} characters`);
    if (path.isAbsolute(raw) || /^[a-z]:\//i.test(raw)) throw makeHttpError(400, "Search path must be relative to the project root");
    if (raw === "." || /^\.\/+$/i.test(raw)) return ".";
    const normalized = raw.replace(/^\.\/+/, "").replace(/\/+$/g, "");
    if (!normalized) return ".";
    const parts = normalized.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) throw makeHttpError(400, "Search path cannot contain . or .. segments");
    return parts.join("/");
  }

  async function canonicalAppRunnerProjectRoot(projectRoot) {
    try {
      return await realpath(projectRoot);
    } catch (error) {
      throw makeHttpError(400, `Cannot resolve project root: ${formatCliError(error)}`);
    }
  }

  async function appRunnerSearchPathStatus(projectRoot, relativePath, canonicalProjectRoot) {
    const absolutePath = resolveProjectRelativePath(projectRoot, relativePath === "." ? "" : relativePath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { available: false, reason: `Search path does not exist: ${relativePath}` };
      return { available: false, reason: `Cannot access search path ${relativePath}: ${formatCliError(error)}` };
    }
    if (!appRunnerPathInside(canonicalProjectRoot, canonicalPath)) {
      return { available: false, reason: `Search path resolves outside the project root: ${relativePath}` };
    }
    const info = await fileStatsIfExists(canonicalPath).catch(() => null);
    if (!info?.isDirectory()) return { available: false, reason: `Search path is not a directory: ${relativePath}` };
    return { available: true, absolutePath, canonicalPath };
  }

  async function appRunnerCanonicalFileInsideProject(projectRoot, relativePath, canonicalProjectRoot) {
    let absolutePath;
    try {
      absolutePath = resolveProjectRelativePath(projectRoot, relativePath);
    } catch {
      return null;
    }
    let canonicalPath;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch {
      return null;
    }
    if (!appRunnerPathInside(canonicalProjectRoot, canonicalPath)) return null;
    const info = await fileStatsIfExists(canonicalPath).catch(() => null);
    return info?.isFile() ? { absolutePath, canonicalPath, info } : null;
  }

  function normalizeProjectRelativePath(value, { allowEmpty = false } = {}) {
    const raw = normalizeSuggestionPath(value).replace(/\0/g, "").trim();
    const withoutDot = raw.replace(/^\.\/+/, "").replace(/\/+$/g, "");
    if (!withoutDot) {
      if (allowEmpty) return "";
      throw makeHttpError(400, "Path to file is required");
    }
    if (path.isAbsolute(withoutDot) || /^[a-z]:\//i.test(withoutDot)) throw makeHttpError(400, "Path must be relative to the project root");
    const parts = withoutDot.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) throw makeHttpError(400, "Path cannot contain . or .. segments");
    return parts.join("/").slice(0, 4096);
  }

  function resolveProjectRelativePath(projectRoot, relativePath) {
    const target = path.resolve(projectRoot, relativePath || ".");
    if (!appRunnerPathInside(projectRoot, target)) throw makeHttpError(400, "Path must stay inside the project root");
    return target;
  }

  async function findAppRunnerProjectRoot(cwd) {
    const start = await resolveCwd(cwd || defaultCwd, defaultCwd);
    let fallback = "";
    for (let current = start; current; current = path.dirname(current)) {
      if (await appRunnerFileExists(current, APP_RUNNER_CONFIG_FILE)) return current;
      if (!fallback && (await appRunnerFileExists(current, "package.json") || await appRunnerDirectoryExists(current, ".git"))) fallback = current;
      const parent = path.dirname(current);
      if (parent === current) break;
    }
    return fallback || start;
  }

  function cleanCustomRunnerCommand(value) {
    const command = String(value || "./").trim().replace(/\s+/g, " ") || "./";
    if (command.includes("\0") || /[\r\n]/.test(command)) throw makeHttpError(400, "Command cannot contain newlines or null bytes");
    if (command.length > 512) throw makeHttpError(400, "Command is too long");
    return command === "." ? "./" : command;
  }

  function customRunnerCommandParts(command) {
    const clean = cleanCustomRunnerCommand(command);
    return clean === "./" ? ["./"] : clean.split(" ").filter(Boolean);
  }

  function parseCustomRunnerArgs(value) {
    const rawItems = Array.isArray(value)
      ? value
      : String(value || "").trim()
        ? String(value || "").trim().split(/\s+/)
        : [];
    const args = [];
    for (const item of rawItems) {
      const text = String(item || "").trim();
      if (!text) continue;
      if (text.includes("\0") || /[\r\n]/.test(text)) throw makeHttpError(400, "Args cannot contain newlines or null bytes");
      if (text.length > 2048) throw makeHttpError(400, "One arg is too long");
      args.push(text);
      if (args.length > APP_RUNNER_CUSTOM_ARG_LIMIT) throw makeHttpError(400, `Too many args; limit is ${APP_RUNNER_CUSTOM_ARG_LIMIT}`);
    }
    return args;
  }

  function publicCustomRunnerDefinition(runner) {
    const command = cleanCustomRunnerCommand(runner.command);
    const args = parseCustomRunnerArgs(runner.args);
    const filePath = normalizeProjectRelativePath(runner.path || runner.projectFile);
    const commandParts = customRunnerCommandParts(command);
    const effectiveCommand = command === "./" ? `./${filePath}` : commandParts[0];
    const effectiveArgs = command === "./" ? args : [...commandParts.slice(1), filePath, ...args];
    return {
      id: runner.id,
      label: runner.label,
      command,
      path: filePath,
      args,
      displayCommand: formatCommandForDisplay(effectiveCommand, effectiveArgs),
    };
  }

  function normalizeCustomRunnerDefinition(raw, projectRoot, { strict = false } = {}) {
    const filePath = normalizeProjectRelativePath(raw?.path || raw?.projectFile);
    const absolutePath = resolveProjectRelativePath(projectRoot, filePath);
    const command = cleanCustomRunnerCommand(raw?.command);
    const args = parseCustomRunnerArgs(raw?.args);
    const label = String(raw?.label || path.basename(filePath)).trim().slice(0, 120) || path.basename(filePath);
    const rawId = String(raw?.id || "").trim();
    const id = appRunnerId(rawId) || appRunnerId(label, command, filePath) || appRunnerId(command, filePath);
    if (!id) throw makeHttpError(400, "Custom runner id could not be generated");
    if (strict && !appRunnerPathInside(projectRoot, absolutePath)) throw makeHttpError(400, "Path must stay inside the project root");
    return { id, label, command, path: filePath, args };
  }

  function customAppRunnerDiagnostic(severity, message, runner = {}) {
    const source = runner && typeof runner === "object" ? runner : {};
    return {
      severity,
      message,
      runnerId: source.id || "",
      runnerLabel: source.label || "",
      path: source.path || source.projectFile || "",
    };
  }

  function directCustomRunnerUnavailableReason(filePath, stats) {
    if (process.platform !== "win32" && stats && (stats.mode & 0o111) === 0) {
      return `Path is not executable: ${filePath}. Run chmod +x ${filePath} or set Command to bash, python3, node, etc.`;
    }
    return "";
  }

  async function customAppRunnerUnavailableReason(projectRoot, runner) {
    const filePath = runner.path;
    const canonicalProjectRoot = await canonicalAppRunnerProjectRoot(projectRoot);
    const file = await appRunnerCanonicalFileInsideProject(projectRoot, filePath, canonicalProjectRoot);
    if (!file) {
      const absolutePath = resolveProjectRelativePath(projectRoot, filePath);
      const info = await fileStatsIfExists(absolutePath).catch(() => null);
      if (info?.isFile()) return `Path resolves outside the project root: ${filePath}`;
      return `Path to file does not exist: ${filePath}`;
    }
    const command = cleanCustomRunnerCommand(runner.command);
    const directReason = command === "./" ? directCustomRunnerUnavailableReason(filePath, file.info) : "";
    if (directReason) return directReason;
    const commandParts = customRunnerCommandParts(command);
    if (command !== "./" && !await appRunnerCommandAvailable(commandParts[0], projectRoot)) return `Command is not available: ${commandParts[0]}`;
    return "";
  }

  function appRunnerSearchPathDiagnostic(severity, message, pathValue) {
    return customAppRunnerDiagnostic(severity, message, { path: pathValue });
  }

  async function normalizeAppRunnerSearchPaths(rawSearchPaths, projectRoot, { requireDirectories = false, diagnostics = null } = {}) {
    if (!Array.isArray(rawSearchPaths)) throw makeHttpError(400, `${APP_RUNNER_CONFIG_FILE} searchPaths must be an array`);
    if (rawSearchPaths.length > APP_RUNNER_SEARCH_PATH_LIMIT) {
      throw makeHttpError(400, `Search path limit reached (${APP_RUNNER_SEARCH_PATH_LIMIT})`);
    }
    const canonicalProjectRoot = await canonicalAppRunnerProjectRoot(projectRoot);
    const searchPaths = [];
    const availableSearchPaths = [];
    const seen = new Set();
    for (const rawPath of rawSearchPaths) {
      let searchPath;
      try {
        searchPath = normalizeAppRunnerSearchPath(rawPath);
      } catch (error) {
        if (!diagnostics) throw error;
        diagnostics.push(appRunnerSearchPathDiagnostic("error", `Invalid search path ignored: ${formatCliError(error)}`, typeof rawPath === "string" ? rawPath : ""));
        continue;
      }
      if (seen.has(searchPath)) {
        const message = `Duplicate search path ignored: ${searchPath}`;
        if (!diagnostics) throw makeHttpError(400, message);
        diagnostics.push(appRunnerSearchPathDiagnostic("warning", message, searchPath));
        continue;
      }
      seen.add(searchPath);
      searchPaths.push(searchPath);
      const status = await appRunnerSearchPathStatus(projectRoot, searchPath, canonicalProjectRoot);
      if (!status.available) {
        if (requireDirectories) throw makeHttpError(400, status.reason);
        diagnostics?.push(appRunnerSearchPathDiagnostic("warning", status.reason, searchPath));
        continue;
      }
      availableSearchPaths.push({ path: searchPath, ...status });
    }
    return { searchPaths, availableSearchPaths, canonicalProjectRoot };
  }

  async function readAppRunnerConfig(projectRoot, { strictRead = false } = {}) {
    const configPath = path.join(projectRoot, APP_RUNNER_CONFIG_FILE);
    let source = {};
    const diagnostics = [];
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        source = parsed;
      } else {
        const message = `${APP_RUNNER_CONFIG_FILE} must contain a JSON object`;
        if (strictRead) throw makeHttpError(400, message);
        diagnostics.push(customAppRunnerDiagnostic("error", message));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const message = `Cannot read ${APP_RUNNER_CONFIG_FILE}: ${formatCliError(error)}`;
        if (strictRead) throw makeHttpError(400, message);
        diagnostics.push(customAppRunnerDiagnostic("error", message));
        console.warn(`failed to read custom app runner config ${configPath}: ${sanitizeError(error)}`);
      }
    }
    if (source.runners !== undefined && !Array.isArray(source.runners)) {
      const message = `${APP_RUNNER_CONFIG_FILE} runners must be an array`;
      if (strictRead) throw makeHttpError(400, message);
      diagnostics.push(customAppRunnerDiagnostic("error", message));
    }
    if (source.searchPaths !== undefined && !Array.isArray(source.searchPaths)) {
      const message = `${APP_RUNNER_CONFIG_FILE} searchPaths must be an array`;
      if (strictRead) throw makeHttpError(400, message);
      diagnostics.push(appRunnerSearchPathDiagnostic("error", message, ""));
    }
    const rawRunners = Array.isArray(source.runners) ? source.runners : [];
    const runners = [];
    for (const raw of rawRunners) {
      try {
        const runner = normalizeCustomRunnerDefinition(raw, projectRoot);
        if (runners.some((item) => item.id === runner.id)) {
          diagnostics.push(customAppRunnerDiagnostic("warning", `Duplicate custom runner ignored: ${runner.label || runner.path || runner.id}`, runner));
        } else {
          runners.push(runner);
        }
      } catch (error) {
        const message = `Invalid custom runner ignored: ${formatCliError(error)}`;
        diagnostics.push(customAppRunnerDiagnostic("error", message, raw));
        console.warn(`skipping invalid custom app runner in ${configPath}: ${sanitizeError(error)}`);
      }
      if (runners.length >= APP_RUNNER_CUSTOM_LIMIT) break;
    }
    let searchPathData = { searchPaths: [], availableSearchPaths: [], canonicalProjectRoot: await canonicalAppRunnerProjectRoot(projectRoot) };
    if (Array.isArray(source.searchPaths)) {
      try {
        searchPathData = await normalizeAppRunnerSearchPaths(source.searchPaths, projectRoot, { diagnostics });
      } catch (error) {
        const message = `Invalid search paths ignored: ${formatCliError(error)}`;
        if (strictRead) throw makeHttpError(400, message);
        diagnostics.push(appRunnerSearchPathDiagnostic("error", message, ""));
      }
    }
    return { projectRoot, configPath, runners, diagnostics, ...searchPathData };
  }

  async function writeAppRunnerConfig(projectRoot, runners, searchPaths = []) {
    const configPath = path.join(projectRoot, APP_RUNNER_CONFIG_FILE);
    const normalizedRunners = [];
    for (const runner of runners) {
      normalizedRunners.push(normalizeCustomRunnerDefinition(runner, projectRoot, { strict: true }));
      if (normalizedRunners.length >= APP_RUNNER_CUSTOM_LIMIT) break;
    }
    const { searchPaths: normalizedSearchPaths } = await normalizeAppRunnerSearchPaths(searchPaths, projectRoot);
    const tmpFile = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpFile, `${JSON.stringify({ version: 2, searchPaths: normalizedSearchPaths, runners: normalizedRunners }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpFile, configPath);
    return { projectRoot, configPath, runners: normalizedRunners, searchPaths: normalizedSearchPaths };
  }

  async function customAppRunnerCandidate(projectRoot, configPath, runner) {
    const filePath = runner.path;
    if (await customAppRunnerUnavailableReason(projectRoot, runner)) return null;
    const command = cleanCustomRunnerCommand(runner.command);
    const args = parseCustomRunnerArgs(runner.args);
    const commandParts = customRunnerCommandParts(command);
    const effectiveCommand = command === "./" ? `./${filePath}` : commandParts[0];
    const effectiveArgs = command === "./" ? args : [...commandParts.slice(1), filePath, ...args];
    return appRunnerCandidate({
      id: appRunnerId("custom", runner.id),
      label: runner.label || path.basename(filePath),
      kind: "custom",
      command: effectiveCommand,
      args: effectiveArgs,
      projectFile: filePath,
      description: `Custom project runner from ${APP_RUNNER_CONFIG_FILE}`,
      priority: 8,
      cwd: projectRoot,
      custom: true,
      configFile: configPath,
    });
  }

  async function addCustomAppRunners(runners, cwd) {
    const projectRoot = await findAppRunnerProjectRoot(cwd);
    const config = await readAppRunnerConfig(projectRoot);
    for (const runner of config.runners) {
      const candidate = await customAppRunnerCandidate(projectRoot, config.configPath, runner);
      if (candidate) addAppRunner(runners, candidate);
    }
  }

  async function getCustomAppRunnerConfigData(tab) {
    const projectRoot = await findAppRunnerProjectRoot(tab?.cwd || defaultCwd);
    const config = await readAppRunnerConfig(projectRoot);
    const runners = [];
    for (const runner of config.runners) {
      const unavailableReason = await customAppRunnerUnavailableReason(projectRoot, runner);
      runners.push({
        ...publicCustomRunnerDefinition(runner),
        available: !unavailableReason,
        unavailableReason,
      });
    }
    return {
      version: 2,
      projectRoot,
      displayProjectRoot: displayPath(projectRoot),
      configFile: config.configPath,
      displayConfigFile: displayPath(config.configPath),
      relativeConfigFile: APP_RUNNER_CONFIG_FILE,
      searchPaths: config.searchPaths,
      runners,
      diagnostics: config.diagnostics,
    };
  }

  async function saveCustomAppRunner(tab, rawRunner) {
    const projectRoot = await findAppRunnerProjectRoot(tab?.cwd || defaultCwd);
    const config = await readAppRunnerConfig(projectRoot, { strictRead: true });
    const normalized = normalizeCustomRunnerDefinition(rawRunner, projectRoot, { strict: true });
    const unavailableReason = await customAppRunnerUnavailableReason(projectRoot, normalized);
    if (unavailableReason) throw makeHttpError(400, unavailableReason);
    const runners = config.runners.filter((runner) => runner.id !== normalized.id);
    if (runners.length >= APP_RUNNER_CUSTOM_LIMIT) throw makeHttpError(400, `Custom runner limit reached (${APP_RUNNER_CUSTOM_LIMIT})`);
    runners.push(normalized);
    await writeAppRunnerConfig(projectRoot, runners, config.searchPaths);
    return getAppRunnerData(tab);
  }

  async function saveAppRunnerSearchPaths(tab, rawSearchPaths) {
    const projectRoot = await findAppRunnerProjectRoot(tab?.cwd || defaultCwd);
    const config = await readAppRunnerConfig(projectRoot, { strictRead: true });
    const { searchPaths } = await normalizeAppRunnerSearchPaths(rawSearchPaths, projectRoot, { requireDirectories: true });
    await writeAppRunnerConfig(projectRoot, config.runners, searchPaths);
    return getAppRunnerData(tab);
  }

  async function deleteCustomAppRunner(tab, runnerId) {
    const id = appRunnerId(String(runnerId || "").replace(/^custom:/, ""));
    if (!id) throw makeHttpError(400, "Custom runner id is required");
    const projectRoot = await findAppRunnerProjectRoot(tab?.cwd || defaultCwd);
    const config = await readAppRunnerConfig(projectRoot);
    const runners = config.runners.filter((runner) => runner.id !== id);
    if (runners.length === config.runners.length) throw makeHttpError(404, "Custom runner not found");
    await writeAppRunnerConfig(projectRoot, runners, config.searchPaths);
    return getAppRunnerData(tab);
  }

  async function getAppRunnerFileBrowserData(tab, rawPath) {
    const projectRoot = await findAppRunnerProjectRoot(tab?.cwd || defaultCwd);
    const relativeDir = normalizeProjectRelativePath(rawPath || "", { allowEmpty: true });
    const absoluteDir = resolveProjectRelativePath(projectRoot, relativeDir || ".");
    const stats = await fileStatsIfExists(absoluteDir);
    if (!stats?.isDirectory()) throw makeHttpError(400, `Not a directory inside project root: ${relativeDir || "."}`);
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw makeHttpError(error?.code === "EACCES" ? 403 : 400, `Cannot read directory ${relativeDir || "."}: ${sanitizeError(error)}`);
    }
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    const directories = [];
    const files = [];
    for (const entry of sorted) {
      if (entry.name === ".git") continue;
      const entryRelativePath = normalizeSuggestionPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (entry.isDirectory()) directories.push({ name: entry.name, path: entryRelativePath, hidden: entry.name.startsWith(".") });
      else if (entry.isFile()) files.push({ name: entry.name, path: entryRelativePath, hidden: entry.name.startsWith(".") });
      if (directories.length + files.length >= APP_RUNNER_FILE_PICKER_LIMIT) break;
    }
    const parent = relativeDir ? normalizeSuggestionPath(path.posix.dirname(relativeDir)) : "";
    return {
      projectRoot,
      displayProjectRoot: displayPath(projectRoot),
      relativeDir,
      displayRelativeDir: relativeDir || ".",
      parent: relativeDir && parent !== "." ? parent : relativeDir ? "" : null,
      directories,
      files,
      truncated: sorted.length > directories.length + files.length,
    };
  }

  function packageManagerArgs(manager, script) {
    if (manager === "bun") return ["run", script];
    if (manager === "yarn") return script === "start" ? ["start"] : [script];
    return script === "start" ? ["start"] : ["run", script];
  }

  async function addPackageManagerRunners(runners, cwd, pkg) {
    const script = preferredPackageScript(pkg);
    if (!script) return;
    const packageManager = String(pkg?.packageManager || "").toLowerCase();
    const [hasBunLock, hasPnpmLock, hasYarnLock, hasPackageLock] = await Promise.all([
      appRunnerFileExists(cwd, "bun.lock").then((exists) => exists || appRunnerFileExists(cwd, "bun.lockb")),
      appRunnerFileExists(cwd, "pnpm-lock.yaml"),
      appRunnerFileExists(cwd, "yarn.lock"),
      appRunnerFileExists(cwd, "package-lock.json"),
    ]);
    const managers = [
      { id: "bun", command: "bun", label: "Bun", hint: hasBunLock || packageManager.startsWith("bun@"), priority: hasBunLock || packageManager.startsWith("bun@") ? 20 : 54 },
      { id: "pnpm", command: "pnpm", label: "pnpm", hint: hasPnpmLock || packageManager.startsWith("pnpm@"), priority: hasPnpmLock || packageManager.startsWith("pnpm@") ? 24 : 58 },
      { id: "npm", command: "npm", label: "npm", hint: hasPackageLock || packageManager.startsWith("npm@") || !packageManager, priority: hasPackageLock || packageManager.startsWith("npm@") || !packageManager ? 28 : 62 },
      { id: "yarn", command: "yarn", label: "Yarn", hint: hasYarnLock || packageManager.startsWith("yarn@"), priority: hasYarnLock || packageManager.startsWith("yarn@") ? 34 : 72 },
    ];

    for (const manager of managers) {
      if (!await appRunnerCommandAvailable(manager.command, cwd)) continue;
      const args = packageManagerArgs(manager.id, script);
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("pkg", manager.id, script),
        label: `${manager.label} ${script}`,
        kind: manager.id === "bun" ? "bun" : "node",
        command: manager.command,
        args,
        projectFile: "package.json",
        description: `${manager.label} package script: ${script}`,
        priority: manager.priority + (manager.hint ? 0 : 12),
      }));
    }
  }

  async function addNpxFrameworkRunners(runners, cwd, pkg) {
    const dependencyNames = packageDependencyNames(pkg);
    if (!dependencyNames.size || !await appRunnerCommandAvailable("npx", cwd)) return;
    const frameworks = [
      { dep: "vite", label: "npx vite", args: ["--no-install", "vite"], priority: 78 },
      { dep: "next", label: "npx next dev", args: ["--no-install", "next", "dev"], priority: 80 },
      { dep: "astro", label: "npx astro dev", args: ["--no-install", "astro", "dev"], priority: 82 },
      { dep: "@storybook/react", label: "npx storybook dev", args: ["--no-install", "storybook", "dev"], priority: 86 },
      { dep: "storybook", label: "npx storybook dev", args: ["--no-install", "storybook", "dev"], priority: 86 },
    ];
    for (const framework of frameworks) {
      if (!dependencyNames.has(framework.dep)) continue;
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("npx", framework.dep),
        label: framework.label,
        kind: "node",
        command: "npx",
        args: framework.args,
        projectFile: "package.json",
        description: `Detected ${framework.dep} dependency`,
        priority: framework.priority,
      }));
    }
  }

  async function addNodeEntrypointRunner(runners, cwd, hasPackageJson) {
    if (hasPackageJson) return;
    const entry = await firstExistingRunnerFile(cwd, APP_RUNNER_JS_ENTRIES);
    if (!entry || !await appRunnerCommandAvailable("node", cwd)) return;
    addAppRunner(runners, appRunnerCandidate({
      id: appRunnerId("node", entry),
      label: `node ${entry}`,
      kind: "node",
      command: "node",
      args: [entry],
      projectFile: entry,
      description: "Detected JavaScript entry file",
      priority: 88,
    }));
  }

  async function addPythonRunners(runners, cwd) {
    const entry = await firstExistingRunnerFile(cwd, APP_RUNNER_PYTHON_ENTRIES);
    if (!entry) return;
    if (await appRunnerCommandAvailable("uv", cwd)) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("python", "uv", entry),
        label: `uv run ${entry}`,
        kind: "python",
        command: "uv",
        args: ["run", entry],
        projectFile: entry,
        description: "Detected Python entry file",
        priority: 36,
      }));
    }
    const pythonCommand = await appRunnerCommandAvailable("python3", cwd) ? "python3" : await appRunnerCommandAvailable("python", cwd) ? "python" : "";
    if (pythonCommand) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("python", pythonCommand, entry),
        label: `${pythonCommand} ${entry}`,
        kind: "python",
        command: pythonCommand,
        args: [entry],
        projectFile: entry,
        description: "Detected Python entry file",
        priority: 68,
      }));
    }
  }

  async function addRustRunner(runners, cwd) {
    if (!await appRunnerFileExists(cwd, "Cargo.toml") || !await appRunnerCommandAvailable("cargo", cwd)) return;
    addAppRunner(runners, appRunnerCandidate({
      id: "rust:cargo-run",
      label: "cargo run",
      kind: "rust",
      command: "cargo",
      args: ["run"],
      projectFile: "Cargo.toml",
      description: "Detected Rust Cargo project",
      priority: 18,
    }));
  }

  async function goRunTarget(cwd) {
    if (await appRunnerFileExists(cwd, "main.go")) return ".";
    if (await appRunnerDirectoryExists(cwd, "cmd")) {
      const entries = await readdir(path.join(cwd, "cmd"), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        if (await appRunnerFileExists(cwd, path.join("cmd", entry.name, "main.go"))) return `./cmd/${entry.name}`;
      }
    }
    return await appRunnerFileExists(cwd, "go.mod") ? "." : "";
  }

  async function addGoRunner(runners, cwd) {
    const target = await goRunTarget(cwd);
    if (!target || !await appRunnerCommandAvailable("go", cwd)) return;
    addAppRunner(runners, appRunnerCandidate({
      id: appRunnerId("go", target),
      label: `go run ${target}`,
      kind: "go",
      command: "go",
      args: ["run", target],
      projectFile: await appRunnerFileExists(cwd, "go.mod") ? "go.mod" : target,
      description: "Detected Go/Golang app entry",
      priority: 46,
    }));
  }

  function buildZigHasRunStep(text) {
    return /\.step\(\s*["']run["']/.test(String(text || ""));
  }

  async function addZigRunner(runners, cwd) {
    if (!await appRunnerCommandAvailable("zig", cwd)) return;
    const buildZig = await appRunnerTextIfExists(cwd, "build.zig");
    if (buildZig && buildZigHasRunStep(buildZig)) {
      addAppRunner(runners, appRunnerCandidate({
        id: "zig:build-run",
        label: "zig build run",
        kind: "zig",
        command: "zig",
        args: ["build", "run"],
        projectFile: "build.zig",
        description: "Detected Zig build.zig run step",
        priority: 44,
      }));
    }
    const entry = await firstExistingRunnerFile(cwd, APP_RUNNER_ZIG_ENTRIES);
    if (entry) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("zig", entry),
        label: `zig run ${entry}`,
        kind: "zig",
        command: "zig",
        args: ["run", entry],
        projectFile: entry,
        description: "Detected Zig app entry file",
        priority: 66,
      }));
    }
  }

  function firstCmakeExecutableTarget(text) {
    const match = String(text || "").match(/add_executable\s*\(\s*([A-Za-z0-9_.+-]+)/i);
    return match ? match[1] : "";
  }

  async function addCompiledLanguageRunner(runners, cwd, { language, kind, compiler, entry, outputName, priority }) {
    if (!entry || !await appRunnerCommandAvailable("sh", cwd) || !await appRunnerCommandAvailable(compiler, cwd)) return;
    const output = `.pi-webui-runner/${outputName}`;
    const compileAndRun = `mkdir -p .pi-webui-runner && ${compiler} ${shellQuote(entry)} -o ${shellQuote(output)} && ${shellQuote(`./${output}`)}`;
    addAppRunner(runners, appRunnerCandidate({
      id: appRunnerId(kind, entry),
      label: `${compiler} ${entry}`,
      kind,
      command: "sh",
      args: ["-lc", compileAndRun],
      projectFile: entry,
      description: `Detected ${language} app entry file`,
      priority,
    }));
  }

  async function addCppRunners(runners, cwd) {
    const cmakeText = await appRunnerTextIfExists(cwd, "CMakeLists.txt");
    const cmakeTarget = firstCmakeExecutableTarget(cmakeText);
    const hasShell = await appRunnerCommandAvailable("sh", cwd);
    if (cmakeTarget && hasShell && await appRunnerCommandAvailable("cmake", cwd)) {
      const configureBuildRun = `cmake -S . -B build && cmake --build build --target ${shellQuote(cmakeTarget)} && ${shellQuote(`./build/${cmakeTarget}`)}`;
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("cmake", cmakeTarget),
        label: `cmake run ${cmakeTarget}`,
        kind: "cpp",
        command: "sh",
        args: ["-lc", configureBuildRun],
        projectFile: "CMakeLists.txt",
        description: "Detected C/C++ CMake executable target",
        priority: 42,
      }));
      return;
    }

    await Promise.all([
      addCompiledLanguageRunner(runners, cwd, {
        language: "C",
        kind: "c",
        compiler: "cc",
        entry: await firstExistingRunnerFile(cwd, APP_RUNNER_C_ENTRIES),
        outputName: "main-c",
        priority: 64,
      }),
      addCompiledLanguageRunner(runners, cwd, {
        language: "C++",
        kind: "cpp",
        compiler: "c++",
        entry: await firstExistingRunnerFile(cwd, APP_RUNNER_CPP_ENTRIES),
        outputName: "main-cpp",
        priority: 65,
      }),
    ]);
  }

  async function dockerComposePluginAvailable(cwd) {
    const result = await runCommand("docker", ["compose", "version"], {
      cwd,
      timeoutMs: APP_RUNNER_DETECTION_TIMEOUT_MS,
      maxOutputLength: 2_000,
    });
    return !result.error && !result.timedOut && result.exitCode === 0;
  }

  async function addDockerComposeRunner(runners, cwd) {
    const composeFile = await firstExistingRunnerFile(cwd, APP_RUNNER_DOCKER_COMPOSE_FILES);
    if (!composeFile) return;
    if (await appRunnerCommandAvailable("docker", cwd) && await dockerComposePluginAvailable(cwd)) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("docker-compose", composeFile),
        label: "docker compose up",
        kind: "docker",
        command: "docker",
        args: ["compose", "-f", composeFile, "up"],
        projectFile: composeFile,
        description: "Detected Docker Compose file",
        priority: 82,
      }));
    }
    if (await appRunnerCommandAvailable("docker-compose", cwd)) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("docker-compose-standalone", composeFile),
        label: "docker-compose up",
        kind: "docker",
        command: "docker-compose",
        args: ["-f", composeFile, "up"],
        projectFile: composeFile,
        description: "Detected Docker Compose file",
        priority: 84,
      }));
    }
  }

  function shellFromShebang(text) {
    const firstLine = String(text || "").split(/\r?\n/, 1)[0] || "";
    if (!firstLine.startsWith("#!")) return "";
    if (/\bfish\b/.test(firstLine)) return "fish";
    if (/\bzsh\b/.test(firstLine)) return "zsh";
    if (/\bbash\b/.test(firstLine)) return "bash";
    if (/\bsh\b/.test(firstLine)) return "bash";
    return "";
  }

  function pythonFromShebang(text) {
    const firstLine = String(text || "").split(/\r?\n/, 1)[0] || "";
    return firstLine.startsWith("#!") && /\bpython(?:3(?:\.\d+)?)?\b/i.test(firstLine);
  }

  function shellScriptPriority(relativePath, shell) {
    const base = path.basename(relativePath).replace(/\.(?:sh|bash|zsh|fish)$/i, "").toLowerCase();
    const directory = path.dirname(relativePath).replace(/\\/g, "/");
    const nameRank = ["dev", "start", "run", "serve", "server", "app", "main"].indexOf(base);
    const dirRank = APP_RUNNER_SHELL_SCRIPT_DIRS.indexOf(directory === "." ? "" : directory);
    const shellRank = shell === "bash" ? 0 : shell === "zsh" ? 1 : shell === "fish" ? 2 : 3;
    return 70 + (nameRank === -1 ? 18 : nameRank) + (dirRank === -1 ? 8 : dirRank) + shellRank / 10;
  }

  async function shellScriptRunnerForFile(cwd, relativePath, { canonicalProjectRoot = "", runnerCwd = "" } = {}) {
    let file;
    if (canonicalProjectRoot) {
      file = await appRunnerCanonicalFileInsideProject(cwd, relativePath, canonicalProjectRoot);
      if (!file) return null;
    }
    const extensionShell = APP_RUNNER_SHELL_EXTENSIONS.get(path.extname(relativePath).toLowerCase()) || "";
    let shell = extensionShell;
    if (!shell) {
      const text = file
        ? await appRunnerFilePrefix(file.canonicalPath)
        : await appRunnerTextIfExists(cwd, relativePath, 256);
      shell = shellFromShebang(text);
    }
    if (!shell || !await appRunnerCommandAvailable(shell, cwd)) return null;
    const fileName = path.basename(relativePath);
    const directory = path.dirname(relativePath);
    return appRunnerCandidate({
      id: appRunnerId("shell", shell, relativePath),
      label: fileName,
      kind: "shell",
      command: shell,
      args: [relativePath],
      projectFile: relativePath,
      description: `Detected ${shell} shell script${directory && directory !== "." ? ` in ${directory}` : ""}`,
      priority: shellScriptPriority(relativePath, shell),
      cwd: runnerCwd,
    });
  }

  async function pythonScriptRunnersForFile(cwd, relativePath, { canonicalProjectRoot, runnerCwd, uvAvailable, pythonCommand }) {
    if (!uvAvailable && !pythonCommand) return [];
    const file = await appRunnerCanonicalFileInsideProject(cwd, relativePath, canonicalProjectRoot);
    if (!file) return [];
    const extension = path.extname(relativePath).toLowerCase();
    if (extension !== ".py") {
      if (path.basename(relativePath).includes(".")) return [];
      const text = await appRunnerFilePrefix(file.canonicalPath);
      if (!pythonFromShebang(text)) return [];
    }
    const directory = path.dirname(relativePath);
    const descriptionSuffix = directory && directory !== "." ? ` in ${directory}` : "";
    const candidates = [];
    if (uvAvailable) {
      candidates.push(appRunnerCandidate({
        id: appRunnerId("python", "uv", relativePath),
        label: `uv run ${path.basename(relativePath)}`,
        kind: "python",
        command: "uv",
        args: ["run", relativePath],
        projectFile: relativePath,
        description: `Detected Python script${descriptionSuffix} from a configured project discovery path`,
        priority: 56,
        cwd: runnerCwd,
      }));
    }
    if (pythonCommand) {
      candidates.push(appRunnerCandidate({
        id: appRunnerId("python", pythonCommand, relativePath),
        label: `${pythonCommand} ${path.basename(relativePath)}`,
        kind: "python",
        command: pythonCommand,
        args: [relativePath],
        projectFile: relativePath,
        description: `Detected Python script${descriptionSuffix} from a configured project discovery path`,
        priority: 69,
        cwd: runnerCwd,
      }));
    }
    return candidates;
  }

  function shellScriptEntrySupported(entry) {
    const extension = path.extname(entry.name).toLowerCase();
    return APP_RUNNER_SHELL_EXTENSIONS.has(extension) || !entry.name.includes(".");
  }

  function configuredScriptEntrySupported(entry) {
    return shellScriptEntrySupported(entry) || path.extname(entry.name).toLowerCase() === ".py";
  }

  async function addConfiguredScriptRunners(runners, cwd) {
    const projectRoot = await findAppRunnerProjectRoot(cwd);
    const config = await readAppRunnerConfig(projectRoot);
    const [uvAvailable, python3Available, pythonAvailable] = await Promise.all([
      appRunnerCommandAvailable("uv", projectRoot),
      appRunnerCommandAvailable("python3", projectRoot),
      appRunnerCommandAvailable("python", projectRoot),
    ]);
    const pythonCommand = python3Available ? "python3" : pythonAvailable ? "python" : "";
    let pythonFilesAdded = 0;
    for (const directory of config.availableSearchPaths) {
      const shellLimitReached = runners.filter((item) => item.kind === "shell").length >= APP_RUNNER_SHELL_SCRIPT_LIMIT;
      if (shellLimitReached && pythonFilesAdded >= APP_RUNNER_PYTHON_SCRIPT_LIMIT) break;
      const entries = await readdir(directory.canonicalPath, { withFileTypes: true }).catch(() => []);
      const sortedEntries = entries
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && configuredScriptEntrySupported(entry))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
        .slice(0, APP_RUNNER_CONFIGURED_SCRIPT_SCAN_LIMIT);
      for (const entry of sortedEntries) {
        const relativePath = directory.path === "." ? entry.name : `${directory.path}/${entry.name}`;
        if (runners.filter((item) => item.kind === "shell").length < APP_RUNNER_SHELL_SCRIPT_LIMIT && shellScriptEntrySupported(entry)) {
          const shellRunner = await shellScriptRunnerForFile(projectRoot, relativePath, {
            canonicalProjectRoot: config.canonicalProjectRoot,
            runnerCwd: projectRoot,
          });
          if (shellRunner) addAppRunner(runners, shellRunner);
        }
        if (pythonFilesAdded < APP_RUNNER_PYTHON_SCRIPT_LIMIT && (path.extname(entry.name).toLowerCase() === ".py" || !entry.name.includes("."))) {
          const pythonRunners = await pythonScriptRunnersForFile(projectRoot, relativePath, {
            canonicalProjectRoot: config.canonicalProjectRoot,
            runnerCwd: projectRoot,
            uvAvailable,
            pythonCommand,
          });
          for (const pythonRunner of pythonRunners) addAppRunner(runners, pythonRunner);
          if (pythonRunners.length) pythonFilesAdded += 1;
        }
        if (runners.filter((item) => item.kind === "shell").length >= APP_RUNNER_SHELL_SCRIPT_LIMIT && pythonFilesAdded >= APP_RUNNER_PYTHON_SCRIPT_LIMIT) break;
      }
    }
  }

  async function addShellScriptRunners(runners, cwd) {
    const candidates = [];
    for (const directory of APP_RUNNER_SHELL_SCRIPT_DIRS) {
      const absoluteDirectory = path.join(cwd, directory || ".");
      const stats = await fileStatsIfExists(absoluteDirectory);
      if (!stats?.isDirectory()) continue;
      const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
        if (!shellScriptEntrySupported(entry)) continue;
        candidates.push(relativePath);
      }
    }

    for (const relativePath of candidates.slice(0, APP_RUNNER_SHELL_SCRIPT_LIMIT * 2)) {
      const runner = await shellScriptRunnerForFile(cwd, relativePath);
      if (runner) addAppRunner(runners, runner);
      if (runners.filter((item) => item.kind === "shell").length >= APP_RUNNER_SHELL_SCRIPT_LIMIT) break;
    }
    await addConfiguredScriptRunners(runners, cwd);
  }

  function firstTaskFromText(text, names) {
    for (const name of names) {
      const pattern = new RegExp(`^[\\s\"']*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\"']*[:=]`, "m");
      if (pattern.test(text)) return name;
    }
    return "";
  }

  async function addDenoRunner(runners, cwd) {
    const hasDenoConfig = await appRunnerFileExists(cwd, "deno.json") || await appRunnerFileExists(cwd, "deno.jsonc");
    if (!hasDenoConfig || !await appRunnerCommandAvailable("deno", cwd)) return;
    const configText = (await appRunnerTextIfExists(cwd, "deno.json")) || (await appRunnerTextIfExists(cwd, "deno.jsonc"));
    const task = firstTaskFromText(configText, ["dev", "start", "serve"]);
    if (task) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("deno", task),
        label: `deno task ${task}`,
        kind: "deno",
        command: "deno",
        args: ["task", task],
        projectFile: "deno.json",
        description: "Detected Deno task",
        priority: 52,
      }));
    }
  }

  async function addTaskFileRunners(runners, cwd) {
    const [justText, makeText] = await Promise.all([
      appRunnerTextIfExists(cwd, "justfile").then((text) => text || appRunnerTextIfExists(cwd, "Justfile")),
      appRunnerTextIfExists(cwd, "Makefile").then((text) => text || appRunnerTextIfExists(cwd, "makefile")),
    ]);
    const justTarget = firstTaskFromText(justText, ["dev", "run", "start"]);
    if (justTarget && await appRunnerCommandAvailable("just", cwd)) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("just", justTarget),
        label: `just ${justTarget}`,
        kind: "task",
        command: "just",
        args: [justTarget],
        projectFile: "Justfile",
        description: "Detected just recipe",
        priority: 74,
      }));
    }
    const makeTarget = firstTaskFromText(makeText, ["dev", "run", "start"]);
    if (makeTarget && await appRunnerCommandAvailable("make", cwd)) {
      addAppRunner(runners, appRunnerCandidate({
        id: appRunnerId("make", makeTarget),
        label: `make ${makeTarget}`,
        kind: "task",
        command: "make",
        args: [makeTarget],
        projectFile: "Makefile",
        description: "Detected Make target",
        priority: 76,
      }));
    }
  }

  function publicAppRunner(runner) {
    if (!runner) return null;
    const { priority: _priority, ...publicRunner } = runner;
    return publicRunner;
  }

  async function detectAppRunners(tab) {
    const cwd = tab?.cwd || defaultCwd;
    const runners = [];
    const pkg = await readJsonFileIfExists(path.join(cwd, "package.json"));
    await Promise.all([
      addCustomAppRunners(runners, cwd),
      addRustRunner(runners, cwd),
      pkg ? addPackageManagerRunners(runners, cwd, pkg) : Promise.resolve(),
      pkg ? addNpxFrameworkRunners(runners, cwd, pkg) : Promise.resolve(),
      addPythonRunners(runners, cwd),
      addGoRunner(runners, cwd),
      addZigRunner(runners, cwd),
      addCppRunners(runners, cwd),
      addDockerComposeRunner(runners, cwd),
      addShellScriptRunners(runners, cwd),
      addDenoRunner(runners, cwd),
      addTaskFileRunners(runners, cwd),
      addNodeEntrypointRunner(runners, cwd, !!pkg),
    ]);
    return runners
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
      .map(publicAppRunner);
  }

  function appRunnerPendingLine(run) {
    if (!run || run.status !== "running") return "";
    return [run.stdoutRemainder, run.stderrRemainder].map((part) => String(part || "")).filter(Boolean).join("");
  }

  function publicAppRunnerState(run) {
    if (!run) return null;
    return {
      id: run.id,
      runnerId: run.runnerId,
      kind: run.kind,
      label: run.label,
      command: run.command,
      args: run.args,
      displayCommand: run.displayCommand,
      cwd: run.cwd,
      pid: run.pid,
      status: run.status,
      executionMode: run.executionMode || "pipe",
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      stopping: run.stopping === true,
      truncated: run.truncated === true,
      lineCount: run.lineCount || run.lines?.length || 0,
      lines: Array.isArray(run.lines) ? [...run.lines] : [],
      pendingLine: appRunnerPendingLine(run),
      stdinClosed: run.stdinClosed === true,
      stdinError: run.stdinError || "",
      stdinWrites: run.stdinWrites || 0,
      lastStdinAt: run.lastStdinAt || "",
    };
  }

  async function getAppRunnerData(tab) {
    const [runners, customRunnerConfig] = await Promise.all([
      detectAppRunners(tab),
      getCustomAppRunnerConfigData(tab),
    ]);
    return {
      cwd: tab.cwd,
      runners,
      customRunnerConfig,
      activeRun: publicAppRunnerState(tab.appRunner),
    };
  }

  function appendAppRunnerLine(run, line) {
    if (!run) return;
    const text = String(line ?? "");
    run.lines.push(text);
    run.lineCount = (run.lineCount || 0) + 1;
    run.outputChars = (run.outputChars || 0) + text.length + 1;
    while (run.lines.length > APP_RUNNER_OUTPUT_LINE_LIMIT || run.outputChars > APP_RUNNER_OUTPUT_MAX_CHARS) {
      const removed = run.lines.shift();
      run.outputChars -= String(removed || "").length + 1;
      run.truncated = true;
    }
  }

  function appendAppRunnerChunk(tab, run, chunk, streamName) {
    if (!run || run.status !== "running") return;
    const key = streamName === "stderr" ? "stderrRemainder" : "stdoutRemainder";
    const carriageReturnKey = streamName === "stderr" ? "stderrCarriageReturnPending" : "stdoutCarriageReturnPending";
    const reduced = consumeAppRunnerTerminalChunk({
      line: run[key],
      carriageReturnPending: run[carriageReturnKey],
    }, chunk);
    run[key] = reduced.line;
    run[carriageReturnKey] = reduced.carriageReturnPending;
    for (const line of reduced.lines) appendAppRunnerLine(run, line);
    scheduleAppRunnerBroadcast(tab);
  }

  function flushAppRunnerRemainders(run) {
    for (const [key, carriageReturnKey] of [
      ["stdoutRemainder", "stdoutCarriageReturnPending"],
      ["stderrRemainder", "stderrCarriageReturnPending"],
    ]) {
      if (run?.[key]) {
        appendAppRunnerLine(run, run[key]);
        run[key] = "";
      }
      if (run) run[carriageReturnKey] = false;
    }
  }

  function appRunnerStatusLabel(run) {
    if (run?.stopping && run.status === "running") return "stopping";
    if (run?.status === "done") return "exit 0";
    if (run?.status === "failed") return run.signal ? `signal ${run.signal}` : `exit ${run.exitCode ?? "?"}`;
    if (run?.status === "error") return "error";
    return run?.status || "running";
  }

  function broadcastAppRunnerState(tab) {
    broadcastTabEvent(tab, {
      type: "webui_app_runner_update",
      tabId: tab.id,
      tabTitle: tab.title,
      cwd: tab.cwd,
      command: tab.appRunner?.displayCommand,
      activeRun: publicAppRunnerState(tab.appRunner),
      tabActivity: tabActivitySnapshot(tab),
    });
  }

  function scheduleAppRunnerBroadcast(tab) {
    if (!tab || tab.appRunnerBroadcastTimer) return;
    tab.appRunnerBroadcastTimer = setTimeout(() => {
      tab.appRunnerBroadcastTimer = null;
      if (hasTab(tab.id)) broadcastAppRunnerState(tab);
    }, 120);
  }

  function appRunnerChildActive(run) {
    if (!run?.child || run.settled) return false;
    if (run.executionMode === "conpty") return true;
    return run.child.exitCode === null && run.child.signalCode === null;
  }

  function terminateAppRunnerChild(run, signal = "SIGTERM") {
    if (!appRunnerChildActive(run)) return false;
    return terminateProcessTree(run.child, signal);
  }

  function appRunnerStdinWritable(run) {
    if (!appRunnerChildActive(run) || run.stdinClosed === true) return false;
    if (run.executionMode === "conpty") return typeof run.child.write === "function";
    const stdin = run.child.stdin;
    return !!stdin && !stdin.destroyed && !stdin.writableEnded;
  }

  function interruptAppRunnerChild(run) {
    if (!appRunnerChildActive(run)) return false;
    if (run.executionMode === "conpty" && appRunnerStdinWritable(run)) {
      try {
        run.child.write("\x03");
        return true;
      } catch {
        // Fall back to process-tree termination below.
      }
    }
    // Writing ETX to a Windows pipe is data, not a console Ctrl+C event. Kill the
    // complete tree there so npm/bash wrappers cannot leave orphaned servers.
    if (process.platform === "win32") return terminateAppRunnerChild(run, "SIGKILL");
    if (appRunnerStdinWritable(run) && run.executionMode === "pty") {
      try {
        run.child.stdin.write("\x03", "utf8");
        return true;
      } catch {
        // Fall back to process signals below.
      }
    }
    return terminateAppRunnerChild(run, "SIGINT");
  }

  function finishAppRunner(tab, run, patch = {}) {
    if (!run || run.settled) return;
    run.settled = true;
    clearTimeout(run.stopTimer);
    flushAppRunnerRemainders(run);
    run.endedAt = new Date().toISOString();
    run.exitCode = patch.exitCode;
    run.signal = patch.signal;
    run.error = patch.error;
    run.status = patch.error ? "error" : patch.exitCode === 0 ? "done" : "failed";
    for (const disposable of run.ptyDisposables || []) {
      try {
        disposable?.dispose?.();
      } catch {
        // The PTY has already exited; listener cleanup is best effort.
      }
    }
    run.ptyDisposables = [];
    run.child = null;
    run.stdinClosed = true;
    run.stopping = false;
    appendAppRunnerLine(run, `# ${appRunnerStatusLabel(run)} after ${Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000))}s`);
    if (patch.error) appendAppRunnerLine(run, `# ${patch.error}`);
    recordEvent({ type: "webui_app_runner_exit", tabId: tab.id, tabTitle: tab.title, command: run.displayCommand, code: run.exitCode, signal: run.signal, error: run.error });
    clearTimeout(tab.appRunnerBroadcastTimer);
    tab.appRunnerBroadcastTimer = null;
    broadcastAppRunnerState(tab);
  }

  function normalizeAppRunnerInputText(value) {
    const text = String(value ?? "");
    if (text.includes("\0")) throw makeHttpError(400, "App runner input cannot contain null bytes");
    if (text.length > APP_RUNNER_INPUT_MAX_CHARS) throw makeHttpError(413, `App runner input is too long; limit is ${APP_RUNNER_INPUT_MAX_CHARS} characters`);
    return text;
  }

  function sendAppRunnerInput(tab, value, { appendNewline = true, closeStdin = false } = {}) {
    const run = tab?.appRunner;
    if (!run || run.status !== "running") throw makeHttpError(409, "No app runner is running in this tab");
    if (!appRunnerStdinWritable(run)) throw makeHttpError(409, "App runner stdin is closed");
    const text = normalizeAppRunnerInputText(value);
    const newline = run.executionMode === "conpty" && process.platform === "win32" ? "\r" : "\n";
    const chunk = `${text}${appendNewline === false ? "" : newline}`;
    if (!chunk && !closeStdin) throw makeHttpError(400, "App runner input is empty");
    let buffered = false;
    try {
      if (run.executionMode === "conpty") {
        if (chunk) run.child.write(chunk);
        else if (closeStdin) run.child.write("\x04");
        if (closeStdin) run.stdinClosed = true;
      } else {
        const stdin = run.child.stdin;
        if (closeStdin) {
          if (chunk) stdin.end(chunk, "utf8");
          else stdin.end();
          run.stdinClosed = true;
        } else {
          buffered = stdin.write(chunk, "utf8") === false;
        }
      }
    } catch (error) {
      run.stdinClosed = true;
      run.stdinError = sanitizeError(error);
      throw makeHttpError(409, `App runner stdin write failed: ${run.stdinError}`);
    }
    run.stdinWrites = (run.stdinWrites || 0) + 1;
    run.lastStdinAt = new Date().toISOString();
    const closeSuffix = closeStdin ? " and closed" : "";
    if (chunk) appendAppRunnerLine(run, text ? `# stdin sent (${text.length} char${text.length === 1 ? "" : "s"})${closeSuffix}` : `# stdin sent (Enter)${closeSuffix}`);
    else appendAppRunnerLine(run, "# stdin closed (EOF)");
    recordEvent({ type: "webui_app_runner_stdin", tabId: tab.id, tabTitle: tab.title, command: run.displayCommand, chars: text.length, newline: appendNewline !== false, closed: closeStdin === true });
    scheduleAppRunnerBroadcast(tab);
    return { cwd: tab.cwd, activeRun: publicAppRunnerState(run), inputBuffered: buffered };
  }

  async function startAppRunner(tab, runnerId) {
    if (tab.appRunner?.status === "running") throw makeHttpError(409, `App runner already running: ${tab.appRunner.displayCommand}`);
    const runners = await detectAppRunners(tab);
    const runner = runners.find((item) => item.id === runnerId) || (runners.length === 1 && !runnerId ? runners[0] : null);
    if (!runner) throw makeHttpError(400, "Selected app runner is unavailable in this tab cwd");

    const run = {
      id: randomUUID(),
      runnerId: runner.id,
      kind: runner.kind,
      label: runner.label,
      command: runner.command,
      args: runner.args || [],
      displayCommand: runner.displayCommand,
      cwd: runner.cwd || tab.cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      lines: [],
      lineCount: 0,
      outputChars: 0,
      stdinClosed: false,
      stdinWrites: 0,
    };
    appendAppRunnerLine(run, `$ ${run.displayCommand}`);
    const child = await spawnAppRunnerChild(run);
    run.child = child;
    run.pid = child.pid;
    tab.appRunner = run;

    if (run.executionMode === "conpty") {
      run.ptyDisposables = [
        child.onData((chunk) => appendAppRunnerChunk(tab, run, chunk, "stdout")),
        child.onExit(({ exitCode, signal }) => finishAppRunner(tab, run, { exitCode, signal })),
      ];
    } else {
      child.stdin?.on("error", (error) => {
        run.stdinClosed = true;
        run.stdinError = sanitizeError(error);
        if (run.status === "running") {
          appendAppRunnerLine(run, `# stdin error: ${run.stdinError}`);
          scheduleAppRunnerBroadcast(tab);
        }
      });
      child.stdin?.on("close", () => {
        run.stdinClosed = true;
        if (run.status === "running") scheduleAppRunnerBroadcast(tab);
      });
      child.stdout.on("data", (chunk) => appendAppRunnerChunk(tab, run, chunk, "stdout"));
      child.stderr.on("data", (chunk) => appendAppRunnerChunk(tab, run, chunk, "stderr"));
      child.on("error", (error) => finishAppRunner(tab, run, { error: sanitizeError(error) }));
      child.on("exit", (exitCode, signal) => finishAppRunner(tab, run, { exitCode, signal }));
    }

    recordEvent({ type: "webui_app_runner_start", tabId: tab.id, tabTitle: tab.title, command: run.displayCommand, cwd: run.cwd, pid: run.pid });
    broadcastAppRunnerState(tab);
    return { runners, customRunnerConfig: await getCustomAppRunnerConfigData(tab), activeRun: publicAppRunnerState(run), cwd: tab.cwd };
  }

  function stopAppRunnerForTab(tab, reason = "stop requested", { force = false } = {}) {
    const run = tab?.appRunner;
    if (!run || run.status !== "running") return false;
    run.stopping = true;
    const action = run.executionMode === "conpty" && !force
      ? "sending Ctrl+C"
      : process.platform === "win32" ? "terminating Windows process tree" : `sending ${force ? "SIGKILL" : "Ctrl+C"}`;
    appendAppRunnerLine(run, `# ${reason}; ${action}`);
    if (force) terminateAppRunnerChild(run, "SIGKILL");
    else interruptAppRunnerChild(run);
    if (!force) {
      clearTimeout(run.stopTimer);
      run.stopTimer = setTimeout(() => {
        if (run.status === "running") {
          appendAppRunnerLine(run, "# app runner did not stop within the grace period; forcing process-tree termination");
          terminateAppRunnerChild(run, "SIGKILL");
          scheduleAppRunnerBroadcast(tab);
        }
      }, APP_RUNNER_STOP_GRACE_MS);
    }
    broadcastAppRunnerState(tab);
    return true;
  }

  function clearAppRunnerForTab(tab) {
    if (!tab?.appRunner || tab.appRunner.status === "running") return false;
    tab.appRunner = null;
    broadcastAppRunnerState(tab);
    return true;
  }

  function normalizeAppRunnerContextLineCount(value) {
    const number = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(number)) return APP_RUNNER_CONTEXT_DEFAULT_LINES;
    return Math.max(1, Math.min(APP_RUNNER_CONTEXT_MAX_LINES, number));
  }

  function appRunnerOutputLinesForContext(run) {
    const lines = Array.isArray(run?.lines) ? [...run.lines] : [];
    const pendingLine = appRunnerPendingLine(run);
    if (pendingLine) lines.push(pendingLine);
    return lines.map((line) => stripAnsi(line).replace(/\r\n?/g, "\n"));
  }

  function formatAppRunnerContextContent(tab, run, { requestedLineCount, lines, totalAvailableLines }) {
    const status = appRunnerStatusLabel(run);
    const capturedAt = new Date().toISOString();
    const header = [
      "App runner output transferred from Pi Web UI.",
      `Command: ${stripAnsi(run?.displayCommand || run?.command || "app runner")}`,
      `Cwd: ${stripAnsi(run?.cwd || tab?.cwd || "")}`,
      `Status: ${status}`,
      `Captured: last ${lines.length} of ${totalAvailableLines} available line${totalAvailableLines === 1 ? "" : "s"} (requested ${requestedLineCount})`,
      run?.truncated ? "Note: earlier app runner output had already been truncated before this capture." : "",
      `Captured at: ${capturedAt}`,
    ].filter(Boolean);
    return `${header.join("\n")}\n\n\`\`\`\`text\n${lines.join("\n").trimEnd()}\n\`\`\`\``;
  }

  async function transferAppRunnerContext(tab, body = {}) {
    const run = tab?.appRunner;
    if (!run) throw makeHttpError(409, "No app runner output is available in this tab");
    const requestedLineCount = normalizeAppRunnerContextLineCount(body.lineCount ?? body.lines ?? body.count);
    const allLines = appRunnerOutputLinesForContext(run);
    const lines = allLines.slice(-requestedLineCount);
    if (!lines.some((line) => stripAnsi(line).trim())) throw makeHttpError(400, "App runner output is empty");
    const details = {
      runId: run.id,
      runnerId: run.runnerId,
      command: run.displayCommand || run.command || "",
      cwd: run.cwd || tab.cwd,
      status: run.status || "running",
      requestedLineCount,
      lineCount: lines.length,
      totalAvailableLines: allLines.length,
      truncated: run.truncated === true,
      capturedAt: new Date().toISOString(),
    };
    const content = formatAppRunnerContextContent(tab, run, { requestedLineCount, lines, totalAvailableLines: allLines.length });
    const helperData = await sendWebuiHelperCommand(tab, "app-runner-context", { content, details });
    recordEvent({ type: "webui_app_runner_context", tabId: tab.id, tabTitle: tab.title, command: details.command, lineCount: lines.length, requestedLineCount, delivery: helperData?.delivery || "context" });
    return { ...details, delivery: helperData?.delivery || "context", activeRun: publicAppRunnerState(run) };
  }

  return {
    getAppRunnerData,
    getCustomAppRunnerConfigData,
    saveCustomAppRunner,
    saveAppRunnerSearchPaths,
    deleteCustomAppRunner,
    getAppRunnerFileBrowserData,
    startAppRunner,
    sendAppRunnerInput,
    transferAppRunnerContext,
    stopAppRunnerForTab,
    clearAppRunnerForTab,
    publicAppRunnerState,
  };
}
