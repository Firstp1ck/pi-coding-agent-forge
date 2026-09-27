#!/usr/bin/env node
// Deterministic stand-in for `pi --mode rpc`. It speaks the same LF-delimited JSONL protocol,
// records every command it receives, and replays scripted scenarios keyed by prompt text so
// the backend and the live Quickshell smoke can exercise protocol edges without a provider.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const capturePath = process.env.QT_WEBUI_SMOKE_CAPTURE_PATH;
const statePath = process.env.QT_WEBUI_SMOKE_STATE_PATH;
const startupStage = statePath && existsSync(statePath) ? readFileSync(statePath, "utf8").trim() : "initial";
let startupNoiseSent = false;
const dialogAnswers = new Map();
let dialogReceiptSent = false;
let dialogCancelReceiptSent = false;
let activeAbort = false;
let delayedContinuation = null;

// Model inventory: the reasoning model exposes every level; the fast model has none. The odd
// entries prove the backend drops malformed models and strips terminal color codes.
const MODELS = [
  { id: "fixture-model", name: "Fixture Model", provider: "fixture-provider", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 1, output: 2 } },
  { id: "fixture-fast", name: "Fixture Fast \u001b[31mred\u001b[0m", provider: "fixture-provider", api: "fixture-unknown", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 4_096 },
  { id: "other-model", name: "Other Model", provider: "other-provider", api: "google-generative-ai", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192 },
  { id: "", name: "Nameless", provider: "broken" },
  "not a model",
  { id: "fixture-model", name: "Duplicate", provider: "fixture-provider", reasoning: true },
];
let currentModel = MODELS[0];
let currentThinkingLevel = "high";
let compacting = false;
let sessionSerial = 0;
let currentSessionFile = process.env.QT_WEBUI_FIXTURE_INITIAL_SESSION_FILE || "/tmp/fixture-session.jsonl";
let currentSessionName = "Fixture session";
let helperSession = { tools: null, skills: null, sampling: {} };
let helperEffective = { tools: null, skills: null, sampling: {} };
let helperCallCount = 0;
let switchCallCount = 0;
let currentSessionId = "fixture-session";

const HELPER_TOOLS = [
  { name: "read", description: "Read a file", source: "core" },
  { name: "bash", description: "Run a command", source: "core" },
  { name: "write", description: "Write a file", source: "core" },
];
const PROJECT_ONLY_TOOL = { name: "project-only", description: "Project-local test tool", source: "extension" };
function helperToolsForFixture() {
  return process.env.QT_WEBUI_FIXTURE_EXTRA_TOOL_CWD === process.cwd()
    ? [...HELPER_TOOLS, PROJECT_ONLY_TOOL]
    : HELPER_TOOLS;
}
const HELPER_SKILLS = [
  { name: "brave-search", description: "Web search", filePath: "/tmp/skills/brave-search/SKILL.md", disableModelInvocation: false },
  { name: "review", description: "Review code", filePath: "/tmp/skills/review/SKILL.md", disableModelInvocation: false },
];

// Persisted history replayed by get_messages: a session named resume-me has a complete exchange
// with a tool call, one named interrupted ends with an unanswered user message.
function persistedSession(sessionFile) {
  if (!existsSync(sessionFile)) return null;
  try {
    const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const header = entries.find((entry) => entry?.type === "session");
    const names = entries.filter((entry) => entry?.type === "session_info" && typeof entry.name === "string");
    return {
      id: typeof header?.id === "string" ? header.id : "fixture-session",
      name: names.at(-1)?.name ?? "",
      messages: entries.filter((entry) => entry?.type === "message" && entry.message && typeof entry.message === "object").map((entry) => entry.message),
    };
  } catch {
    return null;
  }
}

function historyFor(sessionFile) {
  if (sessionFile.includes("resume-me")) {
    return [
      { role: "user", content: "earlier question", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "earlier thinking" }, { type: "text", text: "earlier **answer**" }, { type: "toolCall", id: "hist-tool", name: "read", arguments: { path: "/tmp/a.txt" } }], stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "hist-tool", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 4 },
    ];
  }
  if (sessionFile.includes("interrupted")) {
    return [
      { role: "user", content: [{ type: "text", text: "please continue" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
    ];
  }
  return persistedSession(sessionFile)?.messages ?? [];
}

function thinkingLevelsFor(model) {
  return model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
}

function scopedModelsForFixture() {
  if (process.env.QT_WEBUI_FIXTURE_MODEL_SCOPE === "explicit") {
    return {
      explicit: true,
      items: [
        { provider: "other-provider", id: "other-model", thinkingLevel: "medium" },
        { provider: "fixture-provider", id: "fixture-model", thinkingLevel: "" },
      ],
      omitted: 0,
    };
  }
  if (process.env.QT_WEBUI_FIXTURE_MODEL_SCOPE === "many") {
    return {
      explicit: true,
      items: Array.from({ length: 300 }, (_, index) => ({ provider: "bulk", id: `bulk-${299 - index}`, thinkingLevel: "" })),
      omitted: 0,
    };
  }
  return { explicit: false, items: [], omitted: 0 };
}

const MARKDOWN_SAMPLE = [
  "# Heading one",
  "",
  "Some **bold** text, *emphasis*, `inline code`, and a [safe link](https://example.com/docs).",
  "Raw <img src=\"file:///etc/passwd\"> markup and <script>alert(1)</script> must stay inert.",
  "A [blocked link](javascript:alert(1)) and ![an image](https://example.com/image.png).",
  "",
  "```js",
  "const answer = 1 < 2 && \"<b>not bold</b>\";",
  "```",
  "",
  "- first item",
  "- second item",
  "  - nested item",
  "",
  "> quoted **line**",
  "",
  "| col a | col b |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");

function emit(value, ending = "\n") {
  process.stdout.write(`${JSON.stringify(value)}${ending}`);
}

function response(command, success = true, extra = {}) {
  emit({
    type: "response",
    ...(typeof command.id === "string" ? { id: command.id } : {}),
    command: command.type,
    success,
    ...extra,
  });
}

function capture(command) {
  if (!capturePath) return;
  appendFileSync(capturePath, `${JSON.stringify(command)}\n`);
}

function notify(message, notifyType = "info") {
  emit({ type: "extension_ui_request", id: `notify-${message}`, method: "notify", message, notifyType });
}

function emitDialogs() {
  emit({ type: "extension_ui_request", id: "dialog-select", method: "select", title: "Fixture select", message: "Pick one", options: ["Allow", "Block"], timeout: 60_000 });
  emit({ type: "extension_ui_request", id: "dialog-confirm", method: "confirm", title: "Fixture confirm", message: "Continue?" });
  emit({ type: "extension_ui_request", id: "dialog-input", method: "input", title: "Fixture input", placeholder: "type something" });
  emit({ type: "extension_ui_request", id: "dialog-editor", method: "editor", title: "Fixture editor", prefill: "Line 1\nLine 2" });
  emit({ type: "extension_ui_request", id: "dialog-cancel", method: "input", title: "Fixture cancel", placeholder: "cancel me" });
}

function maybeEmitDialogReceipts() {
  const expected = [["dialog-select", "value", "Block"], ["dialog-confirm", "confirmed", true], ["dialog-input", "value", "typed value"], ["dialog-editor", "value", "Line 1\nLine 2\nLine 3"]];
  if (!dialogReceiptSent && expected.every(([id, key, value]) => dialogAnswers.get(id)?.[key] === value)) {
    dialogReceiptSent = true;
    notify("QT_WEBUI_SMOKE_DIALOG_ANSWER_RECEIPT");
  }
  if (!dialogCancelReceiptSent && dialogAnswers.get("dialog-cancel")?.cancelled === true) {
    dialogCancelReceiptSent = true;
    notify("QT_WEBUI_SMOKE_DIALOG_CANCEL_RECEIPT");
  }
}

function runStream(command) {
  response(command);
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "extension_ui_request", id: "status-plain", method: "setStatus", statusKey: "plain-ext", statusText: "plain status <b>text</b> \u001b[38;2;249;22;22mred\u001b[0m [38;2;1;2;3mraw" });
  emit({ type: "extension_ui_request", id: "status-controls", method: "setStatus", statusKey: "pi-remote-webui:controls", statusText: JSON.stringify({ type: "firstpick.pi-package-remote-webui.controls", version: 1, title: "Remote WebUI", description: "Open, close, and protect LAN access.", commands: { open: "/remote" } }) });
  emit({ type: "extension_ui_request", id: "status-cwd", method: "setStatus", statusKey: "cd-history", statusText: "cwd ~/project" });
  emit({
    type: "extension_ui_request", id: "status-footer", method: "setStatus", statusKey: "git-footer-webui",
    statusText: JSON.stringify({
      type: "firstpick.git-footer-status.footer", version: 1, generatedAt: 1,
      main: [{ key: "pi", icon: "π", label: "pi", value: "45k tok", title: "PI context" }, { key: "git", icon: "", label: "git", value: "main ↑1", title: "Branch <b>main</b>" }, { key: "cwd", label: "cwd", value: "~/project" }],
      meta: [{ key: "speed", label: "speed", value: "42 tok/s" }, { key: "context", label: "pi", value: "45k tok" }, { key: "model", label: "model", value: "x" }, { label: "", value: "" }],
    }),
  });
  emitDialogs();
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "**Planning user notification strategy**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "**Planning user notification strategy**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "**Deciding on partial validation response**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "**Deciding on partial validation response**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 2 } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "**Discarded streamed draft**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 2, content: "**Discarded streamed draft**" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 3 } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "streamed draft" } });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "<b>read</b>", args: { path: "/tmp/<b>file</b>.txt", nested: { deep: true } } });
  emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "<b>read</b>", args: {}, partialResult: { content: [{ type: "text", text: "partial <i>output</i>" }] } });
  emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "<b>read</b>", result: { content: [{ type: "text", text: "final tool output" }] }, isError: false });
  emit({ type: "message_end", message: { role: "assistant", content: [
    { type: "thinking", thinking: "**Planning user notification strategy**" },
    { type: "thinking", thinking: "**Deciding on partial validation response**" },
    { type: "thinking", thinking: "" },
    { type: "text", text: "authoritative final" },
  ], stopReason: "stop" } });
  setTimeout(() => emit({ type: "agent_settled" }), 30);
}

function runMarkdown(command) {
  response(command);
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const chunk of MARKDOWN_SAMPLE.match(/[\s\S]{1,40}/g)) {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
  }
  // Delay the authoritative message so the backend's streaming render cadence is observable.
  setTimeout(() => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: MARKDOWN_SAMPLE }], stopReason: "stop" } });
    setTimeout(() => emit({ type: "agent_settled" }), 30);
  }, 200);
}

function runProviderError(command) {
  response(command);
  emit({ type: "agent_start" });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: `deterministic provider failure ${"x".repeat(700)}`,
    },
  });
  setTimeout(() => emit({ type: "agent_settled" }), 30);
}

function runToolError(command) {
  response(command);
  emit({ type: "agent_start" });
  emit({ type: "tool_execution_start", toolCallId: "tool-err", toolName: "bash", args: { command: "exit 1" } });
  emit({ type: "tool_execution_end", toolCallId: "tool-err", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "tool failed" }], stopReason: "stop" } });
  setTimeout(() => emit({ type: "agent_settled" }), 30);
}

function runDelayedAbort(command) {
  response(command);
  setTimeout(() => {
    activeAbort = true;
    emit({ type: "agent_start" });
    delayedContinuation = setTimeout(() => {
      activeAbort = false;
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "delayed run continued after abort" }] },
      });
      emit({ type: "agent_settled" });
    }, 200);
  }, 120);
}

function runLimits(command) {
  response(command);
  emit({ type: "agent_start" });
  for (let index = 0; index < 95; index += 1) {
    const text = index === 94 ? "x".repeat(10_000) : `bounded assistant row ${index}`;
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  }
  emit({ type: "agent_settled" });
}

// Thousands of essential tool records with large outputs: exercises the backend's bounded
// outbound queue while the consumer is not reading.
function runFlood(command) {
  response(command);
  emit({ type: "agent_start" });
  const output = "flood output ".repeat(400);
  let sent = 0;
  const pump = () => {
    for (let index = 0; index < 100 && sent < 2500; index += 1, sent += 1) {
      emit({ type: "tool_execution_start", toolCallId: `flood-${sent}`, toolName: "flood", args: { index: sent } });
      emit({ type: "tool_execution_end", toolCallId: `flood-${sent}`, toolName: "flood", result: { content: [{ type: "text", text: output }] }, isError: false });
    }
    if (sent < 2500) {
      setImmediate(pump);
      return;
    }
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "flood done" }], stopReason: "stop" } });
    emit({ type: "agent_settled" });
  };
  pump();
}

let grandchild = null;

function runGrandchild(command) {
  response(command);
  grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `grandchild ${grandchild.pid}` }], stopReason: "stop" } });
  emit({ type: "agent_settled" });
}

function handle(command) {
  capture(command);

  if (command.type === "get_state") {
    if (startupStage === "failed-state") {
      if (statePath) writeFileSync(statePath, "missing-state\n");
      response(command, false, { error: "deterministic startup state failure" });
      return;
    }
    if (startupStage === "missing-state") {
      if (statePath) writeFileSync(statePath, "recovered-state\n");
      return;
    }
    if (!startupNoiseSent && startupStage === "initial") {
      startupNoiseSent = true;
      process.stdout.write("{malformed rpc record}\n");
      emit({ type: "future_unknown_event", payload: "must be ignored" });
      emit({ type: "response", id: "qt-webui-stale-0", command: "get_state", success: true, data: { model: null } });
    }
    const lineEnding = startupStage === "initial" ? "\r\n" : "\n";
    emit({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: {
        model: currentModel,
        thinkingLevel: currentThinkingLevel,
        isStreaming: false,
        isCompacting: compacting,
        sessionId: currentSessionId,
        sessionName: currentSessionName,
        sessionFile: currentSessionFile,
        messageCount: historyFor(currentSessionFile).length,
      },
    }, lineEnding);
    return;
  }

  if (command.type === "extension_ui_response") {
    if (typeof command.id === "string" && command.id.startsWith("dialog-")) {
      dialogAnswers.set(command.id, command);
      maybeEmitDialogReceipts();
    }
    return;
  }

  if (command.type === "abort") {
    response(command);
    if (activeAbort) {
      activeAbort = false;
      clearTimeout(delayedContinuation);
      delayedContinuation = null;
      notify("QT_WEBUI_SMOKE_DELAYED_AGENT_ABORTED");
      emit({ type: "agent_settled", aborted: true });
    }
    return;
  }

  if (command.type === "switch_session") {
    switchCallCount += 1;
    const cancelledCalls = String(process.env.QT_WEBUI_FIXTURE_CANCEL_SWITCH_AT || "").split(",").filter(Boolean).map(Number);
    if (typeof command.sessionPath !== "string" || command.sessionPath.includes("cancel-me") || cancelledCalls.includes(switchCallCount)) {
      response(command, true, { data: { cancelled: true } });
      return;
    }
    currentSessionFile = command.sessionPath;
    const persisted = persistedSession(currentSessionFile);
    currentSessionId = persisted?.id ?? "fixture-session";
    currentSessionName = command.sessionPath.includes("resume-me") ? "Resumed session" : persisted?.name ?? "";
    const delay = Number(process.env.QT_WEBUI_FIXTURE_SWITCH_DELAY_MS) || 0;
    if (delay > 0) setTimeout(() => response(command, true, { data: { cancelled: false } }), delay);
    else response(command, true, { data: { cancelled: false } });
    return;
  }

  if (command.type === "new_session") {
    sessionSerial += 1;
    currentSessionFile = `/tmp/fixture-session-${sessionSerial}.jsonl`;
    currentSessionId = `fixture-session-${sessionSerial}`;
    currentSessionName = "";
    response(command, true, { data: { cancelled: false } });
    return;
  }

  if (command.type === "set_session_name") {
    currentSessionName = typeof command.name === "string" ? command.name : "";
    response(command);
    return;
  }

  if (command.type === "get_messages") {
    if (process.env.QT_WEBUI_FIXTURE_HISTORY_FAIL === "1") { response(command, false, { error: "history projection failed after switch" }); return; }
    response(command, true, { data: { messages: historyFor(currentSessionFile) } });
    return;
  }

  if (command.type === "get_session_stats") {
    response(command, true, { data: { sessionFile: currentSessionFile, sessionId: "fixture-session", userMessages: 3, assistantMessages: 2, toolCalls: 1, toolResults: 1, totalMessages: 7,
      tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 }, cost: 0.45, contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 } } });
    return;
  }

  if (command.type === "get_commands") {
    response(command, true, { data: { commands: [
      ...(process.env.QT_WEBUI_FIXTURE_NO_HELPER === "1" ? [] : [{ name: "qt-webui-helper", description: "Internal resource helper", source: "extension" }]),
      { name: "review", description: "Review the current diff", source: "extension", path: "/tmp/ext/review.ts" },
      { name: "fix-tests", description: "Fix failing tests [31m![0m", source: "prompt", location: "project", path: "/tmp/project/.pi/agent/prompts/fix-tests.md" },
      { name: "skill:brave-search", description: "Web search", source: "skill", location: "user", path: "/tmp/skills/brave-search/SKILL.md" },
      { name: "bad name", description: "has whitespace", source: "extension" },
      { name: "review", description: "duplicate", source: "extension" },
      { description: "nameless" },
    ] } });
    return;
  }

  if (command.type === "get_available_models") {
    response(command, true, { data: { models: process.env.QT_WEBUI_FIXTURE_MANY_MODELS === "1"
      ? MODELS.concat(Array.from({ length: 300 }, (_, index) => ({ id: `bulk-${index}`, name: `Bulk ${index}`, provider: "bulk", reasoning: false })))
      : MODELS } });
    return;
  }

  if (command.type === "set_model") {
    const model = MODELS.find((entry) => entry && typeof entry === "object" && entry.id === command.modelId && entry.provider === command.provider && entry.id.length > 0);
    if (!model) {
      response(command, false, { error: `unknown model ${command.provider}/${command.modelId}` });
      return;
    }
    currentModel = model;
    if (!thinkingLevelsFor(model).includes(currentThinkingLevel)) currentThinkingLevel = "off";
    response(command, true, { data: model });
    return;
  }

  if (command.type === "cycle_model") {
    const selectable = MODELS.filter((entry) => entry && typeof entry === "object" && entry.id.length > 0 && entry.name !== "Duplicate");
    const next = selectable[(selectable.indexOf(currentModel) + 1) % selectable.length];
    currentModel = next;
    if (!thinkingLevelsFor(next).includes(currentThinkingLevel)) currentThinkingLevel = "off";
    response(command, true, { data: { model: next, thinkingLevel: currentThinkingLevel, isScoped: false } });
    return;
  }

  if (command.type === "get_available_thinking_levels") {
    response(command, true, { data: { levels: thinkingLevelsFor(currentModel).concat(["bogus"]) } });
    return;
  }

  if (command.type === "set_thinking_level") {
    if (!thinkingLevelsFor(currentModel).includes(command.level)) {
      response(command, false, { error: `thinking level ${command.level} is not supported by ${currentModel.id}` });
      return;
    }
    currentThinkingLevel = command.level;
    response(command);
    return;
  }

  if (command.type === "cycle_thinking_level") {
    const levels = thinkingLevelsFor(currentModel);
    if (levels.length < 2) {
      response(command, true, { data: null });
      return;
    }
    currentThinkingLevel = levels[(levels.indexOf(currentThinkingLevel) + 1) % levels.length];
    response(command, true, { data: { level: currentThinkingLevel } });
    return;
  }

  if (command.type === "compact") {
    compacting = true;
    emit({ type: "compaction_start", reason: "manual" });
    setTimeout(() => {
      compacting = false;
      if (command.customInstructions === "__QT_WEBUI_COMPACT_FAIL__") {
        emit({ type: "compaction_end", reason: "manual", result: null, aborted: false, errorMessage: "deterministic compaction failure" });
        response(command, false, { error: "deterministic compaction failure" });
        return;
      }
      const result = { summary: `Summary (${command.customInstructions ?? "default"}) \u001b[32mok\u001b[0m`, firstKeptEntryId: "kept-1", tokensBefore: 150_000, estimatedTokensAfter: 32_000, details: {} };
      emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      response(command, true, { data: result });
    }, 60);
    return;
  }

  if (command.type === "steer" || command.type === "follow_up") {
    response(command);
    emit({ type: "queue_update", steering: command.type === "steer" ? [command.message] : [], followUp: command.type === "follow_up" ? [command.message] : [] });
    return;
  }

  if (command.type !== "prompt") {
    response(command, false, { error: `unsupported fixture command: ${command.type}` });
    return;
  }

  if (String(command.message).startsWith("/qt-webui-helper ")) {
    helperCallCount += 1;
    const callSelected = (name) => String(process.env[name] || "").split(",").filter(Boolean).map(Number).includes(helperCallCount);
    const commandSilent = callSelected("QT_WEBUI_FIXTURE_HELPER_COMMAND_SILENT_AT");
    const configuredNotifyDelay = process.env.QT_WEBUI_FIXTURE_HELPER_NOTIFY_DELAY_MS
      || (process.env.QT_WEBUI_PI_REQUEST_TIMEOUT_MS === "10000" ? "40" : "0");
    const notifyDelayMs = Number.parseInt(configuredNotifyDelay, 10) || 0;
    let request;
    try {
      request = JSON.parse(String(command.message).slice("/qt-webui-helper ".length));
    } catch (error) {
      if (!commandSilent) response(command);
      notify(`__QT_WEBUI_HELPER__${JSON.stringify({ requestId: "", ok: false, error: error.message })}`);
      return;
    }
    if (callSelected("QT_WEBUI_FIXTURE_HELPER_EXIT_AT")) process.exit(24);
    if (callSelected("QT_WEBUI_FIXTURE_HELPER_ERROR_BEFORE_RESPONSE_AT")) {
      notify(`__QT_WEBUI_HELPER__${JSON.stringify({ requestId: request.requestId, ok: false, error: "deterministic early helper error" })}`);
      setTimeout(() => response(command), 30);
      return;
    }
    if (!commandSilent) response(command);
    if (process.env.QT_WEBUI_FIXTURE_HELPER_SILENT === "1" || callSelected("QT_WEBUI_FIXTURE_HELPER_SILENT_AT")) return;
    const answer = (record) => {
      const send = () => notify(`__QT_WEBUI_HELPER__${JSON.stringify(record)}`);
      if (notifyDelayMs > 0) setTimeout(send, notifyDelayMs);
      else send();
    };
    try {
      if (callSelected("QT_WEBUI_FIXTURE_HELPER_FAIL_AT")) throw new Error(`deterministic helper failure at call ${helperCallCount}`);
      if (request.action === "apply") {
        const session = request.payload && request.payload.session;
        if (session && typeof session === "object") {
          for (const field of ["tools", "skills", "sampling"]) {
            if (Object.hasOwn(session, field)) helperSession[field] = session[field] === null ? null : structuredClone(session[field]);
          }
        }
        if (request.payload && request.payload.effective) helperEffective = structuredClone(request.payload.effective);
      } else if (request.action !== "state") throw new Error("unknown helper action");
      const api = typeof currentModel.api === "string" ? currentModel.api : "";
      const supported = api === "openai-completions" ? new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed"])
        : api === "google-generative-ai" ? new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "top_k"])
          : new Set();
      const labels = { temperature: "temperature", top_p: "top p", frequency_penalty: "frequency penalty", presence_penalty: "presence penalty", seed: "seed", top_k: "top k", min_p: "min p" };
      const capabilities = Object.fromEntries(Object.keys(labels).map((key) => [key, { supported: supported.has(key), reason: supported.has(key) ? "" : api ? `${api} does not accept ${labels[key]}` : "no active model" }]));
      const helperTools = helperToolsForFixture();
      const activeTools = helperEffective.tools === null ? helperTools.map((entry) => entry.name) : helperEffective.tools;
      const enabledSkills = helperEffective.skills === null ? HELPER_SKILLS.map((entry) => entry.name) : helperEffective.skills;
      const data = {
        model: { provider: currentModel.provider, id: currentModel.id, api },
        thinkingLevel: currentThinkingLevel,
        session: {
          ...structuredClone(helperSession),
          durability: process.env.QT_WEBUI_FIXTURE_EPHEMERAL === "1"
            ? { durable: false, reason: "This Pi session is ephemeral; resource overrides apply only until it ends." }
            : { durable: true, reason: "" },
        },
        tools: { all: helperTools.map((entry) => ({ ...entry, enabled: activeTools.includes(entry.name) })), active: activeTools, baseline: helperTools.map((entry) => entry.name) },
        skills: { all: HELPER_SKILLS, enabled: enabledSkills },
        scopedModels: scopedModelsForFixture(),
        sampling: { applied: structuredClone(helperEffective.sampling || {}), api, capabilities, thinkingActive: currentModel.reasoning === true && currentThinkingLevel !== "off" },
      };
      answer({ requestId: request.requestId, ok: true, data });
    } catch (error) {
      answer({ requestId: request?.requestId || "", ok: false, error: error.message });
    }
    return;
  }

  // Attachments append fenced blocks below the typed prompt, so scenarios key on the first line.
  switch (String(command.message).split("\n")[0]) {
    case "__QT_WEBUI_STREAM__":
      runStream(command);
      break;
    case "__QT_WEBUI_MARKDOWN__":
      runMarkdown(command);
      break;
    case "__QT_WEBUI_ACCEPT_DELAY__":
      setTimeout(() => response(command), 500);
      break;
    case "__QT_WEBUI_IMMEDIATE__":
      response(command);
      break;
    case "__QT_WEBUI_EFFECTIVE__":
      notify(`QT_WEBUI_HELPER_EFFECTIVE ${JSON.stringify(helperEffective)}`);
      response(command);
      break;
    case "__QT_WEBUI_PROVIDER_ERROR__":
      runProviderError(command);
      break;
    case "__QT_WEBUI_TOOL_ERROR__":
      runToolError(command);
      break;
    case "__QT_WEBUI_FAIL__":
      response(command, false, { error: "deterministic prompt rejection" });
      break;
    case "__QT_WEBUI_DELAYED_ABORT__":
      runDelayedAbort(command);
      break;
    case "__QT_WEBUI_LIMITS__":
      runLimits(command);
      break;
    case "__QT_WEBUI_STDERR_FLOOD__": {
      response(command);
      let index = 0;
      const produce = () => {
        while (index < 4000) {
          const writable = process.stderr.write(`pressure-stderr-${index++} ${"x".repeat(450)}\n`);
          if (!writable) { process.stderr.once("drain", produce); return; }
        }
      };
      setTimeout(produce, 20);
      break;
    }
    case "__QT_WEBUI_FLOOD__":
      runFlood(command);
      break;
    case "__QT_WEBUI_GRANDCHILD__":
      runGrandchild(command);
      break;
    case "__QT_WEBUI_SILENT__":
      // Accept the prompt but never answer: exercises client-side timeouts.
      break;
    case "__QT_WEBUI_SAVE_FIRST__":
    case "__QT_WEBUI_SAVE_AND_EXIT__": {
      writeFileSync(currentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "saved-first", cwd: process.cwd() })}\n`);
      response(command);
      if (command.message === "__QT_WEBUI_SAVE_FIRST__") {
        emit({ type: "agent_start" });
        emit({ type: "agent_settled" });
      } else setTimeout(() => process.exit(23), 20);
      break;
    }
    case "__QT_WEBUI_EXIT__":
      response(command);
      if (statePath) writeFileSync(statePath, "failed-state\n");
      setTimeout(() => process.exit(23), 20);
      break;
    default:
      response(command, false, { error: "unexpected fixture prompt" });
      break;
  }
}

// Strict LF-only JSONL reader (Pi's protocol forbids readline's Unicode separators).
const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try {
      const command = JSON.parse(line);
      if (command && typeof command === "object") handle(command);
    } catch (error) {
      process.stderr.write(`fake-pi-rpc received invalid JSON: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
});
process.stdin.on("end", () => {
  // Like Pi, stop owned tool processes when the client goes away, then exit.
  clearTimeout(delayedContinuation);
  if (grandchild && grandchild.exitCode === null) grandchild.kill("SIGTERM");
  process.exit(process.exitCode ?? 0);
});
