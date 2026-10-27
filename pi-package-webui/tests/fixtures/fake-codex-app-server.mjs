import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_CODEX_MODE || "success";
const log = (entry) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`);
};
log({ kind: "start", pid: process.pid, args: process.argv.slice(2) });
if (["hang", "stubborn", "tree"].includes(mode)) setInterval(() => {}, 1000);
if (mode === "tree") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  log({ kind: "descendant", pid: child.pid });
}
const send = (frame) => {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (mode === "fragmented") {
    for (let start = 0; start < bytes.length; start += 7) process.stdout.write(bytes.subarray(start, start + 7));
  } else process.stdout.write(bytes);
};
const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 };
const secondary = { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2_000_500_000 };
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  log({ kind: "frame", ...frame });
  if (!frame.method || frame.method === "initialized") return;
  if (frame.method === "initialize") {
    if (mode === "hang") return;
    if (mode === "early-exit") { process.exit(7); return; }
    if (mode === "malformed") { process.stdout.write("not JSON\n"); return; }
    if (mode === "oversized") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
    if (mode === "stderr-flood") { process.stderr.write("x".repeat(4 * 1024 * 1024 + 1)); return; }
    send({ id: frame.id, result: { userAgent: "fixture" } });
    if (mode === "server-request") send({ id: "server-auth-request", method: "account/chatgptAuthTokens/refresh", params: { reason: "expired" } });
    send({ method: "account/updated", params: { email: "private-fixture@example.invalid", secret: "fixture-notification-secret" } });
    return;
  }
  if (frame.method === "account/read") {
    const account = mode === "logged-out" ? null : mode === "api-key" ? { type: "apiKey" } : { type: "chatgpt", planType: "plus", email: "private-fixture@example.invalid", accountId: "private-account", accessToken: "fixture-access-secret" };
    send({ id: frame.id, result: { account, requiresOpenaiAuth: true } });
    return;
  }
  if (frame.method === "account/rateLimits/read") {
    if (mode === "rpc-error") {
      process.stderr.write("Bearer fixture-stderr-secret\n");
      send({ id: frame.id, error: { code: -32603, message: "upstream 401 Bearer fixture-error-secret", data: { refreshToken: "fixture-refresh-secret" } } });
      return;
    }
    const limits = mode === "empty" ? {} : { limitId: "codex", limitName: "Codex 漢字", primary: mode === "weekly-only" ? null : primary, secondary, credits: { hasCredits: true, unlimited: false, balance: "12.50", accessToken: "fixture-credit-secret" }, planType: "plus" };
    send({ id: frame.id, result: {
      rateLimits: limits,
      rateLimitsByLimitId: mode === "multi-bucket" ? { codex: limits, extra: { limitId: "extra", primary: { ...primary, usedPercent: 70 } } } : null,
      accountId: "private-account",
      accessToken: "fixture-usage-secret",
      profile: { email: "private-fixture@example.invalid" },
    } });
    return;
  }
  send({ id: frame.id, error: { code: -32601, message: "Unexpected operation" } });
});
process.stdin.on("end", () => { if (!["hang", "stubborn", "tree"].includes(mode)) process.exit(0); });
