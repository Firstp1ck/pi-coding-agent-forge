/**
 * e2e apps (plan §8 "e2e apps"): S4 GTK 4, PySide6, Electron snapshot → act
 * by ref → screenshot; S5 Tk with coverage none, operated by coordinates;
 * every act action on a text-field fixture; the HANDOFF path; a container UID
 * other than the host's; Electron without `--shm-size`. All through the tools.
 *
 *   npm run test:e2e -- tests/e2e/apps.test.mjs
 *
 * PySide6 and Electron download packages during `setup`; set
 * PI_GUI_E2E_OFFLINE=1 to skip them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { decodePng, isUniform } from "../../src/tools/png.ts";
import { ctx, dockerSkipReason, e2eRuntime, FIXTURES, labelled, networkSkipReason, project, run, TESTAPPS, textOf } from "./harness.mjs";

const skip = dockerSkipReason();
const offline = skip ?? networkSkipReason();
const BUTTON_ROLES = ["button", "push button"];

async function findNode(env, session, context, predicate, timeoutMs = 20_000) {
  const started = Date.now();
  let snap;
  while (Date.now() - started < timeoutMs) {
    snap = await run(env.tools.gui_snapshot, { session, maxNodes: 2000 }, context);
    const node = snap.details.tree.find(predicate);
    if (node) return { node, snap };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`node not found; roles: ${[...new Set(snap?.details.tree.map((n) => n.role))].join(", ")}`);
}

function screenshotPixels(result) {
  const image = result.content.find((c) => c.type === "image");
  return decodePng(Buffer.from(image.data, "base64"));
}

/** S4 flow: launch with the sample's .pi/gui.json → find "Press me" → click by ref → "Pressed" → screenshot → stop with an empty audit. */
async function pressMe(t, app, backend = {}) {
  const env = await e2eRuntime(t, { backend });
  const cwd = join(TESTAPPS, app);
  const context = ctx(cwd);
  const launched = await run(env.tools.gui_launch, {}, context);
  const session = launched.details.session;
  t.diagnostic(textOf(launched));
  try {
    const { node, snap } = await findNode(env, session, context, (n) => BUTTON_ROLES.includes(n.role) && n.name === "Press me");
    assert.equal(snap.details.coverage, "full");
    await run(env.tools.gui_act, { session, action: "click", ref: node.ref }, context);
    const waited = await run(env.tools.gui_wait, { session, for: "text", value: "Pressed", timeoutMs: 10_000 }, context);
    assert.equal(waited.details.matched, true);
    const window = launched.details.windows[0]?.ref;
    const shot = await run(env.tools.gui_screenshot, { session, ...(window ? { window } : {}) }, context);
    assert.equal(isUniform(screenshotPixels(shot).rgb), false);
  } finally {
    const stopped = await run(env.tools.gui_stop, { session }, context);
    assert.match(textOf(stopped), /footprint audit: empty/);
  }
  assert.deepEqual(labelled(session), []);
}

test("S4: GTK 4 sample — snapshot, act by ref, screenshot", { skip, timeout: 10 * 60_000 }, (t) => pressMe(t, "gtk4"));
test("S4: PySide6 sample — setup installs into /deps, then snapshot, act by ref, screenshot", { skip: offline, timeout: 30 * 60_000 }, (t) => pressMe(t, "pyside6"));
test("S4: Electron sample — copy mode, npm install, --shm-size 512m, snapshot, act by ref, screenshot", { skip: offline, timeout: 30 * 60_000 }, (t) => pressMe(t, "electron"));

test("Electron without --shm-size (risk check, plan §10/§12): outcome recorded", { skip: offline, timeout: 30 * 60_000 }, async (t) => {
  try {
    await pressMe(t, "electron", { shm: "never" });
    t.diagnostic("Electron works with Docker's default 64 MB /dev/shm in this run");
  } catch (error) {
    t.diagnostic(`Electron without --shm-size failed: ${error.message.split("\n")[0]}`);
  }
  assert.deepEqual(labelled().filter((id) => id), [], "nothing left either way");
});

test("S5: Tk reports coverage none and is operated by screenshot coordinates", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const context = ctx(join(TESTAPPS, "tk"));
  const launched = await run(env.tools.gui_launch, {}, context);
  const session = launched.details.session;
  try {
    const snap = await run(env.tools.gui_snapshot, { session }, context);
    assert.equal(snap.details.coverage, "none");
    assert.match(textOf(snap), /no accessibility tree: use gui_screenshot/);
    await run(env.tools.gui_wait, { session, for: "idle", timeoutMs: 5_000 }, context);
    const window = launched.details.windows[0].ref;
    const before = await run(env.tools.gui_screenshot, { session, window }, context);
    const { rgb, width, height } = screenshotPixels(before);
    // The Tk button is the lowest region that differs from the background colour.
    const bg = rgb.subarray(0, 3);
    const rows = [];
    for (let y = Math.floor(height / 2); y < height; y++) {
      for (let x = 0; x < width; x += 4) {
        const o = (y * width + x) * 3;
        if (rgb[o] !== bg[0] || rgb[o + 1] !== bg[1] || rgb[o + 2] !== bg[2]) {
          rows.push(y);
          break;
        }
      }
    }
    const y = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
    await run(env.tools.gui_act, { session, action: "click", x: Math.round(width / 2), y }, context);
    await run(env.tools.gui_wait, { session, for: "idle", timeoutMs: 5_000 }, context);
    const after = await run(env.tools.gui_screenshot, { session, window }, context);
    assert.notEqual(after.details.sha256, before.details.sha256, "the click changed the window");
  } finally {
    await run(env.tools.gui_stop, { session }, context);
  }
});

test("every act action on a text field fixture: type, key, set_value, double_click, right_click, scroll", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  const context = ctx(join(FIXTURES, "fields"));
  const launched = await run(env.tools.gui_launch, { cmd: "python3", args: ["app.py"] }, context);
  const session = launched.details.session;
  const status = (text) => run(env.tools.gui_wait, { session, for: "text", value: text, timeoutMs: 8_000 }, context).then((r) => r.details.matched);
  const entry = async () => (await findNode(env, session, context, (n) => n.name === "Name" && /text|entry/.test(n.role))).node;
  try {
    await run(env.tools.gui_act, { session, action: "type", ref: (await entry()).ref, text: "Ada" }, context);
    assert.equal((await entry()).value, "Ada");
    await run(env.tools.gui_act, { session, action: "key", ref: (await entry()).ref, text: "ctrl+a BackSpace" }, context);
    assert.ok(!(await entry()).value, "cleared by keys");
    await run(env.tools.gui_act, { session, action: "type", ref: (await entry()).ref, text: "Bob" }, context);
    await run(env.tools.gui_act, { session, action: "key", ref: (await entry()).ref, text: "Return" }, context);
    assert.equal(await status("Hello Bob"), true, "Return activated the entry");
    await run(env.tools.gui_act, { session, action: "set_value", ref: (await entry()).ref, text: "Zed" }, context);
    assert.equal((await entry()).value, "Zed");
    const target = async () => (await findNode(env, session, context, (n) => n.name === "Click target")).node;
    await run(env.tools.gui_act, { session, action: "double_click", ref: (await target()).ref }, context);
    assert.equal(await status("double"), true);
    await run(env.tools.gui_act, { session, action: "right_click", ref: (await target()).ref }, context);
    assert.equal(await status("right"), true);
    const row = (await findNode(env, session, context, (n) => n.name === "Row 1")).node;
    await run(env.tools.gui_act, { session, action: "scroll", ref: row.ref, text: "down 5" }, context);
    assert.equal(await status("scrolled"), true);
  } finally {
    await run(env.tools.gui_stop, { session }, context);
  }
});

test("HANDOFF: an app that exits without a window fails launch with the hand-off message and leaves nothing", { skip, timeout: 5 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t);
  await assert.rejects(run(env.tools.gui_launch, { cmd: "python3", args: ["-c", "pass"] }, ctx(join(FIXTURES, "fields"))), /app handed off to another instance.*the session was stopped/s);
  assert.deepEqual(env.runtime.list(), []);
});

test("a container UID/GID other than the host's (4242) resolves through the generated passwd and can run the smoke app", { skip, timeout: 10 * 60_000 }, async (t) => {
  const env = await e2eRuntime(t, { backend: { uid: 4242, gid: 4343 } });
  const cwd = await project(env.root, { "README.md": "readable by any uid\n" });
  const context = ctx(cwd);
  const launched = await run(env.tools.gui_launch, { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] }, context);
  const session = launched.details.session;
  try {
    const live = env.runtime.get(session);
    const id = await live.session.request("exec", { cmd: 'test "$(id -u):$(id -g):$(id -un)" = 4242:4343:app && test "$HOME" = /home/app && touch "$HOME/x" /tmp/y /scratch/z /deps/w "$XDG_RUNTIME_DIR/v" && cat /workspace/README.md', cwd: "/workspace", env: {}, timeoutMs: 30_000 });
    assert.equal(id.exitCode, 0, live.logs.tail(20).join("\n"));
    const { node } = await findNode(env, session, context, (n) => BUTTON_ROLES.includes(n.role) && n.name === "Press me");
    await run(env.tools.gui_act, { session, action: "click", ref: node.ref }, context);
    assert.equal((await run(env.tools.gui_wait, { session, for: "text", value: "Pressed", timeoutMs: 8_000 }, context)).details.matched, true);
  } finally {
    await run(env.tools.gui_stop, { session }, context);
  }
});
