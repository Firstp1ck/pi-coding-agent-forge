/**
 * Host picker (spec §4.2a): `~/.ssh/config` aliases with `Include` (relative
 * to ~/.ssh, `~`, globs, nesting), skipped patterns, `ssh -G` resolution
 * (Match applied by OpenSSH, here a fake), parallel bounded probes with
 * their labels, the "Other host…" entry, and the no-UI path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import {
  candidateLabel,
  discoverHosts,
  hostBlockTemplate,
  isConcreteAlias,
  listConfigAliases,
  OTHER_HOST,
  parseOtherHost,
  parseSshG,
  pickHost,
  probeLabel,
  tokenizeConfigLine,
} from "../../../../src/setup/hosts.ts";
import { MissingInputError } from "../../../../src/setup/ui.ts";
import { decodeRemote, parseSshArgv } from "../../transport/ssh/fake-ssh.mjs";

async function home(t, files) {
  const root = await mkdtemp(join(tmpdir(), "pgt-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("tokenizeConfigLine: keyword, =, quotes, comments", () => {
  assert.deepEqual(tokenizeConfigLine("  Host a b"), ["Host", "a", "b"]);
  assert.deepEqual(tokenizeConfigLine("Host=a"), ["Host", "a"]);
  assert.deepEqual(tokenizeConfigLine("Host = a"), ["Host", "a"]);
  assert.deepEqual(tokenizeConfigLine('Include "my dir/*.conf" other'), ["Include", "my dir/*.conf", "other"]);
  assert.deepEqual(tokenizeConfigLine("Host a # comment"), ["Host", "a"]);
  assert.deepEqual(tokenizeConfigLine("# Host x"), []);
  assert.deepEqual(tokenizeConfigLine(""), []);
  assert.equal(isConcreteAlias("raspi5"), true);
  for (const p of ["*", "*.lan", "web?", "!bastion"]) assert.equal(isConcreteAlias(p), false, p);
});

test("listConfigAliases follows Include (relative, ~, absolute, globs, nested) and skips patterns", async (t) => {
  const root = await home(t, {
    ".ssh/config": [
      "Host raspi5 vps",
      "    HostName 10.0.0.5",
      "Host *.lan !secret web?",
      "Include conf.d/*.conf",
      "Include ~/.ssh/extra",
      "Include missing-file",
      "Match host raspi5",
      "    Include nested/inside",
      "host lowercase",
      "Host raspi5",
    ].join("\n"),
    ".ssh/conf.d/b.conf": "Host beta\n",
    ".ssh/conf.d/a.conf": "Host alpha\nInclude nested/deeper\n",
    ".ssh/conf.d/.hidden.conf": "Host hidden\n",
    ".ssh/conf.d/c.txt": "Host notincluded\n",
    ".ssh/extra": "Host=extra-host\n",
    ".ssh/nested/deeper": "Host deep\n",
    ".ssh/nested/inside": "Host in-match\n",
  });
  const listed = await listConfigAliases({ home: root });
  assert.deepEqual(listed.aliases, ["raspi5", "vps", "alpha", "deep", "beta", "extra-host", "in-match", "lowercase"]);
  assert.ok(listed.files.some((f) => f.endsWith("conf.d/a.conf")));
  assert.deepEqual(listed.problems, [], "a missing Include is not a problem");
});

test("listConfigAliases: missing config gives no aliases; self-include stops at depth 16", async (t) => {
  const empty = await home(t, {});
  assert.deepEqual((await listConfigAliases({ home: empty })).aliases, []);
  const loop = await home(t, { ".ssh/config": "Host x\nInclude config\n" });
  const listed = await listConfigAliases({ home: loop });
  assert.deepEqual(listed.aliases, ["x"]);
  assert.match(listed.problems[0], /deeper than 16/);
});

test("parseSshG", () => {
  const r = parseSshG("user pi\nhostname 10.0.0.5\nport 2222\nproxyjump bastion\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n");
  assert.deepEqual(r, {
    user: "pi",
    hostname: "10.0.0.5",
    port: "2222",
    proxyJump: "bastion",
    identityFiles: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"],
    knownHostsFiles: ["~/.ssh/known_hosts", "~/.ssh/known_hosts2", "/etc/ssh/ssh_known_hosts"],
  });
  assert.equal(parseSshG("hostname h\nproxyjump none\n").proxyJump, undefined);
});

test("probeLabel maps outcomes to the spec's labels", () => {
  assert.equal(probeLabel({ exitCode: 0, stdout: "Linux aarch64\n", stderr: "" }).label, "ready (Linux aarch64)");
  assert.equal(probeLabel({ exitCode: 0, stdout: "Darwin arm64\n", stderr: "" }).status, "not Linux");
  assert.equal(probeLabel({ exitCode: 255, stdout: "", stderr: "pi@h: Permission denied (publickey)." }).label, "auth needed");
  assert.equal(probeLabel({ exitCode: 255, stdout: "", stderr: "Host key verification failed." }).label, "host key unknown");
  assert.equal(probeLabel({ exitCode: 255, stdout: "", stderr: "ssh: connect to host h port 22: No route to host" }).label, "unreachable");
  assert.equal(probeLabel({ exitCode: null, stdout: "", stderr: "", timedOut: true }).label, "unreachable");
});

/** A fake local runner: `ssh -G` per alias, probes per destination (decoded `uname -sm`). */
function fakeSshRunner(hosts, stats = { active: 0, max: 0 }) {
  const runner = new FakeCommandRunner();
  runner.on((argv) => argv.includes("-G"), (argv) => {
    const alias = argv.at(-1);
    const h = hosts[alias];
    if (!h || h.resolve === false) return { exitCode: 255, stderr: `ssh: Could not resolve hostname ${alias}` };
    return { stdout: `user ${h.user ?? "pi"}\nhostname ${h.hostname ?? alias}\nport ${h.port ?? 22}\n${h.jump ? `proxyjump ${h.jump}\n` : ""}` };
  });
  runner.on(
    (argv) => argv[0] === "ssh" && !argv.includes("-G"),
    async (argv, options) => {
      const parsed = parseSshArgv(argv);
      assert.deepEqual(decodeRemote(parsed.command).argv, ["uname", "-sm"]);
      assert.equal(parsed.options.BatchMode, "yes");
      assert.ok(Number(parsed.options.ConnectTimeout) <= 3);
      const h = hosts[parsed.destination];
      stats.active++;
      stats.max = Math.max(stats.max, stats.active);
      try {
        if (h.delayMs) {
          const aborted = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), h.delayMs);
            options.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(true)), { once: true });
          });
          if (aborted) return { exitCode: null, signal: "SIGTERM", timedOut: false };
        }
        return h.probe;
      } finally {
        stats.active--;
      }
    },
  );
  return runner;
}

test("discoverHosts resolves and probes in parallel (≤ 8) and labels every host", async (t) => {
  const aliases = ["ok", "auth", "hk", "down", "mac", "slow", ...Array.from({ length: 10 }, (_, i) => `h${i}`)];
  const root = await home(t, { ".ssh/config": `Host ${aliases.join(" ")} gone\nHost *\n  User x\n` });
  const hosts = {
    ok: { probe: { stdout: "Linux x86_64\n" }, jump: "bastion" },
    auth: { probe: { exitCode: 255, stderr: "Permission denied (publickey)." } },
    hk: { probe: { exitCode: 255, stderr: "Host key verification failed." } },
    down: { probe: { exitCode: 255, stderr: "ssh: connect to host down port 22: Connection refused" } },
    mac: { probe: { stdout: "Darwin arm64\n" } },
    slow: { probe: { stdout: "Linux aarch64\n" }, delayMs: 10_000 },
    gone: { resolve: false },
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`h${i}`, { probe: { stdout: "Linux aarch64\n" }, delayMs: 20 }])),
  };
  const stats = { active: 0, max: 0 };
  const started = Date.now();
  const { candidates } = await discoverHosts({ home: root, runner: fakeSshRunner(hosts, stats), totalMs: 400 });
  assert.ok(Date.now() - started < 3_000, "bounded by the total time");
  assert.ok(stats.max <= 8, `at most 8 probes at once (saw ${stats.max})`);
  const by = Object.fromEntries(candidates.map((c) => [c.alias, c]));
  assert.equal(by.ok.probe.label, "ready (Linux x86_64)");
  assert.equal(candidateLabel(by.ok), "ok — pi@ok:22 via bastion — ready (Linux x86_64)");
  assert.equal(by.auth.probe.label, "auth needed");
  assert.equal(by.hk.probe.label, "host key unknown");
  assert.equal(by.down.probe.label, "unreachable");
  assert.equal(by.mac.probe.status, "not Linux");
  assert.equal(by.slow.probe.label, "unreachable", "a probe still running at the deadline is unreachable");
  assert.equal(candidateLabel(by.gone), "gone — does not resolve");
  assert.equal(candidates.some((c) => c.alias === "*"), false);
});

function fakeUi(answers) {
  const calls = [];
  return {
    calls,
    hasUI: true,
    async select(title, options) {
      calls.push({ select: title, options });
      return answers.select?.(options);
    },
    async input(title, placeholder) {
      calls.push({ input: title, placeholder });
      return answers.input;
    },
    async confirm() {
      return false;
    },
    notify() {},
    setStatus(text) {
      calls.push({ status: text });
    },
  };
}

test("pickHost returns the chosen alias only", async (t) => {
  const root = await home(t, { ".ssh/config": "Host raspi5 vps\n" });
  const runner = fakeSshRunner({ raspi5: { probe: { stdout: "Linux aarch64\n" } }, vps: { probe: { stdout: "Linux x86_64\n" } } });
  const ui = fakeUi({ select: (options) => options.find((o) => o.startsWith("vps")) });
  const choice = await pickHost(ui, { backend: "remote-linux", home: root, runner });
  assert.equal(choice.host, "vps");
  const select = ui.calls.find((c) => c.select);
  assert.equal(select.options.at(-1), OTHER_HOST);
  assert.ok(select.options[0].startsWith("raspi5 — pi@raspi5:22 — ready (Linux aarch64)"));
});

test("pickHost: Other host… asks for user@host[:port] and returns a template", async (t) => {
  const root = await home(t, {});
  const ui = fakeUi({ select: () => OTHER_HOST, input: "pi@10.0.0.7:2222" });
  const choice = await pickHost(ui, { backend: "remote-linux", home: root, runner: new FakeCommandRunner() });
  assert.equal(choice.host, "ssh://pi@10.0.0.7:2222");
  assert.match(choice.template, /^Host 10\n    HostName 10\.0\.0\.7\n    User pi\n    Port 2222/);
  assert.equal(await pickHost(fakeUi({ select: () => undefined }), { backend: "remote-linux", home: root, runner: new FakeCommandRunner() }), undefined);
});

test("pickHost without a UI fails with the --host flag and probes nothing", async () => {
  const runner = new FakeCommandRunner();
  const ui = { ...fakeUi({}), hasUI: false, select: async (title, options, prompt) => { throw new MissingInputError(title, prompt.flags); } };
  await assert.rejects(pickHost(ui, { backend: "remote-linux-docker", runner }), (e) => e instanceof MissingInputError && /--host/.test(e.message));
  assert.equal(runner.calls.length, 0);
});

test("parseOtherHost", () => {
  assert.deepEqual(parseOtherHost("pi@raspi"), { destination: "pi@raspi", host: "raspi", user: "pi" });
  assert.deepEqual(parseOtherHost("raspi:22"), { destination: "raspi", host: "raspi", port: 22 });
  assert.equal(parseOtherHost("me@[fe80::1]:2200").destination, "ssh://me@[fe80::1]:2200");
  for (const bad of ["", "-oProxyCommand=x", "a b", "u@h:99999", "u@h;rm", "u@@h"]) assert.throws(() => parseOtherHost(bad), undefined, bad);
  assert.match(hostBlockTemplate({ host: "box.example.org", user: "me", destination: "me@box.example.org" }), /^Host box\n    HostName box\.example\.org\n    User me/);
});
