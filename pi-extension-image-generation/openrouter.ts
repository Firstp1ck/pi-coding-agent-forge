import type { Usage } from "@earendil-works/pi-ai";

export const API_BASE = "https://openrouter.ai/api/v1";
export const CATALOG_TIMEOUT_MS = 30_000;
export const GENERATION_TIMEOUT_MS = 180_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 8_000;

export type Capability =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

export interface ImageModel {
  id: string;
  name: string;
  parameters: Record<string, Capability>;
}

export interface GenerationOptions {
  aspect_ratio?: string;
  resolution?: string;
}

export interface GeneratedImage {
  data: string;
  bytes: Buffer;
  mimeType: string;
  extension: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function cleanLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 160);
}

export function parseModels(payload: unknown): ImageModel[] {
  const data = record(payload).data;
  if (!Array.isArray(data)) throw new Error("OpenRouter returned an invalid image catalog.");
  const models = new Map<string, ImageModel>();
  for (const item of data) {
    const row = record(item);
    const architecture = record(row.architecture);
    if (!Array.isArray(architecture.output_modalities) || !architecture.output_modalities.includes("image")) continue;
    if (!Array.isArray(architecture.input_modalities) || !architecture.input_modalities.includes("text")) continue;
    if (typeof row.id !== "string" || row.id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(row.id)) continue;
    const parameters: Record<string, Capability> = {};
    for (const key of ["aspect_ratio", "resolution"]) {
      const cap = record(record(row.supported_parameters)[key]);
      if (cap.type === "enum" && Array.isArray(cap.values)) {
        const values = cap.values.filter((v): v is string => typeof v === "string" && /^[a-zA-Z0-9:.-]{1,32}$/.test(v)).slice(0, 100);
        if (values.length) parameters[key] = { type: "enum", values };
      }
    }
    models.set(row.id, { id: row.id, name: cleanLabel(typeof row.name === "string" ? row.name : row.id), parameters });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function validateOptions(model: ImageModel, options: GenerationOptions): void {
  for (const key of ["aspect_ratio", "resolution"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    const cap = model.parameters[key];
    if (!cap || cap.type !== "enum" || !cap.values.includes(value)) {
      throw new Error(`${key} is not supported for this model. Use a value returned by show_image_model_list or omit it.`);
    }
  }
}

export async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("OpenRouter returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("OpenRouter response exceeds the download limit.");
      chunks.push(value);
    }
    signal.throwIfAborted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    // Never include raw response bodies, which can echo prompts or credentials.
    throw new Error("OpenRouter returned invalid JSON.");
  }
}

async function requestJson(
  fetcher: typeof fetch, path: string, init: RequestInit, timeout: number, maxBytes: number, signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  try {
    combined.throwIfAborted();
    const response = await fetcher(`${API_BASE}${path}`, { ...init, signal: combined, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const hint = response.status === 401 ? "Check your OpenRouter credentials in /setup-image-generation or OPENROUTER_API_KEY."
        : response.status === 402 ? "Check your OpenRouter credits."
        : response.status === 429 ? "Rate limited. Wait before trying again."
        : "Check model availability and your OpenRouter activity.";
      throw new Error(`OpenRouter HTTP ${response.status}. ${hint} No automatic retry was made.`);
    }
    return await readBoundedJson(response, maxBytes, combined);
  } catch (error) {
    if (signal?.aborted) throw new Error("Image operation cancelled. No automatic retry was made.");
    if (controller.signal.aborted) throw new Error("OpenRouter request timed out. Check your activity before retrying.");
    if (error instanceof Error && error.message.startsWith("OpenRouter")) throw error;
    throw new Error("OpenRouter request failed. Check your connection and activity before retrying.");
  } finally {
    clearTimeout(deadline);
  }
}

export async function listModels(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ImageModel[]> {
  return parseModels(await requestJson(fetcher, "/images/models", {}, CATALOG_TIMEOUT_MS, 4 * 1024 * 1024, signal));
}

export async function checkConnection(apiKey: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<number> {
  const payload = await requestJson(fetcher, "/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, CATALOG_TIMEOUT_MS, 64 * 1024, signal);
  if (!record(payload).data || typeof record(payload).data !== "object" || Array.isArray(record(payload).data)) {
    throw new Error("OpenRouter returned an invalid authentication check response.");
  }
  return (await listModels(fetcher, signal)).length;
}

export function decodeImage(payload: unknown): GeneratedImage {
  const rows = record(payload).data;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("OpenRouter did not return exactly one image. Check your activity before retrying.");
  const row = record(rows[0]);
  const data = row.b64_json;
  if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("OpenRouter returned invalid or oversized base64 image data.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) throw new Error("OpenRouter returned invalid or oversized image data.");
  let mimeType: string;
  let extension: string;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = "image/png"; extension = "png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = "image/jpeg"; extension = "jpg";
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    mimeType = "image/webp"; extension = "webp";
  } else if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    mimeType = "image/gif"; extension = "gif";
  } else {
    throw new Error("OpenRouter returned an unsupported image format. Only PNG, JPEG, WebP and GIF are saved; SVG is not rendered or saved. Check your activity before retrying.");
  }
  if (row.media_type !== undefined && row.media_type !== mimeType) throw new Error("OpenRouter image media type does not match its bytes.");
  return { data, bytes, mimeType, extension };
}

export function reportedCost(payload: unknown): number | undefined {
  const cost = record(record(payload).usage).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export function parseUsage(payload: unknown): Usage | undefined {
  const raw = record(record(payload).usage);
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  if (Object.keys(raw).length === 0) return undefined;
  const input = number(raw.prompt_tokens);
  const output = number(raw.completion_tokens);
  const cost = number(raw.cost);
  return {
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

export async function generateImage(
  model: ImageModel, prompt: string, options: GenerationOptions, apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<{ image: GeneratedImage; usage?: Usage; costUsd?: number }> {
  const payload = await requestJson(fetcher, "/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.id, prompt, n: 1, ...options }),
  }, GENERATION_TIMEOUT_MS, MAX_RESPONSE_BYTES, signal);
  return { image: decodeImage(payload), usage: parseUsage(payload), costUsd: reportedCost(payload) };
}
