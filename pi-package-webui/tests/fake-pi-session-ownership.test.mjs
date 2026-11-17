import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const defaultModel = { provider: "fake", id: "fake-model" };
const alternateModel = { provider: "fake", id: "fake-model-alt" };
const catalog = [
  { ...defaultModel, name: "Fake Model" },
  { ...alternateModel, name: "Fake Alternate Model" },
];

function startFixture(t, { env = {}, args = [], cwd = tmpdir() } = {}) {
  // Ambient fixture flags must not turn a compatibility check into another mode.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FAKE_PI_")));
  const child = spawn(process.execPath, [fixture, ...args], {
    cwd,
    env: { ...cleanEnv, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const records = [];
  let nextId = 0;
  let failure;
  let stderr = "";
  const fail = (error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr = (stderr + text).slice(-8192);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      assert.ok(records.length < 200, "fixture output exceeded the test bound");
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === "response") {
        const request = pending.get(record.id);
        assert.ok(request, `unexpected response ${record.id}`);
        assert.equal(record.command, request.type);
        pending.delete(record.id);
        request.resolve(record);
      }
    } catch (error) {
      fail(error);
      child.kill("SIGKILL");
    }
  });
  const exited = new Promise((resolveExit) => {
    child.once("close", (code, signal) => {
      fail(new Error(`fixture closed: code=${code}, signal=${signal}, stderr=${stderr}`));
      resolveExit({ code, signal });
    });
  });
  let closing;
  const close = () => {
    closing ||= (async () => {
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 1500);
      child.stdin.end();
      try {
        const result = await exited;
        assert.equal(forced, false, "fixture did not exit after stdin closed");
        assert.deepEqual(result, { code: 0, signal: null }, stderr);
        assert.equal(stderr, "");
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    })();
    return closing;
  };
  t.after(close);
  return {
    records,
    close,
    request(type, data = {}) {
      if (failure) return Promise.reject(failure);
      const id = `request-${++nextId}`;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`fixture timed out on ${type}: ${stderr}`));
        }, 2000);
        pending.set(id, {
          type,
          resolve: (reply) => {
            clearTimeout(timer);
            resolveReply(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ ...data, id, type })}\n`);
      });
    },
  };
}

async function state(driver) {
  const reply = await driver.request("get_state");
  assert.equal(reply.success, true);
  return reply.data;
}

async function selectModel(driver, model) {
  const reply = await driver.request("set_model", { provider: model.provider, modelId: model.id });
  assert.equal(reply.success, true);
  assert.deepEqual(reply.data, model);
}

test("ownership catalog is deterministic and successful models survive rejection", { timeout: 10_000 }, async (t) => {
  const driver = startFixture(t, { env: { FAKE_PI_SESSION_OWNERSHIP: "1" } });
  assert.deepEqual((await state(driver)).model, defaultModel);
  assert.deepEqual((await driver.request("get_available_models")).data, { models: catalog });
  for (const model of [alternateModel, defaultModel, alternateModel]) {
    await selectModel(driver, model);
    assert.deepEqual((await state(driver)).model, model);
  }
  const rejected = await driver.request("set_model", { provider: "fake", modelId: "missing-model" });
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "Model not found: fake/missing-model");
  assert.deepEqual((await state(driver)).model, alternateModel);
  assert.deepEqual((await driver.request("get_available_models")).data, { models: catalog });
  const customModel = { provider: "custom-fake", id: "custom-model" };
  await selectModel(driver, customModel);
  assert.deepEqual((await state(driver)).model, customModel);
});

test("processes own distinct sessions and new sessions preserve models and peers", { timeout: 10_000 }, async (t) => {
  const first = startFixture(t, { env: { FAKE_PI_SESSION_OWNERSHIP: "1" } });
  const second = startFixture(t, { env: { FAKE_PI_SESSION_OWNERSHIP: "1" } });
  const initialFirst = await state(first);
  const initialSecond = await state(second);
  assert.notEqual(initialFirst.sessionId, initialSecond.sessionId);
  assert.match(initialFirst.sessionId, /^fake-session-.+/);
  assert.equal(initialFirst.sessionFile, undefined);
  assert.equal(initialSecond.sessionFile, undefined);
  await selectModel(first, alternateModel);
  assert.deepEqual(await state(second), initialSecond);
  const ids = new Set([initialFirst.sessionId, initialSecond.sessionId]);
  for (let generation = 0; generation < 2; generation += 1) {
    const reply = await first.request("new_session");
    assert.equal(reply.success, true);
    assert.deepEqual(reply.data, {});
    const current = await state(first);
    assert.equal(ids.has(current.sessionId), false);
    ids.add(current.sessionId);
    assert.deepEqual(current.model, alternateModel);
    assert.equal(current.sessionFile, undefined);
    assert.equal((await state(first)).sessionId, current.sessionId);
    assert.deepEqual(await state(second), initialSecond);
  }
});

test("explicit and continuity paths share stable normalized identities without session files", { timeout: 15_000 }, async (t) => {
  const relativePath = `fake-pi-ownership-${randomUUID()}/../fake-pi-${randomUUID()}.jsonl`;
  const absolutePath = resolve(tmpdir(), relativePath);
  const explicit = startFixture(t, {
    args: ["--session", relativePath],
    env: { FAKE_PI_SESSION_OWNERSHIP: "1" },
  });
  const initial = await state(explicit);
  assert.equal(initial.sessionFile, relativePath);
  const samePath = startFixture(t, {
    cwd: process.cwd(),
    args: ["--session", absolutePath],
    env: {
      FAKE_PI_SESSION_OWNERSHIP: "1",
      FAKE_PI_CONTINUITY_MODE: "1",
      FAKE_PI_CONTINUITY_SESSION_FILE: `${absolutePath}.ignored`,
    },
  });
  assert.equal((await state(samePath)).sessionId, initial.sessionId);
  assert.equal((await state(samePath)).sessionFile, absolutePath);
  const continuity = startFixture(t, {
    env: { FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_CONTINUITY_MODE: "1", FAKE_PI_CONTINUITY_SESSION_FILE: absolutePath },
  });
  assert.equal((await state(continuity)).sessionId, initial.sessionId);
  const differentPath = startFixture(t, {
    args: ["--session", `${absolutePath}.other`],
    env: { FAKE_PI_SESSION_OWNERSHIP: "1" },
  });
  assert.notEqual((await state(differentPath)).sessionId, initial.sessionId);
  await selectModel(explicit, alternateModel);
  await explicit.request("new_session");
  const renewed = await state(explicit);
  assert.notEqual(renewed.sessionId, initial.sessionId);
  assert.deepEqual(renewed.model, alternateModel);
  assert.equal((await state(samePath)).sessionId, initial.sessionId);
  assert.deepEqual((await state(samePath)).model, defaultModel);
  const restarted = startFixture(t, {
    args: ["--session", absolutePath],
    env: { FAKE_PI_SESSION_OWNERSHIP: "1" },
  });
  assert.equal((await state(restarted)).sessionId, initial.sessionId);
  assert.deepEqual((await state(restarted)).model, defaultModel);
});

test("continuity path is ignored unless continuity mode is enabled", { timeout: 10_000 }, async (t) => {
  const env = { FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_CONTINUITY_SESSION_FILE: "ignored.jsonl" };
  const first = await state(startFixture(t, { env }));
  const second = await state(startFixture(t, { env }));
  assert.equal(first.sessionFile, undefined);
  assert.equal(second.sessionFile, undefined);
  assert.notEqual(first.sessionId, second.sessionId);
});

test("unflagged explicit and continuity paths keep their original reply shapes", { timeout: 10_000 }, async (t) => {
  const sessionFile = "./unresolved/../fake-session.jsonl";
  const explicit = startFixture(t, { args: ["--session", sessionFile] });
  const continuity = startFixture(t, {
    env: { FAKE_PI_CONTINUITY_MODE: "1", FAKE_PI_CONTINUITY_SESSION_FILE: sessionFile },
  });
  for (const driver of [explicit, continuity]) {
    const initial = await state(driver);
    assert.equal(initial.sessionFile, sessionFile);
    assert.equal(initial.sessionId, "fake-session");
    await driver.request("new_session");
    assert.deepEqual(await state(driver), initial);
  }
});

for (const flag of [undefined, "0", "true"]) {
  test(`ownership is default off for ${String(flag)} and preserves baseline replies`, { timeout: 10_000 }, async (t) => {
    const driver = startFixture(t, { env: flag === undefined ? {} : { FAKE_PI_SESSION_OWNERSHIP: flag } });
    const baseline = {
      model: defaultModel,
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionId: "fake-session",
      sessionName: "fake",
      autoCompactionEnabled: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
    assert.deepEqual(await state(driver), baseline);
    assert.deepEqual((await driver.request("get_available_models")).data, { models: [catalog[0]] });
    await selectModel(driver, alternateModel);
    assert.deepEqual(await state(driver), baseline);
    assert.equal((await driver.request("set_model", { provider: "fake", modelId: "missing-model" })).success, false);
    assert.deepEqual((await driver.request("new_session")).data, {});
    assert.deepEqual(await state(driver), baseline);
    assert.deepEqual((await driver.request("prompt", { message: "normal baseline prompt" })).data, { output: "fake prompt accepted" });
    assert.deepEqual((await driver.request("get_messages")).data.messages, [
      { role: "user", content: "fake prompt", timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "fake answer" }], timestamp: 2000 },
      { role: "user", content: "fake follow-up", timestamp: 3000 },
    ]);
    assert.ok(driver.records.every((record) => record.type === "response"));
  });
}

for (const enabled of [false, true]) {
  test(`Codex model retains precedence with ownership ${enabled}`, { timeout: 10_000 }, async (t) => {
    const driver = startFixture(t, { env: enabled ? { FAKE_PI_SESSION_OWNERSHIP: "1" } : {} });
    await selectModel(driver, alternateModel);
    await driver.request("prompt", { message: "fixture codex astra" });
    const codexModel = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
    assert.deepEqual((await state(driver)).model, codexModel);
    await selectModel(driver, defaultModel);
    await selectModel(driver, alternateModel);
    await driver.request("new_session");
    assert.deepEqual((await state(driver)).model, codexModel);
    await driver.request("prompt", { message: "fixture codex reset" });
    assert.deepEqual((await state(driver)).model, enabled ? alternateModel : defaultModel);
    assert.deepEqual(driver.records.filter((record) => record.type !== "response").map((record) => record.type), [
      "agent_start", "agent_settled", "agent_start", "agent_settled",
    ]);
  });
}

for (const enabled of [false, true]) {
  test(`stdin close cancels pending scripted voice events with ownership ${enabled}`, { timeout: 10_000 }, async (t) => {
    const driver = startFixture(t, {
      env: { FAKE_PI_VOICE_SCRIPTS: "1", ...(enabled ? { FAKE_PI_SESSION_OWNERSHIP: "1" } : {}) },
    });
    assert.deepEqual((await driver.request("prompt", { message: "voice test slow" })).data, { output: "voice scripted prompt accepted" });
    assert.equal((await state(driver)).isStreaming, true);
    await driver.close();
    assert.equal(driver.records.some((record) => record.type === "agent_settled"), false);
  });
}
