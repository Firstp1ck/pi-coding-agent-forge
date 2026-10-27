import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { VbaService } from "../src/vba/service.ts";
import { createVbaSettings, isVbaEditingEnabled, setPersistentVbaEditing, VBA_EDITING_SETTING } from "../src/vba/settings.ts";
import { formatVbaApprovalMessage } from "../src/vba/approval.ts";
import { vbaCodeSha256, VBA_LIMITS } from "../src/backends/excel-vba.ts";
import { sha256File } from "../src/core/hash.ts";
import { writeWorkbookFixture, workbookFixtureBytes } from "./fixture-builder.mjs";

const meta = { excelVersion: "fake", excelBuild: "fake", automationSecurity: "ForceDisable", sentinelExecuted: false };
const add = { type: "addModule", name: "NewModule", kind: "standard", code: "Sub Example()\nEnd Sub" };
const moduleInfo = (name, kind = "standard", code = "") => ({ name, kind, code, lineCount: code ? code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").length : 0, codeSha256: vbaCodeSha256(code) });
const project = () => ({ protected: false, modules: [moduleInfo("ThisWorkbook", "document"), moduleInfo("Existing", "class", "' existing")] });
const errorCode = (code) => (error) => { assert.equal(error.code, code, error.stack); return true; };

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vba-auth-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = await writeWorkbookFixture(path.join(dir, options.xlsx ? "source.xlsx" : "source.xlsm"), { macro: !options.xlsx });
  const output = path.join(dir, "result.xlsm");
  const hash = await sha256File(source);
  const state = { lists: 0, edits: 0, dialogs: [], enabled: options.enabled ?? false, before: project(), after: undefined, onList: undefined, onEdit: undefined, outputBytes: undefined, listOptions: undefined };
  const backend = {
    async probe() { return { ...meta, vbaProjectAccess: true }; },
    async list(input, listOptions) {
      state.lists++;
      state.listOptions = listOptions;
      await state.onList?.(input);
      return { ...meta, sourceSha256: await sha256File(input), project: structuredClone(state.before) };
    },
    async edit(input, staged, operations) {
      state.edits++;
      const sourceSha256Before = await sha256File(input);
      state.staged = staged;
      await state.onEdit?.(input, staged, operations);
      if (state.outputBytes) await fs.writeFile(staged, state.outputBytes, { flag: "wx" });
      else await fs.copyFile(input, staged, fs.constants.COPYFILE_EXCL);
      const after = structuredClone(state.before);
      for (const op of operations) {
        const index = after.modules.findIndex((module) => module.name.toLowerCase() === op.name.toLowerCase());
        if (op.type === "removeModule") after.modules.splice(index, 1);
        else if (op.type === "addModule") after.modules.push(moduleInfo(op.name, op.kind, op.code));
        else after.modules[index] = moduleInfo(after.modules[index].name, after.modules[index].kind, op.code);
      }
      return { ...meta, sourceSha256Before, sourceSha256After: await sha256File(input), outputPath: staged, outputSha256: await sha256File(staged), before: structuredClone(state.before), after: state.after ?? after, operations: [] };
    },
  };
  const settings = { isEnabled: () => state.enabled, enableSession: () => { state.enabled = true; } };
  const service = new VbaService(dir, backend, options.queue ?? (async (_key, work) => work()), settings);
  const approve = (answers = [true, true], hook) => ({ hasUI: true, async confirm(title, message) { state.dialogs.push({ title, message }); await hook?.(state.dialogs.length); return answers.shift() ?? true; } });
  const request = (changes = {}) => ({ path: source, outputPath: output, expectedSha256: hash, dryRun: false, operations: [{ ...add }], ...changes });
  const absent = async () => assert.equal(await fs.lstat(output).then(() => false, () => true), true);
  const unchanged = async () => assert.equal(await sha256File(source), hash);
  return { dir, source, output, hash, state, backend, service, approve, request, absent, unchanged };
}

test("VBA dry run defaults to no dialogs, no enablement, and no output", async (t) => {
  const f = await fixture(t);
  const result = await f.service.edit(f.request({ dryRun: undefined, expectedSha256: undefined }), f.approve());
  assert.equal(result.dryRun, true);
  assert.equal(result.macrosExecuted, false);
  assert.equal(result.operations[0].codeSha256, vbaCodeSha256(add.code));
  assert.equal(result.operations[0].code, add.code);
  assert.match(result.approvalPreview, /NewModule/);
  assert.equal(f.state.dialogs.length, 0);
  assert.equal(f.state.edits, 0);
  assert.equal(f.state.enabled, false);
  await f.absent(); await f.unchanged();
});

for (const enabled of [false, true]) test(`VBA commit without UI fails even when enabled=${enabled}`, async (t) => {
  const f = await fixture(t, { enabled });
  await assert.rejects(f.service.edit(f.request(), { hasUI: false, confirm() { assert.fail("no dialog allowed"); } }), errorCode("AUTHORIZATION_REQUIRED"));
  assert.equal(f.state.edits, 0); await f.absent(); await f.unchanged();
});

test("declined session enablement cannot edit or persist permission", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.edit(f.request(), f.approve([false])), errorCode("AUTHORIZATION_REQUIRED"));
  assert.equal(f.state.dialogs.length, 1); assert.equal(f.state.enabled, false); assert.equal(f.state.edits, 0);
  await f.absent(); await f.unchanged();
});

test("session enablement never substitutes for per-edit approval", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.edit(f.request(), f.approve([true, false])), errorCode("AUTHORIZATION_REQUIRED"));
  assert.equal(f.state.dialogs.length, 2); assert.equal(f.state.enabled, true); assert.equal(f.state.edits, 0);
  await f.absent(); await f.unchanged();
});

test("approved edit creates a distinct output, preserves source, and attests dialog approval", async (t) => {
  const f = await fixture(t);
  const result = await f.service.edit(f.request(), f.approve());
  assert.equal(f.state.dialogs.length, 2);
  const dialog = f.state.dialogs[1].message;
  for (const text of [f.source, f.output, f.hash, add.name, "standard", "0 → 2", vbaCodeSha256(add.code), "Macros will not be run."]) assert.ok(dialog.includes(text), text);
  assert.equal(result.approvedBy, "user-dialog"); assert.equal(result.macrosExecuted, false);
  assert.equal(result.outputSha256, await sha256File(f.output));
  assert.equal(result.operations[0].readBackCodeSha256, vbaCodeSha256(add.code));
  assert.equal(result.operations[0].approvedCodeSha256, vbaCodeSha256(add.code));
  assert.equal(result.operations[0].storedCodeSha256, vbaCodeSha256(add.code));
  assert.doesNotMatch(result.warnings.join("\n"), /formatting-only/);
  assert.equal(result.operations[0].code, undefined);
  assert.deepEqual(result.unrelatedChangedParts, []);
  assert.equal(result.signature.state, "absent");
  assert.equal(await fs.stat(path.dirname(f.state.staged)).then(() => true, () => false), false);
  await f.unchanged();
  await fs.rm(f.output);
  f.state.dialogs.length = 0;
  await f.service.edit(f.request(), f.approve());
  assert.equal(f.state.dialogs.length, 1, "session permission still requires one edit dialog for every commit");
});

for (const expectedSha256 of [undefined, "0".repeat(64)]) test(`commit rejects ${expectedSha256 ? "stale" : "missing"} source hash before backend calls`, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.edit(f.request({ expectedSha256 }), f.approve()), errorCode("CONFLICT"));
  assert.equal(f.state.lists, 0); assert.equal(f.state.edits, 0); await f.absent(); await f.unchanged();
});

test("existing output is never overwritten", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.output, "keep me");
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("OUTPUT_EXISTS"));
  assert.equal(await fs.readFile(f.output, "utf8"), "keep me"); assert.equal(f.state.edits, 0); await f.unchanged();
});

test("output cannot be the source, a source symlink, or an XLSX path", async (t) => {
  const f = await fixture(t);
  for (const outputPath of [f.source, path.join(f.dir, "bad.xlsx")]) await assert.rejects(f.service.edit(f.request({ outputPath }), f.approve()), errorCode("INVALID_ARGUMENT"));
  if (process.platform !== "win32") {
    const link = path.join(f.dir, "alias.xlsm");
    await fs.symlink(f.source, link);
    await assert.rejects(f.service.edit(f.request({ outputPath: link }), f.approve()), errorCode("INVALID_ARGUMENT"));
  }
  await f.unchanged();
});

test("signed project is rejected without flag before any backend call", async (t) => {
  const f = await fixture(t);
  const signed = fileURLToPath(new URL("./corpus/fixtures/signed-vba/xlsxwriter-macro04.xlsm", import.meta.url));
  await fs.copyFile(signed, f.source);
  await assert.rejects(f.service.edit(f.request({ expectedSha256: await sha256File(f.source) }), f.approve()), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 0); assert.equal(f.state.dialogs.length, 0); await f.absent();
});

test("signed project with flag still needs a signature-loss approval dialog", async (t) => {
  const f = await fixture(t, { enabled: true });
  await fs.copyFile(fileURLToPath(new URL("./corpus/fixtures/signed-vba/xlsxwriter-macro04.xlsm", import.meta.url)), f.source);
  await assert.rejects(f.service.edit(f.request({ expectedSha256: await sha256File(f.source), allowSignatureRemoval: true }), f.approve([false])), errorCode("AUTHORIZATION_REQUIRED"));
  assert.equal(f.state.dialogs.length, 1);
  assert.match(f.state.dialogs[0].message, /signature will be lost/);
  assert.equal(f.state.edits, 0); await f.absent();
});

test("locked VBA projects are refused without dialogs or mutation", async (t) => {
  const f = await fixture(t);
  f.state.before = { protected: true, modules: [] };
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.dialogs.length, 0); assert.equal(f.state.edits, 0); await f.absent();
});

for (const [type, name, expected] of [["removeModule", "ThisWorkbook", "UNSUPPORTED_FEATURE"], ["removeModule", "Form1", "UNSUPPORTED_FEATURE"], ["replaceModuleCode", "Form1", "UNSUPPORTED_FEATURE"], ["removeModule", "Missing", "INVALID_ARGUMENT"], ["addModule", "Existing", "INVALID_ARGUMENT"]]) test(`${type} ${name} fails closed`, async (t) => {
  const f = await fixture(t);
  f.state.before.modules.push(moduleInfo("Form1", "form"));
  const operation = type === "removeModule" ? { type, name } : type === "addModule" ? { ...add, name } : { type, name, code: "' changed" };
  await assert.rejects(f.service.edit(f.request({ operations: [operation] }), f.approve()), errorCode(expected));
  assert.equal(f.state.dialogs.length, 0); assert.equal(f.state.edits, 0); await f.absent();
});

test("replacement of document code and removal of class module are verified", async (t) => {
  const f = await fixture(t, { enabled: true });
  const operations = [{ type: "replaceModuleCode", name: "thisworkbook", code: "' approved" }, { type: "removeModule", name: "Existing" }];
  const result = await f.service.edit(f.request({ operations }), f.approve());
  assert.deepEqual(result.after.modules.map((module) => module.name), ["ThisWorkbook"]);
  assert.equal(result.operations[0].readBackCodeSha256, vbaCodeSha256("' approved"));
  assert.equal(result.operations[1].linesAfter, 0); await f.unchanged();
});

for (const mode of ["wrong-edited-hash", "removed-still-present", "untouched-changed", "extra-module", "kind-changed"]) test(`read-back failure (${mode}) never commits`, async (t) => {
  const f = await fixture(t, { enabled: true });
  f.state.after = project();
  let operations = [{ ...add }];
  if (mode === "removed-still-present") operations = [{ type: "removeModule", name: "Existing" }];
  else f.state.after.modules.push(moduleInfo(add.name, mode === "kind-changed" ? "class" : "standard", mode === "wrong-edited-hash" ? "' wrong" : add.code));
  if (mode === "untouched-changed") f.state.after.modules[0] = moduleInfo("ThisWorkbook", "document", "' changed");
  if (mode === "extra-module") f.state.after.modules.push(moduleInfo("Sneaky"));
  await assert.rejects(f.service.edit(f.request({ operations }), f.approve()), errorCode("VALIDATION_FAILED"));
  await f.absent(); await f.unchanged();
  assert.equal(await fs.stat(path.dirname(f.state.staged)).then(() => true, () => false), false);
});

test("read-back accepts one inserted leading Option Explicit as a formatting-only difference", async (t) => {
  const f = await fixture(t, { enabled: true });
  f.state.after = project();
  f.state.after.modules.push(moduleInfo(add.name, "standard", `Option Explicit\r\n${add.code}\r\n`));
  const result = await f.service.edit(f.request(), f.approve());
  assert.match(result.warnings.join("\n"), /formatting-only/);
  assert.equal(result.operations[0].readBackCodeSha256, vbaCodeSha256(`Option Explicit\n${add.code}`));
  await f.unchanged();
});

test("changed unrelated OOXML parts are reported rather than prohibited", async (t) => {
  const f = await fixture(t, { enabled: true });
  const entries = unzipSync(await fs.readFile(f.source));
  entries["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(new TextDecoder().decode(entries["xl/worksheets/sheet1.xml"]).replace("Hello", "Changed"));
  f.state.outputBytes = zipSync(entries);
  const result = await f.service.edit(f.request(), f.approve());
  assert.deepEqual(result.unrelatedChangedParts, ["xl/worksheets/sheet1.xml"]);
  assert.match(result.warnings.join("\n"), /Excel full save changed unrelated part/); await f.unchanged();
});

test("XLSX source converts only the new output and validates XLSM structure", async (t) => {
  const f = await fixture(t, { enabled: true, xlsx: true });
  f.state.outputBytes = workbookFixtureBytes({ macro: true });
  const result = await f.service.edit(f.request({ outputPath: undefined }), f.approve());
  assert.equal(result.outputPath, path.join(f.dir, "source.vba-edited.xlsm"));
  assert.equal(result.validation.ok, true); await f.unchanged();
});

test("invalid saved package fails validation before output creation", async (t) => {
  const f = await fixture(t, { enabled: true });
  f.state.outputBytes = workbookFixtureBytes();
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("VALIDATION_FAILED"));
  await f.absent(); await f.unchanged();
});

test("abort before planning and while confirming cannot commit", async (t) => {
  const f = await fixture(t, { enabled: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.edit(f.request(), f.approve(), controller.signal), errorCode("ABORTED"));
  assert.equal(f.state.lists, 0);
  const during = new AbortController();
  await assert.rejects(f.service.edit(f.request(), f.approve([true], () => during.abort()), during.signal), errorCode("ABORTED"));
  assert.equal(f.state.edits, 0); await f.absent(); await f.unchanged();
});

test("abort during backend edit removes staged work and commits nothing", async (t) => {
  const f = await fixture(t, { enabled: true });
  const controller = new AbortController();
  f.state.onEdit = () => controller.abort();
  await assert.rejects(f.service.edit(f.request(), f.approve(), controller.signal), errorCode("ABORTED"));
  await f.absent(); await f.unchanged();
  assert.equal(await fs.stat(path.dirname(f.state.staged)).then(() => true, () => false), false);
});

test("source is rehashed immediately after approval", async (t) => {
  const f = await fixture(t, { enabled: true });
  await assert.rejects(f.service.edit(f.request(), f.approve([true], () => fs.appendFile(f.source, "changed"))), errorCode("CONFLICT"));
  assert.equal(f.state.edits, 0); await f.absent();
});

test("source is rehashed inside the output mutation queue", async (t) => {
  let source;
  const f = await fixture(t, { enabled: true, queue: async (_key, work) => { await fs.appendFile(source, "changed"); return work(); } });
  source = f.source;
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("CONFLICT"));
  assert.equal(f.state.edits, 0); await f.absent();
});

test("destination created during backend work is preserved and never overwritten", async (t) => {
  const f = await fixture(t, { enabled: true });
  f.state.onEdit = () => fs.writeFile(f.output, "other writer", { flag: "wx" });
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("OUTPUT_EXISTS"));
  assert.equal(await fs.readFile(f.output, "utf8"), "other writer"); await f.unchanged();
});

test("VBA read is bounded, no approval needed, source is marked untrusted", async (t) => {
  const f = await fixture(t);
  const result = await f.service.read({ path: f.source });
  assert.deepEqual(f.state.listOptions, { includeCode: false, maxCodeChars: 20000, modules: undefined });
  assert.equal(result.sourceIsUntrustedData, true); assert.equal(result.macrosExecuted, false);
  await f.service.read({ path: f.source, includeCode: true, modules: ["Existing"], maxCodeChars: 20 });
  assert.deepEqual(f.state.listOptions, { includeCode: true, maxCodeChars: 20, modules: ["Existing"] });
  await assert.rejects(f.service.read({ path: f.source, modules: [] }), errorCode("INVALID_ARGUMENT"));
  for (const maxCodeChars of [0, -1, 1.5, VBA_LIMITS.maxReadCodeChars + 1]) await assert.rejects(f.service.read({ path: f.source, maxCodeChars }), errorCode("INVALID_ARGUMENT"));
  assert.equal(f.state.dialogs.length, 0); await f.unchanged();
});

test("approval preview bounds code to 20 lines, all metadata, and 6000 characters", () => {
  const op = { type: "addModule", name: "Large", kind: "standard", linesBefore: 0, linesAfter: 30, code: Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n"), codeSha256: "a".repeat(64) };
  const plan = { sourcePath: "/source.xlsm", sourceSha256: "b".repeat(64), outputPath: "/out.xlsm", signed: false, operations: [op] };
  const text = formatVbaApprovalMessage(plan);
  assert.ok(text.length <= 6000); assert.match(text, /line19/); assert.doesNotMatch(text, /line20/); assert.match(text, /Showing 20 of 30 lines; run the dry run to see the full code\./);
  const many = formatVbaApprovalMessage({ ...plan, operations: Array.from({ length: 20 }, (_, index) => ({ ...op, name: `Module${index}`, code: "a".repeat(10000) })) });
  assert.ok(many.length <= 6000); assert.match(many, /Module19/);
  assert.throws(() => formatVbaApprovalMessage({ ...plan, sourcePath: "a".repeat(6000) }), errorCode("LIMIT_EXCEEDED"));
});

test("read-back accepts case/space/tab-only changes with both approved and stored hashes", async (t) => {
  const f = await fixture(t, { enabled: true });
  const approved = "\nsub   Example()\n\tend sub\n";
  const stored = "Sub Example()\r\nEnd Sub\r\n";
  f.state.after = project(); f.state.after.modules.push(moduleInfo(add.name, "standard", stored));
  const result = await f.service.edit(f.request({ operations: [{ ...add, code: approved }] }), f.approve());
  assert.match(result.warnings.join("\n"), /formatting-only/);
  assert.equal(result.operations[0].approvedCodeSha256, vbaCodeSha256(approved));
  assert.equal(result.operations[0].storedCodeSha256, vbaCodeSha256(stored));
  assert.match(result.warnings.join("\n"), new RegExp(vbaCodeSha256(approved)));
  assert.match(result.warnings.join("\n"), new RegExp(vbaCodeSha256(stored)));
});

for (const mode of ["semantic-change", "missing-code", "truncated-code", "inconsistent-hash", "second-option-explicit"]) test(`edited module ${mode} fails read-back`, async (t) => {
  const f = await fixture(t, { enabled: true });
  const module = moduleInfo(add.name, "standard", mode === "semantic-change" ? "Sub Other()\nEnd Sub" : mode === "second-option-explicit" ? `Option Explicit\nOption Explicit\n${add.code}` : add.code);
  if (mode === "missing-code") delete module.code;
  if (mode === "truncated-code") module.codeTruncated = true;
  if (mode === "inconsistent-hash") module.codeSha256 = vbaCodeSha256("' different");
  f.state.after = project(); f.state.after.modules.push(module);
  await assert.rejects(f.service.edit(f.request(), f.approve()), errorCode("VALIDATION_FAILED"));
  await f.absent(); await f.unchanged();
});

for (const signatureType of ["vbaProjectSignature", "vbaProjectSignatureAgile", "vbaProjectSignatureV3", "content-type-only"]) test(`relocated signature (${signatureType}) cannot bypass refusal or reporting`, async (t) => {
  const f = await fixture(t, { enabled: true });
  const entries = unzipSync(await fs.readFile(fileURLToPath(new URL("./corpus/fixtures/signed-vba/xlsxwriter-macro04.xlsm", import.meta.url))));
  const moved = "xl/hidden/seal.dat";
  const encode = (text) => new TextEncoder().encode(text);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  entries[moved] = entries["xl/vbaProjectSignature.bin"]; delete entries["xl/vbaProjectSignature.bin"];
  entries["xl/_rels/vbaProject.bin.rels"] = encode(decode(entries["xl/_rels/vbaProject.bin.rels"]).replace('Target="vbaProjectSignature.bin"', 'Target="hidden/seal.dat"').replace("relationships/vbaProjectSignature", `relationships/${signatureType === "content-type-only" ? "opaqueSeal" : signatureType.toUpperCase()}`));
  entries["[Content_Types].xml"] = encode(decode(entries["[Content_Types].xml"]).replace("/xl/vbaProjectSignature.bin", `/${moved}`).replace("application/vnd.ms-office.vbaProjectSignature", signatureType === "content-type-only" ? "application/vnd.ms-office.vbaProjectSignatureV3" : "application/octet-stream"));
  await fs.writeFile(f.source, zipSync(entries));
  const expectedSha256 = await sha256File(f.source);
  await assert.rejects(f.service.edit(f.request({ expectedSha256 }), f.approve()), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 0);
  // A changed relocated signature must be related, even though its path has no VBA hint.
  entries[moved] = new Uint8Array([...entries[moved], 0]); f.state.outputBytes = zipSync(entries);
  const result = await f.service.edit(f.request({ expectedSha256, allowSignatureRemoval: true }), f.approve());
  assert.match(f.state.dialogs[0].message, /signature will be lost/);
  assert.deepEqual(result.signature.before, [moved]); assert.deepEqual(result.signature.after, [moved]);
  assert.equal(result.signature.state, "present-unverified");
  assert.ok(result.changedParts.includes(moved)); assert.ok(!result.unrelatedChangedParts.includes(moved));
});

for (const kind of ["connections", "pivotCacheDefinition", "queryTable"]) for (const refresh of ["1", "true"]) test(`${kind} refreshOnLoad=${refresh} fails before backend access`, async (t) => {
  const f = await fixture(t);
  const entries = unzipSync(await fs.readFile(f.source));
  const part = kind === "connections" ? "xl/connections.xml" : kind === "pivotCacheDefinition" ? "xl/pivotCache/pivotCacheDefinition1.xml" : "xl/queryTables/queryTable1.xml";
  entries[part] = new TextEncoder().encode(`<${kind} xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><item refreshOnLoad="${refresh}"/></${kind}>`);
  await fs.writeFile(f.source, zipSync(entries));
  await assert.rejects(f.service.read({ path: f.source }), errorCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(f.service.edit(f.request({ expectedSha256: await sha256File(f.source) }), f.approve()), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 0); assert.equal(f.state.edits, 0); assert.equal(f.state.dialogs.length, 0); await f.absent();
});

test("refresh preflight follows content types for relocated XML and accepts refresh disabled", async (t) => {
  const f = await fixture(t);
  const entries = unzipSync(await fs.readFile(f.source));
  entries["xl/opaque.dat"] = new TextEncoder().encode('<connections refreshOnLoad="false"/>');
  entries["[Content_Types].xml"] = new TextEncoder().encode(new TextDecoder().decode(entries["[Content_Types].xml"]).replace("</Types>", '<Override PartName="/xl/opaque.dat" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"/></Types>'));
  await fs.writeFile(f.source, zipSync(entries));
  await f.service.read({ path: f.source });
  entries["xl/opaque.dat"] = new TextEncoder().encode('<connections refreshOnLoad="&#116;rue"/>');
  await fs.writeFile(f.source, zipSync(entries));
  await assert.rejects(f.service.read({ path: f.source }), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 1);
});

test("refresh preflight matches a namespace-prefixed refreshOnLoad attribute", async (t) => {
  const f = await fixture(t);
  const entries = unzipSync(await fs.readFile(f.source));
  entries["xl/connections.xml"] = new TextEncoder().encode('<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection x:refreshOnLoad="1"/></connections>');
  await fs.writeFile(f.source, zipSync(entries));
  await assert.rejects(f.service.read({ path: f.source }), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 0);
});

for (const kind of ["xlMacrosheet", "xlIntlMacrosheet", "content-type"]) test(`XLM preflight rejects ${kind} before backend access`, async (t) => {
  const f = await fixture(t);
  const entries = unzipSync(await fs.readFile(f.source));
  const encode = (text) => new TextEncoder().encode(text);
  entries["xl/macro.xml"] = encode('<macrosheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  if (kind === "content-type") entries["[Content_Types].xml"] = encode(new TextDecoder().decode(entries["[Content_Types].xml"]).replace("</Types>", '<Override PartName="/xl/macro.xml" ContentType="application/vnd.ms-excel.MACROSHEET+xml"/></Types>'));
  else entries["xl/_rels/workbook.xml.rels"] = encode(new TextDecoder().decode(entries["xl/_rels/workbook.xml.rels"]).replace("</Relationships>", `<Relationship Id="rIdMacro" Type="http://schemas.microsoft.com/office/2006/relationships/${kind}" Target="macro.xml"/></Relationships>`));
  await fs.writeFile(f.source, zipSync(entries));
  await assert.rejects(f.service.read({ path: f.source }), errorCode("UNSUPPORTED_FEATURE"));
  await assert.rejects(f.service.edit(f.request({ expectedSha256: await sha256File(f.source) }), f.approve()), errorCode("UNSUPPORTED_FEATURE"));
  assert.equal(f.state.lists, 0); assert.equal(f.state.edits, 0); await f.absent();
});

test("dry-run contains the complete submitted code beyond the dialog preview", async (t) => {
  const f = await fixture(t);
  const code = "'".repeat(VBA_LIMITS.maxModuleCodeBytes);
  const result = await f.service.edit(f.request({ dryRun: true, operations: [{ ...add, code }] }), f.approve());
  assert.equal(result.operations[0].code, code);
  assert.match(result.approvalPreview, /Showing 0 of 1 lines; run the dry run to see the full code\./);
  assert.ok(result.approvalPreview.length <= 6000);
});

test("persistent setting writes only redirected Pi global env; session state is isolated and resettable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vba-settings-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSetting = process.env[VBA_EDITING_SETTING];
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousSetting === undefined) delete process.env[VBA_EDITING_SETTING]; else process.env[VBA_EDITING_SETTING] = previousSetting;
    await fs.rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir; delete process.env[VBA_EDITING_SETTING];
  assert.equal(isVbaEditingEnabled(), false);
  setPersistentVbaEditing(true);
  assert.match(await fs.readFile(path.join(dir, ".env"), "utf8"), /PI_WORKBOOK_VBA_EDITING="1"/);
  assert.equal(isVbaEditingEnabled(), true);
  setPersistentVbaEditing(false); assert.equal(isVbaEditingEnabled(), false);
  const one = createVbaSettings(); const two = createVbaSettings();
  one.enableSession(); assert.equal(one.isEnabled(), true); assert.equal(two.isEnabled(), false);
  one.resetSession(); assert.equal(one.isEnabled(), false);
  process.env[VBA_EDITING_SETTING] = "yes"; assert.equal(isVbaEditingEnabled(), true);
  process.env[VBA_EDITING_SETTING] = "0"; setPersistentVbaEditing(true); assert.equal(isVbaEditingEnabled(), false);
});
