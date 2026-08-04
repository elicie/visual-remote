import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["viewer-smoke.e2e.ts", "next-single-port.e2e.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "list",
  outputDir: "../../output/playwright/e2e",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1_280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
