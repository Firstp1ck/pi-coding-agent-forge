import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NATURAL_CONVERSATION_FEATURE_ID } from "../lib/server/conversation-mode.mjs";

const serviceNames = [
  "conversationVoicesData", "setConversationVoice", "naturalConversationVoiceProviderStatus",
  "naturalConversationUnavailableResponse", "handleNaturalConversationSttTranscribe", "handleNaturalConversationTtsSpeech",
];
const credentialEnvNames = ["OPENAI_API_KEY", "GROQ_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "XDG_DATA_HOME"];
const localRequest = { local: true };
const remoteRequest = { local: false };
const audioBase64 = Buffer.from("test audio").toString("base64");
const audioLimit = 24 * 1024 * 1024;

function voiceEnvEntries() {
  return Object.entries(process.env).filter(([key]) => key.startsWith("PI_VOICE_") || credentialEnvNames.includes(key));
}

function replaceVoiceEnv(entries) {
  for (const [key] of voiceEnvEntries()) delete process.env[key];
  for (const [key, value] of entries) process.env[key] = value;
}

function httpError(statusCode, message) {
  return (error) => {
    assert.equal(error.statusCode, statusCode);
    if (typeof message === "string") assert.equal(error.message, message);
    else if (message) assert.match(error.message, message);
    return true;
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json" } });
}

test("C2 conversation voice service", { timeout: 20_000 }, async (t) => {
  const savedEnv = voiceEnvEntries();
  const savedFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(tmpdir(), "webui-conversation-voice-"));
  t.after(async () => {
    globalThis.fetch = savedFetch;
    replaceVoiceEnv(savedEnv);
    await rm(root, { recursive: true, force: true });
  });
  replaceVoiceEnv([["PI_VOICE_PROVIDER_TIMEOUT_MS", "1"]]);
  let importFetchCalls = 0;
  globalThis.fetch = () => { importFetchCalls++; throw new Error("Unexpected import-time fetch"); };
  // A fresh instance captures the clamped timeout independently of other tests.
  const voiceModule = await import("../lib/server/conversation-voice.mjs?c2-contract");
  const { createConversationVoiceService, VOICE_AUDIO_JSON_BODY_LIMIT_BYTES } = voiceModule;
  assert.equal(importFetchCalls, 0);
  let fixtureIndex = 0;

  async function run(name, fn) {
    await t.test(name, { timeout: 5_000 }, async (subtest) => {
      const directory = path.join(root, String(fixtureIndex++));
      await mkdir(directory);
      const configPath = path.join(directory, "voice.json");
      const dataHome = path.join(directory, "data");
      replaceVoiceEnv([
        ["PI_VOICE_CONFIG_PATH", configPath], ["XDG_DATA_HOME", dataHome],
        ["PI_VOICE_PROVIDER_TIMEOUT_MS", "999999"],
      ]);
      const calls = { fetch: [], feature: [], rpc: [], snapshot: [], format: [], truncate: [] };
      let fetchResponse = () => { throw new Error("Unexpected provider dispatch"); };
      globalThis.fetch = async (...args) => {
        calls.fetch.push(args);
        return fetchResponse(...args);
      };
      const feature = { available: true, commands: ["voice", "talk"], unavailableReason: "Companion unavailable" };
      const response = { success: true, data: { accepted: true } };
      let rpcResponse = async () => response;
      const tab = { id: "requested-tab", rpc: { async send(...args) {
        calls.rpc.push(args);
        return rpcResponse(...args);
      } } };
      const mode = { featureId: NATURAL_CONVERSATION_FEATURE_ID, enabled: true, available: true, uiState: "listening" };
      const service = createConversationVoiceService({
        async naturalConversationFeatureData(target) { calls.feature.push(target); return feature; },
        naturalConversationModeSnapshot(target, patch = {}) { calls.snapshot.push([target, patch]); return { ...mode, ...patch }; },
        isLocalRequest: (request) => request.local === true,
        makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
        formatBytes(bytes) { calls.format.push(bytes); return `${bytes} bytes`; },
        truncateStatusText(value, limit) { calls.truncate.push([value, limit]); return String(value).slice(0, limit); },
      });
      await fn({
        service, calls, feature, response, tab, mode, directory, configPath, dataHome, subtest,
        setFetch: (fn) => { fetchResponse = fn; },
        setRpc: (fn) => { rpcResponse = fn; },
      });
    });
  }

  await run("exports the exact contract and construction calls no dependencies", async ({ calls }) => {
    assert.deepEqual(Object.keys(voiceModule).sort(), ["VOICE_AUDIO_JSON_BODY_LIMIT_BYTES", "createConversationVoiceService"]);
    assert.equal(VOICE_AUDIO_JSON_BODY_LIMIT_BYTES, Math.ceil(audioLimit * 1.4) + 1024 * 1024);
    const fail = () => { throw new Error("Unexpected factory dependency call"); };
    const service = createConversationVoiceService({
      naturalConversationFeatureData: fail, naturalConversationModeSnapshot: fail,
      isLocalRequest: fail, makeHttpError: fail, formatBytes: fail, truncateStatusText: fail,
    });
    assert.deepEqual(Object.keys(service).sort(), [...serviceNames].sort());
    assert.ok(Object.values(calls).every((entries) => entries.length === 0));
  });

  await run("catalog survives absent or malformed config and keeps its built-in order", async ({ service, configPath }) => {
    const initial = await service.conversationVoicesData();
    assert.deepEqual(initial, {
      voices: [
        { id: "en_US-lessac-medium", sizeMb: 63, note: "natural US English", downloaded: false, current: false },
        { id: "en_GB-alba-medium", sizeMb: 63, note: "natural British English", downloaded: false, current: false },
        { id: "de_DE-thorsten-medium", sizeMb: 63, note: "natural German", downloaded: false, current: false },
        { id: "de_DE-thorsten-high", sizeMb: 110, note: "German, best quality", downloaded: false, current: false },
      ], current: null, ttsProvider: null,
    });
    await writeFile(configPath, "invalid json");
    assert.deepEqual(await service.conversationVoicesData(), initial);
    await writeFile(configPath, JSON.stringify({ native: { tts: { provider: "other", modelPath: "/en_US-lessac-medium.onnx" } } }));
    assert.deepEqual(await service.conversationVoicesData(), { ...initial, ttsProvider: "other" });
  });

  await run("catalog reads all three Piper directories, requires sidecars and prefers the first copy", async ({ service, dataHome, configPath }) => {
    const dirs = [path.join(dataHome, "piper"), path.join(dataHome, "piper", "voices"), path.join(dataHome, "piper-voices")];
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    const models = [
      [dirs[0], "en_US-lessac-medium", 1], [dirs[1], "custom", 2 * 1024 * 1024],
      [dirs[2], "third", 1], [dirs[2], "custom", 1],
    ];
    for (const [dir, id, bytes] of models) {
      await writeFile(path.join(dir, `${id}.onnx`), Buffer.alloc(bytes));
      await writeFile(path.join(dir, `${id}.onnx.json`), "{}");
    }
    await writeFile(path.join(dirs[0], "incomplete.onnx"), "no sidecar");
    await writeFile(path.join(dirs[0], "ignored.txt"), "ignored");
    const config = JSON.stringify({ native: { tts: { provider: "piper", modelPath: path.join(dirs[1], "custom.onnx") } } });
    await writeFile(configPath, config);
    const data = await service.conversationVoicesData();
    assert.equal(data.ttsProvider, "piper");
    assert.equal(data.current, "custom");
    assert.equal(data.voices[0].downloaded, true);
    assert.deepEqual(data.voices.slice(4), [
      { id: "custom", sizeMb: 2, note: "found on disk", downloaded: true, current: true },
      { id: "third", sizeMb: 0, note: "found on disk", downloaded: true, current: false },
    ]);
    assert.equal(await readFile(configPath, "utf8"), config);
    await writeFile(configPath, JSON.stringify({ native: { tts: { provider: "piper", modelPath: "/missing/de_DE-thorsten-high.onnx" } } }));
    const missingCurrent = await service.conversationVoicesData();
    assert.equal(missingCurrent.current, "de_DE-thorsten-high");
    assert.equal(missingCurrent.voices[3].downloaded, false);
  });

  await run("voice selection uses only the native command and returns the existing envelope", async ({ service, tab, calls, response, configPath, directory }) => {
    const config = JSON.stringify({ native: { tts: { provider: "piper", modelPath: "/test/en_US-lessac-medium.onnx" } } });
    await writeFile(configPath, config);
    const data = await service.setConversationVoice(tab, { voice: " en_US-lessac-medium " });
    assert.equal(data.current, "en_US-lessac-medium");
    assert.equal(data.response, response);
    assert.deepEqual(calls.feature, [tab]);
    assert.deepEqual(calls.rpc, [[{ type: "prompt", message: "/talk voice en_US-lessac-medium" }, 600_000]]);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.deepEqual(await readdir(directory), ["voice.json"]);
    assert.deepEqual(calls.fetch, []);
  });

  await run("invalid voice IDs fail before discovery or RPC", async ({ service, tab, calls }) => {
    for (const voice of ["", "../voice/file", "voice with spaces", "voice\ncommand", "v".repeat(121)]) {
      await assert.rejects(service.setConversationVoice(tab, { voice }), httpError(400, /Piper voice id/));
    }
    assert.deepEqual(calls.feature, []);
    assert.deepEqual(calls.rpc, []);
    assert.deepEqual(calls.fetch, []);
  });

  await run("voice command availability, aliases and failures retain their contracts", async ({ service, tab, calls, feature, setRpc }) => {
    feature.available = false;
    await assert.rejects(service.setConversationVoice(tab, { voice: "test" }), httpError(404, feature.unavailableReason));
    assert.deepEqual(calls.rpc, []);
    feature.available = true;
    for (const [commands, expected] of [[["conversation", "voice"], "conversation"], [[], "talk"]]) {
      feature.commands = commands;
      await service.setConversationVoice(tab, { voice: "test" });
      assert.deepEqual(calls.rpc.at(-1), [{ type: "prompt", message: `/${expected} voice test` }, 600_000]);
    }
    setRpc(async () => ({ success: false, error: "Companion rejected voice" }));
    await assert.rejects(service.setConversationVoice(tab, { voice: "test" }), httpError(400, "Companion rejected voice"));
    setRpc(async () => ({ success: false }));
    await assert.rejects(service.setConversationVoice(tab, { voice: "test" }), httpError(400, "Failed to switch the conversation voice to test"));
    const failure = new Error("RPC unavailable");
    setRpc(async () => { throw failure; });
    await assert.rejects(service.setConversationVoice(tab, { voice: "test" }), (error) => error === failure);
  });

  await run("status exposes provider availability and credential-free endpoint labels at call time", async ({ service, tab, mode, calls }) => {
    const initial = service.naturalConversationVoiceProviderStatus();
    assert.equal(initial.defaultProvider, "");
    assert.deepEqual(initial.providers.map(({ id, configured }) => [id, configured]), [["local", false], ["groq", false], ["openai", false], ["cloudflare", false]]);
    Object.assign(process.env, {
      PI_VOICE_STT_URL: "http://test-user:test-password@localhost:1234/transcribe?token=test-query#test-fragment",
      PI_VOICE_TTS_URL: "invalid endpoint", OPENAI_API_KEY: "test-openai-key", GROQ_API_KEY: "test-groq-key",
      CLOUDFLARE_API_TOKEN: "test-cloudflare-key", CLOUDFLARE_ACCOUNT_ID: "test-account",
      PI_VOICE_GROQ_STT_MODEL: "test-groq-model", PI_VOICE_OPENAI_STT_MODEL: "test-stt-model", PI_VOICE_OPENAI_TTS_MODEL: "test-tts-model",
    });
    const status = service.naturalConversationVoiceProviderStatus();
    assert.equal(status.defaultProvider, "local");
    assert.equal(status.providers[0].endpoint, "http://localhost:1234/transcribe");
    assert.ok(status.providers.every(({ configured }) => configured));
    assert.equal(status.providers[1].defaultModel, "test-groq-model");
    assert.equal(status.providers[2].defaultModel, "test-stt-model");
    assert.equal(status.providers[3].deferred, true);
    const tts = service.naturalConversationVoiceProviderStatus("tts");
    assert.equal(tts.providers[0].endpoint, "");
    assert.equal(tts.providers[1].defaultModel, "test-tts-model");
    for (const secret of ["test-user", "test-password", "test-query", "test-fragment", "test-openai-key", "test-groq-key", "test-cloudflare-key", "test-account"]) {
      assert.ok(!JSON.stringify([status, tts]).includes(secret));
    }
    const unavailable = service.naturalConversationUnavailableResponse(tab, "tts");
    assert.deepEqual(unavailable, {
      featureId: NATURAL_CONVERSATION_FEATURE_ID, available: false,
      mode: { ...mode, available: false, enabled: false, uiState: "off" }, voice: tts,
      message: "Natural Conversation server-side voice fallbacks are opt-in. Configure a local endpoint or explicit hosted provider env vars; browser-native audio remains the default Web UI path.",
    });
    assert.deepEqual(calls.snapshot, [[tab, { available: false, enabled: false, uiState: "off" }]]);
    assert.deepEqual(calls.fetch, []);
  });

  await run("remote consent is checked before provider selection and audio decoding", async ({ service, tab, calls }) => {
    const body = {
      get provider() { assert.fail("provider accessed before consent"); },
      get audioBase64() { assert.fail("audio decoded before consent"); },
    };
    for (const consent of [undefined, false, "true", 1]) {
      const requestBody = Object.create(body);
      requestBody.remoteMicStreamingConsentAccepted = consent;
      await assert.rejects(service.handleNaturalConversationSttTranscribe(remoteRequest, tab, requestBody), httpError(403, /explicit per-tab remote microphone streaming consent/));
    }
    assert.deepEqual(calls.fetch, []);
    assert.deepEqual(calls.snapshot, []);
  });

  await run("provider selection and missing credentials fail before decode or dispatch", async ({ service, tab, calls }) => {
    for (const kind of ["stt", "tts"]) {
      const handle = kind === "stt" ? service.handleNaturalConversationSttTranscribe : service.handleNaturalConversationTtsSpeech;
      for (const [provider, status] of [[undefined, 501], ["local", 424], ["openai", 424], ["unknown", 400], ["cloudflare", kind === "stt" ? 501 : 400], ["groq", kind === "stt" ? 424 : 400]]) {
        await assert.rejects(handle(localRequest, tab, {
          provider,
          get audioBase64() { assert.fail("audio decoded before provider validation"); },
          get text() { assert.fail("text read before provider validation"); },
        }), (error) => {
          assert.equal(error.statusCode, status);
          if (status === 424 || provider === undefined) assert.equal(error.voice.kind, kind);
          return true;
        });
      }
    }
    process.env.CLOUDFLARE_API_TOKEN = "test-cloudflare-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { provider: "cloudflare", audioBase64 }), httpError(501, /adapter is deferred/));
    assert.deepEqual(calls.fetch, []);
  });

  await run("STT rejects empty, invalid, unsupported and oversized audio before dispatch", async ({ service, tab, calls }) => {
    process.env.PI_VOICE_STT_URL = "http://local.test/stt";
    for (const [body, status, message] of [
      [{}, 400, /audioBase64 is required/],
      [{ audioBase64: "?invalid" }, 400, /valid base64/],
      [{ audioBase64: "=" }, 400, /empty audio payload/],
      [{ audioBase64, mimeType: "text/plain" }, 415, /Unsupported voice audio mime type/],
      [{ audioBase64: "data:text/plain;base64,YQ==" }, 415, /Unsupported voice audio mime type/],
      [{ audioBase64: Buffer.alloc(audioLimit + 1).toString("base64") }, 413, /Audio payload is too large/],
    ]) await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, body), httpError(status, message));
    assert.deepEqual(calls.format, [audioLimit]);
    assert.deepEqual(calls.fetch, []);
  });

  await run("local STT retains form fields, data URLs, MIME handling, filename sanitation and envelope", async ({ service, tab, mode, calls, setFetch }) => {
    process.env.PI_VOICE_STT_URL = "http://local.test/stt";
    setFetch(() => jsonResponse({ data: { text: "  heard text  " } }));
    const result = await service.handleNaturalConversationSttTranscribe(localRequest, tab, {
      audio: `data:audio/wav;base64, ${audioBase64}\n`, model: "local-model", language: "de", prompt: "context", fileName: "a/b\\c\0.wav",
    });
    assert.deepEqual(result, { provider: "local", text: "heard text", mimeType: "audio/wav", byteLength: 10, mode });
    const [url, init] = calls.fetch[0];
    assert.equal(url, "http://local.test/stt");
    assert.equal(init.method, "POST");
    assert.equal(init.headers, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body.get("file").name, "a_b_c_.wav");
    assert.equal(init.body.get("file").type, "audio/wav");
    assert.equal(await init.body.get("file").text(), "test audio");
    assert.equal(init.body.get("model"), "local-model");
    assert.equal(init.body.get("language"), "de");
    assert.equal(init.body.get("prompt"), "context");
    assert.deepEqual(calls.snapshot, [[tab, {}]]);
  });

  await run("STT supports consent aliases, every allowed MIME type and the exact audio size limit", async ({ service, tab, setFetch, calls }) => {
    process.env.PI_VOICE_STT_URL = "http://local.test/stt";
    setFetch(() => new Response("  plain transcript  "));
    for (const consentName of ["remoteMicStreamingConsentAccepted", "remoteMicStreamingConsent"]) {
      const result = await service.handleNaturalConversationSttTranscribe(remoteRequest, tab, { audioBase64, [consentName]: true });
      assert.equal(result.text, "plain transcript");
    }
    for (const mimeType of ["audio/webm", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/ogg", "audio/flac", "application/octet-stream"]) {
      await service.handleNaturalConversationSttTranscribe(localRequest, tab, { data: audioBase64, contentType: mimeType.toUpperCase(), fileName: "v".repeat(200) });
      assert.equal(calls.fetch.at(-1)[1].body.get("file").name.length, 120);
    }
    const result = await service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64: Buffer.alloc(audioLimit).toString("base64") });
    assert.equal(result.byteLength, audioLimit);
  });

  await run("hosted STT preserves provider URLs, credentials, default and overridden models", async ({ service, tab, setFetch, calls }) => {
    Object.assign(process.env, { OPENAI_API_KEY: "test-openai-key", GROQ_API_KEY: "test-groq-key" });
    setFetch(() => jsonResponse({ result: { text: "transcript" } }));
    for (const [provider, host, model] of [["openai", "api.openai.com", "gpt-4o-mini-transcribe"], ["groq", "api.groq.com", "whisper-large-v3-turbo"]]) {
      const result = await service.handleNaturalConversationSttTranscribe(localRequest, tab, { providerId: provider.toUpperCase(), audioBase64 });
      assert.equal(result.provider, provider);
      const [url, init] = calls.fetch.at(-1);
      assert.equal(url, `https://${host}${provider === "groq" ? "/openai" : ""}/v1/audio/transcriptions`);
      assert.equal(init.headers.authorization, `Bearer test-${provider}-key`);
      assert.equal(init.body.get("model"), model);
      assert.equal(init.body.get("response_format"), "json");
    }
    process.env.PI_VOICE_STT_PROVIDER = "groq";
    process.env.PI_VOICE_GROQ_STT_MODEL = "env-groq";
    await service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 });
    assert.equal(calls.fetch.at(-1)[1].body.get("model"), "env-groq");
    await service.handleNaturalConversationSttTranscribe(localRequest, tab, { provider: "openai", model: "requested-model", audioBase64 });
    assert.equal(calls.fetch.at(-1)[1].body.get("model"), "requested-model");
  });

  await run("TTS rejects missing and oversized text before provider dispatch", async ({ service, tab, calls }) => {
    process.env.PI_VOICE_TTS_URL = "http://local.test/tts";
    for (const body of [{}, { text: "  " }]) {
      await assert.rejects(service.handleNaturalConversationTtsSpeech(remoteRequest, tab, body), httpError(400, /text is required/));
    }
    await assert.rejects(service.handleNaturalConversationTtsSpeech(remoteRequest, tab, { text: "x".repeat(12_001) }), httpError(413, "TTS text is too long (limit 12000 characters)"));
    assert.deepEqual(calls.fetch, []);
  });

  await run("local TTS keeps opt-in text dispatch, JSON audio variants and exact text limit", async ({ service, tab, mode, setFetch, calls }) => {
    Object.assign(process.env, { PI_VOICE_TTS_URL: "http://local.test/tts", PI_VOICE_TTS_VOICE: "env-voice", PI_VOICE_TTS_FORMAT: "wav" });
    setFetch(() => jsonResponse({ data: { audioBase64 }, mimeType: "audio/wav", format: "wav" }));
    const result = await service.handleNaturalConversationTtsSpeech(remoteRequest, tab, { input: "  hello  " });
    assert.deepEqual(result, { provider: "local", audioBase64, contentType: "audio/wav", format: "wav", byteLength: 10, mode });
    const [url, init] = calls.fetch[0];
    assert.equal(url, "http://local.test/tts");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "content-type": "application/json" });
    assert.deepEqual(JSON.parse(init.body), { text: "hello", voice: "env-voice", format: "wav" });
    setFetch(() => jsonResponse({ audio: audioBase64, contentType: "audio/ogg" }));
    const overridden = await service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "x".repeat(12_000), voice: "requested-voice", format: "ogg" });
    assert.equal(overridden.contentType, "audio/ogg");
    assert.equal(overridden.format, "ogg");
    assert.deepEqual(JSON.parse(calls.fetch.at(-1)[1].body), { text: "x".repeat(12_000), voice: "requested-voice", format: "ogg" });
  });

  await run("OpenAI TTS keeps defaults, environment overrides, requested fields and binary envelope", async ({ service, tab, mode, setFetch, calls }) => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    setFetch(() => new Response(Buffer.from("audio"), { headers: { "content-type": "audio/wav" } }));
    const result = await service.handleNaturalConversationTtsSpeech(remoteRequest, tab, { provider: "openai", text: " hello " });
    assert.deepEqual(result, { provider: "openai", audioBase64: Buffer.from("audio").toString("base64"), contentType: "audio/wav", format: "mp3", byteLength: 5, mode });
    const [url, init] = calls.fetch[0];
    assert.equal(url, "https://api.openai.com/v1/audio/speech");
    assert.deepEqual(init.headers, { authorization: "Bearer test-openai-key", "content-type": "application/json" });
    assert.deepEqual(JSON.parse(init.body), { model: "gpt-4o-mini-tts", voice: "alloy", input: "hello", response_format: "mp3" });
    Object.assign(process.env, { PI_VOICE_TTS_PROVIDER: "openai", PI_VOICE_OPENAI_TTS_MODEL: "env-model", PI_VOICE_OPENAI_TTS_VOICE: "env-voice", PI_VOICE_OPENAI_TTS_FORMAT: "flac" });
    await service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "hello" });
    assert.deepEqual(JSON.parse(calls.fetch.at(-1)[1].body), { model: "env-model", voice: "env-voice", input: "hello", response_format: "flac" });
    await service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "hello", model: "requested-model", voice: "requested-voice", format: "wav" });
    assert.deepEqual(JSON.parse(calls.fetch.at(-1)[1].body), { model: "requested-model", voice: "requested-voice", input: "hello", response_format: "wav" });
  });

  await run("provider HTTP failures preserve status mapping and bounded messages", async ({ service, tab, setFetch, calls }) => {
    Object.assign(process.env, { PI_VOICE_STT_URL: "http://local.test/stt", PI_VOICE_TTS_URL: "http://local.test/tts" });
    for (const [method, body] of [[service.handleNaturalConversationSttTranscribe, { audioBase64 }], [service.handleNaturalConversationTtsSpeech, { text: "hello" }]]) {
      for (const status of [401, 429, 500, 503]) {
        setFetch(() => new Response("e".repeat(900), { status }));
        await assert.rejects(method(localRequest, tab, body), (error) => {
          assert.equal(error.statusCode, status >= 500 ? 502 : 400);
          assert.ok(error.message.endsWith("e".repeat(500)));
          assert.ok(!error.message.endsWith("e".repeat(501)));
          assert.match(error.message, new RegExp(`HTTP ${status}:`));
          return true;
        });
        assert.deepEqual(calls.truncate.at(-1), ["e".repeat(900), 500]);
      }
    }
    setFetch(() => ({ ok: false, status: 502, statusText: "Bad gateway", text: async () => { throw new Error("unreadable"); } }));
    await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 }), httpError(502, "local STT voice provider returned HTTP 502: Bad gateway"));
  });

  await run("provider parse and transport failures propagate without changing envelopes", async ({ service, tab, setFetch }) => {
    Object.assign(process.env, { PI_VOICE_STT_URL: "http://local.test/stt", PI_VOICE_TTS_URL: "http://local.test/tts" });
    for (const [response, message] of [[() => jsonResponse({ unexpected: "missing" }), /JSON without a transcript text field/], [() => new Response("  "), /empty transcript/]]) {
      setFetch(response);
      await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 }), httpError(502, message));
    }
    for (const [response, message] of [[() => jsonResponse({ unexpected: "missing" }), /JSON without audioBase64/], [() => new Response(new Uint8Array()), /empty audio/]]) {
      setFetch(response);
      await assert.rejects(service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "hello" }), httpError(502, message));
    }
    const transportError = new Error("Synthetic fetch failure");
    setFetch(() => { throw transportError; });
    await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 }), (error) => error === transportError);
    await assert.rejects(service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "hello" }), (error) => error === transportError);
    setFetch(() => new Response("{broken", { headers: { "content-type": "application/json" } }));
    await assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 }), SyntaxError);
    await assert.rejects(service.handleNaturalConversationTtsSpeech(localRequest, tab, { text: "hello" }), SyntaxError);
  });

  await run("timeout is captured at module load, clamped to 1000ms and passed to both providers", async ({ service, tab, setFetch }) => {
    Object.assign(process.env, { PI_VOICE_STT_URL: "http://local.test/stt", PI_VOICE_TTS_URL: "http://local.test/tts" });
    setFetch((_url, { signal }) => new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("Provider did not receive the captured timeout")), 2_000);
      signal.addEventListener("abort", () => { clearTimeout(guard); reject(signal.reason); }, { once: true });
    }));
    await Promise.all([
      assert.rejects(service.handleNaturalConversationSttTranscribe(localRequest, tab, { audioBase64 }), { name: "TimeoutError" }),
      assert.rejects(service.handleNaturalConversationTtsSpeech(remoteRequest, tab, { text: "hello" }), { name: "TimeoutError" }),
    ]);
  });
});
