import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.name, "@firstpick/pi-extension-workbook");
assert.equal(pkg.type, "module");
assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
assert.deepEqual(pkg.pi?.skills, ["./skills"]);
assert.equal(pkg.peerDependencies?.["@earendil-works/pi-ai"], "*");
assert.equal(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
assert.equal(pkg.peerDependencies?.typebox, "*");

const required = [
  "index.ts",
  "README.md",
  "LICENSE",
  "src/contracts.ts",
  "src/schemas.ts",
  "src/backends/ooxml-safe.ts",
  "src/backends/excel-native.ts",
  "src/backends/excel-vba.ts",
  "workers/excel-native.ps1",
  "workers/excel-vba.ps1",
  "src/core/transaction.ts",
  "src/ooxml/package.ts",
  "src/ooxml/edit.ts",
  "skills/workbook-editor/SKILL.md",
  "docs/ADR-0001-primary-backend.md",
];
for (const relative of required) {
  const stat = await fs.stat(path.join(root, relative));
  assert.ok(stat.isFile(), `required file missing: ${relative}`);
}
const skill = await fs.readFile(path.join(root, "skills/workbook-editor/SKILL.md"), "utf8");
assert.match(skill, /^---\nname: workbook-editor\ndescription: .+\n---\n/);
assert.match(skill, /expectedSha256/);
assert.match(skill, /Never execute macros/);
const index = await fs.readFile(path.join(root, "index.ts"), "utf8");
for (const tool of ["workbook_inspect", "workbook_read", "workbook_render", "workbook_edit", "workbook_diff", "workbook_validate", "workbook_vba_read", "workbook_vba_edit"]) assert.match(index, new RegExp(`name: "${tool}"`));
assert.doesNotMatch(index, /child_process|ActiveWorkbook|Workbooks\.Open|AutomationSecurity/);
const nativeWorker = await fs.readFile(path.join(root, "workers/excel-native.ps1"), "utf8");
assert.match(nativeWorker, /\$excel\.AutomationSecurity = 3/);
assert.match(nativeWorker, /\$excel\.EnableEvents = \$false/);
assert.match(nativeWorker, /\$excel\.AskToUpdateLinks = \$false/);
assert.match(nativeWorker, /\$excel\.Calculation = -4135/);
assert.match(nativeWorker, /GetWindowThreadProcessId/);
assert.match(nativeWorker, /Workbooks\.Open\(\$inputFullPath, 0, \$readOnly\)/);
assert.match(nativeWorker, /sourceHashBefore/);
assert.match(nativeWorker, /sourceHashAfter/);
assert.doesNotMatch(nativeWorker, /New-SelfSignedCertificate|Cert:\\|Set-ItemProperty|New-ItemProperty|RefreshAll|VBProject|CodeModule/);
const vbaWorker = await fs.readFile(path.join(root, "workers/excel-vba.ps1"), "utf8");
for (const setting of ["Visible", "DisplayAlerts", "EnableEvents", "AskToUpdateLinks"]) assert.match(vbaWorker, new RegExp(`\\$excel\\.${setting} = \\$false`));
assert.match(vbaWorker, /\$excel\.AutomationSecurity = 3/);
assert.match(vbaWorker, /\$excel\.Calculation = -4135/);
assert.match(vbaWorker, /\$excel\.CalculateBeforeSave = \$false/);
assert.match(vbaWorker, /\[Environment\]::UserInteractive/);
assert.match(vbaWorker, /GetWindowThreadProcessId/);
assert.match(vbaWorker, /Write-ControlFile \$ownedExcelInstance/);
assert.match(vbaWorker, /if \(-not \$ownedExcelInstance\) \{ throw/);
assert.match(vbaWorker, /Workbooks\.Open\(\$inputFullPath, 0, \$true\)/);
assert.match(vbaWorker, /Workbooks\.Open\(\$outputFullPath, 0, \$true\)/);
assert.ok(vbaWorker.indexOf("$excel.AutomationSecurity = 3") < vbaWorker.indexOf("$excel.Workbooks.Open("));
assert.match(vbaWorker, /sourceHashBefore/);
assert.match(vbaWorker, /sourceHashAfter/);
assert.match(vbaWorker, /PI_SENTINEL_EXECUTED/);
assert.match(vbaWorker, /FinalReleaseComObject/);
assert.match(vbaWorker, /\$excel\.Quit\(\)/);
assert.doesNotMatch(vbaWorker, /Application\s*\.\s*Run|\.\s*Run\s*\(|RefreshAll|\bCalculate\b|AccessVBOM|VBE\s*\.\s*MainWindow|Certificate|Cert:\\|\b(?:Get|Set|New|Remove|Clear|Copy|Move|Rename)-ItemProperty\b|\b(?:Get|Set|New|Remove|Clear|Copy|Move|Rename)-Item\b[^\r\n]*(?:HKCU:|HKLM:|Registry::)/i);
console.log(`package_check=PASS required_files=${required.length} tools=8 native_worker_safety=PASS vba_worker_safety=PASS`);
