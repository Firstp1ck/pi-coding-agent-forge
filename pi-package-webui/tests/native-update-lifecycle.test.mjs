import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "pi-webui-native-lifecycle-"));
const prefix = path.join(temp, "prefix");
const windows = process.platform === "win32";
const bin = windows ? prefix : path.join(prefix, "bin");
const piRoot = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "@earendil-works", "pi-coding-agent");
const npmRoot = path.join(temp, "npm");
const cli = path.join(piRoot, "dist", "cli.js");
const manifest = path.join(piRoot, "package.json");
const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const chosen = server.address().port;
    server.close(() => resolve(chosen));
  });
});
let child;
let cleanupSafe = false;
let output = "";
const base = `http://127.0.0.1:${port}`;
const api = (route, body) => fetch(`${base}${route}`, body === undefined ? {} : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
try {
  await mkdir(path.join(piRoot, "dist"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(npmRoot, "bin"), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1", bin: { pi: "dist/cli.js" } }));
  const fakePi = path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs");
  await writeFile(cli, `import { readFileSync, writeFileSync } from 'node:fs';\nconst manifest = ${JSON.stringify(manifest)};\nconst current = JSON.parse(readFileSync(manifest, 'utf8'));\nif (process.argv.includes('--version')) { console.log(current.version); process.exit(0); }\nif (process.argv.includes('update')) { current.version = '0.87.2'; writeFileSync(manifest, JSON.stringify(current)); process.exit(0); }\nawait import(${JSON.stringify(pathToFileURL(fakePi).href)});\n`);
  if (windows) {
    await writeFile(path.join(bin, "pi.cmd"), `@echo off\r\nnode "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n`);
  } else await symlink(cli, path.join(bin, "pi"));
  await writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }));
  await writeFile(path.join(npmRoot, "bin", "npm-cli.js"), `const prefix = ${JSON.stringify(prefix)};\nconst args = process.argv.slice(2).join(' ');\nif (args === 'root -g') console.log(${JSON.stringify(path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules"))});\nelse if (args === 'prefix -g') console.log(prefix);\nelse if (args === 'config get userconfig') console.log(${JSON.stringify(path.join(temp, "user.npmrc"))});\nelse if (args === 'config get globalconfig') console.log(${JSON.stringify(path.join(temp, "global.npmrc"))});\nelse process.exitCode = 2;\n`);
  child = spawn(process.execPath, [path.join(packageRoot, "bin", "pi-webui.mjs"), "--cwd", temp,
    "--host", "127.0.0.1", "--port", String(port), "--pi", cli], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
      PI_CODING_AGENT_DIR: path.join(temp, "agent"), PI_WEBUI_NPM_BIN: path.join(npmRoot, "bin", "npm-cli.js"),
      PI_WEBUI_UPDATE_TEST_HOME: temp, NODE_ENV: "test", PI_OFFLINE: "1" },
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited: ${output}`);
    try { if ((await api("/api/health")).ok) break; } catch {}
    await delay(100);
  }
  const planned = await api("/api/update/plan", { targets: ["pi"] });
  const planResult = await planned.json();
  assert.equal(planned.status, 201, JSON.stringify(planResult) + output);
  const plan = planResult.data.plan;
  assert.deepEqual(plan.targets.map(({ id }) => id), ["pi"]);
  const applied = await api("/api/update/apply", { transactionId: plan.transactionId, planDigest: plan.digest });
  assert.equal(applied.status, 202, JSON.stringify(await applied.json()) + output);
  let result;
  for (let i = 0; i < 180; i++) {
    result = (await (await api(`/api/update/transactions/${plan.transactionId}`)).json()).data;
    if (["success", "partial", "failed", "unknown"].includes(result.phase)) break;
    await delay(200);
  }
  assert.equal(result.phase, "success", JSON.stringify(result) + output);
  assert.equal(result.receipts[0].status, "changed");
  assert.equal(result.verifiedTargets[0].status, "healthy");
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.87.2");
  const state = await api("/api/state");
  assert.equal(state.status, 200, output);
  cleanupSafe = true;
} finally {
  if (child && child.exitCode === null) {
    try { await api("/api/shutdown", {}); } catch { child.kill("SIGTERM"); }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(6_000)]);
    if (child.exitCode === null) child.kill();
  }
  if (cleanupSafe) {
    // Windows may still be closing the detached supervisor's directory handle.
    await rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 150 });
  } else console.error(`Retained failed native lifecycle fixture for inspection: ${temp}`);
}
console.log("native-update-lifecycle.test.mjs passed");
