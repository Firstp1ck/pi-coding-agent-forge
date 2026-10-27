import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLine,
  DiagnosticBuffer,
  encodeRequest,
  FramingError,
  generateToken,
  LineDecoder,
  readyLine,
} from "../../../src/framing/codec.ts";
import { READY_PREFIX, TOKEN_HEX_LENGTH } from "../../../src/protocol.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("generateToken returns distinct 32-hex tokens", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, new RegExp(`^[0-9a-f]{${TOKEN_HEX_LENGTH}}$`));
  assert.notEqual(a, b);
});

test("encodeRequest produces one token-prefixed line", () => {
  const line = encodeRequest(TOKEN, { id: 3, method: "launch", params: { cmd: "a\nb", args: [], env: {}, cwd: "/w" } });
  assert.ok(line.startsWith(`${TOKEN} {`));
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1, "embedded newline must be escaped");
  assert.deepEqual(JSON.parse(line.slice(TOKEN.length + 1)).params.cmd, "a\nb");
});

test("LineDecoder joins chunks split anywhere, strips CR, and keeps partial lines", () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push("hel"), []);
  assert.deepEqual(d.push("lo\r"), []);
  assert.deepEqual(d.push("\nwor"), ["hello"]);
  assert.deepEqual(d.push("ld\nx\r\ny"), ["world", "x"]);
  assert.equal(d.flush(), "y");
  assert.equal(d.flush(), undefined);
});

test("LineDecoder decodes a UTF-8 character split across chunks", () => {
  const bytes = Buffer.from("é\n", "utf8");
  const d = new LineDecoder();
  assert.deepEqual(d.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(d.push(bytes.subarray(1)), ["é"]);
});

test("LineDecoder fails on an oversize line, also when it arrives in pieces, and stays failed", () => {
  const d = new LineDecoder(8);
  assert.deepEqual(d.push("12345678\n"), ["12345678"]);
  assert.throws(() => d.push("123456789\n"), FramingError);
  assert.throws(() => d.push("ok\n"), FramingError);

  const e = new LineDecoder(8);
  e.push("12345");
  assert.throws(() => e.push("67890"), /exceeds 8 bytes/);
});

test("classifyLine separates ready, protocol, and diagnostic lines", () => {
  assert.deepEqual(classifyLine(TOKEN, `${READY_PREFIX} ${TOKEN}`), { type: "ready" });
  assert.equal(readyLine(TOKEN), `${READY_PREFIX} ${TOKEN}`);
  assert.deepEqual(classifyLine(TOKEN, "Welcome to host!"), { type: "diagnostic", line: "Welcome to host!" });
  assert.deepEqual(classifyLine(TOKEN, `${READY_PREFIX} ffff`), { type: "diagnostic", line: `${READY_PREFIX} ffff` });
  const msg = classifyLine(TOKEN, `${TOKEN} {"id":1,"ok":true,"result":{"ok":true}}`);
  assert.equal(msg.type, "message");
  assert.deepEqual(msg.message, { id: 1, ok: true, result: { ok: true } });
  const log = classifyLine(TOKEN, `${TOKEN} {"event":"log","stream":"stderr","source":"app","data":"x"}`);
  assert.equal(log.type, "message");
});

test("classifyLine rejects broken token-prefixed lines", () => {
  for (const bad of [
    `${TOKEN} not json`,
    `${TOKEN} []`,
    `${TOKEN} {"id":"1","ok":true,"result":1}`,
    `${TOKEN} {"id":1,"ok":true}`,
    `${TOKEN} {"id":1,"ok":false,"error":"x"}`,
    `${TOKEN} {"id":1,"ok":"yes"}`,
    `${TOKEN} {"event":"log","stream":"stdout","source":"other","data":"x"}`,
    `${TOKEN} {"event":"progress"}`,
  ]) {
    assert.throws(() => classifyLine(TOKEN, bad), FramingError, bad);
  }
});

test("DiagnosticBuffer is bounded in lines and line length", () => {
  const b = new DiagnosticBuffer(3, 5);
  for (const l of ["a", "b", "c", "dddddddddd"]) b.add(l);
  assert.deepEqual(b.lines(), ["b", "c", "ddddd…"]);
  assert.match(b.tail(2), /c\n  ddddd…$/);
  assert.equal(new DiagnosticBuffer().tail(), "");
});
