import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const artifactOwner = await readFile(new URL("../public/project-artifact-controller.mjs", import.meta.url), "utf8");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [server, app, styles] = await Promise.all([
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
]);

for (const contract of ["pi.artifact/v1", "registerDocumentArtifact", "rewriteArtifactsForTab", "documentArtifactRecord", "sendDocumentArtifactFile", "/api/artifacts/"]) assert.ok(server.includes(contract), `server should contain ${contract}`);
for (const privateField of ["manifestPath", "downloadPath", "outputPath", "sourcePath", "stagedPath", "pdfPath", "workspace", "recoveryPath"]) assert.match(server, new RegExp(`PRIVATE_ARTIFACT_KEYS[^;]+[\\s\\S]*?${privateField}`), `artifact sanitizer should cover ${privateField}`);
for (const feature of ["openDocumentArtifact", "appendDocumentArtifact", "Send page to composer", "Previous", "Rotate", "Semantic structure, revisions, warnings, and diff"]) assert.ok((app + artifactOwner).includes(feature), `browser viewer should contain ${feature}`);
for (const selector of [".document-artifact-dialog", ".document-artifact-sidebar", ".document-artifact-page", "@media (max-width: 720px)"]) assert.ok(styles.includes(selector), `viewer stylesheet should contain ${selector}`);
assert.equal(/details\.artifact\s*=/.test(server), false, "server should replace details immutably rather than mutating raw RPC artifacts");
console.log("document-artifact-static.test.mjs passed");
