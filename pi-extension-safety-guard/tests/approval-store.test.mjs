import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { ApprovalPersistence, allowKey, projectApprovalFile } from "../src/approval-store.ts";
import { globalOperationAllowKey } from "../src/approvals.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-approval-store-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let number = 0;
function fixture() {
  const dir = path.join(root, String(++number));
  const cwd = path.join(dir, "project-a");
  const other = path.join(dir, "project-b");
  const globalFile = path.join(dir, "user", "safety-guard-allow.json");
  for (const folder of [cwd, other, path.dirname(globalFile)]) fs.mkdirSync(folder, { recursive: true });
  return { dir, cwd, other, globalFile, store: new ApprovalPersistence(globalFile) };
}
function local(cwd, command = "git switch main") {
  return { key: allowKey("bash", command, cwd), matchType: "exact", kind: "bash", value: command, cwd, label: "git switch", createdAt: "2026-01-01T00:00:00Z" };
}
function global() {
  const argv = ["git", "switch", "main"];
  return { ...local(""), matchType: "operation-global", cwd: "", argv, key: globalOperationAllowKey(argv) };
}
const rawStore = (entries) => `${JSON.stringify({ version: 1, entries })}\n`;
const readEntries = (file) => JSON.parse(fs.readFileSync(file, "utf8")).entries;
function backups(f) { return fs.readdirSync(path.dirname(f.globalFile)).filter((file) => file.endsWith(".bak")); }
function withRenameFailure(target, run) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === target) throw new Error("simulated commit failure"); return rename(from, to); };
  try { run(); } finally { fs.renameSync = rename; }
}

test("local/global approvals use distinct physical stores; receipts contain only digests", () => {
  const f = fixture();
  const file = projectApprovalFile(f.cwd);
  fs.mkdirSync(path.dirname(file));
  const ignore = path.join(path.dirname(file), ".gitignore");
  fs.writeFileSync(ignore, "existing-rule");
  f.store.save([local(f.cwd)], f.cwd);
  assert.equal(fs.existsSync(f.globalFile), false);
  assert.deepEqual(readEntries(file), [local(f.cwd)]);
  assert.equal(fs.readFileSync(ignore, "utf8"), "existing-rule\n/safety-guard-allow.json\n");
  const receipt = JSON.parse(fs.readFileSync(f.store.receiptFile, "utf8"));
  assert.equal(receipt.files[file], createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  assert.ok(!JSON.stringify(receipt).includes("git switch"));
  f.store.save([global()], f.cwd);
  assert.deepEqual(readEntries(f.globalFile), [global()]);
  assert.equal(f.store.load(f.cwd).entries.length, 2);
  assert.deepEqual(f.store.load(f.other).entries, [global()]);
  if (process.platform !== "win32") for (const target of [file, f.globalFile, f.store.receiptFile]) assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("Git ignores the generated per-project approval file", { skip: spawnSync("git", ["--version"]).status !== 0 }, () => {
  const f = fixture();
  execFileSync("git", ["init", "--quiet", f.cwd], { stdio: "pipe" });
  f.store.save([local(f.cwd)], f.cwd);
  const file = projectApprovalFile(f.cwd);
  const matched = execFileSync("git", ["-C", f.cwd, "check-ignore", "--no-index", file], { encoding: "utf8" });
  assert.equal(matched.trim(), file);
});

test("copied, edited and unverified project files cannot grant permissions or be overwritten", () => {
  const f = fixture();
  f.store.save([local(f.cwd)], f.cwd);
  const file = projectApprovalFile(f.cwd);
  const copy = projectApprovalFile(f.other);
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(file, copy);
  assert.deepEqual(f.store.load(f.other).entries, []);
  assert.match(f.store.load(f.other).issues.join("\n"), /Unverified project approvals/);
  const altered = rawStore([local(f.cwd, "git reset --hard")]);
  fs.writeFileSync(file, altered);
  assert.deepEqual(f.store.load(f.cwd).entries, []);
  assert.throws(() => f.store.save([local(f.cwd)], f.cwd), /Unverified project approvals/);
  assert.equal(fs.readFileSync(file, "utf8"), altered);
});

test("even a verified local file cannot supply global or another cwd's identities", () => {
  const f = fixture();
  const file = projectApprovalFile(f.cwd);
  fs.mkdirSync(path.dirname(file));
  const raw = rawStore([global(), local(f.other)]);
  fs.writeFileSync(file, raw);
  fs.writeFileSync(f.store.receiptFile, JSON.stringify({ version: 1, files: { [file]: createHash("sha256").update(raw).digest("hex") } }));
  assert.deepEqual(f.store.load(f.cwd).entries, []);
});

test("lazy migration backs up original bytes, commits a verified local file, and preserves other cwd records", () => {
  const f = fixture();
  const original = rawStore([local(f.cwd), local(f.other), global()]);
  fs.writeFileSync(f.globalFile, original);
  assert.equal(f.store.load(f.cwd).issues.length, 0);
  assert.deepEqual(readEntries(projectApprovalFile(f.cwd)), [local(f.cwd)]);
  assert.deepEqual(readEntries(f.globalFile), [local(f.other), global()]);
  assert.equal(backups(f).length, 1);
  const backup = path.join(path.dirname(f.globalFile), backups(f)[0]);
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  if (process.platform !== "win32") assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  f.store.load(f.cwd);
  assert.equal(backups(f).length, 1);
  f.store.clear(f.cwd);
  assert.deepEqual(f.store.load(f.cwd).entries, []);
  assert.deepEqual(readEntries(f.globalFile), [local(f.other)]);
  assert.deepEqual(f.store.load(f.other).entries, [local(f.other)]);
  assert.deepEqual(readEntries(f.globalFile), []);
  assert.deepEqual(f.store.load(f.cwd).entries, [], "backups must never revive cleared grants");
});

test("an unverified migration destination leaves original legacy grants and bytes intact", () => {
  const f = fixture();
  const original = rawStore([local(f.cwd)]);
  fs.writeFileSync(f.globalFile, original);
  const file = projectApprovalFile(f.cwd);
  fs.mkdirSync(path.dirname(file));
  const forged = rawStore([local(f.cwd, "git reset --hard")]);
  fs.writeFileSync(file, forged);
  const result = f.store.load(f.cwd);
  assert.deepEqual(result.entries, [local(f.cwd)]);
  assert.match(result.issues.join("\n"), /migration not completed/);
  assert.equal(fs.readFileSync(f.globalFile, "utf8"), original);
  assert.equal(fs.readFileSync(file, "utf8"), forged);
});

test("receipt failure rolls back local bytes and never authorizes the new grant", () => {
  const f = fixture();
  f.store.save([local(f.cwd)], f.cwd);
  const file = projectApprovalFile(f.cwd);
  const before = fs.readFileSync(file, "utf8");
  withRenameFailure(f.store.receiptFile, () => assert.throws(() => f.store.save([local(f.cwd, "git reset --hard")], f.cwd), /simulated/));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(f.store.load(f.cwd).entries, [local(f.cwd)]);
  assert.equal(fs.existsSync(f.store.lockFile), false);
  assert.ok(fs.readdirSync(path.dirname(file)).every((name) => !name.endsWith(".tmp")));
  const fresh = fixture();
  withRenameFailure(fresh.store.receiptFile, () => assert.throws(() => fresh.store.save([local(fresh.cwd)], fresh.cwd), /simulated/));
  assert.equal(fs.existsSync(projectApprovalFile(fresh.cwd)), false);
  assert.deepEqual(fresh.store.load(fresh.cwd).entries, []);
});

test("failed legacy cleanup leaves the backup and verified local copy; retry completes migration", () => {
  const f = fixture();
  const original = rawStore([local(f.cwd), global()]);
  fs.writeFileSync(f.globalFile, original);
  withRenameFailure(f.globalFile, () => {
    const loaded = f.store.load(f.cwd);
    assert.match(loaded.issues.join("\n"), /migration not completed/);
    assert.equal(loaded.entries.length, 2);
  });
  assert.equal(fs.readFileSync(f.globalFile, "utf8"), original);
  assert.deepEqual(readEntries(projectApprovalFile(f.cwd)), [local(f.cwd)]);
  assert.equal(f.store.load(f.cwd).issues.length, 0);
  assert.deepEqual(readEntries(f.globalFile), [global()]);
});

test("busy locks are neither bypassed nor removed", () => {
  const f = fixture();
  fs.writeFileSync(f.store.lockFile, "another owner");
  assert.throws(() => f.store.save([local(f.cwd)], f.cwd), /store is busy/);
  assert.equal(fs.readFileSync(f.store.lockFile, "utf8"), "another owner");
  assert.equal(fs.existsSync(projectApprovalFile(f.cwd)), false);
});

test("symlinked local directories, approval files and ignore files are rejected", { skip: process.platform === "win32" }, () => {
  for (const kind of ["directory", "approval", "ignore"]) {
    const f = fixture();
    const file = projectApprovalFile(f.cwd);
    const outside = path.join(f.dir, "outside");
    fs.mkdirSync(outside);
    if (kind === "directory") fs.symlinkSync(outside, path.dirname(file));
    else {
      fs.mkdirSync(path.dirname(file));
      const target = path.join(outside, "untouched");
      fs.writeFileSync(target, "untouched");
      fs.symlinkSync(target, kind === "approval" ? file : path.join(path.dirname(file), ".gitignore"));
    }
    assert.throws(() => f.store.save([local(f.cwd)], f.cwd), /symlink/);
    assert.deepEqual(f.store.load(f.cwd).entries, []);
    assert.equal(fs.existsSync(path.join(outside, "safety-guard-allow.json")), false);
  }
});

test("clearing current/global grants leaves other verified projects untouched", () => {
  const f = fixture();
  f.store.save([local(f.cwd)], f.cwd);
  f.store.save([local(f.other)], f.other);
  f.store.save([global()], f.cwd);
  const otherBytes = fs.readFileSync(projectApprovalFile(f.other), "utf8");
  f.store.clear(f.cwd);
  assert.deepEqual(f.store.load(f.cwd).entries, []);
  assert.deepEqual(f.store.load(f.other).entries, [local(f.other)]);
  assert.equal(fs.readFileSync(projectApprovalFile(f.other), "utf8"), otherBytes);
});

test("oversized and invalid-encoding state files are rejected without being replaced", () => {
  const f = fixture();
  fs.writeFileSync(f.globalFile, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  assert.match(f.store.load(f.cwd).issues.join("\n"), /exceeds 8 MiB/);
  assert.throws(() => f.store.save([global()], f.cwd), /exceeds 8 MiB/);
  assert.equal(fs.statSync(f.globalFile).size, 8 * 1024 * 1024 + 1);
  fs.writeFileSync(f.globalFile, Buffer.from([255, 254]));
  assert.match(f.store.load(f.cwd).issues.join("\n"), /not UTF-8/);
  assert.throws(() => f.store.save([global()], f.cwd), /not UTF-8/);
  assert.deepEqual(fs.readFileSync(f.globalFile), Buffer.from([255, 254]));
});

test("invalid stores fail without overwriting or leaking malformed contents", () => {
  const f = fixture();
  fs.writeFileSync(f.globalFile, "secret-example invalid JSON");
  const result = f.store.load(f.cwd);
  assert.deepEqual(result.entries, []);
  assert.ok(!result.issues.join("\n").includes("secret-example"));
  assert.throws(() => f.store.save([global()], f.cwd), /Invalid approval store JSON/);
  assert.equal(fs.readFileSync(f.globalFile, "utf8"), "secret-example invalid JSON");
});
