import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexFastModeExtension, {
  FAST_MODE_SERVICE_TIER,
  FAST_MODE_STATE_ENTRY_TYPE,
  FAST_MODE_STATUS_KEY,
  ULTRAFAST_MODE_MODEL_ID,
  ULTRAFAST_MODE_NOTICE,
  ULTRAFAST_MODE_SERVICE_TIER,
  fastModeArgumentCompletions,
  isFastModeEligibleModel,
  isUltrafastModeEligibleModel,
  isPlainObject,
  parseFastModeCommand,
  reconstructFastModeState,
  transformFastModeRequest,
} from "../index.ts";

type StatusUpdate = { key: string; value: string | undefined };
type Notification = { message: string; level: string };
type Handler = (event: any, ctx: any) => unknown;

function createHarness(options: { entries?: unknown[]; busy?: boolean; pending?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const entries = options.entries ?? [];
  const statusUpdates: StatusUpdate[] = [];
  const notifications: Notification[] = [];
  const appendCalls: Array<{ customType: string; data: unknown }> = [];
  let busy = options.busy ?? false;
  let pending = options.pending ?? false;

  const context = {
    model: { provider: "openai-codex", api: "openai-codex-responses", id: ULTRAFAST_MODE_MODEL_ID },
    sessionManager: { getBranch: () => entries },
    isIdle: () => !busy,
    hasPendingMessages: () => pending,
    ui: {
      setStatus(key: string, value: string | undefined) {
        statusUpdates.push({ key, value });
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;

  codexFastModeExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      appendCalls.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI);

  return {
    appendCalls,
    commands,
    context,
    entries,
    handlers,
    notifications,
    setBusy(value: boolean) { busy = value; },
    setPending(value: boolean) { pending = value; },
    statusUpdates,
  };
}

test("plain-object guard excludes malformed payloads", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject("payload"), false);
});

test("provider eligibility is exact", () => {
  assert.equal(isFastModeEligibleModel({ provider: "openai-codex", api: "openai-codex-responses" }), true);
  assert.equal(isFastModeEligibleModel({ provider: "openai", api: "openai-codex-responses" }), false);
  assert.equal(isFastModeEligibleModel({ provider: "openai-codex", api: "openai-responses" }), false);
  assert.equal(isFastModeEligibleModel(undefined), false);
});

test("request transformer is isolated, non-mutating, and overwrites only service_tier", () => {
  const payload = { model: "gpt-5.6-codex", service_tier: "default", nested: { preserved: true } };
  const transformed = transformFastModeRequest(true, { provider: "openai-codex", api: "openai-codex-responses" }, payload);

  assert.deepEqual(transformed, {
    model: "gpt-5.6-codex",
    service_tier: FAST_MODE_SERVICE_TIER,
    nested: { preserved: true },
  });
  assert.notStrictEqual(transformed, payload);
  assert.strictEqual(transformed?.nested, payload.nested);
  assert.equal(payload.service_tier, "default");
  assert.equal(transformFastModeRequest(false, { provider: "openai-codex", api: "openai-codex-responses" }, payload), undefined);
  assert.equal(transformFastModeRequest(true, { provider: "openai", api: "openai-codex-responses" }, payload), undefined);
  assert.equal(transformFastModeRequest(true, { provider: "openai-codex", api: "openai-codex-responses" }, []), undefined);
});

test("branch reconstruction uses the latest valid custom snapshot and defaults off", () => {
  assert.deepEqual(reconstructFastModeState([]), { mode: "normal" });
  assert.deepEqual(reconstructFastModeState([
    { type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: true } },
    { type: "custom", customType: "other", data: { enabled: false } },
    { type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: "invalid" } },
    { type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: false } },
  ]), { mode: "normal" });
});

test("command grammar and completions are deterministic", () => {
  assert.equal(parseFastModeCommand(""), "toggle");
  assert.equal(parseFastModeCommand(" ON "), "on");
  assert.equal(parseFastModeCommand("off"), "off");
  assert.equal(parseFastModeCommand("status"), "status");
  assert.equal(parseFastModeCommand("on now"), "invalid");
  assert.deepEqual(fastModeArgumentCompletions("o"), [
    { value: "on", label: "on" },
    { value: "off", label: "off" },
  ]);
  assert.deepEqual(fastModeArgumentCompletions("status"), [{ value: "status", label: "status" }]);
});

test("extension restores state, publishes concise status, and persists successful mutations", async () => {
  const harness = createHarness({
    entries: [{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: true } }],
  });
  const sessionStart = harness.handlers.get("session_start");
  const request = harness.handlers.get("before_provider_request");
  const command = harness.commands.get("fast-mode");
  assert.ok(sessionStart && request && command);

  sessionStart!({}, harness.context as unknown as ExtensionContext);
  assert.deepEqual(harness.statusUpdates.at(-1), { key: FAST_MODE_STATUS_KEY, value: "on" });
  assert.deepEqual(request!({ payload: { service_tier: "standard", keep: true } }, harness.context), {
    service_tier: FAST_MODE_SERVICE_TIER,
    keep: true,
  });

  await command.handler("off", harness.context);
  assert.deepEqual(harness.appendCalls, [{ customType: FAST_MODE_STATE_ENTRY_TYPE, data: { mode: "normal", enabled: false } }]);
  assert.deepEqual(harness.statusUpdates.at(-1), { key: FAST_MODE_STATUS_KEY, value: "off" });
  assert.equal(request!({ payload: { keep: true } }, harness.context), undefined);

  await command.handler("status", harness.context);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Fast mode: off/u);
  assert.equal(harness.notifications.at(-1)?.level, "info");
});

test("extension rejects every mutation while busy but leaves status readable", async () => {
  const harness = createHarness({ busy: true });
  const sessionStart = harness.handlers.get("session_start");
  const command = harness.commands.get("fast-mode");
  assert.ok(sessionStart && command);
  sessionStart!({}, harness.context as unknown as ExtensionContext);

  for (const args of ["on", "", "off", "normal", "fast", "ultrafast"]) {
    await command.handler(args, harness.context);
  }
  assert.equal(harness.appendCalls.length, 0);
  assert.equal(harness.notifications.filter((item) => item.level === "warning").length, 6);

  await command.handler("status", harness.context);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Fast mode: off/u);
  assert.equal(harness.notifications.at(-1)?.level, "info");

  harness.setBusy(false);
  harness.setPending(true);
  for (const args of ["on", "", "off", "normal", "fast", "ultrafast"]) {
    await command.handler(args, harness.context);
  }
  assert.equal(harness.appendCalls.length, 0);
});

test("tree navigation reconstructs the active branch state", () => {
  const harness = createHarness({
    entries: [{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: true } }],
  });
  const sessionStart = harness.handlers.get("session_start");
  const sessionTree = harness.handlers.get("session_tree");
  assert.ok(sessionStart && sessionTree);

  sessionStart!({}, harness.context as unknown as ExtensionContext);
  harness.entries.push({ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: false } });
  sessionTree!({}, harness.context as unknown as ExtensionContext);
  assert.deepEqual(harness.statusUpdates.at(-1), { key: FAST_MODE_STATUS_KEY, value: "off" });
});

test("Ultrafast eligibility requires the exact Codex provider, API, and Astra model", () => {
  const astra = { provider: "openai-codex", api: "openai-codex-responses", id: ULTRAFAST_MODE_MODEL_ID };
  assert.equal(isUltrafastModeEligibleModel(astra), true);
  for (const model of [undefined, { ...astra, id: "gpt-5.6-sol" }, { ...astra, id: undefined },
    { ...astra, provider: "openai" }, { ...astra, api: "openai-responses" }]) {
    assert.equal(isUltrafastModeEligibleModel(model), false);
  }
});

test("Ultrafast rewrites only matching Astra requests without mutation or downgrade", () => {
  const astra = { provider: "openai-codex", api: "openai-codex-responses", id: ULTRAFAST_MODE_MODEL_ID };
  const payload = Object.freeze({ model: ULTRAFAST_MODE_MODEL_ID, service_tier: "priority", nested: { keep: true } });
  const transformed = transformFastModeRequest("ultrafast", astra, payload);
  assert.deepEqual(transformed, { ...payload, service_tier: ULTRAFAST_MODE_SERVICE_TIER });
  assert.notStrictEqual(transformed, payload);
  assert.strictEqual(transformed?.nested, payload.nested);
  assert.equal(payload.service_tier, "priority");
  for (const model of [undefined, { ...astra, id: "gpt-5.6-sol" }, { ...astra, provider: "openai" },
    { ...astra, api: "openai-responses" }]) {
    assert.equal(transformFastModeRequest("ultrafast", model, payload), undefined);
  }
  for (const other of [null, [], "payload", new Date(), {}, { ...payload, model: "gpt-6-sol" }]) {
    assert.equal(transformFastModeRequest("ultrafast", astra, other), undefined);
  }
  assert.equal(transformFastModeRequest("normal", astra, payload), undefined);
  assert.equal(transformFastModeRequest("invalid" as any, astra, payload), undefined);
  assert.equal(transformFastModeRequest("fast", astra, payload)?.service_tier, FAST_MODE_SERVICE_TIER);
});

test("mode snapshots migrate legacy booleans and ignore malformed new states", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data });
  assert.deepEqual(reconstructFastModeState([entry({ enabled: true })]), { mode: "fast" });
  assert.deepEqual(reconstructFastModeState([entry({ enabled: true }), entry({ mode: "ultrafast", enabled: true })]), { mode: "ultrafast" });
  assert.deepEqual(reconstructFastModeState([
    entry({ mode: "ultrafast" }), entry({ mode: "bad", enabled: false }), entry({ mode: null, enabled: false }),
    entry({ mode: undefined, enabled: false }), entry(null), entry([]),
  ]), { mode: "ultrafast" });
  assert.deepEqual(reconstructFastModeState([entry({ mode: "ultrafast" }), entry({ enabled: false })]), { mode: "normal" });
  assert.deepEqual(reconstructFastModeState([entry({ mode: "normal", enabled: true })]), { mode: "normal" });
  assert.deepEqual(reconstructFastModeState([entry({ mode: "ultrafast" }), entry({ mode: "fast" })]), { mode: "fast" });
});

test("explicit modes parse and complete without accepting extra arguments", () => {
  for (const mode of ["normal", "fast", "ultrafast"]) {
    assert.equal(parseFastModeCommand(` ${mode.toUpperCase()} `), mode);
  }
  assert.equal(parseFastModeCommand("ultrafast on"), "invalid");
  assert.equal(parseFastModeCommand("ultra-fast"), "invalid");
  assert.deepEqual(fastModeArgumentCompletions("u"), [{ value: "ultrafast", label: "ultrafast" }]);
  assert.deepEqual(fastModeArgumentCompletions("").map((item) => item.value), ["on", "off", "status", "normal", "fast", "ultrafast"]);
});

test("Ultrafast selection publishes its tier, persists compatibility state, and warns about costs", async () => {
  const harness = createHarness();
  const command = harness.commands.get("fast-mode");
  await command.handler("ultrafast", harness.context);
  assert.deepEqual(harness.appendCalls, [{ customType: FAST_MODE_STATE_ENTRY_TYPE, data: { mode: "ultrafast", enabled: true } }]);
  assert.deepEqual(harness.statusUpdates.at(-1), { key: FAST_MODE_STATUS_KEY, value: "ultrafast" });
  assert.ok(harness.notifications.at(-1)?.message.includes(ULTRAFAST_MODE_NOTICE));
  assert.equal(harness.notifications.at(-1)?.level, "warning");
  const payload = { model: ULTRAFAST_MODE_MODEL_ID };
  assert.equal((harness.handlers.get("before_provider_request")!({ payload }, harness.context) as any).service_tier, "ultrafast");
  await command.handler("ultrafast", harness.context);
  await command.handler("status", harness.context);
  assert.equal(harness.appendCalls.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /not confirmation of upstream acceptance/u);
});

test("legacy on selects Fast from Ultrafast and toggle never implicitly enables Ultrafast", async () => {
  const harness = createHarness();
  const command = harness.commands.get("fast-mode");
  const cases = [["ultrafast", "ultrafast"], ["on", "on"], ["normal", "off"], ["fast", "on"],
    ["off", "off"], ["", "on"], ["ultrafast", "ultrafast"], ["", "off"]];
  for (const [args, status] of cases) {
    await command.handler(args, harness.context);
    assert.equal(harness.statusUpdates.at(-1)?.value, status);
  }
  assert.equal(harness.appendCalls.length, cases.length);
});

test("unsupported Ultrafast selection and invalid commands leave existing state unchanged", async () => {
  const harness = createHarness();
  const command = harness.commands.get("fast-mode");
  await command.handler("on", harness.context);
  Object.assign(harness.context, { model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-sol" } });
  await command.handler("ultrafast", harness.context);
  assert.equal(harness.appendCalls.length, 1);
  assert.equal(harness.statusUpdates.at(-1)?.value, "on");
  assert.match(harness.notifications.at(-1)?.message ?? "", /No setting was changed/u);
  await command.handler("ultrafast on", harness.context);
  assert.equal(harness.appendCalls.length, 1);
});

test("branch-restored Ultrafast remains a preference when the model is unsupported", async () => {
  const harness = createHarness({ entries: [{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { mode: "ultrafast", enabled: true } }] });
  Object.assign(harness.context, { model: { provider: "openai", api: "openai-responses", id: ULTRAFAST_MODE_MODEL_ID } });
  harness.handlers.get("session_start")!({}, harness.context);
  assert.equal(harness.statusUpdates.at(-1)?.value, "ultrafast");
  assert.equal(harness.handlers.get("before_provider_request")!({ payload: { model: ULTRAFAST_MODE_MODEL_ID } }, harness.context), undefined);
  await harness.commands.get("fast-mode").handler("status", harness.context);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Inactive for the current model/u);
  harness.entries.splice(0, harness.entries.length, { type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: true } });
  harness.handlers.get("session_tree")!({}, harness.context);
  assert.equal(harness.statusUpdates.at(-1)?.value, "on");
});
