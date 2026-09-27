import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const scale of [1, 2]) test(`dialog and composer geometry at ${scale * 100}% scaling`, { timeout: 60_000 }, async (t) => {
  const qmake = spawnSync("qmake6", ["-query", "QT_INSTALL_BINS"], { encoding: "utf8", timeout: 5_000 });
  if (qmake.error?.code === "ENOENT") return t.skip("Qt 6 qmake6 unavailable");
  assert.equal(qmake.status, 0, qmake.stderr);
  const runner = path.join(qmake.stdout.trim(), "qmltestrunner");
  const probe = spawnSync(runner, ["-help"], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, encoding: "utf8", timeout: 5_000 });
  if (probe.error?.code === "ENOENT") return t.skip("qmltestrunner unavailable");
  assert.equal(probe.status, 0, probe.stderr);
  const directory = await mkdtemp(path.join(os.tmpdir(), "qt-webui-dialog-geometry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const section of ["components", "dialogs"]) {
    await mkdir(path.join(directory, section));
    for (const name of await readdir(new URL(`../qml/${section}/`, import.meta.url))) {
      if (!name.endsWith(".qml")) continue;
      let source = await readFile(new URL(`../qml/${section}/${name}`, import.meta.url), "utf8");
      if (name === "AppDialog.qml") source = source.replace("id: dialog", "id: dialog\n    property alias testBody: bodyViewport\n    property alias testActions: actionArea");
      if (name === "PickerDialog.qml" || name === "ExtensionDialog.qml") source = source.replace("id: dialog", "id: dialog\n    property alias testOptions: optionList");
      await writeFile(path.join(directory, section, name), source);
    }
  }
  await writeFile(path.join(directory, "Theme.qml"), await readFile(new URL("../qml/Theme.qml", import.meta.url), "utf8"));
  await writeFile(path.join(directory, "tst_geometry.qml"), await readFile(new URL("fixtures/dialog-geometry-checks.qml", import.meta.url), "utf8"));
  const result = spawnSync(runner, ["-input", directory, "-o", "-,txt"], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software", QT_FORCE_STDERR_LOGGING: "1", QT_SCALE_FACTOR: String(scale) },
    encoding: "utf8", timeout: 50_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /TypeError:|ReferenceError:|Cannot assign|FAIL!/, output);
  t.diagnostic(result.stdout.trim());
});
