import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerateImageCommand, parseCommandPrompt } from "../command.ts";
import { createWorkflow, type WorkflowResult } from "../workflow.ts";

const selected: WorkflowResult = { content: [], details: { status: "selected", selection_id: "user-choice" } };
const generated: WorkflowResult = { content: [{ type: "text", text: "Saved cat.png" }], details: { status: "generated", path: "cat.png" } };
const cancelled: WorkflowResult = { content: [], details: { status: "cancelled" } };

function harness() {
  const lifecycle = new AbortController();
  const calls: string[] = [];
  const notices: { message: string; type?: string }[] = [];
  const published: { prompt: string; result: WorkflowResult }[] = [];
  const ctx = {
    hasUI: true, cwd: process.cwd(), isIdle: () => true, signal: undefined,
    ui: {
      select: async () => undefined,
      confirm: async () => true,
      notify: (message: string, type?: "info" | "warning" | "error") => { notices.push({ message, type }); },
    },
  };
  const workflow: Parameters<typeof createGenerateImageCommand>[0]["workflow"] = {
    select: async (_ctx, query, signal) => {
      assert.equal(query, "");
      assert.ok(signal);
      calls.push("select");
      return selected;
    },
    generate: async (_ctx, input, signal) => {
      assert.deepEqual(input, { selection_id: "user-choice", prompt: "create an image of a cat" });
      assert.ok(signal);
      calls.push("generate");
      return generated;
    },
  };
  const handler = createGenerateImageCommand({ workflow, getSignal: () => lifecycle.signal,
    publish: (prompt, result) => { published.push({ prompt, result }); },
  });
  return { handler, ctx, workflow, lifecycle, calls, notices, published };
}

test("command accepts quoted or bare prompts and preserves internal text", () => {
  for (const input of ['"create an image of a cat"', "'create an image of a cat'", "  create an image of a cat  "]) {
    assert.equal(parseCommandPrompt(input), "create an image of a cat");
  }
  assert.equal(parseCommandPrompt('"a cat with a sign reading "hello""'), 'a cat with a sign reading "hello"');
  assert.equal(parseCommandPrompt('"cat\\dog"'), "cat\\dog");
  assert.equal(parseCommandPrompt("a cat's portrait"), "a cat's portrait");
  assert.equal(parseCommandPrompt('"cat\non a chair"'), "cat\non a chair");
});

test("invalid command arguments fail before workflow execution", async () => {
  for (const args of ["", "   ", '"', '"cat', "'cat\"", '""', "'   '", "x".repeat(8001), "cat\x1b[2J"]) {
    assert.throws(() => parseCommandPrompt(args));
    const h = harness();
    await h.handler(args, h.ctx);
    assert.equal(h.calls.length, 0);
    assert.equal(h.published.length, 0);
    assert.equal(h.notices[0].type, "error");
  }
});

test("command passes the exact prompt and user choice to generation and publishes once", async () => {
  const h = harness();
  await h.handler('"create an image of a cat"', h.ctx);
  assert.deepEqual(h.calls, ["select", "generate"]);
  assert.deepEqual(h.published, [{ prompt: "create an image of a cat", result: generated }]);
  assert.equal(h.notices.length, 0);
});

test("picker cancellation stops before generation", async () => {
  const h = harness();
  h.workflow.select = async () => cancelled;
  await h.handler("create an image of a cat", h.ctx);
  assert.equal(h.calls.length, 0);
  assert.equal(h.published.length, 0);
  assert.match(h.notices[0].message, /cancelled/);
});

test("confirmation cancellation stops without publishing a success", async () => {
  const h = harness();
  h.workflow.generate = async () => cancelled;
  await h.handler("create an image of a cat", h.ctx);
  assert.deepEqual(h.calls, ["select"]);
  assert.equal(h.published.length, 0);
  assert.match(h.notices[0].message, /cancelled/);
});

test("missing selection and request failures are reported without retry", async () => {
  const h = harness();
  h.workflow.select = async () => ({ content: [], details: { status: "selected" } });
  await h.handler("create an image of a cat", h.ctx);
  assert.match(h.notices[0].message, /No image model/);
  h.workflow.select = async () => selected;
  let attempts = 0;
  h.workflow.generate = async () => { attempts++; throw new Error("OpenRouter HTTP 402. Check credits."); };
  await h.handler("create an image of a cat", h.ctx);
  assert.equal(attempts, 1);
  assert.match(h.notices[1].message, /402/);
  assert.equal(h.published.length, 0);
});

test("command requires an idle interactive context", async () => {
  const h = harness();
  await assert.rejects(h.handler("cat", { ...h.ctx, hasUI: false }), /requires a TUI or RPC/);
  await h.handler("cat", { ...h.ctx, isIdle: () => false });
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices[0].type, "warning");
});

test("overlapping invocations are refused and the guard clears afterward", async () => {
  const h = harness();
  let finish!: (value: WorkflowResult) => void;
  h.workflow.select = async () => new Promise((resolve) => { finish = resolve; });
  const first = h.handler("create an image of a cat", h.ctx);
  await h.handler("cat", h.ctx);
  assert.equal(h.notices[0].type, "warning");
  finish(selected);
  await first;
  assert.equal(h.published.length, 1);
  h.workflow.select = async () => selected;
  await h.handler("create an image of a cat", h.ctx);
  assert.equal(h.published.length, 2);
});

test("lifecycle cancellation between selection and generation stops the command", async () => {
  const h = harness();
  h.workflow.select = async () => { h.lifecycle.abort(); return selected; };
  await h.handler("create an image of a cat", h.ctx);
  assert.equal(h.calls.length, 0);
  assert.equal(h.published.length, 0);
  assert.equal(h.notices.length, 0);
});

test("late saved results and errors are not published after session shutdown", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.workflow.generate = async () => {
      h.lifecycle.abort();
      if (fail) throw new Error("late error");
      return generated;
    };
    await h.handler("create an image of a cat", h.ctx);
    assert.equal(h.published.length, 0);
    assert.equal(h.notices.length, 0);
  }
});

test("direct command runs the real workflow with mock network and saves the image", async (t) => {
  const h = harness();
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-command-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=";
  const requests: RequestInit[] = [];
  const workflow = createWorkflow({
    mutate: async (_path, operation) => operation(),
    getApiKey: () => "test-only-key",
    fetcher: async (_url, init) => {
      requests.push(init!);
      return Response.json(init?.method === "POST" ? { data: [{ b64_json: png }] } : { data: [{
        id: "example/cat", name: "Cat image model", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      }] });
    },
  });
  const handler = createGenerateImageCommand({ workflow, getSignal: () => h.lifecycle.signal,
    publish: (prompt, result) => h.published.push({ prompt, result }),
  });
  await handler('"create an image of a cat"', { ...h.ctx, cwd,
    ui: { ...h.ctx.ui, select: async (_title, options) => options[0], confirm: async (_title, message) => {
      assert.match(message, /create an image of a cat/);
      return true;
    } },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body as string), { model: "example/cat", prompt: "create an image of a cat", n: 1 });
  assert.equal(h.published.length, 1);
  assert.deepEqual(await readFile(h.published[0].result.details.path!), Buffer.from(png, "base64"));
});
