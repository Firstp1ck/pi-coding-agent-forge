/**
 * Integration wiring of the post-M1 backends through the unchanged runtime,
 * tools, and commands, with fake backends that have the remote-host and
 * billing capabilities: host resolution (`--host` → `remote.host` → picker
 * with a UI only), remote sudo, doctor `--host`, the billing acknowledgement
 * (`--accept-billing` or one confirm; never a prompt without a UI), flag
 * refusals, launch warnings and workspace descriptions, the cost hook, the
 * config dir handed to factories, and a startup sweep that runs no command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../src/backends/registry.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeBackendEntry } from "../backends/fake-backend.mjs";

const OK = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 0 };

/**
 * A fake `remote-linux`: the fake helper backend plus `forHost`/`remoteHost`
 * (host-bound views; the shared backend has no host), remote sudo, and a
 * package check fixed with sudo. `options.wrapChecks(host, checks)` may add checks.
 */
function remoteEntry(options = {}) {
  const fake = fakeBackendEntry({ id: "remote-linux" });
  const log = { forHost: [], hostsAtChecks: [], sudo: [], applied: [], hostsAtStart: [], hostsAtSweep: [] };
  let installed = false;
  const create = fake.entry.create;
  /** A copy of `from` bound to `host`; methods that need the host read their own copy's. */
  const view = (from, host) => {
    const backend = { ...from };
    Object.defineProperty(backend, "remoteHost", { value: host, enumerable: true });
    backend.forHost = (h) => {
      log.forHost.push(h);
      if (h !== undefined && /\s/.test(h)) throw new Error(`"${h}" is not a usable SSH destination`);
      return view(backend, h === "" ? undefined : h);
    };
    backend.passwordlessSudo = async () => (log.sudo.push(host), true);
    backend.runner = { run: async (argv) => (log.applied.push([host, ...argv]), (installed = true), OK) };
    backend.checks = () => {
      log.hostsAtChecks.push(host);
      const checks = [
        ...from.baseChecks(),
        {
          id: "remote.pkg",
          description: "a package on the remote host",
          kind: "observe",
          required: true,
          remediation: { summary: "install it on the remote host", command: ["ssh", "host", "sudo", "-n", "apt-get", "install", "xvfb"], needsSudo: true },
          run: async () => (installed ? { status: "pass", observed: "installed", facts: { "remote.host": host ?? "" } } : { status: "fail", observed: "missing" }),
        },
      ];
      return options.wrapChecks ? options.wrapChecks(host, checks) : checks;
    };
    backend.smokeConfig = (base) => (host ? { ...base, remote: { host } } : base);
    backend.smokeApp = () => ({ cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] });
    backend.startSession = async (start) => (log.hostsAtStart.push(start.config.remote?.host ?? host), from.baseStart(start));
    backend.sweepOrphans = async (signal) => (log.hostsAtSweep.push(host), from.baseSweep(signal));
    backend.sweepAvailable = async (context) => !context.startup && host !== undefined;
    return backend;
  };
  fake.entry.create = (ctx) => {
    const raw = create(ctx);
    return view({ ...raw, baseChecks: raw.checks, baseStart: raw.startSession, baseSweep: raw.sweepOrphans }, undefined);
  };
  return { ...fake, log };
}

/** A fake `cua`: billing capability, a cost-ack check reading the fake settings, and a cost estimate. */
function billingEntry(options = {}) {
  const fake = fakeBackendEntry({ id: "cua" });
  const state = { location: options.location ?? "aws", ack: undefined, recorded: [], targets: [], cost: options.cost };
  const create = fake.entry.create;
  fake.entry.create = (ctx) => {
    const backend = create(ctx);
    state.ctx = ctx;
    backend.billingStatus = async (inputs) => {
      const location = inputs.location ?? state.location;
      if (!location) return { acknowledged: false, problem: "no cloud connected" };
      return { location, acknowledged: state.ack === location, text: `Each GUI session creates one sandbox in your ${location} account, which bills it.` };
    };
    backend.recordSetupInputs = async (inputs) => {
      state.recorded.push(inputs);
      if (inputs.location) state.location = inputs.location;
      if (inputs.acknowledgedLocation) state.ack = inputs.acknowledgedLocation;
    };
    backend.estimateCost = () => state.cost;
    const checks = backend.checks;
    backend.checks = () => [
      ...checks(),
      {
        id: "cua.targets",
        description: "targets",
        kind: "observe",
        required: true,
        run: async (c) => (state.targets.push(c.targets), { status: "pass", observed: String(c.targets ?? "project") }),
      },
      {
        id: "cua.cost-ack",
        description: "billing acknowledged",
        kind: "observe",
        required: true,
        remediation: { summary: "Confirm at /gui-setup cua, or pass --accept-billing", manual: true },
        run: async () => (state.ack === state.location ? { status: "pass", observed: `acknowledged for ${state.ack}` } : { status: "fail", observed: "not acknowledged" }),
      },
    ];
    return backend;
  };
  return { ...fake, state };
}

/** A fake `local-linux` whose sessions report a workspace description and launch warnings. */
function describingEntry() {
  const fake = fakeBackendEntry({ id: "local-linux" });
  const create = fake.entry.create;
  fake.entry.create = (ctx) => {
    const backend = create(ctx);
    const start = backend.startSession.bind(backend);
    backend.startSession = async (options) => {
      const session = await start(options);
      Object.defineProperty(session, "workspaceDescription", { value: "the project directory itself (writable)" });
      Object.defineProperty(session, "warnings", { value: ["local-linux never runs setup commands; the 1 setup command(s) in .pi/gui.json were skipped"] });
      return session;
    };
    return backend;
  };
  return fake;
}

async function wiringEnv(t, entries, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-wiring-"));
  const project = join(root, "project");
  const tmp = join(root, "tmp");
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(tmp);
  await mkdir(join(root, "agent", "gui"), { recursive: true });
  await writeFile(join(project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "app" }, ...options.shared }));
  if (options.local) await writeFile(join(project, ".pi", "gui.local.json"), JSON.stringify(options.local));
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, verified: {}, ...options.global }));
  const dockerCalls = [];
  const dockerRunner = { run: async (argv) => (dockerCalls.push(argv.join(" ")), { ...OK, exitCode: 1 }) };
  const picks = [];
  const runtime = new GuiRuntime({
    registry: new BackendRegistry([DEFAULT_REGISTRY.entry("docker-linux"), ...entries.map((e) => e.entry)]),
    tmpRoot: tmp,
    globalConfigPath,
    docker: { runner: dockerRunner, endpointSource: {} },
    dockerOnPath: async () => false,
    hostPicker: async (_ui, opts) => (picks.push(opts.backend), options.pick === undefined ? { host: "picked-host", template: "Host picked-host\n    HostName 192.0.2.7" } : options.pick),
  });
  const exitCode = process.exitCode;
  t.after(async () => {
    await runtime.shutdown();
    process.exitCode = exitCode;
    await rm(root, { recursive: true, force: true });
  });
  const messages = [];
  const uiCalls = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, runtime).map((c) => [c.name, c]));
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = (overrides = {}) => ({
    cwd: project,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "pi-wiring" },
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async (...args) => (uiCalls.push(["select", ...args]), overrides.answers?.select),
      confirm: async (...args) => (uiCalls.push(["confirm", ...args]), overrides.answers?.confirm ?? false),
      input: async (...args) => (uiCalls.push(["input", ...args]), undefined),
    },
    ...overrides,
  });
  const global = async () => JSON.parse(await readFile(globalConfigPath, "utf8"));
  const local = async () => JSON.parse(await readFile(join(project, ".pi", "gui.local.json"), "utf8"));
  const last = () => messages.at(-1)?.content ?? "";
  return { root, project, tmp, runtime, commands, tools, ctx, messages, uiCalls, global, local, last, picks, dockerCalls, globalConfigPath };
}

test("I: /gui-setup --host wins over a stored remote.host; the alias, purgeTooling, and inputs.host are stored; remote sudo plans the fix", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote], { global: { remote: { host: "stored-host" } } });
  await env.commands["gui-setup"].handler("remote-linux --host raspi5 --fix", env.ctx());
  assert.match(env.last(), /remote-linux is set up and verified/);
  assert.equal(remote.log.forHost.at(0), "raspi5");
  assert.deepEqual(remote.log.hostsAtChecks, ["raspi5"], "checks see the host before they run");
  assert.deepEqual(remote.log.sudo, ["raspi5"], "remote sudo is asked, not the client's sudo");
  assert.deepEqual(remote.log.applied, [["raspi5", "ssh", "host", "sudo", "-n", "apt-get", "install", "xvfb"]]);
  assert.deepEqual(env.picks, [], "no picker with --host");
  assert.deepEqual(env.uiCalls, []);
  const global = await env.global();
  assert.equal(global.backend, "remote-linux");
  assert.deepEqual(global.remote, { host: "raspi5" });
  assert.equal(global.verified["remote-linux"].inputs.host, "raspi5");
  assert.equal(global.verified["remote-linux"].toolVersions["remote.host"], "raspi5");
});

test("I: /gui-setup takes remote.host from .pi/gui.local.json without prompting; --project stores the host there", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote], { local: { remote: { host: "lab-box" } }, global: { remote: { host: "global-host" } } });
  await env.commands["gui-setup"].handler("remote-linux --project --fix", env.ctx({ hasUI: true, mode: "rpc", answers: { confirm: false } }));
  assert.match(env.last(), /remote-linux is set up and verified/);
  assert.deepEqual(remote.log.hostsAtChecks, ["lab-box"], "local file before global config");
  assert.deepEqual(env.picks, []);
  const local = await env.local();
  assert.equal(local.backend, "remote-linux");
  assert.equal(local.remote.host, "lab-box");
  assert.deepEqual((await env.global()).remote, { host: "global-host" }, "the global config is untouched");
});

test("I: without a host and without a UI, /gui-setup fails with the --host hint and never opens the picker", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote]);
  process.exitCode = undefined;
  await env.commands["gui-setup"].handler("remote-linux", env.ctx());
  assert.match(env.last(), /\/gui-setup remote-linux needs an SSH host when there is no interactive UI; run \/gui-setup remote-linux --host <ssh-alias-or-user@host>/);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(env.picks, []);
  assert.deepEqual(env.uiCalls, []);
  assert.deepEqual(remote.log.hostsAtChecks, [], "no check ran");
  assert.equal((await env.global()).backend, undefined, "nothing stored");
});

test("I: without a host, an interactive /gui-setup opens the picker; its alias is stored and the template is shown", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote]);
  await env.commands["gui-setup"].handler("remote-linux --fix", env.ctx({ hasUI: true, mode: "rpc" }));
  assert.deepEqual(env.picks, ["remote-linux"]);
  assert.match(env.last(), /remote-linux is set up and verified/);
  assert.match(env.last(), /add this block to ~\/\.ssh\/config \(the package never writes it\):\nHost picked-host/);
  assert.deepEqual((await env.global()).remote, { host: "picked-host" });

  const cancelled = await wiringEnv(t, [remoteEntry()], { pick: null });
  await cancelled.commands["gui-setup"].handler("remote-linux", cancelled.ctx({ hasUI: true, mode: "rpc" }));
  assert.match(cancelled.last(), /GUI setup cancelled; nothing was changed/);
});

test("I: an invalid host is refused before any check; --host and --purge-tooling are refused on backends they do not fit", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote]);
  await env.commands["gui-setup"].handler('remote-linux --host "bad host"', env.ctx());
  assert.match(env.last(), /"bad host" is not a usable SSH destination/);
  assert.deepEqual(remote.log.hostsAtChecks, []);
  await env.commands["gui-setup"].handler("docker-linux --host raspi5", env.ctx());
  assert.match(env.last(), /--host only applies to the remote backends \(remote-linux, remote-linux-docker\), not docker-linux/);
  await env.commands["gui-setup"].handler("remote-linux --host raspi5 --purge-tooling", env.ctx());
  assert.match(env.last(), /--purge-tooling only applies to remote-linux-docker, not remote-linux/);
  assert.deepEqual(env.dockerCalls, []);
});

test("I: /gui-doctor checks the configured host; --host checks another host without touching the verified state", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote], { global: { remote: { host: "raspi5" } } });
  await env.commands["gui-setup"].handler("remote-linux --fix", env.ctx());
  const verified = (await env.global()).verified["remote-linux"];
  assert.equal(verified.inputs.host, "raspi5");

  await env.commands["gui-doctor"].handler("remote-linux", env.ctx());
  assert.equal(remote.log.hostsAtChecks.at(-1), "raspi5");
  assert.match(env.last(), /remote-linux is healthy/);

  await env.commands["gui-doctor"].handler("remote-linux --host other-box", env.ctx());
  assert.equal(remote.log.hostsAtChecks.at(-1), "other-box");
  assert.match(env.last(), /checked other-box given by --host; the verified state is unchanged because the configured host is raspi5/);
  assert.match(env.last(), /remote-linux is healthy \(x86_64\); verified state unchanged/);
  assert.doesNotMatch(env.last(), /marked unverified/);
  const after = (await env.global()).verified["remote-linux"];
  assert.equal(after.inputs.host, "raspi5");
  assert.equal(after.verifiedAt, (await env.global()).verified["remote-linux"].verifiedAt);

  await env.commands["gui-doctor"].handler("docker-linux --host raspi5", env.ctx());
  assert.match(env.last(), /\/gui-doctor: --host only applies to the remote backends/);
});

test("I: gui_launch observes the configured host for drift; /gui-cleanup sweeps the configured host", async (t) => {
  const remote = remoteEntry();
  const env = await wiringEnv(t, [remote], { global: { remote: { host: "raspi5" } } });
  await env.commands["gui-setup"].handler("remote-linux --fix", env.ctx());
  // The fake reports remote.host as a fact; a changed remote.host is drift.
  const backend = env.runtime.backend("remote-linux");
  backend.currentVersions = async function () {
    return { "remote.host": this.remoteHost };
  };
  await writeFile(join(env.project, ".pi", "gui.local.json"), JSON.stringify({ remote: { host: "new-box" } }));
  await assert.rejects(env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx()), /changed since setup \(remote\.host raspi5 → new-box\); ask the user to run \/gui-doctor remote-linux/);
  await writeFile(join(env.project, ".pi", "gui.local.json"), JSON.stringify({}));
  const launched = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  assert.equal(remote.log.hostsAtStart.at(-1), "raspi5");
  await env.tools.gui_stop.execute("c", { session: launched.details.session }, undefined, undefined, env.ctx());

  assert.equal(backend.remoteHost, undefined, "the shared backend is never re-pointed");
  await env.commands["gui-cleanup"].handler("remote-linux", env.ctx());
  assert.deepEqual(remote.log.hostsAtSweep, ["raspi5"]);
  assert.match(env.last(), /GUI testing cleanup \(remote-linux\)/);
});

/** A barrier check for `host-A`: setup on that host waits in it until `release()`. */
function barrier() {
  let entered;
  let release;
  const inCheck = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const wrapChecks = (host, checks) =>
    host !== "host-A"
      ? checks
      : [...checks, { id: "barrier", description: "waits", kind: "observe", required: true, run: async () => (entered(), await gate, { status: "pass", observed: "released", facts: { "barrier.host": host } }) }];
  return { inCheck, release: () => release(), wrapChecks };
}

test("V1: /gui-doctor --host during a setup is refused before it can bind a host; the setup keeps its host to the end", async (t) => {
  const b = barrier();
  const remote = remoteEntry({ wrapChecks: b.wrapChecks });
  const env = await wiringEnv(t, [remote]);
  const setup = env.commands["gui-setup"].handler("remote-linux --host host-A --fix", env.ctx());
  await b.inCheck;
  await env.commands["gui-doctor"].handler("remote-linux --host host-B", env.ctx());
  assert.match(env.last(), /\/gui-setup is already running/);
  assert.ok(!remote.log.forHost.includes("host-B"), "a refused doctor binds no host");
  b.release();
  await setup;
  assert.match(env.last(), /remote-linux is set up and verified/);
  assert.deepEqual(remote.log.hostsAtStart, ["host-A"], "the smoke session runs on the setup's host");
  assert.ok(remote.log.hostsAtChecks.every((h) => h === "host-A"), `checks only saw host-A: ${remote.log.hostsAtChecks}`);
  const global = await env.global();
  assert.equal(global.verified["remote-linux"].inputs.host, "host-A");
  assert.equal(global.verified["remote-linux"].toolVersions["remote.host"], "host-A");
  assert.deepEqual(global.remote, { host: "host-A" });
  assert.equal(env.runtime.backend("remote-linux").remoteHost, undefined, "the shared backend is never re-pointed");
});

test("V1: gui_launch during a setup on another host starts on the configured host and does not redirect the setup", async (t) => {
  const b = barrier();
  const remote = remoteEntry({ wrapChecks: b.wrapChecks });
  const record = { verifiedAt: new Date().toISOString(), toolVersions: { "fake.version": "1" }, checksPassed: [], inputs: { backend: "remote-linux", host: "raspi5" } };
  const env = await wiringEnv(t, [remote], { global: { backend: "remote-linux", remote: { host: "raspi5" }, verified: { "remote-linux": record } } });
  const setup = env.commands["gui-setup"].handler("remote-linux --host host-A --fix --project", env.ctx());
  await b.inCheck;
  const launched = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  assert.deepEqual(remote.log.hostsAtStart, ["raspi5"], "the launch uses its own configured host");
  await env.tools.gui_stop.execute("c", { session: launched.details.session }, undefined, undefined, env.ctx());
  b.release();
  await setup;
  assert.match(env.last(), /remote-linux is set up and verified/);
  assert.deepEqual(remote.log.hostsAtStart, ["raspi5", "host-A"], "the setup's smoke session still runs on host-A");
  assert.ok(remote.log.hostsAtChecks.filter((h) => h !== undefined).every((h) => h === "host-A"), `setup checks only saw host-A: ${remote.log.hostsAtChecks}`);
  assert.equal((await env.local()).remote.host, "host-A");
});

test("I: billing without a UI and without --accept-billing never prompts and ends with needs-user-action", async (t) => {
  const cua = billingEntry();
  const env = await wiringEnv(t, [cua]);
  process.exitCode = undefined;
  await env.commands["gui-setup"].handler("cua", env.ctx());
  assert.deepEqual(env.uiCalls, []);
  assert.match(env.last(), /needs-user-action/);
  assert.match(env.last(), /Billing and upload are not acknowledged for aws; re-run with \/gui-setup cua --accept-billing/);
  assert.equal(cua.state.ack, undefined);
  assert.equal(process.exitCode, 1);
  assert.equal((await env.global()).verified.cua, undefined);
});

test("I: --accept-billing records the acknowledgement for the chosen cloud; --cloud, --rate-usd-per-hour, and --targets reach the backend", async (t) => {
  const cua = billingEntry();
  const env = await wiringEnv(t, [cua]);
  await env.commands["gui-setup"].handler("cua --accept-billing --cloud hetzner --rate-usd-per-hour 0.5 --targets linux", env.ctx());
  assert.match(env.last(), /cua is set up and verified/);
  assert.deepEqual(cua.state.recorded, [{ location: "hetzner", rateUsdPerHour: 0.5, acknowledgedLocation: "hetzner" }]);
  assert.deepEqual(cua.state.targets.at(-1), ["linux"], "checks get the --targets value");
  const inputs = (await env.global()).verified.cua.inputs;
  assert.equal(inputs.cloud, "hetzner");
  assert.equal(inputs.targets, "linux");
  assert.deepEqual(env.uiCalls, []);
});

test("I: interactive billing shows one confirm with the acknowledgement text; no means nothing changes", async (t) => {
  const cua = billingEntry();
  const env = await wiringEnv(t, [cua]);
  await env.commands["gui-setup"].handler("cua", env.ctx({ hasUI: true, mode: "rpc", answers: { confirm: false } }));
  const confirms = env.uiCalls.filter(([kind]) => kind === "confirm");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0][1], /Allow cua sessions to bill your aws account\?/);
  assert.match(confirms[0][2], /creates one sandbox in your aws account/);
  assert.match(env.last(), /billing and upload were not acknowledged; nothing was changed/);
  assert.deepEqual(cua.state.recorded, []);

  const yes = await wiringEnv(t, [billingEntry()]);
  await yes.commands["gui-setup"].handler("cua", yes.ctx({ hasUI: true, mode: "rpc", answers: { confirm: true } }));
  assert.match(yes.last(), /cua is set up and verified/);
  assert.equal(yes.uiCalls.filter(([kind]) => kind === "confirm").length, 1, "exactly one dialog");
});

test("I: --api-key-env is rejected with the cua sign-in explanation; cua-only flags are refused elsewhere", async (t) => {
  const cua = billingEntry();
  const env = await wiringEnv(t, [cua]);
  await env.commands["gui-setup"].handler("cua --api-key-env CUA_API_KEY --accept-billing", env.ctx());
  assert.match(env.last(), /--api-key-env is no longer used: cua uses your `cua auth login` session and needs no API key/);
  assert.deepEqual(cua.state.recorded, []);
  await env.commands["gui-setup"].handler("docker-linux --accept-billing --cloud aws", env.ctx());
  assert.match(env.last(), /--accept-billing, --cloud only apply to cua, not docker-linux/);
  await env.commands["gui-setup"].handler("cua --cloud azure", env.ctx());
  assert.match(env.last(), /unknown cloud "azure"; valid clouds: aws, gcp, hetzner, modal/);
  await env.commands["gui-setup"].handler("cua --rate-usd-per-hour -1", env.ctx());
  assert.match(env.last(), /--rate-usd-per-hour (must be a number|needs a value)/);
  assert.deepEqual(env.dockerCalls, []);
});

test("V14: --api-key-env on a backend other than cua is refused as not one of its options", async (t) => {
  const env = await wiringEnv(t, [billingEntry()]);
  for (const id of ["docker-linux", "cua"]) {
    await env.commands["gui-setup"].handler(`${id} --api-key-env MY_KEY`, env.ctx());
    if (id === "cua") assert.match(env.last(), /--api-key-env is no longer used: cua uses your `cua auth login` session/);
    else assert.match(env.last(), new RegExp(`^/gui-setup: --api-key-env is not an option of ${id}$`));
  }
  assert.deepEqual(env.dockerCalls, []);
});

test("V13: --image reaches the billing backend, is recorded in the verified inputs, and is refused elsewhere", async (t) => {
  const cua = billingEntry();
  const env = await wiringEnv(t, [cua]);
  await env.commands["gui-setup"].handler("cua --accept-billing --image ghcr.io/me/desktop:2", env.ctx());
  assert.match(env.last(), /cua is set up and verified/);
  assert.deepEqual(cua.state.recorded, [{ image: "ghcr.io/me/desktop:2", acknowledgedLocation: "aws" }]);
  assert.equal((await env.global()).verified.cua.inputs.image, "ghcr.io/me/desktop:2");
  await env.commands["gui-setup"].handler("docker-linux --image x", env.ctx());
  assert.match(env.last(), /--image only applies to cua, not docker-linux/);
  await env.commands["gui-setup"].handler("cua --image '-bad'", env.ctx());
  assert.match(env.last(), /--image must be an image alias or registry reference/);
});

test("I: the usage tracker gets the backend's cost estimate and the configured usageCheck thresholds", async (t) => {
  const cua = billingEntry({ cost: { sessionUsd: 2, dailyUsd: 6 } });
  const env = await wiringEnv(t, [cua], { global: { backend: "cua", verified: { cua: { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "fake.version": "1" }, checksPassed: [] } } } });
  const launched = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  assert.deepEqual(launched.details.usageWarning.map((w) => w.signal), ["session-cost", "daily-cost"]);
  await env.tools.gui_stop.execute("c", { session: launched.details.session }, undefined, undefined, env.ctx());

  await writeFile(join(env.project, ".pi", "gui.local.json"), JSON.stringify({ usageCheck: { warnSessionCostUsd: 10, warnDailyCostUsd: 10 } }));
  const quiet = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  assert.equal(quiet.details.usageWarning, undefined, "higher thresholds from the config: no warning");
  assert.equal(cua.state.ctx.configDir, join(env.root, "agent", "gui"), "factories get the runtime's config dir");
});

test("I: gui_launch shows the session's workspace description and launch warnings; the shared config is not changed", async (t) => {
  const local = describingEntry();
  const env = await wiringEnv(t, [local], { global: { backend: "local-linux", verified: { "local-linux": { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "fake.version": "1" }, checksPassed: [] } } } });
  const launched = await env.tools.gui_launch.execute("c", {}, undefined, undefined, env.ctx());
  const text = launched.content.map((c) => c.text).join("\n");
  assert.match(text, /workspace: the project directory itself \(writable\) at \/fake\/workspace/);
  assert.doesNotMatch(text, /read-only mount/);
  assert.match(text, /local-linux warnings:\n- local-linux never runs setup commands/);
  assert.doesNotMatch(text, /config warnings/);
  assert.deepEqual(launched.details.backendWarnings, ["local-linux never runs setup commands; the 1 setup command(s) in .pi/gui.json were skipped"]);
  assert.equal(launched.details.configWarnings, undefined);
});

test("I: the real cua factory keeps its ledger and settings in the runtime's config dir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-cua-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new GuiRuntime({ globalConfigPath: join(root, "agent", "gui", "config.json"), tmpRoot: root });
  const cua = runtime.backend("cua");
  assert.equal(cua.ledger.dir, join(root, "agent", "gui", "cua-sandboxes"));
  assert.equal(cua.settings.path, join(root, "agent", "gui", "cua.json"));
});

test("I: the startup sweep over all seven registered backends runs no command and makes no network call on a host without the tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-sweep-"));
  const empty = join(root, "bin");
  await mkdir(empty);
  const spawned = [];
  const saved = { ...childProcess };
  const savedFetch = globalThis.fetch;
  const savedPath = process.env.PATH;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    childProcess[name] = (...args) => {
      spawned.push([name, args[0]]);
      throw new Error(`unexpected ${name}`);
    };
  }
  syncBuiltinESMExports();
  globalThis.fetch = async (url) => {
    spawned.push(["fetch", String(url)]);
    throw new Error("unexpected fetch");
  };
  process.env.PATH = empty;
  t.after(async () => {
    Object.assign(childProcess, saved);
    syncBuiltinESMExports();
    globalThis.fetch = savedFetch;
    process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "tmp"));
  const runtime = new GuiRuntime({ globalConfigPath: join(root, "agent", "gui", "config.json"), tmpRoot: join(root, "tmp") });
  assert.deepEqual(runtime.registry.ids, ["docker-linux", "local-linux", "remote-linux", "remote-linux-docker", "cua", "local-windows", "docker-windows"]);
  // A machine that once set up docker-windows: its startup gate still needs docker on PATH, and local-windows needs win32.
  await mkdir(join(root, "agent", "gui", "docker-windows"), { recursive: true });
  const report = await runtime.sweep();
  assert.ok(report, "the sweep finished");
  assert.deepEqual(report.leftovers, []);
  // No docker on PATH, remote backends never sweep at startup, cua has no ledger record, local-windows needs a Windows host: nothing external runs.
  assert.deepEqual(await runtime.sweepableBackends(runtime.registry.ids, { startup: true }), process.platform === "linux" ? ["local-linux"] : []);
  assert.deepEqual(spawned, []);
  await runtime.shutdown();
  assert.deepEqual(spawned, []);
  // Control: the interception sees the package's own spawn runner.
  const { createSpawnRunner } = await import("../../../src/runner/spawn.ts");
  await createSpawnRunner().run(["docker", "info"], { timeoutMs: 1_000 }).catch(() => undefined);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][1], "docker");
});
