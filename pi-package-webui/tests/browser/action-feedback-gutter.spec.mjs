import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Touch layouts keep reactions visible and need a strip below the text. Desktop
// reactions appear on hover and must preserve the original message height.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");

// Long enough to wrap to the full bubble width several times, so the last line reaches
// the right edge where the controls sit. Three paragraphs and a short closing line.
const TRANSCRIPT = [
  {
    role: "user",
    content: "Fixture gutter prompt",
    timestamp: 1_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "The layout pass moves the reserved strip into the message bubble instead of the header, so the transcript keeps a stable height while the reaction controls stay pinned to the bottom-right corner of the card and never expand it.",
          "Measurements come from the rendered controls, not from a guessed constant: the button row is forty pixels tall on a narrow touch viewport and forty-three pixels on a desktop viewport, and the controls keep their own bottom offset inside the bubble.",
          "When the strip is missing the last text line runs underneath the buttons, which is what a phone shows on every final answer, and the text stays partly unreadable until the message is long enough to scroll past the overlap.",
          "Closing note: the strip is reserved by the class the renderer already applies.",
        ].join("\n\n"),
      },
    ],
    timestamp: 2_000,
  },
];

let child;
let baseURL;
let port;
let tempDir;
let output = "";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: free } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return free;
}

async function startServer() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("FAKE_PI_")),
  );
  child = spawn(
    process.execPath,
    [
      serverScript,
      "--cwd",
      tempDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--pi",
      fakePi,
      "--",
      "--session-dir",
      join(tempDir, "sessions"),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        NODE_ENV: "test",
        HOME: join(tempDir, "home"),
        PI_CODING_AGENT_DIR: join(tempDir, "agent"),
        PI_WEBUI_RPC_SUPERVISOR: "0",
        FAKE_PI_TRANSCRIPT_JSON: JSON.stringify(TRANSCRIPT),
      },
    },
  );
  child.stdout.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-8_000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-8_000);
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Pi Web UI exited during startup:\n${output}`);
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    await delay(250);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, delay(3_000)]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Geometry of every message bubble that carries reaction controls. The text walk skips
// text inside a collapsed <details>: the browser reports client rects for it, but those
// pixels are not painted, so counting them would report a false overlap.
const MEASURE = () => {
  const messages = [...document.querySelectorAll(".message.has-action-feedback")];
  return messages.map((message) => {
    const controls = message.querySelector(":scope > .action-feedback-controls");
    const body = message.querySelector(":scope > .message-body");
    if (!controls || !body) return { controls: false, overlaps: 0, gutter: null };
    const box = controls.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    let overlaps = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      if (node.parentElement?.closest("details:not([open])")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 1 || rect.height <= 1) continue;
        const overlapX = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
        const overlapY = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
        if (overlapX > 1 && overlapY > 1) overlaps += 1;
      }
    }
    return {
      controls: true,
      overlaps,
      gutter: Math.round(box.top - bodyRect.bottom),
      paddingBottom: getComputedStyle(message).paddingBottom,
      text: body.innerText.trim().slice(0, 32),
    };
  });
};

async function openTranscript(page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const bubble = page.locator(".message.has-action-feedback").first();
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toContainText("Closing note");
  // The strip must already be laid out; wait for the controls to have a box.
  await expect
    .poll(() => bubble.locator(":scope > .action-feedback-controls").evaluate((element) => element.getClientRects().length > 0), {
      timeout: 10_000,
    })
    .toBe(true);
}

async function expectNoOverlap(page) {
  const measured = await page.evaluate(MEASURE);
  assert.ok(measured.length > 0, "the transcript should render at least one message with reaction controls");
  for (const message of measured) {
    assert.equal(message.controls, true, "each action-feedback bubble should keep its controls as a direct child");
    assert.equal(
      message.overlaps,
      0,
      `reaction controls should not cover text in "${message.text}": ${message.overlaps} intersecting text line(s)`,
    );
    assert.ok(
      message.gutter >= 0,
      `the bubble should reserve a strip under the text (controls top is ${message.gutter}px above the body bottom, padding-bottom ${message.paddingBottom})`,
    );
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `the reserved strip should not introduce horizontal overflow (${overflow}px)`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-action-feedback-gutter-"));
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await rm(tempDir, { recursive: true, force: true });
});

test.describe("390px touch viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });

  test("reaction controls stay off the last text line", async ({ page }) => {
    await openTranscript(page);
    await expectNoOverlap(page);
  });
});

test.describe("320px touch viewport", () => {
  test.use({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });

  test("reaction controls stay off the last text line", async ({ page }) => {
    await openTranscript(page);
    await expectNoOverlap(page);
  });
});

for (const layout of ["classic", "focused"]) {
  test.describe(`1440px ${layout} desktop viewport`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });

    test("reaction controls do not increase message height", async ({ page }) => {
      await page.addInitScript((desktopLayout) => {
        localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout }));
      }, layout);
      await openTranscript(page);
      await expect(page.locator("#focusedWorkspace")).toBeVisible({ visible: layout === "focused" });
      const bubble = page.locator(".message.has-action-feedback").first();
      const heights = await bubble.evaluate((message) => {
        const withControls = message.getBoundingClientRect().height;
        message.classList.remove("has-action-feedback");
        try {
          return { withControls, withoutControls: message.getBoundingClientRect().height };
        } finally {
          message.classList.add("has-action-feedback");
        }
      });
      expect(heights.withControls).toBe(heights.withoutControls);
      await bubble.hover();
      await expect(bubble.locator(":scope > .action-feedback-controls")).toHaveCSS("opacity", "1");
      expect(await bubble.evaluate((message) => message.getBoundingClientRect().height)).toBe(heights.withoutControls);
    });
  });
}
