import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { allocateNoProjectWorkspace, noProjectPiArgs, resolveNoProjectWorkspace, validateNoProjectCreateIntent } from "../lib/server/no-project-workspaces.mjs";
import { getWebuiWorkspace, saveWebuiWorkspace } from "../lib/webui-workspaces.mjs";

const root = await mkdtemp(path.join(tmpdir(), "webui-no-project-unit-"));
try {
  const agentDir = path.join(root, "active-agent");
  const project = path.join(root, "project");
  await mkdir(project);
  assert.deepEqual(await resolveNoProjectWorkspace(agentDir, { cwd: project }), {});
  const leaves = await Promise.all(Array.from({ length: 12 }, () => allocateNoProjectWorkspace(agentDir)));
  assert.equal(new Set(leaves.map((leaf) => leaf.cwd)).size, 12);
  const first = leaves[0];
  const ownedRoot = path.join(agentDir, "webui", "no-project");
  assert.equal(path.dirname(first.cwd), ownedRoot);
  assert.deepEqual(await resolveNoProjectWorkspace(agentDir, first), { workspaceKind: "no-project", noProjectId: first.noProjectId });
  assert.deepEqual(await resolveNoProjectWorkspace(agentDir, { cwd: first.cwd }), { workspaceKind: "no-project", noProjectId: first.noProjectId });
  if (process.platform !== "win32") {
    for (const directory of [ownedRoot, first.cwd]) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  await writeFile(path.join(first.cwd, "keep.txt"), "retained user work");
  await allocateNoProjectWorkspace(agentDir);
  assert.equal(await readFile(path.join(first.cwd, "keep.txt"), "utf8"), "retained user work");
  const storage = path.join(root, "workspaces.json");
  const saved = await saveWebuiWorkspace({ name: "No Project", tabs: [{ id: "owned", ...first }] }, storage);
  const restored = (await getWebuiWorkspace(saved.workspace.id, storage)).tabs[0];
  assert.equal(restored.workspaceKind, first.workspaceKind);
  assert.equal(restored.noProjectId, first.noProjectId);
  assert.equal(restored.cwd, first.cwd);

  await assert.rejects(resolveNoProjectWorkspace(agentDir, { ...first, noProjectId: leaves[1].noProjectId }), /identity does not match/);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { ...first, cwd: project }), /canonical owned leaf/);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { cwd: ownedRoot }), /canonical owned leaf/);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { cwd: `${first.cwd}/../${first.noProjectId}` }), /canonical owned leaf/);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { ...first, cwd: path.join(first.cwd, "child") }), /missing/);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { cwd: project, workspaceKind: "typo" }), /unknown workspaceKind/);
  const lookalike = `${ownedRoot}-other`;
  await mkdir(lookalike);
  assert.deepEqual(await resolveNoProjectWorkspace(agentDir, { cwd: lookalike }), {});
  const hidden = `${first.cwd}.hidden`;
  await rename(first.cwd, hidden);
  await assert.rejects(resolveNoProjectWorkspace(agentDir, first), /missing/);
  await symlink(project, first.cwd, "dir");
  await assert.rejects(resolveNoProjectWorkspace(agentDir, first), /canonical owned leaf/);
  await rm(first.cwd);
  await rename(hidden, first.cwd);
  const alias = path.join(root, "alias");
  await symlink(first.cwd, alias, "dir");
  await assert.rejects(resolveNoProjectWorkspace(agentDir, { cwd: alias }), /canonical owned leaf/);
  const linkedAgent = path.join(root, "linked-agent");
  await mkdir(linkedAgent);
  await symlink(path.join(agentDir, "webui"), path.join(linkedAgent, "webui"), "dir");
  await assert.rejects(allocateNoProjectWorkspace(linkedAgent), /symlink/);
  assert.deepEqual(await resolveNoProjectWorkspace(linkedAgent, { cwd: project }), {});

  assert.equal(validateNoProjectCreateIntent({ workspaceKind: "no-project", title: "Draft" }), true);
  assert.equal(validateNoProjectCreateIntent({ cwd: project }), false);
  for (const key of ["cwd", "session", "sessionFile", "sessionPath", "sessionId", "continue", "resume", "noProjectId", "root", "workspace", "agentDir"]) {
    assert.throws(() => validateNoProjectCreateIntent({ workspaceKind: "no-project", [key]: null }), /cannot include/);
  }
  assert.throws(() => validateNoProjectCreateIntent({ workspaceKind: "project" }), /unknown/);
  assert.throws(() => validateNoProjectCreateIntent({ noProjectId: first.noProjectId }), /cannot select/);
  for (const malformed of [null, [], "no-project"]) assert.throws(() => validateNoProjectCreateIntent(malformed), /requires an object/);
  assert.deepEqual(noProjectPiArgs([
    "--session", "/private/history.jsonl", "--continue", "-c", "--resume", "-r", "--session-id=old", "--fork", "old",
    "--prompt", "initial", "--initial-prompt=initial", "-p", "first input", "@input.txt",
    "--model", "fake/model", "--thinking", "high", "--no-tools", "another prompt", "--session-dir", "/custom/sessions",
    "--system-prompt", "keep system instructions", "--custom-extension-option", "value", "--custom-boolean=true", "--no-session",
    "--", "--model", "ignore positional tail",
  ]), ["--model", "fake/model", "--thinking", "high", "--no-tools", "--session-dir", "/custom/sessions", "--system-prompt", "keep system instructions", "--custom-extension-option", "value", "--custom-boolean=true", "--no-session"]);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("No Project allocation, ownership, persistence, and argument tests passed");
