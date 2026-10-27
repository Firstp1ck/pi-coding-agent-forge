import assert from "node:assert/strict";
import test, { mock } from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fetchPublicPage, pageText } from "../src/public-fetch.ts";

const addresses = async () => [{ address: "93.184.216.34", family: 4 }];
const page = body => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body, bytes: Buffer.byteLength(body) });

test("bundled public reader exposes a concrete bounded page contract without executing page assets", async () => {
  const calls = [];
  const result = await fetchPublicPage("https://example.com/article#fragment", undefined, { resolve: addresses, async request(url, address) {
    calls.push({ url: url.href, address });
    return page('<html><head><script>bad()</script></head><body><h1>Evidence</h1><p>A &amp; B</p><script>ignore()</script><img src="/track"><p>Conditions</p></body></html>');
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, "93.184.216.34");
  assert.equal(result.finalUrl, "https://example.com/article");
  assert.match(result.text, /Evidence/);
  assert.match(result.text, /A & B/);
  assert.ok(!result.text.includes("bad()") && !result.text.includes("ignore()") && !result.text.includes("track"));
  assert.equal(result.truncated, false);
  assert.match(result.accessedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("native HTTPS transport uses pinned address, original TLS/Host identity and no caller credentials", async t => {
  let observed;
  const replacement = mock.method(https, "request", (options, respond) => {
    observed = options;
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from([Buffer.from("<p>Native offline source</p>")]);
      response.statusCode = 200;
      response.headers = { "content-type": "text/html; charset=utf-8" };
      respond(response);
    };
    return req;
  });
  t.after(() => replacement.mock.restore());
  const result = await fetchPublicPage("https://example.com/article?ref=public", undefined, { resolve: addresses });
  assert.match(result.text, /Native offline source/);
  assert.equal(observed.hostname, "93.184.216.34");
  assert.equal(observed.servername, "example.com");
  assert.equal(observed.headers.host, "example.com");
  assert.equal(observed.path, "/article?ref=public");
  assert.equal(observed.method, "GET");
  assert.equal(observed.agent, false);
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers.authorization, undefined);
  await fetchPublicPage("https://93.184.216.34/article", undefined, { resolve: addresses });
  assert.equal(observed.servername, undefined, "IP literals must not be sent as TLS SNI names");
});

test("private URLs, credentials, unsupported schemes and ports never reach the transport", async () => {
  let requests = 0;
  for (const url of ["file:///etc/passwd", "http://localhost/x", "http://127.0.0.1/x", "http://2130706433/x", "http://192.168.1.2/", "https://user:secret@example.com/", "https://[::1]/", "https://example.com:8080/"]) {
    await assert.rejects(fetchPublicPage(url, undefined, { resolve: addresses, request: async () => { requests++; return page("never"); } }));
  }
  assert.equal(requests, 0);
});

test("DNS answers and every redirect are revalidated, with requests pinned to public IPv4", async () => {
  let requests = 0;
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: async () => [{ address: "10.0.0.1", family: 4 }], request: async () => { requests++; return page("never"); } }), /DNS destination/);
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => { requests++; return { status: 302, headers: { location: "http://169.254.169.254/latest/" }, body: "", bytes: 0 }; } }), /Private/);
  assert.equal(requests, 1);
  let lookups = 0;
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: async () => ++lookups === 1 ? addresses() : [{ address: "172.16.0.1", family: 4 }], request: async () => ({ status: 302, headers: { location: "/new" }, body: "", bytes: 0 }) }), /DNS destination/);
  assert.equal(lookups, 2);
});

test("reader bounds redirects, content, bytes and extracted text", async () => {
  let hops = 0;
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => { hops++; return { status: 302, headers: { location: "/again" }, body: "", bytes: 0 }; } }), /redirect limit/);
  assert.equal(hops, 5);
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: "pdf", bytes: 3 }) }), /content type/);
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => page("x".repeat(512001)) }), /exceeds/);
  const result = await fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => page("x".repeat(30000)) });
  assert.equal(result.text.length, 24000);
  assert.equal(result.truncated, true);
});

test("access failures, timeout and caller abort are explicit and do not start another request", async () => {
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { resolve: addresses, request: async () => ({ status: 403, headers: {}, body: "blocked", bytes: 7 }) }), /403/);
  await assert.rejects(fetchPublicPage("https://example.com", undefined, { timeoutMs: 10, resolve: () => new Promise(() => {}), request: async () => page("never") }), /timed out/);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(fetchPublicPage("https://example.com", controller.signal, { resolve: async () => { calls++; return addresses(); }, request: async () => page("never") }));
  assert.equal(calls, 0);
  assert.equal(pageText("<p>One</p><style>hidden</style><p>&#65;</p>").replace(/\s+/g, " ").trim(), "One A");
});
