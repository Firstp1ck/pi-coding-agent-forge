import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore, DEFAULT_SETTINGS, validateSettings, type ImageSettings } from "../settings.ts";
import { resolveImageAuth } from "../auth.ts";
import { checkConnection } from "../openrouter.ts";
import { createSetupCommand } from "../setup.ts";
import { createWorkflow } from "../workflow.ts";
import { createGenerateImageCommand } from "../command.ts";

const mutate = async <T>(_path: string, operation: () => Promise<T>) => operation();
const model = {
  id: "example/image", name: "Example image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] }, resolution: { type: "enum", values: ["1K", "2K"] } },
};
const catalog = { data: [model, { ...model, id: "example/other", name: "Other image", supported_parameters: {} }] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=";
const signal = () => new AbortController().signal;
const automatic: ImageSettings = { ...DEFAULT_SETTINGS, defaultModel: model.id, selectionBehavior: "default", aspectRatio: "16:9", resolution: "2K", preview: "paths", outputDirectory: "art" };

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-image-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const store = createSettingsStore(join(root, "agent"), ".pi", mutate);
  const notices: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const choices: (string | undefined)[] = [];
  const prompts: string[] = [];
  const inputs: (string | undefined)[] = [];
  const lifecycle = new AbortController();
  let saved = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(String(url).endsWith("/key") ? { data: { label: "NEVER-DISPLAY-THIS", limit_remaining: 1 } }
      : init?.method === "POST" ? { data: [{ b64_json: png }], usage: { cost: 0.03 } } : catalog);
  };
  const ctx = {
    cwd, hasUI: true, signal: undefined, isIdle: () => true, isProjectTrusted: () => true,
    ui: {
      select: async (title: string, options: string[]) => {
        prompts.push(title);
        const choice = choices.shift();
        if (choice !== undefined) assert.ok(options.includes(choice), `Choice '${choice}' not in ${options.join(", ")}`);
        return choice;
      },
      confirm: async (_title: string, message: string) => { prompts.push(message); return true; },
      input: async () => inputs.shift(),
      notify: (message: string) => { notices.push(message); },
    },
  };
  const setup = createSetupCommand({ store, fetcher, getSignal: () => lifecycle.signal, onSaved: () => { saved++; },
    resolveAuth: async () => ({ apiKey: "test-only-key", source: "OPENROUTER_API_KEY" }),
  });
  return { root, cwd, store, ctx, choices, inputs, notices, requests, prompts, lifecycle, setup, fetcher, saved: () => saved };
}

test("settings default safely, persist globally, override as a complete trusted project profile, and reset", async (t) => {
  const h = await harness(t);
  let snapshot = await h.store.load(h.cwd, true);
  assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS);
  assert.equal(snapshot.source, "built-in defaults");
  await h.store.save(snapshot, "global", automatic, true, signal());
  snapshot = await h.store.load(h.cwd, true);
  assert.deepEqual(snapshot.settings, automatic);
  assert.equal(snapshot.source, "global");
  await h.store.save(snapshot, "project", { ...DEFAULT_SETTINGS, preview: "paths" }, true, signal());
  snapshot = await h.store.load(h.cwd, true);
  assert.equal(snapshot.source, "project");
  assert.equal(snapshot.settings.defaultModel, null);
  assert.deepEqual((await h.store.load(h.cwd, false)).settings, automatic);
  await h.store.save(snapshot, "project", null, true, signal());
  snapshot = await h.store.load(h.cwd, true);
  assert.equal(snapshot.source, "global");
  await h.store.save(snapshot, "global", null, true, signal());
  assert.deepEqual((await h.store.load(h.cwd, true)).settings, DEFAULT_SETTINGS);
});

test("settings reject secrets, unknown fields, invalid types, and model-less defaults", () => {
  for (const settings of [
    { ...DEFAULT_SETTINGS, apiKey: "private" }, { ...DEFAULT_SETTINGS, authentication: ["environment"] },
    { ...DEFAULT_SETTINGS, preview: "bad" }, { ...DEFAULT_SETTINGS, selectionBehavior: "default" },
    { ...DEFAULT_SETTINGS, aspectRatio: "1:1" }, { ...DEFAULT_SETTINGS, outputDirectory: "~/.images" },
    { ...DEFAULT_SETTINGS, outputDirectory: "bad\x1bpath" }, { ...DEFAULT_SETTINGS, defaultModel: "bad\nmodel" },
  ]) assert.throws(() => validateSettings(settings));
});

test("untrusted project settings are never read or written", async (t) => {
  const h = await harness(t);
  const snapshot = await h.store.load(h.cwd, false);
  await mkdir(join(h.cwd, ".pi"));
  await writeFile(snapshot.projectPath, "malformed secret-bearing data");
  assert.deepEqual((await h.store.load(h.cwd, false)).settings, DEFAULT_SETTINGS);
  await assert.rejects(h.store.load(h.cwd, true), /invalid JSON/);
  await assert.rejects(h.store.save(snapshot, "project", automatic, false, signal()), /Trust this project/);
  assert.equal(await readFile(snapshot.projectPath, "utf8"), "malformed secret-bearing data");
});

test("concurrent edits and cancellation do not overwrite saved settings", async (t) => {
  const h = await harness(t);
  const before = await h.store.load(h.cwd, true);
  await h.store.save(before, "global", automatic, true, signal());
  await assert.rejects(h.store.save(before, "global", { ...DEFAULT_SETTINGS }, true, signal()), /changed while setup/);
  const current = await h.store.load(h.cwd, true);
  await assert.rejects(h.store.save(current, "global", null, true, AbortSignal.abort()), /abort/i);
  assert.deepEqual((await h.store.load(h.cwd, true)).settings, automatic);
  assert.deepEqual(await readdir(join(h.root, "agent")), ["image-generation.json"]);
});

test("config reads reject oversized files and symlinked directories", async (t) => {
  const h = await harness(t);
  const snapshot = await h.store.load(h.cwd, true);
  await mkdir(join(h.root, "agent"));
  await writeFile(snapshot.globalPath, "x".repeat(17 * 1024));
  await assert.rejects(h.store.load(h.cwd, true), /16 KiB/);
  await writeFile(snapshot.globalPath, '{"version":1,"settings":null}');
  await symlink(join(h.root, "agent"), join(h.cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(h.store.load(h.cwd, true), /symbolic link/);
});

test("environment credentials take precedence; Pi fallback requires opt-in", async () => {
  let calls = 0;
  const ctx = { modelRegistry: { getProviderAuth: async () => {
    calls++;
    return { auth: { apiKey: "pi-key", baseUrl: "https://openrouter.ai/api/v1" }, source: "private-path" };
  } } };
  assert.equal((await resolveImageAuth(ctx, { ...DEFAULT_SETTINGS }, signal(), () => " env-key ")).apiKey, "env-key");
  assert.equal((await resolveImageAuth(ctx, { ...DEFAULT_SETTINGS }, signal(), () => undefined)).source, "not configured");
  assert.equal(calls, 0);
  const fallback = await resolveImageAuth(ctx, { ...DEFAULT_SETTINGS, authentication: "environment-or-pi" }, signal(), () => undefined);
  assert.deepEqual(fallback, { apiKey: "pi-key", source: "Pi OpenRouter credentials" });
  assert.equal(calls, 1);
});

test("Pi auth errors and custom endpoints do not expose secrets", async () => {
  for (const getProviderAuth of [
    async () => { throw new Error("private-key-leak"); },
    async () => ({ auth: { apiKey: "private-key-leak", baseUrl: "https://proxy.invalid" } }),
  ]) {
    await assert.rejects(resolveImageAuth({ modelRegistry: { getProviderAuth } }, { ...DEFAULT_SETTINGS, authentication: "environment-or-pi" }, signal(), () => undefined), (error: Error) => {
      assert.ok(!error.message.includes("private-key-leak"));
      return true;
    });
  }
});

test("Pi credential resolution is bounded and cancellable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = { modelRegistry: { getProviderAuth: async () => new Promise<never>(() => {}) } };
  const pending = resolveImageAuth(ctx, { ...DEFAULT_SETTINGS, authentication: "environment-or-pi" }, signal(), () => undefined);
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /Could not resolve/);
  await assert.rejects(resolveImageAuth(ctx, { ...DEFAULT_SETTINGS }, AbortSignal.abort(), () => "unused"), /abort/i);
});

test("connection check verifies key and refreshes models without generation or returning key metadata", async (t) => {
  const h = await harness(t);
  assert.equal(await checkConnection("test-only-key", h.fetcher), 2);
  assert.ok(h.requests[0].url.endsWith("/key"));
  assert.ok(h.requests[1].url.endsWith("/images/models"));
  assert.ok(h.requests.every((request) => request.init?.method !== "POST"));
  assert.equal(h.requests[1].init?.headers, undefined);
  await assert.rejects(checkConnection("test-only-key", async () => Response.json({ error: "private" })), /invalid authentication/);
});

test("setup edits every recommended preference, checks credentials and saves one profile", async (t) => {
  const h = await harness(t);
  h.choices.push("Global", "OpenRouter authentication", "Environment key, otherwise Pi credentials", "Default image model", "Example image | example/image",
    "Model selection behavior", "Use saved default for /generate-image", "Default aspect ratio", "16:9", "Default resolution", "2K",
    "Output directory", "Preview privacy", "File paths only", "Check connection, no image generated", "Show current configuration", "Back", "Save settings");
  h.inputs.push("art");
  await h.setup("", h.ctx);
  assert.equal(h.saved(), 1);
  assert.deepEqual((await h.store.load(h.cwd, true)).settings, { ...automatic, authentication: "environment-or-pi" });
  assert.ok(h.notices.some((notice) => notice.includes("authentication verified")));
  assert.ok(!JSON.stringify(h.notices).includes("test-only-key"));
  assert.ok(!JSON.stringify(h.prompts).includes("NEVER-DISPLAY-THIS"));
  assert.ok(h.requests.every((request) => request.init?.method !== "POST"));
});

test("changing default model clears ratio and resolution rather than substituting values", async (t) => {
  const h = await harness(t);
  await h.store.save(await h.store.load(h.cwd, true), "global", automatic, true, signal());
  h.choices.push("Global", "Default image model", "Other image | example/other", "Save settings");
  await h.setup("", h.ctx);
  const settings = (await h.store.load(h.cwd, true)).settings;
  assert.equal(settings.defaultModel, "example/other");
  assert.equal(settings.aspectRatio, null);
  assert.equal(settings.resolution, null);
});

test("discarding edits and declining save leave config unchanged", async (t) => {
  const h = await harness(t);
  h.choices.push("Global", "Preview privacy", "File paths only", "Save settings", "Discard and close");
  h.ctx.ui.confirm = async () => false;
  await h.setup("", h.ctx);
  assert.equal(h.saved(), 0);
  assert.equal((await h.store.load(h.cwd, true)).globalRaw, null);
  assert.equal(h.requests.length, 0);
});

test("project reset restores global profile without deleting global preferences", async (t) => {
  const h = await harness(t);
  await h.store.save(await h.store.load(h.cwd, true), "global", automatic, true, signal());
  await h.store.save(await h.store.load(h.cwd, true), "project", { ...DEFAULT_SETTINGS }, true, signal());
  h.choices.push("This project", "Reset this scope");
  await h.setup("", h.ctx);
  assert.equal(h.saved(), 1);
  assert.deepEqual((await h.store.load(h.cwd, true)).settings, automatic);
});

test("global editing does not copy an overriding project profile", async (t) => {
  const h = await harness(t);
  await h.store.save(await h.store.load(h.cwd, true), "global", automatic, true, signal());
  await h.store.save(await h.store.load(h.cwd, true), "project", { ...DEFAULT_SETTINGS }, true, signal());
  h.choices.push("Global", "Save settings");
  await h.setup("", h.ctx);
  const snapshot = await h.store.load(h.cwd, true);
  assert.deepEqual(snapshot.globalSettings, automatic);
  assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS);
  assert.ok(h.prompts.some((prompt) => prompt.includes("project profile still overrides")));
});

test("setup rejects headless/busy calls and aborts without saving on lifecycle changes", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.setup("", { ...h.ctx, hasUI: false }), /requires a TUI/);
  await h.setup("", { ...h.ctx, isIdle: () => false });
  assert.equal(h.prompts.length, 0);
  h.ctx.ui.select = async () => { h.lifecycle.abort(); return "Global"; };
  await h.setup("", h.ctx);
  assert.equal(h.saved(), 0);
  assert.equal((await h.store.load(h.cwd, true)).globalRaw, null);
});

test("untrusted setup offers global scope only, and no model default means automatic mode is refused", async (t) => {
  const h = await harness(t);
  h.choices.push("Global", "Model selection behavior", "Use saved default for /generate-image", "Discard and close");
  const select = h.ctx.ui.select;
  h.ctx.ui.select = async (title, options) => {
    if (title.startsWith("Where")) assert.ok(!options.includes("This project"));
    return select(title, options);
  };
  await h.setup("", { ...h.ctx, isProjectTrusted: () => false });
  assert.ok(h.notices.some((notice) => notice.includes("Choose a default image model first")));
  assert.equal(h.saved(), 0);
});

test("saved defaults drive direct generation, final confirmation remains, and paths-only omits all image bytes", async (t) => {
  const h = await harness(t);
  await h.store.save(await h.store.load(h.cwd, true), "global", automatic, true, signal());
  const workflow = createWorkflow({ mutate, fetcher: h.fetcher, getApiKey: () => "test-only-key",
    getSettings: async (ctx) => (await h.store.load(ctx.cwd, true)).settings,
  });
  let result: unknown;
  const command = createGenerateImageCommand({ workflow, getSignal: signal, publish: (_prompt, generated) => { result = generated; } });
  await command('"create an image of a cat"', h.ctx);
  assert.equal(h.choices.length, 0);
  assert.ok(h.prompts.some((prompt) => prompt.includes("Paths-only mode")));
  const post = h.requests.find((request) => request.init?.method === "POST")!;
  assert.deepEqual(JSON.parse(post.init?.body as string), { model: model.id, prompt: "create an image of a cat", n: 1, aspect_ratio: "16:9", resolution: "2K" });
  const generated = result as { details: { path: string; previewIncluded: boolean }; content: { type: string }[] };
  assert.equal(generated.details.previewIncluded, false);
  assert.ok(generated.content.every((block) => block.type === "text"));
  assert.ok(!JSON.stringify(result).includes(png));
  assert.ok(generated.details.path.startsWith(join(h.cwd, "art")));
  assert.deepEqual(await readFile(generated.details.path), Buffer.from(png, "base64"));
});

test("explicit picker still asks even in default mode; other models do not inherit incompatible options", async (t) => {
  const h = await harness(t);
  const workflow = createWorkflow({ mutate, fetcher: h.fetcher, getApiKey: () => "test-only-key", getSettings: async () => automatic });
  h.choices.push("Other image | example/other");
  const selected = await workflow.select(h.ctx);
  const result = await workflow.generate(h.ctx, { selection_id: selected.details.selection_id!, prompt: "A cat" });
  assert.equal(result.details.model, "example/other");
  assert.deepEqual(JSON.parse(h.requests.find((request) => request.init?.method === "POST")!.init?.body as string), { model: "example/other", prompt: "A cat", n: 1 });
});

test("ask mode puts saved default first but does not silently select it", async (t) => {
  const h = await harness(t);
  const workflow = createWorkflow({ mutate, fetcher: h.fetcher, getSettings: async () => ({ ...automatic, selectionBehavior: "ask", defaultModel: "example/other" }) });
  h.ctx.ui.select = async (_title, options) => {
    assert.equal(options[0], "Other image | example/other [saved default]");
    return undefined;
  };
  assert.equal((await workflow.selectForGeneration(h.ctx)).details.status, "cancelled");
  assert.ok(h.requests.every((request) => request.init?.method !== "POST"));
});

test("unavailable defaults and stale options fail without fallback or generation", async (t) => {
  const h = await harness(t);
  let settings: ImageSettings = { ...automatic, defaultModel: "missing/model" };
  const workflow = createWorkflow({ mutate, fetcher: h.fetcher, getApiKey: () => "test-only-key", getSettings: async () => settings });
  await assert.rejects(workflow.selectForGeneration(h.ctx), /saved image model is unavailable/);
  settings = { ...automatic, resolution: "4K" };
  const selected = await workflow.selectForGeneration(h.ctx);
  await assert.rejects(workflow.generate(h.ctx, { selection_id: selected.details.selection_id!, prompt: "cat" }), /not supported/);
  assert.ok(h.requests.every((request) => request.init?.method !== "POST"));
});
