import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { createSafetyGuardExtension } from "../index.ts";
import { canonicalFilePath, inspectFileTarget, normalizeToolPath } from "../src/protected-paths.ts";
import { defaultSafetyGuardConfig, writeSafetyGuardConfig } from "../src/config.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-protected-paths-"));
const previousConfig = process.env.PI_SAFETY_GUARD_CONFIG_FILE;
const configFile = path.join(root, "settings.json");
process.env.PI_SAFETY_GUARD_CONFIG_FILE = configFile;
after(() => {
  if (previousConfig === undefined) delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  else process.env.PI_SAFETY_GUARD_CONFIG_FILE = previousConfig;
  fs.rmSync(root, { recursive: true, force: true });
});
let counter = 0;
function fixture() {
  const cwd = path.join(root, `workspace-${++counter}`);
  fs.mkdirSync(cwd);
  writeSafetyGuardConfig(defaultSafetyGuardConfig(), configFile);
  return cwd;
}
function harness(cwd, { hasUI = true, choice = "Block", review } = {}) {
  const handlers = new Map();
  const prompts = [];
  createSafetyGuardExtension({ allowStorePath: path.join(cwd, "allow.json"), requestAutoReviewFn: review })({
    on: (name, handler) => handlers.set(name, handler), registerCommand() {},
    appendEntry() { throw new Error("Unexpected session permission"); },
  });
  const ctx = { cwd, hasUI, mode: hasUI ? "tui" : "print", modelRegistry: {},
    sessionManager: { getSessionId: () => "path-tests", getEntries: () => [] },
    ui: { theme: { fg: (_tone, text) => text }, select: async (title, choices) => { prompts.push({ title, choices }); return typeof choice === "function" ? choice() : choice; }, notify() {}, setWidget() {}, setStatus() {} },
  };
  return { prompts, ctx, call: (toolName, input) => handlers.get("tool_call")({ type: "tool_call", toolName, input }, ctx) };
}

test("normalization matches native write paths without touching any target", async () => {
  const cwd = fixture();
  let observed;
  const native = createWriteTool(cwd, { operations: {
    mkdir: async () => {}, writeFile: async (target) => { observed = target; },
  } });
  for (const input of [".env", "@.env", "@@.env", "./dir/../.env", "~/.env", "@~/.env", "./with\u00a0space/.env", pathToFileURL(path.join(cwd, ".env")).href]) {
    await native.execute("normalization-only", { path: input, content: "unused" });
    assert.equal(normalizeToolPath(input, cwd), observed, input);
  }
});

test("native writes and edits through @ paths and symlinks cannot change protected targets", async (t) => {
  const cwd = fixture();
  fs.mkdirSync(path.join(cwd, ".ssh"));
  fs.writeFileSync(path.join(cwd, ".env"), "DUMMY=original\n");
  fs.writeFileSync(path.join(cwd, ".ssh", "dummy"), "DUMMY=original\n");
  const cases = [["@.env", ".env"]];
  if (process.platform !== "win32") {
    fs.symlinkSync(".env", path.join(cwd, "ordinary.txt"));
    fs.symlinkSync(".ssh", path.join(cwd, "ordinary-dir"));
    fs.symlinkSync(".ssh/new-file", path.join(cwd, "dangling.txt"));
    cases.push(["ordinary.txt", ".env"], ["ordinary-dir/dummy", ".ssh/dummy"]);
    assert.equal(inspectFileTarget("ordinary-dir/new/deeper", cwd).protected, true);
    assert.equal(inspectFileTarget("dangling.txt", cwd).resolved, path.join(cwd, ".ssh/new-file"));
    assert.equal(inspectFileTarget("dangling.txt", cwd).protected, true);
  } else t.diagnostic("Symlink cases require link privileges and are covered on POSIX; @ cases still run.");
  const tools = { write: createWriteTool(cwd), edit: createEditTool(cwd) };
  for (const hasUI of [true, false]) for (const [inputPath, actual] of cases) for (const kind of ["write", "edit"]) {
    const guard = harness(cwd, { hasUI });
    const input = kind === "write" ? { path: inputPath, content: "DUMMY=changed\n" }
      : { path: inputPath, edits: [{ oldText: "DUMMY=original", newText: "DUMMY=changed" }] };
    const decision = await guard.call(kind, input);
    if (!decision?.block) await tools[kind].execute("disposable-file-only", input);
    assert.equal(decision?.block, true, `${kind}: ${inputPath}`);
    assert.equal(fs.readFileSync(path.join(cwd, actual), "utf8"), "DUMMY=original\n");
    assert.equal(guard.prompts.length, hasUI ? 1 : 0);
    if (hasUI) assert.ok(guard.prompts[0].title.includes(path.join(cwd, actual)));
    assert.equal(input.path, inputPath, "guard must not rewrite tool paths");
  }
});

test("active settings require fresh human approval despite path toggles, saved grants or model review", async () => {
  const cwd = fixture();
  const input = { path: configFile, content: '{"enabled":false}' };
  writeSafetyGuardConfig({ protectedPaths: { write: false, edit: false }, autoReview: { enabled: true } }, configFile);
  const before = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(path.join(cwd, "allow.json"), JSON.stringify({ version: 1, entries: ["write", "edit"].map((kind) => ({
    kind, value: configFile, cwd, label: "old setting grant", key: `${kind}:${cwd}:${configFile}`, createdAt: new Date().toISOString(),
  })) }));
  let reviews = 0;
  for (const hasUI of [true, false]) for (const kind of ["write", "edit"]) {
    const guard = harness(cwd, { hasUI, review: async () => { reviews++; return { verdict: "allow", reason: "unused" }; } });
    const decision = await guard.call(kind, input);
    assert.equal(decision?.block, true);
    if (hasUI) assert.deepEqual(guard.prompts[0].choices, ["Block", "Allow once"]);
  }
  assert.equal(reviews, 0);
  assert.equal(fs.readFileSync(configFile, "utf8"), before);
  for (const choice of ["Allow for this session", `Always allow write to this path in this cwd`]) {
    assert.equal((await harness(cwd, { choice }).call("write", input))?.block, true);
  }
  assert.equal(await harness(cwd, { choice: "Allow once" }).call("write", input), undefined);
  assert.equal((await harness(cwd).call("write", input))?.block, true);
});

test("default and custom settings paths include aliases", { skip: process.platform === "win32" }, () => {
  const cwd = fixture();
  fs.symlinkSync(configFile, path.join(cwd, "settings-alias"));
  assert.equal(inspectFileTarget("settings-alias", cwd).isSettings, true);
  const previous = process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  try {
    delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
    assert.equal(inspectFileTarget("@~/.pi/agent/safety-guard.json", cwd).isSettings, true);
  } finally { process.env.PI_SAFETY_GUARD_CONFIG_FILE = previous; }
});

test("changing a link during approval blocks without persisting a permission", { skip: process.platform === "win32" }, async () => {
  const cwd = fixture();
  fs.writeFileSync(path.join(cwd, ".env"), "first");
  fs.writeFileSync(path.join(cwd, ".npmrc"), "second");
  const link = path.join(cwd, "alias");
  fs.symlinkSync(".env", link);
  const guard = harness(cwd, { choice: () => {
    fs.unlinkSync(link); fs.symlinkSync(".npmrc", link);
    return "Always allow write to this path in this cwd";
  } });
  assert.match((await guard.call("write", { path: "alias", content: "unused" })).reason, /target changed/);
  assert.equal(fs.existsSync(path.join(cwd, "allow.json")), false);
});

test("link cycles fail closed while missing ordinary paths remain writable", { skip: process.platform === "win32" }, async () => {
  const cwd = fixture();
  fs.symlinkSync("loop", path.join(cwd, "loop"));
  assert.throws(() => canonicalFilePath(path.join(cwd, "loop")), /Too many symbolic links/);
  const guard = harness(cwd, { hasUI: false });
  assert.equal((await guard.call("write", { path: "loop", content: "unused" }))?.block, true);
  assert.equal(await guard.call("write", { path: "new/plain.txt", content: "unused" }), undefined);
});
