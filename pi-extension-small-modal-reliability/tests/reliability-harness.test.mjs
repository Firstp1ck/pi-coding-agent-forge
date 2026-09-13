import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityHarnessExtension from "../index.ts";
import { addTrustedCheckMapping, applyParsedVerificationToCriteria, assessTaskCompletion, buildContextHeader, computeVerification, createPlanModeRun, createTaskState, extractPlanModeProgress, markTaskCompleteIfVerified, nativeAuthorityReceiptHash, nextPlanModePhaseAfterAgent, normalizeConfig, parseVerificationResult, reconcilePersistedToolResults, recordUserAttestation, redactSensitiveText, runOfflineReliabilityEvaluation, truncateRawLog } from "../src/core.ts";
import { buildDryRunOrchestration, parseVerificationEvidenceFromText, parseWorkerResultFromText } from "../src/orchestration.ts";

function createHarness(cwd, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const notifications = [];
  const sentUserMessages = [];
  const statuses = new Map();
  const widgets = new Map();
  const newSessions = [];
  const eventBusHandlers = new Map();
  const installedSessionManager = options.installedHost ? SessionManager.inMemory(cwd) : undefined;
  if (installedSessionManager) {
    installedSessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "installed host task" }], timestamp: Date.now() });
  }

  const pi = {
    registerFlag() {},
    getFlag(name) {
      return options.flags?.[name] ?? false;
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    getAllTools() {
      return [...["read", "grep", "find", "ls", "bash", "powershell", "write", "edit"].map((name) => ({
        name,
        sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
      })), ...(options.registeredControls ? [...tools.keys()].map(name => ({ name, sourceInfo: { source: "extension", path: "reliability-fixture" } })) : [])];
    },
    getCommands() {
      return [...commands.keys()].map(name => ({ name, source: "extension", sourceInfo: { source: "extension", path: "reliability-fixture" } }));
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    appendEntry(customType, data) {
      const entry = { id: `custom-${entries.length + 1}`, type: "custom", customType, data };
      entries.push(entry);
      installedSessionManager?.appendCustomEntry(customType, data);
    },
    sendMessage(message, sendOptions) { sentUserMessages.push({ content: message.content, customType: message.customType, options: sendOptions }); },
    sendUserMessage(content, sendOptions) {
      sentUserMessages.push({ content, options: sendOptions });
    },
    events: {
      emit(channel, data) {
        for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
      },
      on(channel, handler) {
        const handlersForChannel = eventBusHandlers.get(channel) ?? [];
        handlersForChannel.push(handler);
        eventBusHandlers.set(channel, handlersForChannel);
        return () => eventBusHandlers.set(channel, (eventBusHandlers.get(channel) ?? []).filter((item) => item !== handler));
      },
    },
  };

  reliabilityHarnessExtension(pi);

  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    getContextUsage: () => options.contextUsage?.value,
    model: options.model,
    modelRegistry: options.modelRegistry,
    waitForIdle: async () => {},
    async newSession(options = {}) {
      const sessionEntries = [];
      const sessionFile = join(cwd, `mock-new-session-${newSessions.length + 1}.jsonl`);
      const sessionManager = {
        appendCustomEntry(customType, data) {
          sessionEntries.push({ type: "custom", customType, data });
          return `custom-${sessionEntries.length}`;
        },
      };
      await options.setup?.(sessionManager);
      const sentUserMessagesForSession = [];
      const nextCtx = {
        ...ctx,
        sessionManager: {
          getBranch: () => sessionEntries,
          getSessionFile: () => sessionFile,
        },
        sendUserMessage: async (content, sendOptions) => {
          sentUserMessagesForSession.push({ content, options: sendOptions });
        },
      };
      await options.withSession?.(nextCtx);
      newSessions.push({ sessionFile, entries: sessionEntries, sentUserMessages: sentUserMessagesForSession });
      return { cancelled: false };
    },
    sessionManager: installedSessionManager ?? {
      getBranch: () => entries,
      getSessionId: () => "mock-native-session",
      getSessionFile: () => join(cwd, "mock-session.jsonl"),
    },
    ui: {
      confirm: async () => true,
      notify(message, level = "info") {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
      setWidget(key, value) {
        widgets.set(key, value);
      },
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
        strikethrough: (text) => text,
      },
    },
  };

  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, ctx));
    }
    return results;
  };

  return { commands, tools, emit, ctx, entries, notifications, sentUserMessages, statuses, widgets, newSessions };
}

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-test-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function taskIds(cwd) {
  return readdirSync(join(cwd, ".pi", "tasks"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("creates task state, scratchpad, and context header", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on implement login flow", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "implement login flow", systemPrompt: "sys" });

    const contextResults = await harness.emit("context", { messages: [{ role: "user", content: "hello" }] });
    const injectedMessages = contextResults.at(-1)?.messages ?? [];
    assert.equal(injectedMessages.length, 2);
    assert.match(JSON.stringify(injectedMessages.at(-1)), /RELIABILITY (LITE|HARNESS) ACTIVE/);

    const [taskId] = taskIds(cwd);
    assert.ok(taskId);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.normalized_goal, "implement login flow");
    assert.ok(state.plan.length >= 4);
    assert.match(readFileSync(join(cwd, ".pi", "tasks", taskId, "scratchpad.md"), "utf8"), /Task Scratchpad/);
  } finally {
    cleanup(cwd);
  }
});

test("installed lifecycle lane and pressure triggers retain context when their actual gates are not eligible", async () => {
  const cwd = tempCwd();
  try {
    const contextUsage = { value: { tokens: 90_000, contextWindow: 100_000, percent: 0.5 } };
    const harness = createHarness(cwd, { installedHost: true, flags: { reliability: true }, contextUsage });
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on implement guarded boundary flow", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "implement guarded boundary flow", systemPrompt: "sys" });

    // General -> retrieval establishes a real lane boundary but its outgoing
    // gate fails, so the installed lifecycle must retain provider history.
    await harness.commands.get("reliability").handler("lane retrieval", harness.ctx);
    await harness.emit("turn_end", { turnIndex: 1, message: { role: "assistant", content: [] } });
    const [taskId] = taskIds(cwd);
    let state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.context_checkpoints.length, 0);
    assert.match(state.context_reset.last_reason ?? "", /pressure has not reached|outgoing lane gate failed/i);

    // Pi's percent field is percentage units: 0.5 means 0.005 ratio, not 50%.
    contextUsage.value = { tokens: 99_000, contextWindow: 100_000, percent: 35 };
    await harness.emit("turn_end", { turnIndex: 2, message: { role: "assistant", content: [] } });
    state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.context_checkpoints.length, 0, "failed actual outgoing gate retains context even at pressure threshold");
    assert.match(state.context_reset.last_reason ?? "", /outgoing lane gate failed/i);
  } finally {
    cleanup(cwd);
  }
});

test("installed observations require native reaffirmation; expanded starts and extension continuations confer no authority", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd, { installedHost: true, flags: { reliability: true } });
    const manager = harness.ctx.sessionManager;
    await harness.emit("session_start");

    const original = "  Persist this exact interactive instruction.  ";
    const originalEntry = manager.appendMessage({ role: "user", content: [{ type: "text", text: original }], timestamp: Date.now() });
    await harness.emit("input", { source: "interactive", text: original });
    await harness.emit("before_agent_start", { prompt: "transformed original", systemPrompt: "sys" });
    assert.equal(manager.getBranch().some(entry => entry.customType === "reliability-authoritative-input"), false);
    await harness.commands.get("reliability").handler("input confirm", harness.ctx);
    const [taskId] = taskIds(cwd);
    let state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.authoritative_instructions.original_user_request.text, original);
    assert.equal(state.authoritative_instructions.original_user_request.origin, "native-confirmation");
    assert.notEqual(state.authoritative_instructions.original_user_request.session_entry_id, originalEntry);
    assert.equal(manager.getEntry(state.authoritative_instructions.original_user_request.session_entry_id)?.customType, "reliability-authoritative-input");

    const correction = "  Persist this exact RPC correction.  ";
    const correctionEntry = manager.appendMessage({ role: "user", content: [{ type: "text", text: correction }], timestamp: Date.now() });
    await harness.emit("input", { source: "rpc", text: correction });
    await harness.emit("before_agent_start", { prompt: correction, systemPrompt: "sys" });
    await harness.commands.get("reliability").handler("input confirm", harness.ctx);
    state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.authoritative_instructions.corrections.length, 1);
    assert.equal(state.authoritative_instructions.corrections[0].origin, "native-confirmation");
    assert.notEqual(state.authoritative_instructions.corrections[0].session_entry_id, correctionEntry);
    assert.equal(manager.getEntry(state.authoritative_instructions.corrections[0].session_entry_id)?.customType, "reliability-authoritative-input");

    const continuation = "[RELIABILITY PLAN MODE CONTINUATION] internal follow-up";
    await harness.emit("input", { source: "extension", text: continuation });
    await harness.emit("before_agent_start", { prompt: continuation, systemPrompt: "sys" });
    state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.authoritative_instructions.corrections.length, 1);
  } finally {
    cleanup(cwd);
  }
});

test("registered dependency tool accepts a scoped installed package with receipt-bound source and optional lock", async () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { dep: "^0.1.0" } }));
    writeFileSync(join(cwd, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "0.1.2" }));
    writeFileSync(join(cwd, "node_modules", "dep", "types.d.ts"), "export declare const dependency: string;\n");
    const harness = createHarness(cwd, { installedHost: true });
    const manager = harness.ctx.sessionManager;
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on record a dependency", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "record a dependency", systemPrompt: "sys" });
    const scope = harness.tools.get("reliability_scope");
    await scope.execute("dependency-read-scope", {
      action: "set", lane: "coding", allowedTools: ["read"], allowedReadPaths: [cwd], allowedWritePaths: [], forbiddenPaths: [],
      maxToolCalls: 12, maxErrors: 3, maxIterations: 12, externalSideEffects: "forbidden", validationCommands: [],
      stopConditions: ["Stop when done."], escalationConditions: ["Escalate missing source."],
    }, undefined, undefined, harness.ctx);
    for (const [id, path] of [["read-project", "package.json"], ["read-manifest", "node_modules/dep/package.json"], ["read-types", "node_modules/dep/types.d.ts"]]) {
      await harness.emit("tool_call", { toolCallId: id, toolName: "read", input: { path } });
      await harness.emit("tool_result", { toolCallId: id, toolName: "read", input: { path }, isError: false, content: [{ type: "text", text: readFileSync(join(cwd, path), "utf8") }] });
      manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: readFileSync(join(cwd, path), "utf8") }], isError: false, timestamp: Date.now() });
      await harness.emit("message_start", { message: { role: "assistant", content: [] } });
    }
    const evidence = harness.tools.get("reliability_evidence");
    const started = await evidence.execute("dependency-start", { action: "start", question: "Which installed dependency contract applies?", requirements: ["Use current installed source."] }, undefined, undefined, harness.ctx);
    const packId = started.details.summary.pack_id;
    const sourced = await evidence.execute("dependency-source", {
      action: "add-source", packId, sourceId: "S1", title: "dep 0.1.2 types", locator: "node_modules/dep/types.d.ts", sourceKind: "local-file",
      retrievedAt: "2026-09-12T12:00:00.000Z", passages: [{ passageId: "P1", text: "export declare const dependency: string;" }],
    }, undefined, undefined, harness.ctx);
    assert.ok(sourced.details.summary.revision_receipt_entry_id);
    const recorded = await evidence.execute("dependency-record", {
      action: "record-dependency", packId, package: "dep", installedVersion: "0.1.2", manifestPath: "node_modules/dep/package.json",
      sourceKind: "installed-types", sourceId: "S1", passageIds: ["P1"],
    }, undefined, undefined, harness.ctx);
    assert.equal(recorded.details.summary.pack_id, packId);
    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.match(state.dependency_evidence[0].source_content_sha256, /^[a-f0-9]{64}$/);
    assert.match(state.dependency_evidence[0].source_receipt_id, /^R/);
  } finally {
    cleanup(cwd);
  }
});

test("installed Pi navigation blocks unbound evidence create and update while persisted receipt continuation succeeds", async () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "source.txt"), "authoritative source\n");
    const harness = createHarness(cwd, { installedHost: true });
    const manager = harness.ctx.sessionManager;
    const taskAnchor = manager.getLeafId();
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on collect installed host evidence", harness.ctx);
    const evidence = harness.tools.get("reliability_evidence");

    manager.resetLeaf();
    await assert.rejects(
      evidence.execute("before-create", {
        action: "start",
        question: "What does the source establish?",
        requirements: ["Use exact source passages."],
      }, undefined, undefined, harness.ctx),
      /outside the task's persisted Pi branch/i,
    );

    manager.branch(taskAnchor);
    const created = await evidence.execute("create", {
      action: "start",
      question: "What does the source establish?",
      requirements: ["Use exact source passages."],
    }, undefined, undefined, harness.ctx);
    const [taskId] = taskIds(cwd);
    let state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    const createReceiptId = state.evidence_packs[0].revision_receipt_entry_id;
    assert.ok(createReceiptId);
    assert.equal(created.details.summary.revision_receipt_entry_id, createReceiptId);
    assert.equal(manager.getEntry(createReceiptId)?.customType, "reliability-evidence-revision");

    const packPath = join(cwd, ".pi", "tasks", taskId, "evidence", "E1.json");
    const beforeUpdate = readFileSync(packPath, "utf8");
    manager.branch(taskAnchor);
    await assert.rejects(
      evidence.execute("before-update", {
        action: "add-source",
        packId: "E1",
        sourceId: "S1",
        title: "Installed source",
        locator: "source.txt",
        sourceKind: "local-file",
        retrievedAt: "2026-09-12T12:00:00.000Z",
        passages: [{ passageId: "P1", text: "The installed host source supports the claim." }],
      }, undefined, undefined, harness.ctx),
      /finalized Pi revision receipt|persisted Pi branch revision/i,
    );
    assert.equal(readFileSync(packPath, "utf8"), beforeUpdate);

    manager.branch(createReceiptId);
    const updated = await evidence.execute("update", {
      action: "add-source",
      packId: "E1",
      sourceId: "S1",
      title: "Installed source",
      locator: "source.txt",
      sourceKind: "local-file",
      retrievedAt: "2026-09-12T12:00:00.000Z",
      passages: [{ passageId: "P1", text: "The installed host source supports the claim." }],
    }, undefined, undefined, harness.ctx);
    state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.evidence_packs[0].revision_receipt_entry_id, updated.details.summary.revision_receipt_entry_id);
    assert.notEqual(state.evidence_packs[0].revision_receipt_entry_id, createReceiptId);
    assert.equal(manager.getEntry(state.evidence_packs[0].revision_receipt_entry_id)?.customType, "reliability-evidence-revision");
  } finally {
    cleanup(cwd);
  }
});

test("installed SessionManager reconciles only after its tool result is persisted", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd, { installedHost: true });
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on verify installed host lifecycle", harness.ctx);
    const scopeTool = harness.tools.get("reliability_scope");
    await scopeTool.execute("installed-bash-scope", {
      action: "set", lane: "agentic", allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], forbiddenPaths: [],
      maxToolCalls: 20, maxErrors: 3, maxIterations: 20, externalSideEffects: "approval-required", validationCommands: [],
      stopConditions: ["Stop when the configured budget is exhausted."], escalationConditions: ["Escalate missing user authority."],
    }, undefined, undefined, harness.ctx);
    await harness.commands.get("reliability").handler("scope approve SC1", harness.ctx);
    const check = await scopeTool.execute("installed-bash-check", { action: "check", candidateTool: "bash", candidateInput: { command: "npm test" } }, undefined, undefined, harness.ctx);
    const approval = await scopeTool.execute("installed-bash-approval", {
      action: "request-approval", toolName: "bash", normalizedEffect: check.details.decision.normalized_effect,
      description: "Run the installed lifecycle validation.", reversible: true,
    }, undefined, undefined, harness.ctx);
    await harness.commands.get("reliability").handler(`approval approve ${approval.details.approvalId}`, harness.ctx);
    await harness.emit("before_agent_start", { prompt: "verify installed host lifecycle", systemPrompt: "sys" });
    await harness.emit("tool_call", { toolCallId: "provider-call-1", toolName: "bash", input: { command: "npm test" } });
    const fakeProviderResponse = { toolCallId: "provider-call-1", toolName: "bash", input: { command: "npm test" }, isError: false, content: [{ type: "text", text: "Tests: 1 passed" }], details: {} };
    await harness.emit("tool_result", fakeProviderResponse);
    await harness.emit("message_end", { message: { role: "toolResult", toolCallId: "provider-call-1", toolName: "bash", isError: false } });

    const [taskId] = taskIds(cwd);
    let state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(state.execution_receipts.at(-1)?.session_anchor_entry_id, undefined);

    const resultEntryId = harness.ctx.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "provider-call-1",
      toolName: "bash",
      content: [{ type: "text", text: "Tests: 1 passed" }],
      details: {},
      isError: false,
      timestamp: Date.now(),
    });
    await harness.emit("message_start", { message: { role: "assistant", content: [] } });
    await harness.emit("context", { messages: [] });

    state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    const receipt = state.execution_receipts.at(-1);
    assert.equal(receipt.host_provenance, "pi-builtin-bash");
    assert.equal(receipt.execution_observed, true);
    assert.equal(receipt.exit_code, 0);
    assert.equal(receipt.session_id, harness.ctx.sessionManager.getSessionId());
    assert.equal(receipt.session_anchor_entry_id, resultEntryId);
  } finally {
    cleanup(cwd);
  }
});

test("installed AgentSession runner reconciles persisted tool results across navigation and reload", async () => {
  const cwd = tempCwd();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-reliability-agent-dir-"));
  let session;
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('Tests: 1 passed')\"" } }));
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "reliability-test", api: "reliability-test" });
    modelRuntime.registerNativeProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "fake-bash-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The local lifecycle command completed."),
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "reliability-test", factory: reliabilityHarnessExtension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: provider.getModel(),
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      tools: ["bash"],
    });
    session = created.session;
    assert.equal(created.extensionsResult.errors.length, 0);
    await session.prompt("/reliability on verify runner lifecycle");
    const command = session.extensionRunner.getCommand("reliability");
    const scopeTool = session.extensionRunner.getToolDefinition("reliability_scope");
    assert.ok(command);
    assert.ok(scopeTool);
    const baseCommandContext = session.extensionRunner.createCommandContext();
    const commandContext = Object.create(baseCommandContext);
    const nativeUi = Object.create(baseCommandContext.ui);
    nativeUi.confirm = async () => true;
    nativeUi.notify = () => {};
    Object.defineProperties(commandContext, { hasUI: { value: true }, ui: { value: nativeUi } });
    await scopeTool.execute("runner-bash-scope", {
      action: "set", lane: "agentic", allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], forbiddenPaths: [],
      maxToolCalls: 20, maxErrors: 3, maxIterations: 20, externalSideEffects: "approval-required", validationCommands: [],
      stopConditions: ["Stop when the configured budget is exhausted."], escalationConditions: ["Escalate missing user authority."],
    }, undefined, undefined, commandContext);
    await command.handler("scope approve SC1", commandContext);
    const check = await scopeTool.execute("runner-bash-check", { action: "check", candidateTool: "bash", candidateInput: { command: "npm test" } }, undefined, undefined, commandContext);
    const approval = await scopeTool.execute("runner-bash-approval", {
      action: "request-approval", toolName: "bash", normalizedEffect: check.details.decision.normalized_effect,
      description: "Run the runner lifecycle validation.", reversible: true,
    }, undefined, undefined, commandContext);
    await command.handler(`approval approve ${approval.details.approvalId}`, commandContext);
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Run the supplied lifecycle command.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.equal(provider.state.callCount, 3);
    const receipt = state.execution_receipts.at(-1);
    assert.equal(receipt?.operation, "bash", JSON.stringify({ toolHistory: state.tool_history, receipts: state.execution_receipts, providerCalls: provider.state.callCount }));
    assert.equal(receipt?.host_provenance, "pi-builtin-bash");
    assert.equal(receipt?.session_id, session.sessionManager.getSessionId());

    const entries = session.sessionManager.getEntries();
    const toolCallEntry = entries.find((entry) => entry.type === "message"
      && entry.message.role === "assistant"
      && entry.message.content.some((part) => part.type === "toolCall" && part.id === "fake-bash-call"));
    const toolResultEntry = entries.find((entry) => entry.type === "message"
      && entry.message.role === "toolResult"
      && entry.message.toolCallId === "fake-bash-call"
      && entry.message.toolName === "bash");
    assert.ok(toolCallEntry);
    assert.ok(toolResultEntry);
    assert.equal(receipt?.session_anchor_entry_id, toolResultEntry.id);
    const scopeEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "reliability-scope-authorization");
    const approvalEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "reliability-exact-approval");
    assert.ok(scopeEntry);
    assert.ok(approvalEntry);
    const observedScopeReceipts = [{
      entry_id: scopeEntry.id,
      ...scopeEntry.data,
      receipt_hash: nativeAuthorityReceiptHash("reliability-scope-authorization", scopeEntry.data),
    }];
    const observedApprovalReceipts = [{
      entry_id: approvalEntry.id,
      ...approvalEntry.data,
      receipt_hash: nativeAuthorityReceiptHash("reliability-exact-approval", approvalEntry.data),
    }];

    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    applyParsedVerificationToCriteria(state, parseVerificationResult("npm test", "Tests: 1 passed", false), receipt);
    assert.equal(assessTaskCompletion(state, "explicit").decision, "pass");

    const inputReceipts = state.current_session.input_authority_receipts;
    const reloaded = SessionManager.inMemory(cwd, { id: session.sessionManager.getSessionId() }, entries);
    reloaded.branch(toolCallEntry.id);
    const beforeResult = {
      session_id: reloaded.getSessionId(),
      branch_entry_ids: reloaded.getBranch().map((entry) => entry.id),
      scope_authorization_receipts: observedScopeReceipts,
      scope_approval_receipts: observedApprovalReceipts,
      input_authority_receipts: inputReceipts,
      lifecycle_identity: "available",
      observed_at: new Date().toISOString(),
    };
    reconcilePersistedToolResults(state, beforeResult, reloaded.getBranch());
    assert.equal(computeVerification(state)[0]?.status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");

    reloaded.branch(toolResultEntry.id);
    reloaded.appendMessage({ role: "user", content: [{ type: "text", text: "Continue after the verified result." }], timestamp: Date.now() });
    const afterResult = {
      session_id: reloaded.getSessionId(),
      branch_entry_ids: reloaded.getBranch().map((entry) => entry.id),
      scope_authorization_receipts: observedScopeReceipts,
      scope_approval_receipts: observedApprovalReceipts,
      input_authority_receipts: inputReceipts,
      lifecycle_identity: "available",
      observed_at: new Date().toISOString(),
    };
    reconcilePersistedToolResults(state, afterResult, reloaded.getBranch());
    assert.equal(computeVerification(state)[0]?.status, "passed");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "pass");
  } finally {
    session?.dispose();
    cleanup(cwd);
    cleanup(agentDir);
  }
});

test("installed AgentSession never certifies uncorrelated interactive, RPC, duplicate or extension input", async () => {
  const cwd = tempCwd();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-reliability-input-agent-"));
  let session;
  try {
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const provider = fauxProvider({ provider: "reliability-input-test", api: "reliability-input-test" });
    modelRuntime.registerNativeProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage("interactive acknowledgement"),
      fauxAssistantMessage("same text acknowledgement"),
      fauxAssistantMessage("rpc acknowledgement"),
      fauxAssistantMessage("extension acknowledgement"),
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, extensionFactories: [{ name: "reliability-input-test", factory: reliabilityHarnessExtension }],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd, agentDir, model: provider.getModel(), modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader, tools: [],
    });
    session = created.session;
    await session.prompt("/reliability on initial command task");
    const raw = "  exact user text survives prompt processing  ";
    await session.prompt(raw, { source: "interactive" });
    await session.waitForIdle();
    await session.prompt(raw, { source: "interactive" });
    await session.waitForIdle();
    const rpc = "  exact rpc correction  ";
    await session.prompt(rpc, { source: "rpc", expandPromptTemplates: true });
    await session.waitForIdle();
    await session.prompt("[RELIABILITY PLAN MODE CONTINUATION] internal", { source: "extension" });
    await session.waitForIdle();

    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    const corrections = state.authoritative_instructions.corrections;
    assert.equal(corrections.length, 0);
    assert.ok(state.input_pause);
    assert.equal(JSON.stringify(state.input_pause).includes(raw), false);
    const authorities = session.sessionManager.getEntries().filter(entry => entry.customType === "reliability-authoritative-input");
    assert.equal(authorities.length, 1);
    assert.equal(authorities[0].data.origin, "user-command");
    assert.equal(corrections.some((item) => item.text.includes("CONTINUATION")), false);
  } finally {
    session?.dispose?.();
    cleanup(cwd);
    cleanup(agentDir);
  }
});

test("new session starts armed instead of auto-resuming latest task", async () => {
  const cwd = tempCwd();
  try {
    const original = createHarness(cwd, { flags: { reliability: true } });
    await original.emit("session_start", { reason: "startup" });
    await original.commands.get("reliability").handler("on previous live task", original.ctx);
    assert.equal(taskIds(cwd).length, 1);

    const fresh = createHarness(cwd, { flags: { reliability: true } });
    await fresh.emit("session_start", { reason: "new" });
    await fresh.commands.get("reliability").handler("status", fresh.ctx);
    assert.match(fresh.notifications.at(-1).message, /waiting for the next task/);
    assert.doesNotMatch(fresh.notifications.at(-1).message, /previous live task/);
    assert.deepEqual(fresh.widgets.get("reliability-harness"), ["Reliability harness armed for next task"]);

    const resumed = createHarness(cwd);
    resumed.entries.push(original.entries.at(-1));
    await resumed.emit("session_start", { reason: "resume" });
    await resumed.commands.get("reliability").handler("status", resumed.ctx);
    assert.match(resumed.notifications.at(-1).message, /previous live task/);
  } finally {
    cleanup(cwd);
  }
});

test("plan mode command starts exploration in the retained session with Markdown artifacts", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("--mode plan-on implement a plan-mode feature", harness.ctx);

    assert.equal(harness.newSessions.length, 0);
    const kickoff = harness.sentUserMessages[0].content;
    assert.match(kickoff, /Phase: EXPLORE/);
    assert.match(kickoff, /01-exploration\.md/);

    const [taskId] = taskIds(cwd);
    assert.ok(taskId);
    assert.match(readFileSync(join(cwd, ".pi", "tasks", taskId, "plan-mode", "01-exploration.md"), "utf8"), /Status: TODO/);
    const planProposal = readFileSync(join(cwd, ".pi", "tasks", taskId, "plan-mode", "02-implementation-plan.md"), "utf8");
    assert.match(planProposal, /## Proposed steps/);
    assert.match(planProposal, /Markdown status markers are not completion evidence/);
    assert.ok(harness.statuses.has("reliability-plan-mode"));
  } finally {
    cleanup(cwd);
  }
});

test("plan mode verification failure creates a failure artifact and requires a canonical remediation step", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ profile: "balanced" });
    const task = createTaskState(cwd, "fix verification failure", undefined, config);
    const run = createPlanModeRun(task);
    writeFileSync(run.artifacts.plan, [
      "# Detailed Implementation Plan",
      "",
      "Status: IN_PROGRESS",
      "",
      "## Progress",
      "- [x] Implement the feature",
    ].join("\n"));
    writeFileSync(run.artifacts.verification, [
      "# Plan Mode Verification",
      "",
      "Status: FAILED",
      "",
      "Tests failed with one assertion error.",
    ].join("\n"));
    run.phase = "verify";

    const decision = nextPlanModePhaseAfterAgent(run);
    const updatedPlan = readFileSync(run.artifacts.plan, "utf8");

    assert.equal(decision.phase, "implement");
    assert.equal(extractPlanModeProgress(updatedPlan).open, 0);
    assert.match(updatedPlan, /Verification remediation/);
    assert.match(updatedPlan, /canonical plan revision/i);
    assert.ok(readdirSync(run.artifacts.failuresDir).some((name) => name.endsWith(".md")));
  } finally {
    cleanup(cwd);
  }
});

test("adaptive default keeps simple tasks in lite mode", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on create a tiny file", harness.ctx);
    const before = await harness.emit("before_agent_start", { prompt: "create a tiny file", systemPrompt: "sys" });
    assert.match(before.at(-1).systemPrompt, /RELIABILITY LITE INSTRUCTIONS/);
    assert.doesNotMatch(before.at(-1).systemPrompt, /SUPERVISOR \/ WORKER SPLIT/);

    const contextResults = await harness.emit("context", { messages: [] });
    assert.match(JSON.stringify(contextResults.at(-1).messages), /RELIABILITY HARNESS ACTIVE/);
    assert.match(JSON.stringify(contextResults.at(-1).messages), /Mode: lite/);
    await harness.commands.get("reliability").handler("status", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /mode lite/);

    await assert.rejects(
      harness.tools.get("reliability_submit_worker_result").execute("worker-in-lite", {
        step_id: "S1",
        action_taken: "tried worker ceremony",
        result: "not allowed",
        status: "complete",
      }, undefined, undefined, harness.ctx),
      /disabled in lite mode/,
    );
  } finally {
    cleanup(cwd);
  }
});

test("adaptive mode escalates long work to supervised mode", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    const prompt = "Refactor the authentication module, update tests, migrate related configuration, document the changes, and verify the full test suite without breaking existing behavior.";
    await harness.commands.get("reliability").handler(`on ${prompt}`, harness.ctx);
    const before = await harness.emit("before_agent_start", { prompt, systemPrompt: "sys" });
    assert.match(before.at(-1).systemPrompt, /RELIABILITY HARNESS INSTRUCTIONS/);
    assert.match(before.at(-1).systemPrompt, /SUPERVISOR \/ WORKER SPLIT/);
    await harness.commands.get("reliability").handler("status", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /mode supervised/);
  } finally {
    cleanup(cwd);
  }
});

test("blocks exact repeated tool calls at the configured threshold", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on repeat test", harness.ctx);

    for (let i = 1; i <= 2; i++) {
      const results = await harness.emit("tool_call", { toolCallId: `t${i}`, toolName: "read", input: { path: "README.md" } });
      assert.equal(results.some((result) => result?.block), false);
      await harness.emit("tool_result", { toolCallId: `t${i}`, toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "ok" }], isError: false });
    }

    const blocked = await harness.emit("tool_call", { toolCallId: "t3", toolName: "read", input: { path: "README.md" } });
    assert.equal(blocked.some((result) => result?.block), true);
    assert.match(blocked.find((result) => result?.block).reason, /repeated action/i);
  } finally {
    cleanup(cwd);
  }
});

test("applies strict and relaxed reliability profiles", async () => {
  const strictCwd = tempCwd();
  const relaxedCwd = tempCwd();
  try {
    mkdirSync(join(strictCwd, ".pi"), { recursive: true });
    writeFileSync(join(strictCwd, ".pi", "reliability.json"), JSON.stringify({ profile: "strict" }));
    const strictHarness = createHarness(strictCwd);
    await strictHarness.emit("session_start");
    await strictHarness.commands.get("reliability").handler("on strict repeat test", strictHarness.ctx);
    await strictHarness.emit("tool_call", { toolCallId: "s1", toolName: "read", input: { path: "README.md" } });
    await strictHarness.emit("tool_result", { toolCallId: "s1", toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "ok" }], isError: false });
    const strictSecond = await strictHarness.emit("tool_call", { toolCallId: "s2", toolName: "read", input: { path: "README.md" } });
    assert.equal(strictSecond.some((result) => result?.block), true);
    await strictHarness.commands.get("reliability").handler("status", strictHarness.ctx);
    assert.match(strictHarness.notifications.at(-1).message, /Profile: strict/);

    mkdirSync(join(relaxedCwd, ".pi"), { recursive: true });
    writeFileSync(join(relaxedCwd, ".pi", "reliability.json"), JSON.stringify({ profile: "relaxed" }));
    const relaxedHarness = createHarness(relaxedCwd);
    await relaxedHarness.emit("session_start");
    await relaxedHarness.commands.get("reliability").handler("on relaxed repeat test", relaxedHarness.ctx);
    for (let i = 1; i <= 4; i++) {
      const results = await relaxedHarness.emit("tool_call", { toolCallId: `r${i}`, toolName: "read", input: { path: "README.md" } });
      assert.equal(results.some((result) => result?.block), false);
      await relaxedHarness.emit("tool_result", { toolCallId: `r${i}`, toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "ok" }], isError: false });
    }
    await relaxedHarness.commands.get("reliability").handler("status", relaxedHarness.ctx);
    assert.match(relaxedHarness.notifications.at(-1).message, /Profile: relaxed/);
  } finally {
    cleanup(strictCwd);
    cleanup(relaxedCwd);
  }
});

test("builds compact and delta context headers", () => {
  const cwd = tempCwd();
  try {
    const compactConfig = normalizeConfig({ profile: "balanced", contextMode: "compact" });
    const deltaConfig = normalizeConfig({ profile: "balanced", contextMode: "delta" });
    const task = createTaskState(cwd, "implement reliability context compression", undefined, compactConfig);

    const compact = buildContextHeader(task, compactConfig);
    assert.match(compact.header, /Header mode: compact/);
    assert.ok(compact.header.length < buildContextHeader(task, normalizeConfig({ contextMode: "full" })).header.length);

    const firstDelta = buildContextHeader(task, deltaConfig);
    assert.match(firstDelta.header, /Initial context snapshot/);
    const secondDelta = buildContextHeader(task, deltaConfig, firstDelta.snapshot);
    assert.match(secondDelta.header, /No material reliability-state changes/);
    assert.ok(secondDelta.header.length <= firstDelta.header.length + 120);
  } finally {
    cleanup(cwd);
  }
});

test("verified complete task points at final plan step", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ profile: "balanced" });
    const task = createTaskState(cwd, "verify final pointer", undefined, config);
    recordUserAttestation(task, "C1", "User confirmed the completed artifact.", "user-command:test");

    assert.equal(markTaskCompleteIfVerified(task), true);
    assert.equal(task.status, "complete");
    assert.equal(task.current_phase, "complete");
    assert.equal(task.current_step_id, "S4");
    assert.equal(task.plan.at(-1).status, "complete");
  } finally {
    cleanup(cwd);
  }
});

test("supervisor worker contract accepts current step result", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on supervisor worker split", harness.ctx);
    await harness.commands.get("reliability").handler("mode supervised", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "supervisor worker split", systemPrompt: "sys" });

    const decision = await harness.tools.get("reliability_supervisor_decision").execute("tool", {}, undefined, undefined, harness.ctx);
    assert.match(decision.content[0].text, /SUPERVISOR \/ WORKER SPLIT/);
    const stepId = decision.details.decision.step_id;

    const result = await harness.tools.get("reliability_submit_worker_result").execute("tool", {
      step_id: stepId,
      action_taken: "Inspected task state",
      result: "Step completed",
      status: "complete",
      files_changed: ["README.md"],
      next_recommendation: "Continue next step",
    }, undefined, undefined, harness.ctx);

    assert.match(result.content[0].text, /Worker result accepted/);
    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.ok(state.completed_steps.includes(stepId));
    assert.ok(state.files_touched.includes("README.md"));
  } finally {
    cleanup(cwd);
  }
});

test("worker result accepts step advanced by progress tool", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on create live-test.txt and verify", harness.ctx);
    await harness.commands.get("reliability").handler("mode supervised", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "create live-test.txt and verify", systemPrompt: "sys" });

    await harness.tools.get("reliability_record_progress").execute("progress", {
      step_id: "S1",
      step_status: "complete",
      known_fact: "Task goal and success criteria are clear.",
    }, undefined, undefined, harness.ctx);

    const result = await harness.tools.get("reliability_submit_worker_result").execute("worker", {
      step_id: "S2",
      action_taken: "Created live-test.txt",
      result: "File contains ok.",
      status: "complete",
      files_changed: ["live-test.txt"],
      next_recommendation: "Verify by reading live-test.txt back.",
    }, undefined, undefined, harness.ctx);

    assert.match(result.content[0].text, /Worker result accepted for S2/);
    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.ok(state.completed_steps.includes("S1"));
    assert.ok(state.completed_steps.includes("S2"));
  } finally {
    cleanup(cwd);
  }
});

test("blocks verification/report step completion until explicit evidence is recorded", async () => {
  const cwd = tempCwd();
  const goal = "Create live-test.txt containing exactly ok, then verify it by reading it back before final answer.";
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler(`on ${goal}`, harness.ctx);
    await harness.commands.get("reliability").handler("mode supervised", harness.ctx);
    await harness.emit("before_agent_start", { prompt: goal, systemPrompt: "sys" });

    await harness.tools.get("reliability_record_progress").execute("progress", {
      step_id: "S1",
      step_status: "complete",
      known_fact: "Task goal and success criteria are clear.",
    }, undefined, undefined, harness.ctx);

    await harness.tools.get("reliability_submit_worker_result").execute("worker-s2", {
      step_id: "S2",
      action_taken: "Created live-test.txt",
      result: "File contains ok.",
      status: "complete",
      files_changed: ["live-test.txt"],
      next_recommendation: "Read live-test.txt back to verify exact contents.",
    }, undefined, undefined, harness.ctx);

    await assert.rejects(
      harness.tools.get("reliability_verify_completion").execute("verify-missing-evidence", {}, undefined, undefined, harness.ctx),
      (error) => {
        assert.match(error.message, /Missing explicit verification evidence: 0 failed and 1 unknown verification criteria remain/);
        assert.doesNotMatch(error.message, /UNKNOWN:/);
        return true;
      },
    );

    await assert.rejects(
      harness.tools.get("reliability_submit_worker_result").execute("worker-s3-missing-evidence", {
        step_id: "S3",
        action_taken: "Read live-test.txt",
        result: "Read output was ok.",
        status: "complete",
      }, undefined, undefined, harness.ctx),
      (error) => {
        assert.match(error.message, /Cannot mark S3 complete while completion evidence is escalate: 0 failed and 1 unknown verification criteria remain/);
        assert.doesNotMatch(error.message, /UNKNOWN:/);
        return true;
      },
    );

    await assert.rejects(
      harness.tools.get("reliability_verify_completion").execute("verify-model-claim", {
        evidence: [{
          criterionId: "C1",
          status: "passed",
          evidence: "Read live-test.txt returned exactly ok.",
        }],
      }, undefined, undefined, harness.ctx),
      /Model-provided evidence did not resolve 1 criteria/,
    );
  } finally {
    cleanup(cwd);
  }
});

test("partial progress, agent-end, and plan-mode completion entries cannot bypass the shared gate", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on the required behavior must be verified", harness.ctx);

    await assert.rejects(
      harness.tools.get("reliability_record_progress").execute("progress-complete", {
        task_status: "complete",
      }, undefined, undefined, harness.ctx),
      /Cannot set task status to complete while completion evidence is escalate/,
    );
    await harness.emit("agent_end", {});
    const [taskId] = taskIds(cwd);
    const persisted = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    assert.notEqual(persisted.status, "complete");

    const partial = createTaskState(cwd, "The plan-mode behavior must be verified.", undefined, normalizeConfig({}));
    const run = createPlanModeRun(partial);
    writeFileSync(run.artifacts.finalReport, [
      "# Plan Mode Final Report",
      "",
      "Status: COMPLETE",
      "",
      "This report is intentionally long enough to satisfy the artifact reader but has no verification receipt.",
    ].join("\n"));
    run.phase = "report";
    const decision = nextPlanModePhaseAfterAgent(run, partial);
    assert.equal(decision.phase, "verify");
    assert.match(decision.issue, /shared completion gate/i);
  } finally {
    cleanup(cwd);
  }
});

test("builds separate-model orchestration dry run and parses role JSON", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ orchestrationMode: "separate-model", orchestrationModels: { worker: "test/worker" } });
    const state = createTaskState(cwd, "orchestrate task", undefined, config);
    const dryRun = buildDryRunOrchestration(state, config);
    assert.equal(dryRun.mode, "dry-run");
    assert.match(dryRun.prompts.supervisor, /reliability supervisor/i);
    assert.match(dryRun.prompts.worker, /worker contract/i);
    assert.match(dryRun.prompts.verifier, /reliability verifier/i);

    const worker = parseWorkerResultFromText('```json\n{"step_id":"S1","action_taken":"did it","result":"done","files_changed":["a.ts"],"errors":[],"status":"complete"}\n```');
    assert.equal(worker?.step_id, "S1");
    assert.equal(worker?.status, "complete");

    const evidence = parseVerificationEvidenceFromText('{"evidence":[{"criterion":"tests pass","status":"passed","evidence":"npm test passed"}]}');
    assert.equal(evidence?.[0]?.status, "passed");
  } finally {
    cleanup(cwd);
  }
});

test("orchestrate command is dry-run unless subprocess mode and --run are both enabled", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on orchestrate dry run", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "orchestrate dry run", systemPrompt: "sys" });
    await harness.commands.get("reliability").handler("orchestrate", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /Orchestration mode: dry-run/);
    assert.match(harness.notifications.at(-1).message, /orchestrationMode: prompt/);
  } finally {
    cleanup(cwd);
  }
});

test("installed fake-provider orchestration uses only exact data-only completions", async () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "reliability.json"), JSON.stringify({
      orchestrationMode: "separate-model",
      orchestrationModels: { supervisor: "fake/model", worker: "fake/model", verifier: "fake/model" },
    }));
    const calls = [];
    const model = { provider: "fake", id: "model", maxTokens: 512, cost: { input: 0, output: 0 } };
    const outputs = [
      JSON.stringify({ decision_ok: true, risks: ["fake-only"], revised_next_action: "Inspect the current bounded state." }),
      JSON.stringify({ step_id: "S1", action_taken: "inspected", result: "no mutation", files_changed: [], errors: [], status: "complete" }),
      JSON.stringify({ evidence: [{ criterion: "The requested task must be completed with verified evidence.", status: "unknown", evidence: "No tool receipt", remainingWork: "Run an attributable check." }] }),
    ];
    const harness = createHarness(cwd, {
      installedHost: true,
      model,
      modelRegistry: {
        find: (provider, id) => provider === "fake" && id === "model" ? model : undefined,
        hasConfiguredAuth: () => true,
        complete: async (_model, context, options) => {
          calls.push({ context, options });
          return fauxAssistantMessage(outputs.shift());
        },
      },
    });
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on native fake orchestration", harness.ctx);
    await harness.emit("before_agent_start", { prompt: "native fake orchestration", systemPrompt: "sys" });
    await harness.commands.get("reliability").handler("orchestrate --run", harness.ctx);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ context, options }) => context.messages.length === 1 && context.messages[0].role === "user" && Number.isInteger(options.maxTokens)));
    assert.ok(calls.every(({ context }) => !JSON.stringify(context).includes("toolCall")));
    assert.match(harness.notifications.at(-1).message, /Orchestration mode: separate-model/);
  } finally {
    cleanup(cwd);
  }
});

test("offline reliability evaluation reports deterministic harness metrics", async () => {
  const cwd = tempCwd();
  try {
    const report = runOfflineReliabilityEvaluation(cwd);
    assert.equal(report.metrics.failed, 0);
    assert.equal(report.metrics.total, 6);
    assert.equal(report.metrics.false_completion_blocks, 1);
    assert.equal(report.metrics.repeated_action_blocks, 1);

    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("eval", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /Reliability Harness Evaluation/);
    assert.equal(harness.notifications.at(-1).level, "info");
  } finally {
    cleanup(cwd);
  }
});

test("stores redacted raw tool logs only when enabled", async () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "reliability.json"), JSON.stringify({ storeRawToolLogs: true, rawLogMaxChars: 2000 }));
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on raw log storage", harness.ctx);
    await harness.emit("tool_call", { toolCallId: "raw1", toolName: "read", input: { path: "package.json" } });
    await harness.emit("tool_result", {
      toolCallId: "raw1",
      toolName: "read",
      input: { path: "package.json" },
      content: [{ type: "text", text: "token=supersecret\nBearer abcdefghijklmnop\nAKIA1234567890ABCDEF\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }],
      isError: false,
    });

    const [taskId] = taskIds(cwd);
    const state = JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
    const rawLogPath = state.tool_history.at(-1).raw_log_path;
    assert.ok(rawLogPath);
    const log = readFileSync(join(cwd, rawLogPath), "utf8");
    assert.doesNotMatch(log, /supersecret|abcdefghijklmnop|AKIA1234567890ABCDEF|BEGIN PRIVATE KEY/);
    assert.match(log, /\[REDACTED/);
  } finally {
    cleanup(cwd);
  }
});

test("redacts and truncates raw logs", () => {
  assert.equal(redactSensitiveText("postgres://user:pass@example.test/db"), "postgres://[REDACTED]@example.test/db");
  const truncated = truncateRawLog(`sk-1234567890abcdef\n${"x".repeat(3000)}`, 1200);
  assert.match(truncated, /\[REDACTED_API_KEY\]/);
  assert.match(truncated, /RAW LOG TRUNCATED/);
  assert.ok(truncated.length < 1400);
});

test("registered output-contract command and reliability_gate reject headless activation and accept current native receipts", async () => {
  const cwd = tempCwd();
  try {
    const contractPath = join(cwd, "output-contract.json");
    writeFileSync(contractPath, JSON.stringify({ format: "enum", semantic: "structural-only", values: ["approved"] }));
    const headless = createHarness(cwd, { installedHost: true });
    headless.ctx.hasUI = false;
    await headless.emit("session_start");
    await headless.commands.get("reliability").handler("on validate an approved response", headless.ctx);
    await headless.commands.get("reliability").handler(`output-contract ${contractPath}`, headless.ctx);
    assert.match(headless.notifications.at(-1).message, /requires native confirmation/i);

    const harness = createHarness(cwd, { installedHost: true });
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on validate an approved response", harness.ctx);
    await harness.commands.get("reliability").handler(`output-contract ${contractPath}`, harness.ctx);
    assert.match(harness.notifications.at(-1).message, /Activated output contract OC1/i);
    const gate = harness.tools.get("reliability_gate");
    const result = await gate.execute("gate-validate", { action: "validate-output", contractId: "OC1", candidate: "approved" }, undefined, undefined, harness.ctx);
    assert.match(result.content[0].text, /Structured output PASS/i);
    await assert.rejects(() => gate.execute("gate-over-budget", { action: "validate-output", contractId: "OC1", candidate: "approved".repeat(20_000) }, undefined, undefined, harness.ctx));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("strict profile queues completion-gate follow-up on unsupported completion claim", async () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "reliability.json"), JSON.stringify({ profile: "strict" }));
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on verify deployment is complete", harness.ctx);

    await harness.emit("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Implemented and complete." }],
      },
    });

    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages[0].content, /Reliability completion gate escalate/);
    assert.equal(harness.sentUserMessages[0].options.deliverAs, "followUp");
    assert.equal(harness.notifications.at(-1).level, "error");
  } finally {
    cleanup(cwd);
  }
});


test("suggests verification commands from project manifests", async () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest", check: "tsc --noEmit" } }, null, 2));
    const harness = createHarness(cwd);
    await harness.emit("session_start");

    const result = await harness.tools.get("reliability_suggest_verification").execute("tool", {}, undefined, undefined, harness.ctx);
    assert.match(result.content[0].text, /npm test/);
    assert.match(result.content[0].text, /npm run check/);
  } finally {
    cleanup(cwd);
  }
});

test("JavaScript validation preserves failures across file and repeated summaries", () => {
  for (const output of [
    "Tests: 0 failed, 2 passed\nTest Files 1 failed",
    "Test Files 1 failed\nTests: 0 failed, 2 passed",
    "Tests: 0 failed, 2 passed\nTests: 1 failed",
    "Tests: 1 failed\nTests: 0 failed, 2 passed",
    `Tests: ${"9".repeat(400)} failed\nTests: 0 failed`,
  ]) {
    assert.equal(parseVerificationResult("npm test", output, false).status, "failed", output);
  }
  assert.equal(parseVerificationResult("npm test", "Tests: 0 failed, 2 passed\nTest Files 0 failed, 1 passed", false).status, "passed");
});

test("parses common verification outputs", () => {
  assert.deepEqual(
    parseVerificationResult("npx tsc --noEmit", "src/app.ts(1,1): error TS2322: Type 'x' is not assignable", true).counts,
    { errors: 1 },
  );
  assert.equal(parseVerificationResult("pytest", "==== 2 failed, 3 passed in 1.23s ====", true).status, "failed");
  assert.equal(parseVerificationResult("cargo test", "test result: ok. 10 passed; 0 failed; 0 ignored", false).status, "passed");
  assert.equal(parseVerificationResult("go test ./...", "FAIL\t./pkg\n", true).status, "failed");
  assert.equal(parseVerificationResult("./gradlew test", "BUILD SUCCESSFUL in 3s", false).status, "passed");
});

test("does not map failed verification commands to unrelated criteria", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on verify tests work", harness.ctx);

    await harness.emit("tool_call", { toolCallId: "bash1", toolName: "bash", input: { command: "npm test" } });
    await harness.emit("tool_result", {
      toolCallId: "bash1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "Tests failed" }],
      isError: true,
    });

    await harness.commands.get("reliability").handler("verify", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /UNKNOWN: C1 — verify tests work/i);
  } finally {
    cleanup(cwd);
  }
});

test("lists, resumes, and archives tasks", async () => {
  const cwd = tempCwd();
  try {
    const harness = createHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on first task", harness.ctx);
    await harness.commands.get("reliability").handler("on second task", harness.ctx);

    const ids = taskIds(cwd);
    assert.equal(ids.length, 2);

    await harness.commands.get("reliability").handler("tasks", harness.ctx);
    assert.match(harness.notifications.at(-1).message, /first task|second task/);

    await harness.commands.get("reliability").handler(`archive ${ids[0].slice(0, 8)}`, harness.ctx);
    assert.equal(harness.notifications.at(-1).level, "info");

    await harness.commands.get("reliability").handler("tasks", harness.ctx);
    assert.doesNotMatch(harness.notifications.at(-1).message, new RegExp(ids[0].slice(0, 8)));

    await harness.commands.get("reliability").handler(`resume ${ids[1].slice(0, 8)}`, harness.ctx);
    assert.match(harness.notifications.at(-1).message, /Resumed reliability task/);
  } finally {
    cleanup(cwd);
  }
});

function rf2Scope(lane = "agentic", overrides = {}) {
  return { action: "set", lane, allowedTools: ["read", "grep", "find", "ls"], allowedReadPaths: ["."], allowedWritePaths: [], forbiddenPaths: [], maxToolCalls: 20, maxErrors: 3, maxIterations: 20, externalSideEffects: "forbidden", validationCommands: [], stopConditions: [], escalationConditions: [], ...overrides };
}

function rf2State(cwd) {
  return JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskIds(cwd)[0], "state.json"), "utf8"));
}

async function rf2Start(cwd, options = {}, config = {}) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "reliability.json"), JSON.stringify(config));
  const harness = createHarness(cwd, { installedHost: true, registeredControls: true, ...options });
  await harness.emit("session_start");
  await harness.commands.get("reliability").handler("on", harness.ctx);
  await harness.emit("input", { source: "interactive", text: "bounded RF2 task" });
  await harness.commands.get("reliability").handler("input confirm", harness.ctx);
  await harness.emit("before_agent_start", { prompt: "bounded RF2 task", systemPrompt: "sys" });
  return harness;
}

async function rf2Execute(harness, name, params, id = name) {
  return harness.tools.get(name).execute(id, params, undefined, undefined, harness.ctx);
}

for (const tool of ["reliability_record_progress", "reliability_submit_worker_result"]) {
  test(`RF2 executable verification/report exits advance through registered ${tool}`, async () => {
    const cwd = tempCwd();
    try {
      const h = await rf2Start(cwd, {}, { supervisionMode: "supervised" });
      await rf2Execute(h, "reliability_set_plan", { steps: ["Verify work", "Report outcome"].map((title, i) => ({
        step_id: `V${i}`, title, depends_on: i ? ["V0"] : [], allowed_scope: { allowed_tools: ["read"], allowed_read_paths: [cwd], allowed_write_paths: [] },
        exit_conditions: [{ kind: "observed-tool-result", description: "Read the relevant artifact" }],
      })) });
      writeFileSync(join(cwd, "artifact.txt"), "observed artifact");
      for (const step of ["V0", "V1"]) {
        const id = `read-${step}`;
        await h.emit("tool_call", { toolName: "read", toolCallId: id, input: { path: "artifact.txt" } });
        await h.emit("tool_result", { toolName: "read", toolCallId: id, input: { path: "artifact.txt" }, content: [{ type: "text", text: "observed artifact" }], isError: false });
        h.ctx.sessionManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: id, content: [{ type: "text", text: "observed artifact" }], isError: false, timestamp: Date.now() });
        await h.emit("message_start");
        const receipt = rf2State(cwd).execution_receipts.at(-1).id;
        if (tool === "reliability_record_progress" && step === "V0") {
          await assert.rejects(() => rf2Execute(h, tool, { step_id: step, step_status: "complete", task_status: "complete", evidence_receipt_ids: [receipt] }), /Cannot set task status/);
          const current = await rf2Execute(h, tool, {});
          assert.equal(current.details.task.plan.find(s => s.step_id === step).status, "in_progress", "refused whole-task completion cannot partially commit a step status");
        }
        await rf2Execute(h, tool, tool === "reliability_record_progress"
          ? { step_id: step, step_status: "complete", evidence_receipt_ids: [receipt] }
          : { step_id: step, status: "complete", action_taken: "Read artifact", result: "Artifact observed", evidence_receipt_ids: [receipt] });
        assert.equal(rf2State(cwd).plan.find(s => s.step_id === step).status, "complete");
      }
      assert.notEqual(rf2State(cwd).status, "complete", "step exits do not certify whole-task completion");
    } finally { cleanup(cwd); }
  });
}

test("RF2 registered verify explains common-authority refusal after all criteria pass", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { installedHost: true });
    for (const criterion of rf2State(cwd).criteria) await h.commands.get("reliability").handler(`attest ${criterion.id} checked manually`, h.ctx);
    await rf2Execute(h, "reliability_gate", { action: "escalate", reason: "Release decision pending", decisionNeeded: "Approve release" });
    const result = await rf2Execute(h, "reliability_verify_completion", { markComplete: true });
    assert.match(result.content[0].text, /completion.*(refused|escalate)|quality escalation/i);
    assert.match(result.content[0].text, /quality escalation/i);
    assert.notEqual(result.details.status, "complete");
  } finally { cleanup(cwd); }
});

for (const percent of [35, 70]) {
  test(`RF2 settled runtime pressure at ${percent}% needs no manual lane and does not record gate audits`, async () => {
    const cwd = tempCwd();
    try {
      const h = await rf2Start(cwd, { contextUsage: { value: { percent } } });
      await rf2Execute(h, "reliability_scope", rf2Scope());
      const before = rf2State(cwd).completion_gates.length;
      await h.emit("turn_end");
      const state = rf2State(cwd);
      assert.equal(state.completion_gates.length, before);
      assert.equal(state.context_checkpoints.length, 1, JSON.stringify(state.context_reset));
      assert.equal(state.context_checkpoints[0].status, "checkpoint-only");
      assert.equal(state.context_epoch, 0);
      await h.emit("turn_end");
      assert.equal(rf2State(cwd).context_checkpoints.length, 1, "cooldown/dedup prevents repeats");
    } finally { cleanup(cwd); }
  });
}

test("RF2 transient threshold uses only host-observed tool text and follows step advancement", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { contextUsage: { value: { percent: 1, tokens: 999999 } } }, { contextReset: { eligibleTransientTokens: 1000, cooldownTurns: 1 } });
    await rf2Execute(h, "reliability_scope", rf2Scope());
    await h.emit("context", { messages: [{ role: "user", content: "x".repeat(10000) }] });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0, "total usage and user text are not transient");
    await rf2Execute(h, "reliability_record_progress", { step_id: "S1", step_status: "complete" });
    await h.emit("context", { messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(8000) }] }] });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 1, JSON.stringify(rf2State(cwd).context_reset));
    assert.equal(rf2State(cwd).current_step_id, "S2");
    assert.ok(rf2State(cwd).context_reset.pending_candidate.estimated_transient_tokens >= 1000);
  } finally { cleanup(cwd); }
});

test("RF2 runtime unsettled batches defer checkpoint and disabled automatic mode stays inert", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { contextUsage: { value: { percent: 70 } } });
    await rf2Execute(h, "reliability_scope", rf2Scope());
    writeFileSync(join(cwd, "missing"), "fixture");
    await h.emit("tool_call", { toolName: "read", toolCallId: "pending", input: { path: "missing" } });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    assert.equal(rf2State(cwd).context_reset.stable_boundary_id, undefined);
    await h.commands.get("reliability").handler("checkpoint auto-off", h.ctx);
    await h.emit("tool_result", { toolName: "read", toolCallId: "pending", input: { path: "missing" }, content: [], isError: false });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    assert.notEqual(rf2State(cwd).context_reset.status, "paused", "disabled automation must not impose a pressure pause");
  } finally { cleanup(cwd); }
});

test("RF2 hard-pressure diagnostic blocks supported built-in exploration when gate is unresolved", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { contextUsage: { value: { percent: 70 } } });
    await rf2Execute(h, "reliability_scope", rf2Scope("coding"));
    await h.emit("turn_end");
    assert.match(rf2State(cwd).context_reset.last_reason, /hard context pressure/i);
    assert.match(h.notifications.at(-1).message, /hard context pressure/i);
    for (const toolName of ["grep", "find", "ls"]) {
      const result = await h.emit("tool_call", { toolName, toolCallId: toolName, input: { path: ".", pattern: "x" } });
      assert.match(result.at(-1)?.reason ?? "", /hard-pressure/i);
    }
  } finally { cleanup(cwd); }
});

test("RF2 output status honors configured candidate count and evaluation confirmation has real newlines", async () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "contract.json"), JSON.stringify({ format: "enum", semantic: "structural-only", values: ["ok"] }));
    const h = await rf2Start(cwd, { installedHost: true }, { structuredOutput: { maxCandidatesPerTask: 1 }, evaluation: { liveModels: ["fake/model"] } });
    await h.commands.get("reliability").handler("output-contract contract.json", h.ctx);
    await h.commands.get("reliability").handler("output-contract status", h.ctx);
    assert.match(h.notifications.at(-1).message, /Candidates: 0\/1/);
    let dialog;
    h.ctx.modelRegistry = { find: () => ({ id: "model", provider: "fake" }), hasConfiguredAuth: () => true };
    h.ctx.ui.confirm = async (_title, text) => { dialog = text; return false; };
    await h.commands.get("reliability").handler("eval --model fake/model --run", h.ctx);
    assert.ok(dialog?.includes("\nCases:"));
    assert.equal(dialog.includes("\\n"), false);
  } finally { cleanup(cwd); }
});

test("RF2 evaluation dialog alone captures source disclosure with real newlines", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { installedHost: true }, { evaluation: { liveModels: ["fake/model"] } });
    let dialog;
    h.ctx.modelRegistry = { find: () => ({ id: "model", provider: "fake" }), hasConfiguredAuth: () => true };
    h.ctx.ui.confirm = async (_title, text) => { dialog = text; return false; };
    await h.commands.get("reliability").handler("eval --model fake/model --run", h.ctx);
    assert.ok(dialog?.includes("\nCases:"));
    assert.equal(dialog.includes("\\n"), false);
  } finally { cleanup(cwd); }
});

test("RF2 scope preview and deterministic repeat denial preserve unused exact approval and charge attempts", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, { installedHost: true });
    await rf2Execute(h, "reliability_scope", rf2Scope("agentic", { allowedTools: ["bash"], externalSideEffects: "approval-required" }));
    await h.commands.get("reliability").handler("scope approve SC1", h.ctx);
    const input = { command: "npm test" };
    const approve = async (id) => {
      const check = await rf2Execute(h, "reliability_scope", { action: "check", candidateTool: "bash", candidateInput: input });
      const result = await rf2Execute(h, "reliability_scope", { action: "request-approval", toolName: "bash", normalizedEffect: check.details.decision.normalized_effect, description: "Run validation", reversible: true }, id);
      await h.commands.get("reliability").handler(`approval approve ${result.details.approvalId}`, h.ctx);
      return result.details.approvalId;
    };
    for (let i = 0; i < 2; i++) {
      await approve(`approval-${i}`);
      await h.emit("tool_call", { toolName: "bash", toolCallId: `fail-${i}`, input });
      const content = [{ type: "text", text: "Tests: 1 failed" }];
      await h.emit("tool_result", { toolName: "bash", toolCallId: `fail-${i}`, input, content, isError: true, details: { exitCode: 1 } });
      h.ctx.sessionManager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: `fail-${i}`, content, isError: true, timestamp: Date.now() });
      await h.emit("message_start");
    }
    const id = await approve("last-approval");
    const before = rf2State(cwd);
    const preview = await rf2Execute(h, "reliability_scope", { action: "check", candidateTool: "bash", candidateInput: input });
    assert.equal(rf2State(cwd).scope_state.usage.tool_calls_used, before.scope_state.usage.tool_calls_used);
    const blocked = await h.emit("tool_call", { toolName: "bash", toolCallId: "denied", input });
    assert.equal(blocked.at(-1).block, true);
    const after = rf2State(cwd);
    assert.equal(after.scope_state.approvals.find(a => a.id === id).status, "approved");
    assert.equal(preview.details.decision.allowed, false);
    assert.equal(after.scope_state.usage.tool_calls_used, before.scope_state.usage.tool_calls_used + 1);
  } finally { cleanup(cwd); }
});

test("RF2 scope and evidence semantic changes checkpoint only after their control batch settles", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd);
    await rf2Execute(h, "reliability_scope", rf2Scope("retrieval"));
    await rf2Execute(h, "reliability_evidence", { action: "start", question: "Bounded lookup", requirements: ["Report missing evidence"] });
    // Empty retrieval evidence is incomplete, so this outgoing gate must not become passed.
    writeFileSync(join(cwd, "x"), "fixture");
    await h.emit("tool_call", { toolName: "read", toolCallId: "sibling", input: { path: "x" } });
    await rf2Execute(h, "reliability_scope", rf2Scope("agentic"), "transition");
    for (const change of rf2State(cwd).scope_state.pending_scope_changes.filter(c => c.status === "pending")) await h.commands.get("reliability").handler(`scope approve ${change.id}`, h.ctx);
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    await h.emit("tool_result", { toolName: "read", toolCallId: "sibling", input: { path: "x" }, content: [], isError: false });
    await h.emit("turn_end");
    const state = rf2State(cwd);
    assert.equal(state.context_reset.pending_candidate?.trigger, "phase-boundary");
    assert.equal(state.context_reset.pending_candidate?.from_lane, "retrieval");
    assert.notEqual(state.context_reset.pending_candidate?.gate_decision, "pass");
  } finally { cleanup(cwd); }
});

test("RF2 registered coding assessment requires every approved command at the current diff", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd, {}, { maxRepeatedAction: 8 });
    await rf2Execute(h, "reliability_scope", rf2Scope("coding", { allowedTools: ["read", "bash"], externalSideEffects: "approval-required", validationCommands: ["npm test", "node smoke.mjs"] }));
    await h.commands.get("reliability").handler("scope approve SC1", h.ctx);
    const assess = async () => (await rf2Execute(h, "reliability_gate", { action: "assess", gate: "coding" })).details.decision;
    assert.notEqual((await assess()).decision, "pass");
    await h.commands.get("reliability").handler("map C1 bash npm test", h.ctx);
    await h.commands.get("reliability").handler("map C2 bash node smoke.mjs", h.ctx);
    const check = async (command, isError = false, output) => {
      const preview = await rf2Execute(h, "reliability_scope", { action: "check", candidateTool: "bash", candidateInput: { command } });
      const request = await rf2Execute(h, "reliability_scope", { action: "request-approval", toolName: "bash", normalizedEffect: preview.details.decision.normalized_effect, description: "Run configured validation", reversible: true });
      await h.commands.get("reliability").handler(`approval approve ${request.details.approvalId}`, h.ctx);
      const id = `check-${rf2State(cwd).execution_receipts.length}`;
      const call = await h.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command } });
      assert.notEqual(call.at(-1)?.block, true, call.at(-1)?.reason);
      const content = [{ type: "text", text: output ?? (isError ? "Tests: 1 failed" : "Tests: 1 passed") }];
      await h.emit("tool_result", { toolName: "bash", toolCallId: id, input: { command }, content, isError, details: { exitCode: isError ? 1 : 0 } });
      h.ctx.sessionManager.appendMessage({ role: "toolResult", toolName: "bash", toolCallId: id, content, isError, timestamp: Date.now() });
      await h.emit("message_start");
    };
    await check("npm test");
    assert.notEqual((await assess()).decision, "pass", "one missing command blocks the coding gate");
    await check("node smoke.mjs", true);
    assert.equal((await assess()).decision, "fail");
    await check("node smoke.mjs");
    const result = await assess();
    assert.equal(result.decision, "pass", JSON.stringify(result));
    assert.equal(rf2State(cwd).criterion_results.some(c => c.criterion_id === "C3"), false, "future report remains unproven");
    await h.commands.get("reliability").handler("map C1 bash node smoke.mjs", h.ctx);
    await check("npm test", false, "Tests: 1 failed");
    assert.equal(rf2State(cwd).execution_receipts.at(-1).validation_status, "failed");
    await check("node smoke.mjs");
    assert.notEqual((await assess()).decision, "pass", "a second command cannot hide a parsed exit-zero failure on their shared criterion");
    await check("npm test");
    assert.equal((await assess()).decision, "pass");
    writeFileSync(join(cwd, "external.js"), "export const value = 1;\n");
    assert.notEqual((await assess()).decision, "pass", "external changes stale both checks");
  } finally { cleanup(cwd); }
});

test("RF2 positive semantic checkpoint waits for its registered control and sibling batch", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd);
    await rf2Execute(h, "reliability_scope", rf2Scope());
    writeFileSync(join(cwd, "readme.txt"), "fixture");
    const input = rf2Scope("coding");
    await h.emit("tool_call", { toolName: "reliability_scope", toolCallId: "transition", input });
    await h.emit("tool_call", { toolName: "read", toolCallId: "sibling", input: { path: "readme.txt" } });
    await rf2Execute(h, "reliability_scope", input, "transition");
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    await h.emit("tool_result", { toolName: "reliability_scope", toolCallId: "transition", input, content: [], isError: false });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    await h.emit("tool_result", { toolName: "read", toolCallId: "sibling", input: { path: "readme.txt" }, content: [], isError: false });
    await h.emit("turn_end");
    const state = rf2State(cwd);
    assert.equal(state.context_checkpoints.length, 1, JSON.stringify(state.context_reset));
    assert.equal(state.context_checkpoints[0].trigger, "phase-boundary");
    assert.equal(state.context_checkpoints[0].from_lane, "agentic");
    assert.equal(state.context_checkpoints[0].to_lane, "coding");
  } finally { cleanup(cwd); }
});

test("RF2 pressure estimate counts settled built-in results without a context hook and bounds unknown usage", async () => {
  const cwd = tempCwd();
  try {
    const usage = { value: { percent: Number.NaN } };
    const h = await rf2Start(cwd, { contextUsage: usage }, { contextReset: { eligibleTransientTokens: 1000 } });
    await rf2Execute(h, "reliability_scope", rf2Scope());
    for (const percent of [Number.NaN, Infinity, -1, undefined]) {
      usage.value.percent = percent;
      await h.emit("turn_end");
      assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    }
    writeFileSync(join(cwd, "large.txt"), "x".repeat(8000));
    const event = { toolName: "read", toolCallId: "large-read", input: { path: "large.txt" } };
    await h.emit("tool_call", event);
    await h.emit("tool_result", { ...event, content: [{ type: "text", text: "x".repeat(8000) }], isError: false });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 1, JSON.stringify(rf2State(cwd).context_reset));
    assert.equal(rf2State(cwd).context_reset.pending_candidate.estimated_transient_tokens, 2000);
  } finally { cleanup(cwd); }
});

test("RF2 evidence action is observed as a semantic lane change without promoting incomplete outgoing coding", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd);
    await rf2Execute(h, "reliability_scope", rf2Scope("coding"));
    const input = { action: "start", question: "Inspect installed contract", requirements: ["Record source evidence"] };
    await h.emit("tool_call", { toolName: "reliability_evidence", toolCallId: "evidence-start", input });
    await rf2Execute(h, "reliability_evidence", input, "evidence-start");
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    await h.emit("tool_result", { toolName: "reliability_evidence", toolCallId: "evidence-start", input, content: [], isError: false });
    await h.emit("turn_end");
    const candidate = rf2State(cwd).context_reset.pending_candidate;
    assert.equal(candidate.trigger, "phase-boundary");
    assert.equal(candidate.from_lane, "coding");
    assert.equal(candidate.to_lane, "retrieval");
    assert.notEqual(candidate.gate_decision, "pass");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0, "unsupported backwards semantic reset retains context");
  } finally { cleanup(cwd); }
});

test("RF2 manual lane transition also waits for unsettled work", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd);
    await rf2Execute(h, "reliability_evidence", { action: "start", question: "Bounded lookup", requirements: ["Report missing evidence"] });
    writeFileSync(join(cwd, "file.txt"), "fixture");
    const event = { toolName: "read", toolCallId: "pending-read", input: { path: "file.txt" } };
    await h.emit("tool_call", event);
    await h.commands.get("reliability").handler("lane general", h.ctx);
    assert.match(h.notifications.at(-1).message, /deferred/);
    assert.equal(rf2State(cwd).context_checkpoints.length, 0);
    await h.emit("tool_result", { ...event, content: [], isError: false });
    await h.emit("turn_end");
    assert.equal(rf2State(cwd).context_reset.pending_candidate.trigger, "phase-boundary");
    assert.equal(rf2State(cwd).context_reset.pending_candidate.from_lane, "retrieval");
    assert.equal(rf2State(cwd).context_checkpoints.length, 0, "incomplete outgoing work still retains context");
  } finally { cleanup(cwd); }
});

for (const recoveryCase of ["live", "reload", "branch", "session", "epoch", "compact", "late-result", "pending", "tampered", "noop-save", "cancel"] ) {
  test(`RF2b registered checkpoint recovery lifecycle: ${recoveryCase}`, async () => {
    const cwd = tempCwd();
    try {
      const h = await rf2Start(cwd);
      await rf2Execute(h, "reliability_scope", rf2Scope());
      await rf2Execute(h, "reliability_scope", rf2Scope("coding"));
      const live = (await rf2Execute(h, "reliability_status", {})).details.task;
      const path = join(cwd, ".pi", "tasks", live.task_id, "state.json");
      let failed = false;
      let queuedBytes;
      let reset = live.context_reset;
      // Inject lost persistence at the real save callback's state-object replacement,
      // after writing validated state but before the coordinator reopens the file.
      Object.defineProperty(live, "context_reset", { enumerable: true, configurable: true, get: () => reset, set(value) {
        reset = value;
        if (value.status === "queued") queuedBytes = readFileSync(path);
        if (value.status === "validated" && !failed) { failed = true; writeFileSync(path, queuedBytes); }
      } });
      await h.emit("turn_end");
      Object.defineProperty(live, "context_reset", { enumerable: true, configurable: true, writable: true, value: reset });
      assert.equal(failed, true, JSON.stringify(rf2State(cwd).context_reset));
      assert.equal(live.context_reset.mutation_blocked, true);
      const checkpoint = live.context_checkpoints.at(-1);
      const taskId = live.task_id;
      // Ordinary post-failure events and a denied mutation must not erase the live witness.
      await h.emit("message_start", { message: { role: "assistant" } });
      await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Partial: checkpoint recovery required" }] } });
      await h.emit("context", { messages: [] });
      await h.emit("turn_end");
      await h.emit("agent_end");
      assert.equal((await h.emit("tool_call", { toolName: "write", toolCallId: "blocked", input: { path: "never.txt", content: "no" } }))[0]?.block, true);
      await h.commands.get("reliability").handler(`resume ${taskId}`, h.ctx);
      assert.equal((await rf2Execute(h, "reliability_status", {})).details.task, live, "generic resume cannot substitute an unfrozen disk copy");
      if (recoveryCase === "reload") await h.emit("session_start");
      if (recoveryCase === "branch") h.ctx.sessionManager.resetLeaf();
      if (recoveryCase === "session") h.ctx.sessionManager = SessionManager.inMemory(cwd);
      if (recoveryCase === "epoch") live.context_epoch += 1;
      if (recoveryCase === "compact") await h.emit("session_before_compact");
      if (recoveryCase === "late-result") await h.emit("tool_result", { toolName: "read", toolCallId: "late-unknown", input: { path: "readme.txt" }, content: [], isError: false });
      if (recoveryCase === "pending") live.pending_tool_calls.push({ tool_call_id: "late", operation: "read" });
      if (recoveryCase === "tampered") writeFileSync(join(cwd, ".pi", "tasks", taskId, checkpoint.artifact_path), "tampered Markdown");
      if (recoveryCase === "noop-save") {
        const prior = readFileSync(path);
        let current = live.context_reset;
        Object.defineProperty(live, "context_reset", { enumerable: true, configurable: true, get: () => current, set(value) {
          current = value;
          if (!value.mutation_blocked) writeFileSync(path, prior);
        } });
      }
      if (recoveryCase === "cancel") h.ctx.ui.confirm = async () => false;
      await h.commands.get("reliability").handler(`checkpoint recover ${checkpoint.checkpoint_id}`, h.ctx);
      const current = (await rf2Execute(h, "reliability_status", {})).details.task;
      assert.equal(current.context_reset.mutation_blocked, recoveryCase !== "live", h.notifications.map(note => note.message).join("\n"));
      assert.equal(current.context_epoch, recoveryCase === "epoch" ? 1 : 0);
      if (recoveryCase === "live") assert.equal(rf2State(cwd).context_reset.mutation_blocked, false);
    } finally { cleanup(cwd); }
  });
}

test("RF2b registered artifact slots enforce identity, pauses, budgets and cancellation", async () => {
  const cwd = tempCwd();
  try {
    const h = createHarness(cwd, { installedHost: true, registeredControls: true });
    await h.emit("session_start");
    await h.commands.get("reliability").handler("--mode plan-on Review this design", h.ctx);
    const status = await rf2Execute(h, "reliability_status", {});
    const task = status.details.task;
    const run = status.details.planMode;
    const input = { run_id: run.run_id, phase: "explore", slot: "exploration" };
    const read = await rf2Execute(h, "reliability_status", { artifact: input });
    const content = "# Exploration\nStatus: COMPLETE\n" + "Observed facts remain untrusted prose. ".repeat(4);
    await rf2Execute(h, "reliability_record_progress", { artifact: { ...input, content, expected_sha256: read.details.artifact.sha256 } });
    await assert.rejects(rf2Execute(h, "reliability_record_progress", { artifact: { ...input, slot: "final-report", content, expected_sha256: read.details.artifact.sha256 } }), /phase/);
    for (const change of [{ run_id: "wrong" }, { slot: "state" }, { path: "../state.json" }]) await assert.rejects(rf2Execute(h, "reliability_status", { artifact: { ...input, ...change } }));
    await h.emit("agent_end");
    const continuation = h.sentUserMessages.at(-1).content.replace("/reliability ", "");
    await h.commands.get("reliability").handler(continuation, h.ctx);
    const iteration = run.iteration;
    await h.commands.get("reliability").handler(continuation, h.ctx);
    assert.equal(run.iteration, iteration, "duplicate continuation must not consume another iteration");
    const branch = h.ctx.sessionManager.getLeafId();
    h.ctx.sessionManager.resetLeaf();
    await assert.rejects(rf2Execute(h, "reliability_status", { artifact: { ...input, phase: "plan" } }), /anchor/);
    h.ctx.sessionManager.branch(branch);
    await rf2Execute(h, "reliability_scope", rf2Scope("agentic", { maxToolCalls: 1 }));
    const call = { toolName: "reliability_status", toolCallId: "slot-read", input: { artifact: { ...input, phase: "plan" } } };
    assert.equal((await h.emit("tool_call", call))[0]?.block, undefined);
    assert.equal((await h.emit("tool_call", { ...call, toolCallId: "exhausted" }))[0]?.block, true);
    task.pending_tool_calls = [];
    await h.emit("input", { source: "interactive", text: "Unconfirmed correction" });
    await assert.rejects(rf2Execute(h, "reliability_status", { artifact: { ...input, phase: "plan" } }), /confirm/);
    await h.commands.get("reliability").handler("--mode plan-off", h.ctx);
    const calls = h.sentUserMessages.length;
    await h.emit("agent_end");
    assert.equal(h.sentUserMessages.length, calls);
  } finally { cleanup(cwd); }
});

test("RF2b foreign-session resume never copies authority or pending text", async () => {
  const cwd = tempCwd();
  try {
    const h = await rf2Start(cwd);
    const prior = rf2State(cwd);
    await h.emit("input", { source: "interactive", text: "old session live correction" });
    h.ctx.sessionManager = SessionManager.inMemory(cwd);
    await h.emit("session_start");
    await h.commands.get("reliability").handler("input confirm", h.ctx);
    assert.equal(h.ctx.sessionManager.getEntries().some(entry => entry.customType === "reliability-authoritative-input"), false);
    await h.commands.get("reliability").handler(`resume ${prior.task_id}`, h.ctx);
    const status = (await rf2Execute(h, "reliability_status", {})).details.task;
    assert.equal(status.task_identity.session_id, prior.task_identity.session_id);
    assert.notEqual(status.current_session.session_id, prior.task_identity.session_id);
    assert.deepEqual(status.current_session.input_authority_receipts, []);
    const denied = await h.emit("tool_call", { toolName: "reliability_record_progress", toolCallId: "foreign-progress", input: { task_status: "complete" } });
    assert.equal(denied[0]?.block, true);
    await h.commands.get("reliability").handler("input confirm old session live correction", h.ctx);
    assert.equal(h.ctx.sessionManager.getEntries().some(entry => entry.customType === "reliability-authoritative-input"), false);
  } finally { cleanup(cwd); }
});

test("RF2b registered PASSED Markdown cannot advance verification without native evidence", async () => {
  const cwd = tempCwd();
  try {
    const h = createHarness(cwd, { installedHost: true, registeredControls: true });
    await h.emit("session_start");
    await h.commands.get("reliability").handler("--mode plan-on Review required behavior", h.ctx);
    const status = (await rf2Execute(h, "reliability_status", {})).details;
    status.planMode.phase = "verify";
    const input = { run_id: status.planMode.run_id, phase: "verify", slot: "verification" };
    const before = await rf2Execute(h, "reliability_status", { artifact: input });
    await rf2Execute(h, "reliability_record_progress", { artifact: { ...input, expected_sha256: before.details.artifact.sha256, content: "# Verification\nStatus: PASSED\n" + "Model claims all checks passed without any independent evidence. ".repeat(3) } });
    await h.emit("agent_end");
    await h.commands.get("reliability").handler(h.sentUserMessages.at(-1).content.replace("/reliability ", ""), h.ctx);
    assert.equal(status.planMode.phase, "verify");
    assert.match(status.planMode.last_issue, /shared completion gate/);
    assert.notEqual(status.task.status, "complete");
  } finally { cleanup(cwd); }
});
