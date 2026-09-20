#!/usr/bin/env node
// Minimal JSONL RPC stub standing in for the pi coding agent so HTTP endpoint
// tests can boot the real pi-webui server without a model provider.
//
// Optional env-gated features (default off; without them the voice scripting
// and logging additions are inert and command responses are unchanged, except
// that "steer" now gets an explicit success payload instead of the generic
// default-case response — no test asserts on either shape):
// - FAKE_PI_LOG_FILE=<path>: append one JSON line per received RPC command
//   ({direction:"command", type, message}) plus one per scripted event emitted
//   ({direction:"event", type}), so browser-driver tests can assert ordering.
// - FAKE_PI_VOICE_SCRIPTS=1: prompts containing "voice test say|question|tool|slow"
//   respond success and then asynchronously emit a scripted agent event flow
//   (agent_start/message_*/tool_execution_*/agent_end/agent_settled) over stdout; the scripted
//   assistant turns are appended to a dynamic transcript returned by
//   get_messages AFTER the three baseline messages, and get_state reports
//   isStreaming=true while a scripted flow runs.
// - FAKE_PI_STATS_PROMPT_CONTEXT=1: advertise /stats-webui and publish deterministic
//   structured or malformed-subsection Prompt/context dashboard payloads.
// - FAKE_PI_TRANSCRIPT_JSON=<JSON array>: replace only the three baseline get_messages
//   records with an isolated transcript fixture; dynamic/scripted messages still append.
// - FAKE_PI_INTERCOM_LIVE=1: accept the isolated "fixture modal transport live"
//   prompt and emit a generic Intercom tool stream with visible unrelated output.
// - FAKE_PI_GUIDED_GIT_ACTIVATION=1: advertise the Guided Git extension and
//   prompt companion, then emit its exact transient set/clear activation status.
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import {
  BUILTIN_SAMPLING_APIS,
  filterSupportedSamplingParameters,
  resolveSamplingParameterCapabilities,
} from "../../lib/sampling-parameter-capabilities.mjs";
import { validateSamplingParameterObject } from "../../public/sampling-parameter-controls.mjs";
import { longTranscriptMessages } from "./streaming-workloads.mjs";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex !== -1
  ? process.argv[sessionIndex + 1]
  : process.env.FAKE_PI_CONTINUITY_MODE === "1" ? process.env.FAKE_PI_CONTINUITY_SESSION_FILE || undefined : undefined;

let activeBash = 0;
let peakBash = 0;
let thinkingLevel = "off";
let conversationEnabled = false;
let codexFastModeEnabled = false;
let rejectNextCodexFastModeMutation = false;
const fakeTools = [
  { name: "read", description: "Read files", sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" } },
  { name: "bash", description: "Run shell commands", sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" } },
];
const fakeSkills = [
  { name: "repo-explorer", description: "Explore repositories" },
  { name: "code-security", description: "Review code security" },
];
let enabledToolNames = new Set(fakeTools.map((tool) => tool.name));
let enabledSkillNames = new Set(fakeSkills.map((skill) => skill.name));
let fakeSessionSamplingParams = {};
const fakeSamplingModel = {
  provider: "fake",
  id: "fake-model",
  name: "Fake Model",
  api: "openai-completions",
  samplingParams: { temperature: 0.7 },
};

function fakeSamplingState() {
  const parameters = resolveSamplingParameterCapabilities(fakeSamplingModel);
  return {
    session: { ...fakeSessionSamplingParams },
    defaults: { ...fakeSamplingModel.samplingParams },
    effective: {
      ...filterSupportedSamplingParameters(fakeSamplingModel.samplingParams, parameters),
      ...filterSupportedSamplingParameters(fakeSessionSamplingParams, parameters),
    },
    support: {
      supported: Object.values(parameters).some((capability) => capability.supported),
      api: fakeSamplingModel.api,
      model: {
        provider: fakeSamplingModel.provider,
        id: fakeSamplingModel.id,
        name: fakeSamplingModel.name,
      },
      parameters,
      compatibleApis: [...BUILTIN_SAMPLING_APIS],
      message: "Session sampling parameters apply to subsequent provider requests.",
    },
  };
}

const voiceScriptsEnabled = process.env.FAKE_PI_VOICE_SCRIPTS === "1";
// The continuity harness opts into this behavior explicitly so existing fixture
// consumers retain their current timing and log shapes.
const continuityModeEnabled = process.env.FAKE_PI_CONTINUITY_MODE === "1";
const largePayloadsEnabled = process.env.FAKE_PI_LARGE_PAYLOADS === "1";
const sseFloodEnabled = process.env.FAKE_PI_SSE_FLOOD === "1";
const statsPromptContextEnabled = process.env.FAKE_PI_STATS_PROMPT_CONTEXT === "1";
const intercomLiveEnabled = process.env.FAKE_PI_INTERCOM_LIVE === "1";
const guidedGitActivationEnabled = process.env.FAKE_PI_GUIDED_GIT_ACTIVATION === "1";
const guidedGitStateMode = String(process.env.FAKE_PI_GUIDED_GIT_STATE || "").trim();
const guidedGitActivationDelayMs = Math.max(0, Number.parseInt(process.env.FAKE_PI_GUIDED_GIT_ACTIVATION_DELAY_MS || "0", 10) || 0);
const fakeTranscriptMessages = (() => {
  const source = process.env.FAKE_PI_TRANSCRIPT_JSON;
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) && parsed.every((message) => message && typeof message === "object" && !Array.isArray(message)) ? parsed : null;
  } catch {
    return null;
  }
})();
const streamIsolationEnabled = process.env.FAKE_PI_STREAM_ISOLATION === "1";
const commandLogFile = process.env.FAKE_PI_LOG_FILE || "";
const largeRpcText = "large-rpc-payload:" + "λ".repeat(70_000);
const largeTokenSamples = Array.from({ length: 300 }, (_, index) => ({ index, input: index + 1, output: index + 2 }));
const staticEntries = [
  { type: "message", id: "u0000001", parentId: null, timestamp: new Date(1000).toISOString(), message: { role: "user", content: "fake prompt", timestamp: 1000 } },
  { type: "message", id: "a0000001", parentId: "u0000001", timestamp: new Date(2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "fake answer" }], timestamp: 2000 } },
  { type: "message", id: "u0000002", parentId: "a0000001", timestamp: new Date(3000).toISOString(), message: { role: "user", content: "fake follow-up", timestamp: 3000 } },
];
const dynamicEntries = [];
const dynamicMessages = [];
let dynamicLeafId = "u0000002";
let scriptedStreaming = false;
let continuityRun = 0;
let streamIsolationRun = 0;
const pendingStreamIsolationRuns = new Map();
let streamIsolationLongTranscriptPopulated = false;
let largeTranscriptEnabled = false;
const fixtureSubagentRuns = [];
const fixtureSubagentGates = [];
const runtimeQueue = {
  steering: ["runtime steering"],
  followUp: ["runtime first", "runtime second", "runtime third"],
  steeringMessages: [],
  followUpMessages: [],
};

function runtimeQueuedMessage(text, timestamp) {
  return {
    role: "user",
    timestamp,
    metadata: { fixture: "runtime-queue" },
    content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
  };
}

runtimeQueue.steeringMessages = runtimeQueue.steering.map((text, index) => runtimeQueuedMessage(text, 100 + index));
runtimeQueue.followUpMessages = runtimeQueue.followUp.map((text, index) => runtimeQueuedMessage(text, 200 + index));

function runtimeQueueSnapshot() {
  return { source: "pi-runtime", steering: [...runtimeQueue.steering], followUp: [...runtimeQueue.followUp] };
}

function sameRuntimeQueue(expected) {
  return Array.isArray(expected?.steering) && Array.isArray(expected?.followUp)
    && expected.steering.length === runtimeQueue.steering.length
    && expected.followUp.length === runtimeQueue.followUp.length
    && expected.steering.every((text, index) => text === runtimeQueue.steering[index])
    && expected.followUp.every((text, index) => text === runtimeQueue.followUp[index]);
}

function mutateRuntimeQueue(payload = {}) {
  const failed = (reason) => ({ mutated: false, reason, queue: runtimeQueueSnapshot() });
  if (payload.source !== "pi-runtime" || payload.kind !== "followUp" || !sameRuntimeQueue(payload.expected)) return failed("queue-changed");
  const operation = payload.operation;
  if (!operation || typeof operation.expectedText !== "string") return failed("invalid-request");
  if (operation.type === "edit") {
    if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index >= runtimeQueue.followUp.length
      || runtimeQueue.followUp[operation.index] !== operation.expectedText || typeof operation.text !== "string" || !operation.text.trim()) return failed("invalid-request");
    const message = runtimeQueue.followUpMessages[operation.index];
    const textPartIndex = message.content.findIndex((part) => part?.type === "text");
    if (textPartIndex < 0) return failed("queue-desynchronized");
    runtimeQueue.followUp[operation.index] = operation.text;
    runtimeQueue.followUpMessages[operation.index] = { ...message, content: message.content.map((part, index) => index === textPartIndex ? { ...part, text: operation.text } : part) };
  } else if (operation.type === "move") {
    if (!Number.isInteger(operation.from) || !Number.isInteger(operation.to) || operation.from < 0 || operation.to < 0
      || operation.from >= runtimeQueue.followUp.length || operation.to >= runtimeQueue.followUp.length || operation.from === operation.to
      || runtimeQueue.followUp[operation.from] !== operation.expectedText) return failed("invalid-request");
    const [text] = runtimeQueue.followUp.splice(operation.from, 1);
    const [message] = runtimeQueue.followUpMessages.splice(operation.from, 1);
    runtimeQueue.followUp.splice(operation.to, 0, text);
    runtimeQueue.followUpMessages.splice(operation.to, 0, message);
  } else if (operation.type === "delete") {
    if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index >= runtimeQueue.followUp.length
      || runtimeQueue.followUp[operation.index] !== operation.expectedText) return failed("invalid-request");
    runtimeQueue.followUp.splice(operation.index, 1);
    runtimeQueue.followUpMessages.splice(operation.index, 1);
  } else {
    return failed("invalid-request");
  }
  emitEvent({ type: "queue_update", steering: [...runtimeQueue.steering], followUp: [...runtimeQueue.followUp] });
  return { mutated: true, source: "pi-runtime", queue: runtimeQueueSnapshot() };
}

function allSessionEntries() {
  return [...staticEntries, ...dynamicEntries];
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "").filter(Boolean).join(" ");
}

function forkMessages() {
  return allSessionEntries()
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => ({ entryId: entry.id, text: messageText(entry.message.content) }));
}

function appendDynamicMessage(message) {
  const prefix = message.role === "assistant" ? "a" : "u";
  const entry = {
    type: "message",
    id: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 7)}`,
    parentId: dynamicLeafId,
    timestamp: new Date().toISOString(),
    message,
  };
  dynamicEntries.push(entry);
  dynamicMessages.push(message);
  dynamicLeafId = entry.id;
  return entry;
}

function logJsonLine(entry) {
  if (!commandLogFile) return;
  try {
    appendFileSync(commandLogFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // Logging must never break the fixture.
  }
}

logJsonLine({
  direction: "startup",
  cwd: process.cwd(),
  recoveryUrl: String(process.env.PI_WEBUI_RECOVERY_URL || ""),
  recoveryTokenConfigured: Boolean(process.env.PI_WEBUI_RECOVERY_TOKEN),
  recoveryTokenDigest: process.env.PI_WEBUI_RECOVERY_TOKEN
    ? createHash("sha256").update(process.env.PI_WEBUI_RECOVERY_TOKEN).digest("hex")
    : "",
  ...(continuityModeEnabled ? { pid: process.pid, continuityMode: true } : {}),
});

function continuityExitMarker(signal) {
  if (continuityModeEnabled) logJsonLine({ direction: "exit", signal, pid: process.pid });
}

if (continuityModeEnabled) {
  process.on("SIGTERM", () => {
    continuityExitMarker("SIGTERM");
    process.exit(143);
  });
  process.on("SIGINT", () => {
    continuityExitMarker("SIGINT");
    process.exit(130);
  });
}


function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitEvent(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitScriptedEvent(payload) {
  logJsonLine({
    direction: "event",
    type: payload.type,
    ...(payload.toolName ? { toolName: payload.toolName } : {}),
    ...(payload.assistantMessageEvent?.type ? { assistantMessageEventType: payload.assistantMessageEvent.type } : {}),
    ...(payload.isolationRunId ? { isolationRunId: payload.isolationRunId } : {}),
    ...(payload.isolationMode ? { isolationMode: payload.isolationMode } : {}),
    ...(payload.isolationPhase ? { isolationPhase: payload.isolationPhase } : {}),
    ...(Number.isInteger(payload.isolationDeltaIndex) ? { isolationDeltaIndex: payload.isolationDeltaIndex } : {}),
  });
  emitEvent(payload);
}

const scriptedTimers = new Set();

function runScriptedSteps(steps) {
  let at = 0;
  for (const step of steps) {
    at += step.afterMs ?? 0;
    const timer = setTimeout(() => {
      scriptedTimers.delete(timer);
      step.run();
    }, at);
    scriptedTimers.add(timer);
  }
}

function cancelScriptedSteps() {
  for (const timer of scriptedTimers) clearTimeout(timer);
  scriptedTimers.clear();
}

// Emits a full scripted assistant turn: agent_start, optional tool phase,
// streamed assistant text, message_end, agent_end, agent_settled. The final assistant text is
// appended to the dynamic transcript so get_messages returns it afterwards.
function runVoiceScriptFlow({ text, chunks, chunkSpacingMs = 60, toolPhase = false, toolDurationMs = 1500 }) {
  scriptedStreaming = true;
  const steps = [{ afterMs: 30, run: () => emitScriptedEvent({ type: "agent_start" }) }];
  if (toolPhase) {
    const toolCallId = `voice-tool-${randomUUID()}`;
    steps.push({ afterMs: 50, run: () => emitScriptedEvent({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "README.md" } }) });
    steps.push({ afterMs: toolDurationMs, run: () => emitScriptedEvent({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false, result: { content: [{ type: "text", text: "fake tool output" }] } }) });
  }
  steps.push({ afterMs: toolPhase ? 120 : 50, run: () => emitScriptedEvent({ type: "message_start", message: { role: "assistant" } }) });
  for (const delta of chunks || [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
    steps.push({ afterMs: chunkSpacingMs, run: () => emitScriptedEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }) });
  }
  steps.push({
    afterMs: chunkSpacingMs,
    run: () => {
      const message = { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
      appendDynamicMessage(message);
      emitScriptedEvent({ type: "message_end", message });
    },
  });
  steps.push({ afterMs: 60, run: () => emitScriptedEvent({ type: "agent_end" }) });
  steps.push({
    afterMs: 10,
    run: () => {
      scriptedStreaming = false;
      emitScriptedEvent({ type: "agent_settled" });
    },
  });
  runScriptedSteps(steps);
}

function runIntercomLiveScript() {
  scriptedStreaming = true;
  const toolCallId = "live-intercom-call";
  const normalText = "LIVE NORMAL OUTPUT VISIBLE";
  const toolCall = {
    type: "toolCall",
    id: toolCallId,
    name: "intercom",
    arguments: { action: "send", to: "peer-live", message: "LIVEINTERCOMARGUMENTSECRET" },
  };
  const assistantMessage = { role: "assistant", content: [{ type: "text", text: normalText }, toolCall], timestamp: Date.now() };
  const toolResult = {
    role: "toolResult",
    toolCallId,
    toolName: "intercom",
    content: [{ type: "text", text: "LIVEINTERCOMRESULTSECRET" }],
    isError: false,
    timestamp: Date.now() + 1,
  };
  runScriptedSteps([
    { afterMs: 30, run: () => emitScriptedEvent({ type: "agent_start" }) },
    { afterMs: 30, run: () => emitScriptedEvent({ type: "message_start", message: { role: "assistant" } }) },
    { afterMs: 40, run: () => emitScriptedEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: normalText } }) },
    { afterMs: 40, run: () => emitScriptedEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: toolCallId, toolName: "intercom" } }) },
    { afterMs: 30, run: () => emitScriptedEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(toolCall.arguments) } }) },
    { afterMs: 30, run: () => emitScriptedEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, name: "intercom", toolCall } }) },
    { afterMs: 30, run: () => emitScriptedEvent({ type: "tool_execution_start", toolCallId, toolName: "intercom", args: toolCall.arguments }) },
    { afterMs: 40, run: () => emitScriptedEvent({ type: "tool_execution_update", toolCallId, toolName: "intercom", partialResult: { content: toolResult.content } }) },
    { afterMs: 40, run: () => emitScriptedEvent({ type: "tool_execution_end", toolCallId, toolName: "intercom", isError: false, result: { content: toolResult.content } }) },
    { afterMs: 40, run: () => {
      appendDynamicMessage(assistantMessage);
      appendDynamicMessage(toolResult);
      emitScriptedEvent({ type: "message_end", message: assistantMessage });
    } },
    { afterMs: 40, run: () => emitScriptedEvent({ type: "agent_end" }) },
    { afterMs: 10, run: () => {
      scriptedStreaming = false;
      emitScriptedEvent({ type: "agent_settled" });
    } },
  ]);
}

function handleGuidedGitActivationPrompt(command, base) {
  if (!guidedGitActivationEnabled || !/^\/git-guided-workflow(?::\d+)?$/u.test(String(command.message || "").trim())) return false;
  respond({ ...base, data: { output: "Guided Git WebUI activation requested" } });
  const statusKey = "git-guided-workflow:webui-start";
  const statusText = JSON.stringify({
    type: "firstpick.pi-extension-git-guided-workflow.start",
    version: 1,
    action: "start",
    requestId: randomUUID(),
  });
  const emitActivation = () => {
    emitEvent({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText });
    emitEvent({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey });
  };
  if (guidedGitActivationDelayMs > 0) setTimeout(emitActivation, guidedGitActivationDelayMs);
  else emitActivation();
  return true;
}

function handleIntercomLivePrompt(command, base) {
  if (!intercomLiveEnabled || String(command.message || "").trim() !== "fixture modal transport live") return false;
  appendDynamicMessage({ role: "user", content: String(command.message), timestamp: Date.now() });
  respond({ ...base, data: { output: "fake live transport accepted", pid: process.pid } });
  runIntercomLiveScript();
  return true;
}

function runContinuityDelayedStream() {
  scriptedStreaming = true;
  const text = "continuity stream complete";
  const run = ++continuityRun;
  const tagged = (payload) => ({ ...payload, continuityRun: run });
  const steps = [
    { afterMs: 80, run: () => emitScriptedEvent(tagged({ type: "agent_start", continuityStep: "start" })) },
    { afterMs: 80, run: () => emitScriptedEvent(tagged({ type: "message_start", continuityStep: "message-start", message: { role: "assistant" } })) },
    { afterMs: 300, run: () => emitScriptedEvent(tagged({ type: "message_update", continuityStep: "delta-1", assistantMessageEvent: { type: "text_delta", delta: "continuity " } })) },
    { afterMs: 300, run: () => emitScriptedEvent(tagged({ type: "message_update", continuityStep: "delta-2", assistantMessageEvent: { type: "text_delta", delta: "stream " } })) },
    { afterMs: 300, run: () => emitScriptedEvent(tagged({ type: "message_update", continuityStep: "delta-3", assistantMessageEvent: { type: "text_delta", delta: "complete" } })) },
    { afterMs: 100, run: () => {
      const message = { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
      appendDynamicMessage(message);
      emitScriptedEvent(tagged({ type: "message_end", continuityStep: "message-end", message }));
    } },
    { afterMs: 80, run: () => emitScriptedEvent(tagged({ type: "agent_end", continuityStep: "end" })) },
    { afterMs: 10, run: () => {
      scriptedStreaming = false;
      emitScriptedEvent(tagged({ type: "agent_settled", continuityStep: "settled" }));
    } },
  ];
  runScriptedSteps(steps);
}

function runContinuityDelayedStart() {
  runScriptedSteps([{ afterMs: 3500, run: runContinuityDelayedStream }]);
}

function runContinuityConfirmedBeforeTool() {
  scriptedStreaming = true;
  runScriptedSteps([{ afterMs: 1500, run: () => runTranscriptContinuityScenario("tool") }]);
}

function runTranscriptContinuityScenario(scenario) {
  scriptedStreaming = true;
  const run = ++continuityRun;
  const tagged = (payload) => ({ ...payload, continuityRun: run, continuityScenario: scenario });
  const steps = [];
  const start = () => steps.push(
    { afterMs: 40, run: () => emitScriptedEvent(tagged({ type: "agent_start" })) },
    { afterMs: 40, run: () => emitScriptedEvent(tagged({ type: "message_start", message: { role: "assistant" } })) },
  );
  const finish = (message, afterMs = 160) => {
    if (message) {
      steps.push({ afterMs, run: () => {
        const settledMessage = typeof message === "function" ? message() : message;
        appendDynamicMessage(settledMessage);
        emitScriptedEvent(tagged({ type: "message_end", message: settledMessage }));
      } });
    }
    steps.push(
      { afterMs: message ? 60 : afterMs, run: () => emitScriptedEvent(tagged({ type: "agent_end" })) },
      { afterMs: 20, run: () => {
        scriptedStreaming = false;
        emitScriptedEvent(tagged({ type: "agent_settled" }));
      } },
    );
  };
  const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });

  if (scenario === "reverse") {
    const text = "backward selection literal survives";
    start();
    steps.push(
      { afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "backward selection literal" } })) },
      { afterMs: 650, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " survives" } })) },
    );
    finish(assistant(text), 400);
  } else if (scenario === "duplicate") {
    const text = "duplicate keyed selection literal";
    start();
    steps.push({ afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })) });
    finish(assistant(text), 400);
  } else if (scenario === "pointer") {
    const text = "pointer drag selection literal remains after update";
    start();
    steps.push(
      { afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pointer drag selection literal" } })) },
      { afterMs: 900, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " remains after update" } })) },
    );
    finish(assistant(text), 1_000);
  } else if (scenario === "thinking") {
    start();
    steps.push(
      { afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking selection literal" } })) },
      { afterMs: 650, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: " survives" } })) },
    );
    finish({ role: "assistant", content: [{ type: "thinking", thinking: "thinking selection literal survives" }, { type: "text", text: "thinking final answer" }], timestamp: Date.now() }, 450);
  } else if (scenario === "order") {
    const toolCallId = `continuity-order-${run}`;
    const toolCall = { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "order.txt" } };
    start();
    steps.push(
      { afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "ordering thinking" } })) },
      { afterMs: 500, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ordering assistant output" } })) },
      { afterMs: 1_000, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, name: "read", toolCall } })) },
      { afterMs: 100, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, name: "read", toolCall, delta: "" } })) },
      { afterMs: 200, run: () => emitScriptedEvent(tagged({ type: "webui_supervisor_reconnected", supervisorScopeId: `continuity-order-${run}`, supervisorEpoch: "1", supervisorSeq: "1" })) },
      { afterMs: 800, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, name: "read", toolCall } })) },
    );
    finish({ role: "assistant", content: [{ type: "thinking", thinking: "ordering thinking" }, toolCall], timestamp: Date.now() }, 700);
  } else if (scenario === "tool") {
    const toolCallId = `continuity-tool-${run}`;
    const toolOutput = (revision) => [
      "tool selection literal",
      `unselected revision ${revision}`,
      ...Array.from({ length: 64 }, (_, index) => `continuity output line ${String(index + 1).padStart(2, "0")} ${"x".repeat(160)}`),
    ].join("\n");
    steps.push(
      { afterMs: 40, run: () => emitScriptedEvent(tagged({ type: "agent_start" })) },
      { afterMs: 70, run: () => emitScriptedEvent(tagged({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "continuity.txt" } })) },
      { afterMs: 100, run: () => emitScriptedEvent(tagged({ type: "tool_execution_update", toolCallId, toolName: "read", partialResult: { content: [{ type: "text", text: toolOutput("one") }] } })) },
      { afterMs: 700, run: () => emitScriptedEvent(tagged({ type: "tool_execution_update", toolCallId, toolName: "read", partialResult: { content: [{ type: "text", text: toolOutput("two") }] } })) },
      { afterMs: 600, run: () => emitScriptedEvent(tagged({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false, result: { content: [{ type: "text", text: toolOutput("two") }] } })) },
    );
    finish(null, 120);
  } else if (scenario === "authoritative") {
    start();
    steps.push({ afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "authoritative selection literal" } })) });
    finish(assistant("authoritative replacement text"), 700);
  } else if (scenario === "cadence") {
    const prefix = "high cadence selection literal\n\n";
    let finalText = prefix;
    start();
    steps.push({ afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prefix } })) });
    steps.push({ afterMs: 800, run: () => {
      for (let index = 0; index < 96; index += 1) {
        const delta = `c${String(index).padStart(2, "0")} `;
        finalText += delta;
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }));
      }
    } });
    finish(() => assistant(finalText), 500);
  } else if (scenario === "dwell") {
    const prefix = "thirty second selection literal anchor\n\n";
    let finalText = prefix;
    start();
    steps.push({ afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: prefix } })) });
    for (let index = 0; index < 300; index += 1) {
      const delta = `d${String(index).padStart(3, "0")} `;
      finalText += delta;
      steps.push({ afterMs: 100, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } })) });
    }
    finish(() => assistant(finalText), 200);
  } else if (scenario === "mode") {
    const text = "output mode transition literal";
    start();
    steps.push(
      { afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })) },
      { afterMs: 3_000, run: () => emitScriptedEvent(tagged({ type: "webui_output_mode", protocolVersion: 1, activeMode: "compact-v1" })) },
    );
    finish(assistant(text), 1_200);
  } else if (scenario === "mermaid") {
    const text = "Mermaid source selection literal\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n";
    start();
    steps.push({ afterMs: 120, run: () => emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })) });
    finish(assistant(text), 1800);
  } else {
    return false;
  }
  runScriptedSteps(steps);
  return true;
}

function handleTranscriptContinuityPrompt(command, base) {
  if (!continuityModeEnabled) return false;
  const match = String(command.message || "").trim().match(/^fixture transcript continuity (reverse|duplicate|pointer|thinking|order|tool|authoritative|cadence|dwell|mode|mermaid)$/);
  if (!match) return false;
  appendDynamicMessage({ role: "user", content: String(command.message), timestamp: Date.now() });
  respond({ ...base, data: { output: `fake transcript continuity ${match[1]} accepted`, pid: process.pid } });
  return runTranscriptContinuityScenario(match[1]);
}

function handleMobileBlockerPrompt(command, base) {
  if (String(command.message || "").trim() !== "fixture mobile blocker") return false;
  respond({ ...base, data: { output: "mobile blocker fixture accepted" } });
  // Model a handled extension command: it opens a dialog without starting an
  // agent turn, so the browser must settle from the accepted prompt response.
  emitEvent({
    type: "extension_ui_request",
    id: "fixture_blocker_12345678",
    method: "confirm",
    title: "Fixture blocker",
    message: "Confirm the background-tab blocker.",
  });
  return true;
}

function handleContinuityPrompt(command, base) {
  if (!continuityModeEnabled) return false;
  const message = String(command.message || "").trim();
  if (!["fixture continuity delayed stream", "fixture continuity delayed start", "fixture continuity confirmed before tool"].includes(message)) return false;
  appendDynamicMessage({ role: "user", content: String(command.message), timestamp: Date.now() });
  respond({ ...base, data: { output: "fake continuity stream accepted", pid: process.pid } });
  if (message === "fixture continuity delayed start") runContinuityDelayedStart();
  else if (message === "fixture continuity confirmed before tool") runContinuityConfirmedBeforeTool();
  else runContinuityDelayedStream();
  return true;
}

function handleLargePayloadPrompt(command, base) {
  if (!largePayloadsEnabled || String(command.message || "").trim() !== "fixture large rpc payload") return false;
  largeTranscriptEnabled = true;
  respond({ ...base, data: { output: largeRpcText, tokens: { input: 123456, output: 654321 }, samples: largeTokenSamples } });
  return true;
}

function handleSseFloodPrompt(command, base) {
  const message = String(command.message || "").trim();
  if (!sseFloodEnabled || !["fixture sse flood", "fixture sse stall flood"].includes(message)) return false;
  respond({ ...base, data: { output: "fake SSE flood accepted" } });
  const payload = "s".repeat(8192);
  const eventCount = message === "fixture sse stall flood" ? 4096 : 256;
  for (let index = 0; index < eventCount; index += 1) {
    emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${index}:${payload}` } });
  }
  return true;
}

function handleVoiceScriptPrompt(command, base) {
  if (!voiceScriptsEnabled) return false;
  const message = String(command.message || "");
  const marker = ["voice test say", "voice test question", "voice test tool", "voice test slow"].find((item) => message.includes(item));
  if (!marker) return false;
  appendDynamicMessage({ role: "user", content: message, timestamp: Date.now() });
  respond({ ...base, data: { output: "voice scripted prompt accepted" } });
  if (marker === "voice test say") {
    runVoiceScriptFlow({ text: "Okay, this is the spoken answer." });
  } else if (marker === "voice test question") {
    runVoiceScriptFlow({ text: "Should we proceed with the next step?" });
  } else if (marker === "voice test tool") {
    runVoiceScriptFlow({ text: "The tool has finished.", toolPhase: true });
  } else {
    runVoiceScriptFlow({
      text: "This is a long streaming answer that keeps going.",
      chunks: ["This is a long ", "streaming answer ", "that keeps ", "going", "."],
      chunkSpacingMs: 500,
    });
  }
  return true;
}

function conversationStatusText() {
  return conversationEnabled ? "Voice: listening" : "";
}

function emitConversationStatus() {
  emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: "natural-conversation",
    statusText: conversationStatusText(),
  });
}

function emitCodexFastModeStatus() {
  emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: "codex-fast-mode",
    statusText: codexFastModeEnabled ? "on" : "off",
  });
}

function handleCodexFastModePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (message === "fixture reject next codex fast mode mutation") {
    rejectNextCodexFastModeMutation = true;
    // Prompt routing marks the tab active before RPC dispatch; settle this control-only fixture
    // synchronously so the following PUT exercises status confirmation rather than preflight busy.
    emitEvent({ type: "agent_start" });
    emitEvent({ type: "agent_settled" });
    respond({ ...base, data: { output: "next Codex Fast mode mutation will be rejected" } });
    return true;
  }
  const match = message.match(/^\/fast-mode(?:\s+(on|off|status))?$/i);
  if (!match) return false;
  const subcommand = String(match[1] || "").toLowerCase();
  if (subcommand !== "status" && rejectNextCodexFastModeMutation) {
    rejectNextCodexFastModeMutation = false;
    respond({ ...base, data: { output: "Fast mode mutation rejected while busy" } });
    return true;
  }
  if (!subcommand) codexFastModeEnabled = !codexFastModeEnabled;
  else if (subcommand === "on") codexFastModeEnabled = true;
  else if (subcommand === "off") codexFastModeEnabled = false;
  emitCodexFastModeStatus();
  respond({ ...base, data: { output: `Fast mode ${codexFastModeEnabled ? "on" : "off"}.` } });
  return true;
}

function handleWebuiHelperPrompt(command, base) {
  const message = String(command.message || "").trim();
  const match = message.match(/^\/webui-helper\s+(\{[\s\S]*\})$/);
  if (!match) return false;
  let request = {};
  try {
    request = JSON.parse(match[1]);
  } catch {
    request = {};
  }
  const requestId = String(request.requestId || "");
  const respondHelper = (payload) => emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "notify",
    message: `__PI_WEBUI_HELPER_RESPONSE__:${JSON.stringify(payload)}`,
    notifyType: payload.ok === false ? "error" : "info",
  });
  respond({ ...base, data: { output: "webui-helper handled" } });
  switch (request.action) {
    case "tools-state":
      respondHelper({ requestId, ok: true, data: { tools: fakeTools.map((tool) => ({ ...tool, enabled: enabledToolNames.has(tool.name) })) } });
      return true;
    case "tools-set": {
      if (request.payload?.mode === "inherit") enabledToolNames = new Set(fakeTools.map((tool) => tool.name));
      else if (Array.isArray(request.payload?.enabledTools)) enabledToolNames = new Set(request.payload.enabledTools.map(String));
      else if (Array.isArray(request.payload?.disabledTools)) {
        const disabled = new Set(request.payload.disabledTools.map(String));
        enabledToolNames = new Set(fakeTools.map((tool) => tool.name).filter((name) => !disabled.has(name)));
      }
      respondHelper({ requestId, ok: true, data: { tools: fakeTools.map((tool) => ({ ...tool, enabled: enabledToolNames.has(tool.name) })) } });
      return true;
    }
    case "skills-state":
      respondHelper({ requestId, ok: true, data: { skills: fakeSkills.map((skill) => ({ ...skill, enabled: enabledSkillNames.has(skill.name) })) } });
      return true;
    case "resources-recompute":
      respondHelper({ requestId, ok: true, data: {
        tools: { tools: fakeTools.map((tool) => ({ ...tool, enabled: enabledToolNames.has(tool.name) })) },
        skills: { skills: fakeSkills.map((skill) => ({ ...skill, enabled: enabledSkillNames.has(skill.name) })) },
      } });
      return true;
    case "skills-set": {
      if (request.payload?.mode === "inherit") enabledSkillNames = new Set(fakeSkills.map((skill) => skill.name));
      else if (Array.isArray(request.payload?.enabledSkills)) enabledSkillNames = new Set(request.payload.enabledSkills.map(String));
      else if (Array.isArray(request.payload?.disabledSkills)) {
        const disabled = new Set(request.payload.disabledSkills.map(String));
        enabledSkillNames = new Set(fakeSkills.map((skill) => skill.name).filter((name) => !disabled.has(name)));
      }
      respondHelper({ requestId, ok: true, data: { skills: fakeSkills.map((skill) => ({ ...skill, enabled: enabledSkillNames.has(skill.name) })) } });
      return true;
    }
    case "sampling-state":
      respondHelper({ requestId, ok: true, data: fakeSamplingState() });
      return true;
    case "sampling-set": {
      const samplingParams = request.payload?.samplingParams;
      const plain = samplingParams && typeof samplingParams === "object" && !Array.isArray(samplingParams);
      if (!plain || Object.keys(samplingParams).length > 128 || Buffer.byteLength(JSON.stringify(samplingParams), "utf8") > 16 * 1024) {
        respondHelper({ requestId, ok: false, error: "Sampling parameters must be a bounded JSON object" });
        return true;
      }
      const normalized = JSON.parse(JSON.stringify(samplingParams));
      const validation = validateSamplingParameterObject(normalized);
      if (!validation.valid) {
        respondHelper({
          requestId,
          ok: false,
          error: `Invalid sampling parameters: ${Object.values(validation.errors).join(" ")}`,
        });
        return true;
      }
      fakeSessionSamplingParams = normalized;
      respondHelper({ requestId, ok: true, data: fakeSamplingState() });
      return true;
    }
    case "sampling-reset":
      fakeSessionSamplingParams = {};
      respondHelper({ requestId, ok: true, data: fakeSamplingState() });
      return true;
    case "queue-mutate":
      respondHelper({ requestId, ok: true, data: mutateRuntimeQueue(request.payload) });
      return true;
    case "subagent-output": {
      const opaqueSelection = request.payload?.outputId
        ? fixtureSubagentRuns.flatMap((run) => run.agents.map((agent) => ({ run, agent }))).find(({ run, agent }) => `h-${createHash("sha256").update(`${run.id}\0${agent.id}`).digest("hex").slice(0, 32)}` === request.payload.outputId)
        : null;
      const run = opaqueSelection?.run || fixtureSubagentRuns.find((candidate) => candidate.id === request.payload?.runId);
      const agent = opaqueSelection?.agent || run?.agents?.find((candidate) => candidate.id === request.payload?.agentId);
      if (!run || !agent) {
        respondHelper({ requestId, ok: false, error: "Subagent output is no longer tracked" });
        return true;
      }
      respondHelper({
        requestId,
        ok: true,
        data: {
          version: 1,
          runId: run.id,
          source: run.source,
          mode: run.mode,
          startedAt: run.startedAt,
          updatedAt: run.endedAt || Date.now(),
          agent: {
            id: agent.id,
            name: agent.name,
            index: agent.index,
            status: agent.status,
            currentTool: "read",
            currentToolArgs: "README.md",
            model: agent.model || "anthropic/claude-opus-4-8:high",
            thinking: agent.thinking || "high",
            telemetry: {
              promptInjectionTokens: 1234,
              inputTokens: 300,
              outputTokens: 100,
              tokenSpeed: 20,
              contextTokens: 240,
              contextWindow: 200_000,
              model: null,
              effort: null,
              rawSessionPayload: "must not leave fake helper telemetry",
            },
            recentTools: [{ tool: "grep", args: "Subagents", endMs: Date.now() - 200 }],
            recentOutput: ["Inspecting current implementation", "Waiting for the next tool result"],
            transcript: [
              {
                role: "assistant",
                timestamp: "2026-07-19T12:00:00.000Z",
                content: [
                  { type: "thinking", thinking: "Checking the fixture transcript." },
                  { type: "text", text: "Inspecting current implementation" },
                  { type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "README.md", offset: 1 } },
                  { type: "text", text: "Waiting for the next tool result" },
                ],
              },
              {
                role: "toolResult",
                timestamp: "2026-07-19T12:00:01.000Z",
                toolCallId: "fixture-read",
                toolName: "read",
                isError: false,
                content: [{ type: "text", text: "# Fixture README" }],
              },
            ],
            turnCount: 2,
            toolCount: 3,
            tokens: 420,
          },
        },
      });
      return true;
    }
    case "subagent-cancel": {
      const run = fixtureSubagentRuns.find((candidate) => candidate.id === request.payload?.runId);
      if (!run || run.status !== "running") {
        respondHelper({ requestId, ok: false, error: "Subagent run is not running" });
        return true;
      }
      const reason = String(request.payload?.reason || "").trim().slice(0, 120) || undefined;
      const note = String(request.payload?.note || "").trim().slice(0, 2000) || undefined;
      run.status = "cancelled";
      run.endedAt = Date.now();
      run.cancelReason = reason;
      run.cancelNote = note;
      run.cancelledBy = "user";
      run.agents = run.agents.map((agent) => ({ ...agent, status: "cancelled" }));
      emitSubagentFixtureStatus();
      respondHelper({ requestId, ok: true, data: { runId: run.id, state: "cancelled", delivery: "context", rpcMethod: "stop" } });
      return true;
    }
    case "subagent-dismiss": {
      const index = fixtureSubagentRuns.findIndex((candidate) => candidate.id === request.payload?.runId);
      const run = fixtureSubagentRuns[index];
      if (!run || run.status === "running") {
        respondHelper({ requestId, ok: false, error: "Subagent run cannot be dismissed" });
        return true;
      }
      fixtureSubagentRuns.splice(index, 1);
      emitSubagentFixtureStatus();
      respondHelper({ requestId, ok: true, data: { runId: request.payload?.runId, dismissed: true } });
      return true;
    }
    default:
      respondHelper({ requestId, ok: false, error: `Unknown webui-helper action: ${String(request.action || "")}` });
      return true;
  }
}

function handleDocumentArtifactFixturePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (message === "fixture document artifact clear") { for (let index = dynamicMessages.length - 1; index >= 0; index--) if (dynamicMessages[index]?.toolName === "docx_render") { dynamicMessages.splice(index, 1); dynamicEntries.splice(index, 1); } dynamicLeafId = dynamicEntries.at(-1)?.id || "u0000002"; respond({ ...base, data: { output: "fake document artifacts cleared" } }); return true; }
  if (message !== "fixture document artifact" || !process.env.FAKE_PI_ARTIFACT_MANIFEST) return false;
  const toolCallId = `artifact-${randomUUID()}`, artifact = { schema: "pi.artifact/v1", kind: "document", id: "fixture-document-artifact", revisionId: "fixture-revision", title: "fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pageCount: 1, manifestPath: process.env.FAKE_PI_ARTIFACT_MANIFEST, downloadPath: process.env.FAKE_PI_ARTIFACT_DOWNLOAD, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }, result = { content: [{ type: "text", text: "Rendered fixture document" }], details: { artifact } };
  appendDynamicMessage({ role: "toolResult", toolCallId, toolName: "docx_render", content: result.content, details: result.details, isError: false, timestamp: Date.now() });
  respond({ ...base, data: { output: "fake document artifact emitted" } });
  emitEvent({ type: "tool_execution_end", toolCallId, toolName: "docx_render", isError: false, result });
  return true;
}

function fastModeMessageUpdate(delta, accumulated) {
  const partial = { role: "assistant", content: [{ type: "text", text: accumulated }] };
  return {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0, partial },
  };
}

function runFastModeFixtureFlow({ barrierOnly = false } = {}) {
  const toolCallId = "fast-mode-tool";
  const firstText = "fast mode first delta ";
  const finalText = `${firstText}and final delta`;
  const finish = () => {
    emitEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
    emitEvent({ type: "agent_end" });
    emitEvent({ type: "agent_settled" });
  };
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "message_start", message: { role: "assistant" } });
  emitEvent(fastModeMessageUpdate(firstText, firstText));
  if (barrierOnly) {
    setTimeout(finish, 180);
    return;
  }
  setTimeout(() => {
    emitEvent({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "fast-mode.txt" } });
    emitEvent({ type: "tool_execution_update", toolCallId, toolName: "read", partialResult: { content: [{ type: "text", text: "intermediate tool work" }] } });
    emitEvent({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false, result: { content: [{ type: "text", text: "final tool result" }] } });
    emitEvent({ type: "pi_stderr", text: "fast mode fixture diagnostic" });
    emitEvent({ type: "extension_ui_request", id: "fast-mode-dialog", method: "confirm", title: "Fast mode dialog", message: "Preserve this dialog" });
    emitEvent(fastModeMessageUpdate("and final delta", finalText));
    finish();
  }, 20);
}

function runFastModeHistoryFlow() {
  let accumulated = "";
  emitEvent({ type: "agent_start" });
  emitEvent({ type: "message_start", message: { role: "assistant" } });
  for (let index = 0; index < 512; index += 1) {
    const delta = `h${String(index).padStart(3, "0")}`;
    accumulated += delta;
    emitEvent(fastModeMessageUpdate(delta, accumulated));
  }
  emitEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: accumulated }] } });
  emitEvent({ type: "agent_end" });
  emitEvent({ type: "agent_settled" });
}

function handleFastModeFixturePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (!["fixture fast mode flow", "fixture fast mode barrier", "fixture fast mode history"].includes(message)) return false;
  respond({ ...base, data: { output: "fast mode fixture accepted" } });
  if (message.endsWith("history")) runFastModeHistoryFlow();
  else runFastModeFixtureFlow({ barrierOnly: message.endsWith("barrier") });
  return true;
}

function streamIsolationTextDelta(index, scenario = "standard") {
  if (scenario === "long-transcript") {
    const line = `const v${String(index).padStart(4, "0")} = ${index};\n`;
    if (index === 0) return `\`\`\`js\n${line}`;
    if (index === 999) return `${line}\`\`\`\nLONG-STREAM-TAIL`;
    return line;
  }
  const digit = String(index % 10);
  if (index === 0) return `ISOLATION-TEXT-BEGIN ${digit}`;
  if (index === 999) return `${digit} ISOLATION-TEXT-TAIL`;
  return digit;
}

function logStreamIsolationPhase(runId, mode, scenario, phase) {
  logJsonLine({ direction: "isolation-phase", isolationRunId: runId, isolationMode: mode, isolationScenario: scenario, isolationPhase: phase });
}

function ensureStreamIsolationLongTranscript() {
  if (streamIsolationLongTranscriptPopulated) return 1000;
  for (const message of longTranscriptMessages(1000)) appendDynamicMessage(message);
  streamIsolationLongTranscriptPopulated = true;
  return 1000;
}

function runStreamIsolationFixtureFlow(mode, scenario = "standard") {
  const runId = `stream-isolation-${mode}-${scenario}-${++streamIsolationRun}`;
  const retainedMessageCount = scenario === "long-transcript" ? ensureStreamIsolationLongTranscript() : 0;
  const toolCallId = `${runId}-execution`;
  const streamedToolCallId = `${runId}-call`;
  const textDeltas = Array.from({ length: 1_000 }, (_, index) => streamIsolationTextDelta(index, scenario));
  const finalText = textDeltas.join("");
  const thinkingText = "ISOLATION-THINKING-PATH";
  const toolCall = { type: "toolCall", id: streamedToolCallId, name: "read", arguments: { path: "isolation.txt" } };
  const tagged = (payload, phase) => ({
    ...payload,
    isolationRunId: runId,
    isolationMode: mode,
    isolationScenario: scenario,
    isolationPhase: phase,
  });
  const emitTextRange = (start, end, { finish = false } = {}) => {
    if (start === 0) emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } }, "raw"));
    for (let index = start; index < end; index += 1) {
      emitScriptedEvent({
        ...tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: textDeltas[index] } }, "raw"),
        isolationDeltaIndex: index,
      });
    }
    if (finish) emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, text: finalText } }, "raw"));
  };

  scriptedStreaming = true;
  const preburstStep = {
    afterMs: 25,
    run: () => {
      emitScriptedEvent(tagged({ type: "agent_start" }, "pre-burst"));
      if (mode === "compact") {
        emitScriptedEvent(tagged({ type: "message_start", message: { role: "assistant" } }, "pre-burst"));
        emitScriptedEvent(tagged({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "isolation.txt" } }, "pre-burst"));
      } else {
        emitScriptedEvent(tagged({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "isolation.txt" } }, "pre-burst"));
        emitScriptedEvent(tagged({ type: "message_start", message: { role: "assistant" } }, "pre-burst"));
      }
      logStreamIsolationPhase(runId, mode, scenario, "ready");
    },
  };
  const steps = [
    {
      afterMs: 0,
      run: () => {
        logStreamIsolationPhase(runId, mode, scenario, "raw-start");
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }, "raw"));
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: thinkingText } }, "raw"));
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_end", delta: thinkingText } }, "raw"));
      },
    },
  ];

  if (scenario === "paced-pressure") {
    for (let start = 0; start < 1_000; start += 10) {
      const end = start + 10;
      steps.push({
        afterMs: start === 0 ? 100 : 8,
        run: () => {
          emitTextRange(start, end);
          if (end !== 1_000) return;
          // Alternating kinds intentionally defeat adjacent coalescing. The
          // final text_end snapshot remains authoritative, so this pressure
          // phase can exercise queue bounds without changing settled output.
          for (let pressureIndex = 0; pressureIndex < 260; pressureIndex += 1) {
            emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "p" } }, "pressure"));
            emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x" } }, "pressure"));
          }
          emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, text: finalText } }, "raw"));
          logStreamIsolationPhase(runId, mode, scenario, "text-complete");
        },
      });
    }
  } else {
    steps.push({
      afterMs: 100,
      run: () => {
        if (scenario === "abort") {
          emitTextRange(0, 500);
          logStreamIsolationPhase(runId, mode, scenario, "abort-ready");
        } else {
          emitTextRange(0, 1_000, { finish: true });
          logStreamIsolationPhase(runId, mode, scenario, "text-complete");
        }
      },
    });
  }

  if (scenario === "abort") {
    // Keep a deterministic partial stream pending long enough for the browser
    // proof to inspect it and issue Abort; cancelScriptedSteps() must prevent
    // this fallback tail from ever being emitted after cancellation.
    steps.push({ afterMs: 30_000, run: () => emitTextRange(500, 1_000, { finish: true }) });
  }
  const completionSteps = [];
  steps.push(
    {
      afterMs: 1_500,
      run: () => {
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, name: "read", toolCall: { ...toolCall, arguments: undefined } } }, "raw"));
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, name: "read", toolCall: { ...toolCall, arguments: undefined }, delta: "{\"path\":\"isolation.txt\"}" } }, "raw"));
        emitScriptedEvent(tagged({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, name: "read", toolCall } }, "raw"));
      },
    },
    {
      afterMs: 100,
      run: () => {
        emitScriptedEvent(tagged({
          type: "tool_execution_update",
          toolCallId,
          toolName: "read",
          partialResult: { content: [{ type: "text", text: "ISOLATION-TOOL-UPDATE-COMPLETE" }] },
        }, "raw"));
        if (scenario === "lifecycle") {
          pendingStreamIsolationRuns.set(runId, () => {
            pendingStreamIsolationRuns.delete(runId);
            runScriptedSteps(completionSteps);
          });
        }
        logStreamIsolationPhase(runId, mode, scenario, "raw-end");
      },
    },
  );
  if (scenario === "lifecycle") {
    completionSteps.push({
      afterMs: 0,
      run: () => {
        emitScriptedEvent(tagged({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: "fixture retry" }, "semantic"));
        emitScriptedEvent(tagged({ type: "auto_retry_end", attempt: 1, success: true }, "semantic"));
        emitScriptedEvent(tagged({ type: "compaction_start", reason: "fixture" }, "semantic"));
        emitScriptedEvent(tagged({ type: "compaction_end", aborted: false }, "semantic"));
        emitScriptedEvent(tagged({ type: "webui_supervisor_reconnected", supervisorScopeId: runId, supervisorEpoch: "1", supervisorSeq: "1" }, "semantic"));
        logStreamIsolationPhase(runId, mode, scenario, "lifecycle-complete");
      },
    });
  }
  completionSteps.push(
    {
      // Keep the expensive long-transcript stream live long enough for the
      // browser ledger and continuity assertions to sample it before the
      // authoritative settlement replaces the transient bubble.
      afterMs: scenario === "long-transcript" ? 15_000 : 1_200,
      run: () => {
        emitScriptedEvent(tagged({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false, result: { content: [{ type: "text", text: "ISOLATION-TOOL-RESULT" }] } }, "post-burst"));
        logStreamIsolationPhase(runId, mode, scenario, "tool-complete");
      },
    },
    {
      afterMs: 500,
      run: () => {
        const message = {
          role: "assistant",
          content: [{ type: "thinking", thinking: thinkingText }, toolCall, { type: "text", text: finalText }],
          timestamp: Date.now(),
        };
        appendDynamicMessage(message);
        emitScriptedEvent(tagged({ type: "message_end", message }, "post-burst"));
        emitScriptedEvent(tagged({ type: "agent_end" }, "post-burst"));
        scriptedStreaming = false;
        emitScriptedEvent(tagged({ type: "agent_settled" }, "post-burst"));
        logStreamIsolationPhase(runId, mode, scenario, "settled");
      },
    },
  );
  runScriptedSteps([preburstStep]);
  pendingStreamIsolationRuns.set(runId, () => {
    pendingStreamIsolationRuns.delete(runId);
    runScriptedSteps(scenario === "lifecycle" ? steps : [...steps, ...completionSteps]);
  });
  return { runId, finalText, retainedMessageCount };
}

function continueStreamIsolationFixture(runId) {
  const start = pendingStreamIsolationRuns.get(runId);
  if (!start) return false;
  start();
  return true;
}

function handleStreamIsolationFixturePrompt(command, base) {
  if (!streamIsolationEnabled) return false;
  const message = String(command.message || "").trim();
  if (message === "fixture stream isolation populate long transcript") {
    respond({ ...base, data: { output: "stream isolation long transcript populated", retainedMessageCount: ensureStreamIsolationLongTranscript() } });
    return true;
  }
  const match = message.match(/^fixture stream isolation (normal|compact)(?: (standard|abort|lifecycle|background|long-transcript|paced-pressure))?$/);
  if (!match) return false;
  const mode = match[1];
  const scenario = match[2] || "standard";
  const { runId, finalText, retainedMessageCount } = runStreamIsolationFixtureFlow(mode, scenario);
  respond({ ...base, data: { output: "stream isolation fixture accepted", runId, deltaCount: 1_000, retainedMessageCount, mode, scenario, finalText } });
  return true;
}

function handleTransportFixturePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (message === "fixture stderr diagnostic") {
    process.stderr.write("fixture Pi RPC stderr diagnostic\n");
    respond({ ...base, data: { output: "fake stderr diagnostic emitted" } });
    return true;
  }
  if (message === "fixture oversized jsonl") {
    const bytes = Math.max(0, Math.min(64 * 1024 * 1024, Number.parseInt(process.env.FAKE_PI_OVERSIZED_JSONL_BYTES || "0", 10) || 0));
    if (bytes === 0) {
      respond({ ...base, success: false, error: "FAKE_PI_OVERSIZED_JSONL_BYTES must be configured" });
      return true;
    }
    // Intentionally leave this physical JSONL line unterminated long enough
    // for the server to switch into discard mode before sending a valid reply.
    process.stdout.write("x".repeat(bytes));
    setTimeout(() => {
      process.stdout.write("\n");
      respond({ ...base, data: { output: "fake oversized JSONL line discarded" } });
    }, 50);
    return true;
  }
  return false;
}

function emitSubagentFixtureStatus({ legacyOnly = false } = {}) {
  const now = Date.now();
  emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: "webui-subagents",
    statusText: `PI_WEBUI_SUBAGENTS_V1 ${JSON.stringify({ version: 1, available: true, updatedAt: now, runs: fixtureSubagentRuns, gates: fixtureSubagentGates })}`,
  });
  if (legacyOnly) return;
  const instances = fixtureSubagentRuns.flatMap((run) => run.agents.map((agent) => {
    const terminal = agent.status !== "running";
    const startedAt = run.startedAt;
    const endedAt = terminal ? run.endedAt || now : null;
    return {
      version: 1,
      instanceId: agent.id,
      runId: run.id,
      parentSessionId: "fake-session",
      launcher: run.source === "workflow" ? "workflow" : "pi-subagents",
      provider: run.source === "workflow" ? "workflow-run" : "pi-subagents",
      origin: run.source,
      name: agent.name,
      status: agent.status,
      startedAt,
      updatedAt: endedAt || now,
      endedAt,
      model: agent.model,
      thinking: agent.thinking,
      ...(agent.currentTool ? { currentTool: agent.currentTool } : {}),
      capabilities: { open: true, refresh: true, cancel: !terminal && run.source !== "workflow", steer: false },
      outputRef: { kind: "helper", id: `h-${createHash("sha256").update(`${run.id}\0${agent.id}`).digest("hex").slice(0, 32)}` },
    };
  }));
  emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: "webui-subagents-v2",
    statusText: `PI_WEBUI_SUBAGENTS_V2 ${JSON.stringify({ version: 2, available: true, updatedAt: now, instances, gateReferences: [], diagnostics: [] })}`,
  });
}

function handleSubagentFixturePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (!["fixture subagents running", "fixture subagents old-helper", "fixture subagents workflow", "fixture subagents clear", "fixture subagents retained"].includes(message)) return false;
  const now = Date.now();
  fixtureSubagentRuns.splice(0, fixtureSubagentRuns.length);
  fixtureSubagentGates.splice(0, fixtureSubagentGates.length);
  if (message === "fixture subagents running" || message === "fixture subagents old-helper") {
    fixtureSubagentRuns.push({
      id: "fixture-run",
      source: "async",
      mode: "parallel",
      status: "running",
      startedAt: now - 2500,
      agents: [
        { id: "fixture-run:0", name: "reviewer", status: "running", index: 0, currentTool: "read", model: "anthropic/claude-opus-4-8:high", thinking: "high", nested: false },
        { id: "fixture-run:1", name: "scout", status: "running", index: 1, model: "openai-codex/gpt-5.6-sol", thinking: "high", nested: false },
      ],
    });
    fixtureSubagentGates.push({
      version: 1,
      id: "fixture-gate",
      status: "running",
      requiredSuccesses: 2,
      qualifyingSuccesses: 1,
      requireDistinctProviders: true,
      startedAt: now - 3000,
      updatedAt: now,
      attempts: [
        { id: "fixture-gate:0:1", taskIndex: 0, attempt: 1, maxAttempts: 2, agent: "reviewer", retrySafety: "read-only", runId: "fixture-review-1", model: "anthropic/claude-opus-4-8", provider: "anthropic", status: "succeeded" },
        { id: "fixture-gate:1:1", taskIndex: 1, attempt: 1, maxAttempts: 2, agent: "reviewer", retrySafety: "read-only", runId: "fixture-review-2", model: "openrouter/moonshotai/kimi-k3", provider: "openrouter", status: "failed", failureKind: "transient-provider", error: "provider overloaded" },
      ],
    });
  } else if (message === "fixture subagents workflow") {
    fixtureSubagentRuns.push(
      {
        id: "fixture-workflow-controller",
        source: "recovered",
        mode: "single",
        status: "done",
        startedAt: now - 2500,
        agents: [
          { id: "fixture-workflow-controller:workflow", name: "workflow", status: "done", index: 0, nested: false },
        ],
      },
      {
        id: "fixture-workflow-worker",
        source: "recovered",
        mode: "single",
        status: "running",
        startedAt: now - 2450,
        agents: [
          { id: "fixture-workflow-worker:worker", name: "worker", status: "running", index: 0, model: "openai-codex/gpt-5.6-sol", thinking: "high", nested: false },
        ],
      },
    );
  } else if (message === "fixture subagents retained") {
    fixtureSubagentRuns.push(
      {
        id: "fixture-done",
        source: "foreground",
        mode: "single",
        status: "done",
        startedAt: now - 5000,
        endedAt: now - 2000,
        agents: [{ id: "fixture-done:0", name: "tester", status: "done", index: 0, model: "openai-codex/gpt-5.6-sol", thinking: "high", nested: false }],
      },
      {
        id: "fixture-cancelled",
        source: "async",
        mode: "parallel",
        status: "cancelled",
        startedAt: now - 4000,
        endedAt: now - 1000,
        cancelledBy: "user",
        cancelReason: "Taking too long",
        cancelNote: "Use the existing result instead.",
        agents: [{ id: "fixture-cancelled:0", name: "reviewer", status: "cancelled", index: 0, model: "anthropic/claude-opus-4-8:high", thinking: "high", nested: false }],
      },
    );
  }
  respond({ ...base, data: { output: "fake subagent status emitted" } });
  emitSubagentFixtureStatus({ legacyOnly: message === "fixture subagents old-helper" });
  return true;
}

function handleWorkflowFixturePrompt(command, base) {
  const message = String(command.message || "").trim();
  if (!/^fixture workflow inspector (running|completed|clear)$/.test(message)) return false;
  const status = message.split(" ").at(-1);
  const now = new Date().toISOString();
  const runs = status === "clear" ? [] : [{
    runId: "fixture-workflow-run",
    workflowKey: "fixture-workflow",
    workflowName: "Fixture Workflow",
    status,
    sourceType: "javascript",
    input: { topic: "rpc" },
    script: "export const meta = { name: 'fixture-workflow', description: 'Fixture Workflow' }\nreturn 1",
    startedAt: now,
    updatedAt: now,
    ...(status === "completed" ? { finishedAt: now, result: "fixture complete" } : {}),
    phases: [{
      phaseId: "audit", name: "Audit", status,
      agents: [{ callId: "fixture-call", callIndex: 1, taskId: "inspect", label: "inspect", name: "Inspect", status, prompt: "Inspect fixture", options: { tools: ["read"] }, recentEvents: [{ type: "stdout", timestamp: now, line: "read fixture" }], ...(status === "completed" ? { result: "inspected", usage: { input: 2, output: 1 } } : {}) }],
    }],
    controls: { canPause: status === "running", canResume: status === "completed", canAbort: status === "running", canRetry: status === "completed", canSave: status === "completed" },
  }];
  const payload = { type: "firstpick.pi-extension-workflows.inspector", version: 1, updatedAt: now, mode: { enabled: true, behavior: "persistent", phase: "armed" }, runs };
  respond({ ...base, data: { output: `fake workflow inspector ${status} emitted` } });
  emitEvent({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: "workflow:rpc", widgetLines: [`WORKFLOW_RPC_PAYLOAD ${JSON.stringify(payload)}`] });
  return true;
}

function handleTalkPrompt(command, base) {
  const message = String(command.message || "").trim();
  const match = message.match(/^\/(talk|voice|conversation)(?:\s+(\S+))?/i);
  if (!match) return false;
  const subcommand = String(match[2] || "").toLowerCase();
  if (!subcommand) conversationEnabled = !conversationEnabled;
  else if (["on", "enable", "start"].includes(subcommand)) conversationEnabled = true;
  else if (["off", "disable", "end", "stop"].includes(subcommand)) conversationEnabled = false;
  emitConversationStatus();
  respond({
    ...base,
    data: {
      output: conversationEnabled ? "Natural Conversation Mode on." : "Natural Conversation Mode off.",
      conversationMode: {
        enabled: conversationEnabled,
        uiState: conversationEnabled ? "listening" : "off",
        statusText: conversationStatusText(),
        allowedTools: ["read", "grep", "find", "ls"],
      },
    },
  });
  return true;
}

function statsPromptContextFixturePayload({ malformedSnapshot = false } = {}) {
  const hostileLabel = `System <img src=x onerror="globalThis.fixturePwned=true"> & "quoted" ${"long-label-".repeat(16)}`;
  const payload = {
    type: "firstpick.pi-extension-stats.overlay",
    version: 1,
    generatedAt: Date.now(),
    open: true,
    scopeLabel: "fixture prompt context",
    scope: { mode: "range", days: 14 },
    sessionCount: 0,
    scopedSessionCount: 0,
    dayCount: 14,
    activeDayCount: 0,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, messages: 1, unpricedMessages: 1 },
    costInfo: {
      source: "session-recorded",
      status: "partial",
      isEstimate: true,
      ollamaCloudMessageCount: 1,
      unpricedMessageCount: 1,
      warning: "Fixture Ollama Cloud cost estimate is partial because one token-bearing message has no recorded cost.",
    },
    promptEstimate: {
      total: 300, low: 270, high: 330, confidence: "fixture", calibrationMultiplier: 1,
      calibrationSamples: 0, source: "export-html", settled: true, attempts: 0,
      warning: null, systemPromptChars: 0, activeToolSchemas: 2,
    },
    promptContext: {
      initialPrompt: {
        totalTokens: 300,
        lowTokens: 270,
        highTokens: 330,
        confidence: "fixture",
        source: "export-html",
        warning: null,
        estimateMethod: "weighted-character-estimate-with-largest-remainder-calibration",
        components: [
          { id: "system-prompt-1", kind: "system-prompt", label: hostileLabel, chars: null, uncalibratedTokens: 300, tokens: 300, percent: 100 },
          { id: "framing-1", kind: "framing", label: "Zero-token framing", chars: 0, uncalibratedTokens: 0, tokens: 0, percent: 0 },
        ],
      },
      snapshot: {
        source: "export-html",
        settled: true,
        attempts: 0,
        warning: null,
        systemPromptChars: 0,
        estimateComponents: {
          promptText: malformedSnapshot ? "not-a-number" : 0,
          toolSchemas: 25,
          framing: 0,
          calibration: { multiplier: 1, samples: 0 },
        },
        metadata: { currentDate: null, cwdDisplay: null, extraGuidelineCount: 0 },
        tools: {
          totalCount: 3,
          omittedCount: 1,
          items: [
            { name: "<script>fixture-tool</script>", description: "Text-safe <b>description</b> & symbols", parameterSummary: "0 params", estimatedTokens: 0 },
            { name: "read", description: null, parameterSummary: "1 param, 1 required", estimatedTokens: 25 },
          ],
        },
        toolPromptEntries: { totalCount: 2, omittedCount: 0, names: ["<unsafe-entry>", "read"] },
        skills: { totalCount: 2, omittedCount: 1, items: [{ name: "fixture-skill", description: "Hostile </details> stays text" }] },
        contextFiles: {
          totalCount: 2,
          omittedCount: 0,
          items: [
            { displayPath: `nested/${"overflow-segment-".repeat(18)}context.md`, chars: null },
            { displayPath: "zero.md", chars: 0 },
          ],
        },
      },
      currentContext: {
        usage: { tokens: 0, contextWindow: null, percent: 0 },
        breakdown: {
          estimateMethod: "weighted-character-estimate",
          reconstruction: "complete",
          estimatedTotalTokens: 200,
          actualMinusEstimatedTokens: -200,
          sources: [
            { id: "user-messages-1", kind: "user-messages", label: `User ${"overflow-source-".repeat(18)}`, chars: 800, estimatedTokens: 200, percent: 100 },
          ],
        },
      },
    },
    summary: {},
    daily: [],
    models: [],
    expensiveSessions: [],
    lines: {
      graph: ["RAW_GRAPH_FIXTURE"],
      promptInjection: ["RAW_PROMPT_INJECTION <keep>& exact"],
      promptDetailed: ["RAW_PROMPT_DETAILED </pre> exact"],
      tokenBreakdown: ["RAW_CONTEXT_BREAKDOWN <raw> exact"],
      costTrend: ["RAW_COST_TREND"],
      cache: ["RAW_CACHE"],
      modelComparison: ["RAW_MODEL_COMPARISON"],
      expensiveSessions: ["RAW_EXPENSIVE_SESSIONS"],
    },
  };
  return payload;
}

const FEATURE_DECISION_FIXTURE_REASONS = {
  lightweight: "One localized WebUI slice with no migration or rollout work.",
  complex: "Crosses the classifier extension and the WebUI status consumer.",
};

function featureDecisionFixturePayload(mode) {
  if (mode === "lightweight" || mode === "complex") {
    return {
      output: JSON.stringify({ kind: `feature_${mode}`, reason: FEATURE_DECISION_FIXTURE_REASONS[mode] }),
      category: `${mode}-feature`,
    };
  }
  // Legacy exact-label payload from a classifier build that predates the structured contract.
  if (mode === "legacy") return { output: "feature_complex", category: "complex-feature" };
  // Structured decision whose kind contradicts the category; the popup must stay unavailable.
  if (mode === "mismatch") {
    return {
      output: JSON.stringify({ kind: "feature_lightweight", reason: FEATURE_DECISION_FIXTURE_REASONS.lightweight }),
      category: "complex-feature",
    };
  }
  if (mode === "malformed") return { output: '{"kind":"feature_complex"}', category: "complex-feature" };
  return { output: undefined, category: undefined };
}

function handleFeatureDecisionFixturePrompt(command, base) {
  const match = String(command.message || "").trim().match(/^fixture feature decision (lightweight|complex|legacy|mismatch|malformed|clear)$/);
  if (!match) return false;
  const mode = match[1];
  const { output, category } = featureDecisionFixturePayload(mode);
  respond({ ...base, data: { output: `fake feature decision ${mode} emitted` } });
  emitEvent({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "feature-decision-output", statusText: output });
  emitEvent({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "feature-category", statusText: category });
  return true;
}

function handleStatsPromptContextFixturePrompt(command, base) {
  if (!statsPromptContextEnabled) return false;
  const message = String(command.message || "").trim();
  const malformedSnapshot = message === "fixture stats prompt malformed";
  if (!malformedSnapshot && !/^\/stats-webui(?:\s|$)/.test(message)) return false;
  respond({ ...base, data: { output: malformedSnapshot ? "malformed stats prompt fixture emitted" : "structured stats prompt fixture emitted" } });
  emitEvent({
    type: "extension_ui_request",
    id: randomUUID(),
    method: "setStatus",
    statusKey: "stats-webui",
    statusText: JSON.stringify(statsPromptContextFixturePayload({ malformedSnapshot })),
  });
  return true;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  const { id, type } = command || {};
  if (!id || !type) return;
  logJsonLine({
    direction: "command",
    type,
    ...(command.message !== undefined ? { message: String(command.message) } : {}),
    ...(Array.isArray(command.images) ? { images: command.images } : {}),
    ...(command.provider !== undefined ? { provider: String(command.provider) } : {}),
    ...(command.modelId !== undefined ? { modelId: String(command.modelId) } : {}),
    ...(type === "extension_ui_response" ? { id: String(command.id), value: command.value, cancelled: command.cancelled === true } : {}),
  });
  const base = { type: "response", id, command: type, success: true };

  switch (type) {
    case "get_state":
      respond({
        ...base,
        data: {
          model: { provider: "fake", id: "fake-model" },
          thinkingLevel,
          isStreaming: scriptedStreaming || guidedGitStateMode === "streaming",
          isCompacting: guidedGitStateMode === "compacting",
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile,
          sessionId: "fake-session",
          sessionName: "fake",
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: guidedGitStateMode === "pending" ? 1 : 0,
        },
      });
      return;
    case "get_messages":
      respond({
        ...base,
        data: {
          messages: [
            ...(fakeTranscriptMessages || [
              { role: "user", content: "fake prompt", timestamp: 1000 },
              { role: "assistant", content: [{ type: "text", text: "fake answer" }], timestamp: 2000 },
              { role: "user", content: "fake follow-up", timestamp: 3000 },
            ]),
            ...dynamicMessages,
            ...(largeTranscriptEnabled ? [{ role: "assistant", content: [{ type: "text", text: largeRpcText }], timestamp: 4000 }] : []),
          ],
        },
      });
      return;
    case "get_commands":
      respond({
        ...base,
        data: {
          commands: [
            { name: "talk", source: "extension", description: "Toggle Natural Conversation Mode" },
            { name: "voice", source: "extension", description: "Natural Conversation Mode alias" },
            { name: "conversation", source: "extension", description: "Natural Conversation Mode alias" },
            { name: "fast-mode", source: "extension", description: "Toggle Codex subscription Fast mode" },
            { name: "workflow", source: "extension", description: "Run and inspect JavaScript workflows" },
            ...(guidedGitActivationEnabled ? [
              { name: "git-guided-workflow", source: "extension", description: "Start Guided Git" },
              { name: "git-staged-msg", source: "extension", description: "Generate commit messages" },
              { name: "git-branch-name", source: "extension", description: "Generate branch names" },
              { name: "pr", source: "extension", description: "Generate PR text" },
            ] : []),
            ...(statsPromptContextEnabled ? [{ name: "stats-webui", source: "extension", description: "Publish fixture stats dashboard" }] : []),
          ],
        },
      });
      return;
    case "get_fork_messages":
      respond({ ...base, data: { messages: forkMessages() } });
      return;
    case "get_entries": {
      const entries = allSessionEntries();
      if (command.since !== undefined) {
        const sinceIndex = entries.findIndex((entry) => entry.id === command.since);
        if (sinceIndex === -1) {
          respond({ ...base, success: false, error: `Entry not found: ${command.since}` });
          return;
        }
        respond({ ...base, data: { entries: entries.slice(sinceIndex + 1), leafId: dynamicLeafId } });
        return;
      }
      respond({ ...base, data: { entries, leafId: dynamicLeafId } });
      return;
    }
    case "prompt":
      if (handleGuidedGitActivationPrompt(command, base)) return;
      if (handleIntercomLivePrompt(command, base)) return;
      if (handleFeatureDecisionFixturePrompt(command, base)) return;
      if (handleStatsPromptContextFixturePrompt(command, base)) return;
      if (handleWebuiHelperPrompt(command, base)) return;
      if (handleFastModeFixturePrompt(command, base)) return;
      if (handleStreamIsolationFixturePrompt(command, base)) return;
      if (handleTransportFixturePrompt(command, base)) return;
      if (handleSubagentFixturePrompt(command, base)) return;
      if (handleDocumentArtifactFixturePrompt(command, base)) return;
      if (handleWorkflowFixturePrompt(command, base)) return;
      if (handleCodexFastModePrompt(command, base)) return;
      if (handleTalkPrompt(command, base)) return;
      if (handleMobileBlockerPrompt(command, base)) return;
      if (handleTranscriptContinuityPrompt(command, base)) return;
      if (handleContinuityPrompt(command, base)) return;
      if (handleLargePayloadPrompt(command, base)) return;
      if (handleSseFloodPrompt(command, base)) return;
      if (handleVoiceScriptPrompt(command, base)) return;
      respond({ ...base, data: { output: "fake prompt accepted" } });
      return;
    case "steer": {
      const match = String(command.message || "").trim().match(/^fixture stream isolation continue (stream-isolation-[A-Za-z0-9-]+)$/);
      if (match && continueStreamIsolationFixture(match[1])) {
        respond({ ...base, data: { output: "stream isolation raw phase started" } });
        return;
      }
      respond({ ...base, data: { output: "fake steer accepted" } });
      return;
    }
    case "abort":
      cancelScriptedSteps();
      respond({ ...base, data: { output: "fake abort accepted" } });
      emitScriptedEvent({ type: "agent_end", aborted: true });
      scriptedStreaming = false;
      emitScriptedEvent({ type: "agent_settled", aborted: true });
      return;
    case "set_thinking_level":
      thinkingLevel = String(command.level || "off");
      respond({ ...base, data: { level: thinkingLevel } });
      return;
    case "set_model":
      if (command.modelId === "missing-model") respond({ ...base, success: false, error: "Model not found: fake/missing-model" });
      else respond({ ...base, data: { provider: command.provider, id: command.modelId } });
      return;
    case "get_available_models":
      respond({ ...base, data: { models: [{ provider: "fake", id: "fake-model", name: "Fake Model" }] } });
      return;
    case "get_session_stats":
      respond({
        ...base,
        data: largePayloadsEnabled
          ? { tokens: { input: 123456, output: 654321, total: 777777 }, samples: largeTokenSamples }
          : { tokens: 0 },
      });
      return;
    case "get_last_assistant_text":
      respond({ ...base, data: { text: "fake last text" } });
      return;
    case "extension_ui_response":
      // Pi's extension UI response is a one-way RPC write. Deliberately emit
      // no response so supervised HTTP coverage catches accidental waits.
      return;
    case "bash": {
      activeBash += 1;
      peakBash = Math.max(peakBash, activeBash);
      setTimeout(() => {
        activeBash -= 1;
        respond({ ...base, data: { output: `peak:${peakBash}`, exitCode: 0, cancelled: false } });
      }, 150);
      return;
    }
    default:
      respond({ ...base, data: {} });
  }
});

rl.on("close", () => {
  // The parent (pi-webui or a test driver) closed stdin or died; never let
  // pending scripted voice events outlive it and write into a broken pipe.
  cancelScriptedSteps();
});
