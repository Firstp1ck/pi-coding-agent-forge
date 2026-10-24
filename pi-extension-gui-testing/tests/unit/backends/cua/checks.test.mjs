/**
 * `cua` checks (spec §5.4, adapted) through the real check runner on the fake
 * API: the passing path, sign-in and cloud failures, target refusals, expiry,
 * rate, and the billing acknowledgement. Nothing is created or billed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { chooseLocation, targetRefusal } from "../../../../src/backends/cua/checks.ts";
import { CuaCostLedger, reportedRate } from "../../../../src/backends/cua/cost.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { billingAcknowledgementText, CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { runChecks } from "../../../../src/checks/runner.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { cuaEnv, FakeCuaApi, HOST_TAG, LIVE_OWNER, PROVIDERS } from "./fake-cua.mjs";

async function run(t, { fake, settings, targets, network } = {}) {
  const env = await cuaEnv(t, { settings });
  const api = new FakeCuaApi(fake);
  const configDir = join(env.root, "agent", "gui");
  await mkdir(configDir, { recursive: true });
  const backend = new CuaBackend({
    ownerLabel: () => LIVE_OWNER,
    api,
    ledger: new SandboxLedger(env.ledgerDir),
    settings: new CuaSettingsStore(env.settingsPath),
    hostTag: HOST_TAG,
    version: "0.1.0",
    procRoot: env.proc,
    probeNetwork: network ?? (async () => "api.cua.ai answered HTTP 404"),
    ...(targets ? { targets: async () => targets } : {}),
    common: { piVersion: "1.4.0", platform: "linux", configDir, minFreeBytes: 1 },
  });
  const results = await runChecks(backend.checks(), { runner: new FakeCommandRunner(), backend: "cua", projectRoot: env.project, signal: new AbortController().signal });
  return { results: Object.fromEntries(results.map((r) => [r.id, r])), api };
}

test("every check passes on a signed-in machine with a connected cloud and the acknowledgement; nothing is created", async (t) => {
  const { results, api } = await run(t);
  for (const id of ["pi.version", "host.os", "config.writable", "disk.free", "cua.cli", "cua.network", "cua.signin", "cua.auth", "cua.cloud", "cua.quota", "cua.targets", "cua.ttl", "cua.rate", "cua.cost-ack"]) {
    assert.equal(results[id]?.status, "pass", `${id}: ${results[id]?.observed}`);
  }
  assert.equal(results["cua.cloud"].observed, "aws us-west-2 (the cua default cloud)");
  assert.deepEqual(results["cua.cloud"].facts, { "cua.location": "aws", "cua.region": "us-west-2" });
  assert.equal(results["cua.cli"].facts["cua.cli"], "0.7.0");
  assert.equal(results["cua.rate"].observed, "~$0.50/h (reported by Cua)");
  assert.ok(!api.methods().some((m) => ["createSandbox", "deleteSandbox", "exec", "upload", "spawnHelper"].includes(m)));
});

test("not signed in blocks the authenticated checks", async (t) => {
  const { results } = await run(t, { fake: { signedIn: false } });
  assert.equal(results["cua.signin"].status, "fail");
  assert.match(results["cua.signin"].remediation.summary, /cua auth login/);
  assert.equal(results["cua.auth"].status, "blocked");
  assert.equal(results["cua.cloud"].status, "blocked");
  assert.equal(results["cua.cost-ack"].status, "blocked");
});

test("no connected cloud fails cua.cloud with the connect command", async (t) => {
  const { results } = await run(t, { fake: { providers: [{ ...PROVIDERS[1] }] } });
  assert.equal(results["cua.cloud"].status, "fail");
  assert.equal(results["cua.cloud"].observed, "no cloud is connected");
  assert.match(results["cua.cloud"].remediation.summary, /cua cloud connect aws/);
});

test("a cloud test failure is reported without creating anything", async (t) => {
  const { results } = await run(t, { fake: { cloudTest: { ok: false, checks: [{ name: "quota", ok: false, detail: "vCPU limit 0" }] } } });
  assert.equal(results["cua.quota"].status, "fail");
  assert.equal(results["cua.quota"].observed, "aws: quota: vCPU limit 0");
});

test("Windows and macOS targets are refused with the planned-work reason", async (t) => {
  const { results } = await run(t, { targets: ["linux", "windows", "macos"] });
  assert.equal(results["cua.targets"].status, "fail");
  assert.match(results["cua.targets"].observed, /windows: needs the Windows helper \(spike S1\); planned/);
  assert.match(results["cua.targets"].observed, /macos: .*planned/);
  assert.equal(targetRefusal("linux"), undefined);
});

test("the project's targets are read when no flag gives them", async (t) => {
  const env = await cuaEnv(t);
  await mkdir(join(env.project, ".pi"), { recursive: true });
  await writeFile(join(env.project, ".pi", "gui.json"), JSON.stringify({ targets: ["windows"] }));
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api: new FakeCuaApi(), ledger: new SandboxLedger(env.ledgerDir), settings: new CuaSettingsStore(env.settingsPath), hostTag: HOST_TAG, version: "0.1.0", probeNetwork: async () => "ok" });
  const check = backend.checks().find((c) => c.id === "cua.targets");
  const outcome = await check.run({ projectRoot: env.project, signal: new AbortController().signal, dependencies: new Map(), runner: new FakeCommandRunner(), backend: "cua" });
  assert.equal(outcome.status, "fail");
});

test("no expiry and no rate only warn; a missing acknowledgement fails", async (t) => {
  const providers = [{ ...PROVIDERS[0], ttlHours: 0, kinds: [{ image: "linux", kind: "container", supported: true }] }];
  const { results } = await run(t, { fake: { providers }, settings: { billingAcceptedAt: undefined, billingLocation: undefined } });
  assert.equal(results["cua.ttl"].status, "warn");
  assert.match(results["cua.ttl"].observed, /never expire/);
  assert.equal(results["cua.rate"].status, "warn");
  assert.equal(results["cua.cost-ack"].status, "fail");
  assert.match(results["cua.cost-ack"].remediation.summary, /--accept-billing/);
});

test("an acknowledgement for another cloud does not count; a setup rate fills in a missing price", async (t) => {
  const providers = [{ ...PROVIDERS[0], kinds: [] }];
  const { results } = await run(t, { fake: { providers }, settings: { billingLocation: "gcp", rateUsdPerHour: 1.25 } });
  assert.equal(results["cua.cost-ack"].status, "fail");
  assert.match(results["cua.cost-ack"].observed, /acknowledged for gcp/);
  assert.equal(results["cua.rate"].observed, "~$1.25/h (entered at setup)");
});

test("the network check fails when the probe fails", async (t) => {
  const { results } = await run(t, { network: async () => { throw new Error("getaddrinfo ENOTFOUND api.cua.ai"); } });
  assert.equal(results["cua.network"].status, "fail");
  assert.equal(results["cua.auth"].status, "blocked");
});

test("location choice follows setup, then the cua default, then the only connected cloud", () => {
  const p = (name, connected, isDefault) => ({ name, connected, isDefault, credentialsFound: true, kinds: [] });
  assert.equal(chooseLocation({ version: 1, location: "gcp" }, []).location, "gcp");
  assert.equal(chooseLocation({ version: 1 }, [p("aws", true, false), p("gcp", true, true)]).location, "gcp");
  assert.equal(chooseLocation({ version: 1 }, [p("modal", true, false)]).location, "modal");
  assert.match(chooseLocation({ version: 1 }, [p("aws", true, false), p("gcp", true, false)]).why, /none is the default/);
  assert.equal(chooseLocation({ version: 1 }, [p("local", true, true)]).location, undefined, "local is not a cloud");
});

test("cost: reported rates, daily totals, and pruning", () => {
  assert.equal(reportedRate(PROVIDERS, "aws", "linux"), 0.5);
  assert.equal(reportedRate(PROVIDERS, "gcp", "linux"), undefined);
  let now = new Date("2026-10-24T10:00:00").getTime();
  const cost = new CuaCostLedger(() => now);
  cost.start("a", 1, new Date("2026-10-23T23:00:00").getTime());
  cost.start("b", 2);
  cost.start("c", undefined);
  now += 30 * 60_000;
  assert.equal(cost.sessionUsd("a"), 11.5);
  assert.equal(cost.sessionUsd("b"), 1);
  assert.equal(cost.sessionUsd("c"), undefined);
  assert.equal(cost.dailyUsd(), 10.5 + 1, "only today's hours count");
  cost.stop("a", new Date("2026-10-23T23:30:00").getTime());
  cost.prune();
  assert.equal(cost.sessionUsd("a"), undefined);
  assert.match(billingAcknowledgementText("aws", 0.5), /bills that account at about \$0\.50 per sandbox hour/);
  assert.match(billingAcknowledgementText("aws"), /secrets .* are always excluded/);
});

test("V10: the cua.rate fix names the flag that sets the rate", () => {
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api: new FakeCuaApi(), hostTag: HOST_TAG, version: "0.1.0" });
  const rate = backend.checks().find((c) => c.id === "cua.rate");
  assert.match(rate.remediation.summary, /^Run \/gui-setup cua --rate-usd-per-hour <price> /);
});

test("V11: cua.cli requires CLI 0.7 or newer and reports the observed version", async (t) => {
  for (const [version, status] of [["0.6.9", "fail"], ["0.7", "pass"], ["0.7.3", "pass"], ["1.0.0-beta.1", "pass"], ["dev", "fail"]]) {
    const { results } = await run(t, { fake: { version } });
    assert.equal(results["cua.cli"].status, status, version);
    if (status === "fail") {
      assert.equal(results["cua.cli"].observed, `cua ${version} (needs 0.7 or newer)`);
      assert.match(results["cua.cli"].remediation.summary, /update the cua CLI to 0\.7 or newer/);
      assert.equal(results["cua.signin"].status, "blocked");
    } else assert.equal(results["cua.cli"].facts["cua.cli"], version);
  }
});

test("V13: the sandbox image is a setup input and a drift key (cua.image)", async (t) => {
  const { staleVersions } = await import("../../../../src/config/verified.ts");
  const env = await cuaEnv(t, {});
  const api = new FakeCuaApi();
  const settings = new CuaSettingsStore(env.settingsPath);
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api, ledger: new SandboxLedger(env.ledgerDir), settings, hostTag: HOST_TAG, version: "0.1.0", procRoot: env.proc, common: { piVersion: "1.4.0" } });
  const before = await backend.currentVersions();
  assert.equal(before["cua.image"], "linux", "the default image");
  const { results } = await run(t);
  assert.equal(results["cua.targets"].facts["cua.image"], "linux", "the verified record holds the image");
  const status = await backend.billingStatus({ image: "ghcr.io/me/desktop:2" }, new AbortController().signal);
  assert.equal(status.image, "ghcr.io/me/desktop:2");
  await backend.recordSetupInputs({ image: "ghcr.io/me/desktop:2" });
  assert.equal((await settings.read()).image, "ghcr.io/me/desktop:2");
  const after = await backend.currentVersions();
  assert.equal(after["cua.image"], "ghcr.io/me/desktop:2");
  assert.deepEqual(staleVersions({ toolVersions: before }, after).map((c) => c.key), ["cua.image"], "a changed image blocks launches until /gui-doctor");
});
