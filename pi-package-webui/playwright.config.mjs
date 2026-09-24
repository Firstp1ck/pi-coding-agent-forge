import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Browser fixtures must not register update participants under the user's
// production coordination root. Keep ambiguous fixture jobs for inspection.
process.env.NODE_ENV = "test";
process.env.PI_WEBUI_UPDATE_TEST_HOME ||= mkdtempSync(path.join(tmpdir(), "pi-webui-browser-coordination-"));

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { outputFolder: "test-results/playwright", open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:0",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // WebKit remains available for environments with its OS libraries. Keep it
    // opt-in so the package-owned default suite stays runnable on supported
    // Chromium-only Linux hosts rather than silently skipping the whole suite.
    ...(process.env.PI_WEBUI_TEST_WEBKIT === "1" ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
});
