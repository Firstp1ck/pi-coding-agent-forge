import { defineConfig } from "@playwright/test";

process.env.NODE_ENV = "test";

export default defineConfig({
  testDir: "./scripts/browser",
  testMatch: "overhaul-capability-baseline.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: "./test-results/overhaul-baseline/capability-playwright",
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    actionTimeout: 5_000,
    launchOptions: { executablePath: "/usr/bin/chromium" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
