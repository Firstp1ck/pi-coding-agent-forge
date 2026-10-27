import assert from "node:assert/strict";
import { compactReleaseOutput, compactReleaseView } from "../compact-release-output.ts";

const red = (text) => `\u001b[31m${text}\u001b[0m`;
const cyan = (text) => `\u001b[36m${text}\u001b[0m`;

const planOutput = `npm authentication verified as someone.
$ bash release-workflow.sh --plan --all
Planning required version bumps: bump-package-versions.sh --target all
Mode: plan

==> pi-extension-safety-guard
  - package: @firstpick/pi-extension-safety-guard
  - local version: 0.3.2
  - npm version: 0.3.2
  - publishable changes vs npm: no
  - action: unchanged (no publishable changes)

==> pi-extension-stats
  - package: @firstpick/pi-extension-stats
  - local version: 0.3.4
  - npm version: 0.3.4
  - publishable changes vs npm: yes
  - enforced target when changed: 0.3.5 (patch +1, rolls patch 9 to next minor .0)
  - action: would bump up -> 0.3.5

==> pi-extension-broken
  - package: @firstpick/pi-extension-broken
  - local version: 0.1.0
  - npm version: 0.1.0
  - publishable changes vs npm: yes
  - action: would bump up -> 0.1.1

Summary:
  - would bump up: 2
  - errors: 0

${cyan("==>")} pi-extension-stats
  - [PASS] package.json is valid JSON
  - [PASS] version: 0.3.5
  - [PASS] action: publish (new version)
  Result: PASS ready

${cyan("==>")} pi-extension-broken
  - [PASS] package.json is valid JSON
  - [WARN] README.md missing
  - [${red("FAIL")}] extension entry missing: ./index.ts
  - [FAIL] action: blocked (fix checks first)
  Result: FAIL

Plan summary:
  - @firstpick/pi-extension-stats@0.3.5 -> publish-update
  - @firstpick/pi-extension-broken@0.1.1 -> error
`;

assert.deepEqual(compactReleaseOutput(planOutput), [
  "pi-extension-safety-guard ✓",
  "pi-extension-stats ✓",
  "  0.3.4 → 0.3.5 · bump and publish",
  "pi-extension-broken ✗",
  "  ! README.md missing",
  "  ✗ extension entry missing: ./index.ts",
  "",
  "3 package(s) · 1 to publish · 1 with problems",
]);

// A candidate whose publish checks have not run yet is marked pending.
const pending = compactReleaseOutput(planOutput.slice(0, planOutput.indexOf("Summary:")));
assert.deepEqual(pending.slice(0, 3), ["pi-extension-safety-guard ✓", "pi-extension-stats …", "  0.3.4 → 0.3.5 · bump and publish"]);

const publishOutput = `==> pi-extension-stats
  - package: @firstpick/pi-extension-stats
  - local version: 0.3.4
  - npm version: 0.3.4
  - publishable changes vs npm: yes
  - action: bumped up -> 0.3.5

==> pi-extension-stats
  - [PASS] action: publish (new version)
  Result: PASS ready

Publishing @firstpick/pi-extension-stats@0.3.5 (publish-update)
RELEASE_NPM_EVENT {"status":"published"}
PASS Published @firstpick/pi-extension-stats@0.3.5 via npm
Final result: PASS done
`;
assert.deepEqual(compactReleaseOutput(publishOutput).slice(0, 2), ["pi-extension-stats ✓", "  0.3.4 → 0.3.5 · published"]);

const failedPublish = compactReleaseOutput(publishOutput.replace(/PASS Published.*\n/, "FAIL Failed to publish @firstpick/pi-extension-stats@0.3.5 via npm\n").replace("Final result: PASS done", "Final result: FAIL completed with errors"));
assert.deepEqual(failedPublish.slice(0, 2), ["pi-extension-stats ✗", "  ✗ Failed to publish @firstpick/pi-extension-stats@0.3.5 via npm"]);
assert.ok(failedPublish.includes("✗ release completed with errors"));

// Errors outside a package block stay visible; routine lines do not.
assert.deepEqual(compactReleaseOutput("Mode: plan\nERROR: unknown option '--bad'\nbash: foo: command not found\n"), [
  "✗ unknown option '--bad'",
  "✗ bash: foo: command not found",
]);

console.log("compact-release-output tests passed");

// Packages listed up front show as pending until their output arrives.
assert.deepEqual(compactReleaseOutput("==> pi-a\n  - package: @x/pi-a\n  - local version: 1.0.0\n  - npm version: 1.0.0\n  - action: unchanged (no publishable changes)\n\n", undefined, { expectedDirs: ["pi-a", "pi-b"] }), [
  "pi-a ✓",
  "pi-b …",
  "",
  "1/2 checked · 0 to publish · 0 with problems",
]);

console.log("compact-release-output upfront list tests passed");

// While running, the package being checked and the progress line show the spinner frame.
assert.deepEqual(compactReleaseOutput(["==> pi-a", "  - package: @x/pi-a", ""].join("\n"), undefined, { expectedDirs: ["pi-a", "pi-b"], spinner: "*" }), [
  "pi-a *",
  "pi-b …",
  "",
  "* 0/2 checked · 0 to publish · 0 with problems",
]);

console.log("compact-release-output spinner tests passed");

// The view points at the package being worked on so the window can keep it in view.
{
  const output = ["==> pi-a", "  - action: unchanged (no publishable changes)", "", "==> pi-b", ""].join(String.fromCharCode(10));
  const view = compactReleaseView(output, undefined, { expectedDirs: ["pi-a", "pi-b", "pi-c"], spinner: "*" });
  assert.deepEqual(view.lines, ["pi-a ✓", "pi-b *", "pi-c …"]);
  assert.equal(view.focusLine, 1);
  assert.equal(view.summary, "* 1/3 checked · 0 to publish · 0 with problems");
  assert.equal(compactReleaseView("", undefined, { expectedDirs: ["pi-a"] }).focusLine, 0);
}

console.log("compact-release-output focus tests passed");

// Workspace work must be visible and stop focusing the last checked package.
{
  const checked = "==> pi-utils\n  - action: unchanged (no publishable changes)\n\n";
  const preparing = checked + "Release progress: Copying release candidate pi-a\n";
  const view = compactReleaseView(preparing, undefined, { expectedDirs: ["pi-utils", "pi-a"], spinner: "*" });
  assert.deepEqual(view.lines, ["pi-utils ✓", "pi-a …", "Copying release candidate pi-a"]);
  assert.equal(view.focusLine, 2);
  assert.match(view.summary, /^\* Copying release candidate pi-a ·/);
  const next = compactReleaseView(preparing + "==> pi-a\n", undefined, { expectedDirs: ["pi-utils", "pi-a"], spinner: "*" });
  assert.deepEqual(next.lines, ["pi-utils ✓", "pi-a *"]);
  assert.equal(next.focusLine, 1);
  const cleanup = compactReleaseView(preparing + "Release progress: Cleaning up temporary workspace\n", undefined, { spinner: "*" });
  assert.equal(cleanup.lines.at(-1), "Cleaning up temporary workspace");
  assert.ok(!cleanup.lines.includes("Copying release candidate pi-a"));
  // Phase records must also work without a blank separator after package output.
  const noBlank = compactReleaseView("==> pi-utils\nRelease progress: Preparing workspace\n", undefined, { spinner: "*" });
  assert.equal(noBlank.lines.at(-1), "Preparing workspace");
  assert.ok(!noBlank.lines[0].includes("*"));
}

console.log("compact-release-output workspace progress tests passed");
