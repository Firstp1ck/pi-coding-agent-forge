import test from "node:test";
import assert from "node:assert/strict";
import mockWorkbookProvider from "./pi/mock-provider.ts";

function provider() {
  let config;
  mockWorkbookProvider({ registerProvider(_id, value) { config = value; } });
  return { stream: config.streamSimple, model: { ...config.models[0], provider: "workbook-test" } };
}

async function withWorkbookPath(value, run) {
  const previous = process.env.PI_WORKBOOK_TEST_PATH;
  if (value === undefined) delete process.env.PI_WORKBOOK_TEST_PATH;
  else process.env.PI_WORKBOOK_TEST_PATH = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_WORKBOOK_TEST_PATH;
    else process.env.PI_WORKBOOK_TEST_PATH = previous;
  }
}

test("mock provider rejects missing or blank paths before emitting tool calls", async () => {
  const { stream, model } = provider();
  for (const value of [undefined, "", "   "]) {
    await withWorkbookPath(value, async () => {
      const events = [];
      for await (const event of stream(model, { messages: [] })) events.push(event);
      assert.deepEqual(events.map(({ type }) => type), ["start", "error"]);
      assert.match(events.at(-1).error.errorMessage, /PI_WORKBOOK_TEST_PATH must be set/);
      assert.deepEqual(events.at(-1).error.content, []);
    });
  }
});

test("mock provider emits JSON-compatible arguments with the exact configured path", async () => {
  const { stream, model } = provider();
  await withWorkbookPath("/tmp/workbook fixture.xlsx", async () => {
    const result = await stream(model, { messages: [] }).result();
    assert.equal(result.stopReason, "toolUse");
    assert.deepEqual(result.content[0].arguments, { path: "/tmp/workbook fixture.xlsx" });
    assert.deepEqual(JSON.parse(JSON.stringify(result.content[0].arguments)), result.content[0].arguments);
  });
});

test("mock provider can finish after a tool result without constructing new arguments", async () => {
  const { stream, model } = provider();
  await withWorkbookPath(undefined, async () => {
    const result = await stream(model, { messages: [{ role: "toolResult", toolName: "workbook_inspect" }] }).result();
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.content, [{ type: "text", text: "WORKBOOK_MODE_PASS" }]);
  });
});
