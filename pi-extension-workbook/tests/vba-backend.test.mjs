import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { VBA_LIMITS, createExcelVbaBackend, validateVbaOperations, vbaCodeSha256 } from "../src/backends/excel-vba.ts";

const add = (overrides = {}) => ({ type: "addModule", name: "Module1", kind: "standard", code: "Option Explicit\nPublic Sub Hello()\nEnd Sub\n", ...overrides });
const rejectsCode = (operations, code) => assert.throws(() => validateVbaOperations(operations), (error) => error?.code === code);

test("VBA code hashes normalize newline encoding and trailing newlines only", () => {
  const code = "Option Explicit\nPublic Sub Test()\nEnd Sub";
  assert.equal(vbaCodeSha256(code), createHash("sha256").update(code, "utf8").digest("hex"));
  for (const newline of ["\n", "\r\n", "\r"]) {
    assert.equal(vbaCodeSha256(code.replace(/\n/g, newline) + newline.repeat(3)), vbaCodeSha256(code));
  }
  assert.equal(vbaCodeSha256("\r\n\r\n"), vbaCodeSha256(""));
  assert.notEqual(vbaCodeSha256(" x"), vbaCodeSha256("x"));
  assert.notEqual(vbaCodeSha256("x "), vbaCodeSha256("x"));
  assert.notEqual(vbaCodeSha256("\nx"), vbaCodeSha256("x"));
  assert.equal(vbaCodeSha256("' caf\u00e9"), createHash("sha256").update("' caf\u00e9", "utf8").digest("hex"));
});

test("VBA operations accept all supported shapes, empty code, and exact bounds", () => {
  assert.deepEqual(VBA_LIMITS, { maxOperations: 50, maxModuleCodeBytes: 262144, maxReadCodeChars: 200000 });
  const operations = [add(), add({ name: "C_1", kind: "class", code: "" }), { type: "replaceModuleCode", name: "ThisWorkbook", code: "\t' comment\r\n" }, { type: "removeModule", name: "OldModule" }];
  const validated = validateVbaOperations(operations);
  assert.deepEqual(validated, operations);
  assert.notEqual(validated[0], operations[0]);
  assert.equal(validateVbaOperations([add({ name: "A".repeat(31), code: "x".repeat(262144) })])[0].code.length, 262144);
  assert.equal(validateVbaOperations(Array.from({ length: 50 }, (_, index) => add({ name: `Module${index}` }))).length, 50);
  assert.deepEqual(validateVbaOperations([{ type: "removeModule", name: "ThisWorkbook" }]), [{ type: "removeModule", name: "ThisWorkbook" }]);
});

test("VBA operation validation rejects malformed names, shapes, and duplicates", () => {
  for (const name of ["", "1Module", "_Module", "M-1", "M.1", "M 1", "M\u00e9", "M\n", "M\r\n", "M\u2028", "A".repeat(32), null, 1]) rejectsCode([add({ name })], "INVALID_ARGUMENT");
  for (const operations of [[], null, {}, [null], [1], [[]], Array(1), [{ name: "A", code: "" }], [add({ code: null })], [add({ extra: true })], [{ type: "removeModule", name: "A", code: "" }]]) {
    rejectsCode(operations, operations?.[0]?.name === "A" && operations?.[0]?.type === undefined ? "UNSUPPORTED_FEATURE" : "INVALID_ARGUMENT");
  }
  rejectsCode([add(), { type: "replaceModuleCode", name: "module1", code: "" }], "INVALID_ARGUMENT");
  rejectsCode([add(), add()], "INVALID_ARGUMENT");
  rejectsCode([add({ type: "executeMacro" })], "UNSUPPORTED_FEATURE");
  rejectsCode([add({ type: { toString: () => "addModule" } })], "UNSUPPORTED_FEATURE");
  for (const kind of ["document", "form", "other", undefined]) rejectsCode([add({ kind })], "UNSUPPORTED_FEATURE");
});

test("VBA operation validation refuses non-ASCII/control code and Attribute VB_ lines", () => {
  for (const code of ["' caf\u00e9", "\u0000", "\u000b", "\u001b", "\u007f", "\ud83d\ude00", "\u2028"]) rejectsCode([add({ code })], "INVALID_ARGUMENT");
  for (const code of ['Attribute VB_Name = "Module1"', '  attribute\tvb_name = "Module1"', '\rAttribute VB_PredeclaredId = True', 'x\r\nAttribute VB_Description = "x"']) rejectsCode([add({ code })], "UNSUPPORTED_FEATURE");
  assert.doesNotThrow(() => validateVbaOperations([add({ code: "' Attribute VB_Name is a comment\nDebug.Print \"Attribute VB_Name\"" })]));
  rejectsCode([add({ code: "x".repeat(262145) })], "LIMIT_EXCEEDED");
  rejectsCode(Array.from({ length: 51 }, (_, index) => add({ name: `Module${index}` })), "LIMIT_EXCEEDED");
});

test("non-Windows VBA methods fail unavailable without touching files or invoking a worker", { skip: process.platform === "win32" }, async () => {
  const backend = createExcelVbaBackend({ workerPath: "/not-a-real-worker", timeoutMs: 1 });
  const controller = new AbortController();
  controller.abort();
  for (const operation of [
    () => backend.probe(), () => backend.probe(controller.signal),
    () => backend.list("/missing.xlsx", { includeCode: false, maxCodeChars: 20000 }),
    () => backend.edit("/missing.xlsx", "/missing.xlsm", [add()]),
  ]) await assert.rejects(operation, (error) => error?.code === "BACKEND_UNAVAILABLE");
});

test("VBA pure limits preserve backend exports without importing subprocess machinery", async () => {
  const pure = await import("../src/vba/limits.ts");
  assert.equal(pure.VBA_LIMITS, VBA_LIMITS);
  assert.equal(pure.vbaCodeSha256, vbaCodeSha256);
  assert.equal(pure.validateVbaOperations, validateVbaOperations);
  const source = await fs.readFile(new URL("../src/vba/limits.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process|backends\//);
  const schemas = await fs.readFile(new URL("../src/schemas.ts", import.meta.url), "utf8");
  assert.match(schemas, /from "\.\/vba\/limits\.ts"/);
  assert.doesNotMatch(schemas, /backends\/excel-vba/);
});

test("VBA worker distinguishes operation/save phases and only translates trust failures", async () => {
  const worker = await fs.readFile(new URL("../workers/excel-vba.ps1", import.meta.url), "utf8");
  assert.match(worker, /not trusted\|Programmatic access/);
  assert.match(worker, /HResult\.ToString\('X8'\) -eq '800A03EC'/);
  assert.match(worker, /if \(Test-TrustError \$_\.Exception\) \{ Fail-Vba 'BACKEND_UNAVAILABLE' \$trustReason \}\s+throw/);
  assert.match(worker, /\$script:errorCode = 'INVALID_ARGUMENT'[\s\S]*Apply-Operations \$project \$operations \$storedCodeHashes\)\s+\$script:errorCode = 'VALIDATION_FAILED'/);
  assert.match(worker, /\$StoredCodeHashes\[\$name\] = Get-CodeHash \(Get-ModuleCode \$codeModule\)/);
  assert.match(worker, /\$actual\.codeSha256 -cne \$StoredCodeHashes\[\$operation\.name\]/);
  assert.doesNotMatch(worker.slice(worker.indexOf("function Assert-ReadBack"), worker.indexOf("\ntry {\n  if (-not [Environment]")), /operation\.code|withOption/);
  assert.match(worker, /Read-Project \$project \(\$editedNames\.Count -gt 0\) \$editedNames 16777216/);
});

test("VBA worker retains fail-closed automation guards and read-back verification", async () => {
  const worker = await fs.readFile(new URL("../workers/excel-vba.ps1", import.meta.url), "utf8");
  for (const token of ["[Environment]::UserInteractive", "GetWindowThreadProcessId", "Write-ControlFile $ownedExcelInstance", "$excel.AutomationSecurity = 3", "$excel.EnableEvents = $false", "$excel.AskToUpdateLinks = $false", "$excel.Calculation = -4135", "$excel.CalculateBeforeSave = $false", "Assert-ReadBack $before $after $operations", "$workbook.SaveAs($outputFullPath, 52)", "PI_SENTINEL_EXECUTED", "File > Options > Trust Center > Trust Center Settings > Macro Settings > Trust access to the VBA project object model"]) assert.ok(worker.includes(token), token);
  assert.ok(worker.indexOf("$excel.AutomationSecurity = 3") < worker.indexOf("$excel.Workbooks.Open("));
  assert.match(worker, /Workbooks\.Open\(\$inputFullPath, 0, \$true\)/);
  assert.match(worker, /Workbooks\.Open\(\$outputFullPath, 0, \$true\)/);
  assert.match(worker, /if \(-not \$ownedExcelInstance\) \{ throw/);
  assert.doesNotMatch(worker, /Application\s*\.\s*Run|\.\s*Run\s*\(|RefreshAll|\bCalculate\b|AccessVBOM|VBE\s*\.\s*MainWindow|Certificate|Cert:\\|\b(?:Get|Set|New|Remove|Clear|Copy|Move|Rename)-ItemProperty\b/i);
});
