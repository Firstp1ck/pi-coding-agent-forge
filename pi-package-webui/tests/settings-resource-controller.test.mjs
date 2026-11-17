import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsResourceController } from "../public/settings-resource-controller.mjs";

const MODELS = [{ provider: "z", id: "shared" }, { provider: "a", id: "shared", name: "First" }];
const A = { provider: "a", modelId: "shared" };
const Z = { provider: "z", modelId: "shared" };
const resources = () => [
  { name: "read", description: "Read a file", sourceInfo: { source: "builtin" } },
  { name: "write", enabled: true },
  { name: "shell", enabled: false },
];
const data = (kind = "tools", overrides = {}) => ({ [kind]: resources(), configured: false, ...overrides });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture() {
  const calls = [];
  const changes = [];
  const mutations = [];
  let target = Object.freeze({ tabId: "a", lifetime: 1, generation: 1, dialog: 1 });
  const f = { calls, changes, mutations, onChange: null, onMutation: null };
  function pending(type, kind, selection, change, captured) {
    return new Promise((resolve, reject) => calls.push({ type, kind, selection, change, target: captured, resolve, reject }));
  }
  const c = createSettingsResourceController({
    read: (kind, selected, captured) => pending("read", kind, selected, null, captured),
    write: (kind, selected, change, captured) => pending("write", kind, selected, change, captured),
    listModels: (captured) => pending("models", null, null, null, captured),
    isCurrent: (captured) => captured === target,
    onChange(snapshot) { changes.push(snapshot); f.onChange?.(snapshot); },
    onMutation(mutation) { mutations.push(mutation); f.onMutation?.(mutation); },
  });
  Object.assign(f, {
    c,
    target: () => target,
    replace(fields = {}) { target = Object.freeze({ ...target, ...fields }); return target; },
    async open(kind = "tools", result = data(kind)) {
      const opened = c.open(kind, target);
      calls.at(-1).resolve(result);
      assert.equal(await opened, true);
    },
    async model(kind = "tools", result = data(kind, { models: MODELS })) {
      const selected = c.setScope("model");
      assert.equal(calls.at(-1).type, "models");
      calls.at(-1).resolve(MODELS);
      await tick();
      assert.equal(calls.at(-1).type, "read");
      calls.at(-1).resolve(result);
      assert.equal(await selected, true);
    },
  });
  return f;
}

test("open reads the exact target, starts Session/All, and resets a prior presentation", async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.c).sort(), ["open", "setScope", "setModel", "setFilter", "toggle", "inherit", "close", "getSnapshot", "dispose"].sort());
  const opened = f.c.open("tools", f.target());
  assert.equal(f.calls[0].target, f.target());
  assert.deepEqual(f.calls[0].selection, { scope: "session", provider: null, modelId: null });
  assert.ok(Object.isFrozen(f.calls[0].selection));
  assert.deepEqual(f.c.getSnapshot(), {
    kind: "tools", target: f.target(), selection: f.calls[0].selection, resources: [], models: [],
    configured: false, filter: "all", loading: true, savingName: "", error: "",
  });
  f.calls[0].resolve(data());
  assert.equal(await opened, true);
  assert.equal(f.changes.length, 2);
  assert.deepEqual(f.c.getSnapshot().resources, resources());
  f.c.setFilter("disabled");
  const global = f.c.setScope("global");
  f.calls.at(-1).resolve(data("tools", { configured: true }));
  await global;
  const skills = f.c.open("skills", f.target());
  assert.equal(f.c.getSnapshot().filter, "all");
  assert.equal(f.c.getSnapshot().selection.scope, "session");
  assert.equal(f.c.getSnapshot().configured, false);
  f.calls.at(-1).resolve(data("skills"));
  await skills;
  const before = f.c.getSnapshot();
  assert.equal(await f.c.open("extensions", f.target()), false);
  assert.deepEqual(f.c.getSnapshot(), before);
});

test("filters stay local and full resource lists survive filtering", async () => {
  const f = fixture();
  await f.open();
  const before = f.c.getSnapshot().resources;
  for (const filter of ["enabled", "disabled", "all"]) {
    const count = f.changes.length;
    assert.equal(f.c.setFilter(filter), true);
    assert.equal(f.changes.length, count + 1);
    assert.equal(f.c.getSnapshot().filter, filter);
    assert.equal(f.c.getSnapshot().resources, before);
    assert.equal(f.c.setFilter(filter), false);
  }
  assert.equal(f.c.setFilter("other"), false);
  assert.equal(f.calls.length, 1);
});

test("tools and skills submit full enabled sets, preserve metadata and notify captured mutations", async (t) => {
  for (const kind of ["tools", "skills"]) {
    await t.test(kind, async () => {
      const f = fixture();
      await f.open(kind);
      f.c.setFilter("disabled");
      const saved = f.c.toggle("shell");
      const call = f.calls.at(-1);
      assert.equal(call.type, "write");
      assert.equal(call.kind, kind);
      assert.equal(call.target, f.target());
      assert.deepEqual(call.change, { enabled: ["read", "write", "shell"] });
      assert.equal(f.c.getSnapshot().savingName, "shell");
      assert.equal(await f.c.toggle("write"), false);
      assert.equal(await f.c.inherit(), false);
      assert.equal(await f.c.setScope("global"), false);
      assert.equal(await f.c.setModel(A), false);
      assert.equal(f.calls.length, 2);
      assert.equal(f.c.setFilter("enabled"), true);
      call.resolve(data(kind, { configured: true, [kind]: resources().map((item) => ({ ...item, enabled: true })) }));
      assert.equal(await saved, true);
      assert.equal(f.c.getSnapshot().savingName, "");
      assert.equal(f.c.getSnapshot().configured, true);
      assert.deepEqual(f.mutations, [{ kind, target: call.target, selection: call.selection, name: "shell", enabled: true, inherit: false }]);
      assert.equal(f.mutations[0].selection, call.selection);
      assert.equal(f.c.getSnapshot().resources[0].sourceInfo.source, "builtin");
    });
  }
});

test("explicit empty selection is distinct from inheritance in every scope", async (t) => {
  for (const scope of ["session", "global", "model"]) {
    await t.test(scope, async () => {
      const f = fixture();
      await f.open("skills", data("skills", { skills: [{ name: "one" }] }));
      if (scope === "model") await f.model("skills", data("skills", { skills: [{ name: "one" }], models: MODELS }));
      if (scope === "global") {
        const selection = f.c.setScope("global");
        f.calls.at(-1).resolve(data("skills", { skills: [{ name: "one" }] }));
        await selection;
      }
      const selected = f.c.getSnapshot().selection;
      const empty = f.c.toggle("one");
      assert.deepEqual(f.calls.at(-1).change, { enabled: [] });
      assert.equal(f.calls.at(-1).selection, selected);
      f.calls.at(-1).resolve(data("skills", { skills: [{ name: "one", enabled: false }], configured: true }));
      await empty;
      assert.equal(f.c.getSnapshot().configured, true);
      const inherited = f.c.inherit();
      assert.deepEqual(f.calls.at(-1).change, { inherit: true });
      assert.equal(f.calls.at(-1).selection, selected);
      f.calls.at(-1).resolve(data("skills"));
      await inherited;
      assert.equal(f.c.getSnapshot().configured, false);
      assert.deepEqual(f.mutations.at(-1), { kind: "skills", target: f.target(), selection: selected, name: null, enabled: null, inherit: true });
    });
  }
});

test("model discovery is lazy, authenticated, sorted, and retains exact identity across reordering/scopes", async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.calls.length, 1);
  const model = f.c.setScope("model");
  assert.equal(f.calls.at(-1).type, "models");
  assert.equal(f.calls.at(-1).target, f.target());
  assert.equal(f.c.getSnapshot().selection.scope, "session");
  f.calls.at(-1).resolve([null, { id: "bad" }, ...MODELS, { provider: "bad", id: "" }]);
  await tick();
  assert.deepEqual(f.calls.at(-1).selection, { scope: "model", ...A });
  assert.equal(f.calls.at(-1).target, f.target());
  f.calls.at(-1).resolve(data("tools", { models: MODELS }));
  await model;
  assert.deepEqual(f.c.getSnapshot().selection, { scope: "model", ...A });
  assert.equal(await f.c.setModel(A), false);
  assert.equal(await f.c.setModel({ provider: "missing", modelId: "shared" }), false);
  const exactZ = f.c.setModel(Z);
  f.calls.at(-1).resolve(data("tools", { models: [...MODELS].reverse() }));
  await exactZ;
  assert.deepEqual(f.c.getSnapshot().selection, { scope: "model", ...Z });
  const global = f.c.setScope("global");
  assert.deepEqual(f.calls.at(-1).selection, { scope: "global", provider: null, modelId: null });
  f.calls.at(-1).resolve(data());
  await global;
  const back = f.c.setScope("model");
  assert.equal(f.calls.at(-1).type, "read");
  assert.deepEqual(f.calls.at(-1).selection, { scope: "model", ...Z });
  f.calls.at(-1).resolve(data("tools", { models: MODELS }));
  await back;
  const write = f.c.toggle("read");
  assert.deepEqual(f.calls.at(-1).selection, { scope: "model", ...Z });
  f.calls.at(-1).resolve(data("tools", { models: [...MODELS].reverse() }));
  await write;
  assert.deepEqual(f.mutations.at(-1).selection, { scope: "model", ...Z });
  assert.equal(f.calls.filter((call) => call.type === "models").length, 1);
});

test("empty or failed model discovery preserves the previous scope and accepted resources", async (t) => {
  for (const failure of ["empty", "reject"]) {
    await t.test(failure, async () => {
      const f = fixture();
      await f.open();
      const global = f.c.setScope("global");
      f.calls.at(-1).resolve(data("tools", { configured: true }));
      await global;
      const before = f.c.getSnapshot();
      const model = f.c.setScope("model");
      if (failure === "empty") f.calls.at(-1).resolve([{ provider: "bad" }]);
      else f.calls.at(-1).reject(new Error("Authenticated discovery failed"));
      assert.equal(await model, false);
      const after = f.c.getSnapshot();
      assert.equal(after.selection, before.selection);
      assert.equal(after.resources, before.resources);
      assert.equal(after.configured, true);
      assert.equal(after.loading, false);
      assert.match(after.error, failure === "empty" ? /No authenticated Pi models/ : /Authenticated discovery failed/);
      assert.equal(f.calls.filter((call) => call.type === "read").length, 2);
      const retry = f.c.setScope("model");
      f.calls.at(-1).resolve(MODELS);
      await tick();
      f.calls.at(-1).resolve(data("tools", { models: MODELS }));
      assert.equal(await retry, true);
      assert.equal(f.c.getSnapshot().error, "");
    });
  }
});

test("missing exact models block both kinds of write until explicitly selected again", async (t) => {
  for (const responseType of ["read", "write"]) {
    await t.test(responseType, async () => {
      const f = fixture();
      await f.open();
      if (responseType === "read") await f.model("tools", data("tools", { models: [MODELS[0]] }));
      else {
        await f.model();
        const save = f.c.toggle("read");
        f.calls.at(-1).resolve(data("tools", { models: [MODELS[0]] }));
        await save;
        assert.deepEqual(f.mutations.at(-1).selection, { scope: "model", ...A });
      }
      assert.deepEqual(f.c.getSnapshot().selection, { scope: "model", ...A });
      assert.match(f.c.getSnapshot().error, /a\/shared is unavailable/);
      const count = f.calls.length;
      assert.equal(await f.c.toggle("write"), false);
      assert.equal(await f.c.inherit(), false);
      assert.equal(await f.c.setModel(A), false);
      assert.equal(f.calls.length, count);
      const global = f.c.setScope("global");
      f.calls.at(-1).resolve(data());
      await global;
      assert.equal(await f.c.setScope("model"), false);
      assert.deepEqual(f.c.getSnapshot().selection, { scope: "model", ...A });
      assert.equal(f.calls.length, count + 1);
      const recover = f.c.setModel(Z);
      assert.deepEqual(f.calls.at(-1).selection, { scope: "model", ...Z });
      f.calls.at(-1).resolve(data("tools", { models: [MODELS[0]] }));
      assert.equal(await recover, true);
      assert.equal(f.c.getSnapshot().error, "");
    });
  }
});

test("reverse scope completions and failures never replace a newer accepted read", async (t) => {
  for (const reject of [false, true]) {
    await t.test(`old read rejects: ${reject}`, async () => {
      const f = fixture();
      const first = f.c.open("tools", f.target());
      const old = f.calls.at(-1);
      const latest = f.c.setScope("global");
      assert.equal(await f.c.toggle("read"), false);
      assert.equal(await f.c.inherit(), false);
      f.calls.at(-1).resolve(data("tools", { tools: [{ name: "new" }], configured: true }));
      await latest;
      const snapshot = f.c.getSnapshot();
      const count = f.changes.length;
      if (reject) old.reject(new Error("Old read failed"));
      else old.resolve(data("tools", { tools: [{ name: "old" }] }));
      assert.equal(await first, false);
      assert.deepEqual(f.c.getSnapshot(), snapshot);
      assert.equal(f.changes.length, count);
    });
  }
});

test("newer Model reads retain their identity despite reverse completions", async () => {
  const f = fixture();
  await f.open();
  await f.model();
  const old = f.c.setModel(Z);
  const call = f.calls.at(-1);
  const latest = f.c.setModel(A);
  f.calls.at(-1).resolve(data("tools", { tools: [{ name: "a-only" }], models: [...MODELS].reverse() }));
  await latest;
  const count = f.changes.length;
  call.resolve(data("tools", { tools: [{ name: "z-only" }], models: [MODELS[0]] }));
  assert.equal(await old, false);
  assert.deepEqual(f.c.getSnapshot().selection, { scope: "model", ...A });
  assert.deepEqual(f.c.getSnapshot().resources, [{ name: "a-only" }]);
  assert.equal(f.changes.length, count);
});

test("newer discoveries win, and leaving scope during discovery suppresses its follow-up", async (t) => {
  for (const destination of ["session", "global", "model"]) {
    await t.test(destination, async () => {
      const f = fixture();
      await f.open();
      const discovery = f.c.setScope("model");
      const old = f.calls.at(-1);
      const newer = f.c.setScope(destination);
      if (destination === "model") {
        f.calls.at(-1).resolve(MODELS);
        await tick();
      }
      f.calls.at(-1).resolve(data("tools", { models: MODELS }));
      await newer;
      const count = f.calls.length;
      old.resolve([{ provider: "old", id: "wrong" }]);
      assert.equal(await discovery, false);
      assert.equal(f.calls.length, count);
      assert.equal(f.c.getSnapshot().selection.scope, destination);
      assert.equal(f.c.getSnapshot().models.some((model) => model.provider === "old"), false);
    });
  }
});

test("target lifetime, foreground generation and dialog changes suppress reads, discovery and writes", async (t) => {
  for (const field of ["tabId", "lifetime", "generation", "dialog"]) {
    for (const operation of ["read", "models", "write", "inherit"]) {
      await t.test(`${field}: ${operation}`, async () => {
        const f = fixture();
        let pending;
        if (operation === "read") pending = f.c.open("tools", f.target());
        else {
          await f.open();
          pending = operation === "models" ? f.c.setScope("model") : operation === "write" ? f.c.toggle("read") : f.c.inherit();
        }
        const call = f.calls.at(-1);
        f.replace({ [field]: "replacement" });
        const count = f.changes.length;
        call.resolve(operation === "models" ? MODELS : data());
        assert.equal(await pending, false);
        assert.equal(f.changes.length, count);
        assert.equal(f.mutations.length, 0);
        assert.equal(f.calls.at(-1), call);
        assert.equal(await f.c.toggle("read"), false);
        assert.equal(await f.c.setScope("global"), false);
        assert.equal(f.c.setFilter("enabled"), false);
      });
    }
  }
});

test("old closed/reopened successes, failures and finally blocks cannot repaint or unlock new writes", async (t) => {
  for (const operation of ["read", "models", "write", "inherit"]) {
    for (const fail of [false, true]) {
      await t.test(`${operation}, failure: ${fail}`, async () => {
        const f = fixture();
        let pending;
        if (operation === "read") pending = f.c.open("tools", f.target());
        else {
          await f.open();
          pending = operation === "models" ? f.c.setScope("model") : operation === "write" ? f.c.toggle("read") : f.c.inherit();
        }
        const old = f.calls.at(-1);
        assert.equal(f.c.close(), true);
        assert.equal(f.c.close(), false);
        await f.open("skills");
        const saving = f.c.toggle("shell");
        const latest = f.calls.at(-1);
        const snapshot = f.c.getSnapshot();
        const count = f.changes.length;
        if (fail) old.reject(new Error("Retired request failed"));
        else old.resolve(operation === "models" ? MODELS : data());
        assert.equal(await pending, false);
        assert.deepEqual(f.c.getSnapshot(), snapshot);
        assert.equal(f.changes.length, count);
        assert.equal(f.c.getSnapshot().savingName, "shell");
        assert.equal(await f.c.inherit(), false);
        assert.equal(f.mutations.length, 0);
        latest.resolve(data("skills"));
        assert.equal(await saving, true);
        assert.equal(f.c.getSnapshot().savingName, "");
        assert.equal(f.mutations.length, 1);
      });
    }
  }
});

test("current read/write failures release their own flags and permit retries", async (t) => {
  for (const operation of ["read", "write", "inherit"]) {
    await t.test(operation, async () => {
      const f = fixture();
      let failed;
      if (operation === "read") failed = f.c.open("tools", f.target());
      else {
        await f.open();
        failed = operation === "write" ? f.c.toggle("read") : f.c.inherit();
      }
      const before = f.c.getSnapshot().resources;
      f.calls.at(-1).reject(new Error(`${operation} failed`));
      assert.equal(await failed, false);
      assert.equal(f.c.getSnapshot().error, `${operation} failed`);
      assert.equal(f.c.getSnapshot().loading, false);
      assert.equal(f.c.getSnapshot().savingName, "");
      assert.equal(f.c.getSnapshot().resources, before);
      assert.equal(f.mutations.length, 0);
      const retry = operation === "read" ? f.c.setScope("global") : f.c.toggle("read");
      assert.equal(f.c.getSnapshot().error, "");
      f.calls.at(-1).resolve(data());
      assert.equal(await retry, true);
    });
  }
});

test("snapshots, API records and callback projections cannot mutate owned state", async () => {
  const f = fixture();
  const input = data();
  await f.open("tools", input);
  const snapshot = f.c.getSnapshot();
  input.tools[0].sourceInfo.source = "caller change";
  input.tools.push({ name: "injected" });
  assert.equal(snapshot.resources.length, 3);
  assert.equal(snapshot.resources[0].sourceInfo.source, "builtin");
  for (const project of [snapshot, f.changes.at(-1)]) {
    assert.throws(() => { project.filter = "disabled"; }, TypeError);
    assert.throws(() => { project.selection.scope = "global"; }, TypeError);
    assert.throws(() => { project.resources[0].enabled = false; }, TypeError);
    assert.throws(() => { project.resources[0].sourceInfo.source = "changed"; }, TypeError);
    assert.throws(() => project.resources.push({ name: "changed" }), TypeError);
  }
  const models = MODELS.map((model) => ({ ...model, info: { authenticated: true } }));
  await f.model("tools", data("tools", { models }));
  models[0].info.authenticated = false;
  assert.equal(f.c.getSnapshot().models[0].info.authenticated, true);
  assert.throws(() => { f.c.getSnapshot().models[0].info.authenticated = false; }, TypeError);
  const saving = f.c.toggle("read");
  const call = f.calls.at(-1);
  assert.throws(() => call.change.enabled.push("changed"), TypeError);
  call.resolve(data());
  await saving;
  assert.throws(() => { f.mutations[0].selection.provider = "changed"; }, TypeError);
  assert.throws(() => { f.mutations[0].name = "changed"; }, TypeError);
});

test("invalid scopes/models/names and closed methods dispatch nothing", async () => {
  const f = fixture();
  assert.equal(await f.c.toggle("read"), false);
  assert.equal(await f.c.inherit(), false);
  assert.equal(await f.c.setScope("global"), false);
  assert.equal(await f.c.setModel(A), false);
  assert.equal(f.c.setFilter("enabled"), false);
  await f.open();
  assert.equal(await f.c.setScope("bad"), false);
  assert.equal(await f.c.setScope("session"), false);
  assert.equal(await f.c.setModel(A), false);
  assert.equal(await f.c.toggle("missing"), false);
  assert.equal(await f.c.toggle(undefined), false);
  assert.equal(f.calls.length, 1);
});

test("every dispatch rechecks ownership after synchronous rendering callbacks", async (t) => {
  for (const operation of ["read", "models", "write"]) {
    await t.test(operation, async () => {
      const f = fixture();
      if (operation !== "read") await f.open();
      f.onChange = (snapshot) => { if (snapshot.loading || snapshot.savingName) f.c.close(); };
      const count = f.calls.length;
      const pending = operation === "read" ? f.c.open("tools", f.target()) : operation === "models" ? f.c.setScope("model") : f.c.toggle("read");
      assert.equal(await pending, false);
      assert.equal(f.calls.length, count);
      assert.equal(f.c.getSnapshot().kind, null);
    });
  }
});

test("rendering a write completion can retire its notice or begin a newer write safely", async (t) => {
  for (const action of ["close", "new-write"]) {
    await t.test(action, async () => {
      const f = fixture();
      await f.open();
      const first = f.c.toggle("read");
      let newer;
      f.onChange = (snapshot) => {
        if (snapshot.savingName) return;
        f.onChange = null;
        if (action === "close") f.c.close();
        else newer = f.c.toggle("shell");
      };
      f.calls.at(-1).resolve(data());
      await first;
      assert.equal(f.mutations.length, 0);
      if (newer) {
        assert.equal(f.c.getSnapshot().savingName, "shell");
        f.calls.at(-1).resolve(data());
        await newer;
        assert.equal(f.mutations.length, 1);
        assert.equal(f.mutations[0].name, "shell");
      }
    });
  }
});

test("mutation callbacks observe unlocked accepted state and may close their own presentation", async () => {
  const f = fixture();
  await f.open("skills");
  f.onMutation = (mutation) => {
    assert.equal(f.c.getSnapshot().savingName, "");
    assert.equal(f.c.getSnapshot().configured, true);
    assert.equal(mutation.target, f.target());
    f.c.close();
  };
  const saving = f.c.toggle("read");
  f.calls.at(-1).resolve(data("skills", { configured: true }));
  assert.equal(await saving, true);
  assert.equal(f.c.getSnapshot().kind, null);
  assert.equal(f.mutations.length, 1);
});

test("dispose is idempotent and suppresses all pending completions and future work", async (t) => {
  for (const operation of ["read", "models", "write", "inherit"]) {
    await t.test(operation, async () => {
      const f = fixture();
      let pending;
      if (operation === "read") pending = f.c.open("tools", f.target());
      else {
        await f.open();
        pending = operation === "models" ? f.c.setScope("model") : operation === "write" ? f.c.toggle("read") : f.c.inherit();
      }
      const call = f.calls.at(-1);
      f.c.dispose();
      const count = f.changes.length;
      f.c.dispose();
      call.reject(new Error("Disposed request failed"));
      assert.equal(await pending, false);
      assert.equal(f.changes.length, count);
      assert.equal(f.mutations.length, 0);
      assert.equal(f.c.getSnapshot().kind, null);
      assert.equal(await f.c.open("skills", f.target()), false);
      assert.equal(await f.c.setScope("global"), false);
      assert.equal(await f.c.setModel(A), false);
      assert.equal(await f.c.toggle("read"), false);
      assert.equal(await f.c.inherit(), false);
      assert.equal(f.c.setFilter("disabled"), false);
      assert.equal(f.c.close(), false);
      assert.equal(f.calls.at(-1), call);
    });
  }
});
