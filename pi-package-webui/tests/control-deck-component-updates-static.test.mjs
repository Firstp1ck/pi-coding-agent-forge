import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, css, app, development] = await Promise.all([
  readFile(join(root, "public/index.html"), "utf8"),
  readFile(join(root, "public/styles.css"), "utf8"),
  readFile(join(root, "public/app.js"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
]);
for (const target of ["pi", "webui"]) {
  assert.match(app, new RegExp(`startComponentUpdate\\("${target}"\\)`));
  assert.match(html, new RegExp(`id="${target}ComponentUpdateStatus"[^>]*aria-live="polite"`));
  assert.match(html, new RegExp(`id="${target}ComponentUpdateOutput"[^>]*aria-label=`));
}
assert.match(html, /<option value="update-webui">Update Web UI<\/option>/);
assert.doesNotMatch(html, /update-all|Update all|Pi \+ Web UI update/);
assert.doesNotMatch(app, /runPiUpdateAndRestart|managed Web UI activation|side-by-side managed runtime/);
assert.match(app, /body: \{ targets: \[target\] \}/);
assert.match(app, /body: \{ transactionId: plan.transactionId, planDigest: plan.digest \}/);
assert.match(app, /componentUpdateConfirmationText\(plan\)[\s\S]*installedRoot[\s\S]*effectRoot[\s\S]*command\.command[\s\S]*command\.args[\s\S]*context\.cwd[\s\S]*context\.agentDir[\s\S]*context\.npmPrefix[\s\S]*plan\.refusals[\s\S]*plan\.warning[\s\S]*plan\.digest/);
assert.match(app, /nativeJobs[\s\S]*nativeJobDiscoveryError/);
assert.match(app, /plan\.pathPi\?\.eligible[\s\S]*plan\.pathPi\.version[\s\S]*plan\.pathPi\.packageRoot[\s\S]*plan\.pathPi\.executable[\s\S]*plan\.pathPi\.cli/);
assert.match(app, /uncertainApplyJobs\[target\] = plan\.transactionId[\s\S]*phase: "launching"/);
assert.match(app, /if \(latestUpdateStatus\?\.nativeJobs && !latestUpdateStatus\.nativeJobDiscoveryError\) nativeJobPollError = ""/);
assert.match(app, /api\/update\/transactions\/\$\{encodeURIComponent\(job\.transactionId\)\}/);
assert.match(app, /case "unknown"[\s\S]*Do not retry or restart/);
assert.match(app, /case "partial"[\s\S]*Verified healthy active changes may have restarted/);
assert.match(css, /\.component-update-status\[data-update-running\]::before[\s\S]*component-update-spin/);
assert.match(development, /Native Pi and Web UI updates[\s\S]*GET \/api\/update\/transactions\/.*[\s\S]*Native lifecycle scripts are not sandboxed/);
console.log("control deck component update static tests passed");
