import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function temporaryDirectory(prefix = "code-quality-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDirectory(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

export async function writeFixture(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

export async function withEnvironment(changes, operation) {
  const previous = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function run(command, args, { cwd, env = process.env, allowedExitCodes = [0] } = {}) {
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (!allowedExitCodes.includes(result.code)) throw new Error(`${command} failed with ${result.code}: ${Buffer.concat(stderr).toString("utf8")}`);
  return Buffer.concat(stdout);
}

export async function createGitRepository(files = {}) {
  const root = await temporaryDirectory("code-quality-git-");
  await run("git", ["init", "--quiet"], { cwd: root });
  await run("git", ["config", "user.email", "tests@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Code Quality Tests"], { cwd: root });
  await run("git", ["config", "core.autocrlf", "false"], { cwd: root });
  for (const [filename, content] of Object.entries(files)) await writeFixture(root, filename, content);
  await run("git", ["add", "--all"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}
