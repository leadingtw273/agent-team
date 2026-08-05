import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "off",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
});
