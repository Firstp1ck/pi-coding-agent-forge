// Contract tests that need no PowerShell: recorded Windows helper responses
// (fixtures/*.json, written by protocol.test.mjs with RECORD_WINDOWS_FIXTURES=1)
// must pass the client's validation, and the helper's file layout must match
// what helper.ps1 compiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { decodeTreeDump, validateResult } from "../../src/backends/response.ts";
import { HERE, ROOT, checkResponse, decodePng, findPwsh } from "./client.mjs";

const FIXTURES = join(HERE, "fixtures");
const HELPER_DIR = join(ROOT, "helpers", "windows");
const ERROR_CODES = ["STALE_REF", "NOT_FOUND", "TIMEOUT", "HANDOFF", "PROTOCOL_MISMATCH", "CANCELLED", "BAD_REQUEST", "INTERNAL", "ARCHIVE_REJECTED", "TOO_LARGE"];

function fixtures() {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, ...JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) }));
}

test("every recorded success result passes the client's validation", () => {
  const ok = fixtures().filter((f) => f.response.ok === true);
  assert.ok(ok.length >= 14, `expected at least 14 success fixtures, found ${ok.length}`);
  for (const f of ok) {
    assert.doesNotThrow(() => validateResult(f.method, f.response.result), f.name);
  }
});

test("every recorded error uses the protocol's envelope and codes", () => {
  const errors = fixtures().filter((f) => f.response.ok === false);
  assert.ok(errors.length >= 6);
  for (const f of errors) {
    assert.equal(typeof f.response.id, "number", f.name);
    assert.ok(ERROR_CODES.includes(f.response.error.code), `${f.name}: ${f.response.error.code}`);
    assert.equal(typeof f.response.error.message, "string");
    assert.throws(() => checkResponse(f.method, f.response), (e) => e.code === f.response.error.code);
  }
});

test("recorded hello identifies Windows without the deps capability", () => {
  const hello = validateResult("hello", fixtures().find((f) => f.name === "hello.json").response.result);
  assert.equal(hello.os, "windows");
  assert.equal(hello.protocol, 2);
  assert.ok(typeof hello.platform === "string" && hello.platform.length <= 256);
  assert.ok(!hello.capabilities.includes("deps"));
});

test("recorded screenshots decode, keep their sizes, and flag black captures", () => {
  const byName = Object.fromEntries(fixtures().map((f) => [f.name, f]));
  const scaled = validateResult("screenshot", byName["screenshot-scaled.json"].response.result);
  const png = decodePng(Buffer.from(scaled.png_base64, "base64"));
  assert.equal(png.width, Math.round(scaled.width * scaled.scale));
  assert.equal(png.height, Math.round(scaled.height * scaled.scale));
  const black = validateResult("screenshot", byName["screenshot-allblack.json"].response.result);
  assert.equal(black.allBlack, true);
  assert.ok(decodePng(Buffer.from(black.png_base64, "base64")).rgb.every((b) => b === 0));
  const tree = decodeTreeDump(validateResult("snapshotFull", byName["snapshotFull.json"].response.result).tree_gz_base64);
  assert.ok(tree.length > 0 && tree.every((n) => n.ref.startsWith("s1:")));
});

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test("helper.ps1 compiles exactly the C# files that ship, and they are ASCII", () => {
  const script = readFileSync(join(HELPER_DIR, "helper.ps1"), "utf8");
  const block = script.slice(script.indexOf("$sourceFiles = @("), script.indexOf(")", script.indexOf("$sourceFiles = @(") + 20) + 1);
  const listed = [...block.matchAll(/'([^']+\.cs)'/g)].map((m) => m[1].replaceAll("\\", "/")).sort();
  const onDisk = walk(join(HELPER_DIR, "src")).filter((f) => f.endsWith(".cs")).map((f) => relative(HELPER_DIR, f).replaceAll("\\", "/")).sort();
  assert.deepEqual(listed, onDisk);
  for (const file of [...onDisk.map((f) => join(HELPER_DIR, f)), join(HELPER_DIR, "helper.ps1")]) {
    const bytes = readFileSync(file);
    assert.ok(bytes.every((b) => b < 128), `${file} must be ASCII (Windows PowerShell 5.1 reads it with the ANSI code page)`);
  }
});

test("helper.ps1 refuses to run outside Windows without a ready line", { skip: findPwsh() ? false : "pwsh not found" }, () => {
  const result = spawnSync(findPwsh(), ["-NoProfile", "-NonInteractive", "-File", join(HELPER_DIR, "helper.ps1")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_GUI_TESTING_TOKEN: "0123456789abcdef0123456789abcdef" },
    input: "",
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /runs only on Windows/);
});
