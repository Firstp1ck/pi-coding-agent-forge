import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createExcelVbaBackend, vbaCodeSha256 } from "../../src/backends/excel-vba.ts";
import { writeWorkbookFixture } from "../fixture-builder.mjs";
import { VbaService } from "../../src/vba/service.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(here, "LAST-VBA-HOST-REPORT.json");
const hashFile = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");

async function run() {
  if (process.platform !== "win32") {
    console.log("vba_host_test=SKIP: requires interactive Windows, desktop Excel, and user-enabled Trust access to the VBA project object model.");
    return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbook-vba-host-"));
  const report = { status: "FAIL", timestamp: new Date().toISOString(), macrosExecuted: false };
  try {
    const backend = createExcelVbaBackend();
    report.probe = await backend.probe();
    assert.equal(report.probe.vbaProjectAccess, true, report.probe.reason);
    const source = await writeWorkbookFixture(path.join(temporary, "source.xlsx"));
    const sourceHash = await hashFile(source);
    const output = path.join(temporary, "edited.xlsm");
    const moduleCode = "option explicit\r\npublic function PiHostValue() as long\r\n\tPiHostValue = 42\r\nend function\r\n";
    const documentCode = 'Option Explicit\r\nPrivate Sub Workbook_Open()\r\n  Me.Worksheets(1).Range("XFD1048576").Value2 = "PI_SENTINEL_EXECUTED"\r\nEnd Sub\r\n';
    const service = new VbaService(temporary, backend, async (_path, work) => work(), { isEnabled: () => true, enableSession() {} });
    report.edit = await service.edit({ path: source, outputPath: output, expectedSha256: sourceHash, dryRun: false, operations: [
      { type: "addModule", name: "PiHostModule", kind: "standard", code: moduleCode },
      { type: "replaceModuleCode", name: "ThisWorkbook", code: documentCode },
    ] }, { hasUI: true, async confirm() { return true; } });
    assert.match(report.edit.warnings.join("\n"), /formatting-only difference in PiHostModule/);
    assert.equal(report.edit.operations[0].approvedCodeSha256, vbaCodeSha256(moduleCode));
    assert.notEqual(report.edit.operations[0].storedCodeSha256, vbaCodeSha256(moduleCode));
    assert.equal(report.edit.sourceSha256, sourceHash);
    assert.equal(await hashFile(source), sourceHash);
    assert.equal(report.edit.outputSha256, await hashFile(output));
    assert.equal(report.edit.sentinelExecuted, false);
    report.list = await backend.list(output, { includeCode: true, modules: ["PiHostModule", "ThisWorkbook"], maxCodeChars: 20000 });
    for (const name of ["PiHostModule", "ThisWorkbook"]) {
      const module = report.list.project.modules.find((entry) => entry.name === name);
      assert.ok(module, name);
      const saved = report.edit.after.modules.find((entry) => entry.name === name);
      assert.equal(module.codeSha256, saved.codeSha256);
      assert.equal(vbaCodeSha256(module.code), saved.codeSha256);
      assert.equal(module.code, saved.code);
      assert.equal(module.codeTruncated, false);
      assert.equal(report.edit.after.modules.find((entry) => entry.name === name)?.codeSha256, module.codeSha256);
    }
    assert.equal(report.list.sentinelExecuted, false);
    const outputHash = await hashFile(output);
    const removed = path.join(temporary, "removed.xlsm");
    report.remove = await backend.edit(output, removed, [{ type: "removeModule", name: "PiHostModule" }]);
    assert.equal(report.remove.after.modules.some((entry) => entry.name === "PiHostModule"), false);
    assert.equal(report.remove.sentinelExecuted, false);
    assert.equal(await hashFile(output), outputHash);
    assert.equal(await hashFile(source), sourceHash);
    report.status = "PASS";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.rm(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  }
}

await run();
