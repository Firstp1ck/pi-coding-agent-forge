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
    async executeTool(name, id, params, { signal, siblings = [] } = {}) {
      const message = assistantToolMessage([{ id, name, arguments: params }, ...siblings]);
      await this.emit("message_start", { message });
      await this.emit("message_end", { message });
      for (const call of message.content) {
        await this.emit("tool_execution_start", { toolCallId: call.id, toolName: call.name, args: call.arguments });
      }
      try {
        const result = await tools.get(name).execute(id, params, signal, undefined, ctx);
        await this.emit("tool_execution_end", { toolCallId: id, toolName: name, result, isError: false });
        return result;
      } catch (error) {
        await this.emit("tool_execution_end", { toolCallId: id, toolName: name, result: { content: [{ type: "text", text: error.message }] }, isError: true });
        throw error;
      }
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

async function startToolGoal(harness, goal = "Implement and verify the requested change") {
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage(goal) });
  return harness.executeTool("goal", "create-goal", { goal });
}

function latestGoal(harness) {
  return harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state")?.data;
}

test("goal tool activates /goal's controller in the current run without a synthetic user message", async () => {
  const harness = createHarness(await loadExtension(), { hasUI: true });
  const result = await startToolGoal(harness, "  Implement the change\nand verify it.  ");
  const saved = latestGoal(harness);
  assert.equal(saved.goal, "Implement the change and verify it.");
  assert.equal(saved.status, "running");
  assert.deepEqual(result.details, { goalId: saved.goalId, runId: saved.runId, status: "running" });
  assert.match(result.content[0].text, /^Goal: Implement the change and verify it\./);
  assert.equal(result.terminate, undefined);
  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.customMessages.length, 0);
  assert.equal(saved.progressRevision, 0, "Controller calls do not count as work");
  assert.match(await harness.goalContext(), new RegExp(`Goal identity: ${saved.goalId}`));
  await harness.emit("message_end", { message: assistantMessage("- [-] Implement change\n- [ ] Verify result", "toolUse") });
  assert.equal(harness.widgets.at(-1).lines[0], "Goal: Implement the change and verify it.");
  await harness.command("goal-status");
  assert.match(harness.notifications.at(-1).message, /status running/);

  await harness.emit("agent_end", { messages: [assistantMessage("Partial result")] });
  await harness.emit("agent_settled", {});
  const continuation = customMessagesOfType(harness, "todo-progress-goal-continuation").at(-1);
  assert.ok(continuation);
  assert.equal(continuation.message.details.goalId, saved.goalId);
  assert.notEqual(continuation.message.details.runId, saved.runId);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: deliveredCustomMessage(continuation) });
  await executeCheckpoint(harness, "finish-tool-goal", {
    ...continuation.message.details, status: "completed", summary: "Change verified",
    coverage: ["Requested change"], verificationEvidence: ["Regression tests passed"],
  });
  await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
  await harness.emit("agent_settled", {});
  assert.equal(latestGoal(harness).status, "completed");
  assert.equal(harness.userMessages.length, 1, "Completion does not schedule another run");
});

test("goal tool reuses the running goal without resetting identities, checkpoints, checklist, or bounds", async () => {
  const harness = createHarness(await loadExtension());
  const identity = await startGoalRun(harness, "Keep the original scope");
  await executeCheckpoint(harness, "continue-original", {
    ...identity, status: "continue", summary: "Partially complete", remainingWork: ["Tests"], nextAction: "Run tests",
  });
  await harness.emit("agent_end", { messages: [assistantMessage("Tests remain")] });
  await harness.emit("agent_settled", {});
  const continuation = customMessagesOfType(harness, "todo-progress-goal-continuation").at(-1);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: deliveredCustomMessage(continuation) });
  await harness.emit("message_end", { message: assistantMessage("- [x] Implement\n- [ ] Test", "toolUse") });
  const before = structuredClone(latestGoal(harness));
  const checklist = await harness.injectedContext();
  const result = await harness.executeTool("goal", "repeat", { goal: "  Keep the original scope  " });
  assert.equal(result.details.goalId, identity.goalId);
  assert.deepEqual(latestGoal(harness), before);
  assert.equal(await harness.injectedContext(), checklist);
  await assert.rejects(harness.executeTool("goal", "replace", { goal: "Expand the scope" }), /unfinished goal already exists/);
  assert.deepEqual(latestGoal(harness), before);
});

test("goal tool rejects empty, malformed, oversized, and parallel creation without side effects", async () => {
  const harness = createHarness(await loadExtension());
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage("Implement the change") });
  for (const goal of [undefined, 42, "", " \n ", "**", "x".repeat(100_001)]) {
    await assert.rejects(harness.executeTool("goal", "invalid", { goal }), /nonempty string|at most 100000/);
    assert.equal(latestGoal(harness), undefined);
  }
  await assert.rejects(harness.executeTool("goal", "parallel", { goal: "Implement" }, {
    siblings: [{ id: "sibling", name: "read", arguments: { path: "README.md" } }],
  }), /sole tool call/);
  assert.equal(latestGoal(harness), undefined);
  assert.equal(harness.userMessages.length, 0);
  const boundary = await harness.executeTool("goal", "boundary", { goal: "x".repeat(100_000) });
  assert.equal(latestGoal(harness).goal.length, 100_000);
  assert.ok(boundary.content[0].text.length < 2500);
  assert.match(boundary.content[0].text, /preview truncated/);
});

test("goal tool rejects cancelled creation and /goal-pause before creation", async () => {
  const harness = createHarness(await loadExtension());
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage("Implement the change") });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.executeTool("goal", "cancelled", { goal: "Implement" }, { signal: controller.signal }), /cancelled/);
  assert.equal(latestGoal(harness), undefined);
  await harness.command("goal-pause");
  await assert.rejects(harness.executeTool("goal", "paused-before-start", { goal: "Implement" }), /new user request/);
  assert.equal(latestGoal(harness), undefined);
  await harness.emit("message_start", { message: userMessage("Now implement the change") });
  await harness.executeTool("goal", "new-request", { goal: "Implement" });
  assert.equal(latestGoal(harness).status, "running");
});

for (const status of ["paused", "blocked", "waiting"]) {
  test(`goal tool cannot bypass ${status} with the same or a different goal`, async () => {
    const harness = createHarness(await loadExtension());
    const result = await startToolGoal(harness, "Do not bypass controls");
    if (status === "paused") await harness.command("goal-pause");
    else await executeCheckpoint(harness, `stop-${status}`, {
      ...result.details, status, summary: "Stop here", blockerCause: "Approval needed", requiredIntervention: "Owner approval",
      waitingFor: "Native job", jobId: "job-1",
    });
    // A subsequent question must not authorize restarting the stopped goal.
    await harness.emit("message_start", { message: userMessage("What is the status?") });
    const before = structuredClone(latestGoal(harness));
    for (const goal of ["Do not bypass controls", "A different goal"]) {
      await assert.rejects(harness.executeTool("goal", `bypass-${goal}`, { goal }), new RegExp(`Goal is ${status}`));
      assert.deepEqual(latestGoal(harness), before);
    }
  });
}

test("tool and context cancellation signals stop agent-created goals", async () => {
  const extension = await loadExtension();
  for (const source of ["tool", "context"]) {
    const controller = new AbortController();
    const harness = createHarness(extension, source === "context" ? { signal: controller.signal } : {});
    await harness.emit("agent_start", {});
    await harness.emit("message_start", { message: userMessage("Implement safely") });
    await harness.executeTool("goal", "start-with-signal", { goal: "Implement safely" },
      source === "tool" ? { signal: controller.signal } : {});
    controller.abort();
    assert.equal(latestGoal(harness).status, "paused");
    await harness.emit("agent_end", { messages: [assistantMessage("Late response")] });
    await harness.emit("agent_settled", {});
    assert.equal(harness.userMessages.length, 0);
  }
});

test("repeated goal tool calls cannot defeat the no-progress limit", async () => {
  const harness = createHarness(await loadExtension());
  await startToolGoal(harness, "Bound agent-created work");
  for (let run = 0; run < 3; run += 1) {
    await harness.executeTool("goal", `repeat-${run}`, { goal: "Bound agent-created work" });
    assert.equal(latestGoal(harness).progressRevision, 0);
    await harness.emit("agent_end", { messages: [assistantMessage("Still unfinished")] });
    await harness.emit("agent_settled", {});
    if (run < 2) {
      const continuation = customMessagesOfType(harness, "todo-progress-goal-continuation").at(-1);
      await harness.emit("agent_start", {});
      await harness.emit("message_start", { message: deliveredCustomMessage(continuation) });
    }
  }
  assert.equal(latestGoal(harness).status, "paused");
  assert.match(latestGoal(harness).pauseReason, /No observable progress in 3 consecutive runs/);
  assert.equal(harness.userMessages.length, 2);
});

test("goal tool respects queued user goals", async () => {
  const harness = createHarness(await loadExtension(), { isIdle: false });
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage("Original work") });
  await harness.command("goal", "User's chosen goal");
  await assert.rejects(harness.executeTool("goal", "queued-conflict", { goal: "Agent's goal" }), /user \/goal is queued/);
  assert.equal(latestGoal(harness), undefined);
  const kickoff = customMessagesOfType(harness, "todo-progress-goal-kickoff")[0];
  await harness.emit("message_start", { message: deliveredCustomMessage(kickoff) });
  assert.equal(latestGoal(harness).goal, "User's chosen goal");
});

test("tool-created goals restore paused and can be resumed with /goal-resume", async () => {
  const harness = createHarness(await loadExtension());
  const result = await startToolGoal(harness, "Restore agent-created goal");
  harness.setBranch([harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state")]);
  await harness.emit("session_start", { reason: "reload" });
  assert.equal(latestGoal(harness).status, "paused");
  await assert.rejects(harness.executeTool("goal", "restored", { goal: "Restore agent-created goal" }), /Goal is paused/);
  await harness.command("goal-resume");
  assert.equal(latestGoal(harness).goalId, result.details.goalId);
  assert.notEqual(latestGoal(harness).runId, result.details.runId);
  assert.equal(latestGoal(harness).status, "running");
});

test("goal tool cannot create work from a notification but can start a new user task after completion", async () => {
  const harness = createHarness(await loadExtension());
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: { role: "custom", customType: "notification", content: "News" } });
  await assert.rejects(harness.executeTool("goal", "no-request", { goal: "Invented work" }), /new user request/);
  const first = await startToolGoal(harness, "First task");
  await executeCheckpoint(harness, "first-done", {
    ...first.details, status: "completed", summary: "First task done", coverage: ["First task"], verificationEvidence: ["Tests passed"],
  });
  await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
  await harness.emit("agent_settled", {});
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: { role: "custom", customType: "notification", content: "News" } });
  await assert.rejects(harness.executeTool("goal", "no-restart", { goal: "More work" }), /new user request/);
  assert.equal(latestGoal(harness).status, "completed");
  const second = await startToolGoal(harness, "Second task");
  assert.notEqual(second.details.goalId, first.details.goalId);
  assert.equal(latestGoal(harness).goal, "Second task");
});

for (const status of ["paused", "blocked", "waiting"]) {
  test(`goal_resume resumes a ${status} goal in the current run without synthetic messages`, async () => {
    const harness = createHarness(await loadExtension(), { isIdle: false });
    const first = await startToolGoal(harness, "Resume the original scope");
    if (status === "paused") await harness.command("goal-pause");
    else await executeCheckpoint(harness, "stop", {
      ...first.details, status, summary: "Stop here", blockerCause: "Approval needed", requiredIntervention: "Owner approval",
      waitingFor: "Native job", jobId: "job-1",
    });
    await harness.emit("agent_end", { messages: [assistantMessage("Stopped", "toolUse")] });
    await harness.emit("agent_settled", {});
    const stopped = structuredClone(latestGoal(harness));
    await harness.emit("agent_start", {});
    await harness.emit("message_start", { message: userMessage("Resume the goal") });
    assert.match(await harness.goalContext(), /If the user asks to resume, call goal_resume/);
    await harness.emit("message_end", { message: assistantMessage("- [x] Inspect\n- [ ] Verify", "toolUse") });
    const checklist = await harness.injectedContext();
    const result = await harness.executeTool("goal_resume", "resume", first.details);
    const resumed = latestGoal(harness);
    assert.equal(resumed.goalId, stopped.goalId);
    assert.equal(resumed.goal, stopped.goal);
    assert.notEqual(resumed.runId, stopped.runId);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.checkpoint, undefined);
    assert.equal(resumed.pauseReason, undefined);
    assert.equal(resumed.continuationOutstanding, false);
    assert.equal(resumed.progressRevision, stopped.progressRevision);
    assert.deepEqual(resumed.seenProgress, stopped.seenProgress);
    assert.equal(await harness.injectedContext(), checklist);
    assert.deepEqual(result.details, { goalId: resumed.goalId, runId: resumed.runId, status: "running" });
    assert.match(result.content[0].text, /use this new runId for goal_checkpoint/);
    assert.equal(result.terminate, undefined);
    assert.equal(harness.userMessages.length, 0);
    assert.equal(harness.customMessages.length, 0);
    await assert.rejects(executeCheckpoint(harness, "stale", {
      ...first.details, status: "continue", summary: "More work", remainingWork: ["Tests"], nextAction: "Run tests",
    }), /does not match/);
    await executeCheckpoint(harness, "done", {
      ...result.details, status: "completed", summary: "Verified", coverage: ["Original scope"], verificationEvidence: ["Tests passed"],
    });
    await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
    await harness.emit("agent_settled", {});
    assert.equal(latestGoal(harness).status, "completed");
    assert.equal(harness.userMessages.length, 0);
  });
}

test("goal_resume cannot reset a running goal or restart completed work", async () => {
  const harness = createHarness(await loadExtension());
  const first = await startToolGoal(harness);
  for (const status of ["running", "completed"]) {
    if (status === "completed") {
      await executeCheckpoint(harness, "done", {
        ...first.details, status, summary: "Done", coverage: ["Task"], verificationEvidence: ["Tests passed"],
      });
      await harness.emit("agent_end", { messages: [assistantMessage("", "toolUse")] });
      await harness.emit("agent_settled", {});
      await harness.emit("agent_start", {});
    }
    await harness.emit("message_start", { message: userMessage("Resume") });
    const before = structuredClone(latestGoal(harness));
    await assert.rejects(harness.executeTool("goal_resume", "invalid-status", first.details), /new user request|already running|Completed goals/);
    assert.deepEqual(latestGoal(harness), before);
  }
});

test("goal_resume requires a fresh delivered user request and respects subsequent pause", async () => {
  const harness = createHarness(await loadExtension());
  const first = await startToolGoal(harness);
  await harness.command("goal-pause");
  const before = structuredClone(latestGoal(harness));
  await assert.rejects(harness.executeTool("goal_resume", "autonomous", first.details), /new user request/);
  await harness.emit("message_start", { message: { role: "custom", customType: "notification", content: "Resume now" } });
  await assert.rejects(harness.executeTool("goal_resume", "notification", first.details), /new user request/);
  await harness.emit("message_start", { message: userMessage("Resume") });
  await harness.command("goal-pause");
  await assert.rejects(harness.executeTool("goal_resume", "paused-again", first.details), /new user request/);
  assert.deepEqual(latestGoal(harness), before);
  await harness.emit("message_start", { message: userMessage("Now resume") });
  await harness.executeTool("goal_resume", "authorized", first.details);
  const resumed = structuredClone(latestGoal(harness));
  await assert.rejects(harness.executeTool("goal_resume", "repeat", resumed), /new user request/);
  assert.deepEqual(latestGoal(harness), resumed);
});

test("goal_resume rejects missing goals, stale identities, sibling calls, pending input, and queued goals", async () => {
  const harness = createHarness(await loadExtension());
  await assert.rejects(harness.executeTool("goal_resume", "missing", {}), /No explicit goal/);
  const first = await startToolGoal(harness);
  await harness.command("goal-pause");
  await harness.emit("message_start", { message: userMessage("Resume") });
  const before = structuredClone(latestGoal(harness));
  for (const params of [undefined, {}, { ...first.details, goalId: "wrong" }, { ...first.details, runId: "old" }]) {
    await assert.rejects(harness.executeTool("goal_resume", "stale", params), /does not match/);
  }
  await assert.rejects(harness.executeTool("goal_resume", "parallel", first.details, {
    siblings: [{ id: "read", name: "read", arguments: { path: "README.md" } }],
  }), /sole tool call/);
  harness.setPending(true);
  await assert.rejects(harness.executeTool("goal_resume", "pending", first.details), /pending messages/);
  harness.setPending(false);
  await harness.command("goal", "Replace old scope");
  await assert.rejects(harness.executeTool("goal_resume", "queued", first.details), /user \/goal is queued/);
  assert.deepEqual(latestGoal(harness), before);
});

for (const source of ["tool", "context"]) {
  test(`goal_resume honors ${source} cancellation before and after resuming`, async () => {
    const controller = new AbortController();
    const harness = createHarness(await loadExtension(), source === "context" ? { signal: controller.signal } : {});
    const first = await startToolGoal(harness);
    await harness.command("goal-pause");
    await harness.emit("message_start", { message: userMessage("Resume") });
    const options = source === "tool" ? { signal: controller.signal } : {};
    await harness.executeTool("goal_resume", "resume", first.details, options);
    controller.abort();
    assert.equal(latestGoal(harness).status, "paused");
    const before = structuredClone(latestGoal(harness));
    await harness.emit("message_start", { message: userMessage("Resume again") });
    await assert.rejects(harness.executeTool("goal_resume", "aborted", before, options), /cancelled/);
    assert.deepEqual(latestGoal(harness), before);
    await harness.emit("agent_end", { messages: [assistantMessage("Late output")] });
    await harness.emit("agent_settled", {});
    assert.equal(harness.userMessages.length, 0);
  });
}

test("goal_resume restores stopped work and resets bounds only once per user request", async () => {
  const harness = createHarness(await loadExtension());
  const first = await startToolGoal(harness);
  const saved = structuredClone(harness.entries.findLast((entry) => entry.customType === "todo-progress-goal-state"));
  Object.assign(saved.data, { continuations: 20, noProgressRuns: 3, progressRevision: 2, lastSettledProgressRevision: 1, seenProgress: ["tool:earlier"] });
  harness.setBranch([saved]);
  await harness.emit("session_start", { reason: "reload" });
  await assert.rejects(harness.executeTool("goal_resume", "no-request", first.details), /new user request/);
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: userMessage("Continue where you stopped") });
  const result = await harness.executeTool("goal_resume", "resume-restored", first.details);
  const resumed = latestGoal(harness);
  assert.equal(resumed.continuations, 0);
  assert.equal(resumed.noProgressRuns, 0);
  assert.equal(resumed.progressRevision, 2);
  assert.equal(resumed.lastSettledProgressRevision, 2);
  assert.deepEqual(resumed.seenProgress, ["tool:earlier"]);
  assert.equal(saved.data.continuations, 20, "Stored branch snapshots stay immutable");
  assert.equal(harness.userMessages.length, 0);
  await executeCheckpoint(harness, "continue", {
    ...result.details, status: "continue", summary: "Tests remain", remainingWork: ["Tests"], nextAction: "Run tests",
  });
  await harness.emit("agent_end", { messages: [assistantMessage("Tests remain")] });
  await harness.emit("agent_settled", {});
  const continuation = customMessagesOfType(harness, "todo-progress-goal-continuation").at(-1);
  assert.equal(continuation.message.details.goalId, first.details.goalId);
  assert.notEqual(continuation.message.details.runId, result.details.runId);
  assert.equal(latestGoal(harness).continuations, 1);
  assert.equal(latestGoal(harness).noProgressRuns, 1, "Resuming does not count as progress");
  await harness.emit("agent_start", {});
  await harness.emit("message_start", { message: deliveredCustomMessage(continuation) });
  assert.equal(latestGoal(harness).runId, continuation.message.details.runId);
});

test("goal_resume guidance interprets user resume intent without treating clarifications as approval", async () => {
  const harness = createHarness(await loadExtension());
  const tool = harness.tools.get("goal_resume");
  assert.deepEqual(tool.parameters.required, ["goalId", "runId"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.promptGuidelines.join("\n"), /user indicates they want to resume or continue/);
  assert.match(tool.promptGuidelines.join("\n"), /never for a status question, clarification alone/);
  assert.match(tool.promptGuidelines.join("\n"), /sole tool call/);
  const policy = await harness.emit("before_agent_start", { systemPrompt: "base" });
  assert.match(policy.systemPrompt, /call goal_resume before continuing work/);
  assert.match(policy.systemPrompt, /Status questions and clarifications alone do not authorize resuming/);
  assert.doesNotMatch(harness.tools.get("goal").promptGuidelines.join("\n"), /user must use \/goal or \/goal-resume/);
});

test("agent goal policy requires the goal tool but preserves scope, controls, and label-only fallback", async () => {
  const harness = createHarness(await loadExtension());
  const result = await harness.emit("before_agent_start", { prompt: "Implement", systemPrompt: "base" });
  assert.match(result.systemPrompt, /use the goal tool to set the work goal/);
  assert.match(result.systemPrompt, /requests no automatic continuation/);
  const guidelines = harness.tools.get("goal").promptGuidelines.join("\n");
  assert.match(guidelines, /do not merely write Goal: text/);
  assert.match(guidelines, /does not grant new authorization/);
  assert.match(guidelines, /Reuse the injected active goal/);
  await harness.emit("message_start", { message: userMessage("Explain this without automatic continuation") });
  await harness.emit("message_end", { message: assistantMessage("Goal: Explain it\n- [ ] Read\n- [ ] Explain", "toolUse") });
  await harness.emit("agent_end", { messages: [assistantMessage("Explanation")] });
  await harness.emit("agent_settled", {});
  assert.equal(latestGoal(harness), undefined);
  assert.equal(harness.userMessages.length, 0, "Plain Goal: text never starts the controller");
});

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
    async _normalizePromptImages(images) {
      assert.equal(images, undefined, "This fixture exercises text-only startup");
      return { images: [], hints: [] };
    },
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
