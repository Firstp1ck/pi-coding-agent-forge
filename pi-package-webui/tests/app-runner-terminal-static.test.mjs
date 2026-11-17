import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, runnerService] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "lib", "server", "app-runners.mjs"), "utf8"),
]);

assert.match(
  app,
  /function renderAppRunnerWidget\(\)[\s\S]*appendReleaseNpmTerminalLine\(terminal, line\)/,
  "frontend should render app runner output through the shared terminal-line renderer",
);
assert.match(
  app,
  /function appendReleaseNpmTerminalLine\(parent, line\)[\s\S]*renderAnsiText\(row, line\)/,
  "app-runner terminal lines should apply supported ANSI styling and hide unsupported ANSI controls",
);
assert.match(
  runnerService,
  /consumeAppRunnerTerminalChunk\([\s\S]*carriageReturnPending/,
  "server should preserve terminal-style carriage-return state across app-runner chunks",
);

console.log("app runner terminal static contracts passed");
