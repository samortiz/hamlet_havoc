// Browser play-test config (req §2.10). Drives the real page in headless Chrome
// to cover what the headless sim tests cannot: rendering, input wiring, the HUD,
// and the game loop. Mechanics assertions belong in the Vitest sim tests; keep
// this layer thin (page loads, no console errors, loop ticks, input → command).

import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use the system Google Chrome (already installed) instead of
        // downloading Playwright's bundled browser.
        channel: "chrome",
        launchOptions: {
          // Flags this sandboxed Linux environment needs for headless Chrome.
          args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
