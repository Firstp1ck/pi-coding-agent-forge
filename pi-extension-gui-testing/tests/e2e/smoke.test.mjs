/**
 * e2e smoke (plan §8 "e2e smoke"): S1/S3 through the real `/gui-setup
 * docker-linux --fix` command path (checks → image build if needed → smoke
 * test → persist, zero prompts), S6 live negatives that only ever
 * `docker create` (never start) containers, and `/gui-doctor` with an empty
 * orphan audit. Skipped with a reason when no local rootful Docker is usable.
 *
 *   npm run test:e2e -- tests/e2e/smoke.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiCommands } from "../../src/commands/commands.ts";
import { GuiRuntime } from "../../src/tools/runtime.ts";
import { dockerCreateArgs, writeIdentityFiles } from "../../src/backends/docker/run-args.ts";
import { hardRuleViolations } from "../../src/backends/docker/inspect.ts";
import { ensureBaseImage, docker, dockerSkipReason, labelled, ownerLabel } from "./harness.mjs";

const skip = dockerSkipReason();

function captureStderr(t) {
  const original = process.stderr.write;
  const written = [];
  const exitCode = process.exitCode;
  process.stderr.write = (chunk, ...rest) => (written.push(String(chunk)), original.call(process.stderr, chunk, ...rest));
  t.after(() => {
    process.stderr.write = original;
    process.exitCode = exitCode;
  });
  return () => written.join("");
}

test("S1/S3: /gui-setup docker-linux --fix verifies with zero prompts and one summary; the smoke test passes; the audit is empty", { skip, timeout: 60 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-e2e-setup-"));
  const tmp = join(root, "tmp");
  await mkdir(tmp);
  const globalConfigPath = join(root, "agent", "gui", "config.json");
  const runtime = new GuiRuntime({ tmpRoot: tmp, globalConfigPath, docker: { common: { configDir: root } } });
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const prompts = [];
  const messages = [];
  const ui = {
    notify() {},
    setStatus() {},
    select: async (...a) => (prompts.push(a), undefined),
    confirm: async (...a) => (prompts.push(a), false),
    input: async (...a) => (prompts.push(a), undefined),
  };
  const commands = Object.fromEntries(createGuiCommands({ sendMessage: (m) => messages.push(m) }, runtime).map((c) => [c.name, c]));
  const ctx = { cwd: root, hasUI: true, mode: "tui", ui, sessionManager: { getSessionId: () => "pi-e2e" } };
  await commands["gui-setup"].handler("docker-linux --fix", ctx);
  assert.deepEqual(prompts, [], "zero prompts");
  assert.equal(messages.length, 1, "one summary");
  const report = messages[0].content;
  t.diagnostic(report);
  assert.match(report, /GUI testing setup: docker-linux — verified/);
  for (const id of ["docker.endpoint", "docker.rootless", "docker.bind-uid", "docker.version", "image.base", "isolation.inspect"]) {
    assert.match(report, new RegExp(`pass +${id.replace(".", "\\.")} `), id);
  }
  assert.match(report, /Smoke test: passed — GTK 3 app launched, button found by name, click changed the label/);
  const config = JSON.parse(await readFile(globalConfigPath, "utf8"));
  assert.equal(config.backend, "docker-linux");
  assert.ok(config.verified["docker-linux"].toolVersions["image.id"]);
  assert.deepEqual(labelled(), [], "no labelled container, volume, or network remains");

  const stderr = captureStderr(t);
  process.exitCode = undefined;
  await commands["gui-doctor"].handler("docker-linux", { ...ctx, hasUI: false, mode: "print" });
  assert.match(stderr(), /GUI testing doctor: docker-linux — verified/);
  assert.match(stderr(), /Footprint audit \(orphans of ended sessions\): empty/);
  assert.equal(process.exitCode, undefined);
});

/** Live negatives (S6): each case adds forbidden settings to the production create argv; containers are created, inspected, and removed, never started. */
test("S6: isolation.inspect rejects live containers with forbidden settings (docker create only, never started)", { skip, timeout: 30 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-e2e-neg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new GuiRuntime({ tmpRoot: root });
  const backend = runtime.backend("docker-linux");
  await ensureBaseImage(backend);
  const host = (await backend.endpoint()).host;
  await writeIdentityFiles(root, process.getuid(), process.getgid());
  await mkdir(join(root, "workspace"));
  // Dummy sources only: a symlink that resolves to the X11 socket dir and a regular file named docker.sock.
  await symlink("/tmp/.X11-unix", join(root, "x11-link"));
  await writeFile(join(root, "docker.sock"), "");
  const cases = [
    ["privileged", ["--privileged"]],
    ["host-mode", ["--network", "host"]],
    ["host-mode", ["--ipc", "host"]],
    ["host-mode", ["--pid", "host"]],
    ["capabilities", ["--cap-add", "NET_ADMIN"]],
    ["devices", ["--device", "/dev/null:/dev/fake-null"]],
    ["forbidden-mount", ["-v", `${join(root, "x11-link")}:/x11:ro`]],
    ["docker-socket", ["-v", `${join(root, "docker.sock")}:/var/run/docker.sock:ro`]],
    ["forbidden-env", ["-e", "WAYLAND_DISPLAY=wayland-0"]],
    ["forbidden-env", ["-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"]],
    ["display", ["-e", "DISPLAY=:0.0"]],
  ];
  const created = [];
  t.after(() => {
    if (created.length) docker(["rm", "-f", ...created]);
  });
  for (const [index, [rule, extra]] of cases.entries()) {
    const session = `e2e-neg-${process.pid}-${index}`;
    const base = dockerCreateArgs({
      sessionId: session,
      ownerLabel: ownerLabel(),
      image: backend.imageTag,
      uid: process.getuid(),
      gid: process.getgid(),
      sessionDir: root,
      workspace: { source: join(root, "workspace"), readOnly: true },
      network: "default",
    });
    const args = [...base.slice(0, -1), ...extra, base.at(-1)];
    const result = docker(["--host", host, ...args]);
    assert.equal(result.status, 0, `${rule}: docker create failed: ${result.stderr}`);
    const id = result.stdout.trim();
    created.push(id);
    const [inspect] = JSON.parse(docker(["--host", host, "container", "inspect", id]).stdout);
    assert.equal(inspect.State.Status, "created", "never started");
    assert.equal(inspect.State.StartedAt, "0001-01-01T00:00:00Z");
    const violations = hardRuleViolations(inspect);
    assert.ok(violations.some((v) => v.rule === rule), `${rule}: ${JSON.stringify(violations)}`);
    assert.equal(docker(["--host", host, "rm", "-f", id]).status, 0);
    created.pop();
  }
  // The unmodified production configuration passes on the real daemon.
  const clean = docker(["--host", host, ...dockerCreateArgs({ sessionId: `e2e-neg-${process.pid}-ok`, ownerLabel: ownerLabel(), image: backend.imageTag, uid: process.getuid(), gid: process.getgid(), sessionDir: root, workspace: { source: join(root, "workspace"), readOnly: true }, network: "none", shmSize: "512m" })]);
  const cleanId = clean.stdout.trim();
  created.push(cleanId);
  assert.deepEqual(hardRuleViolations(JSON.parse(docker(["--host", host, "container", "inspect", cleanId]).stdout)[0]), []);
  docker(["--host", host, "rm", "-f", cleanId]);
  created.pop();
  assert.deepEqual(labelled().filter((id) => created.includes(id)), []);
});
