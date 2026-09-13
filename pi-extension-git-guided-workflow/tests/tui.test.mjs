import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import gitGuidedWorkflow, {
  BRANCH_GENERATION_COMMAND_NAME,
  COMMAND_NAME,
  COMMIT_GENERATION_COMMAND_NAME,
  PR_GENERATION_COMMAND_NAME,
  WEBUI_START_PAYLOAD_TYPE,
  WEBUI_START_PAYLOAD_VERSION,
  WEBUI_START_STATUS_KEY,
  createWebuiStartPayload,
  progressText,
  showActionScreen,
} from "../index.ts";
import {
  BRANCH_OUTPUT_MAX_TOKENS,
  COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
  COMMIT_GENERATION_CAPTURE_MAX_BYTES,
  COMMIT_OUTPUT_MAX_TOKENS,
} from "../src/native-generation.ts";

initTheme(undefined, false);

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

async function tempDir(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `guided-git-tui-${label}-`));
  roots.push(root);
  return root;
}

async function repository(label) {
  const root = await tempDir(label);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Guided Git TUI Test");
  git(root, "config", "user.email", "guided-git-tui@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-m", "test: initial");
  return root;
}

function fakeTheme() {
  return { fg: (_tone, text) => text, bold: (text) => text };
}

function extensionRegistration() {
  const commands = new Map();
  const handlers = new Map();
  gitGuidedWorkflow({
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { handlers.set(name, handler); },
  });
  return { commands, handlers };
}

function createContext(root, options = {}) {
  const actionMoves = [...(options.actionMoves ?? [])];
  const editorValues = [...(options.editorValues ?? [])];
  const confirmations = [];
  const notifications = [];
  const renders = [];
  const statusUpdates = [];
  let customOpen = false;
  let customCount = 0;
  let statusCallCount = 0;
  const ctx = {
    cwd: root,
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    modelRegistry: options.modelRegistry ?? {},
    isIdle: () => options.idle ?? true,
    hasPendingMessages: () => options.pending ?? false,
    ui: {
      theme: fakeTheme(),
      notify(message, type) { notifications.push({ message, type }); },
      setStatus(statusKey, statusText) {
        const call = statusCallCount;
        statusCallCount += 1;
        if (options.setStatusErrorAt === call) throw new Error(options.setStatusError ?? `status delivery ${call} failed`);
        statusUpdates.push({ statusKey, statusText });
      },
      async confirm(title, message) {
        assert.equal(customOpen, false, "custom screen must finish before confirmation opens");
        confirmations.push({ title, message });
        return options.confirm?.(title, message, confirmations.length - 1) ?? true;
      },
      async editor(title, prefill) {
        assert.equal(customOpen, false, "custom screen must finish before editor opens");
        options.onEditor?.(title, prefill);
        return editorValues.length ? editorValues.shift() : undefined;
      },
      async custom(factory) {
        assert.equal(customOpen, false, "custom screens must not overlap");
        customOpen = true;
        customCount += 1;
        return await new Promise(async (resolve, reject) => {
          let settled = false;
          let component;
          const done = (value) => {
            if (settled) return;
            settled = true;
            component?.dispose?.();
            customOpen = false;
            resolve(value);
          };
          try {
            const tui = { requestRender() {} };
            component = await factory(tui, fakeTheme(), {}, done);
            if (settled) {
              component.dispose?.();
              return;
            }
            const normal = component.render(42);
            const narrow = component.render(12);
            renders.push({ normal, narrow });
            for (const [width, lines] of [[42, normal], [12, narrow]]) {
              for (const line of lines) assert.ok(visibleWidth(line) <= width, `rendered line exceeds ${width}: ${JSON.stringify(line)}`);
            }
            const text = normal.join("\n");
            if (/Generating with active model/u.test(text)) {
              options.onLoader?.(component, customCount);
              return;
            }
            const moves = actionMoves.shift();
            assert.notEqual(moves, undefined, `missing action script for screen:\n${text}`);
            queueMicrotask(() => {
              for (let index = 0; index < moves; index += 1) component.handleInput?.("\x1b[B");
              component.handleInput?.("\r");
            });
          } catch (error) {
            customOpen = false;
            reject(error);
          }
        });
      },
    },
  };
  return { ctx, confirmations, notifications, renders, statusUpdates, statusCallCount: () => statusCallCount, remainingActions: actionMoves };
}

async function stageTracked(root, content = "changed\n") {
  await writeFile(path.join(root, "tracked.txt"), content);
  git(root, "add", "--", "tracked.txt");
}

function assistantResponse(output) {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: output }],
    usage: {},
    api: "test",
    provider: "test",
    model: "test",
    timestamp: Date.now(),
  };
}

function requestEvidence(request) {
  const text = request.messages[0].content[0].text;
  return JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n")));
}

function chunkSummary(summary) {
  return summary;
}

function webuiGenerationProfileArgument(profile) {
  return `--firstpick-webui-generation-profile=${Buffer.from(JSON.stringify({ version: 1, ...profile }), "utf8").toString("base64url")}`;
}

const validNativeCommitOutput = "<<<SHORT>>>\nfeat(core): handle large staged changes\n<<<LONG>>>\nfeat(core): handle large staged changes\n- feat: synthesize complete staged evidence\n<<<END>>>";
const oversizedStagedContent = `${"large staged evidence line\n".repeat(50_000)}final large marker\n`;

test("registers the workflow and three native generation commands with exact public names", () => {
  const { commands, handlers } = extensionRegistration();
  assert.deepEqual([...commands.keys()], [
    COMMIT_GENERATION_COMMAND_NAME,
    BRANCH_GENERATION_COMMAND_NAME,
    PR_GENERATION_COMMAND_NAME,
    COMMAND_NAME,
  ]);
  assert.deepEqual([
    COMMIT_GENERATION_COMMAND_NAME,
    BRANCH_GENERATION_COMMAND_NAME,
    PR_GENERATION_COMMAND_NAME,
    COMMAND_NAME,
  ], ["git-staged-msg", "git-branch-name", "pr", "git-guided-workflow"]);
  assert.match(commands.get(COMMIT_GENERATION_COMMAND_NAME).description, /Conventional Commit artifacts/u);
  assert.match(commands.get(BRANCH_GENERATION_COMMAND_NAME).description, /branch-name artifact/u);
  assert.match(commands.get(PR_GENERATION_COMMAND_NAME).description, /pull-request description artifact/u);
  assert.match(commands.get(COMMAND_NAME).description, /staged changes/u);
  assert.deepEqual([...handlers.keys()], ["session_shutdown"]);
  assert.equal(progressText("Push"), "✓ Stage  →  ✓ Message  →  ✓ Commit  →  ● Push");
});

test("action screens use a cancellable native list and stay within narrow widths", async () => {
  let component;
  const resultPromise = showActionScreen({
    ui: {
      custom: async (factory) => await new Promise((resolve) => {
        component = factory({ requestRender() {} }, fakeTheme(), {}, resolve);
        for (const width of [8, 12, 40]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
        component.handleInput("\x1b");
      }),
    },
  }, "Stage", "Unsafe\x1b[31m title", "odd\x00 details", [{ value: "go", label: "Continue" }]);
  assert.equal(await resultPromise, null, "Escape must cancel without selecting the highlighted action");
  assert.equal(typeof component.handleInput, "function");
});

test("idle RPC invocation emits one exact one-shot WebUI activation and no Git, model, or TUI side effect", async () => {
  const root = await repository("rpc-activation");
  await stageTracked(root);
  const beforeHead = git(root, "rev-parse", "HEAD");
  const beforeIndex = git(root, "diff", "--cached");
  let modelCalls = 0;
  const modelRegistry = { async complete() { modelCalls += 1; throw new Error("model must not be called"); } };
  const requestIds = [];

  for (let invocation = 0; invocation < 2; invocation += 1) {
    const { commands } = extensionRegistration();
    const harness = createContext(root, { mode: "rpc", hasUI: true, model: { id: "unused", provider: "test" }, modelRegistry });
    await commands.get(COMMAND_NAME).handler("", harness.ctx);
    assert.deepEqual(harness.statusUpdates.map(({ statusKey }) => statusKey), [WEBUI_START_STATUS_KEY, WEBUI_START_STATUS_KEY]);
    assert.equal(harness.statusUpdates[1].statusText, undefined, "activation status must be cleared immediately");
    const payload = JSON.parse(harness.statusUpdates[0].statusText);
    assert.deepEqual(Object.keys(payload).sort(), ["action", "requestId", "type", "version"]);
    assert.equal(payload.type, WEBUI_START_PAYLOAD_TYPE);
    assert.equal(payload.version, WEBUI_START_PAYLOAD_VERSION);
    assert.equal(payload.action, "start");
    assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    requestIds.push(payload.requestId);
    assert.equal(harness.renders.length, 0);
    assert.equal(harness.confirmations.length, 0);
    assert.match(harness.notifications[0].message, /Requested the Guided Git workflow in WebUI/u);
  }

  assert.notEqual(requestIds[0], requestIds[1], "each activation must use a unique request ID");
  const directPayload = createWebuiStartPayload();
  assert.equal(directPayload.type, WEBUI_START_PAYLOAD_TYPE);
  assert.equal(modelCalls, 0);
  assert.equal(git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(git(root, "diff", "--cached"), beforeIndex);
});

test("rejects arguments, unsupported surfaces, busy starts, and queued starts without activation or Git mutation", async () => {
  const root = await repository("refusals");
  await stageTracked(root);
  const beforeHead = git(root, "rev-parse", "HEAD");
  const beforeIndex = git(root, "diff", "--cached");
  for (const { options, args = "" } of [
    { options: { mode: "json", hasUI: false } },
    { options: { mode: "rpc", hasUI: false } },
    { options: { mode: "rpc", idle: false } },
    { options: { mode: "rpc", pending: true } },
    { options: { mode: "tui", idle: false } },
    { options: { mode: "tui", pending: true } },
    { options: { mode: "rpc" }, args: "unexpected" },
  ]) {
    const { commands } = extensionRegistration();
    const harness = createContext(root, options);
    await commands.get(COMMAND_NAME).handler(args, harness.ctx);
    assert.equal(harness.renders.length, 0);
    assert.equal(harness.statusUpdates.length, 0);
    assert.match(harness.notifications[0].message, /No Git command was run or WebUI workflow requested/u);
  }
  assert.equal(git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(git(root, "diff", "--cached"), beforeIndex);
});

test("RPC activation bounds status delivery failures without retrying or running Git", async () => {
  const root = await repository("rpc-delivery-failure");
  await stageTracked(root);
  const beforeHead = git(root, "rev-parse", "HEAD");
  const beforeIndex = git(root, "diff", "--cached");
  const { commands } = extensionRegistration();

  const setFailure = createContext(root, { mode: "rpc", setStatusErrorAt: 0, setStatusError: "set failed\nwith controls\u001b[31m" });
  await commands.get(COMMAND_NAME).handler("", setFailure.ctx);
  assert.equal(setFailure.statusCallCount(), 2, "a failed set gets one best-effort clear and no retry");
  assert.deepEqual(setFailure.statusUpdates, [{ statusKey: WEBUI_START_STATUS_KEY, statusText: undefined }]);
  assert.match(setFailure.notifications[0].message, /could not be requested in WebUI: set failed\nwith controls No Git command was run/u);
  assert.doesNotMatch(setFailure.notifications[0].message, /\u001b/u);

  const clearFailure = createContext(root, { mode: "rpc", setStatusErrorAt: 1, setStatusError: "clear failed" });
  await commands.get(COMMAND_NAME).handler("", clearFailure.ctx);
  assert.equal(clearFailure.statusCallCount(), 2, "a failed clear must not trigger an automatic retry");
  assert.equal(clearFailure.statusUpdates.length, 1);
  assert.match(clearFailure.notifications[0].message, /was requested in WebUI, but its transient status could not be cleared/u);
  assert.match(clearFailure.notifications[0].message, /Do not retry automatically/u);

  assert.equal(git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(git(root, "diff", "--cached"), beforeIndex);
});

test("manual no-model flow commits in a temporary repository and offers Finish when push is unavailable", async () => {
  const root = await repository("manual");
  await stageTracked(root, "manual\n");
  const { commands } = extensionRegistration();
  const harness = createContext(root, { actionMoves: [0, 0, 0, 0, 0], editorValues: ["feat: commit manual change"] });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(git(root, "log", "-1", "--pretty=%B"), "feat: commit manual change");
  assert.ok(harness.confirmations.some(({ title, message }) => title === "Create this Git commit?" && /Exact message:\nfeat: commit manual change/u.test(message)));
  assert.ok(harness.renders.some(({ normal }) => /Push is unavailable/u.test(normal.join("\n"))));
  assert.equal(harness.remainingActions.length, 0);
});

test("Stage all confirms exact status counts and can finish before commit", async () => {
  const root = await repository("stage-all");
  await writeFile(path.join(root, "tracked.txt"), "unstaged\n");
  await writeFile(path.join(root, "new.txt"), "new\n");
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    actionMoves: [0, 0, 0, 0, 3],
    editorValues: ["chore: staged all changes"],
  });
  const before = git(root, "rev-parse", "HEAD");
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  const stageConfirmation = harness.confirmations.find(({ title }) => title === "Stage all repository changes?");
  assert.ok(stageConfirmation);
  assert.match(stageConfirmation.message, /Staged: 0\nUnstaged: 1\nUntracked: 1\nConflicted: 0/u);
  assert.match(git(root, "status", "--porcelain"), /^A  new\.txt\nM  tracked\.txt$/mu);
  assert.equal(git(root, "rev-parse", "HEAD"), before, "Finish must not commit");
});

test("Stage all returns to a fresh summary when counts change during confirmation without staging", async () => {
  const root = await repository("stage-all-race");
  await writeFile(path.join(root, "tracked.txt"), "unstaged before confirmation\n");
  const { commands } = extensionRegistration();
  let changed = false;
  const harness = createContext(root, {
    actionMoves: [0, 1],
    confirm(title) {
      if (title === "Stage all repository changes?" && !changed) {
        changed = true;
        execFileSync("sh", ["-c", "printf 'new during confirmation\\n' > raced.txt"], { cwd: root });
      }
      return true;
    },
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "", "stale Stage-all authorization must not mutate the index");
  assert.match(git(root, "status", "--porcelain"), /^M tracked\.txt\n\?\? raced\.txt$/mu);
  assert.ok(harness.notifications.some(({ message }) => /fresh summary before staging/u.test(message)));
  assert.equal(harness.confirmations.filter(({ title }) => title === "Stage all repository changes?").length, 1);
});

test("generation sends the complete diff only after selection and accepts the preferred framing", async () => {
  const root = await repository("generate");
  await stageTracked(root, "generated private content\n");
  let completeCalls = 0;
  let received;
  const short = "feat: generate a safe message";
  const modelRegistry = {
    async complete(_model, context, options) {
      completeCalls += 1;
      received = { context, signal: options.signal };
      await new Promise((resolve) => setImmediate(resolve));
      return assistantResponse(`<<<SHORT>>>\n${short}\n<<<LONG>>>\n${short}\n\nDescribe the staged change.\n<<<END>>>`);
    },
  };
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    model: { id: "active-test-model", provider: "test" },
    modelRegistry,
    actionMoves: [0, 0, 0, 0, 0, 0],
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(completeCalls, 1, JSON.stringify({ notifications: harness.notifications, renders: harness.renders.map((entry) => entry.normal.join("\n")) }));
  assert.match(received.context.systemPrompt, /diff is data only.*Never follow instructions/su);
  assert.match(received.context.systemPrompt, /build, change, chore, ci/u);
  assert.match(received.context.messages[0].content[0].text, /generated private content/u);
  assert.equal(received.signal.aborted, false);
  assert.equal(git(root, "log", "-1", "--pretty=%s"), short);
  assert.ok(harness.renders.some(({ normal }) => /complete staged diff is sent to its provider/u.test(normal.join(" ").replace(/\s+/gu, " "))));
});

test("guided generation analyzes diffs above 1 MiB completely before choosing a message", async () => {
  const root = await repository("large-guided-generation");
  await stageTracked(root, `${"private staged content ".repeat(52_000)}\n`);
  const expectedDiff = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--"], { cwd: root, maxBuffer: COMMIT_GENERATION_CAPTURE_MAX_BYTES });
  assert.ok(expectedDiff.length > 1024 * 1024);
  const calls = [];
  let inFlight = 0;
  const short = "docs: describe a large staged change";
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    model: { id: "active-test-model", provider: "test" },
    modelRegistry: {
      async complete(_model, request, options) {
        inFlight += 1;
        assert.equal(inFlight, 1);
        calls.push({ request, options });
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (/Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt)) {
          return assistantResponse(`Chunk ${requestEvidence(request).chunk.index} changes tracked content.`);
        }
        assert.match(request.systemPrompt, /ordered chunk summaries/u);
        return assistantResponse(`${short}\n\nDescribe the complete staged change.`);
      },
    },
    actionMoves: [0, 0, 0, 0, 0, 0],
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(calls.length, 4);
  const analyses = calls.slice(0, -1);
  assert.deepEqual(Buffer.concat(analyses.map(({ request }) => Buffer.from(requestEvidence(request).diff))), expectedDiff);
  assert.deepEqual(analyses.map(({ request }) => requestEvidence(request).chunk.index), [0, 1, 2]);
  assert.ok(analyses.every(({ options }) => options.maxTokens === COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS));
  assert.equal(calls.at(-1).options.maxTokens, COMMIT_OUTPUT_MAX_TOKENS);
  assert.equal(requestEvidence(calls.at(-1).request).chunks.some((chunk) => Object.hasOwn(chunk, "diff")), false);
  assert.ok(harness.notifications.some(({ message }) => /4 model requests.*3 sequential chunk analyses/u.test(message)));
  assert.equal(git(root, "log", "-1", "--pretty=%s"), short);
});

test("guided large-diff failures and cancellation stop later requests and preserve manual entry", async (t) => {
  for (const failure of ["provider", "empty-summary", "cancel"]) {
    await t.test(failure, async () => {
      const root = await repository(`large-guided-${failure}`);
      await stageTracked(root, `${"private staged content ".repeat(52_000)}\n`);
      let calls = 0;
      let loader;
      const { commands } = extensionRegistration();
      const harness = createContext(root, {
        model: { id: "active-test-model", provider: "test" },
        modelRegistry: {
          async complete(_model, _request, { signal }) {
            calls += 1;
            await new Promise((resolve) => setImmediate(resolve));
            if (failure === "provider") throw new Error("chunk provider unavailable");
            if (failure === "empty-summary") return assistantResponse(" ");
            loader.handleInput("\x1b");
            assert.equal(signal.aborted, true);
            return assistantResponse("Late summary must not trigger another request.");
          },
        },
        actionMoves: [0, 0, 1, 0, 3],
        editorValues: ["docs: use manual after large-diff failure"],
        onLoader(component) { loader = component; },
      });
      const before = git(root, "rev-parse", "HEAD");
      await commands.get(COMMAND_NAME).handler("", harness.ctx);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.ok(harness.notifications.some(({ message }) => /Manual entry is still available/u.test(message)));
      assert.equal(git(root, "rev-parse", "HEAD"), before);
    });
  }
});

test("a guided diff above 16 MiB is not sent and manual entry remains available", async () => {
  const root = await repository("oversized-generation");
  await stageTracked(root, `${"x".repeat(COMMIT_GENERATION_CAPTURE_MAX_BYTES)}\n`);
  let completeCalls = 0;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    model: { id: "unused-model", provider: "test" },
    modelRegistry: { async complete() { completeCalls += 1; throw new Error("must not be called"); } },
    actionMoves: [0, 0, 1, 0, 3],
    editorValues: ["docs: describe a large staged change"],
  });
  const before = git(root, "rev-parse", "HEAD");
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(completeCalls, 0);
  assert.ok(harness.notifications.some(({ message }) => /generation cap.*Manual entry is still available/iu.test(message)));
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("Escape cancels direct generation, aborts its request, and keeps manual entry available", async () => {
  const root = await repository("generation-cancel");
  await stageTracked(root);
  let observedSignal;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    model: { id: "cancelled-model", provider: "test" },
    modelRegistry: {
      async complete(_model, _context, { signal }) {
        observedSignal = signal;
        return await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    },
    actionMoves: [0, 0, 1, 0, 3],
    editorValues: ["fix: use manual after cancellation"],
    onLoader(component) { queueMicrotask(() => component.handleInput("\x1b")); },
  });
  const before = git(root, "rev-parse", "HEAD");
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(observedSignal.aborted, true);
  assert.ok(harness.notifications.some(({ message }) => /generation cancelled.*Manual entry is still available/iu.test(message)));
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("generation failure keeps manual entry available", async () => {
  const root = await repository("generation-failure");
  await stageTracked(root);
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    model: { id: "failing-model", provider: "test" },
    modelRegistry: { async complete() { throw new Error("provider unavailable"); } },
    actionMoves: [0, 0, 1, 0, 3],
    editorValues: ["fix: use manual fallback"],
  });
  const before = git(root, "rev-parse", "HEAD");
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.ok(harness.notifications.some(({ message }) => /Manual entry is still available/u.test(message)), JSON.stringify(harness.notifications));
  assert.equal(git(root, "rev-parse", "HEAD"), before, "test finishes at Commit without mutation");
});

test("staged drift after exact commit confirmation returns to Stage without committing", async () => {
  const root = await repository("drift");
  await stageTracked(root, "candidate\n");
  const before = git(root, "rev-parse", "HEAD");
  const { commands } = extensionRegistration();
  let drifted = false;
  const harness = createContext(root, {
    actionMoves: [0, 0, 0, 0, 1],
    editorValues: ["feat: stale candidate"],
    confirm(title) {
      if (title === "Create this Git commit?" && !drifted) {
        drifted = true;
        execFileSync("sh", ["-c", "printf 'drift\\n' > tracked.txt"], { cwd: root });
        git(root, "add", "--", "tracked.txt");
      }
      return true;
    },
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.ok(harness.notifications.some(({ message }) => /Returning to Stage without committing/u.test(message)), JSON.stringify(harness.notifications));
});

test("native confirmations sanitize hostile Git display values while raw argv values still execute", async () => {
  const container = await tempDir("hostile-display");
  const root = path.join(container, "repo\x1b[31m\nname");
  const branch = "main\u202e";
  const remote = "ori\u2066gin";
  const hostileFile = "odd\x1b[2J\u202ename.txt";
  await mkdir(root);
  git(root, "init", "-b", branch);
  git(root, "config", "user.name", "Guided Git TUI Test");
  git(root, "config", "user.email", "guided-git-tui@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-m", "test: initial");
  const bare = await tempDir("hostile-display-remote.git");
  git(bare, "init", "--bare");
  git(root, "remote", "add", remote, bare);
  await writeFile(path.join(root, hostileFile), "hostile display fixture\n");

  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    actionMoves: [0, 0, 0, 0, 0, 0],
    editorValues: ["fix: sanitize confirmation displays"],
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);

  const unsafeDisplay = /\x1b|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
  assert.equal(harness.confirmations.length, 3);
  for (const { title, message } of harness.confirmations) {
    assert.doesNotMatch(title, unsafeDisplay);
    assert.doesNotMatch(message, unsafeDisplay);
  }
  const oid = git(root, "rev-parse", "HEAD");
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), oid, "raw hostile branch and remote argv values must remain intact");
  assert.ok(harness.confirmations.some(({ message }) => message.includes("odd name.txt")), "sanitized filename copy should remain recognizable");
});

test("push shows and confirms the exact local remote, branch, and refspec", async () => {
  const root = await repository("push");
  const bare = await tempDir("push-remote.git");
  git(bare, "init", "--bare");
  git(root, "remote", "add", "origin", bare);
  await stageTracked(root, "push me\n");
  const { commands } = extensionRegistration();
  const harness = createContext(root, { actionMoves: [0, 0, 0, 0, 0, 0], editorValues: ["feat: push exact refspec"] });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  const localHead = git(root, "rev-parse", "HEAD");
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), localHead);
  const pushConfirmation = harness.confirmations.find(({ title }) => title === "Push this exact commit?");
  assert.ok(pushConfirmation);
  assert.match(pushConfirmation.message, new RegExp(`Remote: origin\\nBranch: main\\nRefspec: ${localHead}:refs/heads/main`, "u"));
  assert.doesNotMatch(pushConfirmation.message, /--force/iu);
});

test("push blocks a remote replacement during confirmation and requires a fresh preview", async () => {
  const root = await repository("push-destination-race");
  const origin = await tempDir("push-race-origin.git");
  const backup = await tempDir("push-race-backup.git");
  git(origin, "init", "--bare");
  git(backup, "init", "--bare");
  git(root, "remote", "add", "origin", origin);
  await stageTracked(root, "push destination race\n");
  const { commands } = extensionRegistration();
  let replaced = false;
  const harness = createContext(root, {
    actionMoves: [0, 0, 0, 0, 0, 1],
    editorValues: ["fix: bind push to confirmed destination"],
    confirm(title) {
      if (title === "Push this exact commit?" && !replaced) {
        replaced = true;
        git(root, "remote", "remove", "origin");
        git(root, "remote", "add", "backup", backup);
      }
      return true;
    },
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);

  const createdOid = git(root, "rev-parse", "HEAD");
  for (const remote of [origin, backup]) {
    assert.notEqual(spawnSync("git", ["rev-parse", "refs/heads/main"], { cwd: remote, encoding: "utf8" }).status, 0);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", `${createdOid}^{commit}`], { cwd: remote, encoding: "utf8" }).status, 0);
  }
  assert.equal(harness.confirmations.filter(({ title }) => title === "Push this exact commit?").length, 1);
  assert.ok(harness.notifications.some(({ message }) => /destination changed after confirmation.*No push was attempted/iu.test(message)));
  assert.ok(harness.renders.some(({ normal }) => /Remote: backup/u.test(normal.join("\n"))), "replacement destination must receive a fresh preview");
});

test("multiple remotes require an explicit native selection", async () => {
  const root = await repository("remote-select");
  const origin = await tempDir("origin.git");
  const backup = await tempDir("backup.git");
  git(origin, "init", "--bare");
  git(backup, "init", "--bare");
  git(root, "remote", "add", "origin", origin);
  git(root, "remote", "add", "backup", backup);
  await stageTracked(root);
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    actionMoves: [0, 0, 0, 0, 0, 0, 0],
    editorValues: ["feat: select backup remote"],
  });
  await commands.get(COMMAND_NAME).handler("", harness.ctx);
  const head = git(root, "rev-parse", "HEAD");
  assert.equal(git(backup, "rev-parse", "refs/heads/main"), head, "alphabetically first explicit selection should be backup");
  assert.notEqual(spawnSync("git", ["rev-parse", "refs/heads/main"], { cwd: origin, encoding: "utf8" }).status, 0);
  assert.ok(harness.renders.some(({ normal }) => /A remote will not be chosen silently/u.test(normal.join("\n"))));
});

test("session shutdown settles generation even when the provider ignores abort", async () => {
  const root = await repository("shutdown-non-cooperative");
  await stageTracked(root);
  const { commands, handlers } = extensionRegistration();
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let observedSignal;
  const harness = createContext(root, {
    model: { id: "non-cooperative-model", provider: "test" },
    modelRegistry: {
      async complete(_model, _context, { signal }) {
        observedSignal = signal;
        startedResolve();
        return await new Promise(() => {});
      },
    },
    actionMoves: [0, 0],
  });
  const running = commands.get(COMMAND_NAME).handler("", harness.ctx);
  await started;
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, harness.ctx);
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error("workflow did not settle after shutdown")), 250)),
  ]);
  assert.equal(observedSignal.aborted, true);
});

test("session shutdown aborts direct generation and duplicate invocation is refused", async () => {
  const root = await repository("shutdown");
  await stageTracked(root);
  const { commands, handlers } = extensionRegistration();
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let observedSignal;
  const modelRegistry = {
    async complete(_model, _context, { signal }) {
      observedSignal = signal;
      startedResolve();
      return await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const first = createContext(root, {
    model: { id: "slow-model", provider: "test" },
    modelRegistry,
    actionMoves: [0, 0],
  });
  const running = commands.get(COMMAND_NAME).handler("", first.ctx);
  await started;
  const second = createContext(root, { actionMoves: [] });
  await commands.get(COMMAND_NAME).handler("", second.ctx);
  assert.ok(second.notifications.some(({ message }) => /already active/u.test(message)));
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, first.ctx);
  await running;
  assert.equal(observedSignal.aborted, true);
});

test("native RPC generation invokes the active model directly and writes correlated commit and branch artifacts", async () => {
  const root = await repository("native-rpc-staged");
  await stageTracked(root, "native direct generation\n");
  const calls = [];
  const outputs = [
    "<<<SHORT>>>\nfeat(core): add native generation\n<<<LONG>>>\nfeat(core): add native generation\n- feat: generate validated artifacts directly\n<<<END>>>",
    "<<<BRANCH>>>\nfeat/add-native-generation\n<<<END_BRANCH>>>",
  ];
  const modelRegistry = {
    async complete(model, request, options) {
      calls.push({ model, request, signal: options.signal, maxTokens: options.maxTokens });
      return assistantResponse(outputs.shift());
    },
  };
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "native-model", provider: "private-provider" },
    modelRegistry,
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en required", harness.ctx);
  await commands.get(BRANCH_GENERATION_COMMAND_NAME).handler("", harness.ctx);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model.id, "native-model");
  assert.deepEqual(calls.map(({ maxTokens }) => maxTokens), [COMMIT_OUTPUT_MAX_TOKENS, BRANCH_OUTPUT_MAX_TOKENS]);
  assert.match(calls[0].request.systemPrompt, /English.*Always use a concise lowercase scope/su);
  assert.match(calls[0].request.messages[0].content[0].text, /native direct generation/u);
  assert.equal(calls[0].signal.aborted, true, "the completed command controller is closed after the artifact transaction");
  assert.match(calls[1].request.systemPrompt, /Generate one branch name/u);
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), "feat(core): add native generation\n");
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-long.txt"), "utf8"), "feat(core): add native generation\n- feat: generate validated artifacts directly\n");
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-branch-name.txt"), "utf8"), "feat/add-native-generation\n");
  assert.ok(harness.notifications.some(({ message }) => /sends the required bounded repository content directly to private-provider/u.test(message)));
  assert.ok(harness.notifications.every(({ message }) => !/prompt template|parent-agent tools/u.test(message) || /No parent-agent tools or prompt template are used/u.test(message)));
});

test("WebUI generation uses its configured model without changing the parent session model or thinking level", async () => {
  const root = await repository("native-rpc-isolated-model");
  await stageTracked(root, "isolated generation model\n");
  const parentModel = { id: "parent-session-model", provider: "parent-provider", reasoning: true };
  const generationModel = { id: "git-writing-model", provider: "generation-provider", reasoning: true };
  const calls = [];
  const isolatedOutputs = [validNativeCommitOutput, "<<<BRANCH>>>\nfeat/use-isolated-generation\n<<<END_BRANCH>>>"];
  const provider = {
    streamSimple(model, request, options) {
      calls.push({ model, request, options });
      return { result: async () => assistantResponse(isolatedOutputs.shift()) };
    },
  };
  const modelRegistry = {
    find(providerId, modelId) {
      return providerId === generationModel.provider && modelId === generationModel.id ? generationModel : undefined;
    },
    getProvider(providerId) {
      return providerId === generationModel.provider ? provider : undefined;
    },
    async getApiKeyAndHeaders(model) {
      assert.equal(model, generationModel);
      return { ok: true, apiKey: "fixture-key", headers: { "x-fixture": "guided-git" }, env: { FIXTURE: "1" } };
    },
    async complete() {
      throw new Error("isolated WebUI generation must not use the active-model completion path");
    },
  };
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry,
  });
  const profile = webuiGenerationProfileArgument({
    provider: generationModel.provider,
    modelId: generationModel.id,
    thinkingLevel: "low",
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler(`en auto ${profile}`, harness.ctx);
  await commands.get(BRANCH_GENERATION_COMMAND_NAME).handler(profile, harness.ctx);

  assert.equal(harness.ctx.model, parentModel);
  assert.equal(harness.ctx.thinkingLevel, "high");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ model }) => model === generationModel));
  assert.ok(calls.every(({ options }) => options.reasoning === "low"));
  assert.equal(calls[0].options.apiKey, "fixture-key");
  assert.deepEqual(calls[0].options.headers, { "x-fixture": "guided-git" });
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), "feat(core): handle large staged changes\n");
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-branch-name.txt"), "utf8"), "feat/use-isolated-generation\n");
  assert.ok(harness.notifications.some(({ message }) => /configured generation model/u.test(message)));
});

test("a private WebUI generation profile cannot override the active model in TUI mode", async () => {
  const root = await repository("native-tui-reject-isolated-profile");
  await stageTracked(root, "keep the active TUI model\n");
  const parentModel = { id: "parent-tui-model", provider: "parent-provider", reasoning: true };
  let registryCalls = 0;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "tui",
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry: {
      find() { registryCalls += 1; return { id: "other-model", provider: "other-provider", reasoning: true }; },
      getProvider() { registryCalls += 1; return undefined; },
      async getApiKeyAndHeaders() { registryCalls += 1; return { ok: false, error: "must not authenticate" }; },
      async complete() { registryCalls += 1; throw new Error("must not generate"); },
    },
  });
  const profile = webuiGenerationProfileArgument({ provider: "other-provider", modelId: "other-model", thinkingLevel: "low" });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler(`en auto ${profile}`, harness.ctx);

  assert.equal(registryCalls, 0);
  assert.equal(harness.ctx.model, parentModel);
  assert.equal(harness.ctx.thinkingLevel, "high");
  assert.ok(harness.notifications.some(({ message }) => /WebUI generation profile is invalid/u.test(message)));
  await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));
});

test("session shutdown releases isolated generation ownership when authentication ignores cancellation", async () => {
  const root = await repository("native-rpc-isolated-auth-cancel");
  await stageTracked(root, "cancel isolated authentication\n");
  const generationModel = { id: "isolated-auth-model", provider: "isolated-provider", reasoning: true };
  let authStartedResolve;
  const authStarted = new Promise((resolve) => { authStartedResolve = resolve; });
  let providerCalls = 0;
  const modelRegistry = {
    find(providerId, modelId) {
      return providerId === generationModel.provider && modelId === generationModel.id ? generationModel : undefined;
    },
    getProvider(providerId) {
      if (providerId !== generationModel.provider) return undefined;
      return {
        streamSimple() {
          providerCalls += 1;
          throw new Error("provider must not start after authentication cancellation");
        },
      };
    },
    async getApiKeyAndHeaders() {
      authStartedResolve();
      return await new Promise(() => {});
    },
    async complete() {
      return assistantResponse("<<<BRANCH>>>\nfeat/after-auth-cancel\n<<<END_BRANCH>>>");
    },
  };
  const { commands, handlers } = extensionRegistration();
  const first = createContext(root, {
    mode: "rpc",
    model: { id: "parent-model", provider: "parent-provider" },
    modelRegistry,
  });
  const profile = webuiGenerationProfileArgument({
    provider: generationModel.provider,
    modelId: generationModel.id,
    thinkingLevel: "low",
  });

  const running = commands.get(COMMIT_GENERATION_COMMAND_NAME).handler(`en auto ${profile}`, first.ctx);
  await authStarted;
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, first.ctx);
  await assert.rejects(
    Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error("isolated auth cancellation did not settle")), 250)),
    ]),
    /cancelled/u,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 0);

  const second = createContext(root, {
    mode: "rpc",
    model: { id: "parent-model", provider: "parent-provider" },
    modelRegistry,
  });
  await commands.get(BRANCH_GENERATION_COMMAND_NAME).handler("", second.ctx);
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-branch-name.txt"), "utf8"), "feat/after-auth-cancel\n");
  assert.ok(second.notifications.every(({ message }) => !/generation is already active/u.test(message)));
});

test("native commit RPC analyzes every oversized staged chunk sequentially before one synthesis", async () => {
  const root = await repository("native-rpc-oversized-success");
  await stageTracked(root, oversizedStagedContent);
  const calls = [];
  const outputTokenLimits = [];
  let inFlight = 0;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "large-model", provider: "test-provider" },
    modelRegistry: {
      async complete(_model, request, options) {
        inFlight += 1;
        assert.equal(inFlight, 1, "chunk analysis must remain sequential");
        calls.push(request);
        outputTokenLimits.push(options.maxTokens);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (/Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt)) {
          const evidence = requestEvidence(request);
          return assistantResponse(chunkSummary(`Chunk ${evidence.chunk.index + 1} of ${evidence.chunk.totalChunks} changes tracked content.`));
        }
        assert.match(request.systemPrompt, /ordered chunk summaries/u);
        return assistantResponse(validNativeCommitOutput);
      },
    },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx);

  const chunkCalls = calls.filter((request) => /Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt));
  assert.equal(chunkCalls.length, 3);
  assert.equal(calls.length, chunkCalls.length + 1);
  assert.deepEqual(outputTokenLimits, [
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_OUTPUT_MAX_TOKENS,
  ]);
  assert.deepEqual(chunkCalls.map((request) => requestEvidence(request).chunk.index), [0, 1, 2]);
  assert.deepEqual(chunkCalls.map((request) => requestEvidence(request).chunk.totalChunks), [3, 3, 3]);
  assert.match(calls.at(-1).systemPrompt, /ordered chunk summaries/u);
  const synthesisEvidence = requestEvidence(calls.at(-1));
  assert.equal(synthesisEvidence.chunkCount, 3);
  assert.equal(synthesisEvidence.chunks.some((chunk) => Object.hasOwn(chunk, "diff")), false);
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), "feat(core): handle large staged changes\n");
  assert.ok(harness.notifications.some(({ message }) => /4 model requests.*3 sequential chunk analyses.*one final synthesis/u.test(message)));
  assert.ok(harness.notifications.some(({ message }) => /analyzed 3\/3 chunks.*retained summaries/u.test(message)));
});

test("oversized native commit bounds provider failure and unsafe chunk summaries", async (t) => {
  await t.test("provider failure stops the remaining chunks", async () => {
    const root = await repository("native-rpc-oversized-provider-failure");
    await stageTracked(root, oversizedStagedContent);
    let calls = 0;
    const { commands } = extensionRegistration();
    const harness = createContext(root, {
      mode: "rpc",
      model: { id: "failing-large-model", provider: "test-provider" },
      modelRegistry: {
        async complete(_model, request) {
          calls += 1;
          if (calls === 2) throw new Error("chunk provider unavailable");
          const evidence = requestEvidence(request);
          return assistantResponse(chunkSummary(`Chunk ${evidence.chunk.index + 1} analyzed.`));
        },
      },
    });

    await assert.rejects(
      commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx),
      /FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE: active model generation failed/u,
    );
    assert.equal(calls, 2);
    await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));
    await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-long.txt"), "utf8"));
  });

  await t.test("empty chunk summary stops before synthesis without a formatting retry", async () => {
    const root = await repository("native-rpc-oversized-empty-summary");
    await stageTracked(root, oversizedStagedContent);
    let calls = 0;
    const { commands } = extensionRegistration();
    const harness = createContext(root, {
      mode: "rpc",
      model: { id: "empty-summary-model", provider: "test-provider" },
      modelRegistry: { async complete() { calls += 1; return assistantResponse("  \n"); } },
    });

    await assert.rejects(
      commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx),
      /Generated chunk summary is empty/u,
    );
    assert.equal(calls, 1, "formatting deviations do not trigger a retry");
    await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));
  });
});

test("oversized native commit cancellation between chunks stops without artifacts", async () => {
  const root = await repository("native-tui-oversized-cancel");
  await stageTracked(root, oversizedStagedContent);
  const { commands } = extensionRegistration();
  let calls = 0;
  let secondStartedResolve;
  const secondStarted = new Promise((resolve) => { secondStartedResolve = resolve; });
  const harness = createContext(root, {
    mode: "tui",
    model: { id: "cancel-large-model", provider: "test-provider" },
    modelRegistry: {
      async complete(_model, request, { signal }) {
        calls += 1;
        if (calls === 1) {
          const evidence = requestEvidence(request);
          return assistantResponse(chunkSummary(`Chunk ${evidence.chunk.index + 1} analyzed.`));
        }
        secondStartedResolve();
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    },
    onLoader(component) { void secondStarted.then(() => component.handleInput("\x1b")); },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx);

  assert.equal(calls, 2);
  assert.ok(harness.notifications.some(({ message }) => /git-staged-msg cancelled/u.test(message)));
  await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));
});

test("oversized native commit correction reuses summaries without reanalyzing chunks", async () => {
  const root = await repository("native-rpc-oversized-correction");
  await stageTracked(root, oversizedStagedContent);
  const calls = [];
  const outputTokenLimits = [];
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "repair-large-model", provider: "test-provider" },
    modelRegistry: {
      async complete(_model, request, options) {
        calls.push(request);
        outputTokenLimits.push(options.maxTokens);
        if (/Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt)) {
          const evidence = requestEvidence(request);
          return assistantResponse(chunkSummary(`Chunk ${evidence.chunk.index + 1} analyzed.`));
        }
        if (/single correction request/u.test(request.systemPrompt)) return assistantResponse(validNativeCommitOutput);
        return assistantResponse("   \n");
      },
    },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx);

  assert.equal(calls.length, 5, "three analyses, one synthesis, and one correction are the only requests");
  assert.deepEqual(outputTokenLimits, [
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
    COMMIT_OUTPUT_MAX_TOKENS,
    COMMIT_OUTPUT_MAX_TOKENS,
  ]);
  assert.equal(calls.filter((request) => /Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt)).length, 3);
  assert.match(calls[3].systemPrompt, /ordered chunk summaries/u);
  assert.match(calls[4].systemPrompt, /single correction request.*retained ordered chunk summaries/su);
  const correctionEvidence = requestEvidence(calls[4]);
  assert.equal(correctionEvidence.chunkCount, 3);
  assert.equal(correctionEvidence.chunks.some((chunk) => Object.hasOwn(chunk, "diff")), false);
  assert.equal(correctionEvidence.previousOutput, "   \n");
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), "feat(core): handle large staged changes\n");
});

test("oversized native commit staged drift still blocks artifact installation", async () => {
  const root = await repository("native-rpc-oversized-drift");
  await stageTracked(root, oversizedStagedContent);
  let calls = 0;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "drift-large-model", provider: "test-provider" },
    modelRegistry: {
      async complete(_model, request) {
        calls += 1;
        if (/Summarize only the supplied staged-diff chunk/u.test(request.systemPrompt)) {
          const evidence = requestEvidence(request);
          return assistantResponse(chunkSummary(`Chunk ${evidence.chunk.index + 1} analyzed.`));
        }
        await writeFile(path.join(root, "tracked.txt"), "staged state drifted during synthesis\n");
        git(root, "add", "--", "tracked.txt");
        return assistantResponse(validNativeCommitOutput);
      },
    },
  });

  await assert.rejects(
    commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx),
    /Staged changes changed during generation/u,
  );
  assert.equal(calls, 4);
  await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));
  await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-long.txt"), "utf8"));
});

test("native PR RPC generation writes the encoded branch artifact without prompt fallback", async () => {
  const root = await repository("native-rpc-pr");
  git(root, "switch", "-c", "feat/native-pr");
  await writeFile(path.join(root, "pr.txt"), "pull request content\n");
  git(root, "add", "--", "pr.txt");
  git(root, "commit", "-m", "feat: add pull request content");
  let completeCalls = 0;
  const isolatedCalls = [];
  const parentModel = { id: "native-pr-model", provider: "test-provider" };
  const generationModel = { id: "isolated-pr-model", provider: "isolated-provider", reasoning: true };
  const directBody = "<<<PR_BODY>>>\n## Summary\n\nAdds native pull request generation.\n\n## Verification\n\nVerification was not supplied.\n<<<END_PR_BODY>>>";
  const isolatedBody = "<<<PR_BODY>>>\n## Summary\n\nUses the configured pull request model independently.\n\n## Verification\n\nVerification was not supplied.\n<<<END_PR_BODY>>>";
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry: {
      async complete(_model, request) {
        completeCalls += 1;
        assert.match(request.systemPrompt, /reviewer-focused pull request description in German/u);
        return assistantResponse(directBody);
      },
      find(providerId, modelId) {
        return providerId === generationModel.provider && modelId === generationModel.id ? generationModel : undefined;
      },
      getProvider(providerId) {
        if (providerId !== generationModel.provider) return undefined;
        return {
          streamSimple(model, request, options) {
            isolatedCalls.push({ model, request, options });
            return { result: async () => assistantResponse(isolatedBody) };
          },
        };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "isolated-pr-key" };
      },
    },
  });

  await commands.get(PR_GENERATION_COMMAND_NAME).handler("de", harness.ctx);
  assert.equal(completeCalls, 1);
  assert.equal(
    await readFile(path.join(root, "dev", "PR", "feat%2Fnative-pr.md"), "utf8"),
    "## Summary\n\nAdds native pull request generation.\n\n## Verification\n\nVerification was not supplied.\n",
  );

  const profile = webuiGenerationProfileArgument({
    provider: generationModel.provider,
    modelId: generationModel.id,
    thinkingLevel: "low",
  });
  await commands.get(PR_GENERATION_COMMAND_NAME).handler(`de ${profile}`, harness.ctx);
  assert.equal(isolatedCalls.length, 1);
  assert.equal(isolatedCalls[0].model, generationModel);
  assert.equal(isolatedCalls[0].options.reasoning, "low");
  assert.equal(harness.ctx.model, parentModel);
  assert.equal(harness.ctx.thinkingLevel, "high");
  assert.equal(
    await readFile(path.join(root, "dev", "PR", "feat%2Fnative-pr.md"), "utf8"),
    "## Summary\n\nUses the configured pull request model independently.\n\n## Verification\n\nVerification was not supplied.\n",
  );
  await assert.rejects(readFile(path.join(root, "dev", "PR", "feat", "native-pr.md"), "utf8"));
});

test("Escape cancellation keeps generation ownership until provider work settles", async () => {
  const root = await repository("native-tui-cancel");
  await stageTracked(root);
  const { commands } = extensionRegistration();
  let observedSignal;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let settleCompletion;
  const harness = createContext(root, {
    mode: "tui",
    model: { id: "native-tui-model", provider: "test" },
    modelRegistry: {
      async complete(_model, _request, { signal }) {
        observedSignal = signal;
        startedResolve();
        return await new Promise((_resolve, reject) => { settleCompletion = () => reject(new Error("provider settled after abort")); });
      },
    },
    onLoader(component) { void started.then(() => component.handleInput("\x1b")); },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", harness.ctx);
  assert.equal(observedSignal.aborted, true);
  assert.ok(harness.notifications.some(({ message }) => /git-staged-msg cancelled/u.test(message)));
  await assert.rejects(readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"));

  const conflict = createContext(root, {
    mode: "rpc",
    model: { id: "conflicting-model", provider: "test" },
    modelRegistry: { async complete() { throw new Error("conflicting generation must not start"); } },
  });
  await assert.rejects(
    commands.get(BRANCH_GENERATION_COMMAND_NAME).handler("", conflict.ctx),
    /git-staged-msg generation is already active/u,
  );
  assert.match(conflict.notifications.at(-1).message, /git-staged-msg generation is already active/u);
  settleCompletion();
  await new Promise((resolve) => setImmediate(resolve));
});

test("native commit RPC makes one bounded correction request after empty output", async () => {
  const root = await repository("native-rpc-commit-correction");
  await stageTracked(root, "repair invalid commit type\n");
  const calls = [];
  const outputs = [
    "   \n",
    "<<<SHORT>>>\nfeat(core): add bounded repair\n<<<LONG>>>\nfeat(core): add bounded repair\n- feat: retry invalid output once\n<<<END>>>",
  ];
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "repair-model", provider: "test" },
    modelRegistry: {
      async complete(model, request, options) {
        calls.push({ model, request, signal: options.signal });
        return assistantResponse(outputs.shift());
      },
    },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en required", harness.ctx);

  assert.equal(calls.length, 2, "one invalid output must make exactly one correction request");
  assert.match(calls[0].request.systemPrompt, /currently staged files only/u);
  assert.match(calls[1].request.systemPrompt, /single correction request/u);
  assert.match(calls[1].request.systemPrompt, /feat rather than feature/u);
  const correctionText = calls[1].request.messages[0].content[0].text;
  const correctionJson = correctionText.slice(correctionText.indexOf("\n") + 1, correctionText.lastIndexOf("\n"));
  const correctionEvidence = JSON.parse(correctionJson);
  assert.equal(correctionEvidence.validation.code, "INVALID_GENERATED_OUTPUT");
  assert.match(correctionEvidence.diff, /repair invalid commit type/u);
  assert.equal(correctionEvidence.previousOutput, "   \n");
  assert.ok(harness.notifications.some(({ message, type }) => type === "warning" && /one final correction request/u.test(message)));
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), "feat(core): add bounded repair\n");
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-long.txt"), "utf8"), "feat(core): add bounded repair\n- feat: retry invalid output once\n");
});

test("sub-1 MiB native commit remains one direct request and treats quality rules as guidance", async () => {
  const root = await repository("native-rpc-commit-guidance");
  await stageTracked(root, "accept advisory commit style\n");
  const calls = [];
  const short = `feature: ${"describe the staged changes clearly ".repeat(3)}`;
  const long = `${short}\ndifferent subject\nbody without typed bullets`;
  const { commands } = extensionRegistration();
  const harness = createContext(root, {
    mode: "rpc",
    model: { id: "guidance-model", provider: "test" },
    modelRegistry: {
      async complete(model, request, options) {
        calls.push({ model, request, signal: options.signal });
        return assistantResponse(long);
      },
    },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en required", harness.ctx);

  assert.equal(Array.from(short).length > 72, true);
  assert.equal(calls.length, 1, "sub-1 MiB input and quality deviations must stay on one direct request");
  assert.match(calls[0].request.messages[0].content[0].text, /^<<<UNTRUSTED_STAGED_DIFF_JSON>>>/u);
  assert.doesNotMatch(calls[0].request.systemPrompt, /chunk summaries/u);
  assert.equal(harness.notifications.some(({ type }) => type === "warning"), false);
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-short.txt"), "utf8"), `${short.trim()}\n`);
  assert.equal(await readFile(path.join(root, "dev", "COMMIT", "staged-commit-long.txt"), "utf8"), `${long}\n`);
});

test("RPC exposes fallback eligibility only for direct provider generation failure", async () => {
  const root = await repository("native-rpc-provider-classification");
  await stageTracked(root);
  const { commands } = extensionRegistration();
  let providerCalls = 0;
  const providerFailure = createContext(root, {
    mode: "rpc",
    model: { id: "failing-native-model", provider: "test" },
    modelRegistry: { async complete() { providerCalls += 1; throw new Error("provider unavailable"); } },
  });
  await assert.rejects(
    commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", providerFailure.ctx),
    /FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE: active model generation failed/u,
  );
  assert.equal(providerCalls, 1, "a provider failure must not start output correction");

  let invalidOutputCalls = 0;
  const invalidOutput = createContext(root, {
    mode: "rpc",
    model: { id: "invalid-output-model", provider: "test" },
    modelRegistry: { async complete() { invalidOutputCalls += 1; return assistantResponse("   \n"); } },
  });
  await assert.rejects(
    commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", invalidOutput.ctx),
    (error) => {
      assert.match(error.message, /Generated output must not be empty/u);
      assert.doesNotMatch(error.message, /FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE/u);
      return true;
    },
  );
  assert.equal(invalidOutputCalls, 2, "a second invalid output must fail without a third request");
  assert.match(invalidOutput.notifications.at(-1).message, /Generated output must not be empty/u);
  assert.doesNotMatch(invalidOutput.notifications.at(-1).message, /FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE/u);

  let repairProviderCalls = 0;
  const repairProviderFailure = createContext(root, {
    mode: "rpc",
    model: { id: "repair-provider-failure", provider: "test" },
    modelRegistry: {
      async complete() {
        repairProviderCalls += 1;
        if (repairProviderCalls === 1) return assistantResponse("   \n");
        throw new Error("provider unavailable during correction");
      },
    },
  });
  await assert.rejects(
    commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", repairProviderFailure.ctx),
    /FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE: active model generation failed/u,
  );
  assert.equal(repairProviderCalls, 2);
});

test("native generation validates arguments before model use and session shutdown aborts the only active call", async () => {
  const root = await repository("native-rpc-shutdown");
  await stageTracked(root);
  const { commands, handlers } = extensionRegistration();
  let completeCalls = 0;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let observedSignal;
  const first = createContext(root, {
    mode: "rpc",
    model: { id: "slow-native-model", provider: "test" },
    modelRegistry: {
      async complete(_model, _request, { signal }) {
        completeCalls += 1;
        observedSignal = signal;
        startedResolve();
        return await new Promise(() => {});
      },
    },
  });

  await commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("fr auto", first.ctx);
  assert.equal(completeCalls, 0, "invalid arguments must fail before repository or model work");
  assert.match(first.notifications.at(-1).message, /Usage: \/git-staged-msg/u);

  const running = commands.get(COMMIT_GENERATION_COMMAND_NAME).handler("en auto", first.ctx);
  await started;
  const second = createContext(root, {
    mode: "rpc",
    model: { id: "other", provider: "test" },
    modelRegistry: { async complete() { throw new Error("a conflicting model call must not start"); } },
  });
  await assert.rejects(
    commands.get(BRANCH_GENERATION_COMMAND_NAME).handler("", second.ctx),
    /git-staged-msg generation is already active/u,
  );
  assert.match(second.notifications.at(-1).message, /git-staged-msg generation is already active/u);
  await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, first.ctx);
  await assert.rejects(
    Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("native generation did not settle after shutdown")), 250))]),
    /Generation was cancelled/u,
  );
  assert.equal(observedSignal.aborted, true);
  assert.ok(first.notifications.some(({ message }) => /git-staged-msg cancelled/u.test(message)));
});

test("package metadata and documentation expose only the approved package contract", async () => {
  const root = new URL("../", import.meta.url);
  const [packageRaw, readme, technical, development, catalog] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("TECHNICAL.md", root), "utf8"),
    readFile(new URL("DEVELOPMENT.md", root), "utf8"),
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(packageRaw);
  assert.equal(pkg.name, "@firstpick/pi-extension-git-guided-workflow");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
  assert.equal(pkg.pi.prompts, undefined);
  assert.equal(pkg.dependencies?.["@firstpick/pi-prompts-git-pr"], undefined);
  assert.equal(pkg.bundledDependencies, undefined);
  assert.deepEqual(pkg.files, ["index.ts", "src/core.ts", "src/native-generation.ts", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]);
  assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.match(pkg.description, /TUI and WebUI/u);
  assert.match(readme, /pi install npm:@firstpick\/pi-extension-git-guided-workflow/u);
  assert.match(readme, /only after you select generation or invoke a generation command/u);
  assert.match(readme, /same command asks that WebUI/u);
  assert.match(readme, /\/git-staged-msg/u);
  assert.doesNotMatch(readme, /pi-prompts-git-pr/u);
  assert.match(technical, /1 MiB/u);
  assert.match(technical, /compatible WebUI RPC session/u);
  assert.match(development, /tests\/tui\.test\.mjs/u);
  assert.match(development, /firstpick\.pi-extension-git-guided-workflow\.start/u);
  assert.match(development, /setStatus/u);
  assert.match(development, /src\/native-generation\.ts/u);
  assert.doesNotMatch(`${readme}\n${technical}\n${development}`, /pi-prompts-git-pr/u);
  assert.match(catalog, /pi-extension-git-guided-workflow\/README\.md/u);
  for (const nonGoal of ["Create PR", "branch creation", "repository publication"]) assert.doesNotMatch(readme, new RegExp(nonGoal, "iu"));
});
