/**
 * Quoting for the remote login shell: every argv element survives sh, bash,
 * and fish unchanged (injection attempts included), and the run/helper
 * wrappers deliver argv, cwd, env, and the stdin environment preamble.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assertDestination, assertEnvEntry, assertSafeRemotePath, shellJoin, shellQuote, shScript } from "../../../../src/transport/ssh/quote.ts";
import { helperCommand, remoteCommand } from "../../../../src/transport/ssh/transport.ts";
import { decodeRemote, decodeShellWords } from "./fake-ssh.mjs";

const NASTY = [
  "plain",
  "a b",
  "it's",
  "back\\slash",
  "\\'",
  "a\\\\b",
  "$(touch /tmp/pwned-by-quote-test)",
  "`id`",
  "; rm -rf /",
  "&& echo hi",
  "| cat",
  '"double"',
  "new\nline",
  "tab\there",
  "*",
  "?",
  "~",
  "~root",
  "%self",
  "=echo",
  "-n",
  "--",
  "",
  "{a,b}",
  "!x",
  "$HOME",
  "${PATH}",
  "é ü 日本 ✓",
  "trailing\\",
  "'",
  "''",
  "a'b'c",
];

const SHELLS = ["/bin/sh", "/bin/bash", "/usr/bin/fish", "/bin/dash", "/usr/bin/zsh"].filter((s) => existsSync(s));

function runIn(shell, line, options = {}) {
  return spawnSync(shell, ["-c", line], { encoding: "utf8", ...options });
}

test("shellQuote leaves plain words bare and quotes the rest", () => {
  assert.equal(shellQuote("abc/def.txt"), "abc/def.txt");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(shellQuote("a\\b"), `'a'"\\\\"'b'`);
  assert.equal(shellQuote("=x"), "'=x'");
  assert.throws(() => shellQuote("a\0b"), /NUL/);
});

for (const shell of SHELLS) {
  test(`every argv element reaches ${shell} unchanged (injection cases)`, () => {
    const result = runIn(shell, shellJoin(["printf", "%s\\0", ...NASTY]));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split("\0").slice(0, -1), NASTY);
    assert.equal(existsSync("/tmp/pwned-by-quote-test"), false);
  });

  test(`remoteCommand runs argv in cwd with env under ${shell}`, () => {
    const line = remoteCommand(["/bin/sh", "-c", 'printf "%s\\001%s\\001%s\\001" "$PWD" "$EXTRA" "${DISPLAY-unset}"; printf "%s\\0" "$@"', "sh", ...NASTY], { cwd: "/tmp", env: { EXTRA: "x y'z $(id)" } });
    const result = runIn(shell, line, { env: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } });
    assert.equal(result.status, 0, result.stderr);
    const [pwd, extra, display, rest] = result.stdout.split("\x01");
    assert.equal(pwd, "/tmp");
    assert.equal(extra, "x y'z $(id)");
    assert.equal(display, "unset", "the desktop DISPLAY never reaches remote commands");
    assert.deepEqual(rest.split("\0").slice(0, -1), NASTY);
  });

  test(`helperCommand reads the environment from stdin under env -i (${shell})`, () => {
    const line = helperCommand(["/bin/sh", "-c", 'printf "%s|%s|%s|%s|%s" "$PI_GUI_TESTING_TOKEN" "$B" "${DISPLAY-unset}" "${DBUS_SESSION_BUS_ADDRESS-unset}" "$(cat)"'], ["B", "PI_GUI_TESTING_TOKEN"]);
    assert.equal(line.includes("0123456789abcdef"), false);
    const result = runIn(shell, line, { input: "b $(value)\n0123456789abcdef0123456789abcdef\nprotocol bytes", env: { ...process.env, DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0123456789abcdef0123456789abcdef|b $(value)|unset|unset|protocol bytes");
  });
}

test("an incomplete preamble ends the helper wrapper with exit 97", () => {
  const result = runIn("/bin/sh", helperCommand(["true"], ["A", "B"]), { input: "only-one" });
  assert.equal(result.status, 97);
});

test("remoteCommand rejects argv[0] that env would misread, and bad env entries", () => {
  assert.throws(() => remoteCommand([]), /empty/);
  assert.throws(() => remoteCommand(["A=b", "x"]), /cannot be run/);
  assert.throws(() => remoteCommand(["-x"]), /cannot be run/);
  assert.throws(() => remoteCommand(["true"], { env: { "BAD NAME": "x" } }), /invalid environment variable name/);
  assert.throws(() => remoteCommand(["true"], { env: { A: "line\nbreak" } }), /newline/);
  assert.throws(() => helperCommand(["true"], ["1BAD"]), /invalid/);
});

test("decodeRemote inverts the wrappers (used by the fakes)", () => {
  const run = decodeRemote(remoteCommand(["ls", "-l", "a b"], { cwd: "/w s", env: { K: "v=1" } }));
  assert.deepEqual(run, { kind: "run", argv: ["ls", "-l", "a b"], cwd: "/w s", env: { K: "v=1" } });
  const helper = decodeRemote(helperCommand(["python3", "-I", "/x/helper"], ["A", "B"]));
  assert.equal(helper.kind, "helper");
  assert.deepEqual(helper.argv, ["python3", "-I", "/x/helper"]);
  assert.deepEqual(helper.keys, ["A", "B"]);
  assert.deepEqual(decodeShellWords(shScript("echo", NASTY.slice(0, 10))).slice(4), NASTY.slice(0, 10));
});

test("assertDestination refuses option-like and shell-like hosts", () => {
  assert.equal(assertDestination("raspi5"), "raspi5");
  assert.equal(assertDestination("pi@10.0.0.5"), "pi@10.0.0.5");
  assert.equal(assertDestination("ssh://pi@host:2222"), "ssh://pi@host:2222");
  for (const bad of ["", "-oProxyCommand=x", "host name", "a;b", "a$(x)", "a`b`", "a|b", "a\nb", "a'b", 'a"b', "a\\b"]) {
    assert.throws(() => assertDestination(bad), undefined, bad);
  }
});

test("assertEnvEntry and assertSafeRemotePath", () => {
  assert.doesNotThrow(() => assertEnvEntry("PI_GUI_X", "any value $(x) 'q'"));
  assert.throws(() => assertEnvEntry("X", "a\rb"));
  assert.equal(assertSafeRemotePath("/run/user/1000/pi-gui-testing/s-a"), "/run/user/1000/pi-gui-testing/s-a");
  for (const bad of ["relative", "/a b", "/a/../b", "/a;b", "/$x"]) assert.throws(() => assertSafeRemotePath(bad), undefined, bad);
});
