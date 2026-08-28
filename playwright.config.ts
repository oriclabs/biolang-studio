import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: "http://127.0.0.1:4178", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
