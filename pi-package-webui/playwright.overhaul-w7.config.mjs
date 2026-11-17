import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
// Workers inherit disposable roots; each unchanged W0 server fixture further isolates its state.
if (!process.env.PI_OVERHAUL_W7_RUN_ID) {
  process.env.PI_OVERHAUL_W7_RUN_ID = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const root = mkdtempSync(join(tmpdir(), "webui-w7-measurements-"));
  for (const [key, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", PI_CODING_AGENT_DIR: "agent" })) {
    process.env[key] = join(root, directory);
    mkdirSync(process.env[key], { recursive: true });
  }
  process.env.PI_WEBUI_SETTINGS_FILE = join(root, "settings.json");
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
}

export default defineConfig({
  testDir: "./scripts/browser",
  testMatch: "overhaul-w7-measurements.spec.mjs",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: `./test-results/overhaul-w7/${process.env.PI_OVERHAUL_W7_RUN_ID}/playwright`,
  reporter: "list",
  use: {
    browserName: "chromium", headless: true, locale: "en-US", timezoneId: "UTC",
    colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block", actionTimeout: 5_000,
    launchOptions: { executablePath: "/usr/bin/chromium" },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
});
