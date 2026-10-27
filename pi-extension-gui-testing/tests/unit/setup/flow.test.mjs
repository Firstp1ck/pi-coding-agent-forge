import { test } from "node:test";
import assert from "node:assert/strict";
import { APPLY_ALL, CANCEL, REVIEW_EACH, runSetup } from "../../../src/setup/flow.ts";
import { runDoctor } from "../../../src/setup/doctor.ts";
import { MissingInputError } from "../../../src/setup/ui.ts";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";

/** Scripted SetupUi that records prompts. */
function fakeUi({ hasUI = true, select = [], confirm = [] } = {}) {
  const prompts = [];
  return {
    hasUI,
    prompts,
    statuses: [],
    async select(title, options, prompt) {
      if (!hasUI) throw new MissingInputError(title, prompt.flags);
      prompts.push({ type: "select", title, options });
      return select.shift();
    },
    async confirm(title, message, prompt) {
      if (!hasUI) throw new MissingInputError(title, prompt.flags);
      prompts.push({ type: "confirm", title, message });
      return confirm.shift() ?? false;
    },
    async input(title, placeholder, prompt) {
      if (!hasUI) throw new MissingInputError(title, prompt.flags);
      prompts.push({ type: "input", title });
      return undefined;
    },
    notify() {},
    setStatus(text) {
      this.statuses.push(text);
    },
  };
}

/** A check whose outcome flips from fail to pass once `state.fixed` is set. */
function fixableCheck(state, id = "image.base", remediation = { summary: "build the base image", command: ["docker", "build", "-t", "pi-gui-testing-base", "."], estimatedSeconds: 300, downloadBytes: 400e6 }) {
  return {
    id,
    description: id,
    kind: "observe",
    required: true,
    remediation,
    async run() {
      return state.fixed ? { status: "pass", observed: "0.1.0", facts: { "image.base": "0.1.0" } } : { status: "fail", observed: "image missing" };
    },
  };
}
const passCheck = (id, facts) => ({ id, description: id, kind: "observe", required: true, run: async () => ({ status: "pass", observed: "ok", ...(facts ? { facts } : {}) }) });

function baseInput(overrides = {}) {
  const persisted = [];
  const runner = overrides.runner ?? new FakeCommandRunner();
  const input = {
    backend: "docker-linux",
    checks: [passCheck("pi.version", { "pi.version": "1.4.0" })],
    runner,
    ui: fakeUi(),
    flags: { fix: false, noFix: false },
    projectRoot: "/p",
    signal: new AbortController().signal,
    smoke: async () => ({ ok: true, observed: "button found, label changed", arch: "x86_64", leftovers: [] }),
    persist: async (record) => persisted.push(record),
    now: () => new Date("2026-10-24T12:00:00Z"),
    ...overrides,
  };
  return { input, persisted };
}

test("all checks pass → zero prompts, smoke, persist, verified", async () => {
  const { input, persisted } = baseInput({ inputs: { backend: "docker-linux" } });
  const report = await runSetup(input);
  assert.equal(report.status, "verified");
  assert.equal(input.ui.prompts.length, 0);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    verifiedAt: "2026-10-24T12:00:00.000Z",
    toolVersions: { "pi.version": "1.4.0" },
    checksPassed: ["pi.version"],
    inputs: { backend: "docker-linux" },
  });
  assert.match(report.message, /verified \(x86_64\)/);
  assert.equal(input.ui.statuses.at(-1), undefined, "status cleared");
});

test("--fix applies the plan without asking, re-checks, and records tool versions", async () => {
  const state = { fixed: false };
  const runner = new FakeCommandRunner().on(["docker", "build"], () => ((state.fixed = true), { exitCode: 0 }), { prefix: true });
  const { input, persisted } = baseInput({ runner, checks: [fixableCheck(state)], flags: { fix: true, noFix: false } });
  const report = await runSetup(input);
  assert.equal(report.status, "verified");
  assert.equal(input.ui.prompts.length, 0, "zero prompts with --fix");
  assert.deepEqual(runner.commands(), ["docker build -t pi-gui-testing-base ."]);
  assert.equal(report.applied.length, 1);
  assert.equal(report.initialResults[0].status, "fail");
  assert.equal(report.results[0].status, "pass");
  assert.equal(persisted[0].toolVersions["image.base"], "0.1.0");
});

test("--no-fix reports the plan and stops without applying or persisting", async () => {
  const state = { fixed: false };
  const runner = new FakeCommandRunner();
  const { input, persisted } = baseInput({ runner, checks: [fixableCheck(state)], flags: { fix: false, noFix: true } });
  const report = await runSetup(input);
  assert.equal(report.status, "failed");
  assert.match(report.message, /--no-fix/);
  assert.equal(report.plan.items.length, 1);
  assert.equal(runner.calls.length, 0);
  assert.equal(persisted.length, 0);
  assert.equal(input.ui.prompts.length, 0);
});

test("without flags: exactly one prompt for the whole plan; Apply all runs every fix", async () => {
  const a = { fixed: false };
  const b = { fixed: false };
  const runner = new FakeCommandRunner()
    .on(["fix-a"], () => ((a.fixed = true), {}))
    .on(["fix-b"], () => ((b.fixed = true), {}));
  const ui = fakeUi({ select: [APPLY_ALL] });
  const { input } = baseInput({
    runner,
    ui,
    checks: [fixableCheck(a, "a", { summary: "fix a", command: ["fix-a"] }), fixableCheck(b, "b", { summary: "fix b", command: ["fix-b"] })],
  });
  const report = await runSetup(input);
  assert.equal(report.status, "verified");
  assert.equal(ui.prompts.length, 1);
  assert.deepEqual(ui.prompts[0].options, [APPLY_ALL, REVIEW_EACH, CANCEL]);
  assert.match(ui.prompts[0].title, /Apply 2 fix\(es\).*\n.*fix-a/s);
  assert.deepEqual(runner.commands(), ["fix-a", "fix-b"]);
});

test("Review each fix confirms items individually and applies only approved ones", async () => {
  const a = { fixed: false };
  const b = { fixed: false };
  const runner = new FakeCommandRunner().on(["fix-a"], () => ((a.fixed = true), {})).on(["fix-b"], () => ((b.fixed = true), {}));
  const ui = fakeUi({ select: [REVIEW_EACH], confirm: [true, false] });
  const { input, persisted } = baseInput({
    runner,
    ui,
    checks: [fixableCheck(a, "a", { summary: "fix a", command: ["fix-a"] }), fixableCheck(b, "b", { summary: "fix b", command: ["fix-b"] })],
  });
  const report = await runSetup(input);
  assert.deepEqual(runner.commands(), ["fix-a"]);
  assert.equal(report.status, "failed");
  assert.match(report.message, /still fail.*b/);
  assert.equal(persisted.length, 0);
});

test("declining the plan changes nothing", async () => {
  for (const answer of [CANCEL, undefined]) {
    const runner = new FakeCommandRunner();
    const { input, persisted } = baseInput({ runner, ui: fakeUi({ select: [answer] }), checks: [fixableCheck({ fixed: false })] });
    const report = await runSetup(input);
    assert.equal(report.status, "failed");
    assert.match(report.message, /declined/);
    assert.equal(runner.calls.length, 0);
    assert.equal(persisted.length, 0);
  }
});

test("manual items are never automated and end with needs-user-action", async () => {
  const runner = new FakeCommandRunner();
  const manual = fixableCheck({ fixed: false }, "docker.daemon", { summary: "start Docker: sudo systemctl start docker", manual: true });
  const { input, persisted } = baseInput({ runner, checks: [manual], flags: { fix: true, noFix: false } });
  const report = await runSetup(input);
  assert.equal(report.status, "needs-user-action");
  assert.equal(report.manual.length, 1);
  assert.equal(runner.calls.length, 0);
  assert.equal(persisted.length, 0);
});

test("sudo items run only with passwordless sudo; otherwise they are manual", async () => {
  const sudoFix = { summary: "install xvfb", command: ["sudo", "-n", "pacman", "-S", "--noconfirm", "xorg-server-xvfb"], needsSudo: true };
  const runner = new FakeCommandRunner().on(["sudo", "-n", "true"], { exitCode: 1, stderr: "a password is required" });
  const { input } = baseInput({ runner, checks: [fixableCheck({ fixed: false }, "linux.xvfb", sudoFix)], flags: { fix: true, noFix: false } });
  const report = await runSetup(input);
  assert.equal(report.status, "needs-user-action");
  assert.equal(report.manual[0].manualReason, "needs sudo with a password");
  assert.deepEqual(runner.commands(), ["sudo -n true"]);

  const state = { fixed: false };
  const ok = new FakeCommandRunner().on(["sudo", "-n", "true"], {}).on(["sudo", "-n", "pacman"], () => ((state.fixed = true), {}), { prefix: true });
  const second = baseInput({ runner: ok, checks: [fixableCheck(state, "linux.xvfb", sudoFix)], flags: { fix: true, noFix: false } });
  assert.equal((await runSetup(second.input)).status, "verified");
});

test("no UI and a fix is needed without --fix/--no-fix → fails listing the missing flags, no prompt", async () => {
  const runner = new FakeCommandRunner();
  const ui = fakeUi({ hasUI: false });
  const { input, persisted } = baseInput({ runner, ui, checks: [fixableCheck({ fixed: false })] });
  const report = await runSetup(input);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.missingFlags, ["--fix", "--no-fix"]);
  assert.match(report.message, /no interactive UI; re-run with --fix or --no-fix/);
  assert.equal(ui.prompts.length, 0);
  assert.equal(runner.calls.length, 0);
  assert.equal(persisted.length, 0);
});

test("a required failure without remediation fails immediately", async () => {
  const bug = { id: "isolation.inspect", description: "", kind: "probe", required: true, run: async () => ({ status: "fail", observed: "IpcMode=host" }) };
  const { input } = baseInput({ checks: [bug], flags: { fix: true, noFix: false } });
  const report = await runSetup(input);
  assert.equal(report.status, "failed");
  assert.match(report.message, /without an automatic fix: isolation\.inspect/);
});

test("a failing fix stops setup with its output", async () => {
  const runner = new FakeCommandRunner().on(["docker", "build"], { exitCode: 1, stderr: "network unreachable" }, { prefix: true });
  const { input, persisted } = baseInput({ runner, checks: [fixableCheck({ fixed: false })], flags: { fix: true, noFix: false } });
  const report = await runSetup(input);
  assert.equal(report.status, "failed");
  assert.match(report.message, /fix for image\.base failed .*exit 1: network unreachable/);
  assert.equal(persisted.length, 0);
});

test("smoke failure or non-empty footprint audit fails setup and persists nothing", async () => {
  const failing = baseInput({ smoke: async () => ({ ok: false, observed: "button not found" }) });
  assert.match((await runSetup(failing.input)).message, /smoke test failed: button not found/);
  assert.equal(failing.persisted.length, 0);

  const leaky = baseInput({ smoke: async () => ({ ok: true, observed: "ok", leftovers: [{ kind: "container", id: "abc" }] }) });
  const report = await runSetup(leaky.input);
  assert.equal(report.status, "failed");
  assert.match(report.message, /footprint audit not empty: container abc/);
  assert.equal(leaky.persisted.length, 0);

  const throwing = baseInput({ smoke: async () => { throw new Error("helper crashed"); } });
  assert.match((await runSetup(throwing.input)).message, /helper crashed/);
});

test("abort during the fix, during smoke, or during the prompt → cancelled and nothing persisted", async () => {
  // During the fix.
  {
    const controller = new AbortController();
    const runner = new FakeCommandRunner().on(["docker", "build"], { exitCode: 0 }, { prefix: true, delayMs: 200 });
    setTimeout(() => controller.abort(new Error("session shutdown")), 20);
    const { input, persisted } = baseInput({ runner, signal: controller.signal, checks: [fixableCheck({ fixed: false })], flags: { fix: true, noFix: false } });
    const report = await runSetup(input);
    assert.equal(report.status, "cancelled");
    assert.match(report.message, /nothing was saved/);
    assert.equal(persisted.length, 0);
  }
  // During smoke.
  {
    const controller = new AbortController();
    const { input, persisted } = baseInput({
      signal: controller.signal,
      smoke: async (signal) => {
        controller.abort();
        return { ok: !signal.aborted || true, observed: "ok" };
      },
    });
    const report = await runSetup(input);
    assert.equal(report.status, "cancelled");
    assert.equal(persisted.length, 0);
  }
  // While the dialog is open.
  {
    const controller = new AbortController();
    const ui = fakeUi();
    ui.select = async () => {
      controller.abort(new Error("/gui-cleanup cancelled setup"));
      return APPLY_ALL;
    };
    const runner = new FakeCommandRunner();
    const { input, persisted } = baseInput({ runner, ui, signal: controller.signal, checks: [fixableCheck({ fixed: false })] });
    const report = await runSetup(input);
    assert.equal(report.status, "cancelled");
    assert.equal(runner.calls.length, 0);
    assert.equal(persisted.length, 0);
  }
  // Already aborted.
  {
    const { input, persisted } = baseInput({ signal: AbortSignal.abort() });
    assert.equal((await runSetup(input)).status, "cancelled");
    assert.equal(persisted.length, 0);
  }
});

test("doctor never prompts or remediates; refreshes on success, unverifies on failure, unchanged on cancel", async () => {
  const calls = [];
  const runner = new FakeCommandRunner();
  const base = {
    backend: "docker-linux",
    runner,
    projectRoot: "/p",
    signal: new AbortController().signal,
    smoke: async () => ({ ok: true, observed: "ok", arch: "x86_64" }),
    persist: async (r) => calls.push(["persist", r]),
    unverify: async () => calls.push(["unverify"]),
    inputs: { backend: "docker-linux" },
  };
  const ok = await runDoctor({ ...base, checks: [passCheck("pi.version", { "pi.version": "1.4.0" })] });
  assert.equal(ok.status, "verified");
  assert.equal(ok.kind, "doctor");
  assert.deepEqual(calls[0][1].inputs, { backend: "docker-linux" });

  calls.length = 0;
  const bad = await runDoctor({ ...base, checks: [fixableCheck({ fixed: false })] });
  assert.equal(bad.status, "failed");
  assert.deepEqual(calls, [["unverify"]]);
  assert.equal(bad.plan.items.length, 1, "suggested fixes are reported");
  assert.equal(runner.calls.length, 0, "never remediates");

  calls.length = 0;
  const smokeBad = await runDoctor({ ...base, checks: [passCheck("x")], smoke: async () => ({ ok: false, observed: "no window" }) });
  assert.equal(smokeBad.status, "failed");
  assert.deepEqual(calls, [["unverify"]]);

  calls.length = 0;
  const cancelled = await runDoctor({ ...base, checks: [passCheck("x")], signal: AbortSignal.abort() });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(calls, []);
});
