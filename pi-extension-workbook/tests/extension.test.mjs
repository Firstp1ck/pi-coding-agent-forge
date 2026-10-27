import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import workbookExtension from "../index.ts";
import { boundedJsonResult } from "../src/output.ts";
import { writeWorkbookFixture } from "./fixture-builder.mjs";
import { Value } from "typebox/value";
import { VbaEditSchema, VbaReadSchema } from "../src/schemas.ts";
import { sha256File } from "../src/core/hash.ts";

test("large tool output is bounded and written to a complete artifact", async (t) => {
  const result = await boundedJsonResult({ sourcePath: "fixture.xlsx", rows: Array.from({ length: 2000 }, (_, index) => ({ index, value: "x".repeat(40) })) }, "bounded-output-test", 1000);
  assert.equal(result.details.truncated, true);
  assert.ok(result.content[0].text.length < 1000);
  const artifact = result.details.artifactPath;
  const full = JSON.parse(await fs.readFile(artifact, "utf8"));
  assert.equal(full.rows.length, 2000);
  t.after(() => fs.rm(path.dirname(artifact), { recursive: true, force: true }));
});

test("extension registers eight strict workbook tools and setup commands", async (t) => {
  const tools = [];
  const commands = [];
  workbookExtension({
    on() {},
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, command) { commands.push({ name, command }); },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["workbook_inspect", "workbook_read", "workbook_render", "workbook_edit", "workbook_diff", "workbook_validate", "workbook_vba_read", "workbook_vba_edit"]);
  assert.deepEqual(commands.map((command) => command.name), ["workbook-doctor", "workbook-vba"]);
  for (const tool of tools) {
    assert.ok(tool.parameters);
    assert.ok(tool.promptSnippet);
    assert.ok(Array.isArray(tool.promptGuidelines));
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-extension-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const source = await writeWorkbookFixture(path.join(cwd, "source.xlsx"));
  const inspect = tools.find((tool) => tool.name === "workbook_inspect");
  const updates = [];
  const result = await inspect.execute("test", { path: source }, undefined, (update) => updates.push(update), { cwd });
  assert.equal(result.details.validation.ok, true);
  assert.ok(result.content[0].text.includes("sourceSha256"));
  assert.equal(updates.length, 1);

  const render = tools.find((tool) => tool.name === "workbook_render");
  const rendered = await render.execute("test", { path: source, sheet: "Sheet1", range: "A1:B2" }, undefined, undefined, { cwd });
  assert.equal(rendered.content[1].type, "image");
  assert.equal(rendered.content[1].mimeType, "image/png");
  assert.match(rendered.content[1].data, /^[A-Za-z0-9+/]+={0,2}$/);
  const renderedPng = Buffer.from(rendered.content[1].data, "base64");
  assert.equal(rendered.content[1].data, renderedPng.toString("base64"), "rendered image data should be canonical base64");
  assert.deepEqual([...renderedPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(rendered.details.outputPath.endsWith(".png"));

  const cachedRender = await render.execute("test", { path: source, sheet: "Sheet1", range: "A1:B2" }, undefined, undefined, { cwd });
  assert.equal(cachedRender.details.cacheHit, true);
  assert.equal(cachedRender.content[1].data, rendered.content[1].data, "cached previews should serialize to the same base64 PNG");
});

test("VBA schemas exclude authorization parameters and unsupported component operations", () => {
  const edit = { path: "source.xlsm", operations: [{ type: "addModule", name: "Example", kind: "standard", code: "Sub Example()\nEnd Sub" }] };
  assert.equal(Value.Check(VbaEditSchema, edit), true);
  for (const extra of [{ approved: true }, { approvedBy: "user-dialog" }, { overwrite: true }, { enabled: true }]) assert.equal(Value.Check(VbaEditSchema, { ...edit, ...extra }), false);
  assert.equal(Value.Check(VbaEditSchema, { ...edit, operations: [{ ...edit.operations[0], kind: "form" }] }), false);
  assert.equal(Value.Check(VbaEditSchema, { ...edit, operations: [{ ...edit.operations[0], code: "é" }] }), false);
  assert.equal(Value.Check(VbaReadSchema, { path: "source.xlsm" }), true);
  assert.equal(Value.Check(VbaReadSchema, { path: "source.xlsm", modules: [] }), false);
  assert.equal(Value.Check(VbaReadSchema, { path: "source.xlsm", modules: ["ThisWorkbook"] }), true);
  assert.equal(Value.Check(VbaReadSchema, { path: "source.xlsm", maxCodeChars: 200001 }), false);
});

test("registered VBA edit tool refuses no-UI commits without confirmation or backend mutation", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-vba-wiring-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const source = await writeWorkbookFixture(path.join(cwd, "source.xlsm"), { macro: true });
  const hash = await sha256File(source);
  const outputPath = path.join(cwd, "out.xlsm");
  const tools = new Map(); let lists = 0; let confirmations = 0; let edits = 0;
  const backend = {
    async probe() { assert.fail("tool should not probe"); },
    async list() { lists++; return { excelVersion: "fake", excelBuild: "fake", automationSecurity: "ForceDisable", sentinelExecuted: false, sourceSha256: hash, project: { protected: false, modules: [] } }; },
    async edit() { edits++; assert.fail("no-UI commit must never mutate"); },
  };
  workbookExtension({ on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} }, () => backend);
  const ctx = { cwd, hasUI: false, ui: { async confirm() { confirmations++; return true; } } };
  await assert.rejects(tools.get("workbook_vba_edit").execute("no-ui", { path: source, expectedSha256: hash, outputPath, dryRun: false, operations: [{ type: "addModule", name: "Example", kind: "standard", code: "Sub Example()\nEnd Sub" }] }, undefined, undefined, ctx), (error) => error.code === "AUTHORIZATION_REQUIRED");
  assert.equal(lists, 1); assert.equal(confirmations, 0); assert.equal(edits, 0);
  assert.equal(await sha256File(source), hash);
  assert.equal(await fs.stat(outputPath).then(() => true, () => false), false);
});

test("VBA setup command requires UI confirmation before persistent changes", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-vba-command-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSetting = process.env.PI_WORKBOOK_VBA_EDITING;
  process.env.PI_CODING_AGENT_DIR = cwd; delete process.env.PI_WORKBOOK_VBA_EDITING;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousSetting === undefined) delete process.env.PI_WORKBOOK_VBA_EDITING; else process.env.PI_WORKBOOK_VBA_EDITING = previousSetting;
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const commands = new Map(); const events = new Map();
  workbookExtension({ on(name, handler) { events.set(name, handler); }, registerTool() {}, registerCommand(name, command) { commands.set(name, command); } });
  assert.equal(typeof events.get("session_start"), "function");
  const command = commands.get("workbook-vba");
  const dialogs = []; const notifications = [];
  let confirmed = false;
  const ctx = { cwd, hasUI: true, ui: { confirm: async (title, message) => { dialogs.push({ title, message }); return confirmed; }, notify: (message, level) => { notifications.push(message); ctx.lastNotifyLevel = level; } } };
  const envPath = path.join(cwd, ".env");
  await command.handler("", ctx);
  assert.equal(dialogs.length, 0); assert.match(notifications.at(-1), /disabled/);
  await command.handler("enable", ctx);
  assert.equal(await fs.stat(envPath).then(() => true, () => false), false);
  confirmed = true;
  await command.handler("enable", ctx);
  assert.match(await fs.readFile(envPath, "utf8"), /PI_WORKBOOK_VBA_EDITING="1"/);
  assert.match(dialogs.at(-1).message, /Every VBA edit still requires/);
  await command.handler("disable", ctx);
  assert.match(await fs.readFile(envPath, "utf8"), /PI_WORKBOOK_VBA_EDITING="0"/);
  const count = dialogs.length;
  await assert.rejects(command.handler("enable", { ...ctx, hasUI: false }), (error) => error.code === "AUTHORIZATION_REQUIRED");
  assert.equal(dialogs.length, count);
  assert.match(await fs.readFile(envPath, "utf8"), /PI_WORKBOOK_VBA_EDITING="0"/);
  await command.handler("unexpected", ctx);
  assert.match(notifications.at(-1), /Usage: \/workbook-vba/);
  assert.equal(ctx.lastNotifyLevel, "warning");
  assert.equal(dialogs.length, count);
});
