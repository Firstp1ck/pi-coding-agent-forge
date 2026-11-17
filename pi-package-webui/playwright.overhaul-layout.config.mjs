import { defineConfig } from "@playwright/test";

process.env.NODE_ENV = "test";

export default defineConfig({
  testDir: "./scripts/browser",
  testMatch: "overhaul-layout-baseline.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: "./test-results/overhaul-baseline/layout-playwright",
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    actionTimeout: 5_000,
    launchOptions: { executablePath: "/usr/bin/chromium" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
