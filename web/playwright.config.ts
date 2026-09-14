import { defineConfig } from "@playwright/test";

// The garden's end-to-end battery. `npm run e2e` from web/. The stack (seeded
// household, Bun server, one engine per member) is started once by
// e2e/global-setup.ts; the same tests run against `astro dev` (E2E_ENGINE=dev,
// the default) and against the built node server (E2E_ENGINE=server).
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // Tests mutate one shared garden (toolbar actions, live edits): serial.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? "line" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_API_PORT || 3990}`,
    trace: "retain-on-failure",
    // Astro dev + a proxy is slow on first hit; Playwright's default is fine after.
    navigationTimeout: 20_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
