import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.15,
      threshold: 0.3,
    },
  },
  testDir: "./tests/browser",
  fullyParallel: false,
  reporter: "line",
  snapshotPathTemplate: "{testDir}/browser-snapshots/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm run site:build:fixture && pnpm run site:serve",
    cwd: repositoryRoot,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:4321",
  },
});
