/**
 * playwright.config.js - settings for the automatic website tests.
 *
 * Run them with `npm test` (builds the website first, then tests it) or
 * `npm run test:quick` (tests the build that's already there). See
 * TESTING.md for the plain-language version.
 *
 * The tests run in a real Chrome browser without a window ("headless").
 * They never touch the real Klever, Moonlabs or relay servers: every
 * outside request is answered by a pretend server inside the test (see
 * tests/web/fakeServers.js), so the tests work offline, always see the
 * same data, and never put load on anyone's server.
 */
const { defineConfig, devices } = require('@playwright/test');

// In Claude's cloud workspace a Chrome is already installed at this path;
// on your Mac, Playwright uses the one from `npx playwright install chromium`.
const chromiumPath = process.env.PW_CHROMIUM_PATH;

module.exports = defineConfig({
  testDir: './tests/web',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test stands on its own (fresh browser, its own pretend servers), so
  // GitHub can split them evenly over several machines (--shard); on one
  // machine they still run one at a time (workers: 1).
  fullyParallel: true,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:8099/devikins-legacy-hub/',
    viewport: { width: 1200, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  webServer: {
    command: 'node tests/web/serve.mjs',
    url: 'http://localhost:8099/devikins-legacy-hub/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
