import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { abortable } from "./tool-bridge.ts";

export type PageResponse = { status: number; headers: Record<string, string | undefined>; body: string; bytes: number };
export type PageResult = { url: string; finalUrl: string; accessedAt: string; status: number; contentType: string; text: string; truncated: boolean; bytesRead: number };
type Address = { address: string; family: number };
export type FetchDependencies = {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: (url: URL, address: string, signal: AbortSignal) => Promise<PageResponse>;
  timeoutMs?: number;
};
export class PublicFetchError extends Error {
  readonly kind: "access" | "policy" | "limit" | "invalid_result";
  constructor(message: string, kind: PublicFetchError["kind"]) { super(message); this.name = "PublicFetchError"; this.kind = kind; }
}
const MAX_BYTES = 512_000;
const MAX_TEXT = 24_000;

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113) || a! >= 224);
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PublicFetchError("An absolute public HTTP(S) URL is required", "policy"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PublicFetchError("Public-page reader permits only HTTP(S)", "policy");
  if (url.username || url.password) throw new PublicFetchError("Public-page reader forbids URL credentials", "policy");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname.includes(".") || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.includes(":")) throw new PublicFetchError("A public IPv4-capable hostname is required", "policy");
  if (isIP(hostname) && !publicIpv4(hostname)) throw new PublicFetchError("Private or reserved IP destination denied", "policy");
  if (url.port && url.port !== "80" && url.port !== "443") throw new PublicFetchError("Only standard web ports 80 and 443 are permitted", "policy");
  url.hash = "";
  return url;
}

async function pinnedRequest(url: URL, address: string, signal: AbortSignal): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? https.request : http.request;
    const req = request({
      protocol: url.protocol, hostname: address, family: 4, servername: isIP(url.hostname) ? undefined : url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: "GET", agent: false, signal,
      headers: { host: url.host, accept: "text/html, text/plain, application/json;q=0.8", "accept-encoding": "identity", "user-agent": "Pi-Model-Research/0.1 (public research; no cookies)" },
    }, response => {
      const status = response.statusCode ?? 0;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
      if (status >= 300 && status < 400) { response.destroy(); resolve({ status, headers, body: "", bytes: 0 }); return; }
      const type = headers["content-type"] ?? "";
      const encoding = headers["content-encoding"];
      if (status < 200 || status >= 300 || !/^(?:text\/(?:html|plain)|application\/(?:xhtml\+xml|json))(?:\s*;|$)/i.test(type) || (encoding && encoding !== "identity")) {
        response.destroy(); reject(new PublicFetchError(`Public-page access failed: HTTP ${status}; unsupported or unavailable content (${type || "unknown type"})`, "access")); return;
      }
      let count = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        count += chunk.length;
        if (count > MAX_BYTES) { response.destroy(new PublicFetchError(`Page exceeds ${MAX_BYTES} bytes`, "limit")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8"), bytes: count }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Extract bounded text without executing scripts, loading assets, or recursively parsing HTML. */
export function pageText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) { parts.push(html.slice(cursor)); break; }
    parts.push(html.slice(cursor, start));
    const end = html.indexOf(">", start + 1);
    if (end < 0) break;
    const tag = lower.slice(start + 1, Math.min(end, start + 200)).trim();
    const blocked = /^(script|style|noscript|svg|head)(?:\s|$)/.exec(tag)?.[1];
    if (blocked) {
      const closing = lower.indexOf(`</${blocked}`, end + 1);
      if (closing < 0) break;
      const closeEnd = html.indexOf(">", closing);
      cursor = closeEnd < 0 ? html.length : closeEnd + 1;
      parts.push(" ");
      continue;
    }
    parts.push(/^(?:\/?(?:p|div|h[1-6]|li|tr|section|article)|br)(?:\s|$)/.test(tag) ? "\n" : " ");
    cursor = end + 1;
  }
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return parts.join("").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
    const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  }).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Public unauthenticated GET with DNS-pinned IPv4 connections and revalidated redirects. */
export async function fetchPublicPage(raw: string, signal?: AbortSignal, dependencies: FetchDependencies = {}): Promise<PageResult> {
  if (typeof raw !== "string" || raw.length > 4000) throw new PublicFetchError("A bounded public URL is required", "policy");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Public-page read timed out")), dependencies.timeoutMs ?? 20_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const request = dependencies.request ?? pinnedRequest;
  try {
    let url = publicUrl(raw);
    for (let hop = 0; hop <= 4; hop += 1) {
      combined.throwIfAborted();
      const answers = await abortable(resolve(url.hostname), combined);
      const ipv4 = answers.filter(answer => answer.family === 4);
      if (!ipv4.length || ipv4.some(answer => !publicIpv4(answer.address))) throw new PublicFetchError("DNS destination is not exclusively public IPv4; access denied", "policy");
      combined.throwIfAborted();
      const response = await abortable(request(url, ipv4[0]!.address, combined), combined);
      if (response.bytes > MAX_BYTES || Buffer.byteLength(response.body) > MAX_BYTES) throw new PublicFetchError(`Page exceeds ${MAX_BYTES} bytes`, "limit");
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        if (hop === 4) throw new PublicFetchError("Public-page redirect limit exceeded", "limit");
        url = publicUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new PublicFetchError(`Source inaccessible: HTTP ${response.status}`, "access");
      const contentType = response.headers["content-type"] ?? "";
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]?.toLowerCase().replace(/[-_]/g, "");
      if (charset && charset !== "utf8" && charset !== "usascii") throw new PublicFetchError("Only UTF-8/ASCII public-page text is supported", "access");
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new PublicFetchError("Compressed public-page responses are unsupported", "access");
      if (!/^(?:text\/(?:html|plain)|application\/(?:xhtml\+xml|json))(?:\s*;|$)/i.test(contentType)) throw new PublicFetchError("Unsupported public-page content type", "access");
      const extracted = /html/i.test(contentType) ? pageText(response.body) : response.body;
      if (!extracted.trim()) throw new PublicFetchError("No readable source text was available", "access");
      return { url: raw, finalUrl: url.href, accessedAt: new Date().toISOString(), status: response.status, contentType, text: extracted.slice(0, MAX_TEXT), truncated: response.status === 206 || extracted.length > MAX_TEXT, bytesRead: response.bytes };
    }
    throw new PublicFetchError("Public-page redirect limit exceeded", "limit");
  } catch (error) {
    if (error instanceof PublicFetchError) throw error;
    if (combined.aborted) throw new PublicFetchError("Public-page read aborted or timed out", "limit");
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (/^(?:EAI_|ENOTFOUND|ECONN|ETIMEDOUT|EHOST|ENET|EPROTO|ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code)) throw new PublicFetchError(error instanceof Error ? error.message : String(error), "access");
    throw new PublicFetchError(error instanceof Error ? error.message : String(error), "invalid_result");
  } finally { clearTimeout(timer); controller.abort(); }
}
