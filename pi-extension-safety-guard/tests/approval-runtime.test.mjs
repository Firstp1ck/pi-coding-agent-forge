import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createSafetyGuardExtension } from "../index.ts";
import { ruleAllowKey, operationRule, operationRuleAllowKey, operationAllowKey } from "../src/approvals.ts";
import { BASH_CHOICES as CHOICE } from "../src/bash-prompt.ts";
import { defaultSafetyGuardConfig, writeSafetyGuardConfig } from "../src/config.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-approval-runtime-"));
const configFile = path.join(tempDir, "config.json");
const previousConfigFile = process.env.PI_SAFETY_GUARD_CONFIG_FILE;
process.env.PI_SAFETY_GUARD_CONFIG_FILE = configFile;
after(() => {
  if (previousConfigFile === undefined) delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  else process.env.PI_SAFETY_GUARD_CONFIG_FILE = previousConfigFile;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
let fixtureId = 0;
function fixture() {
  const cwd = path.join(tempDir, `workspace-${++fixtureId}`);
  fs.mkdirSync(cwd);
  writeSafetyGuardConfig(defaultSafetyGuardConfig(), configFile);
  return { cwd, allowStorePath: path.join(cwd, "allow.json") };
}
function harness(location, choices = [], { hasUI = true, requestAutoReviewFn, analyzeShellFn } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  const notices = [];
  createSafetyGuardExtension({ allowStorePath: location.allowStorePath, requestAutoReviewFn, analyzeShellFn })({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, definition) => commands.set(name, definition),
  });
  const ctx = {
    cwd: location.cwd, hasUI, mode: hasUI ? "tui" : "print", modelRegistry: {},
    ui: {
      theme: { fg: (_tone, value) => value },
      select: async (title, options) => { prompts.push({ title, options }); return choices.shift() ?? "Block"; },
      notify: (message) => notices.push(message), setStatus() {}, setWidget() {},
    },
  };
  return {
    prompts, notices, ctx,
    call: async (command) => {
      const event = { type: "tool_call", toolName: "bash", input: { command } };
      const result = await handlers.get("tool_call")(event, ctx);
      assert.equal(event.input.command, command, "guard must never rewrite or partially execute the invocation");
      return result;
    },
    file: (toolName, target) => handlers.get("tool_call")({ type: "tool_call", toolName, input: { path: target } }, ctx),
    control: (args) => commands.get("safety-guard").handler(args, ctx),
  };
}
function seed(location, entries) { fs.writeFileSync(location.allowStorePath, JSON.stringify({ version: 1, entries })); }
function legacy(location, command) {
  return { key: `bash:${location.cwd}:${command}`, kind: "bash", value: command,
    cwd: location.cwd, label: "git switch", createdAt: "2026-01-01T00:00:00.000Z" };
}
function entries(location) { return fs.existsSync(location.allowStorePath) ? JSON.parse(fs.readFileSync(location.allowStorePath, "utf8")).entries : []; }

test("one prompt shows every operation and risk; block saves nothing", async () => {
  const location = fixture();
  const current = harness(location);
  assert.equal((await current.call("git switch -c branch-a && rm -rf ./important-data")).block, true);
  assert.equal(current.prompts.length, 1);
  assert.match(current.prompts[0].title, /1\. NEEDS APPROVAL.*git switch/);
  assert.match(current.prompts[0].title, /2\. NEEDS APPROVAL.*rm -rf/);
  assert.match(current.prompts[0].title, /recursive rm/);
  assert.deepEqual(entries(location), []);
  assert.ok(!current.prompts[0].options.includes(CHOICE.rulePermanent));
});

test("scope and lifetime choices form an explicit matrix for eligible operations", async () => {
  const location = fixture();
  const current = harness(location);
  await current.call("git switch -c branch-a");
  assert.deepEqual(current.prompts[0].options, ["Block", ...Object.values(CHOICE)]);
  assert.match(current.prompts[0].title, /any branch name/);
  assert.match(current.prompts[0].title, /no extra flags or start point/);
});

test("all catalog types support both session and permanent lifetimes across simple names", async () => {
  for (const [first, second] of [
    ["git switch -c branch-a", "git switch --create branch-b"],
    ["git switch branch-a", "git switch branch-b"],
    ["git branch -d branch-a", "git branch -d branch-b"],
  ]) for (const choice of [CHOICE.ruleSession, CHOICE.rulePermanent]) {
    const location = fixture();
    const current = harness(location, [choice]);
    assert.equal(await current.call(first), undefined);
    assert.equal(await current.call(second), undefined);
    assert.equal(await current.call(`${second} && echo done`), undefined);
    assert.equal(current.prompts.length, 1);
    const reloaded = harness(location);
    if (choice === CHOICE.rulePermanent) {
      assert.equal(await reloaded.call(second), undefined);
      assert.equal(entries(location)[0].matchType, "operation-rule");
    } else {
      assert.equal((await reloaded.call(second)).block, true);
      assert.deepEqual(entries(location), []);
    }
    current.ctx.cwd = path.join(location.cwd, "other");
    assert.equal((await current.call(second)).block, true);
  }
});

test("a covered operation does not approve another operation in the same chain", async () => {
  const location = fixture();
  await harness(location, [CHOICE.rulePermanent]).call("git switch -c branch-a");
  const current = harness(location);
  assert.equal((await current.call("git switch -c branch-b && npm uninstall example")).block, true);
  assert.match(current.prompts[0].title, /1\. ALREADY APPROVED/);
  assert.match(current.prompts[0].title, /2\. NEEDS APPROVAL/);
  assert.equal(entries(location).length, 1);
});

test("operation approvals remember argv rather than the original chain or quoting", async () => {
  for (const choice of [CHOICE.operationSession, CHOICE.operationPermanent]) {
    const location = fixture();
    const current = harness(location, [choice]);
    assert.equal(await current.call("git switch branch-a && git branch -d old"), undefined);
    assert.equal(current.prompts.length, 1);
    assert.equal(await current.call(`git 'switch' "branch-a"`), undefined);
    assert.equal(await current.call("echo done; git branch -d old"), undefined);
    assert.equal((await current.call("git switch branch-b")).block, true);
    const reloaded = harness(location);
    if (choice === CHOICE.operationPermanent) {
      assert.equal(await reloaded.call("git switch branch-a"), undefined);
      assert.equal(entries(location).length, 2);
      assert.ok(entries(location).every((entry) => entry.matchType === "operation"));
    } else assert.equal((await reloaded.call("git switch branch-a")).block, true);
  }
});

test("whole-command exact approvals do not silently become operation permissions", async () => {
  for (const choice of [CHOICE.commandSession, CHOICE.commandPermanent]) {
    const location = fixture();
    const current = harness(location, [choice]);
    assert.equal(await current.call("git switch -c branch-a"), undefined);
    assert.equal(await current.call("git switch -c branch-a"), undefined);
    assert.equal((await current.call("git switch -c branch-a && echo done")).block, true);
    assert.equal((await current.call("git switch -c branch-b")).block, true);
    assert.equal((await current.call("git  switch -c branch-a")).block, true);
  }
});

test("allow once grants neither a session nor permanent bypass", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.once]);
  const command = "git switch -c branch-a && rm -rf ./old-data";
  assert.equal(await current.call(command), undefined);
  assert.equal((await current.call(command)).block, true);
  assert.equal(current.prompts.length, 2);
  assert.deepEqual(entries(location), []);
});

test("repeated occurrences are shown separately while equivalent grants deduplicate", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.rulePermanent]);
  assert.equal(await current.call("git switch -c one && git switch -c two"), undefined);
  assert.match(current.prompts[0].title, /1\. NEEDS APPROVAL/);
  assert.match(current.prompts[0].title, /2\. NEEDS APPROVAL/);
  assert.equal(entries(location).length, 1);
});

test("force flags and extra arguments never inherit constrained type permissions", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.rulePermanent, CHOICE.rulePermanent, CHOICE.rulePermanent]);
  await current.call("git switch -c branch-a");
  await current.call("git switch main");
  await current.call("git branch -d old");
  for (const command of ["git switch -C branch-a", "git switch --discard-changes main", "git branch -D old", "git switch -c new HEAD", "git switch main --force"]) {
    const check = harness(location);
    assert.equal((await check.call(command)).block, true, command);
    assert.ok(!check.prompts[0].options.includes(CHOICE.rulePermanent), command);
  }
});

test("fallback syntax cannot reuse operation grants, even if one component is allowed", async () => {
  const location = fixture();
  await harness(location, [CHOICE.rulePermanent]).call("git switch -c branch-a");
  for (const command of [
    "git switch -c branch-b > .env", "git switch -c branch-b 2>&1", "git switch -c $(echo branch-b)",
    "git switch -c `echo branch-b`", "git switch -c $BRANCH", "sudo git switch -c branch-b",
    "cd elsewhere && git switch -c branch-b", "GIT_DIR=elsewhere git switch -c branch-b",
    "git -C elsewhere switch -c branch-b", "git switch -c branch-b &", "git switch -c branch-b &&",
    "git switch -c branch-b\u2028", "echo $PATH", "node -e '0'",
  ]) {
    const current = harness(location);
    assert.equal((await current.call(command)).block, true, command);
    assert.match(current.prompts[0].title, /WHOLE-COMMAND APPROVAL REQUIRED/);
    assert.ok(!current.prompts[0].options.includes(CHOICE.operationSession));
    assert.ok(!current.prompts[0].options.includes(CHOICE.rulePermanent));
  }
});

test("quoted data and comments are not mistaken for executing risk commands", async () => {
  const location = fixture();
  const current = harness(location);
  for (const command of ["echo 'git switch main'", "printf '%s' 'rm -rf /'", "echo 'DROP TABLE sample;'", "# git reset --hard\necho ok", "echo '$(rm -rf /)'"]) {
    assert.equal(await current.call(command), undefined, command);
  }
  assert.equal(current.prompts.length, 0);
  assert.equal((await current.call('echo "$(rm -rf /)"')).block, true);
});

test("piped SQL requires whole-command approval without reusable operation choices", async () => {
  for (const command of [
    "echo 'DROP TABLE sample;' | psql",
    "printf '%s' 'DROP DATABASE sample;' | mysql",
    "echo 'DROP TABLE sample;' | cat | psql",
    "echo 'DROP TABLE sample;' | cat",
  ]) {
    const location = fixture();
    const current = harness(location);
    assert.equal((await current.call(command))?.block, true, command);
    assert.equal(current.prompts.length, 1);
    assert.match(current.prompts[0].title, /SQL drop/);
    assert.match(current.prompts[0].title, /WHOLE-COMMAND APPROVAL REQUIRED/);
    assert.ok(!current.prompts[0].options.includes(CHOICE.operationPermanent));
    assert.ok(!current.prompts[0].options.includes(CHOICE.rulePermanent));
    assert.equal((await harness(location, [], { hasUI: false }).call(command))?.block, true);
    assert.deepEqual(entries(location), []);
  }
});

test("SQL pipeline context cannot reuse saved producer or client operation grants", async () => {
  for (const [argv, command] of [
    [["echo", "DROP TABLE sample;"], "echo 'DROP TABLE sample;' | psql"],
    [["psql", "-c", "DROP TABLE sample;"], "psql -c 'DROP TABLE sample;' | cat"],
  ]) {
    const location = fixture();
    seed(location, [{ ...legacy(location, command), matchType: "operation", argv,
      key: operationAllowKey(argv, location.cwd) }]);
    assert.equal((await harness(location).call(command))?.block, true, command);
  }
});

test("whole-command pipeline approval stays exact; standalone printed SQL stays harmless", async () => {
  const location = fixture();
  const command = "echo 'DROP TABLE sample;' | psql";
  const current = harness(location, [CHOICE.commandPermanent]);
  assert.equal(await current.call(command), undefined);
  assert.equal(entries(location)[0]?.matchType, "exact");
  assert.equal(await harness(location).call(command), undefined);
  assert.equal((await harness(location).call("echo 'DROP TABLE sample;' | mysql"))?.block, true);
  const standalone = harness(location);
  assert.equal(await standalone.call("echo 'DROP TABLE sample;'; echo ok | cat"), undefined);
  assert.equal(await standalone.call("echo 'DROP TABLE sample;'; psql"), undefined);
  assert.equal(standalone.prompts.length, 0);
  writeSafetyGuardConfig({ categories: { database: false } }, configFile);
  assert.equal(await harness(location).call("echo 'DROP TABLE other;' | mysql"), undefined);
});

test("automatic review sees SQL pipeline risks and the full invocation", async () => {
  const location = fixture();
  writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
  const reviewed = [];
  const current = harness(location, [], { requestAutoReviewFn: async (_registry, _config, request) => {
    reviewed.push(request);
    return { verdict: "block", reason: "test verdict" };
  } });
  const command = "echo 'DROP TABLE sample;' | psql";
  assert.equal((await current.call(command)).block, true);
  assert.equal(reviewed.length, 1);
  assert.match(reviewed[0].label, /SQL drop table/);
  assert.equal(reviewed[0].pendingText, command);
  assert.equal(current.prompts.length, 0);
  assert.deepEqual(entries(location), []);
});

test("fallback heredocs show all SQL risks in one prompt", async () => {
  const current = harness(fixture());
  assert.equal((await current.call("git switch -c branch-a && psql <<SQL\nDROP DATABASE sample;\nDROP TABLE sample;\nSQL")).block, true);
  assert.equal(current.prompts.length, 1);
  assert.match(current.prompts[0].title, /SQL drop database\/schema/);
  assert.match(current.prompts[0].title, /SQL drop table/);
});

test("legacy exact and label-looking commands never become broader approvals", async () => {
  for (const command of ["git switch", "git switch -c branch-a", "git switch branch creation", "git.switch.create.v1"]) {
    const location = fixture();
    seed(location, [legacy(location, command)]);
    const current = harness(location);
    assert.equal(await current.call(command), undefined);
    assert.equal((await current.call("git switch -c branch-b")).block, true);
  }
});

test("legacy branch-creation grants keep their original standalone-only scope", async () => {
  const location = fixture();
  seed(location, [{ ...legacy(location, "git switch -c branch-a"), matchType: "rule", ruleId: "git.switch.create.v1",
    key: ruleAllowKey("git.switch.create.v1", location.cwd) }]);
  const current = harness(location);
  assert.equal(await current.call("git switch --create branch-b"), undefined);
  for (const command of ["git switch -c branch-b && echo done", 'git switch -c "branch-b"', "git switch -c branch-b\n", "git switch --discard-changes main"]) {
    assert.equal((await current.call(command)).block, true, command);
  }
});

test("invalid discriminators, mismatched keys, and unknown rule IDs fail closed", async () => {
  const location = fixture();
  const base = legacy(location, "git switch -c branch-a");
  const id = operationRule(["git", "switch", "-c", "branch-a"]).id;
  for (const entry of [
    { ...base, matchType: "unknown" }, { ...base, key: `bash:${location.cwd}:git switch` },
    { ...base, matchType: "rule", ruleId: "git.switch.create.v2" },
    { ...base, matchType: "operation", argv: ["git", "switch", "-c", "branch-a"] },
    { ...base, matchType: "operation-rule", ruleId: "unknown", key: operationRuleAllowKey(id, location.cwd) },
    { ...base, matchType: "operation-rule", ruleId: id, kind: "write", key: operationRuleAllowKey(id, location.cwd) },
    { ...base, argv: [] }, { ...base, ruleId: id },
  ]) {
    seed(location, [entry]);
    assert.equal((await harness(location).call("git switch -c branch-a")).block, true);
  }
  fs.writeFileSync(location.allowStorePath, "{broken");
  assert.equal((await harness(location).call("git switch -c branch-a")).block, true);
});

test("disabled categories and the master switch retain explicit controls", async () => {
  const location = fixture();
  writeSafetyGuardConfig({ categories: { git: false } }, configFile);
  const current = harness(location);
  assert.equal(await current.call("git switch -c branch-a"), undefined);
  assert.equal((await current.call("git switch -c branch-a && rm -rf ./old-data")).block, true);
  writeSafetyGuardConfig({ enabled: false }, configFile);
  assert.equal(await current.call("echo $PATH"), undefined);
});

test("noninteractive calls use applicable grants but otherwise fail closed", async () => {
  const location = fixture();
  await harness(location, [CHOICE.rulePermanent]).call("git switch -c branch-a");
  const current = harness(location, [], { hasUI: false });
  assert.equal(await current.call("git switch -c branch-b && echo done"), undefined);
  assert.equal((await current.call("git switch -c branch-b && rm -rf ./old-data")).block, true);
  assert.equal((await current.call("git switch -c branch-b >out")).block, true);
  assert.equal(current.prompts.length, 0);
});

test("one model review sees all pending risk labels and never persists approval", async () => {
  const location = fixture();
  writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
  const reviewed = [];
  const current = harness(location, [], { requestAutoReviewFn: async (_registry, _config, request) => {
    reviewed.push(request);
    return { verdict: "allow", reason: "test verdict" };
  } });
  const command = "git switch -c branch-a && rm -rf ./old-data";
  assert.equal(await current.call(command), undefined);
  assert.equal(reviewed.length, 1);
  assert.match(reviewed[0].label, /git switch.*recursive rm/);
  assert.equal(reviewed[0].pendingText, command);
  assert.equal(current.prompts.length, 0);
  assert.deepEqual(entries(location), []);
});

test("model rejection or fallback still gates the entire invocation once", async () => {
  const location = fixture();
  writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
  const denied = harness(location, [], { requestAutoReviewFn: async () => ({ verdict: "block", reason: "test verdict" }) });
  assert.equal((await denied.call("git switch -c one && rm -rf ./old-data")).block, true);
  assert.equal(denied.prompts.length, 0);
  const fallback = harness(location, [CHOICE.once], { requestAutoReviewFn: async () => { throw new Error("unavailable"); } });
  assert.equal(await fallback.call("git switch -c one && rm -rf ./old-data"), undefined);
  assert.equal(fallback.prompts.length, 1);
  assert.deepEqual(entries(location), []);
});

test("parser failure cannot reuse operation permissions", async () => {
  const location = fixture();
  await harness(location, [CHOICE.operationPermanent]).call("git switch main");
  const current = harness(location, [], { analyzeShellFn: async () => { throw new Error("missing grammar"); } });
  assert.equal((await current.call("git switch main")).block, true);
  assert.match(current.prompts[0].title, /parser unavailable/);
  assert.ok(!current.prompts[0].options.includes(CHOICE.operationPermanent));
});

test("oversized previews offer only once or block and skip bounded model review", async () => {
  const location = fixture();
  writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
  let reviews = 0;
  const current = harness(location, [CHOICE.rulePermanent], { requestAutoReviewFn: async () => { reviews++; return { verdict: "allow", reason: "test" }; } });
  assert.equal((await current.call(`git switch -c ${"a".repeat(70_000)}`)).block, true);
  assert.deepEqual(current.prompts[0].options, ["Block", CHOICE.once]);
  assert.ok(current.prompts[0].title.length < 13_000);
  assert.equal(reviews, 0);
  assert.deepEqual(entries(location), []);
});

test("cancellation before, during parsing, or after the dialog never saves grants", async () => {
  for (const stage of ["before", "parse", "dialog"]) {
    const location = fixture();
    const controller = new AbortController();
    const current = harness(location, [], stage === "parse" ? { analyzeShellFn: async () => {
      controller.abort();
      return { supported: false, reason: "test fallback" };
    } } : {});
    current.ctx.signal = controller.signal;
    if (stage === "before") controller.abort();
    current.ctx.ui.select = async () => { controller.abort(); return CHOICE.operationPermanent; };
    assert.equal((await current.call("git switch one")).block, true, stage);
    assert.deepEqual(entries(location), []);
  }
});

test("risk excerpts escape terminal controls and respect configured context lines", async () => {
  const location = fixture();
  const escaped = harness(location);
  await escaped.call("git switch one\u001b[2J");
  assert.ok(!escaped.prompts[0].title.includes("\u001b"));
  assert.ok(escaped.prompts[0].title.includes("\\u001b"));
  writeSafetyGuardConfig({ contextLines: { before: 0, after: 0 } }, configFile);
  const current = harness(location);
  await current.call("echo before\ngit switch one\necho after");
  const excerpt = current.prompts[0].title;
  assert.match(excerpt, /!!! 2 \|/);
  assert.ok(!excerpt.includes("1 | echo before"));
  assert.ok(!excerpt.includes("3 | echo after"));
});

test("batch storage failure blocks and cleans temporary files", async () => {
  const location = fixture();
  fs.mkdirSync(location.allowStorePath);
  const current = harness(location, [CHOICE.operationPermanent]);
  assert.equal((await current.call("git switch one && git branch -d old")).block, true);
  assert.deepEqual(fs.readdirSync(location.cwd), ["allow.json"]);
});

test("protected paths remain exact, resolved, cwd-specific, and tool-specific", async () => {
  for (const kind of ["write", "edit"]) {
    const location = fixture();
    const choice = `Always allow ${kind} to this path in this cwd`;
    const first = harness(location, [choice]);
    assert.equal(await first.file(kind, ".env"), undefined);
    assert.ok(first.prompts[0].options.includes(choice));
    const current = harness(location);
    assert.equal(await current.file(kind, "./.env"), undefined);
    assert.equal((await current.file(kind, ".env.production")).block, true);
    assert.equal((await current.file(kind === "write" ? "edit" : "write", ".env")).block, true);
    current.ctx.cwd = path.join(location.cwd, "other");
    assert.equal((await current.file(kind, path.join(location.cwd, ".env"))).block, true);
  }
});

test("legacy protected-path and whole compound-command grants still work", async () => {
  const location = fixture();
  const target = path.join(location.cwd, ".env");
  const command = "git switch one && rm -rf ./old-data";
  seed(location, [legacy(location, command), ...["write", "edit"].map((kind) => ({ key: `${kind}:${location.cwd}:${target}`, kind,
    value: target, label: target, cwd: location.cwd, createdAt: "2026-01-01T00:00:00.000Z" }))]);
  const current = harness(location);
  assert.equal(await current.call(command), undefined);
  assert.equal(await current.file("write", ".env"), undefined);
  assert.equal(await current.file("edit", ".env"), undefined);
  assert.equal(current.prompts.length, 0);
});

test("list distinguishes scopes without echoing command contents; clears revoke grants", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.rulePermanent, CHOICE.operationPermanent, CHOICE.commandSession]);
  await current.call("git switch -c secret-branch-name");
  await current.call("git switch main");
  await current.call("git branch -d old");
  await current.control("allow-list");
  assert.match(current.notices.at(-1), /operation-rule Git branch creation/);
  assert.match(current.notices.at(-1), /operation git switch/);
  assert.match(current.notices.at(-1), /exact git branch delete/);
  assert.ok(!current.notices.join("\n").includes("secret-branch-name"));
  await current.control("allow-clear-session");
  assert.equal((await current.call("git branch -d old")).block, true);
  await current.control("allow-clear-permanent");
  assert.deepEqual(entries(location), []);
  assert.equal((await current.call("git switch -c new")).block, true);
});

test("RPC uses the same single dialog and fails closed on dismissal, errors, or forged options", async () => {
  for (const select of [async () => undefined, async () => { throw new Error("UI disconnected"); }, async () => CHOICE.rulePermanent]) {
    const location = fixture();
    const current = harness(location);
    current.ctx.mode = "rpc";
    current.ctx.ui.select = select;
    assert.equal((await current.call("git switch --discard-changes main")).block, true);
    assert.deepEqual(entries(location), []);
  }
  const location = fixture();
  const current = harness(location, [CHOICE.rulePermanent]);
  current.ctx.mode = "rpc";
  assert.equal(await current.call("git switch -c one && git switch -c two"), undefined);
  assert.equal(current.prompts.length, 1);
});
