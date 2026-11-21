// Protocol tests of the Windows helper core: the real C# framing, dispatcher,
// handlers, and imaging, compiled at C# 5 and run by PowerShell 7 with the
// scripted fake platform (FakePlatform.cs) in place of Win32. Every result is
// checked with the client's own validation (src/backends/response.ts).
//
// Needs pwsh (PI_GUI_PWSH, PATH, or ~/.local/share/pi-tools/powershell-*);
// skipped otherwise. RECORD_WINDOWS_FIXTURES=1 rewrites fixtures/*.json.
//
//   node --experimental-strip-types --test tests/helper-windows/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeTreeDump } from "../../src/backends/response.ts";
import { Helper, HelperError, HERE, LOCAL_TEMP, baseEnv, checkResponse, COMPILE_WAIT_MS, decodePng, fakePattern, findPwsh } from "./client.mjs";

const PWSH = findPwsh();
const skip = PWSH ? false : "pwsh not found (set PI_GUI_PWSH)";
const RECORD = process.env.RECORD_WINDOWS_FIXTURES === "1";

function record(name, method, response) {
  if (!RECORD) return;
  const dir = join(HERE, "fixtures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ method, response }, null, 2)}\n`);
}

async function started(extra = {}, options = {}) {
  const { env, token } = baseEnv(extra);
  const helper = Helper.start({ env, token, ...options });
  await helper.waitReady();
  return helper;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (e) => e instanceof HelperError && e.code === code, `expected ${code}`);
}

test("ready line, noise, hello, and the session flow validate against the client", { skip }, async () => {
  const helper = await started({ PI_GUI_ALLOW_EXEC: "1" });
  try {
    helper.sendRaw("this is noise before any request");
    helper.sendRaw(`${helper.token} {not json`);
    helper.sendRaw(`${helper.token} {"method":"ping"}`); // no id: dropped without a response

    const helloEnvelope = await helper.send("hello", { protocol: 2, packageVersion: "0.2.0" }).promise;
    record("hello", "hello", helloEnvelope);
    const hello = checkResponse("hello", helloEnvelope);
    assert.equal(hello.os, "windows");
    assert.equal(hello.protocol, 2);
    assert.equal(hello.arch, "x64");
    assert.ok(hello.platform.startsWith("Windows "));
    assert.ok(hello.capabilities.includes("exec") && hello.capabilities.includes("a11y-uia") && hello.capabilities.includes("desktop-private"));
    assert.ok(!hello.capabilities.includes("deps"), "no deps capability");

    const launchEnvelope = await helper.send("launch", { cmd: "electron", args: ["."], env: { FOO: "1" }, cwd: "C:\\work\\project" }).promise;
    record("launch", "launch", launchEnvelope);
    const launched = checkResponse("launch", launchEnvelope);
    assert.equal(launched.windows.length, 1);
    assert.match(launched.windows[0].ref, /^win:0x[0-9a-f]+$/);
    await helper.expectStderr(/launch electron args=\.\|--force-renderer-accessibility\|--disable-gpu/);
    assert.ok(helper.events.some((e) => e.event === "log" && e.source === "app" && e.data === "fake app started\n"));

    const windowsEnvelope = await helper.send("windows").promise;
    record("windows", "windows", windowsEnvelope);
    assert.deepEqual(checkResponse("windows", windowsEnvelope).windows, launched.windows);

    const snapEnvelope = await helper.send("snapshot", { maxNodes: 4 }).promise;
    record("snapshot", "snapshot", snapEnvelope);
    const snap = checkResponse("snapshot", snapEnvelope);
    assert.equal(snap.coverage, "full");
    assert.equal(snap.tree.length, 4);
    assert.equal(snap.truncated, true);
    assert.equal(snap.tree[1].parent, `${snap.snapshotId}:0`);

    const fullEnvelope = await helper.send("snapshotFull", { snapshotId: snap.snapshotId }).promise;
    record("snapshotFull", "snapshotFull", fullEnvelope);
    const tree = decodeTreeDump(checkResponse("snapshotFull", fullEnvelope).tree_gz_base64);
    assert.equal(tree.length, 6);
    const button = tree.find((n) => n.name === "Press me");
    assert.equal(button.role, "push button");
    await expectCode(helper.call("snapshotFull", { snapshotId: "s99" }), "STALE_REF");

    const actEnvelope = await helper.send("act", { ref: button.ref, action: "click" }).promise;
    record("act", "act", actEnvelope);
    assert.deepEqual(checkResponse("act", actEnvelope), { ok: true });
    const waitEnvelope = await helper.send("wait", { for: "text", value: "Pressed", timeoutMs: 2000 }).promise;
    record("wait", "wait", waitEnvelope);
    assert.equal(checkResponse("wait", waitEnvelope).matched, true);
    const miss = await helper.call("wait", { for: "window", value: "No such title", timeoutMs: 300 });
    assert.equal(miss.matched, false);
    assert.ok(miss.elapsedMs >= 250);
    assert.equal((await helper.call("wait", { for: "ref", value: launched.windows[0].ref, timeoutMs: 100 })).matched, true);
    assert.equal((await helper.call("wait", { for: "idle", timeoutMs: 3000 })).matched, true);

    const text = tree.find((n) => n.role === "text");
    await helper.call("act", { ref: text.ref, action: "set_value", text: "hello" });
    await helper.expectStderr(/set_value hello/);
    await expectCode(helper.call("act", { ref: button.ref, action: "set_value", text: "x" }), "BAD_REQUEST");
    await helper.call("act", { ref: text.ref, action: "key", text: "ctrl+a BackSpace" });
    await helper.expectStderr(/keys 0x11:0x41 :0x08 to win:0x/);
    await expectCode(helper.call("act", { ref: text.ref, action: "key", text: "ctrl+nosuchkey" }), "BAD_REQUEST");
    await helper.call("act", { action: "type", text: "typed" });
    await helper.expectStderr(/type 5 chars to active/);

    // A new snapshot makes old refs stale.
    await helper.call("snapshot", { maxNodes: 10 });
    await expectCode(helper.call("act", { ref: button.ref, action: "click" }), "STALE_REF");
    await expectCode(helper.call("act", { ref: "garbage", action: "click" }), "BAD_REQUEST");
    await expectCode(helper.call("act", { ref: "win:0xdead", action: "click" }), "NOT_FOUND");
    await expectCode(helper.call("act", { action: "click" }), "BAD_REQUEST");
    await expectCode(helper.call("act", { action: "fly" }), "BAD_REQUEST");
    await helper.call("act", { ref: launched.windows[0].ref, action: "scroll", text: "up 3" });
    await helper.expectStderr(/activate win:0x[0-9a-f]+/);
    await helper.expectStderr(/scroll up 3 at 42,40/);

    const execEnvelope = await helper.send("exec", { cmd: "echo setting up", timeoutMs: 5000 }).promise;
    record("exec", "exec", execEnvelope);
    assert.equal(checkResponse("exec", execEnvelope).exitCode, 0);
    assert.ok(helper.events.some((e) => e.source === "setup" && e.stream === "stdout" && e.data === "setting up\n"));
    const ntstatus = await helper.call("exec", { cmd: "ntstatus" });
    assert.equal(ntstatus.exitCode, 1000);
    assert.ok(helper.events.some((e) => e.source === "setup" && /0xC0000005\); reported as 1000/.test(e.data)));
    assert.equal((await helper.call("exec", { cmd: "exit 7" })).exitCode, 7);
    await expectCode(helper.call("exec", { cmd: "sleep 5000", timeoutMs: 200 }), "TIMEOUT");
    const before = helper.events.length;
    await helper.call("exec", { cmd: "big 200000" });
    const big = helper.events.slice(before).filter((e) => e.source === "setup");
    assert.ok(big.length >= 4, "big output split into several events");
    assert.ok(big.every((e) => Buffer.byteLength(e.data) <= 64 * 1024));
    assert.equal(big.map((e) => e.data).join("").length, 200000);

    for (const method of ["depsPack", "depsRead", "depsReceive", "depsWrite", "depsUnpack", "depsDiscard"]) {
      const envelope = await helper.send(method, {}).promise;
      if (method === "depsPack") record("error-deps-unsupported", method, envelope);
      assert.throws(() => checkResponse(method, envelope), (e) => e.code === "BAD_REQUEST" && /no dependency cache/.test(e.message));
    }
    const unknown = await helper.send("teleport", {}).promise;
    record("error-unknown-method", "teleport", unknown);
    assert.equal(unknown.error.code, "BAD_REQUEST");
    await expectCode(helper.call("launch", {}), "BAD_REQUEST");
    await expectCode(helper.call("launch", { cmd: "x", args: "not-a-list" }), "BAD_REQUEST");
    await expectCode(helper.call("launch", { cmd: "x", env: { A: 1 } }), "BAD_REQUEST");

    const stopEnvelope = await helper.send("stop").promise;
    record("stop", "stop", stopEnvelope);
    assert.deepEqual(checkResponse("stop", stopEnvelope), { ok: true, leftovers: [] });
    assert.equal(await helper.waitExit(), 0);
    await helper.expectStderr(/tearing down: stop/);
    // Requests dropped without an id never got an answer; every answered id was a request.
    assert.ok(helper.responses.every((r) => typeof r.id === "number"));
  } finally {
    helper.kill();
  }
});

test("screenshots: PNG, pixel hash, scale, window capture, allBlack, coordinates", { skip }, async () => {
  const helper = await started({ FAKE_SCREEN: "160x90" });
  try {
    const launched = await helper.call("launch", { cmd: "fake-app" });
    const shotEnvelope = await helper.send("screenshot", { maxEdge: 80 }).promise;
    record("screenshot-scaled", "screenshot", shotEnvelope);
    const shot = checkResponse("screenshot", shotEnvelope);
    assert.equal(shot.target, "screen");
    assert.deepEqual(shot.origin, { x: 0, y: 0 });
    assert.equal(shot.width, 160);
    assert.equal(shot.height, 90);
    assert.equal(shot.scale, 0.5);
    assert.equal(shot.allBlack, undefined);
    assert.equal(shot.sha256, createHash("sha256").update(fakePattern(160, 90)).digest("hex"));
    const scaled = decodePng(Buffer.from(shot.png_base64, "base64"));
    assert.equal(scaled.width, 80);
    assert.equal(scaled.height, 45);

    const windowRef = launched.windows[0].ref;
    const winEnvelope = await helper.send("screenshot", { window: windowRef }).promise;
    record("screenshot-window", "screenshot", winEnvelope);
    const win = checkResponse("screenshot", winEnvelope);
    assert.equal(win.target, windowRef);
    assert.deepEqual(win.origin, { x: 10, y: 20 });
    assert.equal(win.scale, 1);
    const decoded = decodePng(Buffer.from(win.png_base64, "base64"));
    assert.ok(decoded.rgb.equals(fakePattern(64, 40)), "lossless pixels");

    // Coordinates are in the latest capture's unscaled space; older captures are stale.
    await helper.call("act", { captureId: win.captureId, x: 15, y: 25, action: "click" });
    await helper.expectStderr(/pointer click 25,45/);
    await expectCode(helper.call("act", { captureId: shot.captureId, x: 1, y: 1, action: "click" }), "STALE_REF");
    await expectCode(helper.call("act", { captureId: win.captureId, x: 64, y: 0, action: "click" }), "BAD_REQUEST");
    await expectCode(helper.call("act", { captureId: win.captureId, x: 1, y: 1, action: "set_value" }), "BAD_REQUEST");
    await helper.call("act", { captureId: win.captureId, x: 2, y: 3, action: "type", text: "abc" });
    await helper.expectStderr(/pointer click 12,23/);
    await expectCode(helper.call("screenshot", { window: "win:0xbeef" }), "NOT_FOUND");

    const snap = await helper.call("snapshot", { maxNodes: 50 });
    const label = snap.tree.find((n) => n.role === "label");
    const crop = await helper.call("screenshot", { window: label.ref });
    assert.deepEqual(crop.origin, { x: 20, y: 52 });
    assert.equal(crop.width, 30);
    assert.equal(crop.height, 6);

    await helper.call("launch", { cmd: "black-app" });
    const windows = await helper.call("windows");
    const black = windows.windows.find((w) => w.title === "Black App");
    const blackEnvelope = await helper.send("screenshot", { window: black.ref }).promise;
    record("screenshot-allblack", "screenshot", blackEnvelope);
    assert.equal(checkResponse("screenshot", blackEnvelope).allBlack, true);
  } finally {
    helper.kill();
  }
});

test("launch outcomes: handoff, crash with output tail, missing command and cwd", { skip }, async () => {
  const helper = await started();
  try {
    const handoff = await helper.send("launch", { cmd: "handoff" }).promise;
    record("error-handoff", "launch", handoff);
    assert.equal(handoff.error.code, "HANDOFF");
    const crash = await helper.send("launch", { cmd: "crash" }).promise;
    assert.equal(crash.error.code, "INTERNAL");
    assert.match(crash.error.message, /exited with code 3[\s\S]*boom: fatal error/);
    const missing = await helper.send("launch", { cmd: "missing" }).promise;
    record("error-not-found", "launch", missing);
    assert.equal(missing.error.code, "NOT_FOUND");
    await expectCode(helper.call("launch", { cmd: "fake-app", cwd: "C:\\missing" }), "NOT_FOUND");
    await expectCode(helper.call("exec", { cmd: "exit 0" }), "BAD_REQUEST"); // exec not allowed in this session
  } finally {
    helper.kill();
  }
});

test("ping and cancel bypass the queue; cancel ends running and queued requests", { skip }, async () => {
  const helper = await started({ PI_GUI_ALLOW_EXEC: "1" });
  try {
    const order = [];
    const slow = helper.send("exec", { cmd: "sleep 4000" });
    const queued = helper.send("windows");
    slow.promise.then(() => order.push("exec"));
    queued.promise.then(() => order.push("windows"));
    const ping = await helper.call("ping");
    order.push("ping");
    assert.deepEqual(ping, { ok: true });
    assert.deepEqual(order, ["ping"], "ping answered while exec runs");

    const cancelQueued = await helper.send("cancel", { targetId: queued.id }).promise;
    record("cancel", "cancel", cancelQueued);
    assert.deepEqual(checkResponse("cancel", cancelQueued), { ok: true });
    const queuedResponse = await queued.promise;
    record("error-cancelled", "windows", queuedResponse);
    assert.equal(queuedResponse.error.code, "CANCELLED");

    const cancelRunning = await helper.call("cancel", { targetId: slow.id });
    assert.deepEqual(cancelRunning, { ok: true });
    const slowResponse = await slow.promise;
    assert.equal(slowResponse.error.code, "CANCELLED");
    assert.deepEqual(await helper.call("cancel", { targetId: 999 }), { ok: true }, "unknown target answers ok");
    await expectCode(helper.call("cancel", { targetId: "x" }), "BAD_REQUEST");
    // The session keeps working after cancellations.
    assert.deepEqual((await helper.call("windows")).windows, []);
  } finally {
    helper.kill();
  }
});

test("protocol mismatch answers PROTOCOL_MISMATCH and exits", { skip }, async () => {
  const helper = await started();
  try {
    const envelope = await helper.send("hello", { protocol: 1, packageVersion: "0.2.0" }).promise;
    record("error-protocol-mismatch", "hello", envelope);
    assert.equal(envelope.error.code, "PROTOCOL_MISMATCH");
    assert.equal(await helper.waitExit(), 0);
    await helper.expectStderr(/tearing down: protocol mismatch/);
  } finally {
    helper.kill();
  }
});

test("results stay within the client's limits: windows, inline tree bytes, full tree", { skip }, async () => {
  const helper = await started();
  try {
    // 1200 windows: the client refuses a list over 1000 as a whole, so the helper caps it.
    const launched = checkResponse("launch", await helper.send("launch", { cmd: "many-windows", args: [], cwd: "C:\\work" }).promise);
    assert.equal(launched.windows.length, 1000);
    assert.equal(checkResponse("windows", await helper.send("windows").promise).windows.length, 1000);

    // 1100 nodes of 64 Ki characters (about 72 MB of JSON): the inline tree is cut by bytes, not only by maxNodes.
    await helper.call("launch", { cmd: "big-tree", args: [], cwd: "C:\\work" });
    const envelope = await helper.send("snapshot", { maxNodes: 2000 }).promise;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 40 * 1024 * 1024, "inline snapshot stays far below the 64 MiB line limit");
    const snap = checkResponse("snapshot", envelope);
    assert.equal(snap.truncated, true);
    assert.ok(snap.tree.length > 100 && snap.tree.length < 1106, `inline nodes ${snap.tree.length}`);
    const full = decodeTreeDump(checkResponse("snapshotFull", await helper.send("snapshotFull", { snapshotId: snap.snapshotId }).promise).tree_gz_base64);
    assert.equal(full.length, 1106, "the full tree (6 window nodes + 1100) fits the walk budget");
  } finally {
    helper.kill();
  }
});

test("results stay within the client's limits: long window titles, a walk beyond its budget, an incompressible screenshot (review WG3, WG4, WG6)", { skip }, async () => {
  const helper = await started({ FAKE_SCREEN: "3600x3600", FAKE_SCREEN_NOISE: "1" });
  try {
    // 350 windows with 64 Ki CJK titles are about 68 MB of JSON: the list is cut by encoded bytes, and says so.
    const launchEnvelope = await helper.send("launch", { cmd: "wide-titles", args: [], cwd: "C:\\work" }).promise;
    assert.ok(Buffer.byteLength(JSON.stringify(launchEnvelope)) < 20 * 1024 * 1024, "launch result far below the 64 MiB line limit");
    const launched = checkResponse("launch", launchEnvelope);
    assert.equal(launched.truncated, true);
    assert.ok(launched.windows.length > 0 && launched.windows.length < 350, `windows ${launched.windows.length}`);
    const listEnvelope = await helper.send("windows").promise;
    assert.ok(Buffer.byteLength(JSON.stringify(listEnvelope)) < 20 * 1024 * 1024);
    assert.equal(checkResponse("windows", listEnvelope).truncated, true);

    // A walk stopped by its budget is a truncated snapshot, even when every walked node fits inline.
    await helper.call("launch", { cmd: "wide-tree", args: [], cwd: "C:\\work" });
    const snap = checkResponse("snapshot", await helper.send("snapshot", { maxNodes: 50_000 }).promise);
    assert.equal(snap.tree.length, 20_000);
    assert.equal(snap.truncated, true);
    await helper.expectStderr(/exceeds the walk budget/);

    // 3600 x 3600 high-entropy pixels: about 52 million base64 characters at full size, above pngBase64Chars.
    const shot = checkResponse("screenshot", await helper.send("screenshot", { maxEdge: 3600 }).promise);
    assert.ok(shot.png_base64.length <= 48 * 1024 * 1024, `${shot.png_base64.length} characters`);
    assert.ok(shot.scale < 1, `scale ${shot.scale}`);
    assert.equal(shot.width, 3600);
    await helper.expectStderr(/exceeds 50331648 base64 characters; downscaling/);
  } finally {
    helper.kill();
  }
});

test("a fatal platform error answers INTERNAL, then the helper ends the session", { skip }, async () => {
  const helper = await started();
  try {
    const envelope = await helper.send("launch", { cmd: "unhealthy", args: [], cwd: "C:\\work" }).promise;
    assert.equal(envelope.error.code, "INTERNAL");
    assert.match(envelope.error.message, /still stuck in a hung app/);
    assert.equal(await helper.waitExit(), 0);
    await helper.expectStderr(/tearing down: session unhealthy: launch was refused/);
    await helper.expectStderr(/fake: teardown/);
  } finally {
    helper.kill();
  }
});

test("stdin EOF tears down and exits 0", { skip }, async () => {
  const helper = await started();
  try {
    helper.closeStdin();
    assert.equal(await helper.waitExit(), 0);
    await helper.expectStderr(/tearing down: stdin EOF/);
    await helper.expectStderr(/fake: teardown/);
  } finally {
    helper.kill();
  }
});

test("heartbeat timeout tears down without client messages, and pings keep it alive", { skip }, async () => {
  const helper = await started({ PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS: "1500" });
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 600));
      await helper.call("ping");
    }
    assert.equal(helper.exitCode, undefined, "alive while pinged");
    const quietSince = Date.now();
    assert.equal(await helper.waitExit(10000), 0);
    assert.ok(Date.now() - quietSince >= 1000);
    await helper.expectStderr(/tearing down: heartbeat timeout/);
    await helper.expectStderr(/fake: teardown/);
  } finally {
    helper.kill();
  }
});

test("stop reports leftovers with ok false", { skip }, async () => {
  const helper = await started({ FAKE_LEFTOVER: "1" });
  try {
    const envelope = await helper.send("stop").promise;
    record("stop-leftovers", "stop", envelope);
    const result = checkResponse("stop", envelope);
    assert.equal(result.ok, false);
    assert.deepEqual(result.leftovers, [{ kind: "process", id: "4242:132000000000000000", detail: "fake survivor" }]);
    assert.equal(await helper.waitExit(), 0);
  } finally {
    helper.kill();
  }
});

test("stdin env preamble carries the contract without argv values", { skip }, async () => {
  const { env, token } = baseEnv();
  const values = { PI_GUI_TESTING_TOKEN: token, PI_GUI_WORKSPACE: "D:\\guest\\work", PI_GUI_RUNTIME_DIR: "D:\\guest\\pi-gui-testing-s1", PI_GUI_HELPER_MODE: "guest" };
  for (const name of Object.keys(values)) delete env[name];
  const names = Object.keys(values).sort();
  const helper = Helper.start({ env, token, stdinEnv: names.join(",") });
  try {
    for (const name of names) helper.sendRaw(values[name]);
    await helper.waitReady();
    await helper.expectStderr(/fake: start mode=guest/);
    assert.ok(!helper.child.spawnargs.some((a) => a.includes(token)), "token never in argv");
    assert.equal((await helper.call("hello", { protocol: 2, packageVersion: "0.2.0" })).os, "windows");
  } finally {
    helper.kill();
  }
});

async function startupFailure(extra, { stdinEnv, lines = [], expectCode: code = 1 } = {}) {
  const { env, token } = baseEnv(extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const helper = Helper.start({ env, token, stdinEnv });
  helper.readyPromise.catch(() => {});
  for (const line of lines) helper.sendRaw(line);
  helper.closeStdin();
  const exit = await helper.waitExit(COMPILE_WAIT_MS);
  assert.equal(helper.ready, false, "no ready line");
  assert.equal(exit, code, helper.stderr);
  return helper.stderr;
}

test("startup fails closed: bad token, contract errors, platform start failure", { skip }, async () => {
  assert.match(await startupFailure({ PI_GUI_TESTING_TOKEN: "short" }, { expectCode: 2 }), /32 hex characters/);
  assert.match(await startupFailure({ PI_GUI_WORKSPACE: undefined }), /PI_GUI_WORKSPACE is required/);
  assert.match(await startupFailure({ PI_GUI_RUNTIME_DIR: "C:\\elsewhere\\pi-gui-testing-x" }), /directly under/);
  assert.match(await startupFailure({ PI_GUI_WIN_DESKTOP: "interactive" }), /only allowed in guest mode/);
  assert.match(await startupFailure({ FAKE_START_FAIL: "1" }), /startup failed: fake desktop creation failed/);
  assert.match(await startupFailure({}, { stdinEnv: "PI_GUI_NOPE" , expectCode: 2 }), /unknown variable/);
  assert.match(await startupFailure({}, { stdinEnv: "PI_GUI_HELPER_MODE", expectCode: 2 }), /stdin ended before/);
});

test("probe prints one JSON line without the protocol", { skip }, async () => {
  const { env, token } = baseEnv();
  const helper = Helper.start({ env, token, args: ["-Probe", "desktop"] });
  helper.readyPromise.catch(() => {});
  assert.equal(await helper.waitExit(COMPILE_WAIT_MS), 0);
  assert.deepEqual(JSON.parse(helper.diagnostics[0]), { probe: "desktop", ok: true });
});

test("LOCAL_TEMP fixture constant matches the fake factory default", () => {
  assert.equal(LOCAL_TEMP, "C:\\Users\\tester\\AppData\\Local\\Temp");
});
