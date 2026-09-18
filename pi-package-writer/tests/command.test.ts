import assert from "node:assert/strict";
import test from "node:test";
import { format, parseRequest, tokenize } from "../src/command.ts";

test("parses book format, style blend, language, and a quoted premise independently", () => {
  assert.deepEqual(parseRequest('new book "Ash & Snow" --format light-novel --style "emotional, epic" --genre fantasy --language Deutsch --brief "A courier refuses the crown."'), {
    action: "new", unit: "book", value: "Ash & Snow",
    options: { format: "light-novel", style: "emotional, epic", genre: "fantasy", language: "Deutsch", brief: "A courier refuses the crown." },
  });
});

test("new unit titles can be combined with an explicit project", () => {
  assert.equal(parseRequest('new chapter "A Costly Promise" --project ash-snow').options.project, "ash-snow");
  assert.equal(parseRequest("continue ash-snow").value, "ash-snow");
  assert.equal(parseRequest("continue --project ash-snow").options.project, "ash-snow");
  assert.throws(() => parseRequest("continue ash-snow --project other"), /either/);
});

test("beginner start, coaching, and per-task guidance parse without advanced options", () => {
  assert.deepEqual(parseRequest("start"), { action: "start", options: {} });
  assert.deepEqual(parseRequest('start "A first attempt" --brief "A lonely lighthouse" --format roman'), {
    action: "start", value: "A first attempt", options: { brief: "A lonely lighthouse", format: "novel" },
  });
  assert.equal(parseRequest('coach --project ash --target "scenes/scene-0001.md"').options.project, "ash");
  assert.equal(parseRequest('new book "Ash" --guidance beginner').options.guidance, "beginner");
  assert.equal(parseRequest("continue --guidance standard").options.guidance, "standard");
  assert.equal(parseRequest("review --guidance beginner").options.guidance, "beginner");
  for (const input of ["continue --guidance expert", "start --guidance standard", "coach --guidance standard", "start --project ash", "coach ash", "status --guidance beginner"]) {
    assert.throws(() => parseRequest(input), undefined, input);
  }
});

test("preserves Windows paths, apostrophes, and quoted escapes", () => {
  assert.deepEqual(tokenize(String.raw`import --source "C:\Books\first draft.md"`), ["import", "--source", String.raw`C:\Books\first draft.md`]);
  assert.equal(parseRequest('new book Author\'s-draft').value, "Author's-draft");
  assert.deepEqual(tokenize(String.raw`"The \"Other\" Door"`), ['The "Other" Door']);
  assert.deepEqual(tokenize("'The Other Door'"), ["The Other Door"]);
});

test("menu, help, and Roman alias", () => {
  assert.equal(parseRequest("").action, "menu");
  assert.equal(parseRequest("help").action, "help");
  assert.equal(format("roman"), "novel");
});

test("rejects unsupported actions, duplicate flags, unknown flags, and ambiguous text", () => {
  for (const input of ["delete all", "new", "new planet", "list --project foo", "help extra", "status foo bar", "new book A B", "continue --wat yes", "continue --brief", "continue --brief --project a", "new book A --format novel --format manga", "new book A --format movie", 'new book "unclosed', "review --source a.md", "new book A --project a"]) {
    assert.throws(() => parseRequest(input), undefined, input);
  }
});

test("bounds input and rejects control characters", () => {
  assert.throws(() => parseRequest("x".repeat(8193)), /8,192/);
  assert.throws(() => parseRequest('new book "A\u001bB"'), /control/);
  assert.throws(() => parseRequest('new book ""'), /nonempty/);
  assert.throws(() => parseRequest(`continue --brief "${"a".repeat(4001)}"`), /4?000/);
});
