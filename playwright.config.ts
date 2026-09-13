import { defineConfig, devices } from "@playwright/test";

// The admin smoke test signs in with the local account from .env.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env: the admin test skips itself.
}

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    locale: "sr-Latn-RS",
    timezoneId: "Europe/Belgrade",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // The tests run against a production build so timings resemble deployment.
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
