/**
 * Redaction of Cua output before it reaches an error message, a log, or a
 * report. The `cua` CLI never prints credentials in the commands this backend
 * runs, but its stderr can quote requests and cloud SDK errors, so every text
 * from it passes through {@link redact} and is bounded.
 */
import { ownedSlice } from "../../framing/log-event.ts";

/** Longest redacted text kept for one message (characters). */
export const REDACTED_MAX_CHARS = 2_000;
/** Input read for one message; cut at a word boundary first, so no secret is split and every pattern stays linear. */
const INPUT_MAX_CHARS = 2 * REDACTED_MAX_CHARS;

const MARK = "[redacted]";

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // `authorization: Bearer …`, `x-cua-env-authorization: …`
  [/((?:x-[a-z-]{0,40})?authorization["']?\s{0,8}[:=]\s{0,8}["']?(?:bearer\s+)?)[^\s"',}]+/gi, `$1${MARK}`],
  // `"token": "…"`, `password=…`, `api_key: …`, `refresh_token …`
  [/(["']?\b[a-z_-]{0,40}(?:token|password|passwd|secret|api[_-]?key|apikey|credential)s?["']?\s{0,8}[:=]\s{0,8}["']?)[^\s"',}]+/gi, `$1${MARK}`],
  // `CUA_ENV_TOKEN=…`, `HCLOUD_TOKEN=…`, `AWS_SECRET_ACCESS_KEY=…`
  [/(\b[A-Z][A-Z0-9_]{0,64}(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]{0,64}=)\S+/g, `$1${MARK}`],
  // URLs with userinfo or token query parameters.
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@]+@/gi, `$1${MARK}@`],
  [/([?&](?:token|key|sig|signature|access_token)=)[^\s&"']+/gi, `$1${MARK}`],
  // JWTs and long opaque runs (≥ 40 base64url/hex characters; `/` excluded so paths stay readable).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MARK],
  [/\b[A-Za-z0-9_+-]{40,}={0,2}/g, MARK],
];

/**
 * Removes credential-shaped substrings and the exact `secrets` given, and
 * bounds the result to {@link REDACTED_MAX_CHARS} as an owned copy.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = String(text);
  if (out.length > INPUT_MAX_CHARS) {
    // Drop the last, possibly cut word: a secret split here would escape every pattern.
    let end = INPUT_MAX_CHARS;
    while (end > 0 && !/\s/.test(out[end])) end--;
    out = `${out.slice(0, end)} …`;
  }
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(MARK);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > REDACTED_MAX_CHARS ? `${ownedSlice(out, 0, REDACTED_MAX_CHARS)}…` : ownedSlice(out);
}
