import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NATURAL_CONVERSATION_FEATURE_ID } from "./conversation-mode.mjs";

const VOICE_AUDIO_BODY_LIMIT_BYTES = 24 * 1024 * 1024;
export const VOICE_AUDIO_JSON_BODY_LIMIT_BYTES = Math.ceil(VOICE_AUDIO_BODY_LIMIT_BYTES * 1.4) + 1024 * 1024;
const VOICE_PROVIDER_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.PI_VOICE_PROVIDER_TIMEOUT_MS || "120000", 10) || 120000);
const VOICE_TTS_TEXT_MAX_CHARS = 12_000;

export function createConversationVoiceService({
  naturalConversationFeatureData,
  naturalConversationModeSnapshot,
  isLocalRequest,
  makeHttpError,
  formatBytes,
  truncateStatusText,
}) {
  // Piper voice switching for the native /talk audio loop. The WebUI never
  // imports the natural-conversation package; it mirrors the package's small
  // voice catalog for display, reads voice.json / the piper voice dir for
  // state, and performs the actual switch (incl. download) by sending
  // `/talk voice <id>` over RPC so the package stays the single writer.
  const CONVERSATION_VOICE_CATALOG = [
    { id: "en_US-lessac-medium", file: "en_US-lessac-medium.onnx", sizeMb: 63, note: "natural US English" },
    { id: "en_GB-alba-medium", file: "en_GB-alba-medium.onnx", sizeMb: 63, note: "natural British English" },
    { id: "de_DE-thorsten-medium", file: "de_DE-thorsten-medium.onnx", sizeMb: 63, note: "natural German" },
    { id: "de_DE-thorsten-high", file: "de_DE-thorsten-high.onnx", sizeMb: 110, note: "German, best quality" },
  ];
  const CONVERSATION_VOICE_SWITCH_TIMEOUT_MS = 10 * 60 * 1000; // downloads can take a while

  function conversationVoiceConfigPath() {
    const override = String(process.env.PI_VOICE_CONFIG_PATH || "").trim();
    return override || path.join(homedir(), ".pi", "agent", "voice.json");
  }

  function conversationVoiceDirs() {
    const data = String(process.env.XDG_DATA_HOME || "").trim() || path.join(homedir(), ".local", "share");
    return [path.join(data, "piper"), path.join(data, "piper", "voices"), path.join(data, "piper-voices")];
  }

  async function conversationVoicesData() {
    let ttsProvider = null;
    let currentModelPath = null;
    try {
      const config = JSON.parse(await readFile(conversationVoiceConfigPath(), "utf8"));
      ttsProvider = config?.native?.tts?.provider ?? null;
      if (ttsProvider === "piper") currentModelPath = config?.native?.tts?.modelPath ?? null;
    } catch {
      // no voice.json yet — the dropdown still lists the catalog
    }

    const onDisk = new Map();
    for (const dir of conversationVoiceDirs()) {
      let entries = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".onnx") || onDisk.has(entry)) continue;
        const modelPath = path.join(dir, entry);
        const sidecar = await stat(`${modelPath}.json`).catch(() => null);
        if (!sidecar) continue;
        const size = await stat(modelPath).catch(() => null);
        onDisk.set(entry, { path: modelPath, sizeMb: size ? Math.round(size.size / (1024 * 1024)) : 0 });
      }
    }

    const voices = CONVERSATION_VOICE_CATALOG.map((entry) => ({
      id: entry.id,
      sizeMb: entry.sizeMb,
      note: entry.note,
      downloaded: onDisk.has(entry.file),
      current: Boolean(currentModelPath && currentModelPath.endsWith(`/${entry.file}`)),
    }));
    for (const [file, info] of onDisk) {
      if (CONVERSATION_VOICE_CATALOG.some((entry) => entry.file === file)) continue;
      voices.push({
        id: file.replace(/\.onnx$/, ""),
        sizeMb: info.sizeMb,
        note: "found on disk",
        downloaded: true,
        current: info.path === currentModelPath,
      });
    }
    return { voices, current: voices.find((voice) => voice.current)?.id ?? null, ttsProvider };
  }

  async function setConversationVoice(tab, body = {}) {
    const voiceId = String(body.voice || "").trim();
    if (!/^[\w.-]{1,120}$/.test(voiceId)) throw makeHttpError(400, "voice must be a Piper voice id (letters, digits, dot, dash, underscore)");
    const feature = await naturalConversationFeatureData(tab);
    if (!feature.available) throw makeHttpError(404, feature.unavailableReason);
    const commandName = feature.commands.find((name) => name === "talk") || feature.commands[0] || "talk";
    const response = await tab.rpc.send({ type: "prompt", message: `/${commandName} voice ${voiceId}` }, CONVERSATION_VOICE_SWITCH_TIMEOUT_MS);
    if (response.success === false) throw makeHttpError(400, response.error || `Failed to switch the conversation voice to ${voiceId}`);
    return { ...(await conversationVoicesData()), response };
  }

  const VOICE_AUDIO_MIME_TYPES = new Set(["audio/webm", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/ogg", "audio/flac", "application/octet-stream"]);
  const VOICE_STT_PROVIDER_IDS = ["local", "groq", "openai", "cloudflare"];
  const VOICE_TTS_PROVIDER_IDS = ["local", "openai"];

  function safeVoiceEndpointLabel(value) {
    try {
      const parsed = new URL(String(value || ""));
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "";
    }
  }

  function naturalConversationVoiceProviderStatus(kind = "stt") {
    const stt = kind === "stt";
    const localUrl = stt ? process.env.PI_VOICE_STT_URL : process.env.PI_VOICE_TTS_URL;
    const providers = [
      {
        id: "local",
        label: stt ? "Local STT endpoint" : "Local TTS endpoint",
        configured: !!localUrl,
        env: stt ? ["PI_VOICE_STT_URL"] : ["PI_VOICE_TTS_URL"],
        endpoint: safeVoiceEndpointLabel(localUrl),
      },
    ];
    if (stt) {
      providers.push(
        { id: "groq", label: "Groq Whisper", configured: !!process.env.GROQ_API_KEY, env: ["GROQ_API_KEY"], defaultModel: process.env.PI_VOICE_GROQ_STT_MODEL || "whisper-large-v3-turbo" },
        { id: "openai", label: "OpenAI transcription", configured: !!process.env.OPENAI_API_KEY, env: ["OPENAI_API_KEY"], defaultModel: process.env.PI_VOICE_OPENAI_STT_MODEL || "gpt-4o-mini-transcribe" },
        { id: "cloudflare", label: "Cloudflare Workers AI Whisper", configured: !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID), env: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], deferred: true },
      );
    } else {
      providers.push({ id: "openai", label: "OpenAI speech", configured: !!process.env.OPENAI_API_KEY, env: ["OPENAI_API_KEY"], defaultModel: process.env.PI_VOICE_OPENAI_TTS_MODEL || "gpt-4o-mini-tts" });
    }
    return {
      kind: stt ? "stt" : "tts",
      providers,
      defaultProvider: (stt ? process.env.PI_VOICE_STT_PROVIDER : process.env.PI_VOICE_TTS_PROVIDER) || (localUrl ? "local" : ""),
      remoteConsent: stt ? "Remote WebUI raw-audio uploads require per-request remoteMicStreamingConsentAccepted=true; browser Web Speech does not use this route." : "Server-side TTS sends answer text to the selected provider only when this route is explicitly used.",
    };
  }

  function naturalConversationUnavailableResponse(tab, kind = "stt") {
    return {
      featureId: NATURAL_CONVERSATION_FEATURE_ID,
      available: false,
      mode: naturalConversationModeSnapshot(tab, { available: false, enabled: false, uiState: "off" }),
      voice: naturalConversationVoiceProviderStatus(kind),
      message: "Natural Conversation server-side voice fallbacks are opt-in. Configure a local endpoint or explicit hosted provider env vars; browser-native audio remains the default Web UI path.",
    };
  }

  function naturalConversationProviderNotConfiguredError(kind, provider, message) {
    const error = makeHttpError(provider ? 424 : 501, message);
    error.voice = naturalConversationVoiceProviderStatus(kind);
    return error;
  }

  function requestedNaturalConversationVoiceProvider(kind, body = {}) {
    const requested = String(body.provider || body.providerId || (kind === "stt" ? process.env.PI_VOICE_STT_PROVIDER : process.env.PI_VOICE_TTS_PROVIDER) || "").trim().toLowerCase();
    const ids = kind === "stt" ? VOICE_STT_PROVIDER_IDS : VOICE_TTS_PROVIDER_IDS;
    const localUrl = kind === "stt" ? process.env.PI_VOICE_STT_URL : process.env.PI_VOICE_TTS_URL;
    const provider = requested || (localUrl ? "local" : "");
    if (!provider) throw naturalConversationProviderNotConfiguredError(kind, "", `No Natural Conversation ${kind.toUpperCase()} provider is configured. Set ${kind === "stt" ? "PI_VOICE_STT_URL or PI_VOICE_STT_PROVIDER" : "PI_VOICE_TTS_URL or PI_VOICE_TTS_PROVIDER"}.`);
    if (!ids.includes(provider)) throw makeHttpError(400, `Unsupported Natural Conversation ${kind.toUpperCase()} provider: ${provider}`);
    if (provider === "local" && !localUrl) throw naturalConversationProviderNotConfiguredError(kind, provider, `Local Natural Conversation ${kind.toUpperCase()} endpoint is not configured. Set ${kind === "stt" ? "PI_VOICE_STT_URL" : "PI_VOICE_TTS_URL"}.`);
    if (provider === "groq" && !process.env.GROQ_API_KEY) throw naturalConversationProviderNotConfiguredError(kind, provider, "Groq STT is not configured. Set GROQ_API_KEY server-side; never send it from the browser.");
    if (provider === "openai" && !process.env.OPENAI_API_KEY) throw naturalConversationProviderNotConfiguredError(kind, provider, `OpenAI ${kind.toUpperCase()} is not configured. Set OPENAI_API_KEY server-side; never send it from the browser.`);
    if (provider === "cloudflare") throw makeHttpError(501, "Cloudflare Workers AI STT is a selected Phase 4 provider but its adapter is deferred until the exact upload contract is validated; use local, Groq, or OpenAI for this slice.");
    return provider;
  }

  function requireRemoteMicConsentForStt(req, body = {}) {
    if (isLocalRequest(req)) return;
    if (body.remoteMicStreamingConsentAccepted === true || body.remoteMicStreamingConsent === true) return;
    throw makeHttpError(403, "Remote WebUI STT uploads require explicit per-tab remote microphone streaming consent before raw audio is sent to the Pi host or an STT provider.");
  }

  function decodeVoiceAudioBody(body = {}) {
    const value = String(body.audioBase64 || body.audio || body.data || "").trim();
    if (!value) throw makeHttpError(400, "audioBase64 is required for Natural Conversation STT fallback uploads");
    const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.*)$/s);
    const mimeType = String(body.mimeType || body.contentType || dataUrlMatch?.[1] || "audio/webm").toLowerCase();
    if (!VOICE_AUDIO_MIME_TYPES.has(mimeType)) throw makeHttpError(415, `Unsupported voice audio mime type: ${mimeType}`);
    const base64 = (dataUrlMatch?.[2] || value).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw makeHttpError(400, "audioBase64 must be valid base64");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) throw makeHttpError(400, "audioBase64 decoded to an empty audio payload");
    if (buffer.length > VOICE_AUDIO_BODY_LIMIT_BYTES) throw makeHttpError(413, `Audio payload is too large (limit ${formatBytes(VOICE_AUDIO_BODY_LIMIT_BYTES)})`);
    return {
      buffer,
      mimeType,
      fileName: String(body.fileName || `speech.${mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : "webm"}`).replace(/[\\/\0]/g, "_").slice(0, 120),
    };
  }

  function voiceFetchError(provider, response, text) {
    const status = response.status >= 500 ? 502 : 400;
    return makeHttpError(status, `${provider} voice provider returned HTTP ${response.status}: ${truncateStatusText(text || response.statusText || "request failed", 500)}`);
  }

  async function fetchVoiceProvider(provider, url, init = {}) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(VOICE_PROVIDER_TIMEOUT_MS) });
    if (!response.ok) throw voiceFetchError(provider, response, await response.text().catch(() => ""));
    return response;
  }

  function voiceFormData(audio, body = {}, model = "") {
    const form = new FormData();
    form.set("file", new Blob([audio.buffer], { type: audio.mimeType }), audio.fileName);
    if (model) form.set("model", model);
    if (body.language) form.set("language", String(body.language));
    if (body.prompt) form.set("prompt", String(body.prompt));
    return form;
  }

  function transcriptTextFromProviderJson(json) {
    return String(json?.text || json?.transcript || json?.data?.text || json?.result?.text || "").trim();
  }

  async function parseTranscriptResponse(provider, response) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const json = await response.json();
      const text = transcriptTextFromProviderJson(json);
      if (!text) throw makeHttpError(502, `${provider} STT provider returned JSON without a transcript text field`);
      return text;
    }
    const text = (await response.text()).trim();
    if (!text) throw makeHttpError(502, `${provider} STT provider returned an empty transcript`);
    return text;
  }

  async function transcribeWithLocalProvider(audio, body = {}) {
    const form = voiceFormData(audio, body, body.model ? String(body.model) : "");
    const response = await fetchVoiceProvider("local STT", process.env.PI_VOICE_STT_URL, { method: "POST", body: form });
    return parseTranscriptResponse("local", response);
  }

  async function transcribeWithOpenAiCompatibleProvider(provider, audio, body = {}) {
    const openai = provider === "openai";
    const url = openai ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.groq.com/openai/v1/audio/transcriptions";
    const model = String(body.model || (openai ? process.env.PI_VOICE_OPENAI_STT_MODEL || "gpt-4o-mini-transcribe" : process.env.PI_VOICE_GROQ_STT_MODEL || "whisper-large-v3-turbo"));
    const form = voiceFormData(audio, body, model);
    form.set("response_format", "json");
    const response = await fetchVoiceProvider(`${provider} STT`, url, {
      method: "POST",
      headers: { authorization: `Bearer ${openai ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY}` },
      body: form,
    });
    return parseTranscriptResponse(provider, response);
  }

  async function handleNaturalConversationSttTranscribe(req, tab, body = {}) {
    requireRemoteMicConsentForStt(req, body);
    const provider = requestedNaturalConversationVoiceProvider("stt", body);
    const audio = decodeVoiceAudioBody(body);
    const text = provider === "local" ? await transcribeWithLocalProvider(audio, body) : await transcribeWithOpenAiCompatibleProvider(provider, audio, body);
    return { provider, text, mimeType: audio.mimeType, byteLength: audio.buffer.length, mode: naturalConversationModeSnapshot(tab) };
  }

  function normalizeVoiceText(body = {}) {
    const text = String(body.text || body.input || "").trim();
    if (!text) throw makeHttpError(400, "text is required for Natural Conversation TTS fallback synthesis");
    if (text.length > VOICE_TTS_TEXT_MAX_CHARS) throw makeHttpError(413, `TTS text is too long (limit ${VOICE_TTS_TEXT_MAX_CHARS} characters)`);
    return text;
  }

  async function audioPayloadFromResponse(provider, response, preferredFormat = "") {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const json = await response.json();
      const audioBase64 = String(json.audioBase64 || json.audio || json.data?.audioBase64 || "").trim();
      if (!audioBase64) throw makeHttpError(502, `${provider} TTS provider returned JSON without audioBase64`);
      const buffer = Buffer.from(audioBase64, "base64");
      return { audioBase64, contentType: json.mimeType || json.contentType || "audio/mpeg", format: json.format || preferredFormat || "mp3", byteLength: buffer.length };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw makeHttpError(502, `${provider} TTS provider returned empty audio`);
    return { audioBase64: buffer.toString("base64"), contentType: contentType || "audio/mpeg", format: preferredFormat || (contentType.includes("wav") ? "wav" : "mp3"), byteLength: buffer.length };
  }

  async function synthesizeWithLocalProvider(text, body = {}) {
    const response = await fetchVoiceProvider("local TTS", process.env.PI_VOICE_TTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: body.voice || process.env.PI_VOICE_TTS_VOICE || undefined, format: body.format || process.env.PI_VOICE_TTS_FORMAT || "mp3" }),
    });
    return audioPayloadFromResponse("local", response, body.format || process.env.PI_VOICE_TTS_FORMAT || "mp3");
  }

  async function synthesizeWithOpenAiProvider(text, body = {}) {
    const format = String(body.format || process.env.PI_VOICE_OPENAI_TTS_FORMAT || "mp3");
    const response = await fetchVoiceProvider("openai TTS", "https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: body.model || process.env.PI_VOICE_OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: body.voice || process.env.PI_VOICE_OPENAI_TTS_VOICE || "alloy", input: text, response_format: format }),
    });
    return audioPayloadFromResponse("openai", response, format);
  }

  async function handleNaturalConversationTtsSpeech(_req, tab, body = {}) {
    const provider = requestedNaturalConversationVoiceProvider("tts", body);
    const text = normalizeVoiceText(body);
    const audio = provider === "local" ? await synthesizeWithLocalProvider(text, body) : await synthesizeWithOpenAiProvider(text, body);
    return { provider, ...audio, mode: naturalConversationModeSnapshot(tab) };
  }

  return {
    conversationVoicesData,
    setConversationVoice,
    naturalConversationVoiceProviderStatus,
    naturalConversationUnavailableResponse,
    handleNaturalConversationSttTranscribe,
    handleNaturalConversationTtsSpeech,
  };
}
