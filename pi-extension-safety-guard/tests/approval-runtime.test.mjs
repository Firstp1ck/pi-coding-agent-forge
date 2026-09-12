import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectApprovalFile } from "../src/approval-store.ts";
import { after, test } from "node:test";
import { createSafetyGuardExtension } from "../index.ts";
import { ruleAllowKey, operationRule, operationRuleAllowKey, operationAllowKey, globalOperationAllowKey } from "../src/approvals.ts";
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
function harness(location, choices = [], { hasUI = true, requestAutoReviewFn, analyzeShellFn, session = { id: randomUUID(), entries: [] } } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  const notices = [];
  createSafetyGuardExtension({ allowStorePath: location.allowStorePath, requestAutoReviewFn, analyzeShellFn })({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (customType, data) => session.entries.push({ type: "custom", customType, data: structuredClone(data) }),
  });
  const ctx = {
    cwd: location.cwd, hasUI, mode: hasUI ? "tui" : "print", modelRegistry: {},
    sessionManager: { getSessionId: () => session.id, getEntries: () => session.entries },
    ui: {
      theme: { fg: (_tone, value) => value },
      select: async (title, options) => { prompts.push({ title, options }); return choices.shift() ?? "Block"; },
      notify: (message) => notices.push(message), setStatus() {}, setWidget() {},
    },
  };
  return {
    prompts, notices, ctx, session,
    start: () => handlers.get("session_start")({}, ctx),
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
function entries(location) {
  const all = [projectApprovalFile(location.cwd), location.allowStorePath].flatMap((file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).entries : []);
  return [...new Map(all.map((entry) => [entry.key, entry])).values()];
}

test("one prompt shows every operation and risk; block saves nothing", async () => {
  const location = fixture();
  const current = harness(location);
  assert.equal((await current.call("git switch -c branch-a && rm -rf ./important-data")).block, true);
  assert.equal(current.prompts.length, 1);
  assert.match(current.prompts[0].title, /1\. NEEDS APPROVAL.*git switch/);
  assert.match(current.prompts[0].title, /2\. NEEDS APPROVAL.*rm -rf/);
  assert.match(current.prompts[0].title, /recursive force rm/);
  assert.deepEqual(entries(location), []);
  assert.ok(!current.prompts[0].options.includes(CHOICE.rulePermanent));
});

test("prompts mark the actual risk pattern, not the surrounding unsupported syntax", async () => {
  for (const [command, marker, reason] of [
    ["psql <<SQL\nDROP TABLE sample;\nSQL", ">>> DROP TABLE <<<", /SQL drop table/],
    ["git 'switch' main", ">>> git 'switch' <<<", /git switch/],
    ["git switch main > /tmp/out", ">>> git switch <<<", /git switch/],
  ]) {
    const current = harness(fixture());
    assert.equal((await current.call(command)).block, true);
    const title = current.prompts[0].title;
    assert.match(title, reason);
    assert.ok(title.includes(marker), title);
    assert.ok(title.indexOf(marker) > title.indexOf("\n\nCommand\n"));
    assert.ok(title.indexOf(marker) < title.indexOf("\n\nRisk\n"));
    assert.ok(!title.includes("Risk excerpts"));
    assert.ok(!title.includes("Unverified shell execution"));
    assert.ok(!title.includes(">>> > /tmp/out <<<"));
    assert.ok(!title.includes(">>> <<SQL <<<"));
  }
  const current = harness(fixture(), [], { analyzeShellFn: async () => { throw new Error("test failure"); } });
  assert.equal(await current.call("git diff --stat"), undefined);
  assert.equal((await current.call("git switch main")).block, true);
  assert.match(current.prompts[0].title, />>> git switch <<</);
  assert.ok(!current.prompts[0].title.includes("No specific snippet identified"));
});

test("published pattern-driven behavior allows routine diagnostics even when parsing fails", async () => {
  const commands = [
    "git diff --stat; git diff -- pi-extension-safety-guard/src/bash-prompt.ts pi-extension-safety-guard/index.ts pi-extension-safety-guard/tests/approval-runtime.test.mjs",
    "tsc --noEmit --skipLibCheck --allowImportingTsExtensions --module nodenext --target es2022 pi-extension-safety-guard/src/bash-dialog.ts pi-extension-safety-guard/src/bash-prompt.ts",
    "git diff --check; git diff --check -- '*.md' ':(exclude)**/node_modules/**' ':(exclude)**/vendor/**'; git status --short; git diff --stat",
    ...[12, 20, 28].map((lines) => `npm test --prefix pi-extension-safety-guard > /tmp/safety-guard-tests.log 2>&1; result=$?; tail -${lines} /tmp/safety-guard-tests.log; exit "$result"`),
    "node --input-type=module <<'JS'\nimport { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconsole.log(req.resolve('web-tree-sitter'));\nJS",
    "node --input-type=module <<'JS'\nimport { createJiti } from 'jiti';\nconst jiti = createJiti(import.meta.url);\nconst { analyzeShell } = await jiti.import('./src/shell-analysis.ts');\nconsole.log(await analyzeShell('git diff --stat'));\nJS",
    "echo $PATH", "node -e '0'", "echo ok > /tmp/out", "echo ok\u001b[0m",
  ];
  for (const hasUI of [true, false]) for (const failure of [false, true]) {
    const location = fixture();
    writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
    let reviews = 0;
    const current = harness(location, [], { hasUI,
      ...(failure ? { analyzeShellFn: async () => { throw new Error("missing grammar"); } } : {}),
      requestAutoReviewFn: async () => { reviews++; return { verdict: "block", reason: "should not review" }; },
    });
    for (const command of commands) assert.equal(await current.call(command), undefined, command);
    assert.equal(current.prompts.length, 0);
    assert.equal(reviews, 0);
    assert.deepEqual(entries(location), []);
  }
});

test("known risks still prompt with broken parsing and always have a matched snippet", async () => {
  for (const [command, label] of [
    ["git reset --hard", "git reset --hard"], ["rm -rf ./data", "recursive force rm"],
    ["docker volume prune", "docker volume removal/prune"], ["npm uninstall example", "JS package removal"],
    ["sudo true", "sudo"], ["psql <<SQL\nDROP TABLE sample;\nSQL", "SQL drop table"],
    ["cat .env", "possible secret file access"],
  ]) {
    const current = harness(fixture(), [], { analyzeShellFn: async () => { throw new Error("missing grammar"); } });
    assert.equal((await current.call(command)).block, true, command);
    assert.ok(current.prompts[0].title.includes(label), command);
    assert.ok(current.prompts[0].title.includes(">>> "), command);
    assert.ok(!current.prompts[0].title.includes("Unverified shell execution"), command);
    assert.ok(!current.prompts[0].options.includes(CHOICE.operationPermanent), command);
  }
});

test("masked heredoc bodies preserve source positions for real risks after the body", async () => {
  const current = harness(fixture());
  const command = "node <<'JS'\n// git switch fake; rm -rf fake\nconsole.log('ok');\nJS\ngit switch real";
  assert.equal((await current.call(command)).block, true);
  const title = current.prompts[0].title;
  assert.match(title, /5 \| >>> git switch <<< real/);
  assert.ok(!title.includes(">>> rm -rf"));
  assert.ok(!title.includes("recursive rm"));
});

test("pattern checks do not discard risks beyond the parser input limit", async () => {
  const current = harness(fixture());
  const command = `echo ${"x".repeat(70_000)}\nrm -rf ./data`;
  assert.equal((await current.call(command)).block, true);
  assert.deepEqual(current.prompts[0].options, ["Block", CHOICE.once]);
  assert.match(current.prompts[0].title, /recursive rm/);
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

test("global exact operations persist across reload and cwd but never allow different arguments", async () => {
  const location = fixture();
  const first = harness(location, [CHOICE.operationEverywhere]);
  assert.equal(await first.call("rm -rf ./build && rm -rf ./build"), undefined);
  assert.deepEqual(entries(location).map(({ matchType, cwd, argv, key }) => ({ matchType, cwd, argv, key })), [{
    matchType: "operation-global", cwd: "", argv: ["rm", "-rf", "./build"], key: globalOperationAllowKey(["rm", "-rf", "./build"]),
  }]);
  const current = harness(location);
  current.ctx.cwd = path.join(location.cwd, "other-project");
  assert.equal(await current.call("rm '-rf' ./build && echo done"), undefined);
  assert.equal(current.prompts.length, 0);
  for (const command of ["rm -rf ./other", "rm -r ./build", "rm -rf ./build --", "git switch main"]) {
    assert.equal((await current.call(command)).block, true, command);
  }
  assert.equal(entries(location).length, 1);
});

test("global choices grant only pending operations and do not widen existing cwd permissions", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationPermanent, CHOICE.operationEverywhere]);
  await current.call("git switch main");
  await current.call("git switch main && git branch -d old");
  assert.deepEqual(entries(location).map((entry) => entry.matchType), ["operation", "operation-global"]);
  current.ctx.cwd = path.join(location.cwd, "other-project");
  assert.equal(await current.call("git branch -d old"), undefined);
  assert.equal((await current.call("git switch main")).block, true);
});

test("global grants cannot cover another risky operation, unsupported syntax or protected file tools", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationEverywhere, CHOICE.operationEverywhere]);
  await current.call("git switch main");
  await current.call("cat .env");
  current.ctx.cwd = path.join(location.cwd, "other-project");
  assert.equal((await current.call("git switch main && rm -rf ./other")).block, true);
  for (const command of ["git switch main > /tmp/out", "git switch $BRANCH"]) {
    assert.equal((await current.call(command)).block, true);
    assert.ok(!current.prompts.at(-1).options.includes(CHOICE.operationEverywhere));
  }
  assert.equal((await current.file("write", ".env")).block, true);
  assert.equal((await current.file("edit", ".env")).block, true);
  const brokenParser = harness(location, [], { analyzeShellFn: async () => { throw new Error("unavailable"); } });
  assert.equal((await brokenParser.call("git switch main")).block, true);
  assert.equal(entries(location).length, 2);
});

test("global SQL operation grants cannot authorize a pipeline receiver", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationEverywhere]);
  const command = "psql -c 'DROP TABLE sample;'";
  assert.equal(await current.call(command), undefined);
  current.ctx.cwd = path.join(location.cwd, "other-project");
  assert.equal(await current.call(command), undefined);
  assert.equal((await current.call(`${command} | cat`)).block, true);
  assert.ok(!current.prompts.at(-1).options.includes(CHOICE.operationEverywhere));
});

test("global identities reject malformed or disguised cwd-scoped entries", async () => {
  const location = fixture();
  const command = "git switch main";
  const argv = ["git", "switch", "main"];
  const base = { ...legacy(location, command), matchType: "operation-global", argv, cwd: "", key: globalOperationAllowKey(argv) };
  for (const patch of [
    { cwd: location.cwd }, { cwd: "*" }, { kind: "write" }, { kind: "edit" },
    { argv: [] }, { argv: ["git", 1] }, { argv: undefined }, { ruleId: "git.switch.create.operation.v1" },
    { key: operationAllowKey(argv, location.cwd) }, { matchType: "operation" }, { matchType: undefined },
  ]) {
    seed(location, [{ ...base, ...patch }]);
    assert.equal((await harness(location).call(command)).block, true, JSON.stringify(patch));
  }
  seed(location, [{ ...base, matchType: "operation", cwd: "*", key: operationAllowKey(argv, "*") }]);
  assert.equal((await harness(location).call(command)).block, true);
});

test("global grants bypass review across directories and are clearly listed and revocable", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationEverywhere]);
  await current.call("git switch private-branch-name");
  assert.match(current.notices.at(-1), /operation-global git switch @ EVERYWHERE/);
  assert.ok(!current.notices.at(-1).includes("private-branch-name"));
  await current.control("allow-list");
  assert.match(current.notices.at(-1), /EVERYWHERE/);
  assert.ok(!current.notices.at(-1).includes("private-branch-name"));
  writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
  let reviews = 0;
  const reloaded = harness(location, [], { hasUI: false, requestAutoReviewFn: async () => { reviews++; throw new Error("should skip review"); } });
  reloaded.ctx.cwd = path.join(location.cwd, "other-project");
  assert.equal(await reloaded.call("git switch private-branch-name"), undefined);
  assert.equal(reviews, 0);
  await reloaded.control("allow-clear-permanent");
  assert.deepEqual(entries(location), []);
  assert.equal((await reloaded.call("git switch private-branch-name")).block, true);
});

test("unoffered global choices, late aborts and storage failures never save global grants", async () => {
  const unoffered = fixture();
  assert.equal((await harness(unoffered, [CHOICE.operationEverywhere]).call("git switch main >out")).block, true);
  assert.deepEqual(entries(unoffered), []);
  const cancelled = fixture();
  const controller = new AbortController();
  const current = harness(cancelled);
  current.ctx.signal = controller.signal;
  current.ctx.ui.select = async () => { controller.abort(); return CHOICE.operationEverywhere; };
  assert.equal((await current.call("git switch main")).block, true);
  assert.deepEqual(entries(cancelled), []);
  const failed = fixture();
  fs.mkdirSync(failed.allowStorePath);
  assert.equal((await harness(failed, [CHOICE.operationEverywhere]).call("git switch main")).block, true);
  assert.deepEqual(fs.readdirSync(failed.cwd), ["allow.json"]);
});

test("legacy whole-command approvals stay exact, while removed choices cannot create new grants", async () => {
  const location = fixture();
  seed(location, [legacy(location, "git switch -c branch-a")]);
  const current = harness(location);
  assert.equal(await current.call("git switch -c branch-a"), undefined);
  assert.equal((await current.call("git switch -c branch-a && echo done")).block, true);
  assert.equal((await current.call("git switch -c branch-b")).block, true);
  assert.equal((await current.call("git  switch -c branch-a")).block, true);
  for (const choice of ["Allow this exact command for this session", "Always allow this exact command in this cwd"]) {
    const fresh = fixture();
    const rejected = harness(fresh, [choice]);
    assert.equal((await rejected.call("git switch main")).block, true);
    assert.ok(!rejected.prompts[0].options.includes(choice));
    assert.deepEqual(entries(fresh), []);
    assert.deepEqual(rejected.session.entries, []);
  }
});

test("session lifecycle restores the same session, persists clearing, and rejects new/forked sessions", async () => {
  const location = fixture();
  const first = harness(location, [CHOICE.operationSession]);
  assert.equal(await first.call("git switch main"), undefined);
  assert.equal(first.session.entries.length, 1);
  assert.deepEqual(entries(location), []);
  const resumed = harness(location, [], { session: first.session });
  await resumed.start();
  assert.equal(await resumed.call("git switch main"), undefined);
  assert.equal(resumed.prompts.length, 0);
  const forked = harness(location, [], { session: { id: randomUUID(), entries: structuredClone(first.session.entries) } });
  await forked.start();
  assert.equal((await forked.call("git switch main")).block, true);
  assert.equal((await harness(location).call("git switch main")).block, true);
  await resumed.control("allow-clear-session");
  const cleared = harness(location, [], { session: first.session });
  await cleared.start();
  assert.equal((await cleared.call("git switch main")).block, true);
});

test("guard routes permanent grants physically and clears only current cwd plus EVERYWHERE", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationPermanent, CHOICE.operationEverywhere, CHOICE.operationPermanent]);
  await current.call("git switch main");
  assert.equal(fs.existsSync(location.allowStorePath), false);
  assert.equal(JSON.parse(fs.readFileSync(projectApprovalFile(location.cwd), "utf8")).entries.length, 1);
  await current.call("rm -rf ./build");
  assert.ok(JSON.parse(fs.readFileSync(location.allowStorePath, "utf8")).entries.every((entry) => entry.matchType === "operation-global"));
  const other = path.join(location.cwd, "other-project");
  fs.mkdirSync(other);
  current.ctx.cwd = other;
  await current.call("git branch -d old");
  assert.equal(JSON.parse(fs.readFileSync(projectApprovalFile(other), "utf8")).entries.length, 1);
  await current.control("allow-clear-permanent");
  assert.deepEqual(JSON.parse(fs.readFileSync(projectApprovalFile(other), "utf8")).entries, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(location.allowStorePath, "utf8")).entries, []);
  current.ctx.cwd = location.cwd;
  assert.equal(await current.call("git switch main"), undefined);
});

test("changing session or cwd while an approval is open saves nothing", async () => {
  for (const change of ["session", "cwd"]) {
    const location = fixture();
    const current = harness(location);
    current.ctx.ui.select = async () => {
      if (change === "session") current.session.id = randomUUID();
      else current.ctx.cwd = path.join(location.cwd, "other-project");
      return CHOICE.operationEverywhere;
    };
    assert.equal((await current.call("git switch main")).block, true);
    assert.deepEqual(entries(location), []);
    assert.deepEqual(current.session.entries, []);
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
    "git switch -c branch-b &", "git switch -c branch-b &&", "git switch -c branch-b\u2028",
  ]) {
    const current = harness(location);
    assert.equal((await current.call(command)).block, true, command);
    assert.match(current.prompts[0].title, /Whole-command approval required/);
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

test("unlisted wrappers retain risk matches in interactive and noninteractive calls", async () => {
  const commands = [
    "busybox rm -rf ./data", "systemd-run -- rm -rf ./data", "setsid rm -rf ./data",
    "script -qc 'rm -rf ./data' /dev/null", "tmux new -d rm -rf ./data", "ssh host rm -rf ./data",
    "parallel rm -rf ./data", "custom-wrapper rm -rf ./data", "custom-wrapper 'rm' '-rf' ./data",
    "systemd-run --unit x -- rm -rf ./data", "timeout 5 rm -rf ./data",
    "find ./data -exec rm -rf {} +", "xargs rm -rf ./data", "/bin/rm -rf ./data",
    "sudo rm -rf ./data", "bash -c 'rm -rf ./data'", "env rm -rf ./data",
    "awk 'BEGIN { system(\"rm -rf ./data\") }'", "sed 'e rm -rf ./data'",
    "rg --pre 'rm -rf ./data' pattern", "git submodule foreach 'rm -rf ./data'",
  ];
  for (const hasUI of [true, false]) for (const base of commands) {
    for (const command of [base, `${base}; head -5`, `${base}; head -n 5`]) {
      const location = fixture();
      const current = harness(location, [], { hasUI });
      assert.equal((await current.call(command))?.block, true, command);
      assert.equal(current.prompts.length, hasUI ? 1 : 0, command);
      if (hasUI) {
        assert.match(current.prompts[0].title, /recursive force rm/, command);
        assert.ok(current.prompts[0].title.includes(">>> "), command);
      }
      assert.deepEqual(entries(location), [], command);
      assert.deepEqual(current.session.entries, [], command);
    }
  }
});

test("the screenshot pipeline has one highlighted command and one combined display risk", async () => {
  const current = harness(fixture());
  const command = "setsid rm -rf --help | head -5";
  assert.equal((await current.call(command))?.block, true);
  const { title, options } = current.prompts[0];
  assert.equal(title.split("setsid").length - 1, 1);
  assert.equal(title.split(">>> rm -rf <<<").length - 1, 1);
  assert.equal(title.split("recursive force rm").length - 1, 1);
  assert.ok(!title.includes("Risk excerpts"));
  assert.ok(!title.includes("Operations\n"));
  assert.match(title, /Whole-command approval required\nThis pipeline includes/);
  assert.deepEqual(options, ["Block", CHOICE.once]);
});

test("numeric diagnostics and reviewed data commands retain false-positive suppression", async () => {
  for (const hasUI of [true, false]) {
    const current = harness(fixture(), [], { hasUI });
    for (const command of [
      'echo "=== music mount ==="', `grep -c '"sudo"' /home/USER/.bash_history`, "# reboot the box later",
      ...["-5", "5", "+5", "-n 5", "--lines=5"].map((flags) => `journalctl -g "reboot" | head ${flags}`),
      'journalctl -g "reboot" | tail -5', 'echo "rm -rf ./data" | head -5',
      'grep "reboot" ./log | head -5', 'echo "rm -rf ./data"; custom-wrapper harmless',
      'echo "rm -rf ./data"; echo harmless | custom-wrapper', "custom-wrapper harmless",
    ]) assert.equal(await current.call(command), undefined, command);
    assert.equal(current.prompts.length, 0);
  }
});

test("numeric support preserves direct risk detection and enabled-category controls", async () => {
  const location = fixture();
  const current = harness(location);
  for (const command of ["chmod 777 ./data", "truncate -s 0 ./data", "kill -9 12345", "rm -rf 5"]) {
    assert.equal((await current.call(command))?.block, true, command);
  }
  writeSafetyGuardConfig({ categories: { filesystem: false } }, configFile);
  assert.equal(await current.call("custom-wrapper rm -rf ./data; head -5"), undefined);
  writeSafetyGuardConfig({ enabled: false }, configFile);
  assert.equal(await current.call("custom-wrapper reboot; head -5"), undefined);
});

test("unknown pipeline receivers cannot hide executable text or reuse producer grants", async () => {
  for (const hasUI of [true, false]) for (const command of [
    "echo 'rm -rf ./data' | busybox sh", "printf '%s' 'rm -rf ./data' | custom-wrapper",
    "echo 'rm -rf ./data' | cat | custom-wrapper", "echo 'reboot' | custom-wrapper",
    "busybox rm -rf ./data | cat", "echo harmless | custom-wrapper rm -rf ./data",
  ]) {
    const location = fixture();
    const current = harness(location, [], { hasUI });
    assert.equal((await current.call(command))?.block, true, command);
    if (hasUI) {
      assert.deepEqual(current.prompts[0].options, ["Block", CHOICE.once], command);
      assert.match(current.prompts[0].title, /Whole-command approval required/, command);
    }
  }
  for (const argv of [["echo", "rm -rf ./data"], ["busybox", "rm", "-rf", "./data"]]) {
    for (const matchType of ["operation", "operation-global"]) {
      const location = fixture();
      const command = argv[0] === "echo" ? "echo 'rm -rf ./data' | custom-wrapper" : "busybox rm -rf ./data | cat";
      seed(location, [{ ...legacy(location, command), matchType, argv,
        cwd: matchType === "operation-global" ? "" : location.cwd,
        key: matchType === "operation-global" ? globalOperationAllowKey(argv) : operationAllowKey(argv, location.cwd) }]);
      const current = harness(location, [], { hasUI: false });
      assert.equal((await current.call(command))?.block, true, `${matchType}: ${command}`);
    }
  }
});

test("wrapper matches reach automatic review with the complete invocation", async () => {
  for (const hasUI of [true, false]) for (const command of ["custom-wrapper rm -rf ./data", "custom-wrapper rm -rf ./data; head -5"]) {
    const location = fixture();
    writeSafetyGuardConfig({ autoReview: { enabled: true } }, configFile);
    const reviewed = [];
    const current = harness(location, [], { hasUI, requestAutoReviewFn: async (_registry, _config, request) => {
      reviewed.push(request);
      return { verdict: "block", reason: "test verdict" };
    } });
    assert.equal((await current.call(command))?.block, true);
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].pendingText, command);
    assert.match(reviewed[0].label, /recursive rm/);
    assert.equal(current.prompts.length, 0);
    assert.deepEqual(entries(location), []);
  }
});

test("wrapper detection falls back to whole-command matching on unavailable or throwing analysis", async () => {
  for (const analyzeShellFn of [
    async () => ({ supported: false, reason: "Shell parser unavailable" }),
    async () => { throw new Error("test parser exception"); },
  ]) for (const hasUI of [true, false]) {
    const location = fixture();
    const current = harness(location, [], { hasUI, analyzeShellFn });
    for (const command of ["busybox rm -rf ./data", "custom-wrapper rm -rf ./data; head -5"]) {
      assert.equal((await current.call(command))?.block, true, command);
      if (hasUI) assert.deepEqual(current.prompts.at(-1).options, ["Block", CHOICE.once], command);
    }
    assert.equal(await current.call("custom-wrapper harmless"), undefined);
    assert.deepEqual(entries(location), []);
  }
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
    assert.match(current.prompts[0].title, /Whole-command approval required/);
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

test("legacy pipeline approval stays exact; new pipeline decisions offer only once or block", async () => {
  const location = fixture();
  const command = "echo 'DROP TABLE sample;' | psql";
  seed(location, [{ ...legacy(location, command), matchType: "exact" }]);
  const current = harness(location);
  assert.equal(await current.call(command), undefined);
  assert.equal(entries(location)[0]?.matchType, "exact");
  assert.equal(await harness(location).call(command), undefined);
  assert.equal((await harness(location).call("echo 'DROP TABLE sample;' | mysql"))?.block, true);
  const fresh = harness(fixture(), [CHOICE.once]);
  assert.equal(await fresh.call(command), undefined);
  assert.deepEqual(fresh.prompts[0].options, ["Block", CHOICE.once]);
  assert.equal((await fresh.call(command)).block, true);
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

test("quoted fallback commands, global options and destructive flag variants remain guarded", async () => {
  const commands = [
    "env 'rm' '-rf' ./data", "env 'rm' '-f' ./data", "'rm' '-rf' ./data > /dev/null",
    "git --no-pager reset --hard", "git -C . reset --hard", "git -C './two words' reset --hard",
    "git --git-dir='./repo with spaces' reset --hard", "git '-C' '.' 'reset' '--hard'",
    "docker --context default volume prune", "docker --context='two words' volume prune",
    "docker -H unix:///var/run/docker.sock volume prune", "docker --config './two words' volume prune",
    "rm -f ./important-file", "rm --force ./important-file", "rm -fv ./important-file",
    "git checkout -f main", "git checkout --force main", "git checkout main -f",
    "git branch --delete --force old", "git branch --force --delete old", "git branch -fD old",
    "git -c 'alias.danger=!rm -rf ./data' danger",
  ];
  for (const hasUI of [true, false]) for (const failedParser of [false, true]) for (const command of commands) {
    const location = fixture();
    const current = harness(location, [], { hasUI,
      ...(failedParser ? { analyzeShellFn: async () => { throw new Error("test unavailable parser"); } } : {}),
    });
    assert.equal((await current.call(command))?.block, true, command);
    assert.equal(current.prompts.length, hasUI ? 1 : 0, command);
    if (hasUI) assert.ok(current.prompts[0].title.includes(">>> "), command);
    assert.deepEqual(entries(location), [], command);
  }
});

test("normalizing command options for detection cannot broaden operation grants", async () => {
  const location = fixture();
  const current = harness(location, [CHOICE.operationPermanent, CHOICE.rulePermanent]);
  await current.call("docker volume prune");
  await current.call("git switch main");
  for (const command of ["docker --context other volume prune", "git -C other switch main", "git --no-pager switch main"]) {
    assert.equal((await current.call(command))?.block, true, command);
  }
  assert.equal(entries(location).length, 2);
});

test("heredoc and here-string risk detection covers shell input, expansions and false openers", async () => {
  const commands = [
    "bash <<'EOF'\nrm -rf ./data\nEOF", "bash <<'EOF'\n'rm' '-rf' ./data\nEOF",
    "cat <<EOF\n$(rm -rf ./data)\nEOF", "cat <<EOF\n`rm -rf ./data`\nEOF",
    "node <<EOF\n$(rm -rf ./data)\nEOF", "cat <<'EOF' | bash\nrm -rf ./data\nEOF",
    "custom-wrapper <<'EOF'\nrm -rf ./data\nEOF", "cat <<'EOF' > ./script\nrm -rf ./data\nEOF",
    "# <<EOF\nrm -rf ./data > /dev/null", "echo '<<EOF'\nrm -rf ./data > /dev/null",
    "cat <<< harmless\nrm -rf ./data", "bash <<< 'rm -rf ./data'",
    "bash <<-EOF\n\trm -rf ./data\n\tEOF",
  ];
  for (const hasUI of [true, false]) for (const failedParser of [false, true]) for (const command of commands) {
    const location = fixture();
    const current = harness(location, [], { hasUI,
      ...(failedParser ? { analyzeShellFn: async () => { throw new Error("test unavailable parser"); } } : {}),
    });
    assert.equal((await current.call(command))?.block, true, command);
    assert.equal(current.prompts.length, hasUI ? 1 : 0);
    if (hasUI) {
      assert.deepEqual(current.prompts[0].options, ["Block", CHOICE.once], command);
      assert.ok(current.prompts[0].title.includes(">>> "), command);
    }
    assert.deepEqual(entries(location), []);
  }
});

test("harmless heredoc content remains quiet only when syntax proves a data consumer", async () => {
  for (const hasUI of [true, false]) {
    const location = fixture();
    const current = harness(location, [], { hasUI });
    for (const command of [
      "cat <<'EOF'\nrm -rf ./example\nEOF", "node <<'JS'\nconsole.log('rm -rf ./example');\nJS",
      "cat <<< harmless\necho done", "# <<EOF\necho done > /dev/null",
      "git --no-pager status", "docker --context default ps", "env 'echo' 'hello'",
    ]) assert.equal(await current.call(command), undefined, command);
    assert.equal(current.prompts.length, 0);
    const unavailable = harness(location, [], { hasUI, analyzeShellFn: async () => { throw new Error("test unavailable parser"); } });
    assert.equal((await unavailable.call("node <<'JS'\nconsole.log('rm -rf ./example');\nJS"))?.block, true);
  }
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
  assert.match(current.prompts[0].title, />>> git switch <<</);
  assert.match(current.prompts[0].title, /Whole-command approval required\nShell parser unavailable/);
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

test("command previews escape controls and truncated excerpts respect configured context lines", async () => {
  const location = fixture();
  const escaped = harness(location);
  await escaped.call("git switch one\u001b[2J");
  assert.ok(!escaped.prompts[0].title.includes("\u001b"));
  assert.ok(escaped.prompts[0].title.includes("\\u001b"));
  writeSafetyGuardConfig({ contextLines: { before: 0, after: 0 } }, configFile);
  const current = harness(location);
  await current.call("echo before\ngit switch one\necho after");
  const compact = current.prompts[0].title;
  assert.match(compact, /2 \| >>> git switch <<< one/);
  assert.ok(compact.includes("1 | echo before"));
  assert.ok(compact.includes("3 | echo after"));
  assert.ok(!compact.includes("Risk excerpts"));
  await current.call(`echo ${"x".repeat(14_000)}\necho before\ngit switch one\necho after`);
  const excerpt = current.prompts.at(-1).title.split("Risk excerpts\n")[1];
  assert.ok(excerpt);
  assert.match(excerpt, /!!! 3 \|/);
  assert.ok(!excerpt.includes("2 | echo before"));
  assert.ok(!excerpt.includes("4 | echo after"));
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
  const current = harness(location, [CHOICE.rulePermanent, CHOICE.operationPermanent, CHOICE.operationSession]);
  await current.call("git switch -c secret-branch-name");
  await current.call("git switch main");
  await current.call("git branch -d old");
  await current.control("allow-list");
  assert.match(current.notices.at(-1), /operation-rule Git branch creation/);
  assert.match(current.notices.at(-1), /operation git switch/);
  assert.match(current.notices.at(-1), /operation git branch delete/);
  assert.ok(!current.notices.join("\n").includes("secret-branch-name"));
  await current.control("allow-clear-session");
  assert.equal((await current.call("git branch -d old")).block, true);
  await current.control("allow-clear-permanent");
  assert.deepEqual(entries(location), []);
  assert.equal((await current.call("git switch -c new")).block, true);
});

test("custom TUI dismissal, errors, unoffered options and late abort never save permissions", async () => {
  for (const custom of [async () => undefined, async () => { throw new Error("UI disconnected"); }, async () => CHOICE.rulePermanent]) {
    const location = fixture();
    const current = harness(location);
    current.ctx.ui.custom = custom;
    assert.equal((await current.call("git switch --discard-changes main")).block, true);
    assert.equal(current.prompts.length, 0);
    assert.deepEqual(entries(location), []);
  }
  const location = fixture();
  const controller = new AbortController();
  const current = harness(location);
  current.ctx.signal = controller.signal;
  current.ctx.ui.custom = async () => { controller.abort(); return CHOICE.operationPermanent; };
  assert.equal((await current.call("git switch main")).block, true);
  assert.deepEqual(entries(location), []);
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
