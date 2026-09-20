import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

const loaderMatch = html.match(/<script id="webuiBootLoader"[^>]*>([\s\S]*?)<\/script>/);
assert.ok(loaderMatch, "index.html should contain the inline WebUI boot loader");
const loaderSource = loaderMatch[1];

class FakeElement {
  constructor(values = {}) {
    Object.assign(this, values);
    this.listeners = new Map();
    this.hidden ??= true;
    this.value ??= "";
    this.textContent ??= "";
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  focus() {}
  select() { this.selected = true; }
}

class FakeResponse {
  constructor(url, status, { type = "text/plain", text = "", json = null } = {}) {
    this.url = url;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._text = text;
    this._json = json;
    this.headers = { get: (name) => name.toLowerCase() === "content-type" ? type : null };
    this.body = { cancel: async () => {} };
  }

  clone() { return new FakeResponse(this.url, this.status, { type: this.headers.get("content-type"), text: this._text, json: this._json }); }
  async text() { return this._text; }
  async json() { return this._json; }
}

function makeEnvironment({
  importApp,
  stylesheetLoaded = true,
  stylesheetStatus = 200,
  workflowModuleStatus = 404,
  manifestStatus = 200,
  manifestText = '{"name":"Pi Web UI"}',
  hangingHealth = false,
} = {}) {
  const elements = {
    panel: new FakeElement({ hidden: true }),
    reason: new FakeElement(),
    report: new FakeElement({ value: "Collecting diagnostics…" }),
    copy: new FakeElement(),
    reload: new FakeElement(),
    copyStatus: new FakeElement(),
  };
  const styleLink = new FakeElement({ href: "http://127.0.0.1:31415/styles.css?v=154", sheet: stylesheetLoaded ? {} : null });
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  let copied = "";
  let reloaded = false;

  const location = {
    href: "http://127.0.0.1:31415/?pin=SUPERSECRET#private",
    origin: "http://127.0.0.1:31415",
    reload() { reloaded = true; },
  };
  const window = {
    location,
    __PI_WEBUI_BOOT_IMPORT__: importApp,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const document = {
    currentScript: new FakeElement({ dataset: { appSrc: "/app.js?v=184" } }),
    readyState: "complete",
    querySelector(selector) {
      return {
        "#webuiBootFailurePanel": elements.panel,
        "#webuiBootFailureReason": elements.reason,
        "#webuiBootFailureReport": elements.report,
        "#copyWebuiBootFailureReportButton": elements.copy,
        "#reloadWebuiAfterBootFailureButton": elements.reload,
        "#webuiBootFailureCopyStatus": elements.copyStatus,
        'link[rel="stylesheet"]': styleLink,
      }[selector] || null;
    },
    execCommand() { return true; },
  };

  async function fetch(input) {
    const url = String(input);
    if (url.includes("/api/health")) {
      if (hangingHealth) return new Promise(() => {});
      return new FakeResponse(url, 200, { type: "application/json", json: { ok: true, webuiVersion: "0.7.6", remoteAuthPin: "1234" } });
    }
    if (url.includes("/app.js")) return new FakeResponse(url, 200, { type: "text/javascript", text: 'import "./workflow-status-stack.mjs";\nimport "./fast-output-live.mjs";' });
    if (url.includes("workflow-status-stack.mjs")) return new FakeResponse(url, workflowModuleStatus, { type: workflowModuleStatus === 200 ? "text/javascript" : "application/json" });
    if (url.includes("fast-output-live.mjs")) return new FakeResponse(url, 200, { type: "text/javascript" });
    if (url.includes("manifest.webmanifest")) return new FakeResponse(url, manifestStatus, { type: manifestStatus === 200 ? "application/manifest+json" : "text/html", text: manifestText });
    if (url.includes("styles.css")) return new FakeResponse(url, stylesheetStatus, { type: "text/css" });
    return new FakeResponse(url, 404);
  }

  const context = {
    window,
    document,
    navigator: {
      userAgent: "Boot diagnostics test browser",
      clipboard: { async writeText(value) { copied = value; } },
    },
    fetch,
    URL,
    Error,
    Date,
    Promise,
    console,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };

  return {
    context,
    elements,
    listeners,
    timers,
    fireTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    copied: () => copied,
    reloaded: () => reloaded,
  };
}

async function settleAsyncWork() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const missingModule = makeEnvironment({
  importApp: async () => { throw new Error("Failed to fetch dynamically imported module: http://127.0.0.1:31415/workflow-status-stack.mjs?pin=SUPERSECRET"); },
});
vm.runInNewContext(loaderSource, missingModule.context, { filename: "webui-boot-loader.js" });
await settleAsyncWork();
assert.equal(missingModule.elements.panel.hidden, false, "a rejected app import should expose the boot-failure panel");
assert.match(missingModule.elements.report.value, /Pi Web UI startup failure/);
assert.match(missingModule.elements.report.value, /Diagnosis[\s\S]*Summary: Missing startup module: \/workflow-status-stack\.mjs \(HTTP 404\)\./, "the diagnosis should name the actual missing transitive import before the full checks list");
assert.match(missingModule.elements.report.value, /Likely cause: The backend is healthy, but the running server's static asset allowlist is out of sync with app\.js\./);
assert.match(missingModule.elements.report.value, /Browser note: a transitive import failure may be reported as app\.js/);
assert.match(missingModule.elements.report.value, /Failing checks[\s\S]*HTTP 404 application\/json/, "the report should isolate failing probes");
assert.match(missingModule.elements.report.value, /Recheck the failing asset: curl -i http:\/\/127\.0\.0\.1:31415\/workflow-status-stack\.mjs/);
assert.match(missingModule.elements.report.value, /backend health: HTTP 200 application\/json \(ok=true, webuiVersion=0\.7\.6\)/);
assert.equal(missingModule.elements.reason.textContent, "Missing startup module: /workflow-status-stack.mjs (HTTP 404).", "the visible summary should expose the diagnosed file without requiring report inspection");
assert.match(missingModule.elements.report.value, /\/webui-status detailed/);
assert.doesNotMatch(missingModule.elements.report.value, /SUPERSECRET|remoteAuthPin|1234/, "diagnostics must omit URL secrets and unselected health fields");
await missingModule.elements.copy.listeners.get("click")();
assert.equal(missingModule.copied(), missingModule.elements.report.value, "Copy troubleshooting report should copy the complete generated report");
assert.equal(missingModule.elements.copyStatus.textContent, "Troubleshooting report copied.");
missingModule.elements.reload.listeners.get("click")();
assert.equal(missingModule.reloaded(), true, "Reload page should remain available without app.js");

const successfulBoot = makeEnvironment({ importApp: async () => ({}) });
vm.runInNewContext(loaderSource, successfulBoot.context, { filename: "webui-boot-loader.js" });
await settleAsyncWork();
assert.equal(successfulBoot.elements.panel.hidden, true, "a successful app import should keep the failure panel hidden");
assert.equal(successfulBoot.timers.size, 0, "successful startup should cancel the watchdog");
assert.equal(successfulBoot.listeners.has("error"), false, "successful startup should remove temporary global error capture");

const stylesheetFailure = makeEnvironment({ importApp: async () => ({}), stylesheetLoaded: false, stylesheetStatus: 404, workflowModuleStatus: 200 });
vm.runInNewContext(loaderSource, stylesheetFailure.context, { filename: "webui-boot-loader.js" });
await settleAsyncWork();
assert.equal(stylesheetFailure.elements.panel.hidden, false, "a missing critical stylesheet should expose the boot-failure panel");
assert.match(stylesheetFailure.elements.report.value, /Critical stylesheet returned HTTP 404/);

const syntaxFailureWithManifestNoise = makeEnvironment({
  importApp: async () => {
    const error = new Error("Unexpected token '}'");
    error.name = "SyntaxError";
    throw error;
  },
  workflowModuleStatus: 200,
  manifestText: "<!doctype html><title>wrong response</title>",
});
vm.runInNewContext(loaderSource, syntaxFailureWithManifestNoise.context, { filename: "webui-boot-loader.js" });
await settleAsyncWork();
assert.match(syntaxFailureWithManifestNoise.elements.reason.textContent, /JavaScript failed during startup: SyntaxError: Unexpected token/);
assert.match(syntaxFailureWithManifestNoise.elements.report.value, /entry module: HTTP 200 text\/javascript/);
assert.match(syntaxFailureWithManifestNoise.elements.report.value, /optional web manifest: HTTP 200 application\/manifest\+json.*invalid JSON/);
assert.match(syntaxFailureWithManifestNoise.elements.report.value, /web manifest has a separate problem.*does not execute or block app\.js startup/i, "manifest parse noise should be identified as non-blocking");

const stalledBoot = makeEnvironment({
  importApp: async () => new Promise(() => {}),
  workflowModuleStatus: 200,
});
vm.runInNewContext(loaderSource, stalledBoot.context, { filename: "webui-boot-loader.js" });
stalledBoot.fireTimers();
await settleAsyncWork();
assert.match(stalledBoot.elements.reason.textContent, /WebUI startup stalled even though the current HTTP checks succeeded/);
assert.match(stalledBoot.elements.report.value, /Error: Error: Startup watchdog timed out/);

const hangingDiagnostic = makeEnvironment({
  importApp: async () => { throw new Error("Startup module failed before diagnostics"); },
  workflowModuleStatus: 200,
  hangingHealth: true,
});
vm.runInNewContext(loaderSource, hangingDiagnostic.context, { filename: "webui-boot-loader.js" });
await settleAsyncWork();
hangingDiagnostic.fireTimers();
await settleAsyncWork();
assert.equal(hangingDiagnostic.elements.panel.hidden, false, "the failure panel should remain usable while a diagnostic request hangs");
assert.doesNotMatch(hangingDiagnostic.elements.report.value, /Collecting diagnostics/, "bounded probes must always replace the collecting placeholder");
assert.match(hangingDiagnostic.elements.reason.textContent, /diagnostic check timed out while probing \/api\/health/i);
assert.match(hangingDiagnostic.elements.report.value, /backend health: diagnostic timed out after 3 seconds/);

const startupModuleNames = [...new Set([...app.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']\.\/([^"'?]+)(?:\?[^"']*)?["']/g)].map((match) => match[1]))];
assert.ok(startupModuleNames.length >= 1, "the startup-module invariant should discover app.js imports");
for (const moduleName of startupModuleNames) {
  assert.ok(serviceWorker.includes(`"/${moduleName}"`), `the PWA app shell should include every app.js startup module: ${moduleName}`);
}
assert.match(serviceWorker, /pi-webui-pwa-v\d+/, "the app-shell cache should retain a versioned identity");
assert.ok(html.indexOf('id="webuiBootLoader"') < html.indexOf("/app.js?v=184"), "the inline loader should own app module startup");
assert.doesNotMatch(html, /<script type="module" src="\/app\.js/, "the app module should not bypass the guarded loader");

console.log("boot-failure-diagnostics.test.mjs passed");
