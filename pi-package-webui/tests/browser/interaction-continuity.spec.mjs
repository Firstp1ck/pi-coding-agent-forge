import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");

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
let output = "";

async function api(page, pathname, { method = "GET", data } = {}) {
  const response = await page.request.fetch(`${baseURL}${pathname}`, {
    method,
    data,
    headers: data === undefined ? undefined : { "content-type": "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok(), true, `${method} ${pathname} should succeed: ${payload.error || output}`);
  return payload;
}

async function tabIds(page) {
  const payload = await api(page, "/api/tabs");
  return payload.data?.tabs?.map((tab) => tab.id) || [];
}

async function activeTabId(page) {
  return page.locator("#tabBar [role=\"tab\"][aria-selected=\"true\"]").evaluate((node) => node.closest("[data-tab-id]")?.dataset.tabId || "");
}

async function tabClientCount(page, tabId) {
  const payload = await api(page, "/api/tabs");
  return Number(payload.data?.tabs?.find((tab) => tab.id === tabId)?.clientCount || 0);
}

async function startContinuityRunner(page) {
  const tabId = await activeTabId(page) || (await tabIds(page))[0];
  const configured = await api(page, "/api/app-runner-config", {
    method: "POST",
    data: {
      tab: tabId,
      runner: { label: "Continuity runner", command: process.execPath, path: "continuity-runner.mjs" },
    },
  });
  assert.ok(configured.data?.runners?.some((runner) => runner.label === "Continuity runner"), "continuity runner should be available through the public app-runner API");

  await page.locator("#appRunnerMenuButton").click();
  const runner = page.getByRole("menuitem", { name: /Continuity runner/ });
  await expect(runner).toBeVisible();
  await runner.click();
  await expect(page.locator(".app-runner-stdin-input")).toBeVisible();
}

async function triggerDelayedStream(page, tabId = "") {
  const targetTabId = tabId || await activeTabId(page);
  assert.ok(targetTabId, "a visible active terminal tab is required for the delayed stream fixture");
  const beforeLength = (await page.locator("#chat").textContent() || "").length;
  await api(page, `/api/prompt?tab=${encodeURIComponent(targetTabId)}`, {
    method: "POST",
    data: { message: "fixture continuity delayed stream", requestId: `continuity-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  await expect.poll(async () => ((await page.locator("#chat").textContent() || "").length > beforeLength)).toBe(true);
}

async function triggerTranscriptContinuity(page, scenario, tabId = "") {
  const targetTabId = tabId || await activeTabId(page);
  assert.ok(targetTabId, `an active terminal tab is required for the ${scenario} fixture`);
  await api(page, `/api/prompt?tab=${encodeURIComponent(targetTabId)}`, {
    method: "POST",
    data: { message: `fixture transcript continuity ${scenario}`, requestId: `transcript-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
}

async function waitForFixtureSettlement(page, tabId = "") {
  const targetTabId = tabId || await activeTabId(page);
  await expect.poll(async () => (await api(page, `/api/state?tab=${encodeURIComponent(targetTabId)}`)).data?.isStreaming === false).toBe(true);
}

async function selectRenderedText(locator, expected, { backward = false } = {}) {
  return locator.evaluate((root, { text, backwardSelection }) => {
    const fullText = root.textContent || "";
    const start = fullText.indexOf(text);
    if (start < 0) return { text: "", anchorOffset: -1, focusOffset: -1 };
    const point = (targetOffset) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let last = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const next = consumed + node.data.length;
        if (targetOffset < next) return { node, offset: targetOffset - consumed };
        consumed = next;
        last = node;
      }
      return last ? { node: last, offset: last.data.length } : { node: root, offset: root.childNodes.length };
    };
    const offsetFromRoot = (node, offset) => {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(node, offset);
      return range.toString().length;
    };
    const from = point(start);
    const to = point(start + text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (backwardSelection && typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(to.node, to.offset, from.node, from.offset);
    } else {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      selection.addRange(range);
    }
    return {
      text: selection.toString(),
      anchorOffset: offsetFromRoot(selection.anchorNode, selection.anchorOffset),
      focusOffset: offsetFromRoot(selection.focusNode, selection.focusOffset),
    };
  }, { text: expected, backwardSelection: backward });
}

async function textRangeBox(locator, expected) {
  return locator.evaluate((root, text) => {
    const fullText = root.textContent || "";
    const start = fullText.indexOf(text);
    if (start < 0) return null;
    const point = (targetOffset) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let last = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const next = consumed + node.data.length;
        if (targetOffset < next) return { node, offset: targetOffset - consumed };
        consumed = next;
        last = node;
      }
      return last ? { node: last, offset: last.data.length } : null;
    };
    const from = point(start);
    const to = point(start + text.length);
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const box = range.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
  }, expected);
}

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-interaction-continuity-"));
  await writeFile(join(tempRoot, "continuity-runner.mjs"), [
    "let line = 0;",
    "for (let index = 0; index < 30; index += 1) console.log(`continuity output ${++line} ${'x'.repeat(120)}`);",
    "setInterval(() => console.log(`continuity output ${++line} ${'x'.repeat(120)}`), 500);",
    "process.stdin.on('data', () => {});",
    "",
  ].join("\n"));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"),
      FAKE_PI_CONTINUITY_MODE: "1",
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Poll only until the real server and fake Pi fixture are available.
    }
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
});

test.afterAll(async () => {
  if (child?.exitCode === null) {
    await fetch(`${baseURL}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
});

test("main output shows non-blocking inline feedback while transcript data loads", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let releaseMessages;
  const messagesReleased = new Promise((resolve) => { releaseMessages = resolve; });
  let delayedMessagesRequest = false;
  const messagesPattern = "**/api/messages?*";
  await page.route(messagesPattern, async (route) => {
    if (!delayedMessagesRequest) {
      delayedMessagesRequest = true;
      await messagesReleased;
    }
    await route.continue();
  });

  try {
    await page.goto(baseURL);
    const loading = page.locator("#mainOutputLoading");
    const chat = page.locator("#chat");
    await expect(loading).toBeVisible();
    await expect(loading).toContainText("Loading conversation history…");
    await expect(loading).toHaveCSS("pointer-events", "none");
    await expect(chat).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#promptInput")).toBeEnabled();
    assert.equal(await page.evaluate(() => document.querySelectorAll("dialog:modal").length), 0, "loading feedback should not open a popup");
    const loadingChatBounds = await chat.boundingBox();
    const loadingBounds = await loading.boundingBox();
    const footerBounds = await page.locator("#statusBar").boundingBox();
    assert.ok(loadingChatBounds && loadingBounds && footerBounds, "the transcript, loading status, and footer should have measurable bounds");
    assert.ok(loadingBounds.y + loadingBounds.height <= footerBounds.y, "the loading status should sit above the Git footer status");

    releaseMessages();
    await expect(loading).toBeHidden();
    await expect(chat).toHaveAttribute("aria-busy", "false");
    const settledChatBounds = await chat.boundingBox();
    assert.ok(settledChatBounds, "the settled transcript should have measurable bounds");
    assert.equal(settledChatBounds.x, loadingChatBounds.x, "the loading row should not move the transcript horizontally");
    assert.equal(settledChatBounds.width, loadingChatBounds.width, "the loading row should not resize the transcript horizontally");
    assert.equal(settledChatBounds.height, loadingChatBounds.height, "the loading overlay should not resize the transcript");
  } finally {
    releaseMessages?.();
    await page.unroute(messagesPattern);
  }
});

test("only hidden pages disconnect live events and resume from one authoritative snapshot", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const tabId = await activeTabId(page) || (await tabIds(page))[0];
  assert.ok(tabId, "the background catch-up fixture requires an active tab");
  await expect.poll(() => tabClientCount(page, tabId)).toBe(1);

  await page.evaluate(() => {
    window.__backgroundStreamProof = { closeCalls: 0, constructions: 0 };
    const NativeEventSource = window.EventSource;
    const nativeClose = NativeEventSource.prototype.close;
    NativeEventSource.prototype.close = function (...args) {
      window.__backgroundStreamProof.closeCalls += 1;
      return nativeClose.apply(this, args);
    };
    window.EventSource = new Proxy(NativeEventSource, {
      construct(target, args, receiver) {
        window.__backgroundStreamProof.constructions += 1;
        return Reflect.construct(target, args, receiver);
      },
    });
    window.dispatchEvent(new Event("blur"));
  });
  await expect.poll(() => tabClientCount(page, tabId)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__backgroundStreamProof.closeCalls)).toBe(0);

  await page.evaluate(() => {
    window.__backgroundVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__backgroundVisibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => tabClientCount(page, tabId)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__backgroundStreamProof.closeCalls)).toBe(1);

  const completedBefore = await page.locator("#chat .message.assistant", { hasText: "continuity stream complete" }).count();
  await api(page, `/api/prompt?tab=${encodeURIComponent(tabId)}`, {
    method: "POST",
    data: { message: "fixture continuity delayed stream", requestId: `background-catch-up-${Date.now()}` },
  });
  await waitForFixtureSettlement(page, tabId);
  await expect(page.locator("#chat .message.assistant", { hasText: "continuity stream complete" })).toHaveCount(completedBefore);

  const resumedAt = Date.now();
  await page.evaluate(() => {
    window.__backgroundVisibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => tabClientCount(page, tabId)).toBe(1);
  await expect(page.locator("#chat .message.assistant", { hasText: "continuity stream complete" })).toHaveCount(completedBefore + 1);
  const proof = await page.evaluate(() => window.__backgroundStreamProof);
  assert.equal(proof.constructions, 1, "foreground catch-up should create exactly one replacement EventSource");
  assert.ok(Date.now() - resumedAt < 4_000, "the bounded snapshot resume should complete without replaying the hidden stream duration");
});

test("the main input shows six lines before vertical scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);

  const promptInput = page.locator("#promptInput");
  await promptInput.fill(Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n"));
  const sixLines = await promptInput.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      renderedHeight: node.getBoundingClientRect().height,
      lineHeight: style.lineHeight,
      maxHeight: style.maxHeight,
      paddingBlock: `${style.paddingTop} + ${style.paddingBottom}`,
    };
  });
  assert.ok(sixLines.scrollHeight <= sixLines.clientHeight + 1, `six lines overflowed: ${JSON.stringify(sixLines)}`);

  await promptInput.fill(Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n"));
  const sevenLines = await promptInput.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    renderedHeight: node.getBoundingClientRect().height,
  }));
  assert.ok(sevenLines.scrollHeight > sevenLines.clientHeight + 1, "the seventh line should overflow the six-line input height");
  assert.ok(Math.abs(sevenLines.renderedHeight - sixLines.renderedHeight) <= 1, "the prompt should stop growing after six lines");
});

test("autosizing the main input does not move settled agent output", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const outputCard = page.locator("#chat > .message.assistant").last();
  await expect(outputCard).toBeVisible();

  const promptInput = page.locator("#promptInput");
  await expect(page.locator("#chat")).toHaveAttribute("aria-busy", "false");
  const initial = await outputCard.evaluate(async (node) => {
    await document.fonts.ready;
    const started = performance.now();
    let stableSince = started;
    let previous = null;
    while (performance.now() - started < 4_000) {
      if (!node.isConnected) throw new Error("settled output was replaced during startup");
      const current = {
        top: node.getBoundingClientRect().top,
        inputHeight: document.querySelector("#promptInput")?.getBoundingClientRect().height || 0,
        chatHeight: document.querySelector("#chat")?.clientHeight || 0,
        chatScroll: document.querySelector("#chat")?.scrollTop || 0,
      };
      if (!previous || Object.keys(current).some((key) => current[key] !== previous[key])) stableSince = performance.now();
      previous = current;
      // Initial transcript following has a delayed settling pass; measure only after layout stops moving.
      if (performance.now() - stableSince >= 200) return current;
      await new Promise(requestAnimationFrame);
    }
    throw new Error("initial transcript layout did not settle");
  });
  await promptInput.fill("composer stability ".repeat(120));
  await expect.poll(() => promptInput.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(initial.inputHeight + 40);
  const expandedTop = await outputCard.evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(expandedTop - initial.top) <= 1, `agent output moved ${expandedTop - initial.top}px while the composer expanded`);

  await promptInput.fill("short draft");
  await expect.poll(() => promptInput.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(initial.inputHeight + 2);
  const collapsedTop = await outputCard.evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(collapsedTop - initial.top) <= 1, `agent output moved ${collapsedTop - initial.top}px while the composer collapsed`);
});

test("same-context app-runner refresh preserves directional selection, control scroll, and reader scroll mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await startContinuityRunner(page);

  const input = page.locator(".app-runner-stdin-input");
  const draft = Array.from({ length: 24 }, (_, index) => `draft line ${index} ${"q".repeat(90)}`).join("\n");
  await input.fill(draft);
  await input.focus();
  await page.keyboard.press("Control+End");
  for (let index = 0; index < 12; index += 1) await page.keyboard.press("Shift+ArrowLeft");
  const before = await input.evaluate((node) => {
    node.scrollTop = 32;
    node.dispatchEvent(new Event("scroll"));
    return {
      value: node.value,
      selectionStart: node.selectionStart,
      selectionEnd: node.selectionEnd,
      selectionDirection: node.selectionDirection,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  });
  assert.ok(before.scrollTop > 0, `the text-control fixture needs a real nonzero scroll position before the live rerender: ${JSON.stringify(before)}`);

  const terminal = page.locator(".app-runner-widget .release-npm-terminal");
  const initialOutputLines = await terminal.locator(".release-npm-line").count();
  await expect.poll(async () => terminal.locator(".release-npm-line").count()).toBeGreaterThan(initialOutputLines);
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate((node) => ({
    value: node.value,
    selectionStart: node.selectionStart,
    selectionEnd: node.selectionEnd,
    selectionDirection: node.selectionDirection,
    scrollTop: node.scrollTop,
  }))).toEqual({
    value: before.value,
    selectionStart: before.selectionStart,
    selectionEnd: before.selectionEnd,
    selectionDirection: before.selectionDirection,
    scrollTop: before.scrollTop,
  });

  let readerState = null;
  await expect.poll(async () => {
    const candidate = await terminal.evaluate((node) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (maxScrollTop <= 120) return { scrollTop: 0, key: node.dataset.continuityScrollKey || "" };
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      node.scrollTop = Math.max(1, maxScrollTop - 80);
      node.dispatchEvent(new Event("scroll"));
      return { scrollTop: node.scrollTop, key: node.dataset.continuityScrollKey || "" };
    });
    if (candidate.scrollTop > 0) readerState = candidate;
    return candidate.scrollTop;
  }).toBeGreaterThan(0);
  const readerScrollTop = readerState.scrollTop;
  await input.fill("position update");
  await page.getByRole("button", { name: "Send input", exact: true }).click();
  await expect.poll(async () => (await terminal.textContent() || "").includes("# stdin sent (15 chars)")).toBe(true);
  await expect.poll(() => terminal.evaluate((node, expected) => Math.abs(node.scrollTop - expected) <= 1, readerScrollTop)).toBe(true);

  await terminal.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 80 }));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await input.fill("follow update");
  await page.getByRole("button", { name: "Send input", exact: true }).click();
  await expect.poll(async () => (await terminal.textContent() || "").includes("# stdin sent (13 chars)")).toBe(true);
  await expect.poll(() => terminal.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1)).toBe(true);
  const runnerTabId = await activeTabId(page);
  await api(page, "/api/tabs", { method: "POST", data: {} });
  await api(page, `/api/tabs/${encodeURIComponent(runnerTabId)}`, { method: "DELETE" });
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
});

test("unchanged background-tab polling keeps the followed transcript and terminal controls stable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const foregroundTabId = await activeTabId(page) || (await tabIds(page))[0];
  const created = await api(page, "/api/tabs", { method: "POST", data: {} });
  const backgroundTabId = created.data?.tab?.id;
  assert.ok(backgroundTabId && backgroundTabId !== foregroundTabId, "background polling fixture requires a second terminal tab");

  await page.reload();
  await expect.poll(() => activeTabId(page)).toBe(foregroundTabId);
  await expect(page.locator(`[data-tab-id="${backgroundTabId}"] .terminal-tab-button`)).toBeVisible();
  await page.locator(`[data-tab-id="${backgroundTabId}"] .terminal-tab-button`).click();
  await startContinuityRunner(page);
  await page.locator(`[data-tab-id="${foregroundTabId}"] .terminal-tab-button`).click();
  await expect.poll(() => activeTabId(page)).toBe(foregroundTabId);

  // Let the first poll observe the background runner. Subsequent identical
  // snapshots must not rebuild the terminal strip or disturb chat follow.
  await page.waitForTimeout(1700);
  const foregroundButton = await page.locator(`[data-tab-id="${foregroundTabId}"] .terminal-tab-button`).elementHandle();
  assert.ok(foregroundButton, "foreground terminal control should be mounted before stability sampling");
  const movement = await page.locator("#chat").evaluate(async (chat) => {
    const spacer = document.createElement("div");
    spacer.dataset.pollingContinuityFixture = "true";
    spacer.style.height = "3000px";
    chat.append(spacer);
    chat.scrollTop = chat.scrollHeight;
    const positions = [];
    const started = performance.now();
    while (performance.now() - started < 1800) {
      positions.push(chat.scrollTop);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    spacer.remove();
    return Math.max(...positions) - Math.min(...positions);
  });
  assert.equal(await foregroundButton.evaluate((node) => node.isConnected), true, "an unchanged background-tab poll should preserve the existing foreground terminal control");
  expect(movement).toBeLessThanOrEqual(1.5);

  await api(page, `/api/tabs/${encodeURIComponent(backgroundTabId)}`, { method: "DELETE" });
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
});

test("focus reconciliation and terminal switching keep the running status geometry stable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const foregroundTabId = await activeTabId(page) || (await tabIds(page))[0];
  const created = await api(page, "/api/tabs", { method: "POST", data: {} });
  const backgroundTabId = created.data?.tab?.id;
  assert.ok(backgroundTabId && backgroundTabId !== foregroundTabId, "focus continuity requires a second terminal tab");
  await page.reload();
  await expect.poll(() => activeTabId(page)).toBe(foregroundTabId);
  await expect(page.locator(`[data-tab-id="${backgroundTabId}"] .terminal-tab-button`)).toBeVisible();

  await triggerDelayedStream(page, foregroundTabId);
  await waitForFixtureSettlement(page, foregroundTabId);
  await page.waitForTimeout(1500);
  const runIndicator = page.locator("#runIndicatorHost .runIndicator");
  await expect(runIndicator).toBeHidden();

  const focusMovement = await page.locator("#chat").evaluate(async (chat) => {
    chat.style.paddingBottom = "3000px";
    chat.scrollTop = chat.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sticky = document.querySelector("#stickyUserPromptButton");
    window.dispatchEvent(new FocusEvent("focus"));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stickyChildren = [...sticky.children];
    const samples = [];
    window.dispatchEvent(new FocusEvent("focus"));
    const started = performance.now();
    while (performance.now() - started < 800) {
      samples.push({
        gap: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
        stickyStable: stickyChildren.every((node, index) => node === sticky.children[index] && node.isConnected),
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    chat.style.removeProperty("padding-bottom");
    const gaps = samples.map((sample) => sample.gap);
    return {
      gapDrift: Math.max(...gaps) - Math.min(...gaps),
      stickyStable: samples.every((sample) => sample.stickyStable),
    };
  });
  expect(focusMovement.gapDrift).toBeLessThanOrEqual(1.5);
  assert.equal(focusMovement.stickyStable, true, "focus reconciliation should preserve unchanged sticky-prompt children");

  await triggerDelayedStream(page, foregroundTabId);
  await expect(runIndicator).toBeVisible();
  await page.locator(`[data-tab-id="${backgroundTabId}"] .terminal-tab-button`).click();
  await expect.poll(() => activeTabId(page)).toBe(backgroundTabId);
  await page.locator(`[data-tab-id="${foregroundTabId}"] .terminal-tab-button`).click();
  const switchMovement = await page.evaluate(async () => {
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < 900) {
      const indicator = document.querySelector("#runIndicatorHost .runIndicator");
      samples.push({
        connected: indicator?.isConnected === true,
        indicatorTop: indicator?.getBoundingClientRect().top ?? null,
        composerHeight: document.querySelector("#composer")?.getBoundingClientRect().height ?? null,
        contextHeight: document.querySelector("#contextMeterBar")?.getBoundingClientRect().height ?? null,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const visibleSamples = samples.filter((sample) => sample.connected);
    const range = (key) => {
      const values = visibleSamples.map((sample) => sample[key]).filter(Number.isFinite);
      return Math.max(...values) - Math.min(...values);
    };
    return {
      observed: visibleSamples.length >= 5,
      indicatorTop: range("indicatorTop"),
      composerHeight: range("composerHeight"),
      contextHeight: range("contextHeight"),
    };
  });
  assert.equal(switchMovement.observed, true, "the running status should become visible again during the terminal switch");
  expect(switchMovement.indicatorTop).toBeLessThanOrEqual(1.5);
  expect(switchMovement.composerHeight).toBeLessThanOrEqual(1.5);
  expect(switchMovement.contextHeight).toBeLessThanOrEqual(1.5);

  await api(page, `/api/tabs/${encodeURIComponent(backgroundTabId)}`, { method: "DELETE" });
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
});

test("main output text selection survives streaming-tail and settlement rerenders", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const tabId = await activeTabId(page) || (await tabIds(page))[0];
  const priorMessages = (await api(page, `/api/messages?tab=${encodeURIComponent(tabId)}`)).data?.messages;
  assert.ok(Array.isArray(priorMessages), "selection identity needs the authoritative transcript before this run");
  const expectedMessageKey = `m:${priorMessages.length + 1}`;
  await api(page, `/api/prompt?tab=${encodeURIComponent(tabId)}`, {
    method: "POST",
    data: { message: "fixture continuity delayed stream", requestId: `selection-${Date.now()}` },
  });

  const streamingOutput = page.locator(".message.assistant.streaming .streaming-markdown").last();
  await expect(streamingOutput).toContainText("continuity stream");
  const selectedText = "continuity stream";
  assert.equal((await selectRenderedText(streamingOutput, selectedText)).text, selectedText, "the fixture must create a real browser Range inside the streaming main output");
  const originalSurface = await streamingOutput.elementHandle();
  const originalBubble = await streamingOutput.evaluateHandle((node) => node.closest(".message"));
  assert.ok(originalSurface && originalBubble, "the streaming selection needs inspectable source surface and bubble nodes");

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await expect(page.locator(".message.assistant:not(.streaming)").last()).toContainText("continuity stream complete");
  await expect.poll(() => originalSurface.evaluate((node) => node.isConnected), { timeout: 8_000 }).toBe(true);
  await expect.poll(() => originalBubble.evaluate((node) => ({ connected: node.isConnected, streaming: node.classList.contains("streaming"), itemKey: node.dataset.itemKey, messageKey: node.dataset.transcriptMessageKey })), { timeout: 8_000 }).toEqual({ connected: true, streaming: false, itemKey: expectedMessageKey, messageKey: expectedMessageKey });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || ""), { timeout: 8_000 }).toBe(selectedText);
  await waitForFixtureSettlement(page, tabId);
  await delay(4_000);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
});

test("backward normal-output selection keeps its direction through streaming and exact settlement", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "reverse");

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "backward selection literal";
  await expect(output).toContainText(selectedText);
  const selection = await selectRenderedText(output, selectedText, { backward: true });
  assert.equal(selection.text, selectedText, "the browser should create a backward main-output Range");
  assert.ok(selection.anchorOffset > selection.focusOffset, `the fixture requires a backward selection: ${JSON.stringify(selection)}`);
  const originalSurface = await output.elementHandle();
  assert.ok(originalSurface, "the backward Range needs an inspectable streaming surface");

  await expect(output).toContainText("survives");
  await expect.poll(() => originalSurface.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await waitForFixtureSettlement(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    const root = document.querySelector(".message.assistant:not(.streaming) .streaming-markdown:last-child");
    if (!selection || !root || !selection.anchorNode || !selection.focusNode) return false;
    const offset = (node, value) => {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(node, value);
      return range.toString().length;
    };
    return offset(selection.anchorNode, selection.anchorOffset) > offset(selection.focusNode, selection.focusOffset);
  })).toBe(true);
});

test("duplicate assistant text remains selected in its original keyed bubble during suffix reconciliation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const text = "duplicate keyed selection literal";
  await triggerTranscriptContinuity(page, "duplicate");
  const bubbles = page.locator(".message.assistant:not(.streaming)", { hasText: text });
  await expect.poll(() => bubbles.count()).toBeGreaterThan(0);
  await waitForFixtureSettlement(page);
  const originalBubble = bubbles.last();
  const originalSurface = originalBubble.locator(".streaming-markdown");
  const beforeCount = await bubbles.count();
  const key = await originalBubble.getAttribute("data-transcript-message-key");
  assert.ok(key, "duplicate text needs a semantic message key before suffix reconciliation");
  assert.equal((await selectRenderedText(originalSurface, text)).text, text);
  const originalHandle = await originalBubble.elementHandle();
  assert.ok(originalHandle, "the original duplicate-text bubble needs an inspectable DOM identity");

  await triggerTranscriptContinuity(page, "duplicate");
  await expect.poll(() => bubbles.count()).toBeGreaterThan(beforeCount);
  await expect.poll(() => originalHandle.evaluate((node, expectedKey) => node.isConnected && node.dataset.transcriptMessageKey === expectedKey, key)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(text);
  await waitForFixtureSettlement(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(text);
});

test("real pointer drag keeps the selected tail nodes connected until the drag ends", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const previousTabId = await activeTabId(page);
  const created = await api(page, "/api/tabs", { method: "POST", data: {} });
  const pointerTabId = created.data?.tab?.id;
  assert.ok(pointerTabId, "pointer fixture requires an isolated replacement terminal tab");
  await api(page, `/api/tabs/${encodeURIComponent(previousTabId)}`, { method: "DELETE" });
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
  await page.reload();
  await expect.poll(() => activeTabId(page)).toBe(pointerTabId);
  await triggerTranscriptContinuity(page, "pointer", pointerTabId);

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "pointer drag selection literal";
  await expect(output).toContainText(selectedText);
  const outputHandle = await output.elementHandle();
  assert.ok(outputHandle, "the pointer-drag fixture requires an inspectable streaming surface");
  await output.scrollIntoViewIfNeeded();
  const box = await textRangeBox(output, selectedText);
  assert.ok(box, "the pointer-drag fixture needs visible text geometry");
  await page.mouse.move(box.left + 2, (box.top + box.bottom) / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(box.right - 2, (box.top + box.bottom) / 2, { steps: 12 });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toContain("pointer drag selection");
    const anchor = await page.evaluateHandle(() => window.getSelection()?.anchorNode || null);
    const focus = await page.evaluateHandle(() => window.getSelection()?.focusNode || null);
    // The fixture sends its next destructive tail update while this native pointer gesture is held.
    await delay(1_100);
    await expect.poll(() => anchor.evaluate((node) => node?.isConnected === true)).toBe(true);
    await expect.poll(() => focus.evaluate((node) => node?.isConnected === true)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toContain("pointer drag selection");
  } finally {
    // Release outside #chat to prove the window-level gesture cleanup flushes
    // deferred transcript work instead of wedging the live renderer.
    await page.mouse.move(12, 790);
    await page.mouse.up();
  }
  await expect.poll(() => outputHandle.evaluate((node) => node.isConnected && node.textContent?.includes("remains after update") === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toContain("pointer drag selection");
  await waitForFixtureSettlement(page, pointerTabId);
});

test("streaming thinking selection survives a later thinking delta", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "thinking");

  const thinking = page.locator(".message.thinking.streaming .thinking-text").last();
  const selectedText = "thinking selection literal";
  await expect(thinking).toContainText(selectedText);
  assert.equal((await selectRenderedText(thinking, selectedText)).text, selectedText);
  const originalSurface = await thinking.elementHandle();
  assert.ok(originalSurface, "thinking continuity needs an inspectable streaming surface");
  await expect(thinking).toContainText("survives");
  await expect.poll(() => originalSurface.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await waitForFixtureSettlement(page);
  await expect.poll(() => originalSurface.evaluate((node) => node.isConnected)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
});

test("live thinking, assistant output, and tool calls keep chronological tail order", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "order");

  const chat = page.locator("#chat");
  await expect(chat.locator(".message.thinking.streaming").last()).toContainText("ordering thinking");
  await expect(chat.locator(".message.assistant.streaming").last()).toContainText("ordering assistant output");
  await expect.poll(() => chat.evaluate((root) => {
    const messages = [...root.querySelectorAll(":scope > .message")];
    const thinkingIndex = messages.findIndex((message) => message.matches(".thinking.streaming") && message.textContent?.includes("ordering thinking"));
    const outputIndex = messages.findIndex((message) => message.matches(".assistant.streaming") && message.textContent?.includes("ordering assistant output"));
    return thinkingIndex >= 0 && outputIndex > thinkingIndex;
  })).toBe(true);

  const streamingToolCalls = chat.locator(".message.toolCall.streaming", { hasText: "order.txt" });
  await expect(streamingToolCalls.last()).toContainText("order.txt");
  await expect.poll(() => chat.evaluate((root) => {
    const messages = [...root.querySelectorAll(":scope > .message")];
    const thinkingIndex = messages.findIndex((message) => message.matches(".thinking.streaming") && message.textContent?.includes("ordering thinking"));
    const toolIndex = messages.findIndex((message) => message.matches(".toolCall.streaming") && message.textContent?.includes("order.txt"));
    return thinkingIndex >= 0 && toolIndex > thinkingIndex;
  })).toBe(true);
  await page.waitForTimeout(500);
  await expect(streamingToolCalls).toHaveCount(1);
  await expect(chat.locator(".message.thinking.streaming", { hasText: "ordering thinking" })).toHaveCount(1);
  await waitForFixtureSettlement(page);
});

test("thinking visibility change explicitly invalidates a live thinking selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "thinking");
  const thinking = page.locator(".message.thinking.streaming .thinking-text").last();
  const selectedText = "thinking selection literal";
  await expect(thinking).toContainText(selectedText);
  assert.equal((await selectRenderedText(thinking, selectedText)).text, selectedText);
  const originalSurface = await thinking.elementHandle();
  try {
    await page.keyboard.press("Control+t");
    await expect(page.locator("#thinkingVisibilityToggle")).not.toBeChecked();
    await expect.poll(() => originalSurface.evaluate((node) => node.isConnected)).toBe(false);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  } finally {
    if (!(await page.locator("#thinkingVisibilityToggle").isChecked())) await page.keyboard.press("Control+t");
    await expect(page.locator("#thinkingVisibilityToggle")).toBeChecked();
    await waitForFixtureSettlement(page);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  }
});

test("selectable live tool output restores an unchanged range across body reconciliation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "tool");

  const toolBody = page.locator(".message.toolExecution .message-body").last();
  const selectedText = "tool selection literal";
  await expect(toolBody).toContainText("unselected revision one");
  await toolBody.locator(".tool-output-details").evaluate((node) => { node.open = true; });
  assert.equal((await selectRenderedText(toolBody, selectedText)).text, selectedText);
  const bodyHandle = await toolBody.elementHandle();
  assert.ok(bodyHandle, "tool selection continuity needs an inspectable semantic surface");
  await expect(toolBody).toContainText("unselected revision two");
  await expect.poll(() => bodyHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await waitForFixtureSettlement(page);
});

test("expanded live tool output preserves reader scroll and summary focus across updates", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "tool");

  const toolBody = page.locator(".message.toolExecution .message-body").last();
  const details = toolBody.locator(".tool-output-details");
  const output = details.locator(".tool-output-code");
  const summary = details.locator("summary");
  await expect(toolBody).toContainText("unselected revision one");
  await summary.click();
  const scrollState = await output.evaluate((node) => {
    node.scrollTop = Math.min(180, node.scrollHeight - node.clientHeight);
    return { top: node.scrollTop };
  });
  assert.ok(scrollState.top > 0, "the tool fixture must create vertical reader scroll");
  await summary.focus();
  await expect(summary).toBeFocused();

  await expect(toolBody).toContainText("unselected revision two");
  await expect.poll(() => details.evaluate((node) => node.open)).toBe(true);
  await expect.poll(() => output.evaluate((node) => node.scrollTop)).toBe(scrollState.top);
  await expect(summary).toBeFocused();
  await waitForFixtureSettlement(page);
});

test("authoritative divergence clears a stale live-output selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "authoritative");

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "authoritative selection literal";
  await expect(output).toContainText(selectedText);
  assert.equal((await selectRenderedText(output, selectedText)).text, selectedText);
  await expect(page.locator(".message.assistant:not(.streaming)").last()).toContainText("authoritative replacement text");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  await waitForFixtureSettlement(page);
});

test("high-cadence output preserves the selected committed block through burst updates and settlement", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "cadence");

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "high cadence selection literal";
  await expect(output).toContainText(selectedText);
  const committedBlock = output.locator('[data-transcript-block="committed"]').first();
  await expect(committedBlock).toBeVisible();
  const committedHandle = await committedBlock.elementHandle();
  assert.ok(committedHandle, "the cadence fixture requires a committed keyed block");
  assert.equal((await selectRenderedText(output, selectedText)).text, selectedText);
  await expect(output).toContainText("c95");
  await expect.poll(() => committedHandle.evaluate((node) => node.isConnected && node.dataset.transcriptBlock === "committed")).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  await waitForFixtureSettlement(page);
  await expect.poll(() => committedHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
});

test("30-second polling and sustained cadence preserve one committed selection", async ({ page }) => {
  test.setTimeout(50_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "dwell");

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "thirty second selection literal";
  await expect(output).toContainText(selectedText);
  const committedBlock = output.locator('[data-transcript-block="committed"]').first();
  await expect(committedBlock).toBeVisible();
  const outputHandle = await output.elementHandle();
  const committedHandle = await committedBlock.elementHandle();
  assert.ok(outputHandle && committedHandle, "the dwell fixture requires stable surface and committed-block identities");
  assert.equal((await selectRenderedText(output, selectedText)).text, selectedText);
  for (let checkpoint = 0; checkpoint < 6; checkpoint += 1) {
    await delay(5_000);
    await expect.poll(() => committedHandle.evaluate((node) => node.isConnected && node.dataset.transcriptBlock === "committed")).toBe(true);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  }
  await expect.poll(() => outputHandle.evaluate((node) => node.isConnected && node.textContent?.includes("d299") === true)).toBe(true);
  await waitForFixtureSettlement(page);
  await expect.poll(() => committedHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
});

test("output-mode transition explicitly invalidates the prior normal-output selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "mode");
  const normalOutput = page.locator(".message.assistant.streaming .streaming-markdown").last();
  const selectedText = "output mode transition literal";
  await expect(normalOutput).toContainText(selectedText);
  assert.equal((await selectRenderedText(normalOutput, selectedText)).text, selectedText);
  const originalSurface = await normalOutput.elementHandle();
  await expect(page.locator(".message.compact-live-output .compact-live-text").last()).toContainText(selectedText);
  await expect.poll(() => originalSurface.evaluate((node) => node.isConnected)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  await waitForFixtureSettlement(page);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
});

test("Mermaid async rendering leaves selected source nodes connected", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let delayedMermaidRequest = false;
  await page.route("**/vendor/mermaid/**", async (route) => {
    if (!delayedMermaidRequest) {
      delayedMermaidRequest = true;
      await delay(600);
    }
    await route.continue();
  });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "mermaid");

  const source = page.locator(".markdown-mermaid-source code").last();
  await expect(source).toContainText("graph TD");
  await source.evaluate((node) => { node.closest("details").open = true; });
  assert.equal((await selectRenderedText(source, "graph TD")).text, "graph TD");
  const sourceHandle = await source.elementHandle();
  assert.ok(sourceHandle, "Mermaid source selection needs an inspectable source node");
  const diagram = page.locator(".markdown-mermaid-diagram").last();
  await expect(diagram).toHaveClass(/rendered/, { timeout: 15_000 });
  await expect.poll(() => sourceHandle.evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("graph TD");
  await waitForFixtureSettlement(page);
});

test("cross-message selection survives a whole transcript rebuild", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "duplicate");
  await waitForFixtureSettlement(page);
  const surfaces = page.locator(".message.assistant:not(.streaming) .markdown-body");
  await expect.poll(() => surfaces.count()).toBeGreaterThanOrEqual(2);
  const selectedLength = await page.locator("#chat").evaluate((chat) => {
    const outputs = [...chat.querySelectorAll(".message.assistant:not(.streaming) .markdown-body")];
    const textNodes = (root) => {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if ((walker.currentNode.data || "").trim()) nodes.push(walker.currentNode);
      }
      return nodes;
    };
    const startNodes = textNodes(outputs[0]);
    const endNodes = textNodes(outputs.at(-1));
    const startNode = startNodes.at(-1);
    const endNode = endNodes[0];
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startNode.data.length - 8));
    range.setEnd(endNode, Math.min(18, endNode.data.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const textOffset = (surface, node, offset) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(surface);
      prefix.setEnd(node, offset);
      return prefix.toString().length;
    };
    const endpoint = (surface, node, offset) => ({
      itemKey: surface.closest(".message")?.dataset.transcriptMessageKey || surface.closest(".message")?.dataset.itemKey || "",
      surfaceKey: surface.dataset.transcriptSurfaceKey || "",
      offset: textOffset(surface, node, offset),
    });
    window.__crossMessageSelectionText = selection.toString();
    window.__crossMessageSelectionBoundary = {
      start: window.__crossMessageSelectionText.slice(0, 8),
      end: window.__crossMessageSelectionText.slice(-18),
    };
    window.__crossMessageSelectionEndpoints = {
      anchor: endpoint(outputs[0], selection.anchorNode, selection.anchorOffset),
      focus: endpoint(outputs.at(-1), selection.focusNode, selection.focusOffset),
    };
    return window.__crossMessageSelectionText.length;
  });
  assert.ok(selectedLength > 20, "the fixture must create a real cross-message browser Range");

  await page.evaluate(() => {
    const key = "pi-webui-optional-features-disabled";
    const current = JSON.parse(localStorage.getItem(key) || "[]");
    const next = current.includes("bangCommandAutocomplete")
      ? current.filter((id) => id !== "bangCommandAutocomplete")
      : [...current, "bangCommandAutocomplete"];
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });

  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection();
    const current = selection?.toString() || "";
    const anchorSurface = selection?.anchorNode?.parentElement?.closest?.("[data-transcript-surface-key]");
    const focusSurface = selection?.focusNode?.parentElement?.closest?.("[data-transcript-surface-key]");
    const anchorBubble = anchorSurface?.closest(".message");
    const focusBubble = focusSurface?.closest(".message");
    const anchorItemKey = anchorBubble?.dataset.transcriptMessageKey || anchorBubble?.dataset.itemKey || "";
    const focusItemKey = focusBubble?.dataset.transcriptMessageKey || focusBubble?.dataset.itemKey || "";
    return current.length > 20
      && current.startsWith(window.__crossMessageSelectionBoundary.start)
      && current.endsWith(window.__crossMessageSelectionBoundary.end)
      && anchorItemKey === window.__crossMessageSelectionEndpoints.anchor.itemKey
      && focusItemKey === window.__crossMessageSelectionEndpoints.focus.itemKey;
  })).toBe(true);
});

test("individually expanded tool details stay open through transcript rerenders", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  await triggerTranscriptContinuity(page, "tool");
  const details = page.locator(".message.toolExecution .tool-raw-details").last();
  await expect(details).toBeAttached();
  await expect(details).toContainText("unselected revision one");
  const summary = details.locator("summary");
  await details.evaluate((node) => { node.open = true; });
  await expect.poll(() => details.evaluate((node) => node.open)).toBe(true);
  await waitForFixtureSettlement(page);
  const rawOutput = details.locator(".tool-raw-code");
  const scrollTop = await rawOutput.evaluate((node) => {
    node.scrollTop = Math.min(140, node.scrollHeight - node.clientHeight);
    return node.scrollTop;
  });
  assert.ok(scrollTop > 0, "the settled raw-tool fixture must create reader scroll");
  await summary.focus();
  await expect(summary).toBeFocused();

  await page.evaluate(() => {
    const key = "pi-webui-optional-features-disabled";
    const current = JSON.parse(localStorage.getItem(key) || "[]");
    const next = current.includes("bangCommandAutocomplete")
      ? current.filter((id) => id !== "bangCommandAutocomplete")
      : [...current, "bangCommandAutocomplete"];
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });

  await delay(4_000);
  await expect.poll(() => details.evaluate((node) => node.open)).toBe(true);
  await expect.poll(() => rawOutput.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  await expect(summary).toBeFocused();
});

test("same-mode output control preserves settled output selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const output = page.locator(".message.assistant .markdown-body").first();
  const selectedText = "fake answer";
  await expect(output).toContainText(selectedText);
  await waitForFixtureSettlement(page);
  assert.equal((await selectRenderedText(output, selectedText)).text, selectedText);

  await api(page, "/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
});

test("tab navigation clears transcript selection and never restores it into another context", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const initialOutput = page.locator(".message.assistant .markdown-body").first();
  await expect(initialOutput).toContainText("fake answer");
  assert.equal((await selectRenderedText(initialOutput, "fake answer")).text, "fake answer");
  await page.locator("#newTabButton").click();
  await page.locator("#newTabCurrentDirectoryButton").click();
  await expect.poll(async () => (await tabIds(page)).length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  const originalTab = page.locator("#tabBar [role=\"tab\"]").first();
  const originalTabId = await originalTab.evaluate((node) => node.closest("[data-tab-id]")?.dataset.tabId || "");
  await originalTab.click();
  await expect(page.locator("#promptInput")).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  const extraTabId = (await tabIds(page)).find((id) => id !== originalTabId);
  assert.ok(extraTabId, "navigation fixture should create a distinct tab to clean up");
  await api(page, `/api/tabs/${encodeURIComponent(extraTabId)}`, { method: "DELETE" });
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
});

test("semantic tooltip, held pointer, open dropdown, and stale tab contexts survive only when valid", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const initialIds = await tabIds(page);
  assert.equal(initialIds.length, 1, "continuity fixture starts with one terminal tab");

  await page.locator("#newTabButton").click();
  await page.locator("#newTabCurrentDirectoryButton").click();
  await expect.poll(async () => (await tabIds(page)).length).toBe(2);
  await expect(page.locator("#tabBar [role=\"tab\"]")).toHaveCount(2);

  const inactiveTabButton = page.locator("#tabBar [role=\"tab\"][aria-selected=\"false\"]");
  await expect(inactiveTabButton).toBeVisible();
  const inactiveTabId = await inactiveTabButton.evaluate((node) => node.closest("[data-tab-id]")?.dataset.tabId || "");
  assert.ok(inactiveTabId, "the inactive grouped terminal button needs a semantic tab identity");

  await inactiveTabButton.hover();
  const tooltip = page.locator("#footerFloatingTooltip");
  await expect(tooltip).toBeVisible();
  const tooltipKey = await inactiveTabButton.getAttribute("data-tooltip-target-key");
  assert.equal(tooltipKey, `terminal-tab:${inactiveTabId}:switch`, "tooltip continuity must use the tab identity rather than its display text");
  const tooltipText = await inactiveTabButton.getAttribute("data-tooltip");

  await triggerDelayedStream(page);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(tooltipText || "");

  const inactiveTab = page.locator(`[data-tab-id="${inactiveTabId}"]`);
  await inactiveTab.locator(".terminal-tab-close").click();
  await expect.poll(async () => (await tabIds(page)).length).toBe(1);
  await expect(page.locator(`[data-tooltip-target-key="terminal-tab:${inactiveTabId}:switch"]`)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  await page.locator("#newTabButton").click();
  await expect(page.locator("#newTabButton")).toHaveAttribute("aria-expanded", "true");
  await triggerDelayedStream(page);
  await expect(page.locator("#newTabButton")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#newTabMenu")).toHaveClass(/open/);
  await page.locator("#promptInput").click();
  await expect(page.locator("#newTabButton")).toHaveAttribute("aria-expanded", "false");

  await page.locator("#newTabButton").click();
  await page.locator("#newTabCurrentDirectoryButton").click();
  await expect.poll(async () => (await tabIds(page)).length).toBe(2);
  const heldButton = page.locator("#tabBar [role=\"tab\"][aria-selected=\"true\"]");
  await expect(heldButton).toBeVisible();
  await heldButton.hover();
  await page.mouse.down();
  const heldHandle = await heldButton.elementHandle();
  assert.ok(heldHandle, "pointer deferral test needs the active terminal button element");
  await triggerDelayedStream(page);
  await expect.poll(() => heldHandle.evaluate((node) => node.isConnected)).toBe(true);
  await page.mouse.up();
  await expect.poll(() => heldHandle.evaluate((node) => node.isConnected)).toBe(false);

  const secondTabId = await activeTabId(page);
  assert.ok(secondTabId, "an active tab must remain after the pointer-deferred render flush");
  await startContinuityRunner(page);
  const runnerInput = page.locator(".app-runner-stdin-input");
  await runnerInput.fill("stale runner draft");
  await runnerInput.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+ArrowLeft");
  const otherTabButton = page.locator("#tabBar [role=\"tab\"][aria-selected=\"false\"]");
  await expect(otherTabButton).toBeVisible();
  await otherTabButton.click();
  await expect(page.locator("#promptInput")).toBeFocused();
  await expect(page.locator(".app-runner-stdin-input")).toHaveCount(0);
});

test("scrolled transcript stays pixel-stable while the live tail grows", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(baseURL);
  await expect.poll(() => page.locator("#chat .message.user").count()).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator("#chat .message.assistant").count()).toBeGreaterThanOrEqual(1);
  await page.addStyleTag({ content: "#chat .message { min-height: 11rem; }" });
  await triggerTranscriptContinuity(page, "cadence");

  const output = page.locator(".message.assistant.streaming .streaming-markdown").last();
  await expect(output).toContainText("high cadence selection literal");
  const chat = page.locator("#chat");
  const baseline = await chat.evaluate((node) => {
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 120);
    node.dispatchEvent(new Event("scroll"));
    const value = node.scrollTop;
    node.style.removeProperty("scroll-behavior");
    return value;
  });
  assert.ok(baseline > 0, `scroll stability fixture needs a nonzero reader position, got ${baseline}`);

  const samples = await chat.evaluate(async (node) => {
    const values = [];
    setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true })), 100);
    const deadline = performance.now() + 1200;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      const sticky = document.querySelector("#stickyUserPromptButton");
      values.push({
        top: node.scrollTop,
        remaining: node.scrollHeight - node.clientHeight - node.scrollTop,
        autoFollow: document.querySelector("#jumpToLatestButton")?.hidden === true,
        stickyHidden: sticky?.hidden !== false,
        stickyHeight: sticky?.getBoundingClientRect().height || 0,
        children: [...node.children].map((child) => `${child.className}:${Math.round(child.getBoundingClientRect().height)}`),
      });
    }
    return values;
  });
  assert.ok(samples.length > 10, "scroll stability fixture should observe multiple rendered frames");
  const tops = samples.map((sample) => sample.top);
  const drift = Math.max(...tops) - Math.min(...tops);
  assert.ok(drift <= 1, `reader scrollTop must stay stable while output grows; observed ${drift}px drift from ${Math.min(...tops)} to ${Math.max(...tops)}; states ${JSON.stringify(samples.filter((sample, index) => index === 0 || sample.top !== samples[index - 1].top))}`);
  await waitForFixtureSettlement(page);
});

test("compact live output keeps the selected Text node through repeated flushes", async ({ page }) => {
  await api(page, "/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "compact-v1" } });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(baseURL);
    await triggerDelayedStream(page);

    const compactOutput = page.locator(".message.compact-live-output .compact-live-text").last();
    const selectedText = "continuity";
    await expect(compactOutput).toContainText(selectedText);
    assert.equal((await selectRenderedText(compactOutput, selectedText)).text, selectedText);
    const textNode = await compactOutput.evaluateHandle((node) => node.firstChild);
    const surfaceHandle = await compactOutput.elementHandle();
    const bubbleHandle = await compactOutput.locator("xpath=ancestor::article[1]").elementHandle();
    assert.ok(surfaceHandle && bubbleHandle, "compact settlement needs stable surface and bubble identities");
    await expect(compactOutput).toContainText("continuity stream");
    await expect.poll(() => textNode.evaluate((node) => node?.isConnected === true)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
    await waitForFixtureSettlement(page);
    await expect.poll(() => surfaceHandle.evaluate((node) => node.isConnected && node.classList.contains("markdown-body"))).toBe(true);
    await expect.poll(() => bubbleHandle.evaluate((node) => node.isConnected && !node.classList.contains("streaming") && /^m:\d+$/.test(node.dataset.itemKey || ""))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || "")).toBe(selectedText);
  } finally {
    await api(page, "/api/webui-output-mode", { method: "PUT", data: { outputModeDefault: "normal" } });
  }
});

test("submitting a new turn resumes bottom-follow and keeps the streamed tail anchored", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(baseURL);
  await expect.poll(() => page.locator("#chat .message").count()).toBeGreaterThanOrEqual(3);
  await page.addStyleTag({ content: "#chat > .message { min-height: 10rem; }" });

  const chat = page.locator("#chat");
  const pausedRemaining = await chat.evaluate((node) => {
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -180, bubbles: true }));
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 180);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    node.style.removeProperty("scroll-behavior");
    return node.scrollHeight - node.clientHeight - node.scrollTop;
  });
  assert.ok(pausedRemaining > 96, `the fixture must pause above the bottom threshold, got ${pausedRemaining}px`);
  await expect(page.locator("#jumpToLatestButton")).toBeVisible();

  await page.locator("#promptInput").fill("fixture continuity delayed stream");
  await page.locator("#sendButton").click();
  await expect(page.locator("#chat .message.user", { hasText: "fixture continuity delayed stream" }).last()).toBeVisible();
  await expect.poll(() => chat.evaluate((node) => ({
    following: document.querySelector("#jumpToLatestButton")?.hidden === true,
    remaining: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
  }))).toEqual({ following: true, remaining: 0 });

  const streamingOutput = page.locator(".message.assistant.streaming .streaming-markdown").last();
  for (const text of ["continuity", "continuity stream", "continuity stream complete"]) {
    await expect(streamingOutput).toContainText(text);
    await expect.poll(() => chat.evaluate((node) => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))).toBe(0);
  }
  await waitForFixtureSettlement(page);
  await expect.poll(() => chat.evaluate((node) => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))).toBe(0);
});

test("Latest reaches the live edge during a paused transcript reconciliation", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(baseURL);
  await expect.poll(() => page.locator("#chat .message").count()).toBeGreaterThanOrEqual(3);
  await page.addStyleTag({ content: "#chat > .message { min-height: 10rem; }" });

  const chat = page.locator("#chat");
  const pausedRemaining = await chat.evaluate((node) => {
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -180, bubbles: true }));
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 180);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    node.style.removeProperty("scroll-behavior");
    return node.scrollHeight - node.clientHeight - node.scrollTop;
  });
  assert.ok(pausedRemaining > 96, `the fixture must pause above the bottom threshold, got ${pausedRemaining}px`);
  await expect(page.locator("#jumpToLatestButton")).toBeVisible();

  await triggerDelayedStream(page);
  await expect(page.locator("#jumpToLatestButton")).toBeVisible();
  await page.locator("#jumpToLatestButton").click();

  await expect.poll(() => chat.evaluate((node) => ({
    following: document.querySelector("#jumpToLatestButton")?.hidden === true,
    remaining: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop),
  }))).toEqual({ following: true, remaining: 0 });
  await expect(page.locator(".message.assistant.streaming .streaming-markdown").last()).toContainText("continuity");
  await waitForFixtureSettlement(page);
  await expect.poll(() => chat.evaluate((node) => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))).toBe(0);
});
