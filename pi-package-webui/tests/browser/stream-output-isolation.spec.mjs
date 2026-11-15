import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, hostname, release, totalmem } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const deltaCount = 1_000;
const expectedIndexes = Array.from({ length: deltaCount }, (_, index) => index);
const expectedFinalText = expectedIndexes.map((index) => {
  const digit = String(index % 10);
  if (index === 0) return `ISOLATION-TEXT-BEGIN ${digit}`;
  if (index === deltaCount - 1) return `${digit} ISOLATION-TEXT-TAIL`;
  return digit;
}).join("");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child;
let baseURL;
let tempRoot;
let logRoot;
let logFile;
let output = "";

async function serverApi(pathname, { method = "GET", data } = {}) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname} should succeed: ${payload.error || output}`);
  return payload;
}

async function activeTabId(page) {
  return page.locator("#tabBar [role=\"tab\"][aria-selected=\"true\"]").evaluate((node) => node.closest("[data-tab-id]")?.dataset.tabId || "");
}

async function fixtureLogEntries(runId) {
  const text = await readFile(logFile, "utf8").catch(() => "");
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* Ignore only the concurrently appended trailing row. */ }
  }
  return entries.filter((entry) => entry.isolationRunId === runId);
}

async function waitForFixtureLog(runId, predicate) {
  let matching = [];
  await expect.poll(async () => {
    matching = await fixtureLogEntries(runId);
    return predicate(matching);
  }).toBe(true);
  return matching;
}

async function waitForPhase(runId, phase) {
  return waitForFixtureLog(runId, (entries) => entries.some((entry) => entry.direction === "isolation-phase" && entry.isolationPhase === phase));
}

async function assertFixtureContract(runId, mode, scenario = "standard") {
  const entries = await waitForPhase(runId, scenario === "abort" ? "abort-ready" : "settled");
  const textDeltas = entries.filter((entry) => entry.isolationPhase === "raw" && entry.type === "message_update" && entry.assistantMessageEventType === "text_delta" && Number.isInteger(entry.isolationDeltaIndex));
  const expectedCount = scenario === "abort" ? 500 : deltaCount;
  assert.equal(textDeltas.length, expectedCount, `${mode}/${scenario} fixture must emit the expected non-empty text deltas`);
  assert.deepEqual(textDeltas.map((entry) => entry.isolationDeltaIndex), expectedIndexes.slice(0, expectedCount));
  assert.ok(entries.some((entry) => entry.direction === "isolation-phase" && entry.isolationPhase === "raw-start"));
  if (scenario !== "abort") assert.ok(entries.some((entry) => entry.direction === "isolation-phase" && entry.isolationPhase === "raw-end"));
}

async function selectPreservedText(page, { modal = false } = {}) {
  const expected = modal ? "Confirm action" : "fake answer";
  const target = modal
    ? page.locator("#confirmationTitle")
    : page.locator(".message.assistant:not(.streaming) .markdown-body", { hasText: expected }).first();
  await expect(target).toContainText(expected);
  const selected = await target.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = node.data.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }
    return "";
  }, expected);
  assert.equal(selected, expected);
  return expected;
}

async function prepareInteractiveState(page, {
  viewport = { width: 1280, height: 720 },
  modal = false,
  dropdown = false,
  pauseChat = false,
} = {}) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}/?streamIsolationDebug=1`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.addStyleTag({ content: "#chat > .message { min-height: 10rem; }" });

  if (viewport.width >= 700) {
    const sideScroll = await page.locator("#sidePanel .side-panel-body").evaluate((node) => {
      node.scrollTop = Math.min(120, Math.max(0, node.scrollHeight - node.clientHeight));
      return node.scrollTop;
    });
    assert.ok(sideScroll > 0, `desktop proof requires a real side-panel reader position, got ${sideScroll}`);
  }

  if (pauseChat) {
    const pausedTop = await page.locator("#chat").evaluate((node) => {
      node.style.scrollBehavior = "auto";
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
      node.scrollTop = Math.max(1, node.scrollHeight - node.clientHeight - 160);
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
      node.style.removeProperty("scroll-behavior");
      return node.scrollTop;
    });
    assert.ok(pausedTop > 0);
  }

  if (modal) {
    await page.locator("#confirmationDialog").evaluate((dialog) => dialog.showModal());
    await page.locator("#confirmationCancelButton").focus();
    await expect(page.locator("#confirmationDialog")).toHaveAttribute("open", "");
  } else if (dropdown) {
    await page.locator("#newTabButton").click();
    await expect(page.locator("#newTabButton")).toHaveAttribute("aria-expanded", "true");
  } else {
    await page.locator("#promptInput").focus();
  }
  return selectPreservedText(page, { modal });
}

async function installIsolationInstrumentation(page, { pauseChat = false } = {}) {
  await page.evaluate(({ shouldPauseChat }) => {
    const ledger = window.__piStreamIsolationDebug;
    if (!ledger) throw new Error("stream-isolation debug ledger is unavailable");
    for (const key of Object.keys(ledger.counters)) ledger.counters[key] = 0;
    for (const key of ["receivedIndexes", "appliedIndexes", "records", "unknownEvidence"]) ledger[key].length = 0;

    const identitySelectors = [
      "html", "body", "#tabBar", "#newTabMenu", "#newTabButton", "#widgetArea",
      "#feedbackTray", "#statusBar", "#contextMeterBar", "#gitWorkflowPanel", "#composer",
      "#promptInput", "#abortButton", "#steerButton", "#followUpButton", "#sidePanel", "#fileViewerPane", "#eventLog",
      "#confirmationDialog", "#confirmationCancelButton",
    ];
    const describe = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element) return String(node?.nodeName || "unknown");
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.classList?.length ? `.${[...element.classList].slice(0, 3).join(".")}` : ""}`;
    };
    const underTranscript = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.("#chat") !== null;
    const allowedFollowMutation = (record) => record.type === "attributes" && record.attributeName === "hidden" && record.target === document.querySelector("#jumpToLatestButton");
    const allowedElapsedMetadataMutation = (record) => record.type === "childList"
      && record.target?.matches?.("span.run-indicator-meta, span.run-indicator-elapsed[aria-hidden='true']") === true
      && [...record.addedNodes, ...record.removedNodes].every((node) => node.nodeType === Node.TEXT_NODE);
    const scrollNodes = [...document.querySelectorAll("*")].filter((node) => {
      if (node.closest?.("#chat")) return false;
      return node === document.scrollingElement || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth || node.scrollTop !== 0 || node.scrollLeft !== 0;
    });
    if (document.scrollingElement && !scrollNodes.includes(document.scrollingElement)) scrollNodes.push(document.scrollingElement);
    const proof = {
      allowedMutations: { attributes: 0, characterData: 0, childList: 0 },
      allowedFollowMutations: 0,
      allowedElapsedMetadataMutations: 0,
      forbiddenMutations: { attributes: 0, characterData: 0, childList: 0 },
      forbiddenMutationExamples: [],
      focusEvents: [], focusCalls: [], scrollIntoViewCalls: [], fetchCalls: [], eventSourceConstructions: [],
      activeElement: document.activeElement,
      activeElementDescription: describe(document.activeElement),
      selectionText: window.getSelection()?.toString() || "",
      selectionAnchor: window.getSelection()?.anchorNode || null,
      selectionFocus: window.getSelection()?.focusNode || null,
      identities: identitySelectors.map((selector) => ({ selector, node: document.querySelector(selector) })).filter(({ node }) => node),
      scrolls: scrollNodes.map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft, label: describe(node) })),
      chatTop: document.querySelector("#chat")?.scrollTop || 0,
      pauseChat: shouldPauseChat,
    };
    proof.recordMutations = (records) => {
      for (const record of records) {
        if (underTranscript(record.target)) proof.allowedMutations[record.type] += 1;
        else if (allowedFollowMutation(record)) proof.allowedFollowMutations += 1;
        else if (allowedElapsedMetadataMutation(record)) proof.allowedElapsedMetadataMutations += 1;
        else {
          proof.forbiddenMutations[record.type] += 1;
          if (proof.forbiddenMutationExamples.length < 20) proof.forbiddenMutationExamples.push(`${record.type}:${describe(record.target)}:${record.attributeName || ""}`);
        }
      }
    };
    proof.originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) { proof.focusCalls.push(describe(this)); return proof.originalFocus.apply(this, args); };
    proof.originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) { proof.scrollIntoViewCalls.push(describe(this)); return proof.originalScrollIntoView?.apply(this, args); };
    proof.originalFetch = window.fetch;
    window.fetch = function (...args) { proof.fetchCalls.push(String(args[0])); return proof.originalFetch.apply(this, args); };
    proof.originalEventSource = window.EventSource;
    window.EventSource = new Proxy(proof.originalEventSource, {
      construct(target, args, receiver) { proof.eventSourceConstructions.push(String(args[0])); return Reflect.construct(target, args, receiver); },
    });
    proof.onFocus = (event) => proof.focusEvents.push(`${event.type}:${describe(event.target)}`);
    document.addEventListener("focusin", proof.onFocus, true);
    document.addEventListener("focusout", proof.onFocus, true);
    proof.observer = new MutationObserver(proof.recordMutations);
    proof.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__streamIsolationProof = proof;
  }, { shouldPauseChat: pauseChat });
}

async function finishIsolationInstrumentation(page) {
  return page.evaluate(() => {
    const proof = window.__streamIsolationProof;
    proof.recordMutations(proof.observer.takeRecords());
    proof.observer.disconnect();
    document.removeEventListener("focusin", proof.onFocus, true);
    document.removeEventListener("focusout", proof.onFocus, true);
    HTMLElement.prototype.focus = proof.originalFocus;
    Element.prototype.scrollIntoView = proof.originalScrollIntoView;
    window.fetch = proof.originalFetch;
    window.EventSource = proof.originalEventSource;
    const identityChanges = proof.identities.filter(({ selector, node }) => document.querySelector(selector) !== node || !node.isConnected).map(({ selector }) => selector);
    const scrollChanges = proof.scrolls.filter(({ node, top, left }) => node.isConnected && (node.scrollTop !== top || node.scrollLeft !== left)).map(({ label, node, top, left }) => ({ label, before: [top, left], after: [node.scrollTop, node.scrollLeft] }));
    const ledger = window.__piStreamIsolationDebug;
    return {
      allowedMutations: proof.allowedMutations,
      allowedFollowMutations: proof.allowedFollowMutations,
      allowedElapsedMetadataMutations: proof.allowedElapsedMetadataMutations,
      forbiddenMutations: proof.forbiddenMutations,
      forbiddenMutationExamples: proof.forbiddenMutationExamples,
      focusEvents: proof.focusEvents,
      focusCalls: proof.focusCalls,
      scrollIntoViewCalls: proof.scrollIntoViewCalls,
      fetchCalls: proof.fetchCalls,
      eventSourceConstructions: proof.eventSourceConstructions,
      activeElementChanged: document.activeElement !== proof.activeElement,
      activeElementBefore: proof.activeElementDescription,
      activeElementAfter: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id || ""}` : "none",
      identityChanges,
      scrollChanges,
      chatTopBefore: proof.chatTop,
      chatTopAfter: document.querySelector("#chat")?.scrollTop || 0,
      pauseChat: proof.pauseChat,
      selectionBefore: proof.selectionText,
      selectionAfter: window.getSelection()?.toString() || "",
      selectionNodesConnected: proof.selectionAnchor?.isConnected === true && proof.selectionFocus?.isConnected === true,
      debug: {
        counters: { ...ledger.counters },
        receivedIndexes: [...ledger.receivedIndexes],
        appliedIndexes: [...ledger.appliedIndexes],
        records: ledger.records.map((record) => ({ ...record })),
      },
    };
  });
}

function isIndependentPollRequest(value) {
  try {
    return ["/api/tabs", "/api/state", "/api/subagents"].includes(new URL(String(value), baseURL).pathname);
  } catch {
    return false;
  }
}

async function holdIndependentPollResponses(page) {
  const held = [];
  const matcher = /\/api\/(?:tabs|state|subagents)(?:\?|$)/;
  const handler = (route) => { held.push(route); };
  await page.route(matcher, handler);
  return async () => {
    await page.unroute(matcher, handler);
    await Promise.allSettled(held.splice(0).map((route) => route.continue()));
  };
}

function percentileNearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function assertIsolationMetrics(metrics, networkRequests, surface, expectedSelection, expectedIndexCount = deltaCount) {
  assert.deepEqual(metrics.forbiddenMutations, { attributes: 0, characterData: 0, childList: 0 }, `${surface}: ${metrics.forbiddenMutationExamples.join(", ")}`);
  assert.deepEqual(metrics.focusEvents, []);
  assert.deepEqual(metrics.focusCalls, []);
  assert.deepEqual(metrics.scrollIntoViewCalls, []);
  assert.deepEqual(metrics.fetchCalls.filter((url) => !isIndependentPollRequest(url)), [], `${surface}: raw deltas initiated fetch calls`);
  assert.deepEqual(metrics.eventSourceConstructions, []);
  assert.equal(metrics.activeElementChanged, false, `${surface}: active element changed from ${metrics.activeElementBefore} to ${metrics.activeElementAfter}`);
  assert.deepEqual(metrics.identityChanges, []);
  assert.deepEqual(metrics.scrollChanges, []);
  if (metrics.pauseChat) assert.equal(metrics.chatTopAfter, metrics.chatTopBefore);
  assert.equal(metrics.selectionBefore, expectedSelection);
  assert.equal(metrics.selectionAfter, expectedSelection);
  assert.equal(metrics.selectionNodesConnected, true);
  const deltaTriggeredRequests = networkRequests.filter((request) => !isIndependentPollRequest(request.split(" ").slice(1).join(" ")));
  assert.deepEqual(deltaTriggeredRequests, [], `${surface}: raw deltas initiated page requests`);
  assert.ok(Object.values(metrics.allowedMutations).some((count) => count > 0));
  assert.deepEqual(metrics.debug.receivedIndexes, expectedIndexes.slice(0, expectedIndexCount), `${surface}: browser receipt indexes must be complete`);
  assert.deepEqual(metrics.debug.appliedIndexes, expectedIndexes.slice(0, expectedIndexCount), `${surface}: browser application indexes must be complete`);
  assert.ok(metrics.debug.counters.sinkCalls <= 16, `${surface}: controller should batch transcript sinks, got ${metrics.debug.counters.sinkCalls}`);
  assert.ok(metrics.debug.counters.highWaterPendingCount <= 8, `${surface}: pending high-water should remain bounded, got ${metrics.debug.counters.highWaterPendingCount}`);
  assert.equal(metrics.debug.counters.overflows, 0, `${surface}: normal proof must not overflow the bounded accumulator`);
}

async function startFixture(page, mode, scenario = "standard") {
  const tabId = await activeTabId(page);
  const response = await serverApi(`/api/prompt?tab=${encodeURIComponent(tabId)}`, {
    method: "POST",
    data: { message: `fixture stream isolation ${mode} ${scenario}`, requestId: `stream-isolation-${mode}-${scenario}-${Date.now()}` },
  });
  assert.equal(response.data?.deltaCount, deltaCount);
  if (scenario !== "long-transcript") assert.equal(response.data?.finalText, expectedFinalText);
  else {
    assert.equal(response.data?.retainedMessageCount, 1000);
    assert.ok(response.data?.finalText?.startsWith("```js\nconst v0000 = 0;\n"));
    assert.ok(response.data?.finalText?.endsWith("```\nLONG-STREAM-TAIL"));
  }
  await waitForPhase(response.data.runId, "ready");
  await expect(page.locator("#abortButton")).toBeVisible();
  await expect(page.locator(".message.toolExecution").last()).toContainText("read");
  // The fixture does not start raw output until the test sends an explicit
  // steer. Drain independent lifecycle/subagent polls first so the observed
  // window contains only the requested raw stream.
  const waitForRequestPath = (pathname) => new Promise((resolve) => {
    const timer = setTimeout(() => { page.off("requestfinished", onFinished); resolve(); }, 6_000);
    const onFinished = (request) => {
      if (new URL(request.url()).pathname !== pathname) return;
      clearTimeout(timer); page.off("requestfinished", onFinished); resolve();
    };
    page.on("requestfinished", onFinished);
  });
  await Promise.all([waitForRequestPath("/api/tabs"), waitForRequestPath("/api/subagents")]);
  // The optional-feature ready card owns an independent auto-dismiss timer.
  // Synchronize on its semantic end state so it cannot be mistaken for a
  // stream-delta-caused chrome mutation in the observed window.
  await expect(page.locator("#optionalFeatureMigrationSurface")).toBeHidden();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { tabId, runId: response.data.runId, finalText: response.data.finalText, retainedMessageCount: response.data.retainedMessageCount || 0 };
}

async function continueFixture(tabId, runId) {
  await serverApi(`/api/steer?tab=${encodeURIComponent(tabId)}`, {
    method: "POST",
    data: { message: `fixture stream isolation continue ${runId}` },
  });
}

async function waitForRawDrain(page, runId, expectedCount = deltaCount) {
  await waitForPhase(runId, expectedCount === deltaCount ? "raw-end" : "abort-ready");
  await expect.poll(() => page.evaluate(() => window.__piStreamIsolationDebug?.appliedIndexes?.length || 0)).toBe(expectedCount);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForSettlement(page, tabId) {
  await expect.poll(async () => (await serverApi(`/api/state?tab=${encodeURIComponent(tabId)}`)).data?.isStreaming).toBe(false);
  const settled = page.locator(".message.assistant:not(.streaming) .markdown-body", { hasText: "ISOLATION-TEXT-TAIL" }).last();
  await expect(settled).toContainText("ISOLATION-TEXT-BEGIN");
  assert.equal((await settled.textContent()).trim(), expectedFinalText);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-stream-isolation-"));
  logRoot = await mkdtemp(join(tmpdir(), "pi-webui-stream-isolation-log-"));
  logFile = join(logRoot, "fake-pi.jsonl");
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEBUI_RPC_SUPERVISOR: "0", PI_CODING_AGENT_DIR: join(tempRoot, "agent"), PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"), FAKE_PI_LOG_FILE: logFile, FAKE_PI_STREAM_ISOLATION: "1" },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
});

test.afterAll(async () => {
  if (child?.exitCode === null) { const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
  await Promise.all([rm(tempRoot, { recursive: true, force: true }), rm(logRoot, { recursive: true, force: true })]);
});

async function runIsolationCase(page, { mode, viewport, modal = false, dropdown = false, pauseChat = false, label }) {
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: mode === "compact" ? "compact-v1" : "normal" } });
  const expectedSelection = await prepareInteractiveState(page, { viewport, modal, dropdown, pauseChat });
  const { tabId, runId } = await startFixture(page, mode);
  const releaseIndependentPolls = await holdIndependentPollResponses(page);
  const networkRequests = [];
  const onRequest = (request) => networkRequests.push(`${request.method()} ${request.url()}`);
  page.on("request", onRequest);
  await installIsolationInstrumentation(page, { pauseChat });
  await continueFixture(tabId, runId);
  await waitForPhase(runId, "raw-start");
  await waitForPhase(runId, "text-complete");
  if (mode === "normal") {
    await expect(page.locator(".message.assistant.streaming .streaming-markdown").last()).toContainText("ISOLATION-TEXT-TAIL");
  } else {
    await expect(page.locator(".message.compact-live-output .compact-live-text").last()).toContainText("ISOLATION-TEXT-TAIL");
  }
  await waitForRawDrain(page, runId);
  if (mode === "normal") {
    await expect(page.locator(".message.toolExecution").last()).toContainText("ISOLATION-TOOL-UPDATE-COMPLETE");
  } else {
    await expect(page.locator(".compact-tool-shell")).toHaveCount(0);
    await expect(page.locator("#chat")).not.toContainText("ISOLATION-TOOL-UPDATE-COMPLETE");
  }
  const metrics = await finishIsolationInstrumentation(page);
  page.off("request", onRequest);
  await releaseIndependentPolls();
  console.log(`stream-output-isolation raw metrics ${JSON.stringify({
    mode,
    label,
    ...metrics,
    debug: {
      counters: metrics.debug.counters,
      receivedCount: metrics.debug.receivedIndexes.length,
      appliedCount: metrics.debug.appliedIndexes.length,
    },
    networkRequests,
  })}`);
  assertIsolationMetrics(metrics, networkRequests, label, expectedSelection);
  if (mode === "compact") {
    await waitForPhase(runId, "tool-complete");
    await expect(page.locator(".compact-tool-shell .compact-tool-status").last()).toHaveText("done");
  }
  await waitForSettlement(page, tabId);
  await assertFixtureContract(runId, mode);
}

test("desktop normal stream output isolation", async ({ page }) => runIsolationCase(page, { mode: "normal", viewport: { width: 1280, height: 720 }, dropdown: true, label: "desktop-normal" }));
test("desktop compact isolation preserves paused reader and modal", async ({ page }) => runIsolationCase(page, { mode: "compact", viewport: { width: 1280, height: 720 }, modal: true, pauseChat: true, label: "desktop-compact" }));
test("mobile 390x844 normal isolation", async ({ page }) => runIsolationCase(page, { mode: "normal", viewport: { width: 390, height: 844 }, label: "mobile-390" }));
test("mobile 320x568 compact isolation", async ({ page }) => runIsolationCase(page, { mode: "compact", viewport: { width: 320, height: 568 }, pauseChat: true, label: "mobile-320" }));

test("Chromium streaming baseline: hidden output reconciles exactly on foreground", async ({ page }) => {
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  const expectedSelection = await prepareInteractiveState(page, { viewport: { width: 1280, height: 720 }, pauseChat: true });
  const completed = page.locator(".message.assistant:not(.streaming) .markdown-body", { hasText: "ISOLATION-TEXT-TAIL" });
  const completedBefore = await completed.count();
  const { tabId, runId } = await startFixture(page, "normal", "background");
  const before = await page.evaluate(() => ({
    activeElement: document.activeElement?.id || "",
    selection: window.getSelection()?.toString() || "",
    chatTop: document.querySelector("#chat")?.scrollTop || 0,
  }));

  await page.evaluate(() => {
    window.__ws0VisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__ws0VisibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  await continueFixture(tabId, runId);
  await waitForPhase(runId, "settled");
  await expect(completed).toHaveCount(completedBefore);

  await page.evaluate(() => {
    window.__ws0VisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(completed).toHaveCount(completedBefore + 1);
  await waitForSettlement(page, tabId);
  const after = await page.evaluate(() => {
    const selection = window.getSelection();
    return {
      activeElement: document.activeElement?.id || "",
      selection: selection?.toString() || "",
      selectionConnected: selection?.anchorNode?.isConnected === true && selection?.focusNode?.isConnected === true,
      chatTop: document.querySelector("#chat")?.scrollTop || 0,
    };
  });
  assert.equal(before.activeElement, "promptInput");
  assert.equal(after.activeElement, before.activeElement, "foreground reconciliation must preserve composer focus");
  assert.equal(after.selection, expectedSelection, "foreground reconciliation must preserve exact selected text");
  assert.equal(after.selectionConnected, true);
  assert.equal(after.chatTop, before.chatTop, "foreground reconciliation must preserve detached scroll position exactly");
  await assertFixtureContract(runId, "normal", "background");
});

test("abort flushes and preserves the partial text tail before lifecycle chrome settles", async ({ page }) => {
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  const expectedSelection = await prepareInteractiveState(page, { viewport: { width: 1280, height: 720 } });
  const { tabId, runId } = await startFixture(page, "normal", "abort");
  const indicator = await page.locator(".run-indicator-message").elementHandle();
  const releaseIndependentPolls = await holdIndependentPollResponses(page);
  const requests = [];
  const onRequest = (request) => requests.push(`${request.method()} ${request.url()}`);
  page.on("request", onRequest);
  await installIsolationInstrumentation(page);
  await continueFixture(tabId, runId);
  await waitForRawDrain(page, runId, 500);
  await expect(page.locator(".message.assistant.streaming .streaming-markdown").last()).toContainText("ISOLATION-TEXT-BEGIN");
  const metrics = await finishIsolationInstrumentation(page);
  page.off("request", onRequest);
  await releaseIndependentPolls();
  assertIsolationMetrics(metrics, requests, "abort-partial", expectedSelection, 500);
  const barriersBeforeAbort = await page.evaluate(() => window.__piStreamIsolationDebug?.counters?.barriers || 0);
  assert.equal(await indicator.evaluate((node) => node.isConnected), true, "wording updates must retain the run-indicator node");
  const abortButton = page.locator("#abortButton");
  await abortButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(3_200);
  await page.mouse.up();
  await expect.poll(async () => (await serverApi(`/api/state?tab=${encodeURIComponent(tabId)}`)).data?.isStreaming).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__piStreamIsolationDebug?.counters?.barriers || 0)).toBeGreaterThan(barriersBeforeAbort);
  await expect(page.locator("#abortButton")).toBeHidden();
  await assertFixtureContract(runId, "normal", "abort");
});

test("retry compaction reconnect and settlement retain lifecycle control identity", async ({ page }) => {
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  const expectedSelection = await prepareInteractiveState(page, { viewport: { width: 1280, height: 720 } });
  const { tabId, runId } = await startFixture(page, "normal", "lifecycle");
  const indicator = await page.locator(".run-indicator-message").elementHandle();
  const abort = await page.locator("#abortButton").elementHandle();
  const steer = await page.locator("#steerButton").elementHandle();
  const followUp = await page.locator("#followUpButton").elementHandle();
  const releaseIndependentPolls = await holdIndependentPollResponses(page);
  const requests = [];
  const onRequest = (request) => requests.push(`${request.method()} ${request.url()}`);
  page.on("request", onRequest);
  await installIsolationInstrumentation(page);
  await continueFixture(tabId, runId);
  await waitForRawDrain(page, runId);
  const metrics = await finishIsolationInstrumentation(page);
  page.off("request", onRequest);
  await releaseIndependentPolls();
  assertIsolationMetrics(metrics, requests, "lifecycle-raw", expectedSelection);
  const barriersBeforeLifecycle = await page.evaluate(() => window.__piStreamIsolationDebug?.counters?.barriers || 0);
  await continueFixture(tabId, runId);
  await waitForPhase(runId, "lifecycle-complete");
  await expect.poll(() => page.evaluate(() => window.__piStreamIsolationDebug?.counters?.barriers || 0)).toBeGreaterThanOrEqual(barriersBeforeLifecycle + 4);
  assert.equal(await indicator.evaluate((node) => node.isConnected), true);
  assert.equal(await abort.evaluate((node) => node.isConnected && !node.hidden), true);
  assert.equal(await steer.evaluate((node) => node.isConnected && !node.hidden && !node.disabled), true);
  assert.equal(await followUp.evaluate((node) => node.isConnected && !node.hidden && !node.disabled), true);
  await waitForSettlement(page, tabId);
  await expect(page.locator("#abortButton")).toBeHidden();
  await expect(page.locator("#steerButton")).toBeHidden();
  await expect(page.locator("#followUpButton")).toBeHidden();
  assert.equal(await steer.evaluate((node) => node.isConnected), true, "Steer must retain node identity through settlement");
  assert.equal(await followUp.evaluate((node) => node.isConnected), true, "Follow-up must retain node identity through settlement");
});

test("WS3 paced cadence and slow-renderer queue pressure remain bounded", async ({ page }) => {
  test.setTimeout(120_000);
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  const expectedSelection = await prepareInteractiveState(page, { viewport: { width: 1280, height: 720 }, pauseChat: true });
  const { tabId, runId, finalText } = await startFixture(page, "normal", "paced-pressure");
  const releaseIndependentPolls = await holdIndependentPollResponses(page);
  const networkRequests = [];
  const onRequest = (request) => networkRequests.push(`${request.method()} ${request.url()}`);
  page.on("request", onRequest);
  await installIsolationInstrumentation(page, { pauseChat: true });
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    window.__ws3OriginalRequestAnimationFrame = original;
    window.requestAnimationFrame = (callback) => original((timestamp) => {
      const deadline = performance.now() + 8;
      while (performance.now() < deadline) { /* deterministic slow-renderer pressure */ }
      callback(timestamp);
    });
  });

  await continueFixture(tabId, runId);
  await waitForPhase(runId, "text-complete");
  await expect.poll(() => page.evaluate(() => window.__piStreamIsolationDebug?.appliedIndexes?.length || 0)).toBe(deltaCount);
  const liveMarkdown = page.locator(".message.assistant.streaming .streaming-markdown").last();
  await expect(liveMarkdown).toContainText("ISOLATION-TEXT-TAIL");
  assert.equal((await liveMarkdown.textContent()).trim(), finalText, "paced pressure must end on the authoritative exact snapshot");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const metrics = await finishIsolationInstrumentation(page);
  await page.evaluate(() => {
    if (window.__ws3OriginalRequestAnimationFrame) window.requestAnimationFrame = window.__ws3OriginalRequestAnimationFrame;
    delete window.__ws3OriginalRequestAnimationFrame;
  });
  page.off("request", onRequest);
  await releaseIndependentPolls();

  assert.deepEqual(metrics.forbiddenMutations, { attributes: 0, characterData: 0, childList: 0 }, metrics.forbiddenMutationExamples.join(", "));
  assert.deepEqual(metrics.focusEvents, []);
  assert.deepEqual(metrics.focusCalls, []);
  assert.equal(metrics.activeElementChanged, false);
  assert.deepEqual(metrics.identityChanges, []);
  assert.deepEqual(metrics.scrollChanges, []);
  assert.equal(metrics.chatTopAfter, metrics.chatTopBefore, "slow rendering must not move a detached reader");
  assert.equal(metrics.selectionBefore, expectedSelection);
  assert.equal(metrics.selectionAfter, expectedSelection);
  assert.equal(metrics.selectionNodesConnected, true);
  assert.deepEqual(metrics.debug.receivedIndexes, expectedIndexes);
  assert.deepEqual(metrics.debug.appliedIndexes, expectedIndexes);
  assert.deepEqual(networkRequests.filter((request) => !isIndependentPollRequest(request.split(" ").slice(1).join(" "))), []);

  const counters = metrics.debug.counters;
  assert.ok(counters.renderSchedulerFlushes > 2, "paced output must exercise sustained normal formatting");
  assert.ok(counters.renderSchedulerDefers > 0, "paced output must defer at least one latest-wins render");
  assert.ok(counters.renderSchedulerFlushes < counters.appliedEvents, "formatting publishes must remain below applied transport sources");
  assert.ok(counters.pressureDeferred > 0, "the first queue-pressure drain must leave the EventSource callback");
  assert.ok(counters.pressureSynchronousFallbacks > 0, "repeated same-task pressure must exercise the synchronous lossless fallback");
  assert.ok(counters.highWaterPendingCount <= 129, `primary plus urgent entry should cap at 129, got ${counters.highWaterPendingCount}`);
  assert.ok(counters.highWaterPendingBytes <= 2 * 256 * 1024, "primary plus urgent bytes must remain explicitly bounded");
  assert.equal(counters.focusLossNearStreamBatch, 0);
  assert.equal(counters.detachedScrollMoves, 0);

  const records = metrics.debug.records;
  const paintMs = records.filter((record) => record.type === "paint-opportunity").map((record) => Number(record.ms)).filter(Number.isFinite);
  const longTaskMs = records.filter((record) => record.type === "longtask").map((record) => Number(record.ms)).filter(Number.isFinite);
  const longFrameMs = records.filter((record) => record.type === "long-animation-frame").map((record) => Number(record.ms)).filter(Number.isFinite);
  console.log(`WS3_STREAMING_CANDIDATE ${JSON.stringify({
    scenario: {
      sourceIndexedTextDeltas: deltaCount,
      finalTextBytesUtf8: Buffer.byteLength(finalText),
      finalTextSha256: createHash("sha256").update(finalText).digest("hex"),
      injectedFrameDelayMs: 8,
      selectedCadenceMs: 40,
    },
    eventAndRenderCounts: {
      receivedEvents: counters.receivedEvents,
      appliedEvents: counters.appliedEvents,
      sinkCalls: counters.sinkCalls,
      controllerBatches: counters.batches,
      renderSchedulerFlushes: counters.renderSchedulerFlushes,
      renderSchedulerDefers: counters.renderSchedulerDefers,
      markdownCommits: counters.markdownCommits,
    },
    pressure: {
      overflows: counters.overflows,
      deferred: counters.pressureDeferred,
      synchronousFallbacks: counters.pressureSynchronousFallbacks,
      queueHighWaterEntries: counters.highWaterPendingCount,
      queueHighWaterBytes: counters.highWaterPendingBytes,
    },
    receiptToPaintMs: {
      samples: paintMs.length,
      p95: percentileNearestRank(paintMs, 0.95),
      max: paintMs.length ? Math.max(...paintMs) : null,
    },
    longestMs: {
      batchDrain: counters.batchDrainMaxMs,
      markdownCommit: counters.markdownCommitMaxMs,
      longTask: longTaskMs.length ? Math.max(...longTaskMs) : null,
      longAnimationFrame: longFrameMs.length ? Math.max(...longFrameMs) : null,
    },
    continuity: {
      focusLossNearStreamBatch: counters.focusLossNearStreamBatch,
      detachedScrollMoves: counters.detachedScrollMoves,
    },
  })}`);

  await waitForSettlement(page, tabId);
  await assertFixtureContract(runId, "normal", "paced-pressure");
});

test("Chromium streaming baseline: long transcript plus active fenced stream", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await serverApi("/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseURL}/?streamIsolationDebug=1`);
  await expect(page.locator("#promptInput")).toBeVisible();
  const initialTabId = await activeTabId(page);
  const populated = await serverApi(`/api/prompt?tab=${encodeURIComponent(initialTabId)}`, {
    method: "POST",
    data: { message: "fixture stream isolation populate long transcript", requestId: `stream-isolation-populate-${Date.now()}` },
  });
  assert.equal(populated.data?.retainedMessageCount, 1000);

  // Load the deterministic retained transcript before the active stream starts.
  await page.reload();
  await expect(page.locator("#promptInput")).toBeVisible();
  const retained = page.locator("#chat .message", { hasText: /LONG-TRANSCRIPT-\d{4}/ });
  await expect(retained).toHaveCount(1000);
  await expect(retained.first()).toContainText("LONG-TRANSCRIPT-0000");
  await expect(retained.last()).toContainText("LONG-TRANSCRIPT-0999");
  const { tabId, runId, finalText, retainedMessageCount } = await startFixture(page, "normal", "long-transcript");
  assert.equal(retainedMessageCount, 1000);

  const pausedTop = await page.locator("#chat").evaluate((node) => {
    node.style.scrollBehavior = "auto";
    node.scrollTop = Math.max(1, Math.floor((node.scrollHeight - node.clientHeight) / 3));
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    node.style.removeProperty("scroll-behavior");
    return node.scrollTop;
  });
  assert.ok(pausedTop > 0, "long-transcript baseline requires a detached reader position");
  await page.locator("#promptInput").focus();
  const expectedSelection = await selectPreservedText(page);
  const releaseIndependentPolls = await holdIndependentPollResponses(page);
  const networkRequests = [];
  const onRequest = (request) => networkRequests.push(`${request.method()} ${request.url()}`);
  page.on("request", onRequest);
  await installIsolationInstrumentation(page, { pauseChat: true });
  await continueFixture(tabId, runId);
  await waitForPhase(runId, "raw-start");
  await waitForPhase(runId, "text-complete");
  await expect.poll(() => page.evaluate(() => window.__piStreamIsolationDebug?.appliedIndexes?.length || 0)).toBe(deltaCount);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // The Markdown renderer intentionally omits the delimiter-adjacent trailing
  // newline from the code text node; every source character before it remains
  // exact and the authoritative raw-output hash below covers the full string.
  const expectedCode = finalText.slice("```js\n".length, finalText.lastIndexOf("```\n")).replace(/\n$/, "");
  const liveMarkdown = page.locator(".message.assistant.streaming .streaming-markdown").last();
  await expect(liveMarkdown).toContainText("LONG-STREAM-TAIL");
  assert.equal(await liveMarkdown.locator("code").textContent(), expectedCode, "live fenced source must remain exact");

  const metrics = await finishIsolationInstrumentation(page);
  page.off("request", onRequest);
  await releaseIndependentPolls();
  assertIsolationMetrics(metrics, networkRequests, "long-transcript-active-stream", expectedSelection);
  assert.equal(metrics.debug.counters.focusLossNearStreamBatch, 0);
  assert.equal(metrics.debug.counters.detachedScrollMoves, 0);
  assert.ok(metrics.debug.counters.transcriptNodeMax >= 1000, "node ledger must observe the retained transcript");
  assert.ok(metrics.debug.counters.currentMessageNodeMax > 0, "node ledger must observe the active stream");
  assert.ok(metrics.debug.counters.deriveCalls > 0, "derived-text diagnostics must be exercised");
  assert.ok(metrics.debug.counters.markdownCommits > 0, "Markdown diagnostics must be exercised");
  assert.equal(metrics.debug.counters.tokenizeCalls, 1, "the live open fence must skip accumulated syntax tokenization and highlight authoritatively once");

  const records = metrics.debug.records;
  const markdownRecords = records.filter((record) => record.type === "markdown-commit");
  const tokenizeRecords = records.filter((record) => record.type === "tokenize");
  const boundaryScannedChars = markdownRecords.reduce((sum, record) => sum + (Number(record.boundaryScannedChars) || 0), 0);
  assert.equal(tokenizeRecords.length, 1, "only the authoritative fence close/completion may invoke the tokenizer");
  assert.ok(boundaryScannedChars <= finalText.length, "incremental boundary work must not rescan the committed prefix");
  const paintMs = records.filter((record) => record.type === "paint-opportunity").map((record) => Number(record.ms)).filter(Number.isFinite);
  const markdownMs = markdownRecords.map((record) => Number(record.ms)).filter(Number.isFinite);
  const tokenizeMs = tokenizeRecords.map((record) => Number(record.ms)).filter(Number.isFinite);
  const longTaskMs = records.filter((record) => record.type === "longtask").map((record) => Number(record.ms)).filter(Number.isFinite);
  const longFrameMs = records.filter((record) => record.type === "long-animation-frame").map((record) => Number(record.ms)).filter(Number.isFinite);
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  }));
  const counters = metrics.debug.counters;
  const baseline = {
    scenario: { retainedMessages: retainedMessageCount, sourceDeltaEvents: deltaCount, finalTextBytesUtf8: Buffer.byteLength(finalText), finalTextSha256: createHash("sha256").update(finalText).digest("hex") },
    eventAndBatchCounts: { receivedEvents: counters.receivedEvents, appliedEvents: counters.appliedEvents, sinkCalls: counters.sinkCalls, batches: counters.batches, barriers: counters.barriers, overflows: counters.overflows },
    receiptToPaintMs: { samples: paintMs.length, p50: percentileNearestRank(paintMs, 0.50), p95: percentileNearestRank(paintMs, 0.95), max: paintMs.length ? Math.max(...paintMs) : null },
    longestCostsMs: { batchReceiptAge: counters.batchLatencyMaxMs, batchDrain: counters.batchDrainMaxMs, derive: counters.deriveMaxMs, tokenize: counters.tokenizeMaxMs, markdownCommit: counters.markdownCommitMaxMs, longTask: longTaskMs.length ? Math.max(...longTaskMs) : null, longAnimationFrame: longFrameMs.length ? Math.max(...longFrameMs) : null },
    costInputs: { deriveCalls: counters.deriveCalls, deriveMaxBytes: counters.deriveMaxBytes, tokenizeCalls: counters.tokenizeCalls, tokenizeMaxBytes: counters.tokenizeMaxBytes, markdownCommits: counters.markdownCommits, tailMaxBytes: counters.tailMaxBytes },
    queueHighWater: { entries: counters.highWaterPendingCount, bytes: counters.highWaterPendingBytes },
    nodeMax: { transcript: counters.transcriptNodeMax, currentMessage: counters.currentMessageNodeMax },
    continuity: { focusLossNearStreamBatch: counters.focusLossNearStreamBatch, detachedScrollMoves: counters.detachedScrollMoves },
    environment: {
      browserName: "chromium",
      browserVersion: browser.version(),
      ...environment,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      hostname: hostname(),
      kernelRelease: release(),
      cpuModel: cpus()[0]?.model || "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
  };
  console.log(`WS0_STREAMING_BASELINE ${JSON.stringify(baseline)}`);
  console.log(`WS2_STREAMING_CANDIDATE ${JSON.stringify({
    ...baseline,
    incrementalMarkdown: {
      boundaryScannedChars,
      tokenizeCalls: tokenizeRecords.length,
      authoritativeCommits: markdownRecords.filter((record) => record.authoritative).length,
      reusedTailCommits: markdownRecords.filter((record) => record.reusedTail).length,
      markdownTotalMs: markdownMs.reduce((sum, value) => sum + value, 0),
      tokenizeTotalMs: tokenizeMs.reduce((sum, value) => sum + value, 0),
    },
  })}`);

  await expect.poll(
    async () => (await serverApi(`/api/state?tab=${encodeURIComponent(tabId)}`)).data?.isStreaming,
    { timeout: 30_000 },
  ).toBe(false);
  const settled = page.locator(".message.assistant:not(.streaming) .markdown-body", { hasText: "LONG-STREAM-TAIL" }).last();
  await expect(settled).toContainText("LONG-STREAM-TAIL");
  assert.equal(await settled.locator("code").textContent(), expectedCode, "settled fenced source must remain exact");
  await assertFixtureContract(runId, "normal", "long-transcript");
});
