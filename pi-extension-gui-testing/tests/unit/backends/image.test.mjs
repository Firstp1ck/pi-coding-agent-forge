import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTar, listTar } from "../../../src/backends/docker/tar.ts";
import { baseImageProblem, buildArgs, buildBaseImage, stageBuildContext } from "../../../src/backends/docker/image.ts";
import { PACKAGE_ROOT, baseImageTag, packageVersion } from "../../../src/backends/docker/package.ts";
import { decodePng, isUniform, readPngHeader } from "../../../src/tools/png.ts";
import { encodePng, fakeSpawner, HOST } from "./fakes.mjs";

test("tar writer round-trips files, directories, modes, and long paths, and is readable by tar(1)", async (t) => {
  const long = `${"d".repeat(90)}/${"e".repeat(60)}/file.txt`;
  const archive = createTar([
    { path: "dir", type: "dir", mode: 0o755 },
    { path: "dir/a.txt", type: "file", mode: 0o644, data: Buffer.from("hello") },
    { path: "run", type: "file", mode: 0o755, data: Buffer.alloc(1025, 1) },
    { path: long, type: "file", mode: 0o600, data: Buffer.from("x") },
  ]);
  assert.equal(archive.length % 512, 0);
  const listed = listTar(archive);
  assert.deepEqual(listed.map((e) => [e.path, e.type, e.mode, e.size]), [
    ["dir/", "dir", 0o755, 0],
    ["dir/a.txt", "file", 0o644, 5],
    ["run", "file", 0o755, 1025],
    [long, "file", 0o600, 1],
  ]);
  assert.equal(listed[1].data.toString(), "hello");
  assert.throws(() => createTar([{ path: "../x", type: "file", mode: 0o644 }]), /unsafe/);
  assert.throws(() => createTar([{ path: "/etc/x", type: "file", mode: 0o644 }]), /unsafe/);
  const dir = await mkdtemp(join(tmpdir(), "gui-tar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.tar"), archive);
  const names = execFileSync("tar", ["-tf", join(dir, "a.tar")], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(names, ["dir/", "dir/a.txt", "run", long]);
});

test("the build context holds only package tooling: Dockerfile, helper, helper package, GTK 3 smoke app", async () => {
  const entries = listTar(await stageBuildContext());
  const files = entries.filter((e) => e.type === "file").map((e) => e.path);
  const helperFiles = (await readdir(join(PACKAGE_ROOT, "helpers/linux/pi_gui_helper"))).filter((n) => n.endsWith(".py")).sort().map((n) => `pi_gui_helper/${n}`);
  const smokeFiles = (await readdir(join(PACKAGE_ROOT, "testapps/gtk3-smoke"))).sort().map((n) => `testapps/gtk3-smoke/${n}`);
  assert.deepEqual(files.sort(), ["Dockerfile", ".dockerignore", "helper", ...helperFiles, ...smokeFiles].sort());
  for (const path of files) assert.ok(!/(^|\/)(tests|plans|src|node_modules|gtk4|pyside6|electron|tk)\//.test(path), path);
  assert.ok(!files.some((p) => p.endsWith(".pyc")));
  assert.equal(entries.find((e) => e.path === "helper").mode, 0o755);
  assert.equal(entries.find((e) => e.path === "Dockerfile").mode, 0o644);
  assert.deepEqual(await stageBuildContext(), await stageBuildContext(), "reproducible bytes");
});

test("docker build streams the context to stdin with version and protocol build args; an abort kills it", async () => {
  assert.deepEqual(buildArgs("0.1.0"), ["build", "--force-rm", "--build-arg", "PACKAGE_VERSION=0.1.0", "--build-arg", "PROTOCOL_VERSION=1", "-t", "pi-gui-testing-base:0.1.0", "-"]);
  assert.equal(baseImageTag("2.0.0"), "pi-gui-testing-base:2.0.0");
  assert.equal(packageVersion(), JSON.parse(execFileSync("node", ["-p", `JSON.stringify(require(${JSON.stringify(join(PACKAGE_ROOT, "package.json"))}).version)`], { encoding: "utf8" })));

  const received = [];
  const spawner = fakeSpawner({
    noReady: true,
    onSpawn(child) {
      child.stdin.on("data", (c) => received.push(c));
      child.stdin.removeAllListeners("finish");
      child.stdin.on("finish", () => {
        child.stdout.write("Step 1/9 : FROM debian\nSuccessfully tagged pi-gui-testing-base:0.1.0\n");
        setImmediate(() => child.exit(0));
      });
    },
  });
  const lines = [];
  const result = await buildBaseImage({ spawner, endpoint: { context: "default", host: HOST }, signal: new AbortController().signal, version: "0.1.0", onLine: (l) => lines.push(l) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(spawner.children[0].argv, ["docker", "--host", HOST, ...buildArgs("0.1.0")]);
  const sent = listTar(Buffer.concat(received));
  assert.ok(sent.some((e) => e.path === "Dockerfile"));
  assert.ok(lines.includes("Successfully tagged pi-gui-testing-base:0.1.0"));

  const controller = new AbortController();
  const hanging = fakeSpawner({
    noReady: true,
    onSpawn: (child) => {
      child.stdin.removeAllListeners("finish");
      setImmediate(() => controller.abort());
    },
  });
  const aborted = await buildBaseImage({ spawner: hanging, endpoint: { context: "default", host: HOST }, signal: controller.signal, version: "0.1.0" });
  assert.equal(aborted.exitCode, null);
  assert.deepEqual(hanging.children[0].signals, ["SIGTERM"]);
});

test("base image labels must match package version and protocol", () => {
  const labels = { "pi-gui-testing.base": "true", "pi-gui-testing.version": "0.1.0", "pi-gui-testing.protocol": "1" };
  assert.equal(baseImageProblem({ id: "x", architecture: "amd64", labels }, "0.1.0"), undefined);
  assert.match(baseImageProblem({ id: "x", architecture: "amd64", labels: {} }, "0.1.0"), /pi-gui-testing\.base is missing/);
  assert.match(baseImageProblem({ id: "x", architecture: "amd64", labels: { ...labels, "pi-gui-testing.session": "s" , "pi-gui-testing.version": "9" } }, "0.1.0"), /version is 9/);
});

test("PNG reader: decodes RGB, detects uniform images, rejects garbage", () => {
  const png = encodePng(5, 3, (x, y) => [x * 10, y * 20, 7]);
  const header = readPngHeader(png);
  assert.deepEqual([header.width, header.height, header.bitDepth, header.colorType], [5, 3, 8, 2]);
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.rgb.subarray(0, 6)], [0, 0, 7, 10, 0, 7]);
  assert.equal(isUniform(decoded.rgb), false);
  assert.equal(isUniform(decodePng(encodePng(4, 4, () => [1, 2, 3])).rgb), true);
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
});
