import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckGraphError, endpointFromFacts, orderChecks, requiredChecksPass, runChecks } from "../../../src/checks/runner.ts";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(id, run, extra = {}) {
  return { id, description: id, kind: "observe", required: true, run, ...extra };
}
const pass = (observed = "ok", facts) => async () => (facts ? { status: "pass", observed, facts } : { status: "pass", observed });
const fail = (observed = "bad") => async () => ({ status: "fail", observed });

function options(extra = {}) {
  return { runner: new FakeCommandRunner(), backend: "docker-linux", projectRoot: "/p", signal: new AbortController().signal, ...extra };
}

test("orderChecks validates the graph", () => {
  assert.deepEqual(orderChecks([check("b", pass(), { dependsOn: ["a"] }), check("a", pass())]), ["a", "b"]);
  assert.throws(() => orderChecks([check("a", pass()), check("a", pass())]), (e) => e instanceof CheckGraphError && /duplicate/.test(e.message));
  assert.throws(() => orderChecks([check("a", pass(), { dependsOn: ["x"] })]), /unknown check "x"/);
  assert.throws(() => orderChecks([check("a", pass(), { dependsOn: ["a"] })]), /depends on itself/);
  assert.throws(
    () => orderChecks([check("a", pass(), { dependsOn: ["c"] }), check("b", pass(), { dependsOn: ["a"] }), check("c", pass(), { dependsOn: ["b"] })]),
    /dependency cycle: a → c → b → a/,
  );
});

test("runChecks rejects an invalid graph before running anything", async () => {
  let ran = false;
  await assert.rejects(
    runChecks([check("a", async () => ((ran = true), { status: "pass", observed: "" }), { dependsOn: ["zzz"] })], options()),
    CheckGraphError,
  );
  assert.equal(ran, false);
});

test("runs dependencies first and independent checks in parallel; results keep declaration order", async () => {
  // Parallelism is proven by overlap, not by wall-clock time (a time bound flaked under load):
  // a and b each wait until both have started. A runner that ran them one after the other
  // would never release the first one, which then gives up after 5 s and records no overlap.
  const events = [];
  let running = 0;
  let maxRunning = 0;
  let releaseBoth;
  const bothStarted = new Promise((resolve) => (releaseBoth = resolve));
  let started = 0;
  const overlapping = (id) => async (ctx) => {
    events.push(`start ${id}`);
    running++;
    maxRunning = Math.max(maxRunning, running);
    if (++started === 2) releaseBoth(true);
    let timer;
    const overlapped = await Promise.race([bothStarted, new Promise((resolve) => (timer = setTimeout(resolve, 5_000, false)))]);
    clearTimeout(timer);
    running--;
    events.push(`end ${id}`);
    return { status: "pass", observed: overlapped ? "overlapped" : "ran alone", facts: { [id]: String(ctx.dependencies.size) } };
  };
  const dependent = async (ctx) => {
    events.push(`start c (${running} running)`);
    return { status: "pass", observed: "c", facts: { c: String(ctx.dependencies.size) } };
  };
  const results = await runChecks(
    [
      check("c", dependent, { dependsOn: ["a", "b"] }),
      check("a", overlapping("a")),
      check("b", overlapping("b")),
    ],
    options(),
  );
  assert.deepEqual(results.map((r) => r.id), ["c", "a", "b"]);
  assert.equal(maxRunning, 2, "a and b ran at the same time");
  assert.deepEqual(results.slice(1).map((r) => r.observed), ["overlapped", "overlapped"]);
  const startC = events.indexOf("start c (0 running)");
  assert.ok(startC > events.indexOf("end a") && startC > events.indexOf("end b"), `c starts after a and b ended: ${events.join(", ")}`);
  assert.equal(results[0].facts.c, "2", "dependent sees its dependency results");
  assert.ok(results.every((r) => r.status === "pass" && typeof r.durationMs === "number"));
});

test("dependents of fail or blocked checks are blocked with blockedBy", async () => {
  const results = await runChecks(
    [
      check("cli", fail("docker: not found")),
      check("daemon", pass(), { dependsOn: ["cli"] }),
      check("image", pass(), { dependsOn: ["daemon", "ok"] }),
      check("ok", pass()),
    ],
    options(),
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.cli.status, "fail");
  assert.equal(byId.cli.observed, "docker: not found");
  assert.deepEqual([byId.daemon.status, byId.daemon.blockedBy], ["blocked", ["cli"]]);
  assert.deepEqual([byId.image.status, byId.image.blockedBy], ["blocked", ["daemon"]]);
  assert.equal(byId.ok.status, "pass");
  assert.equal(requiredChecksPass(results), false);
});

test("optional failures become warn with degrades and still block their dependents; remediation is attached on failure", async () => {
  const remediation = { summary: "install at-spi", command: ["sudo", "pacman", "-S", "at-spi2-core"], needsSudo: true };
  const results = await runChecks(
    [
      check("atspi", fail("missing"), { required: false, degrades: "no accessibility tree", remediation }),
      check("pyatspi", pass(), { required: false, dependsOn: ["atspi"] }),
      check("fine", pass(), { remediation }),
    ],
    options(),
  );
  const [atspi, pyatspi, fine] = results;
  assert.equal(atspi.status, "warn");
  assert.equal(atspi.degrades, "no accessibility tree");
  assert.deepEqual(atspi.remediation, remediation);
  assert.equal(pyatspi.status, "blocked");
  assert.equal(fine.remediation, undefined, "no remediation on a passing check");
  assert.equal(requiredChecksPass(results), true);
});

test("a check that exceeds its timeout fails, even if it ignores its signal; its signal is aborted", async () => {
  let sawAbort = false;
  const results = await runChecks(
    [
      check("slow", async (ctx) => {
        ctx.signal.addEventListener("abort", () => (sawAbort = true));
        await sleep(1000);
        return { status: "pass", observed: "late" };
      }, { timeoutMs: 30 }),
    ],
    options(),
  );
  assert.equal(results[0].status, "fail");
  assert.match(results[0].observed, /timed out after 30 ms/);
  assert.ok(results[0].durationMs < 500);
  assert.equal(sawAbort, true);
});

test("a check that throws or returns garbage fails with the reason as observed", async () => {
  const results = await runChecks(
    [
      check("throws", async () => {
        throw new Error("permission denied while connecting to the Docker daemon socket");
      }),
      check("sync-throw", () => {
        throw new Error("sync boom");
      }),
      check("garbage", async () => ({ status: "maybe" })),
    ],
    options(),
  );
  assert.deepEqual(results.map((r) => r.status), ["fail", "fail", "fail"]);
  assert.match(results[0].observed, /permission denied/);
  assert.equal(results[1].observed, "sync boom");
  assert.match(results[2].observed, /invalid outcome/);
});

test("required checks may warn without failing the run", async () => {
  const results = await runChecks([check("docker.version", async () => ({ status: "warn", observed: "31.0.0 (untested major)" }))], options());
  assert.equal(results[0].status, "warn");
  assert.equal(requiredChecksPass(results), true);
});

test("aborting the outer signal rejects the run and aborts running checks", async () => {
  const controller = new AbortController();
  let checkSignal;
  const run = runChecks(
    [check("long", async (ctx) => {
      checkSignal = ctx.signal;
      await sleep(1000);
      return { status: "pass", observed: "" };
    })],
    options({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(new Error("setup cancelled")), 20);
  await assert.rejects(run, /setup cancelled/);
  assert.equal(checkSignal.aborted, true);
  await assert.rejects(runChecks([check("x", pass())], options({ signal: AbortSignal.abort() })));
});

test("checks after docker.endpoint receive the endpoint from its facts", async () => {
  let seen;
  await runChecks(
    [
      check("docker.endpoint", pass("unix:///var/run/docker.sock", { context: "default", host: "unix:///var/run/docker.sock" })),
      check("docker.version", async (ctx) => {
        seen = ctx.dockerEndpoint;
        return { status: "pass", observed: "29.9.1" };
      }, { dependsOn: ["docker.endpoint"] }),
    ],
    options(),
  );
  assert.deepEqual(seen, { context: "default", host: "unix:///var/run/docker.sock" });
  assert.equal(endpointFromFacts(new Map([["docker.endpoint", { status: "fail", facts: { context: "a", host: "b" } }]])), undefined);
});

test("onResult reports each result as it completes", async () => {
  const seen = [];
  await runChecks([check("a", pass()), check("b", fail(), { dependsOn: ["a"] })], options({ onResult: (r) => seen.push(`${r.id}:${r.status}`) }));
  assert.deepEqual(seen, ["a:pass", "b:fail"]);
});
