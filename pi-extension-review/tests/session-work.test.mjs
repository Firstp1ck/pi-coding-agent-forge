import test from "node:test";
import assert from "node:assert/strict";
import { createSessionWorkTracker } from "../src/session-work.ts";

function entry(id, parentId, message) { return { type: "message", id, parentId, timestamp: new Date().toISOString(), message }; }

function context(branch) {
  return { cwd: process.cwd(), sessionManager: { getBranch: () => branch } };
}

test("work extraction uses only finalized write/edit calls on the active branch", () => {
  const branch = [
    entry("1", null, { role: "user", content: "Fix the parser", timestamp: 1 }),
    entry("2", "1", { role: "assistant", content: [
      { type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "shell-1", name: "bash", arguments: { command: "touch unknown" } },
    ] }),
    entry("3", "2", { role: "toolResult", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false }),
    entry("4", "3", { role: "toolResult", toolCallId: "shell-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }),
  ];
  const tracker = createSessionWorkTracker();
  const snapshot = tracker.snapshot(context(branch), 4096);
  assert.deepEqual(snapshot.paths, ["src/a.ts"]);
  assert.deepEqual(snapshot.taskContext, ["Fix the parser"]);
  assert.match(snapshot.warnings.join("\n"), /bash.*exact attribution/u);
});

test("unrelated session branches and failed tool results confer no provenance", () => {
  const active = [
    entry("1", null, { role: "user", content: "Active task" }),
    entry("2", "1", { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "edit", arguments: { path: "src/failed.ts" } }] }),
    entry("3", "2", { role: "toolResult", toolCallId: "bad", toolName: "edit", isError: true, content: [] }),
  ];
  const tracker = createSessionWorkTracker();
  const snapshot = tracker.snapshot(context(active), 4096);
  assert.deepEqual(snapshot.paths, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /other-branch/u);
});

test("persisted bash execution restores attribution warning after reload", () => {
  const branch = [entry("bash-1", null, { role: "bashExecution", command: "touch hidden", excludeFromContext: true })];
  const snapshot = createSessionWorkTracker().snapshot(context(branch), 4096);
  assert.match(snapshot.warnings.join("\n"), /user shell/u);
});

test("live finalized events add exact built-in paths and flag shell/custom changes", () => {
  const tracker = createSessionWorkTracker();
  tracker.observeToolCall({ toolCallId: "e1", toolName: "edit", input: { path: "src/live.ts" } });
  tracker.observeToolResult({ toolCallId: "e1", toolName: "edit", isError: false }, process.cwd());
  tracker.observeToolCall({ toolCallId: "c1", toolName: "custom_mutator", input: {} });
  tracker.observeToolResult({ toolCallId: "c1", toolName: "custom_mutator", isError: false }, process.cwd());
  tracker.observeUserShell();
  const snapshot = tracker.snapshot(context([]), 4096);
  assert.deepEqual(snapshot.paths, ["src/live.ts"]);
  assert.match(snapshot.warnings.join("\n"), /custom_mutator/u);
  assert.match(snapshot.warnings.join("\n"), /user shell/u);
});

test("live provenance and warnings from an abandoned branch are excluded", () => {
  const tracker = createSessionWorkTracker();
  tracker.observeToolCall({ toolCallId: "old-write", toolName: "write", input: { path: "src/old.ts" } }, "assistant-old");
  tracker.observeToolResult({ toolCallId: "old-write", toolName: "write", isError: false }, process.cwd());
  tracker.observeToolCall({ toolCallId: "old-custom", toolName: "custom_mutator", input: {} }, "assistant-old");
  const currentBranch = [entry("assistant-new", null, { role: "assistant", content: [] })];
  const snapshot = tracker.snapshot(context(currentBranch), 4096);
  assert.deepEqual(snapshot.paths, []);
  assert.doesNotMatch(snapshot.warnings.join("\n"), /custom_mutator/u);
});

test("task context is branch-local and byte bounded", () => {
  const branch = Array.from({ length: 20 }, (_, index) => entry(String(index), index ? String(index - 1) : null, { role: "user", content: `task-${index}-${"x".repeat(100)}` }));
  const snapshot = createSessionWorkTracker().snapshot(context(branch), 500);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.taskContext), "utf8") <= 500);
  assert.ok(snapshot.taskContext.at(-1).startsWith("task-19-"));
});
