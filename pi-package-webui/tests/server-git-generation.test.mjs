import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { writeGitWorkflowPreferences } from "../lib/git-workflow-preferences.mjs";
import { createGitGenerationService } from "../lib/server/git-generation.mjs";

const providerFailure = "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE: fixture provider failed";
const profile = { provider: "fixture", modelId: "writer", thinkingLevel: "low" };
const fallbackProfile = { provider: "fixture", modelId: "backup", thinkingLevel: "high" };
const makeHttpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

async function fixture(t, { fallback = false, overrides = {}, mutations = {}, onPrompt } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "webui-git-generation-"));
  const settingsFile = path.join(root, "settings.json");
  const previousSettingsFile = process.env.PI_WEBUI_SETTINGS_FILE;
  process.env.PI_WEBUI_SETTINGS_FILE = settingsFile;
  t.after(async () => {
    if (previousSettingsFile === undefined) delete process.env.PI_WEBUI_SETTINGS_FILE;
    else process.env.PI_WEBUI_SETTINGS_FILE = previousSettingsFile;
    await rm(root, { recursive: true, force: true });
  });
  await writeGitWorkflowPreferences({
    generation: { ...profile, fallback: fallback ? fallbackProfile : {} },
    commit: { language: "en", scope: "auto" },
  }, settingsFile);
  const paths = {
    shortPath: path.join(root, "dev", "COMMIT", "staged-commit-short.txt"),
    longPath: path.join(root, "dev", "COMMIT", "staged-commit-long.txt"),
    branchPath: path.join(root, "dev", "COMMIT", "staged-branch-name.txt"),
    prPath: path.join(root, "dev", "PR", "topic.md"),
  };
  async function artifact(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  async function messages(short = "feat: fixture", long = "feat: fixture\n\nFixture details.") {
    await artifact(paths.shortPath, short);
    await artifact(paths.longPath, long);
  }
  async function readArtifact(file) {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { path: file, text, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: String(info.ino) };
  }
  const calls = { rpc: [], commands: [], staged: [], activity: [], events: [], replay: [] };
  const tab = {
    id: "tab-fixture", title: "Fixture", cwd: root,
    gitWorkflowGeneration: null,
    gitWorkflowMessageGeneration: null,
    gitWorkflowArtifactGeneration: null,
    gitWorkflowFallbackLifecycle: null,
    lastState: { model: { provider: "session", id: "unchanged" }, thinkingLevel: "medium" },
    rpc: {
      isRunning: () => true,
      async send(request) {
        calls.rpc.push(request);
        return onPrompt ? onPrompt(request, { tab, calls, paths, artifact, messages }) : { success: true };
      },
    },
  };
  const deps = {
    getGitRoot: async () => root,
    gitMutations: {
      assertExpectedStagedContentHash: async (...args) => { calls.staged.push(args); },
      gitWorkflowMessageCwd: (gitRoot, cwd) => cwd,
      commitMessagePaths: (cwd) => {
        assert.equal(cwd, root);
        return paths;
      },
      readGitWorkflowBranchName: async () => readArtifact(paths.branchPath),
      readGitWorkflowPrDescription: async () => readArtifact(paths.prPath),
      ...mutations,
    },
    makeHttpError,
    sanitizeError: (error) => error?.message || String(error),
    safeRpcData: async (...args) => {
      calls.commands.push(args);
      return { ok: true, data: { commands: [
        { name: "git-staged-msg:2", source: "extension" },
        { name: "git-branch-name", source: "extension" },
        { name: "pr", source: "extension" },
      ] } };
    },
    currentSessionState: async () => tab.lastState,
    availableGitWorkflowModels: async () => [
      { provider: profile.provider, id: profile.modelId, reasoning: true },
      { provider: fallbackProfile.provider, id: fallbackProfile.modelId, reasoning: true },
    ],
    stateIsBusyForSettings: () => false,
    markTabWorking: () => calls.activity.push("working"),
    markTabIdle: () => calls.activity.push("idle"),
    broadcastTabEvent: (target, event) => { assert.equal(target, tab); calls.events.push(event); },
    sendSseToClient: (client, event) => calls.replay.push({ client, event }),
    statusRpcTimeoutMs: 1234,
    ...overrides,
  };
  return { root, settingsFile, paths, artifact, messages, tab, calls, service: createGitGenerationService(deps) };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for controlled RPC boundary");
    await delay(5);
  }
}

function decodeProfile(message) {
  return JSON.parse(Buffer.from(message.split("--firstpick-webui-generation-profile=")[1], "base64url").toString("utf8"));
}

test("factory is lazy and exposes only the five generation methods", () => {
  const unexpected = () => assert.fail("factory must not perform work");
  const service = createGitGenerationService({ gitMutations: {}, getGitRoot: unexpected, safeRpcData: unexpected });
  assert.deepEqual(Object.keys(service).sort(), [
    "startGitWorkflowGeneration", "consumeGitWorkflowGenerationEvent", "replayGitWorkflowFallbackLifecycle",
    "cancelGitWorkflowGeneration", "loseGitWorkflowGeneration",
  ].sort());
  assert.equal(service.cancelGitWorkflowGeneration({}), false);
});

test("reservation precedes the first await and cancellation retains ownership until cleanup", async (t) => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { mutations: { assertExpectedStagedContentHash: () => gate.promise } });
  const previous = { id: "previous" };
  f.tab.gitWorkflowMessageGeneration = previous;
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit", expectedStagedContentHash: "approved" });
  const record = f.tab.gitWorkflowGeneration;
  assert.ok(record);
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), { statusCode: 409 });
  assert.equal(f.service.cancelGitWorkflowGeneration(f.tab), true);
  assert.equal(f.tab.gitWorkflowGeneration, record);
  gate.resolve();
  await assert.rejects(pending, { code: "GIT_WORKFLOW_CANCELLED" });
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.equal(f.tab.gitWorkflowMessageGeneration, previous);
  assert.deepEqual(f.calls.rpc, []);
});

test("staged approval and preflight failures release the reservation before dispatch", async (t) => {
  const f = await fixture(t, { mutations: {
    assertExpectedStagedContentHash: async () => { throw makeHttpError(409, "Staged content changed"); },
  } });
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /Staged content changed/);
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.deepEqual(f.calls.commands, []);
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "unknown" }), { statusCode: 400 });
  assert.equal(f.tab.gitWorkflowGeneration, null);
});

test("native commit dispatch uses extension collision suffix, fresh pair and the configured profile", async (t) => {
  const f = await fixture(t, { onPrompt: async (request, { messages }) => {
    await messages();
    return { success: true };
  } });
  const body = { kind: "commit", expectedStagedContentHash: "approved" };
  const state = structuredClone(f.tab.lastState);
  const result = await f.service.startGitWorkflowGeneration(f.tab, body);
  assert.equal(result.accepted, true);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.generation, profile);
  assert.match(result.message, /^\/git-staged-msg:2 en auto /);
  assert.deepEqual(decodeProfile(result.message), { version: 1, ...profile });
  assert.deepEqual(f.calls.staged, [[f.tab, body]]);
  assert.deepEqual(f.calls.commands[0], [f.tab, { type: "get_commands" }, 1234]);
  assert.deepEqual(f.calls.rpc.map((request) => request.type), ["prompt"]);
  assert.deepEqual(f.tab.lastState, state);
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.equal(f.tab.gitWorkflowArtifactGeneration, f.tab.gitWorkflowMessageGeneration);
  assert.equal(f.tab.gitWorkflowArtifactGeneration.terminal, true);
  assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, true);
  assert.deepEqual(f.calls.activity, ["working", "idle"]);
});

test("prompt templates never substitute for the native extension", async (t) => {
  const f = await fixture(t, { overrides: {
    safeRpcData: async () => ({ ok: true, data: { commands: [{ name: "git-staged-msg", source: "prompt" }] } }),
  } });
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /Same-named prompt templates are not used/);
  assert.deepEqual(f.calls.rpc, []);
  assert.equal(f.tab.gitWorkflowGeneration, null);
});

for (const [label, overrides, message] of [
  ["busy session", { stateIsBusyForSettings: () => true }, /current agent run/],
  ["unavailable model", { availableGitWorkflowModels: async () => [] }, /model is unavailable/],
  ["unsupported thinking", { availableGitWorkflowModels: async () => [{ provider: "fixture", id: "writer", reasoning: false }] }, /thinking level low is unavailable/],
]) {
  test(`${label} fails without dispatch or fallback`, async (t) => {
    const f = await fixture(t, { fallback: true, overrides });
    await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), message);
    assert.deepEqual(f.calls.rpc, []);
    assert.deepEqual(f.calls.events, []);
    assert.equal(f.tab.gitWorkflowGeneration, null);
  });
}

for (const kind of ["branch", "pr"]) {
  test(`native ${kind} generation requires a changed correlated artifact`, async (t) => {
    const f = await fixture(t, { onPrompt: async (request, { artifact, paths }) => {
      await artifact(kind === "branch" ? paths.branchPath : paths.prPath, "new generated content");
      return { success: true };
    } });
    await f.artifact(kind === "branch" ? f.paths.branchPath : f.paths.prPath, "previous content");
    const result = await f.service.startGitWorkflowGeneration(f.tab, { kind });
    assert.equal(result.kind, kind);
    assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, true);
    assert.equal(f.tab.gitWorkflowMessageGeneration, null);
    assert.deepEqual(f.calls.events, []);
  });
}

for (const mode of ["unchanged", "partial", "empty", "missing"]) {
  test(`commit readiness rejects ${mode} artifacts and restores the previous message record`, async (t) => {
    const f = await fixture(t, { fallback: true, onPrompt: async (request, { paths, artifact, messages }) => {
      if (mode === "partial") await artifact(paths.shortPath, "new short");
      if (mode === "empty") await messages(" ", "new long");
      return { success: true };
    } });
    if (mode !== "missing") await f.messages("old short", "old long");
    const previous = { id: "previous" };
    f.tab.gitWorkflowMessageGeneration = previous;
    await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /Waiting for/);
    assert.equal(f.calls.rpc.length, 1);
    assert.equal(f.tab.gitWorkflowGeneration, null);
    assert.equal(f.tab.gitWorkflowMessageGeneration, previous);
    assert.equal(f.tab.gitWorkflowArtifactGeneration.terminal, true);
    assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, false);
    assert.deepEqual(f.calls.events, []);
  });
}

test("marked prompt rejection retries once using fallback and preserves the session model", async (t) => {
  const f = await fixture(t, { fallback: true, onPrompt: async (request, { calls, messages }) => {
    if (calls.rpc.length === 1) return { success: false, error: providerFailure };
    await messages();
    return { success: true };
  } });
  const state = structuredClone(f.tab.lastState);
  const result = await f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.generation, fallbackProfile);
  assert.deepEqual(result.primaryGeneration, profile);
  assert.deepEqual(f.calls.rpc.map((request) => decodeProfile(request.message)), [
    { version: 1, ...profile }, { version: 1, ...fallbackProfile },
  ]);
  assert.deepEqual(f.tab.lastState, state);
  assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, true);
  assert.equal(f.calls.events.length, 1);
  const client = {};
  f.service.replayGitWorkflowFallbackLifecycle(f.tab, client);
  assert.deepEqual(f.calls.replay, [{ client, event: { ...f.calls.events[0], replayed: true } }]);
  assert.equal(f.calls.events[0].replayed, undefined);
});

test("double provider failure has bounded replay, error correlation and previous-message cleanup", async (t) => {
  const f = await fixture(t, { fallback: true, onPrompt: async () => ({ success: false, error: `${providerFailure}\nprivate fixture details` }) });
  const previous = { id: "previous" };
  f.tab.gitWorkflowMessageGeneration = previous;
  let error;
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), (value) => {
    error = value;
    return true;
  });
  assert.equal(f.calls.rpc.length, 2);
  assert.deepEqual(error.gitWorkflowGeneration, {
    generationId: f.tab.gitWorkflowFallbackLifecycle.generationId,
    kind: "commit", fallbackUsed: true, generation: fallbackProfile, primaryGeneration: profile,
  });
  assert.equal(f.tab.gitWorkflowMessageGeneration, previous);
  assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, false);
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.deepEqual(f.calls.events.map((event) => event.type), [
    "webui_git_workflow_generation_fallback_started", "webui_git_workflow_generation_fallback_failed",
  ]);
  for (const event of f.calls.events) {
    assert.ok((event.reason || event.error).length <= 240);
    assert.doesNotMatch(event.reason || event.error, /private|\n/);
  }
  f.service.replayGitWorkflowFallbackLifecycle(f.tab, "client");
  assert.equal(f.calls.replay.length, 2);
  assert.ok(f.calls.replay.every(({ event }) => event.replayed));
  assert.equal(f.tab.gitWorkflowFallbackLifecycle.events.length, 2);
});

for (const mode of ["ordinary rejection", "unmarked transport error", "marker text on unmarked transport error"]) {
  test(`${mode} does not authorize fallback`, async (t) => {
    const f = await fixture(t, { fallback: true, onPrompt: async () => {
      if (mode === "ordinary rejection") return { success: false, error: "Command failed" };
      throw new Error(mode === "unmarked transport error" ? "RPC connection failed" : providerFailure);
    } });
    await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }));
    assert.equal(f.calls.rpc.length, 1);
    assert.deepEqual(f.calls.events, []);
    assert.equal(f.tab.gitWorkflowGeneration, null);
  });
}

test("only the matching native command error marks provider fallback eligibility", async (t) => {
  let service;
  const f = await fixture(t, { fallback: true, onPrompt: async (request, { tab, calls, messages }) => {
    if (calls.rpc.length === 1) {
      service.consumeGitWorkflowGenerationEvent(tab, { type: "extension_error", event: "command", extensionPath: "command:other", error: providerFailure });
      assert.equal(tab.gitWorkflowGeneration.nativeCommandError, null);
      service.consumeGitWorkflowGenerationEvent(tab, { type: "extension_error", event: "command", extensionPath: "command:git-staged-msg:2", error: providerFailure });
    } else await messages();
    return { success: true };
  } });
  service = f.service;
  assert.equal((await service.startGitWorkflowGeneration(f.tab, { kind: "commit" })).fallbackUsed, true);
  assert.equal(f.calls.rpc.length, 2);
});

test("late native provider error during the 500ms grace triggers fallback", async (t) => {
  const firstResponse = Promise.withResolvers();
  const f = await fixture(t, { fallback: true, onPrompt: async (request, { calls, messages }) => {
    if (calls.rpc.length === 1) return firstResponse.promise;
    await messages();
    return { success: true };
  } });
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  await waitFor(() => f.calls.rpc.length === 1);
  firstResponse.resolve({ success: true });
  await delay(40);
  f.service.consumeGitWorkflowGenerationEvent(f.tab, {
    type: "extension_error", event: "command", extensionPath: "command:git-staged-msg:2", error: providerFailure,
  });
  assert.equal((await pending).fallbackUsed, true);
  assert.equal(f.calls.rpc.length, 2);
});

for (const mode of ["cancel", "process loss"]) {
  test(`${mode} during RPC prevents fallback and preserves a replacement reservation`, async (t) => {
    const response = Promise.withResolvers();
    const f = await fixture(t, { fallback: true, onPrompt: () => response.promise });
    const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
    await waitFor(() => f.calls.rpc.length === 1);
    const old = f.tab.gitWorkflowGeneration;
    const artifactGeneration = f.tab.gitWorkflowArtifactGeneration;
    if (mode === "cancel") f.service.cancelGitWorkflowGeneration(f.tab);
    else {
      f.service.loseGitWorkflowGeneration(f.tab);
      assert.equal(old.processLost, true);
      assert.equal(artifactGeneration.terminal, true);
      assert.equal(artifactGeneration.successful, false);
      assert.equal(f.tab.gitWorkflowMessageGeneration, null);
    }
    const replacement = { generationId: "replacement" };
    const message = { id: "replacement-message" };
    f.tab.gitWorkflowGeneration = replacement;
    f.tab.gitWorkflowMessageGeneration = message;
    const activityBefore = [...f.calls.activity];
    response.resolve({ success: false, error: providerFailure });
    await assert.rejects(pending, (error) => {
      assert.match(error.message, /no longer active/);
      assert.equal(error.gitWorkflowGeneration, undefined);
      return true;
    });
    assert.equal(f.tab.gitWorkflowGeneration, replacement);
    assert.equal(f.tab.gitWorkflowMessageGeneration, message);
    assert.deepEqual(f.calls.activity, activityBefore);
    assert.deepEqual(f.calls.events, []);
    assert.equal(f.calls.rpc.length, 1);
  });
}

test("cancellation while artifacts are pending restores the previous message generation", async (t) => {
  const response = Promise.withResolvers();
  const f = await fixture(t, { fallback: true, onPrompt: () => response.promise });
  const previous = { id: "previous" };
  f.tab.gitWorkflowMessageGeneration = previous;
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  await waitFor(() => f.calls.rpc.length === 1);
  f.service.cancelGitWorkflowGeneration(f.tab);
  response.resolve({ success: false, error: providerFailure });
  await assert.rejects(pending, { code: "GIT_WORKFLOW_CANCELLED" });
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.equal(f.tab.gitWorkflowMessageGeneration, previous);
  assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, false);
  assert.deepEqual(f.calls.events, []);
});

test("process loss during preflight cannot mutate the next generation", async (t) => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { mutations: { assertExpectedStagedContentHash: () => gate.promise } });
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  const old = f.tab.gitWorkflowGeneration;
  f.service.loseGitWorkflowGeneration(f.tab);
  const replacement = { generationId: "replacement" };
  f.tab.gitWorkflowGeneration = replacement;
  gate.resolve();
  await assert.rejects(pending, /no longer active/);
  assert.equal(old.processLost, true);
  assert.equal(f.tab.gitWorkflowGeneration, replacement);
  assert.deepEqual(f.calls.activity, []);
});

for (const { finalError, aborted } of [
  { finalError: false, aborted: false },
  { finalError: true, aborted: false },
  { finalError: false, aborted: true },
]) {
  test(`settlement consumes only a started attempt, failure=${finalError}, aborted=${aborted}`, async (t) => {
    const f = await fixture(t);
    const previous = { id: "previous" };
    const artifactGeneration = { id: "event-generation", terminal: false, successful: false };
    const record = {
      generationId: artifactGeneration.id, attempt: "primary", promptAccepted: true,
      artifactGeneration, messageGeneration: artifactGeneration, previousMessageGeneration: previous,
      fallback: { ...fallbackProfile }, cancelled: false,
    };
    f.tab.gitWorkflowGeneration = record;
    f.tab.gitWorkflowArtifactGeneration = artifactGeneration;
    f.tab.gitWorkflowMessageGeneration = artifactGeneration;
    f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_settled" });
    assert.equal(f.tab.gitWorkflowGeneration, record);
    f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_start" });
    f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_settled", aborted }, { finalError });
    await waitFor(() => f.tab.gitWorkflowGeneration === null);
    assert.equal(artifactGeneration.terminal, true);
    assert.equal(artifactGeneration.successful, !finalError && !aborted);
    assert.equal(f.tab.gitWorkflowMessageGeneration, finalError || aborted ? previous : artifactGeneration);
    assert.deepEqual(f.calls.events, []);
    assert.deepEqual(f.calls.rpc, []);
  });
}

test("an early settlement is retained until prompt acceptance and abort marks cancellation", async (t) => {
  const response = Promise.withResolvers();
  const f = await fixture(t, { onPrompt: () => response.promise });
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  await waitFor(() => f.calls.rpc.length === 1);
  const record = f.tab.gitWorkflowGeneration;
  f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_start" });
  f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_settled" }, { finalError: true });
  assert.deepEqual(record.pendingSettlement, { attempt: "primary", failed: true, cancelled: false });
  assert.equal(f.tab.gitWorkflowGeneration, record);
  f.service.consumeGitWorkflowGenerationEvent(f.tab, { type: "agent_end", aborted: true });
  assert.equal(record.cancelled, true);
  response.resolve({ success: true });
  await assert.rejects(pending, { code: "GIT_WORKFLOW_CANCELLED" });
  assert.equal(f.tab.gitWorkflowGeneration, null);
});

for (const mode of ["cancel", "process loss"]) {
  test(`${mode} during fallback suppresses terminal fallback reporting and correlation`, async (t) => {
    const response = Promise.withResolvers();
    const f = await fixture(t, { fallback: true, onPrompt: async (request, { calls }) => {
      if (calls.rpc.length === 1) return { success: false, error: providerFailure };
      return response.promise;
    } });
    const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
    await waitFor(() => f.calls.rpc.length === 2);
    if (mode === "cancel") f.service.cancelGitWorkflowGeneration(f.tab);
    else f.service.loseGitWorkflowGeneration(f.tab);
    response.resolve({ success: false, error: providerFailure });
    await assert.rejects(pending, (error) => {
      assert.match(error.message, mode === "cancel" ? /cancelled/ : /no longer active/);
      assert.equal(error.gitWorkflowGeneration, undefined);
      return true;
    });
    assert.equal(f.tab.gitWorkflowGeneration, null);
    assert.equal(f.calls.events.length, 1);
    assert.equal(f.calls.events[0].type, "webui_git_workflow_generation_fallback_started");
  });
}

test("ownership is rechecked after asynchronous artifact readiness", async (t) => {
  const readiness = Promise.withResolvers();
  let reads = 0;
  const f = await fixture(t, { mutations: {
    readGitWorkflowBranchName: async () => {
      reads += 1;
      if (reads === 1) return { path: "branch", mtimeMs: 1, ctimeMs: 1, ino: "1" };
      return readiness.promise;
    },
  } });
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "branch" });
  await waitFor(() => reads === 2);
  f.service.loseGitWorkflowGeneration(f.tab);
  const replacement = { generationId: "replacement" };
  f.tab.gitWorkflowGeneration = replacement;
  const activity = [...f.calls.activity];
  readiness.resolve({ path: "branch", mtimeMs: 2, ctimeMs: 2, ino: "1" });
  await assert.rejects(pending, /no longer active/);
  assert.equal(f.tab.gitWorkflowGeneration, replacement);
  assert.deepEqual(f.calls.activity, activity);
});

test("ownership is rechecked after the native command error grace", async (t) => {
  const response = Promise.withResolvers();
  const f = await fixture(t, { fallback: true, onPrompt: () => response.promise });
  const pending = f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  await waitFor(() => f.calls.rpc.length === 1);
  response.resolve({ success: true });
  await delay(40);
  f.service.loseGitWorkflowGeneration(f.tab);
  const replacement = { generationId: "replacement" };
  f.tab.gitWorkflowGeneration = replacement;
  const activity = [...f.calls.activity];
  await assert.rejects(pending, /no longer active/);
  assert.equal(f.tab.gitWorkflowGeneration, replacement);
  assert.deepEqual(f.calls.activity, activity);
  assert.deepEqual(f.calls.events, []);
});

for (const kind of ["branch", "pr"]) {
  test(`unchanged ${kind} artifacts fail readiness without provider fallback`, async (t) => {
    const f = await fixture(t, { fallback: true });
    await f.artifact(kind === "branch" ? f.paths.branchPath : f.paths.prPath, "unchanged");
    await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind }), /did not update its correlated artifact/);
    assert.equal(f.tab.gitWorkflowGeneration, null);
    assert.equal(f.tab.gitWorkflowArtifactGeneration.successful, false);
    assert.equal(f.calls.rpc.length, 1);
    assert.deepEqual(f.calls.events, []);
  });
}

test("unmarked native command error never starts fallback", async (t) => {
  let service;
  const f = await fixture(t, { fallback: true, onPrompt: async (request, { tab }) => {
    service.consumeGitWorkflowGenerationEvent(tab, {
      type: "extension_error", event: "command", extensionPath: "command:git-staged-msg:2", error: "Permission denied writing artifact",
    });
    return { success: true };
  } });
  service = f.service;
  await assert.rejects(service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /Permission denied/);
  assert.equal(f.calls.rpc.length, 1);
  assert.deepEqual(f.calls.events, []);
});

test("a stopped RPC process and incomplete setup fail before prompting", async (t) => {
  const f = await fixture(t);
  f.tab.rpc.isRunning = () => false;
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /process is not running/);
  assert.equal(f.tab.gitWorkflowGeneration, null);
  f.tab.rpc.isRunning = () => true;
  await writeGitWorkflowPreferences({ generation: { provider: "", modelId: "" } }, f.settingsFile);
  await assert.rejects(f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" }), /Guided Git Setup/);
  assert.equal(f.tab.gitWorkflowGeneration, null);
  assert.deepEqual(f.calls.rpc, []);
});

test("non-repository commit artifacts use the tab cwd and a new generation replaces replay", async (t) => {
  const f = await fixture(t, { overrides: { getGitRoot: async () => { throw new Error("not a repository"); } }, onPrompt: async (request, { messages }) => {
    await messages();
    return { success: true };
  } });
  f.tab.gitWorkflowFallbackLifecycle = { generationId: "previous", events: [{ type: "old" }] };
  const result = await f.service.startGitWorkflowGeneration(f.tab, { kind: "commit" });
  assert.equal(f.tab.gitWorkflowArtifactGeneration.root, f.root);
  assert.equal(f.tab.gitWorkflowFallbackLifecycle.generationId, result.generationId);
  f.service.replayGitWorkflowFallbackLifecycle(f.tab, "new client");
  assert.deepEqual(f.calls.replay, []);
});
