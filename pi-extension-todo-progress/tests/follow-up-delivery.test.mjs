import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
const { AgentSession, SessionManager } = await import(process.env.PI_GOAL_TEST_RUNTIME || "@earendil-works/pi-coding-agent");
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadExtension() {
  const sourcePath = join(root, "index.ts");
  const checklistModule = pathToFileURL(join(root, "..", "pi-utils", "src", "markdown.ts")).href;
  const source = (await readFile(sourcePath, "utf8")).replace(
    '"@firstpick/pi-utils"',
    JSON.stringify(checklistModule),
  );
  const tempDir = await mkdtemp(join(tmpdir(), "todo-progress-follow-up-test-"));
  const tempModule = join(tempDir, "index.ts");
  await writeFile(tempModule, source, "utf8");
  await writeFile(join(tempDir, "goal-runtime.ts"), await readFile(join(root, "goal-runtime.ts"), "utf8"), "utf8");
  try {
    return (await import(`${pathToFileURL(tempModule).href}?test=${Date.now()}`)).default;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createHarness(extension, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const notifications = [];
  const prompts = [];
  const userMessages = [];
  const customMessages = [];
  const widgets = [];
  const inputAnswers = [...(options.inputAnswers || [])];
  const runtime = {
    idle: options.isIdle ?? true,
    pending: options.hasPendingMessages ?? false,
    branch: options.branch || [],
    abortCount: 0,
  };
  const pi = {
    on(type, handler) {
      const registered = handlers.get(type) || [];
      registered.push(handler);
      handlers.set(type, registered);
    },
    appendEntry(customType, data) {
      // SessionManager retains data by reference; the extension must snapshot it.
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(content, deliveryOptions) {
      if (options.sendMessageError && content.startsWith("[TODO GOAL CONTROL continuation ")) throw options.sendMessageError;
      userMessages.push({ content, options: deliveryOptions });
    },
    sendMessage(message, deliveryOptions) {
      if (options.sendMessageError && message.customType === "todo-progress-goal-continuation") throw options.sendMessageError;
      customMessages.push({ message, options: deliveryOptions });
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerShortcut() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  extension(pi);

  const ctx = {
    hasUI: options.hasUI ?? false,
    isIdle: () => typeof runtime.idle === "function" ? runtime.idle() : runtime.idle,
    hasPendingMessages: () => typeof runtime.pending === "function" ? runtime.pending() : runtime.pending,
    abort: () => { runtime.abortCount += 1; },
    signal: options.signal,
    sessionManager: { getBranch: () => runtime.branch },
    ui: {
      input: async (title, placeholder) => {
        prompts.push({ title, placeholder });
        return inputAnswers.shift();
      },
      notify: (message, level) => notifications.push({ message, level }),
      setWidget: (key, lines) => widgets.push({ key, lines }),
      theme: { fg: (_style, text) => text },
    },
  };

  return {
    entries,
    notifications,
    prompts,
    userMessages,
    customMessages,
    tools,
    widgets,
    runtime,
    setIdle(value) {
      runtime.idle = value;
    },
    setPending(value) {
      runtime.pending = value;
    },
    setBranch(value) {
      runtime.branch = value;
    },
    hasHandlers(type) {
      return (handlers.get(type) || []).length > 0;
    },
    async command(name, args = "") {
      const command = commands.get(name);
      assert.ok(command, `Expected /${name} to be registered`);
      return command.handler(args, ctx);
    },
    async emit(type, event) {
      let result;
      for (const handler of handlers.get(type) || []) result = await handler(event, ctx);
      return result;
    },
    async injectedContext() {
      const result = await this.emit("context", { messages: [] });
      return result?.messages?.find((message) => message.customType === "todo-progress-context")?.content || "";
    },
    async goalContext() {
      const result = await this.emit("context", { messages: [] });
      return result?.messages?.find((message) => message.customType === "todo-progress-goal-context")?.content || "";
    },
  };
}

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function assistantMessage(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: Date.now(),
  };
}

function customMessagesOfType(harness, customType) {
  return harness.userMessages.flatMap((entry) => {
    const match = /^\[TODO GOAL CONTROL (kickoff|continuation) ([\w-]+) ([\w-]+)\]\n([\s\S]*)$/.exec(entry.content);
    if (!match || `todo-progress-goal-${match[1]}` !== customType) return [];
    return [{
      prompt: entry.content,
      options: entry.options,
      message: { customType, content: match[4], details: { goalId: match[2], runId: match[3] } },
    }];
  });
}

function deliveredCustomMessage(entry) {
  return userMessage(entry.prompt);
}

function assistantToolMessage(toolCalls) {
  return {
    role: "assistant",
    content: toolCalls.map(({ id, name = "goal_checkpoint", arguments: args = {} }) => ({
      type: "toolCall",
      id,
      name,
      arguments: args,
    })),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

async function executeCheckpoint(harness, toolCallId, params, siblings = []) {
  const message = assistantToolMessage([
    { id: toolCallId, arguments: params },
    ...siblings,
  ]);
  await harness.emit("message_start", { message });
  await harness.emit("message_end", { message });
  for (const call of message.content) {
    await harness.emit("tool_execution_start", {
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
  }
  return harness.tools.get("goal_checkpoint").execute(toolCallId, params);
}

async function startGoalRun(harness, goal) {
  await harness.command("goal", goal);
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff").at(-1);
  assert.ok(kickoff, "Expected a correlated goal kickoff message");
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: deliveredCustomMessage(kickoff) });
  const context = await harness.goalContext();
  return {
    goalId: /Goal identity: (.+)/.exec(context)?.[1],
    runId: /Run identity: (.+)/.exec(context)?.[1],
  };
}

test("/goal normalizes and activates a durable goal when its kickoff is delivered", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);

  await harness.command("goal", "  Ship the release\nwithout regressions.  ");
  assert.doesNotMatch(await harness.injectedContext(), /Ship the release without regressions/);
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];
  await harness.emit("message_start", { message: deliveredCustomMessage(kickoff) });

  const context = await harness.injectedContext();
  assert.match(context, /Goal: Ship the release without regressions\./);
  const goalEntry = harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state");
  assert.equal(goalEntry?.data?.goal, "Ship the release without regressions.");
  assert.equal(goalEntry?.data?.status, "running");
  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.customMessages.length, 0);
  assert.equal(kickoff.message.content, "Ship the release without regressions.");
  assert.deepEqual(kickoff.options, { deliverAs: "followUp" });
  assert.deepEqual(harness.notifications.at(-1), {
    message: "Goal submitted and starting: Ship the release without regressions.",
    level: "info",
  });
});

test("argumentless /goal prompts and activates only after delivery", async () => {
  const extension = await loadExtension();
  const branch = [{
    type: "custom",
    customType: "todo-progress-state",
    data: {
      version: 1,
      visible: true,
      items: [{ text: "Keep this item", status: "partial" }],
      offset: 0,
      goal: "Old goal",
      awaitingGoalCheck: false,
      allowNextListReplacement: false,
    },
  }];
  const harness = createHarness(extension, {
    hasUI: true,
    inputAnswers: ["Set the new goal."],
    branch,
  });

  await harness.emit("session_start", { reason: "startup" });
  await harness.command("goal");
  assert.match(await harness.injectedContext(), /Goal: Old goal/);
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];
  await harness.emit("message_start", { message: deliveredCustomMessage(kickoff) });

  assert.deepEqual(harness.prompts, [{
    title: "Set explicit goal",
    placeholder: "Current: Old goal",
  }]);
  assert.equal(harness.widgets.at(-1)?.lines, undefined);
  const goalEntry = harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state");
  assert.equal(goalEntry?.data?.goal, "Set the new goal.");
  assert.equal(goalEntry?.data?.status, "running");
  assert.equal(harness.userMessages.length, 1);
  assert.equal(kickoff.message.content, "Set the new goal.");
});

test("/goal queues the new goal when the agent is already running", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension, { isIdle: false });

  await harness.command("goal", "Review the active change");

  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];
  assert.equal(kickoff.message.content, "Review the active change");
  assert.deepEqual(kickoff.options, { deliverAs: "followUp" });
  assert.deepEqual(harness.notifications.at(-1), {
    message: "Goal queued; the active run is unchanged until delivery: Review the active change",
    level: "info",
  });
});

test("argumentless /goal leaves state unchanged when cancelled or headless", async () => {
  const extension = await loadExtension();
  const interactive = createHarness(extension, { hasUI: true, inputAnswers: ["  "] });
  await interactive.command("goal", "Existing goal");
  await interactive.emit("message_start", {
    message: deliveredCustomMessage(customMessagesOfType(interactive, "todo-progress-goal-kickoff")[0]),
  });
  const persistedBeforeCancel = interactive.entries.length;
  await interactive.command("goal");

  assert.equal(interactive.entries.length, persistedBeforeCancel);
  assert.match(await interactive.injectedContext(), /Goal: Existing goal/);
  assert.deepEqual(interactive.notifications.at(-1), { message: "Goal start cancelled", level: "info" });

  const headless = createHarness(extension);
  await headless.command("goal");
  assert.equal(headless.entries.length, 0);
  assert.deepEqual(headless.notifications.at(-1), {
    message: "Usage: /goal <goal> (interactive input is unavailable)",
    level: "warning",
  });
});

test("a premature final response dispatches one custom continuation and completion suppresses another", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);

  const { goalId, runId } = await startGoalRun(harness, "Complete all three sections");
  assert.ok(goalId && runId);

  const premature = assistantMessage("Section one is done.");
  await harness.emit("agent_end", { messages: [premature] });
  await harness.emit("agent_settled", {});
  await harness.emit("agent_settled", {});
  const continuations = customMessagesOfType(harness, "todo-progress-goal-continuation");
  assert.equal(continuations.length, 1);
  assert.deepEqual(continuations[0].options, { deliverAs: "followUp" });

  const continuationDetails = continuations[0].message.details;
  assert.notEqual(continuationDetails.runId, runId);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", {
    message: {
      role: "custom",
      customType: "todo-progress-goal-continuation",
      content: "continue",
      details: continuationDetails,
    },
  });
  await executeCheckpoint(harness, "checkpoint-1", {
    status: "completed",
    goalId,
    runId: continuationDetails.runId,
    summary: "All sections completed.",
    coverage: ["Section one", "Section two", "Section three"],
    verificationEvidence: ["Focused tests passed"],
  });
  await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
  await harness.emit("agent_settled", {});
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 1);
});

test("native cancellation wins even after a terminal checkpoint", async () => {
  const extension = await loadExtension();
  const abortController = new AbortController();
  const harness = createHarness(extension, { signal: abortController.signal });
  const { goalId, runId } = await startGoalRun(harness, "Finish safely");
  await executeCheckpoint(harness, "completed", {
    status: "completed",
    goalId,
    runId,
    summary: "Finished",
    coverage: ["Entire goal"],
    verificationEvidence: ["Tests passed"],
  });

  abortController.abort();
  await harness.emit("message_start", { message: assistantMessage("Late assistant work", "toolUse") });
  await harness.emit("tool_execution_start", { toolCallId: "late-after-abort", toolName: "bash", args: { command: "true" } });
  await harness.emit("tool_execution_end", { toolCallId: "late-after-abort", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  const goalEntry = harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state");
  assert.equal(goalEntry?.data?.status, "paused");
  assert.match(goalEntry?.data?.pauseReason, /Native cancellation/);
  assert.equal(goalEntry?.data?.checkpoint?.status, "completed");
});

test("goal_checkpoint rejects stale identity and missing terminal details", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const { goalId, runId } = await startGoalRun(harness, "Verify release");
  const checkpoint = harness.tools.get("goal_checkpoint");

  await assert.rejects(checkpoint.execute("stale", {
    status: "continue",
    goalId,
    runId: "stale-run",
    summary: "Continue",
  }), /does not match/);
  await assert.rejects(checkpoint.execute("blocked", {
    status: "blocked",
    goalId,
    runId,
    summary: "Cannot proceed",
    blockerCause: "Approval missing",
  }), /requiredIntervention/);
});

test("queued follow-ups update todo context only when the user message is delivered", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);

  const beforeStart = await harness.emit("before_agent_start", {
    prompt: "Original styling task",
    systemPrompt: "base prompt",
  });
  assert.match(beforeStart.systemPrompt, /\[TODO PROGRESS POLICY\]/);

  await harness.emit("message_start", { message: userMessage("Original styling task") });
  assert.match(await harness.injectedContext(), /Goal: Original styling task/);
  const persistedBeforeQueue = harness.entries.length;

  // Pi emits input as soon as a follow-up is accepted, while message_start is
  // delayed until the active run has finished. Queue acceptance must not alter
  // the context seen by that still-active run.
  await harness.emit("input", {
    text: "Queued follow-up question",
    source: "rpc",
    streamingBehavior: "followUp",
  });
  assert.equal(harness.hasHandlers("input"), false);
  assert.equal(harness.entries.length, persistedBeforeQueue);
  assert.match(await harness.injectedContext(), /Goal: Original styling task/);
  assert.doesNotMatch(await harness.injectedContext(), /Queued follow-up question/);

  await harness.emit("message_start", { message: userMessage("Queued follow-up question") });
  const deliveredContext = await harness.injectedContext();
  assert.match(deliveredContext, /Goal: Queued follow-up question/);
  assert.doesNotMatch(deliveredContext, /Original styling task/);
  assert.equal(harness.entries.at(-1)?.data?.goal, "Queued follow-up question");
});


test("real checklist extraction updates, strips, replaces after compaction, and clears ordinary chat", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension, { hasUI: true });

  await harness.emit("message_start", { message: userMessage("Prepare the package") });
  const first = assistantMessage("Goal: Prepare the package\n- [x] Inspect files\n- [-] Update docs\n- [ ] Run checks", "toolUse");
  const transformed = await harness.emit("message_end", { message: first });
  assert.deepEqual(harness.widgets.at(-1).lines.slice(0, 5), [
    "Goal: Prepare the package",
    "Todo 1/3 done, 1 partial",
    "[x] Inspect files",
    "[-] Update docs",
    "[ ] Run checks",
  ]);
  assert.doesNotMatch(transformed.message.content[0].text, /\[x\]|\[-\]|\[ \]/);

  await harness.emit("session_compact", {});
  const replacement = assistantMessage("- [ ] Verify archive\n- [ ] Write handoff", "toolUse");
  await harness.emit("message_end", { message: replacement });
  assert.deepEqual(harness.widgets.at(-1).lines.slice(2), ["[ ] Verify archive", "[ ] Write handoff"]);

  await harness.emit("agent_end", { messages: [assistantMessage("Here is the result.")] });
  assert.equal(harness.widgets.at(-1).lines, undefined);
});

test("automatic runs get fresh run identities and stale checkpoints are rejected", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const first = await startGoalRun(harness, "Finish the migration");

  await executeCheckpoint(harness, "continue-1", {
    status: "continue",
    ...first,
    summary: "The first stage is complete.",
    remainingWork: ["Migrate the second stage"],
    nextAction: "Inspect the second-stage inputs",
  });
  await harness.emit("agent_end", { messages: [assistantMessage("Stage one complete.")] });
  await harness.emit("agent_settled", {});

  const next = customMessagesOfType(harness, "todo-progress-goal-continuation").at(-1).message.details;
  assert.notEqual(next.runId, first.runId);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", {
    message: { role: "custom", customType: "todo-progress-goal-continuation", content: "continue", details: next },
  });
  await assert.rejects(harness.tools.get("goal_checkpoint").execute("stale", {
    status: "continue",
    ...first,
    summary: "Stale",
    remainingWork: ["Work"],
    nextAction: "Act",
  }), /does not match/);
  assert.match(await harness.goalContext(), new RegExp(`Run identity: ${next.runId}`));
});

test("provider retries and compaction recovery do not pause before the final settled outcome", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const first = await startGoalRun(harness, "Recover from provider failures");

  await harness.emit("agent_end", { messages: [assistantMessage("", "error")] });
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status running/);

  await harness.emit("session_compact", {});
  await harness.emit("agent_start", {});
  const retryContext = await harness.goalContext();
  const retryRunId = /Run identity: (.+)/.exec(retryContext)?.[1];
  assert.notEqual(retryRunId, first.runId);
  await harness.emit("agent_end", { messages: [assistantMessage("Recovered.")] });
  await harness.emit("agent_settled", {});
  const continuations = customMessagesOfType(harness, "todo-progress-goal-continuation");
  assert.equal(continuations.length, 1);

  await harness.emit("agent_start", {});
  await harness.emit("message_start", {
    message: { role: "custom", customType: "todo-progress-goal-continuation", content: "continue", details: continuations[0].message.details },
  });
  await harness.emit("agent_end", { messages: [assistantMessage("", "length")] });
  await harness.emit("agent_settled", {});
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);
  assert.match(harness.notifications.at(-1).message, /Terminal provider result: length/);
});

test("pending user input suppresses automatic continuation and duplicate settled events", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  await startGoalRun(harness, "Respect pending input");
  harness.setPending(true);

  await harness.emit("agent_end", { messages: [assistantMessage("Partial result.")] });
  await harness.emit("agent_settled", {});
  await harness.emit("agent_settled", {});
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);
});

test("waiting resumes on a native custom notification without claiming job verification", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const identity = await startGoalRun(harness, "Wait for the native job");
  const result = await executeCheckpoint(harness, "waiting-1", {
    status: "waiting",
    ...identity,
    summary: "The native job is still running.",
    waitingFor: "Background validation receipt",
    jobId: "job-42",
  });
  assert.match(result.content[0].text, /not independently verified/);
  await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
  await harness.emit("agent_settled", {});
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);

  await harness.emit("agent_start", {});
  await harness.emit("message_start", {
    message: { role: "custom", customType: "native-job-notification", content: "job-42 finished", details: { jobId: "job-42" } },
  });
  const resumed = await harness.goalContext();
  assert.match(resumed, /Controller status: running/);
  assert.doesNotMatch(resumed, new RegExp(`Run identity: ${identity.runId}`));
});

test("an unrelated identical user message cannot activate a pending correlated goal", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension, { isIdle: false });
  await harness.command("goal", "Identical request text");
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];

  await harness.emit("message_start", { message: userMessage("Identical request text") });
  assert.equal(await harness.goalContext(), "");

  await harness.emit("message_start", { message: deliveredCustomMessage(kickoff) });
  assert.match(await harness.goalContext(), /Explicit goal: Identical request text/);
});

test("queued goals can be paused without exposing canceled kickoff content or aborting unrelated work", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension, { isIdle: false });
  const unrelated = userMessage("Explain an unrelated setting");
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: unrelated });
  await harness.command("goal", "Queued release goal");
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];
  await harness.command("goal-pause");
  assert.equal(harness.runtime.abortCount, 0);
  assert.match(harness.notifications.at(-1).message, /canceled kickoff content will not reach the model/);

  const delivered = deliveredCustomMessage(kickoff);
  await harness.emit("message_start", { message: delivered });
  const replacement = await harness.emit("message_end", { message: delivered });
  assert.equal(replacement.message.details.canceled, true);
  assert.doesNotMatch(replacement.message.content, /Queued release goal/);
  const modelContext = await harness.emit("context", { messages: [unrelated, replacement.message] });
  assert.equal(modelContext.messages[0], unrelated);
  assert.doesNotMatch(JSON.stringify(modelContext.messages), /Queued release goal/);
  assert.equal(harness.runtime.abortCount, 0);
  assert.equal(await harness.goalContext(), "");
  await harness.command("goal-status");
  assert.equal(harness.notifications.at(-1).message, "No explicit goal has been started");
});

test("pause and already-aborted signals dominate late assistant, tool, and notification events", async () => {
  const extension = await loadExtension();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const harness = createHarness(extension, { signal: alreadyAborted.signal });
  await startGoalRun(harness, "Never restart after cancellation");
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);

  await harness.emit("message_start", { message: assistantMessage("Late response", "toolUse") });
  await harness.emit("tool_execution_start", { toolCallId: "late", toolName: "bash", args: { command: "true" } });
  await harness.emit("tool_execution_end", { toolCallId: "late", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  await harness.emit("message_start", { message: { role: "custom", customType: "native-job-notification", content: "late" } });
  await harness.emit("agent_settled", {});
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);
});

test("terminal checkpoints require a sole tool call and later same-run work invalidates accepted terminal state", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const identity = await startGoalRun(harness, "Certify the result safely");
  const completed = {
    status: "completed",
    ...identity,
    summary: "Everything is complete.",
    coverage: ["Entire goal"],
    verificationEvidence: ["npm test passed"],
  };

  await assert.rejects(executeCheckpoint(harness, "terminal-with-sibling", completed, [
    { id: "sibling", name: "bash", arguments: { command: "true" } },
  ]), /sole tool call/);

  const result = await executeCheckpoint(harness, "terminal-only", completed);
  assert.match(result.content[0].text, /Goal completed: Everything is complete/);
  assert.match(result.content[0].text, /Verification:\nnpm test passed|Verification:\n- npm test passed/);
  await harness.emit("tool_execution_start", { toolCallId: "later", toolName: "bash", args: { command: "echo later" } });
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status running/);
  assert.match(harness.notifications.at(-1).message, /checkpoint missing/);
});

test("completed goals stay terminal when later ordinary chat is aborted", async () => {
  const extension = await loadExtension();
  const abortController = new AbortController();
  const harness = createHarness(extension, { signal: abortController.signal });
  const identity = await startGoalRun(harness, "Complete once");
  await executeCheckpoint(harness, "complete-once", {
    status: "completed",
    ...identity,
    summary: "Completed once.",
    coverage: ["Whole goal"],
    verificationEvidence: ["Focused test passed"],
  });

  await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
  await harness.emit("agent_settled", {});
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage("What time is it?") });
  await harness.emit("message_start", { message: assistantMessage("I cannot inspect a clock here.") });
  abortController.abort();
  await harness.emit("agent_end", { messages: [assistantMessage("", "aborted")] });
  await harness.emit("agent_settled", {});
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status completed/);
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);
});

test("blocked checkpoint output and status preserve cause and required intervention", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const identity = await startGoalRun(harness, "Obtain approval");
  const result = await executeCheckpoint(harness, "blocked-1", {
    status: "blocked",
    ...identity,
    summary: "Approval is required.",
    blockerCause: "No release approval exists",
    requiredIntervention: "A maintainer must approve the release",
  });
  assert.match(result.content[0].text, /Cause: No release approval exists/);
  assert.match(result.content[0].text, /Required intervention: A maintainer must approve the release/);
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /cause No release approval exists/);
  assert.match(harness.notifications.at(-1).message, /intervention A maintainer must approve the release/);
});

test("three no-progress runs pause and the absolute continuation limit pauses despite progress", async () => {
  const extension = await loadExtension();
  const noProgress = createHarness(extension);
  await startGoalRun(noProgress, "Bound stalled work");
  for (let run = 0; run < 3; run += 1) {
    await noProgress.emit("agent_end", { messages: [assistantMessage(`Attempt ${run + 1}`)] });
    await noProgress.emit("agent_settled", {});
    if (run < 2) {
      const details = customMessagesOfType(noProgress, "todo-progress-goal-continuation").at(-1).message.details;
      await noProgress.emit("agent_start", {});
      await noProgress.emit("message_start", {
        message: { role: "custom", customType: "todo-progress-goal-continuation", content: "continue", details },
      });
    }
  }
  assert.equal(customMessagesOfType(noProgress, "todo-progress-goal-continuation").length, 2);
  await noProgress.command("goal-status");
  assert.match(noProgress.notifications.at(-1).message, /status paused/);
  assert.match(noProgress.notifications.at(-1).message, /No observable progress in 3 consecutive runs/);

  const bounded = createHarness(extension);
  await startGoalRun(bounded, "Bound productive continuations");
  for (let run = 0; run <= 20; run += 1) {
    await bounded.emit("tool_execution_start", { toolCallId: `work-${run}`, toolName: "bash", args: { command: `echo ${run}` } });
    await bounded.emit("tool_execution_end", {
      toolCallId: `work-${run}`,
      toolName: "bash",
      result: { content: [{ type: "text", text: `result ${run}` }] },
      isError: false,
    });
    await bounded.emit("agent_end", { messages: [assistantMessage(`Progress ${run}`)] });
    await bounded.emit("agent_settled", {});
    if (run < 20) {
      const details = customMessagesOfType(bounded, "todo-progress-goal-continuation").at(-1).message.details;
      await bounded.emit("agent_start", {});
      await bounded.emit("message_start", {
        message: { role: "custom", customType: "todo-progress-goal-continuation", content: "continue", details },
      });
    }
  }
  assert.equal(customMessagesOfType(bounded, "todo-progress-goal-continuation").length, 20);
  await bounded.command("goal-status");
  assert.match(bounded.notifications.at(-1).message, /status paused/);
  assert.match(bounded.notifications.at(-1).message, /Automatic continuation limit \(20\) reached/);
});

test("explicit pause and resume enforce idle guards and create a fresh bounded run", async () => {
  const extension = await loadExtension();
  const harness = createHarness(extension);
  const initial = await startGoalRun(harness, "Pause and resume safely");
  await harness.command("goal-pause");
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);

  harness.setPending(true);
  await harness.command("goal-resume");
  assert.match(harness.notifications.at(-1).message, /Wait for Pi and pending messages/);
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);

  harness.setPending(false);
  await harness.command("goal-resume");
  const continuations = customMessagesOfType(harness, "todo-progress-goal-continuation");
  assert.equal(continuations.length, 1);
  const resumed = continuations[0].message.details;
  assert.notEqual(resumed.runId, initial.runId);
  assert.match(continuations[0].message.content, /^Resume the explicit goal/);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", {
    message: { role: "custom", customType: "todo-progress-goal-continuation", content: "resume", details: resumed },
  });
  assert.match(await harness.goalContext(), new RegExp(`Run identity: ${resumed.runId}`));
});

test("reload and tree restoration pause runnable state while malformed state is ignored", async () => {
  const extension = await loadExtension();
  const persisted = {
    version: 1,
    goal: "Restore safely",
    goalId: "goal-restored",
    runId: "run-restored",
    status: "running",
    continuations: 4,
    noProgressRuns: 1,
    progressRevision: 2,
    lastSettledProgressRevision: 2,
    seenProgress: ["tool:abc"],
    continuationOutstanding: true,
  };
  const branch = [{ type: "custom", customType: "todo-progress-goal-state", data: persisted }];
  const harness = createHarness(extension, { branch });
  await harness.emit("session_start", { reason: "reload" });
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);
  assert.match(harness.notifications.at(-1).message, /Session reload or branch restoration requires explicit resume/);

  harness.setBranch(branch);
  await harness.emit("session_tree", {});
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status paused/);

  harness.setBranch([{ type: "custom", customType: "todo-progress-goal-state", data: { version: 1, goal: "bad", status: "running" } }]);
  await harness.emit("session_tree", {});
  assert.equal(await harness.goalContext(), "");
});

test("long explicit goals remain intact and synchronous dispatch failures pause safely", async () => {
  const extension = await loadExtension();
  const longGoal = `Review ${"all-sections-".repeat(4000)}without truncation`;
  const harness = createHarness(extension);
  await startGoalRun(harness, longGoal);
  assert.match(await harness.goalContext(), new RegExp(`Explicit goal: ${longGoal}`));

  const failing = createHarness(extension, { sendMessageError: new Error("dispatch unavailable") });
  await startGoalRun(failing, "Handle dispatch failure");
  await failing.emit("agent_end", { messages: [assistantMessage("Partial result.")] });
  await failing.emit("agent_settled", {});
  await failing.command("goal-status");
  assert.match(failing.notifications.at(-1).message, /status paused/);
  assert.match(failing.notifications.at(-1).message, /Continuation dispatch failed: dispatch unavailable/);
});

for (const status of ["completed", "blocked", "waiting"]) {
  test(`queued clarification cannot reopen ${status} in the same native run`, async () => {
    const harness = createHarness(await loadExtension());
    const identity = await startGoalRun(harness, "Implement all plan sections");
    await executeCheckpoint(harness, `terminal-${status}`, {
      ...identity, status, summary: "Checkpoint before a queued clarification",
      coverage: ["All sections"], verificationEvidence: ["Tests pass"],
      blockerCause: "Missing permission", requiredIntervention: "Owner approval",
      waitingFor: "CI", jobId: "ci-123",
    });
    // Pi drains follow-ups after terminating tools without a new agent_start.
    await harness.emit("message_start", { message: userMessage("Explain the current status") });
    const reply = assistantMessage("Here is the current status.");
    await harness.emit("message_start", { message: reply });
    await harness.emit("message_end", { message: reply });
    await harness.emit("agent_end", { messages: [reply] });
    await harness.emit("agent_settled", {});
    assert.equal(harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state").data.status, status);
    assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);
  });
}

test("native SessionManager snapshots cannot acquire future completion", async () => {
  const harness = createHarness(await loadExtension());
  const identity = await startGoalRun(harness, "Preserve branch-local goal progress");
  const saved = harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state");
  const expected = structuredClone(saved.data);
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(saved.customType, saved.data);
  await executeCheckpoint(harness, "finish-branch", {
    ...identity, status: "completed", summary: "Completed current branch",
    coverage: ["Branch-local work"], verificationEvidence: ["Regression test passed"],
  });
  assert.deepEqual(saved.data, expected);
  assert.deepEqual(manager.getBranch().at(-1).data, expected);
  harness.setBranch(manager.getBranch());
  await harness.emit("session_tree", {});
  assert.match(await harness.goalContext(), /Controller status: paused/);
  assert.doesNotMatch(await harness.goalContext(), /Completed current branch/);
});

test("accepted goal length round-trips and oversized goals are rejected before dispatch", async () => {
  const harness = createHarness(await loadExtension());
  const goal = "x".repeat(100_000);
  await startGoalRun(harness, goal);
  const saved = harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state");
  harness.setBranch([saved]);
  await harness.emit("session_start", { reason: "reload" });
  assert.ok((await harness.goalContext()).includes(`Explicit goal: ${goal}\n`));
  const submitted = harness.userMessages.length;
  await harness.command("goal", `${goal}x`);
  assert.equal(harness.userMessages.length, submitted);
  assert.match(harness.notifications.at(-1).message, /at most 100000 characters/);
});

test("restored waiting goals need explicit resume before any notification", async () => {
  const harness = createHarness(await loadExtension());
  const identity = await startGoalRun(harness, "Wait safely across reload");
  await executeCheckpoint(harness, "wait-before-reload", {
    ...identity, status: "waiting", summary: "Waiting for CI", waitingFor: "CI", jobId: "ci-456",
  });
  harness.setBranch([harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state")]);
  await harness.emit("session_start", { reason: "reload" });
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: { role: "custom", customType: "job-notification", content: "CI finished" } });
  await harness.emit("agent_settled", {});
  assert.match(await harness.goalContext(), /Controller status: paused/);
  assert.equal(customMessagesOfType(harness, "todo-progress-goal-continuation").length, 0);
});

test("native Pi startup preserves hooks and pause cancels a delayed continuation", async () => {
  const harness = createHarness(await loadExtension());
  const inputs = [];
  const policies = [];
  const modelContexts = [];
  const native = {
    isStreaming: false,
    model: { provider: "fixture" },
    _modelRuntime: { hasConfiguredAuth: () => true },
    _baseSystemPromptOptions: { selectedTools: [] },
    _baseSystemPrompt: "Required external policy",
    agent: { state: {} },
    _pendingNextTurnMessages: [],
    _flushPendingBashMessages() {},
    _flushPendingCustomMessages() {},
    _findLastAssistantMessage() {},
    getActiveToolNames: () => [],
    _preparePromptAndToolLoadout: () => undefined,
    async _runInputHandlers(text, images, source) {
      return this._extensionRunner.emitInput(text, images, source);
    },
    _extensionRunner: {
      hasHandlers: (type) => type === "input",
      async emitInput(text, images, source) {
        inputs.push({ text, source });
        return { action: "transform", text: `Fixture input policy\n${text}`, images };
      },
      async emitBeforeAgentStart(prompt, images) {
        const result = await harness.emit("before_agent_start", { prompt, images, systemPrompt: "Required external policy" });
        policies.push(result.systemPrompt);
        return { messages: [], systemPrompt: result.systemPrompt, systemPromptOptions: { selectedTools: [] } };
      },
    },
    async _runAgentPrompt(messages) {
      const abortsBeforeDelivery = harness.runtime.abortCount;
      await harness.emit("agent_start", {});
      for (const message of messages) {
        await harness.emit("message_start", { message });
        await harness.emit("message_end", { message });
      }
      // The model boundary must not be reached for an aborted owned delivery.
      if (harness.runtime.abortCount === abortsBeforeDelivery) {
        modelContexts.push((await harness.emit("context", { messages })).messages);
      }
    },
    prompt: AgentSession.prototype.prompt,
  };
  await harness.command("goal", "Implement all sections of plan.md");
  const kickoff = harness.userMessages[0];
  await AgentSession.prototype.sendUserMessage.call(native, kickoff.content, kickoff.options);
  await harness.emit("agent_end", { messages: [assistantMessage("Section one finished")] });
  await harness.emit("agent_settled", {});
  const continuation = harness.userMessages[1];
  assert.ok(continuation, "Premature final response must request continuation");
  await AgentSession.prototype.sendUserMessage.call(native, continuation.content, continuation.options);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((input) => input.source === "extension"));
  assert.equal(policies.length, 2);
  assert.ok(policies.every((policy) => policy.includes("Required external policy") && policy.includes("TODO PROGRESS POLICY")));
  assert.equal(modelContexts[0][0].role, "user");
  assert.equal(modelContexts[0][0].content, "Fixture input policy\nImplement all sections of plan.md");
  assert.equal(modelContexts[1][0].role, "custom", "Automatic continuation must not become new user authorization");
  assert.equal(modelContexts[1][0].customType, "todo-progress-goal-continuation");

  await harness.emit("agent_end", { messages: [assistantMessage("Section two finished")] });
  await harness.emit("agent_settled", {});
  const delayedContinuation = harness.userMessages[2];
  assert.ok(delayedContinuation);
  let releaseStartup;
  let enteredStartup;
  const held = new Promise((resolve) => { releaseStartup = resolve; });
  const entered = new Promise((resolve) => { enteredStartup = resolve; });
  const beforeStart = native._extensionRunner.emitBeforeAgentStart;
  native._extensionRunner.emitBeforeAgentStart = async (...args) => {
    enteredStartup();
    await held;
    return beforeStart(...args);
  };
  const delayed = AgentSession.prototype.sendUserMessage.call(native, delayedContinuation.content, delayedContinuation.options);
  await entered;
  await harness.command("goal-pause");
  assert.equal(harness.runtime.abortCount, 0, "Pi is still idle during asynchronous preflight");
  releaseStartup();
  await delayed;
  assert.equal(harness.runtime.abortCount, 1, "Canceled owned delivery must request native abort before model work");
  assert.equal(modelContexts.length, 2, "Delayed canceled continuation cannot reach the model boundary");
  const filtered = await harness.emit("context", { messages: [userMessage(delayedContinuation.content)] });
  assert.ok(filtered.messages.every((message) => message.customType !== "todo-progress-goal-continuation"));
  assert.match(await harness.goalContext(), /Controller status: paused/);
});
