import { test } from "node:test";
import assert from "node:assert/strict";
import { createSetupUi, MissingInputError } from "../../../src/setup/ui.ts";
import { emitReport, emitSetupReport, renderCheckTable, renderReport, REPORT_CUSTOM_TYPE } from "../../../src/setup/report.ts";
import { buildRemediationPlan, formatCommand, formatPlan } from "../../../src/setup/plan.ts";

function stubCtx({ hasUI, mode, answers = {} }) {
  const calls = [];
  const ui = {
    select: async (title, options, opts) => (calls.push(["select", title, opts]), answers.select),
    confirm: async (title, message, opts) => (calls.push(["confirm", title, opts]), answers.confirm ?? true),
    input: async (title, placeholder, opts) => (calls.push(["input", title, opts]), answers.input),
    notify: (message, type) => calls.push(["notify", message, type]),
    setStatus: (key, text) => calls.push(["setStatus", key, text]),
  };
  return { ctx: { hasUI, mode, ui }, calls };
}

function stubPi() {
  const messages = [];
  return { pi: { sendMessage: (m) => messages.push(m) }, messages };
}

/** Captures process.stderr writes and restores exitCode afterwards. */
function capture(t) {
  const original = process.stderr.write;
  const exitCode = process.exitCode;
  const written = [];
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  t.after(() => {
    process.stderr.write = original;
    process.exitCode = exitCode;
  });
  return written;
}

test("without UI the adapter never calls dialogs and names the flags instead", async () => {
  const { ctx, calls } = stubCtx({ hasUI: false, mode: "print" });
  const ui = createSetupUi(ctx, { controller: new AbortController() });
  await assert.rejects(ui.confirm("Apply fixes?", "x", { flags: ["--fix", "--no-fix"] }), (e) => e instanceof MissingInputError && e.missingFlags.join() === "--fix,--no-fix");
  await assert.rejects(ui.select("Backend?", ["a"], { flags: ["<backend>"] }), MissingInputError);
  await assert.rejects(ui.input("Host?", undefined, { flags: ["--host"] }), /--host/);
  ui.notify("hi");
  ui.setStatus("working");
  assert.deepEqual(calls, []);
});

test("with UI the adapter passes the setup signal to dialogs and a dialog timeout aborts setup", async () => {
  const { ctx, calls } = stubCtx({ hasUI: true, mode: "tui", answers: { confirm: true } });
  const controller = new AbortController();
  const ui = createSetupUi(ctx, { controller, statusKey: "gui" });
  assert.equal(await ui.confirm("Apply?", "msg", { flags: [] }), true);
  assert.equal(calls[0][2].signal, controller.signal);
  ui.setStatus("building");
  assert.deepEqual(calls.at(-1), ["setStatus", "gui", "building"]);

  const slow = { ...ctx, ui: { ...ctx.ui, confirm: (t, m, opts) => new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve(false))) } };
  const timed = new AbortController();
  const slowUi = createSetupUi(slow, { controller: timed, dialogTimeoutMs: 20 });
  await assert.rejects(slowUi.confirm("Apply?", "msg", { flags: [] }), /timed out/);
  assert.equal(timed.signal.aborted, true, "the whole setup is aborted");
  await assert.rejects(slowUi.select("again", [], { flags: [] }), /timed out/, "no dialogs after abort");
});

test("plan and command formatting", () => {
  assert.equal(formatCommand(["docker", "build", "-t", "x:1", "--label", "a b"]), "docker build -t x:1 --label 'a b'");
  const plan = buildRemediationPlan(
    [
      { id: "image.base", status: "fail", required: true, observed: "", durationMs: 0, remediation: { summary: "build image", command: ["docker", "build", "."], downloadBytes: 2 * 1024 ** 3, estimatedSeconds: 300 } },
      { id: "docker.daemon", status: "fail", required: true, observed: "", durationMs: 0, remediation: { summary: "start Docker", manual: true } },
      { id: "linux.wm", status: "warn", required: false, observed: "", durationMs: 0, remediation: { summary: "install openbox", command: ["sudo", "apt", "install", "openbox"], needsSudo: true } },
      { id: "ok", status: "pass", required: true, observed: "", durationMs: 0, remediation: { summary: "never shown", command: ["x"] } },
    ],
    false,
  );
  assert.deepEqual(plan.items.map((i) => [i.checkId, i.automated]), [["image.base", true], ["docker.daemon", false], ["linux.wm", false]]);
  assert.equal(plan.downloadBytes, 2 * 1024 ** 3);
  const text = formatPlan(plan);
  assert.match(text, /Fixes setup can apply \(download 2\.0 GB, ~5 min\):\n- image\.base: build image .*\n    \$ docker build \./);
  assert.match(text, /Steps you need to do yourself:[\s\S]*docker\.daemon: start Docker[\s\S]*needs sudo with a password/);
});

const results = [
  { id: "pi.version", status: "pass", required: true, observed: "1.4.0", durationMs: 1 },
  { id: "docker.daemon", status: "fail", required: true, observed: "Cannot connect\nto the Docker daemon", durationMs: 2 },
  { id: "image.base", status: "blocked", required: true, observed: "blocked by docker.daemon", durationMs: 0, blockedBy: ["docker.daemon"] },
  { id: "linux.atspi", status: "warn", required: false, observed: "missing", durationMs: 0, degrades: "no accessibility tree" },
];

test("renderCheckTable aligns columns and flattens multi-line observations", () => {
  const table = renderCheckTable(results);
  const lines = table.split("\n");
  assert.match(lines[0], /^STATUS\s+CHECK\s+OBSERVED$/);
  assert.match(lines[2], /^fail\s+docker\.daemon\s+required\s+Cannot connect to the Docker daemon$/);
  assert.match(lines[4], /^warn\s+linux\.atspi\s+optional\s+missing$/);
  assert.equal(renderCheckTable([]), "(no checks ran)");
});

const report = {
  kind: "doctor",
  backend: "docker-linux",
  status: "failed",
  message: "required checks failed; docker-linux is marked unverified",
  results,
  applied: [],
  manual: [],
  degraded: ["linux.atspi: no accessibility tree"],
  durationMs: 1234,
};

test("renderReport includes the table, degraded capabilities, and the summary", () => {
  const text = renderReport(report);
  assert.match(text, /^GUI testing doctor: docker-linux — failed/);
  assert.match(text, /docker\.daemon/);
  assert.match(text, /Degraded capabilities:\n- linux\.atspi: no accessibility tree/);
  assert.match(text, /marked unverified \(1\.2 s\)$/);
});

test("print mode writes the report to stderr and sets exit code 1 on failure", (t) => {
  const written = capture(t);
  process.exitCode = undefined;
  const { pi, messages } = stubPi();
  const { ctx, calls } = stubCtx({ hasUI: false, mode: "print" });
  emitSetupReport(pi, ctx, report);
  assert.match(written.join(""), /GUI testing doctor: docker-linux — failed[\s\S]*docker\.daemon/);
  assert.equal(messages.length, 0);
  assert.deepEqual(calls, []);
  assert.equal(process.exitCode, 1);
});

test("json mode sends a displayed custom message, never stderr/stdout text", (t) => {
  const written = capture(t);
  process.exitCode = undefined;
  const { pi, messages } = stubPi();
  const { ctx, calls } = stubCtx({ hasUI: false, mode: "json" });
  emitReport(pi, ctx, "report text", true);
  assert.deepEqual(messages, [{ customType: REPORT_CUSTOM_TYPE, content: "report text", display: true }]);
  assert.equal(written.length, 0);
  assert.deepEqual(calls, []);
  assert.equal(process.exitCode, 1);
});

test("successful runs leave the exit code alone", (t) => {
  capture(t);
  process.exitCode = undefined;
  const { pi } = stubPi();
  emitReport(pi, stubCtx({ hasUI: false, mode: "print" }).ctx, "ok", false);
  emitReport(pi, stubCtx({ hasUI: false, mode: "json" }).ctx, "ok", false);
  assert.equal(process.exitCode, undefined);
});

test("tui and rpc send a displayed message plus a notification and leave the exit code alone", (t) => {
  const written = capture(t);
  for (const mode of ["tui", "rpc"]) {
    process.exitCode = undefined;
    const { pi, messages } = stubPi();
    const { ctx, calls } = stubCtx({ hasUI: true, mode });
    emitReport(pi, ctx, { text: "full report", summary: "GUI setup docker-linux: failed" }, true);
    assert.equal(messages[0].content, "full report");
    assert.equal(messages[0].display, true);
    assert.deepEqual(calls, [["notify", "GUI setup docker-linux: failed", "error"]]);
    assert.equal(process.exitCode, undefined);
  }
  assert.equal(written.length, 0);
});

test("Z14: after applied fixes, the report still lists every remaining step with its guidance", () => {
  const failing = [
    { id: "image.base", required: true, status: "fail", observed: "missing", remediation: { summary: "Build the base image", command: ["docker", "build", "-"], estimatedSeconds: 300 } },
    { id: "pi.version", required: true, status: "fail", observed: "1.3.0", remediation: { summary: "Update Pi to 1.4.0 or newer", manual: true } },
  ];
  const plan = buildRemediationPlan(failing, false);
  const text = renderReport({
    kind: "setup",
    backend: "docker-linux",
    status: "needs-user-action",
    message: "1 step(s) need you; do them, then run /gui-setup docker-linux again",
    results: failing,
    plan,
    applied: [{ checkId: "image.base", command: ["docker", "build", "-"], ok: true, observed: "exit 0 in 10 ms" }],
    manual: plan.items.filter((i) => !i.automated),
    degraded: [],
    durationMs: 10,
  });
  assert.match(text, /Fixes applied:\n- image\.base: ok/);
  assert.match(text, /Remaining steps:\nSteps you need to do yourself:\n- pi\.version: Update Pi to 1\.4\.0 or newer\n {4}\(needs a password or your judgement\)/);
  assert.doesNotMatch(text.split("Remaining steps:")[1], /image\.base/, "applied fixes are not repeated as remaining");
});
