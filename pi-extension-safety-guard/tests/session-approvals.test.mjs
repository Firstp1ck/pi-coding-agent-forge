import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionApprovals, SESSION_APPROVAL_ENTRY } from "../src/session-approvals.ts";
import { allowKey } from "../src/approval-store.ts";
import { globalOperationAllowKey } from "../src/approvals.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-approvals-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let index = 0;
function fixture() {
  const cwd = path.join(root, String(++index));
  fs.mkdirSync(cwd);
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "test fixture" }], provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const grant = { key: allowKey("bash", "git switch main", cwd), matchType: "exact", kind: "bash", value: "git switch main", cwd, label: "git switch", createdAt: "2026-01-01T00:00:00Z" };
  return { manager, grant, append: (type, data) => { manager.appendCustomEntry(type, data); } };
}

test("session approvals survive extension reload and reopening the native session file", () => {
  const { manager, grant, append } = fixture();
  new SessionApprovals().save([grant], manager, append);
  const reloaded = new SessionApprovals();
  reloaded.restore(manager);
  assert.deepEqual([...reloaded.entries.values()], [grant]);
  const reopened = SessionManager.open(manager.getSessionFile());
  const resumed = new SessionApprovals();
  resumed.restore(reopened);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.deepEqual([...resumed.entries.values()], [grant]);
  const entry = reopened.getEntries().find((item) => item.type === "custom" && item.customType === SESSION_APPROVAL_ENTRY);
  assert.equal(entry.data.sessionId, manager.getSessionId());
  assert.ok(!reopened.buildSessionContext().messages.some((message) => JSON.stringify(message).includes(SESSION_APPROVAL_ENTRY)));
});

test("session clear is durable and branch navigation cannot revive a grant", () => {
  const { manager, grant, append } = fixture();
  const state = new SessionApprovals();
  state.save([grant], manager, append);
  const grantLeaf = manager.getLeafId();
  state.clear(manager, append);
  manager.branch(grantLeaf);
  state.restore(manager);
  assert.equal(state.entries.size, 0);
  state.restore(SessionManager.open(manager.getSessionFile()));
  assert.equal(state.entries.size, 0);
});

test("forked and new sessions do not inherit the source session's approvals", () => {
  const { manager, grant, append } = fixture();
  const state = new SessionApprovals();
  state.save([grant], manager, append);
  const originalFile = manager.getSessionFile();
  const originalId = manager.getSessionId();
  const forkFile = manager.createBranchedSession(manager.getLeafId());
  const forked = SessionManager.open(forkFile);
  assert.notEqual(forked.getSessionId(), originalId);
  assert.ok(forked.getEntries().some((entry) => entry.customType === SESSION_APPROVAL_ENTRY));
  state.ensure(forked);
  assert.equal(state.entries.size, 0);
  state.restore(SessionManager.open(originalFile));
  assert.deepEqual([...state.entries.values()], [grant]);
  manager.newSession();
  state.ensure(manager);
  assert.equal(state.entries.size, 0);
});

test("session persistence errors do not create a grant, even when native memory was already updated", () => {
  const { manager, grant, append } = fixture();
  const state = new SessionApprovals();
  const failingAppend = (type, data) => { append(type, data); throw new Error("simulated persistence failure"); };
  assert.throws(() => state.save([grant], manager, failingAppend), /simulated/);
  assert.equal(state.entries.size, 0);
  state.restore(manager);
  assert.equal(state.entries.size, 0);
  state.restore(SessionManager.open(manager.getSessionFile()));
  assert.equal(state.entries.size, 0);
  state.save([grant], manager, append);
  assert.throws(() => state.clear(manager, failingAppend), /simulated/);
  state.restore(manager);
  assert.deepEqual([...state.entries.values()], [grant]);
});

test("malformed, foreign-session and global entries cannot become session grants", () => {
  const { manager, grant, append } = fixture();
  const state = new SessionApprovals();
  state.save([grant], manager, append);
  append(SESSION_APPROVAL_ENTRY, { version: 2, sessionId: manager.getSessionId(), entries: [grant] });
  state.restore(manager);
  assert.equal(state.entries.size, 0);
  append(SESSION_APPROVAL_ENTRY, { version: 1, sessionId: "another-session", entries: [grant] });
  state.restore(manager);
  assert.equal(state.entries.size, 0);
  const argv = ["git", "switch", "main"];
  const global = { ...grant, matchType: "operation-global", cwd: "", argv, key: globalOperationAllowKey(argv) };
  assert.throws(() => state.save([global], manager, append), /Invalid session/);
  append(SESSION_APPROVAL_ENTRY, { version: 1, sessionId: manager.getSessionId(), entries: [global, { ...grant, key: "wrong" }] });
  state.restore(manager);
  assert.equal(state.entries.size, 0);
});

test("in-memory Pi sessions retain approvals through reload but do not promise disk persistence", () => {
  const { grant } = fixture();
  const manager = SessionManager.inMemory(grant.cwd);
  const append = (type, data) => { manager.appendCustomEntry(type, data); };
  new SessionApprovals().save([grant], manager, append);
  const state = new SessionApprovals();
  state.restore(manager);
  assert.deepEqual([...state.entries.values()], [grant]);
  assert.equal(manager.getSessionFile(), undefined);
});
