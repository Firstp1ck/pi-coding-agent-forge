import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const server = await readFile(new URL("../bin/pi-webui.mjs", import.meta.url), "utf8");
const source = server.match(/^async function handleGitWorkflowRequest\([^\n]*\n[\s\S]*?^}/m)?.[0];
assert.ok(source, "the route adapter must remain inspectable");

function dispatcher(dependencies) {
  return vm.runInNewContext(`(${source})`, {
    options: { cwd: "/default" },
    sanitizeError: (error) => error.message,
    ...dependencies,
  });
}

for (const [route, method, receivesBody] of [
  ["init", "initializeGitRepository", false],
  ["initial-commit", "initialGitCommit", false],
  ["main-branch", "renameGitMainBranch", false],
  ["remote", "addGitOrigin", true],
  ["init-push", "pushInitialGitMain", false],
  ["commit", "commitGitWorkflow", true],
  ["push", "pushGitWorkflow", true],
  ["publish", "publishGitRepository", true],
  ["create-pr", "createGitWorkflowPr", true],
]) {
  test(`${route} retains the workflow envelope across an asynchronous service boundary`, async () => {
    const body = { confirmed: true, expectedStagedContentHash: "approved" };
    const tab = { id: "origin", cwd: "/origin" };
    const payload = { ok: true, data: { marker: route } };
    let reject = false;
    const dispatch = dispatcher({
      [method]: async (...args) => {
        assert.deepEqual(args, receivesBody ? [tab.cwd, body] : [tab.cwd]);
        await Promise.resolve();
        if (reject) throw Object.assign(new Error("fixture validation refusal"), { status: 409 });
        return payload;
      },
    });
    assert.equal(await dispatch(`/api/git-workflow/${route}`, body, tab), payload);
    reject = true;
    const failure = await dispatch(`/api/git-workflow/${route}`, body, tab);
    assert.equal(failure.ok, false);
    assert.equal(failure.error, "fixture validation refusal");
    assert.deepEqual(Object.keys(failure).sort(), ["error", "ok"]);
  });
}

test("cancel invokes both owners even when generation cancellation succeeds", async () => {
  const tab = { id: "origin", cwd: "/origin" };
  const calls = [];
  const dispatch = dispatcher({
    cancelGitWorkflowGeneration: (target) => {
      assert.equal(target, tab);
      calls.push("generation");
      return true;
    },
    cancelGitWorkflowProcess: () => { calls.push("process"); return false; },
  });
  const result = await dispatch("/api/git-workflow/cancel", {}, tab);
  assert.deepEqual(calls, ["generation", "process"]);
  assert.equal(result.ok, true);
  assert.equal(result.data.cancelled, true);
});
