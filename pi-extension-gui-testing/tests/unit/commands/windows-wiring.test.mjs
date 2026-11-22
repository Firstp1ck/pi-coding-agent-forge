/**
 * Integration wiring of the Windows backends through the unchanged runtime,
 * tools, and commands, with fake backends that have the licensing, VM
 * settings, and remediation capabilities: `--accept-windows-license` or one
 * confirm (never a prompt without a UI), the VM size flags, remediations the
 * backend runs itself, cua's Windows flags, the `gui_launch` target reaching
 * the backend, and the smoke test's Windows wording and isolation assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiCommands } from "../../../src/commands/commands.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../src/backends/registry.ts";
import { runSmokeTest, smokeAppName } from "../../../src/setup/smoke.ts";
import { GuiRuntime } from "../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../src/tools/tools.ts";
import { fakeBackendEntry } from "../backends/fake-backend.mjs";

const OK = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 0 };
const VERIFIED_FAKE = { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "fake.version": "1" }, checksPassed: [] };

/**
 * A fake `docker-windows`: licensing (`licenseStatus` with pending VM values,
 * `acknowledgeLicense`), `setVm` with the backend's ranges, a `license.ack`
 * check, and a `vm.installed` check whose displayed command must never run:
 * only `remediate` installs.
 */
function windowsEntry(options = {}) {
  const fake = fakeBackendEntry({ id: "docker-windows" });
  fake.entry.targets = ["windows"];
  const state = { ack: options.acknowledged ?? false, vm: {}, setVm: [], pending: [], remediated: [], runnerCalls: [], installed: options.installed ?? false };
  const create = fake.entry.create;
  fake.entry.create = (ctx) => {
    const backend = create(ctx);
    backend.licenseStatus = async (pending) => {
      state.pending.push(pending);
      const vm = { version: "11", ramGb: 4, diskGb: 64, ...state.vm, ...pending };
      return { acknowledged: state.ack, text: `You license Windows ${vm.version} yourself (${vm.diskGb} GB disk, ${vm.ramGb} GB RAM).` };
    };
    backend.acknowledgeLicense = async () => void (state.ack = true);
    backend.setVm = async (vm) => {
      state.setVm.push(vm);
      if (vm.ramGb !== undefined && vm.ramGb > 512) throw new Error("vm.ramGb must be a whole number from 2 to 512");
      state.vm = { ...state.vm, ...vm };
      return state.vm;
    };
    backend.remediate = (checkId, _signal, onLine) => {
      if (checkId !== "vm.installed") return undefined;
      state.remediated.push(checkId);
      onLine?.("Windows install (3 min): copying files");
      state.installed = true;
      return Promise.resolve(OK);
    };
    backend.runner = { run: async (argv) => (state.runnerCalls.push(argv), { ...OK, exitCode: 1 }) };
    const checks = backend.checks;
    backend.checks = () => [
      ...checks(),
      {
        id: "license.ack",
        description: "licensing acknowledged",
        kind: "observe",
        required: true,
        remediation: { summary: "run /gui-setup docker-windows --accept-windows-license", manual: true },
        run: async () => (state.ack ? { status: "pass", observed: "acknowledged" } : { status: "fail", observed: "not acknowledged" }),
      },
      {
        id: "vm.installed",
        description: "Windows installed",
        kind: "observe",
        required: true,
        dependsOn: ["license.ack"],
        remediation: { summary: "Install Windows unattended", command: ["docker", "run", "<owner>", "<oem>"], timeoutMs: 60_000 },
        run: async () => (state.installed ? { status: "pass", observed: "installed" } : { status: "fail", observed: "not installed" }),
      },
    ];
    return backend;
  };
  return { ...fake, state };
}

/** A fake `cua` with billing and a Windows image, like the real one's `billingStatus`. */
function cuaEntry() {
  const fake = fakeBackendEntry({ id: "cua" });
  fake.entry.targets = ["linux", "windows"];
  const state = { recorded: [] };
  const create = fake.entry.create;
  fake.entry.create = (ctx) => {
    const backend = create(ctx);
    backend.billingStatus = async (inputs) => ({ location: "aws", acknowledged: true, text: "bills aws", image: inputs.image ?? "linux", windowsImage: inputs.windowsImage ?? "windows" });
    backend.recordSetupInputs = async (inputs) => void state.recorded.push(inputs);
    return backend;
  };
  return { ...fake, state };
}

async function wiringEnv(t, entries, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-win-wiring-"));
  const project = join(root, "project");
  const tmp = join(root, "tmp");
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(tmp);
  await mkdir(join(root, "agent", "gui"), { recursive: true });
  await writeFile(join(project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "app" }, ...options.shared }));
  await writeFile(globalConfigPath, JSON.stringify({ version: 1, verified: {}, ...options.global }));
  const dockerCalls = [];
  const runtime = new GuiRuntime({
    registry: new BackendRegistry([DEFAULT_REGISTRY.entry("docker-linux"), ...entries.map((e) => e.entry)]),
    tmpRoot: tmp,
    globalConfigPath,
    docker: { runner: { run: async (argv) => (dockerCalls.push(argv.join(" ")), { ...OK, exitCode: 1 }) }, endpointSource: {} },
    dockerOnPath: async () => false,
  });
  const exitCode = process.exitCode;
  t.after(async () => {
    await runtime.shutdown();
    process.exitCode = exitCode;
    await rm(root, { recursive: true, force: true });
  });
  const messages = [];
  const uiCalls = [];
  const statuses = [];
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, runtime).map((c) => [c.name, c]));
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = (overrides = {}) => ({
    cwd: project,
    hasUI: false,
    mode: "json",
    sessionManager: { getSessionId: () => "pi-win-wiring" },
    ui: {
      notify: () => {},
      setStatus: (_key, text) => statuses.push(text),
      select: async (...args) => (uiCalls.push(["select", ...args]), undefined),
      confirm: async (...args) => (uiCalls.push(["confirm", ...args]), overrides.answers?.confirm ?? false),
      input: async (...args) => (uiCalls.push(["input", ...args]), undefined),
    },
    ...overrides,
  });
  const global = async () => JSON.parse(await readFile(globalConfigPath, "utf8"));
  const last = () => messages.at(-1)?.content ?? "";
  return { root, project, runtime, commands, tools, ctx, uiCalls, statuses, global, last, dockerCalls };
}

test("WI: docker-windows without a UI and without --accept-windows-license never prompts and ends with needs-user-action", async (t) => {
  const win = windowsEntry();
  const env = await wiringEnv(t, [win]);
  process.exitCode = undefined;
  await env.commands["gui-setup"].handler("docker-windows --fix", env.ctx());
  assert.deepEqual(env.uiCalls, []);
  assert.match(env.last(), /needs-user-action/);
  assert.match(env.last(), /The Windows licensing notice is not acknowledged; re-run with \/gui-setup docker-windows --accept-windows-license/);
  assert.equal(win.state.ack, false);
  assert.deepEqual(win.state.remediated, [], "the install is blocked by license.ack, so it never starts");
  assert.equal(process.exitCode, 1);
  assert.equal((await env.global()).verified["docker-windows"], undefined);
});

test("WI: --accept-windows-license acknowledges, the install runs through remediate (never the displayed command), and the record says so", async (t) => {
  const win = windowsEntry();
  const env = await wiringEnv(t, [win]);
  await env.commands["gui-setup"].handler("docker-windows --accept-windows-license --fix", env.ctx({ hasUI: true, mode: "rpc" }));
  assert.match(env.last(), /docker-windows is set up and verified/);
  assert.equal(win.state.ack, true);
  assert.deepEqual(win.state.remediated, ["vm.installed"]);
  assert.deepEqual(win.state.runnerCalls, [], "the placeholder command is never run");
  assert.ok(env.statuses.includes("Windows install (3 min): copying files"), "progress lines become the status");
  assert.equal((await env.global()).verified["docker-windows"].inputs.windowsLicense, "acknowledged");
  assert.deepEqual(env.uiCalls, []);
});

test("WI: interactive setup shows one licensing confirm with the backend's text and pending VM sizes; no changes nothing", async (t) => {
  const win = windowsEntry();
  const env = await wiringEnv(t, [win]);
  await env.commands["gui-setup"].handler("docker-windows --vm-disk-gb 128 --windows-version 10", env.ctx({ hasUI: true, mode: "rpc", answers: { confirm: false } }));
  const confirms = env.uiCalls.filter(([kind]) => kind === "confirm");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0][1], /Acknowledge Windows licensing\?/);
  assert.match(confirms[0][2], /You license Windows 10 yourself \(128 GB disk, 4 GB RAM\)/, "the text shows the sizes the flags choose");
  assert.match(env.last(), /the Windows licensing notice was not acknowledged; nothing was changed/);
  assert.equal(win.state.ack, false);
  assert.deepEqual(win.state.setVm, [], "a declined confirm stores no VM settings");

  const yes = await wiringEnv(t, [windowsEntry()]);
  await yes.commands["gui-setup"].handler("docker-windows --fix", yes.ctx({ hasUI: true, mode: "rpc", answers: { confirm: true } }));
  assert.match(yes.last(), /docker-windows is set up and verified/);
  assert.equal(yes.uiCalls.filter(([kind]) => kind === "confirm").length, 1, "exactly one licensing dialog (--fix approves the install)");
  assert.equal(yes.last().includes("licensing notice is not acknowledged"), false);
});

test("WI: an earlier acknowledgement asks nothing; the VM flags are stored before the checks, with the reinstall note", async (t) => {
  const win = windowsEntry({ acknowledged: true, installed: true });
  const env = await wiringEnv(t, [win]);
  await env.commands["gui-setup"].handler("docker-windows --vm-ram-gb 8 --vm-cpus 4 --vm-disk-gb 100 --windows-version 2025", env.ctx({ hasUI: true, mode: "rpc" }));
  assert.match(env.last(), /docker-windows is set up and verified/);
  assert.deepEqual(env.uiCalls.filter(([kind]) => kind === "confirm"), []);
  assert.deepEqual(win.state.setVm, [{ version: "2025", ramGb: 8, cpuCores: 4, diskGb: 100 }]);
  assert.match(env.last(), /VM settings stored: version 2025, ramGb 8, cpuCores 4, diskGb 100\./);
  assert.match(env.last(), /--windows-version and --vm-disk-gb apply when Windows is installed; if it is installed already, run \/gui-reset docker-windows/);
  assert.match(env.last(), /RAM and CPU apply to every new session/);

  const ram = await wiringEnv(t, [windowsEntry({ acknowledged: true, installed: true })]);
  await ram.commands["gui-setup"].handler("docker-windows --vm-ram-gb 6", ram.ctx());
  assert.doesNotMatch(ram.last(), /--vm-disk-gb apply/, "only RAM given: no reinstall note");
});

test("WI: VM and licensing flags are validated and refused on backends they do not fit", async (t) => {
  const win = windowsEntry({ acknowledged: true });
  const env = await wiringEnv(t, [win, cuaEntry()]);
  await env.commands["gui-setup"].handler("docker-windows --vm-ram-gb 1", env.ctx());
  assert.match(env.last(), /--vm-ram-gb must be a whole number from 2 to 512 \(GB of RAM per VM\)/);
  await env.commands["gui-setup"].handler("docker-windows --vm-cpus 2.5", env.ctx());
  assert.match(env.last(), /--vm-cpus must be a whole number from 1 to 128/);
  await env.commands["gui-setup"].handler("docker-windows --vm-disk-gb 32", env.ctx());
  assert.match(env.last(), /--vm-disk-gb must be a whole number from 64 to 4096/);
  await env.commands["gui-setup"].handler("docker-windows --windows-version 'eleven pro'", env.ctx());
  assert.match(env.last(), /--windows-version must be a dockurr\/windows VERSION value/);
  assert.deepEqual(win.state.setVm, [], "nothing is stored after a refused flag");
  await env.commands["gui-setup"].handler("docker-linux --accept-windows-license", env.ctx());
  assert.match(env.last(), /^\/gui-setup: --accept-windows-license only applies to docker-windows, not docker-linux$/);
  await env.commands["gui-setup"].handler("cua --vm-ram-gb 8 --windows-version 11", env.ctx());
  assert.match(env.last(), /^\/gui-setup: --windows-version, --vm-ram-gb only apply to docker-windows, not cua$/);
  await env.commands["gui-setup"].handler("docker-windows --windows-image windows --accept-billing", env.ctx());
  assert.match(env.last(), /^\/gui-setup: --accept-billing, --windows-image only apply to cua, not docker-windows$/);
  assert.deepEqual(env.dockerCalls, []);
});

test("WI: cua takes --windows-image and --windows-rate-usd-per-hour, records the Windows image in the verified inputs", async (t) => {
  const cua = cuaEntry();
  const env = await wiringEnv(t, [cua]);
  await env.commands["gui-setup"].handler("cua --windows-image windows:2025 --windows-rate-usd-per-hour 1.25 --targets linux,windows", env.ctx());
  assert.match(env.last(), /cua is set up and verified/);
  assert.deepEqual(cua.state.recorded, [{ windowsImage: "windows:2025", windowsRateUsdPerHour: 1.25 }]);
  const inputs = (await env.global()).verified.cua.inputs;
  assert.equal(inputs.windowsImage, "windows:2025");
  assert.equal(inputs.image, "linux");
  assert.equal(inputs.targets, "linux,windows");

  const plain = await wiringEnv(t, [cuaEntry()]);
  await plain.commands["gui-setup"].handler("cua", plain.ctx());
  assert.equal((await plain.global()).verified.cua.inputs.windowsImage, "windows", "the default Windows image is recorded like the Linux one");
  await plain.commands["gui-setup"].handler("cua --windows-rate-usd-per-hour 2000", plain.ctx());
  assert.match(plain.last(), /--windows-rate-usd-per-hour must be a number from 0 to 1000/);
  await plain.commands["gui-setup"].handler("cua --windows-image 'bad image'", plain.ctx());
  assert.match(plain.last(), /--windows-image must be an image alias or registry reference/);
});

test("WI: gui_launch hands its target to the backend: the call's target, else the project's first, else linux", async (t) => {
  const cua = cuaEntry();
  const env = await wiringEnv(t, [cua], { global: { backend: "cua", verified: { cua: VERIFIED_FAKE } } });
  const launch = async (params) => {
    const out = await env.tools.gui_launch.execute("c", params, undefined, undefined, env.ctx());
    await env.tools.gui_stop.execute("c", { session: out.details.session }, undefined, undefined, env.ctx());
  };
  await launch({});
  await launch({ target: "windows" });
  assert.deepEqual(cua.calls.starts.map((s) => s.target), ["linux", "windows"]);
  await assert.rejects(env.tools.gui_launch.execute("c", { target: "macos" }, undefined, undefined, env.ctx()), /backend "cua" runs Linux and Windows apps only; target "macos" is not available on it/);

  const windowsFirst = cuaEntry();
  const win = await wiringEnv(t, [windowsFirst], { shared: { targets: ["windows", "linux"] }, global: { backend: "cua", verified: { cua: VERIFIED_FAKE } } });
  const out = await win.tools.gui_launch.execute("c", {}, undefined, undefined, win.ctx());
  await win.tools.gui_stop.execute("c", { session: out.details.session }, undefined, undefined, win.ctx());
  assert.deepEqual(windowsFirst.calls.starts.map((s) => s.target), ["windows"], "without a target the project's first one is used");
});

test("WI: the smoke test names the WinForms app for Windows targets and runs the session's isolation assertion", async (t) => {
  for (const verdict of [{ ok: true, observed: "foreground unchanged (Explorer)" }, { ok: false, observed: "foreground changed from Explorer to Pi GUI smoke" }]) {
    const fake = fakeBackendEntry({ id: "local-windows" });
    fake.entry.targets = ["windows"];
    const asked = [];
    const create = fake.entry.create;
    fake.entry.create = (ctx) => {
      const backend = create(ctx);
      const start = backend.startSession;
      backend.startSession = async (options) => {
        const session = await start(options);
        session.foregroundUnchanged = async () => (asked.push(options.target), verdict);
        return session;
      };
      backend.smokeApp = () => ({ cmd: "powershell.exe", args: ["-File", "smoke.ps1"] });
      backend.smokeConfig = (base) => ({ ...base, shared: { ...base.shared, targets: ["windows"], network: "default" } });
      return backend;
    };
    const env = await wiringEnv(t, [fake]);
    const statuses = [];
    const outcome = await runSmokeTest({ runtime: env.runtime, backend: "local-windows", piSessionId: "p", signal: AbortSignal.timeout(20_000), onStatus: (s) => statuses.push(s) });
    assert.deepEqual(asked, ["windows"], "the smoke session starts with the Windows target and asks once");
    assert.ok(statuses.includes("smoke test: launching the WinForms test app"));
    assert.ok(statuses.includes("smoke test: checking isolation"));
    if (verdict.ok) {
      assert.equal(outcome.ok, true, outcome.observed);
      assert.match(outcome.observed, /^WinForms test app launched, button found by name, click changed the label, \d+×\d+ screenshot valid, foreground unchanged \(Explorer\) \(launch \d+ ms\)$/);
    } else {
      assert.equal(outcome.ok, false);
      assert.equal(outcome.observed, "isolation: foreground changed from Explorer to Pi GUI smoke");
    }
    assert.deepEqual(outcome.leftovers ?? [], []);
  }
  assert.equal(smokeAppName("linux"), "GTK 3 test app");
  assert.equal(smokeAppName(undefined), "GTK 3 test app");
});

test("WI: the real Windows factories start nothing; docker-windows has the licensing, VM, and remediation capabilities and keeps state in the config dir", async (t) => {
  const { hasLicense, hasRemediation, hasVmSettings, hasSmoke } = await import("../../../src/backends/capabilities.ts");
  const root = await mkdtemp(join(tmpdir(), "gui-win-factory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { ownerLabel: () => "c:1:2:b", runtimeOptions: {}, configDir: root };
  const docker = DEFAULT_REGISTRY.create("docker-windows", ctx);
  assert.ok(hasLicense(docker) && hasVmSettings(docker) && hasRemediation(docker) && hasSmoke(docker));
  const before = await docker.licenseStatus();
  assert.equal(before.acknowledged, false);
  assert.match((await docker.licenseStatus({ diskGb: 128, version: "10" })).text, /Windows 10 .*about 128 GB of disk/);
  await docker.setVm({ ramGb: 8 });
  await docker.acknowledgeLicense();
  const settings = JSON.parse(await readFile(join(root, "docker-windows", "settings.json"), "utf8"));
  assert.equal(settings.vm.ramGb, 8);
  assert.ok(settings.licenseAcceptedAt);
  await assert.rejects(docker.setVm({ ramGb: 1 }), /vm\.ramGb must be a whole number from 2 to 512/);
  assert.equal(docker.remediate("docker.cli", AbortSignal.timeout(1_000)), undefined, "other checks run through the runner");
  assert.equal(docker.smokeConfig({ shared: { targets: ["linux"] } }).shared.targets[0], "windows");

  const local = DEFAULT_REGISTRY.create("local-windows", { ...ctx, runtimeOptions: { backendOptions: { "local-windows": { platform: "linux" } } } });
  assert.equal(hasLicense(local) || hasVmSettings(local), false);
  assert.equal(await local.sweepAvailable({ startup: true }), false, "not a Windows host: no sweep");
  assert.equal(local.smokeConfig({ shared: { targets: ["linux"] } }).shared.targets[0], "windows");
});
