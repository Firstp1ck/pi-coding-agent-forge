import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionDirectoryFor } from "../lib/backend/sessions-index.mjs";
import { REQUIRED_THEME_TOKENS } from "../lib/backend/themes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests", "fixtures", "fake-pi-rpc.mjs");
const launcherUrl = pathToFileURL(path.join(root, "lib", "launcher.mjs")).href;
const smokeMarkers = [
  "QT_WEBUI_SMOKE_BACKEND_READY",
  "QT_WEBUI_SMOKE_READY",
  "QT_WEBUI_SMOKE_STARTUP_ERROR_MAPPED",
  "QT_WEBUI_SMOKE_THEME_DARK",
  "QT_WEBUI_SMOKE_THEME_LIGHT_OVERRIDE",
  "QT_WEBUI_SMOKE_THEME_DARK_OVERRIDE",
  "QT_WEBUI_SMOKE_THEME_AUTOMATIC",
  "QT_WEBUI_SMOKE_REDUCED_MOTION",
  "QT_WEBUI_SMOKE_EXTERNAL_THEME_APPLIED",
  "QT_WEBUI_SMOKE_THEME_TYPED_COLLISION",
  "QT_WEBUI_SMOKE_THEME_SELECTION_PERSISTED",
  "QT_WEBUI_SMOKE_THEME_FALLBACK",
  "QT_WEBUI_SMOKE_THEME_RECOVERED",
  "QT_WEBUI_SMOKE_RUNTIME_INFO",
  "QT_WEBUI_SMOKE_PARSE_RECOVERED",
  "QT_WEBUI_SMOKE_DIALOG_FOCUS",
  "QT_WEBUI_SMOKE_DIALOG_ANSWER_RECEIPT",
  "QT_WEBUI_SMOKE_DIALOG_CANCEL_RECEIPT",
  "QT_WEBUI_SMOKE_STREAM_RECONCILED",
  "QT_WEBUI_SMOKE_THINKING_RENDERED",
  "QT_WEBUI_SMOKE_TOOL_CARD",
  "QT_WEBUI_SMOKE_AGENT_SETTLED",
  "QT_WEBUI_SMOKE_MARKDOWN_RENDERED",
  "QT_WEBUI_SMOKE_LINK_CONFIRMED",
  "QT_WEBUI_SMOKE_SEARCH_MATCHED",
  "QT_WEBUI_SMOKE_IMMEDIATE_PROMPT_RECONCILED",
  "QT_WEBUI_SMOKE_NOTIFICATION_REQUESTED",
  "QT_WEBUI_SMOKE_PROVIDER_ERROR_PRESERVED",
  "QT_WEBUI_SMOKE_FAILED_RESPONSE_RECOVERED",
  "QT_WEBUI_SMOKE_DELAYED_AGENT_ABORTED",
  "QT_WEBUI_SMOKE_DELAYED_ABORT_RECEIPT",
  "QT_WEBUI_SMOKE_TRANSCRIPT_BOUNDED",
  "QT_WEBUI_SMOKE_SETTINGS_PERSISTED",
  "QT_WEBUI_SMOKE_CODE_HIGHLIGHTED",
  "QT_WEBUI_SMOKE_COMMANDS_LOADED",
  "QT_WEBUI_SMOKE_COMMAND_COMPLETED",
  "QT_WEBUI_SMOKE_PATH_COMPLETED",
  "QT_WEBUI_SMOKE_COMPLETION_GENERATIONS",
  "QT_WEBUI_SMOKE_ATTACHMENT_ADDED",
  "QT_WEBUI_SMOKE_ATTACHMENT_SENT",
  "QT_WEBUI_SMOKE_DRAFT_PERSISTED",
  "QT_WEBUI_SMOKE_SEQUENCE_RUN",
  "QT_WEBUI_SMOKE_SEQUENCE_DELETED",
  "QT_WEBUI_SMOKE_ACTIVE_PICKER_INVALIDATED",
  "QT_WEBUI_SMOKE_STALE_PICKER_RESULT_REFUSED",
  "QT_WEBUI_SMOKE_PICKER_LOADING_RECOVERED",
  "QT_WEBUI_SMOKE_REAL_LIST_ARROW_SELECTION",
  "QT_WEBUI_SMOKE_MODEL_DROPUP_BOUNDED",
  "QT_WEBUI_SMOKE_MODEL_DROPUP_FOCUS_RETURNED",
  "QT_WEBUI_SMOKE_MODEL_PICKER",
  "QT_WEBUI_SMOKE_MODEL_SELECTED",
  "QT_WEBUI_SMOKE_THINKING_DROPUP_BOUNDED",
  "QT_WEBUI_SMOKE_THINKING_DROPUP_FOCUS_RETURNED",
  "QT_WEBUI_SMOKE_THINKING_PICKER",
  "QT_WEBUI_SMOKE_MODEL_CYCLED",
  "QT_WEBUI_SMOKE_THINKING_CYCLED",
  "QT_WEBUI_SMOKE_CONTEXT_COMPACTED",
  "QT_WEBUI_SMOKE_RESOURCES_LOADED",
  "QT_WEBUI_SMOKE_RESOURCE_TOOLS_NONE",
  "QT_WEBUI_SMOKE_RESOURCE_SKILLS_ENABLED",
  "QT_WEBUI_SMOKE_RESOURCE_SAMPLING_SAVED",
  "QT_WEBUI_SMOKE_RESOURCE_UNSUPPORTED_PRESERVED",
  "QT_WEBUI_SMOKE_SESSION_AGE_LABELS",
  "QT_WEBUI_SMOKE_SESSION_SORT_GRACE",
  "QT_WEBUI_SMOKE_SESSION_CATALOG_LOADED",
  "QT_WEBUI_SMOKE_WORKSPACE_SEARCH_FILTERED",
  "QT_WEBUI_SMOKE_SESSION_SETTLED",
  "QT_WEBUI_SMOKE_SETTLED_COLLAPSED",
  "QT_WEBUI_SMOKE_SETTLED_EXPANDED",
  "QT_WEBUI_SMOKE_SESSION_RESTORED",
  "QT_WEBUI_SMOKE_SESSION_NEW_TAB_RESUMED",
  "QT_WEBUI_SMOKE_SESSION_EXISTING_TAB_REUSED",
  "QT_WEBUI_SMOKE_EMPTY_SESSION_STATE",
  "QT_WEBUI_SMOKE_TAB_OPENED",
  "QT_WEBUI_SMOKE_TAB_PICKER_INVALIDATED",
  "QT_WEBUI_SMOKE_TAB_PICKER_LOADING_RECOVERED",
  "QT_WEBUI_SMOKE_STALE_RESOURCE_READ_IGNORED",
  "QT_WEBUI_SMOKE_STALE_RESOURCE_MUTATION_IGNORED",
  "QT_WEBUI_SMOKE_TAB_SWITCHED",
  "QT_WEBUI_SMOKE_SESSION_RESUMED",
  "QT_WEBUI_SMOKE_SESSION_NEW",
  "QT_WEBUI_SMOKE_DIRECTORY_PICKED",
  "QT_WEBUI_SMOKE_WORKTREE_CREATED",
  "QT_WEBUI_SMOKE_TAB_CLOSED",
  "QT_WEBUI_SMOKE_USAGE_LOADED",
  "QT_WEBUI_SMOKE_PALETTE_ACTION",
  "QT_WEBUI_SMOKE_EVENTS_LISTED",
  "QT_WEBUI_SMOKE_DIAGNOSTICS_SHOWN",
  "QT_WEBUI_SMOKE_FAILED_STATE_RECOVERABLE",
  "QT_WEBUI_SMOKE_FAILED_STATE_RESTART",
  "QT_WEBUI_SMOKE_MISSING_STATE_RECOVERABLE",
  "QT_WEBUI_SMOKE_MISSING_STATE_RESTART",
  "QT_WEBUI_SMOKE_RESTART_RECEIPT",
  "QT_WEBUI_SMOKE_BACKEND_CRASH_OBSERVED",
  "QT_WEBUI_SMOKE_BACKEND_RESTARTED",
  "QT_WEBUI_SMOKE_BACKEND_CRASH_RECOVERED",
  "QT_WEBUI_SMOKE_COMPLETE",
];

function smokeTheme(name, accent) {
  const backgroundTokens = new Set(["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);
  const colors = Object.fromEntries(REQUIRED_THEME_TOKENS.map((token) => [token, backgroundTokens.has(token) ? "bg" : "fg"]));
  Object.assign(colors, {
    accent,
    border: accent,
    borderAccent: accent,
    borderMuted: "#666666",
    success: "#66cc88",
    error: "#ff6677",
    warning: "#ddaa55",
    text: "",
    userMessageText: "fg",
    customMessageText: "fg",
  });
  return {
    name,
    vars: { bg: "#202020", fg: "#f0f0f0" },
    colors,
    export: {
      pageBg: "#101010",
      cardBg: "#202020",
      infoBg: "#282828",
      backgroundImage: "url(ignored.png)",
      backgroundOverlay: "linear-gradient(ignored)",
    },
  };
}

// Quickshell renders offscreen by default so the suite never opens windows on the desktop.
// Set QT_WEBUI_SMOKE_VISIBLE=1 to watch the scenarios on the current Wayland session instead.
const smokeVisible = process.env.QT_WEBUI_SMOKE_VISIBLE === "1";

function waylandUnavailableReason() {
  if (!smokeVisible) return null;
  if (!process.env.WAYLAND_DISPLAY) return "no Wayland display: WAYLAND_DISPLAY is unset";
  if (!process.env.XDG_RUNTIME_DIR) return "no Wayland display: XDG_RUNTIME_DIR is unset";
  return null;
}

function quickshellUnavailableReason() {
  const probe = spawnSync("quickshell", ["--version"], { encoding: "utf8", timeout: 2_000 });
  if (probe.error?.code === "ENOENT") return "Quickshell is unavailable on PATH";
  if (probe.error) return `Quickshell probe failed: ${probe.error.message}`;
  if (probe.status !== 0) return `Quickshell probe exited ${probe.status}`;
  return null;
}

export function runLiveSmoke({ callerCwd, capturePath, statePath, configHome, extraEnv = {}, timeoutMs = 40_000, orderOnly = false, themeOnly = false, remediation = false, recovery = false, draftOwnership = false, layoutGeometry = false }) {
  const program = `
    import { launchQtWebUi } from ${JSON.stringify(launcherUrl)};
    const code = await launchQtWebUi({
      argv: [],
      cwd: ${JSON.stringify(callerCwd)},
      env: process.env,
      nodeExecutable: process.execPath,
      resolvePiEntry: () => ${JSON.stringify(fixture)},
      detectColorScheme: () => "dark",
      testOnlyEnvironment: {
        QT_WEBUI_SMOKE_MODE: "1",
        QT_WEBUI_SMOKE_CAPTURE_PATH: ${JSON.stringify(capturePath)},
        QT_WEBUI_SMOKE_STATE_PATH: ${JSON.stringify(statePath)},
        QT_WEBUI_THEME_MODE: ${JSON.stringify(layoutGeometry ? "layout-geometry" : draftOwnership ? "draft-ownership" : recovery ? "recovery" : remediation ? "remediation" : themeOnly ? "theme-only" : orderOnly ? "order-only" : "normal")},
        QT_WEBUI_PI_STARTUP_TIMEOUT_MS: "1500",
        QT_WEBUI_PI_REQUEST_TIMEOUT_MS: "10000",
      },
    });
    process.exitCode = code;
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: path.join(path.dirname(configHome), "state"),
        PI_CODING_AGENT_DIR: path.join(path.dirname(configHome), "agent"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...(smokeVisible ? {} : { QT_QPA_PLATFORM: "offscreen" }),
        ...extraEnv,
        XDG_CACHE_HOME: path.join(path.dirname(configHome), "cache"),
        PI_WEBUI_SETTINGS_FILE: path.join(path.dirname(configHome), "webui-settings.json"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(path.dirname(configHome), "isolated-session-bus")}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const terminate = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timeout = setTimeout(() => {
      terminate();
      finish(() => reject(new Error(`QML smoke timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`)));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => resolve({ code, signal, stdout, stderr }));
    });
  });
}

async function smokeWorkspace(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "qt-webui-qml-smoke-"));
  const capturePath = path.join(temporary, "commands.jsonl");
  const statePath = path.join(temporary, "state.txt");
  const configHome = path.join(temporary, "config");
  const callerCwd = path.join(temporary, "<b>project</b>");
  await mkdir(path.join(callerCwd, "src"), { recursive: true });
  await writeFile(path.join(callerCwd, "src", "main.mjs"), "export const answer = 42;\n");
  await mkdir(path.join(temporary, "other"));
  await writeFile(capturePath, "");
  const themesDirectory = path.join(temporary, "agent", "themes");
  await mkdir(themesDirectory, { recursive: true });
  await writeFile(path.join(themesDirectory, "smoke-theme.json"), JSON.stringify(smokeTheme("smoke-theme", "#123456")));
  await writeFile(path.join(themesDirectory, "light.json"), JSON.stringify(smokeTheme("light", "#654321")));
  // The workspace is a Git repository so the worktree flow can run; the fixture session file
  // makes "Resume a session" list something to pick.
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "Smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "src/main.mjs"], ["commit", "-q", "-m", "smoke"]]) {
    const result = spawnSync("git", args, { cwd: callerCwd, env: gitEnv, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  const sessionsDirectory = sessionDirectoryFor(callerCwd, { PI_CODING_AGENT_DIR: path.join(temporary, "agent") });
  await mkdir(sessionsDirectory, { recursive: true });
  const sessionTime = new Date(Date.now() - 60 * 60 * 1000);
  const sessionPath = path.join(sessionsDirectory, "2026-08-26_resume-me.jsonl");
  await writeFile(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: "resume-me", timestamp: sessionTime.toISOString(), cwd: callerCwd }),
    JSON.stringify({ type: "session_info", id: "info", parentId: null, timestamp: sessionTime.toISOString(), name: "Resumable smoke session" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: sessionTime.toISOString(), message: { role: "user", content: "earlier question", timestamp: sessionTime.getTime() } }),
  ].join("\n") + "\n");
  await utimes(sessionPath, sessionTime, sessionTime);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, capturePath, statePath, configHome, callerCwd };
}

function assertHealthyOutput(combined) {
  for (const marker of smokeMarkers) assert.match(combined, new RegExp(marker), `missing ${marker}\n${combined}`);
  assert.doesNotMatch(combined, /QT_WEBUI_SMOKE_FAILURE/, combined);
  assert.doesNotMatch(combined, /QQmlApplicationEngine failed|TypeError:|ReferenceError:|is not a type|Cannot assign|Stack trace/i, combined);
  assert.doesNotMatch(combined, /Failed to register with host portal|Cannot create delegate|Required property \w+ was not initialized|Accessible attached property must be attached to an object deriving from Item or Action/i, combined);
}

async function assertCapture(capturePath) {
  const commands = (await readFile(capturePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const helperPrompts = commands.filter((command) => command.type === "prompt" && String(command.message).startsWith("/qt-webui-helper "));
  const helperRequests = helperPrompts.map((command) => JSON.parse(String(command.message).slice("/qt-webui-helper ".length)));
  const prompts = commands.filter((command) => command.type === "prompt" && !String(command.message).startsWith("/qt-webui-helper "));
  assert.deepEqual(prompts.map((command) => command.message.split("\n")[0]), [
    "__QT_WEBUI_STREAM__",
    "__QT_WEBUI_MARKDOWN__",
    "__QT_WEBUI_IMMEDIATE__",
    "__QT_WEBUI_PROVIDER_ERROR__",
    "__QT_WEBUI_FAIL__",
    "__QT_WEBUI_DELAYED_ABORT__",
    "__QT_WEBUI_LIMITS__",
    "__QT_WEBUI_IMMEDIATE__",
    "__QT_WEBUI_IMMEDIATE__",
    "__QT_WEBUI_IMMEDIATE__",
    "__QT_WEBUI_EXIT__",
  ], "the last immediate prompt runs in the second tab");
  assert(!prompts.some((command) => /^\/review/.test(command.message)), "accepting a command completion must not send");
  const attachmentPrompt = prompts[7];
  assert.equal(attachmentPrompt.message, "__QT_WEBUI_IMMEDIATE__\n\nAttached file: main.mjs\n````\nexport const answer = 42;\n\n````", "text attachments travel as labelled fenced blocks");
  assert.equal(attachmentPrompt.images, undefined);
  assert.deepEqual(commands.filter((command) => command.type === "follow_up").map((command) => command.message), ["queued follow-up"], "the sequence queues its second entry");
  assert(commands.filter((command) => command.type === "get_commands").length >= 2, "the composer and palette load commands; resource-helper discovery may share those reads per tab");
  assert.deepEqual(commands.filter((command) => command.type === "switch_session").map((command) => path.basename(command.sessionPath)), ["2026-08-26_resume-me.jsonl", "2026-08-26_resume-me.jsonl"],
    "the catalog resumes in a new tab before the legacy picker resumes in place");
  assert.equal(commands.filter((command) => command.type === "new_session").length, 1);
  assert.equal(commands.filter((command) => command.type === "get_messages").length, 2, "history is read after each explicit resume");
  assert(commands.filter((command) => command.type === "get_session_stats").length >= 1, "usage statistics are read");
  assert(!prompts.some((command) => /^\/(review|fix-tests|skill:)/.test(command.message)), "palette commands are inserted, never sent");
  assert.equal(commands.filter((command) => command.type === "abort").length, 2,
    "one abort should be sent before delayed agent_start and exactly one after it");
  assert.deepEqual(commands.filter((command) => command.type === "set_model").map((command) => [command.provider, command.modelId]), [["fixture-provider", "fixture-fast"], ["fixture-provider", "fixture-model"]],
    "the picker changes to the fast model and the resource flow returns to a model with different sampling capabilities");
  assert.deepEqual(commands.filter((command) => command.type === "set_thinking_level"), []);
  assert.equal(commands.filter((command) => command.type === "cycle_model").length, 1);
  assert.equal(commands.filter((command) => command.type === "cycle_thinking_level").length, 1);
  assert.deepEqual(commands.filter((command) => command.type === "compact"), [{ type: "compact" }].map((command) => ({ ...command, id: commands.find((entry) => entry.type === "compact").id })));
  assert(helperRequests.filter((request) => request.action === "state").length >= 1, "resource state is refreshed through the helper");
  const helperApplies = helperRequests.filter((request) => request.action === "apply").map((request) => request.payload || {});
  assert(helperApplies.some((payload) => Array.isArray(payload.effective?.tools) && payload.effective.tools.length === 0), "intentional no-tools is applied as an empty enabled list");
  assert(helperApplies.some((payload) => JSON.stringify(payload.effective?.skills) === JSON.stringify(["review"])), "enabled skills are applied by name");
  assert(helperApplies.some((payload) => payload.session?.sampling?.top_k === 55 && payload.effective?.sampling?.top_k === 55), "supported session sampling is serialized exactly");
  assert(helperApplies.some((payload) => payload.session === undefined && payload.effective?.sampling?.temperature === 0.4 && payload.effective?.sampling?.top_k === undefined), "unsupported top_k remains stored but is omitted from the applied payload after the model change");
  const dialogResponses = commands.filter((command) => command.type === "extension_ui_response");
  assert.deepEqual(dialogResponses, [
    { type: "extension_ui_response", id: "dialog-select", value: "Block" },
    { type: "extension_ui_response", id: "dialog-confirm", confirmed: true },
    { type: "extension_ui_response", id: "dialog-input", value: "typed value" },
    { type: "extension_ui_response", id: "dialog-editor", value: "Line 1\nLine 2\nLine 3" },
    { type: "extension_ui_response", id: "dialog-cancel", cancelled: true },
  ]);
  return commands;
}

test("real Quickshell completes the deterministic backend and Pi behavior scenarios", { timeout: 60_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);

  if (smokeVisible) {
    const runtimeDir = path.join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY);
    try {
      await access(runtimeDir);
    } catch {
      return t.skip(`no Wayland display socket at ${runtimeDir}`);
    }
  }

  const workspace = await smokeWorkspace(t);
  const result = await runLiveSmoke(workspace);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.signal, null, combined);
  assert.equal(result.code, 0, combined);
  assertHealthyOutput(combined);
  t.diagnostic(`observed smoke markers: ${smokeMarkers.length}`);
  await assertCapture(workspace.capturePath);
  const settings = JSON.parse(await readFile(path.join(workspace.configHome, "qt-webui", "settings.json"), "utf8"));
  assert.equal(settings.compactTranscript, false, "the legacy density setting remains untouched while the UI uses compact layout");
  assert.equal(settings.showThinking, true, "thinking was hidden in the settings phase and shown again through the palette");
  assert.equal(settings.appearanceMode, "light", "the typed built-in selection updated only Qt WebUI's built-in fallback mode");
  assert.equal(settings.selectedThemeName, "light", "the colliding external theme identity persisted separately from the built-in fallback");
  const state = JSON.parse(await readFile(path.join(workspace.temporary, "state", "qt-webui", "state.json"), "utf8"));
  assert.deepEqual(state.recentActions, ["action:toggle-thinking"]);
  assert.equal(state.tabs.length, 1);
});

for (const [label, extraEnv] of [["default scale", {}], ["200% scaling", { QT_SCALE_FACTOR: "2" }]]) {
  test(`real Quickshell applies, falls back, and recovers a Pi theme at ${label}`, { timeout: 30_000 }, async (t) => {
    const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
    if (skipReason) return t.skip(skipReason);
    const workspace = await smokeWorkspace(t);
    const result = await runLiveSmoke({ ...workspace, themeOnly: true, extraEnv, timeoutMs: 20_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.signal, null, combined);
    assert.equal(result.code, 0, combined);
    for (const marker of [
      "QT_WEBUI_SMOKE_EXTERNAL_THEME_APPLIED",
      "QT_WEBUI_SMOKE_THEME_TYPED_COLLISION",
      "QT_WEBUI_SMOKE_THEME_SELECTION_PERSISTED",
      "QT_WEBUI_SMOKE_THEME_FALLBACK",
      "QT_WEBUI_SMOKE_THEME_RECOVERED",
      "QT_WEBUI_SMOKE_COMPLETE",
    ]) assert.match(combined, new RegExp(marker), `missing ${marker}\n${combined}`);
    assert.doesNotMatch(combined, /QT_WEBUI_SMOKE_FAILURE|QQmlApplicationEngine failed|TypeError:|ReferenceError:|Cannot assign|Accessible attached property must be attached to an object deriving from Item or Action/i, combined);
    const settings = JSON.parse(await readFile(path.join(workspace.configHome, "qt-webui", "settings.json"), "utf8"));
    assert.equal(settings.appearanceMode, "light");
    assert.equal(settings.selectedThemeName, "light");
  });
}

test("real Quickshell completes a model reorder and persists merged identities", { timeout: 30_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);
  const workspace = await smokeWorkspace(t);
  const result = await runLiveSmoke({ ...workspace, orderOnly: true, timeoutMs: 20_000 });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.signal, null, combined);
  assert.equal(result.code, 0, combined);
  for (const marker of ["QT_WEBUI_SMOKE_MODEL_REORDER_COMPLETED", "QT_WEBUI_SMOKE_MODEL_REORDER_SAVED", "QT_WEBUI_SMOKE_MODEL_REORDER_REAPPLIED", "QT_WEBUI_SMOKE_COMPLETE"]) {
    assert.match(combined, new RegExp(marker), `missing ${marker}\n${combined}`);
  }
  assert.doesNotMatch(combined, /QT_WEBUI_SMOKE_FAILURE|QQmlApplicationEngine failed|TypeError:|ReferenceError:|Cannot assign|Accessible attached property must be attached to an object deriving from Item or Action/i, combined);
  const settings = JSON.parse(await readFile(path.join(workspace.configHome, "qt-webui", "settings.json"), "utf8"));
  assert.deepEqual(settings.modelOrder, ["fixture-provider/fixture-fast", "fixture-provider/fixture-model", "other-provider/other-model", "absent-provider/absent-model"]);
});

test("real Quickshell preserves prompt, draft, and dialog intent under delayed settlement", { timeout: 40_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);
  const workspace = await smokeWorkspace(t);
  const result = await runLiveSmoke({ ...workspace, remediation: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, output);
  assert.doesNotMatch(output, /QT_WEBUI_SMOKE_FAILURE|TypeError:|ReferenceError:|Cannot assign/, output);
  for (const name of ["PROMPTS", "DRAFTS", "DIALOGS", "ATTACHMENTS", "SELECTION", "SEARCH"]) assert.match(output, new RegExp(`QT_WEBUI_REMEDIATION_${name}`), output);
  const commands = (await readFile(workspace.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commands.filter(command => command.message === "__QT_WEBUI_ACCEPT_DELAY__").length, 2, "timeouts never resend");
});

test("real Quickshell keeps saved close, unsaved tab, and inactive promotion drafts separate", { timeout: 40_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);
  const workspace = await smokeWorkspace(t);
  const savedFile = path.join(sessionDirectoryFor(workspace.callerCwd, { PI_CODING_AGENT_DIR: path.join(workspace.temporary, "agent") }), "2026-08-26_resume-me.jsonl");
  const directory = path.join(workspace.temporary, "state", "qt-webui");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify({ tabs: [{ cwd: workspace.callerCwd, sessionFile: savedFile, name: "" }], activeTab: 0 }));
  const result = await runLiveSmoke({ ...workspace, draftOwnership: true,
    extraEnv: { QT_WEBUI_FIXTURE_INITIAL_SESSION_DIRECTORY: workspace.temporary } });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, output);
  assert.doesNotMatch(output, /QT_WEBUI_SMOKE_FAILURE|TypeError:|ReferenceError:|Cannot assign/, output);
  for (const marker of ["QT_WEBUI_DRAFT_SAVED_CLOSE", "QT_WEBUI_DRAFT_TWO_UNSAVED", "QT_WEBUI_DRAFT_INACTIVE_PROMOTION", "QT_WEBUI_SMOKE_COMPLETE"]) {
    assert.match(output, new RegExp(marker), output);
  }
  const state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  assert.equal(state.drafts[savedFile]?.text, "saved edit just before close");
});

test("real bridge offers switch and new session when a resume file is missing", { timeout: 40_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);
  const workspace = await smokeWorkspace(t);
  const result = await runLiveSmoke({ ...workspace, recovery: true, timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, output);
  assert.doesNotMatch(output, /QT_WEBUI_SMOKE_FAILURE|TypeError:|ReferenceError:|Cannot assign/, output);
  for (const marker of ["QT_WEBUI_RECOVERY_SWITCH", "QT_WEBUI_RECOVERY_NEW", "QT_WEBUI_SMOKE_COMPLETE"]) assert.match(output, new RegExp(marker), output);
  const commands = (await readFile(workspace.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commands.filter(command => command.type === "new_session").length, 1);
  assert.equal(commands.filter(command => command.type === "switch_session").length, 3);
  assert.equal(commands.filter(command => command.type === "prompt" && command.message === "__QT_WEBUI_IMMEDIATE__").length, 0);
});

for (const [label, extraEnv] of [["default scale", {}], ["200% scaling", { QT_SCALE_FACTOR: "2" }]]) {
  test(`real Quickshell keeps Abort and recovery actions in the 560x520 window at ${label}`, { timeout: 30_000 }, async (t) => {
    const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
    if (skipReason) return t.skip(skipReason);
    const workspace = await smokeWorkspace(t);
    for (let index = 0; index < 8; index++) {
      await writeFile(path.join(workspace.callerCwd, `w6-attachment-${index}-${"long-name-".repeat(8)}.txt`), "Geometry fixture\n");
    }
    const result = await runLiveSmoke({ ...workspace, layoutGeometry: true, extraEnv, timeoutMs: 20_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.signal, null, combined);
    assert.equal(result.code, 0, combined);
    assert.match(combined, /QT_WEBUI_SMOKE_REAL_SHELL_GEOMETRY/, combined);
    assert.match(combined, /QT_WEBUI_SMOKE_COMPLETE/, combined);
    assert.doesNotMatch(combined, /QT_WEBUI_SMOKE_FAILURE|QQmlApplicationEngine failed|TypeError:|ReferenceError:|Cannot assign/i, combined);
  });
}

test("real Quickshell completes the same scenarios at 200% scaling", { timeout: 60_000 }, async (t) => {
  const skipReason = waylandUnavailableReason() ?? quickshellUnavailableReason();
  if (skipReason) return t.skip(skipReason);
  const workspace = await smokeWorkspace(t);
  const result = await runLiveSmoke({ ...workspace, extraEnv: { QT_SCALE_FACTOR: "2" } });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, combined);
  assertHealthyOutput(combined);
  await assertCapture(workspace.capturePath);
});
