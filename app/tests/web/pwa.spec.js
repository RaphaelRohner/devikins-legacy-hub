/**
 * pwa.spec.js - the installable website (25 Nov 2026).
 *
 * The page names its app description (manifest) and icons, the offline copy
 * (public/sw.js) starts and keeps the Hub, and a reload WITHOUT internet still
 * opens the Hub from that copy. The other tests switch service workers off
 * (playwright.config.js); this one switches them on.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers } = require('./fakeServers');
const { openHub } = require('./helpers');

test.use({ serviceWorkers: 'allow' });

test.beforeEach(async ({ context }) => {
  await installFakeServers(context);
});

test('the Hub is installable and opens from its offline copy without internet', async ({ page, context, baseURL }) => {
  await openHub(page);

  // The app description and the icons it names are there.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/devikins-legacy-hub/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  const manifest = await (await page.request.get(`${baseURL}manifest.webmanifest`)).json();
  expect(manifest.start_url).toBe('/devikins-legacy-hub/');
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) {
    const r = await page.request.get(`${baseURL}${icon.src}`);
    expect(r.ok(), icon.src).toBeTruthy();
  }

  // The offline copy starts and takes over the page.
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 30_000 });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // The very first install shows no "new version" note.
  await expect(page.getByTestId('update-note')).toHaveCount(0);

  // Without internet the Hub still opens.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/Wallets|Devikins/).first()).toBeVisible({ timeout: 30_000 });
  await context.setOffline(false);
});

test('a new version waits for "Update" in the note, then takes over', async ({ page }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const swFile = path.join(__dirname, '../../dist/sw.js');
  const original = fs.readFileSync(swFile, 'utf8');
  try {
    await openHub(page);
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 30_000 });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    // A new website build: the helper file changes (the Deploy workflow writes the build number into it).
    fs.writeFileSync(swFile, original.replace(/const BUILD = '[^']*'/, "const BUILD = 'test-build-2'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });

    // The note appears; nothing switches by itself.
    await expect(page.getByTestId('update-note')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('A new version of the Hub is available.')).toBeVisible();

    // "Update": the new version takes over, the page reloads once, the note is gone,
    // and only the new copy is kept.
    await page.getByTestId('update-now').click();
    await expect(page.getByTestId('update-note')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('devi-hub-'))))
      .toEqual(['devi-hub-test-build-2']);
  } finally {
    fs.writeFileSync(swFile, original);
  }
});

test('offline: a note at the top says what needs the internet, and goes when it\'s back', async ({ page, context }) => {
  await openHub(page);
  await expect(page.getByTestId('offline-note')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-note')).toBeVisible();
  await expect(page.getByText(/Fetching, new pictures, chat and albums need the internet/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('offline-note')).toHaveCount(0);
});
