import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

process.env.NODE_ENV = "test";

export default defineConfig({
  testDir: "./scripts/browser",
  testMatch: "overhaul-baseline.spec.mjs",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: "./test-results/overhaul-baseline/playwright",
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    actionTimeout: 5_000,
    launchOptions: {
      executablePath: process.env.PI_OVERHAUL_CHROMIUM || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
