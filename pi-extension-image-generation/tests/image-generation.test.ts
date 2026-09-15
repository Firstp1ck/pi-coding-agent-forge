import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_BASE, decodeImage, generateImage, listModels, MAX_IMAGE_BYTES, parseModels, parseUsage,
  readBoundedJson, reportedCost, validateOptions,
} from "../openrouter.ts";
import { createWorkflow, saveImage, SELECTION_TTL_MS, type WorkflowContext } from "../workflow.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=";
const imagePayload = { data: [{ b64_json: png, media_type: "image/png" }], usage: { prompt_tokens: 5, completion_tokens: 20, cost: 0.04 } };
const model = {
  id: "example/image", name: "Example image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] }, resolution: { type: "enum", values: ["1K"] } },
};
const catalog = { data: [model] };
const mutate = async <T>(_path: string, operation: () => Promise<T>) => operation();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function harness(t: TestContext, options: {
  confirm?: boolean; noKey?: boolean; fetcher?: typeof fetch; now?: () => number;
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-image-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: { url: string; init?: RequestInit }[] = [];
  const dialogs: { title: string; message?: string; options?: string[] }[] = [];
  const ctx: WorkflowContext = {
    cwd, hasUI: true,
    ui: {
      select: async (title, items) => { dialogs.push({ title, options: items }); return items[0]; },
      confirm: async (title, message) => { dialogs.push({ title, message }); return options.confirm ?? true; },
    },
  };
  const fetcher: typeof fetch = options.fetcher ?? (async (url, init) => {
    requests.push({ url: String(url), init });
    return json(init?.method === "POST" ? imagePayload : catalog);
  });
  const workflow = createWorkflow({ mutate, fetcher, getApiKey: () => options.noKey ? undefined : "test-only-key", now: options.now });
  const select = async () => {
    const result = await workflow.select(ctx);
    assert.equal(result.details.status, "selected");
    assert.ok(result.details.selection_id);
    return result.details.selection_id;
  };
  return { cwd, ctx, requests, dialogs, workflow, select };
}

test("catalog filters for text input and image output, sanitizes names and deduplicates IDs", () => {
  const models = parseModels({ data: [model, model,
    { ...model, id: "text/only", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { ...model, id: "image/input-only", architecture: { input_modalities: ["image"], output_modalities: ["image"] } },
    { ...model, id: "invalid\nmodel" },
    { ...model, id: "example/second", name: "Bad\x1b\u202elabel" },
    null,
  ] });
  assert.equal(models.length, 2);
  assert.ok(models.every((m) => !/[\x1b\u202e]/.test(m.name)));
  assert.throws(() => parseModels({}), /invalid image catalog/);
});

test("options must be advertised enum values, never arbitrary passthrough", () => {
  const parsed = parseModels(catalog)[0];
  validateOptions(parsed, { aspect_ratio: "16:9" });
  validateOptions(parsed, {});
  assert.throws(() => validateOptions(parsed, { resolution: "4K" }), /not supported/);
  assert.throws(() => validateOptions({ ...parsed, parameters: {} }, { aspect_ratio: "1:1" }), /not supported/);
});

test("select then confirm generates exactly once with the user's model and saves a raster preview", async (t) => {
  const h = await harness(t);
  const selection_id = await h.select();
  const result = await h.workflow.generate(h.ctx, { selection_id, prompt: "A paper boat", aspect_ratio: "16:9" });
  assert.equal(result.details.status, "generated");
  assert.equal(result.details.model, model.id);
  assert.ok(result.details.path?.startsWith(join(h.cwd, "generated-images")));
  assert.deepEqual(await readFile(result.details.path!), Buffer.from(png, "base64"));
  assert.equal(result.content[1].type, "image");
  assert.equal(result.usage?.cost.total, 0.04);
  assert.match(h.dialogs[1].message!, /A paper boat/);
  assert.match(h.dialogs[1].message!, /may spend API credits/);
  assert.equal(h.requests[0].url, `${API_BASE}/images/models`);
  assert.equal(h.requests[0].init?.headers, undefined);
  assert.equal(h.requests[1].url, `${API_BASE}/images`);
  assert.equal(h.requests[1].init?.redirect, "error");
  assert.deepEqual(JSON.parse(h.requests[1].init?.body as string), { model: model.id, prompt: "A paper boat", n: 1, aspect_ratio: "16:9" });
  assert.equal((h.requests[1].init?.headers as Record<string, string>).Authorization, "Bearer test-only-key");
  assert.ok(!JSON.stringify(result).includes("test-only-key"));
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "Again" }), /fresh user model choice/);
  assert.equal(h.requests.length, 2);
});

test("generation without a picker or with a forged ID never sends a request", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: "fake", prompt: "A boat" }), /fresh user model choice/);
  assert.equal(h.requests.length, 0);
  await h.select();
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: "fake", prompt: "A boat" }), /fresh user model choice/);
  assert.equal(h.requests.length, 1);
});

test("a second picker invalidates the first choice, including when cancelled", async (t) => {
  const h = await harness(t);
  const selection_id = await h.select();
  h.ctx.ui.select = async () => undefined;
  assert.equal((await h.workflow.select(h.ctx)).details.status, "cancelled");
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" }), /fresh user model choice/);
  assert.ok(h.requests.every((r) => r.init?.method !== "POST"));
});

test("confirmation refusal consumes selection and makes no POST", async (t) => {
  const h = await harness(t, { confirm: false });
  const selection_id = await h.select();
  const result = await h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" });
  assert.equal(result.details.status, "cancelled");
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" }), /fresh user model choice/);
  assert.equal(h.requests.length, 1);
});

test("headless operations fail closed before catalog or generation requests", async (t) => {
  const h = await harness(t);
  h.ctx.hasUI = false;
  await assert.rejects(h.workflow.select(h.ctx), /requires a user model choice/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: "fake", prompt: "A boat" }), /requires a user model choice/);
  assert.equal(h.requests.length, 0);
});

test("missing credentials, invalid prompts, and unsupported options fail before POST", async (t) => {
  const h = await harness(t, { noKey: true });
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "A boat" }), /OPENROUTER_API_KEY/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: " " }), /Prompt must/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "Boat\x1b[2J" }), /control or bidirectional/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "A boat", resolution: "4K" }), /not supported/);
  assert.ok(h.requests.every((r) => r.init?.method !== "POST"));
});

test("reset, expiry, and cwd changes invalidate choices", async (t) => {
  let now = 0;
  const h = await harness(t, { now: () => now });
  const first = await h.select();
  h.workflow.reset();
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: first, prompt: "A boat" }), /fresh user model choice/);
  const second = await h.select();
  now += SELECTION_TTL_MS;
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: second, prompt: "A boat" }), /fresh user model choice/);
  const third = await h.select();
  await assert.rejects(h.workflow.generate({ ...h.ctx, cwd: join(h.cwd, "other") }, { selection_id: third, prompt: "A boat" }), /fresh user model choice/);
});

test("unknown dialog answers cannot select an unlisted model", async (t) => {
  const h = await harness(t);
  h.ctx.ui.select = async () => "invented-model";
  await assert.rejects(h.workflow.select(h.ctx), /unknown model/);
});

test("search filters the live catalog; empty matches do not open a dialog", async (t) => {
  const h = await harness(t);
  assert.equal((await h.workflow.select(h.ctx, "EXAMPLE/")).details.model, model.id);
  const count = h.dialogs.length;
  await assert.rejects(h.workflow.select(h.ctx, "no-such-model"), /No text-to-image models/);
  assert.equal(h.dialogs.length, count);
});

test("concurrent image operations are refused and reset aborts the active dialog", async (t) => {
  const h = await harness(t);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  h.ctx.ui.select = async (_title, _options, opts) => {
    started();
    return new Promise((resolve) => opts!.signal!.addEventListener("abort", () => resolve(undefined), { once: true }));
  };
  const pending = h.workflow.select(h.ctx);
  await ready;
  await assert.rejects(h.workflow.select(h.ctx), /already running/);
  h.workflow.reset();
  await assert.rejects(pending, /abort/i);
});

test("aborting during confirmation sends no POST even if the UI returns true", async (t) => {
  const h = await harness(t);
  const selection_id = await h.select();
  const controller = new AbortController();
  h.ctx.ui.confirm = async () => { controller.abort(); return true; };
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" }, controller.signal), /abort/i);
  assert.equal(h.requests.length, 1);
});

test("provider failure is not retried and the consumed selection cannot be reused", async (t) => {
  let posts = 0;
  const h = await harness(t, { fetcher: async (_url, init) => {
    if (init?.method !== "POST") return json(catalog);
    posts++;
    return json({ error: "private raw response" }, 502);
  } });
  const selection_id = await h.select();
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" }), /OpenRouter HTTP 502/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id, prompt: "A boat" }), /fresh user model choice/);
  assert.equal(posts, 1);
});

test("API status errors give actionable hints without exposing raw bodies", async () => {
  for (const [status, hint] of [[401, "OPENROUTER_API_KEY"], [402, "credits"], [429, "Rate limited"]] as const) {
    await assert.rejects(listModels(async () => new Response("private raw response", { status })), (error: Error) => {
      assert.match(error.message, new RegExp(hint));
      assert.ok(!error.message.includes("private raw response"));
      return true;
    });
  }
  await assert.rejects(listModels(async () => { throw new Error("secret request details"); }), /OpenRouter request failed/);
  await assert.rejects(listModels(async () => new Response("not JSON")), /invalid JSON/);
});

test("pre-aborted requests never fetch; in-flight cancellation reaches fetch", async () => {
  const pre = AbortSignal.abort();
  await assert.rejects(listModels(async () => { assert.fail("must not fetch"); }, pre), /cancelled/);
  const controller = new AbortController();
  const pending = listModels(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    controller.abort();
  }), controller.signal);
  await assert.rejects(pending, /cancelled/);
});

test("catalog deadline aborts a hanging fetch without retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = listModels(async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /timed out/);
  assert.equal(calls, 1);
});

test("generation deadline also covers a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = generateImage(parseModels(catalog)[0], "A boat", {}, "test-only-key", undefined, async (_url, init) => {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('{"data":'));
        init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted body")), { once: true });
      },
    }));
  });
  await Promise.resolve();
  t.mock.timers.tick(180_000);
  await assert.rejects(pending, /timed out/);
});

test("bounded JSON reads stop oversized bodies and cancel the reader", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readBoundedJson(response, 10, new AbortController().signal), /download limit/);
  assert.equal(cancelled, true);
});

test("image decoding verifies base64, magic bytes, media type and size", () => {
  assert.equal(decodeImage(imagePayload).mimeType, "image/png");
  assert.equal(decodeImage({ data: [{ b64_json: png }] }).extension, "png");
  for (const data of [[], [{ url: "https://internal.invalid/image" }], [{ b64_json: "!!!!" }],
    [{ b64_json: Buffer.from("<svg></svg>").toString("base64"), media_type: "image/svg+xml" }],
    [{ b64_json: png, media_type: "image/jpeg" }], [imagePayload.data[0], imagePayload.data[0]],
    [{ b64_json: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) }],
  ]) assert.throws(() => decodeImage({ data }));
  const larger = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from(png, "base64").copy(larger);
  assert.equal(decodeImage({ data: [{ b64_json: larger.toString("base64") }] }).bytes.length, larger.length);
});

test("usage excludes malformed counts and records the provider's total cost once", () => {
  assert.equal(parseUsage({}), undefined);
  assert.equal(reportedCost({ usage: { prompt_tokens: 1 } }), undefined);
  assert.equal(reportedCost({ usage: { cost: 0 } }), 0);
  assert.equal(reportedCost(imagePayload), 0.04);
  assert.equal(parseUsage(imagePayload)?.totalTokens, 25);
  assert.equal(parseUsage(imagePayload)?.cost.total, 0.04);
  assert.equal(parseUsage({ usage: { prompt_tokens: -5, completion_tokens: "bad", cost: Infinity } })?.cost.total, 0);
});

test("unique output directories preserve previous images and use the mutation queue", async (t) => {
  const h = await harness(t);
  const calls: string[] = [];
  const queued = async <T>(path: string, operation: () => Promise<T>) => { calls.push(path); return operation(); };
  const first = await saveImage(h.cwd, decodeImage(imagePayload), queued);
  const second = await saveImage(h.cwd, decodeImage(imagePayload), queued);
  assert.notEqual(first, second);
  assert.deepEqual(await readFile(first), Buffer.from(png, "base64"));
  assert.deepEqual(calls, [first, second]);
});

test("failed writes remove only their new directory", async (t) => {
  const h = await harness(t);
  const first = await saveImage(h.cwd, decodeImage(imagePayload), mutate);
  await assert.rejects(saveImage(h.cwd, decodeImage(imagePayload), async () => { throw new Error("disk full"); }), /saving it failed/);
  assert.deepEqual(await readFile(first), Buffer.from(png, "base64"));
  assert.equal((await readdir(join(h.cwd, "generated-images"))).length, 1);
});

test("output paths cannot be redirected through a directory symlink", async (t) => {
  const h = await harness(t);
  const target = await mkdtemp(join(tmpdir(), "pi-image-target-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, join(h.cwd, "generated-images"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(saveImage(h.cwd, decodeImage(imagePayload), mutate), /symbolic link/);
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "A boat" }), /symbolic link/);
  assert.deepEqual(await readdir(target), []);
  assert.equal(h.requests.length, 1);
});

test("an existing output file blocks generation before payment", async (t) => {
  const h = await harness(t);
  await writeFile(join(h.cwd, "generated-images"), "keep");
  await assert.rejects(h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "A boat" }));
  assert.equal(h.requests.length, 1);
  assert.equal(await readFile(join(h.cwd, "generated-images"), "utf8"), "keep");
});

test("large images are saved without an inline preview and missing cost is not reported as free", async (t) => {
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from(png, "base64").copy(bytes);
  const h = await harness(t, { fetcher: async (_url, init) => json(init?.method === "POST"
    ? { data: [{ b64_json: bytes.toString("base64") }], usage: { prompt_tokens: 5 } }
    : catalog),
  });
  const result = await h.workflow.generate(h.ctx, { selection_id: await h.select(), prompt: "A boat" });
  assert.equal(result.details.previewIncluded, false);
  assert.equal(result.content.length, 1);
  assert.equal((await readFile(result.details.path!)).length, bytes.length);
  assert.equal(result.content[0].type, "text");
  assert.match((result.content[0] as { text: string }).text, /Cost was not reported/);
});

test("generation URLs are never fetched as a fallback", async () => {
  let calls = 0;
  await assert.rejects(generateImage(parseModels(catalog)[0], "A boat", {}, "test-only-key", undefined, async () => {
    calls++;
    return json({ data: [{ url: "http://127.0.0.1/private" }] });
  }), /base64/);
  assert.equal(calls, 1);
});
