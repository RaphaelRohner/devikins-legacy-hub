/**
 * dialogs.spec.js - the website's own message box (src/web/alertForWeb.js)
 * must not pause the page: a running Fetch/Update keeps going while it's
 * open (it used to stop until the browser's pop-up was closed).
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, TEST_WALLET } = require('./fakeServers');
const { openHub, openMenuEntry, goBack, nameNewWallet } = require('./helpers');

test('a message box does not pause a running fetch', async ({ page, context }) => {
  const fake = await installFakeServers(context);
  fake.metadataDelayMs = 2500; // a slow server, so the fetch takes a few seconds
  const browserPopups = [];
  page.on('dialog', async (d) => {
    browserPopups.push(d.message());
    await d.accept();
  });

  await openHub(page, { inPageDialogs: true });
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  // The Hub's own box, inside the page:
  const box = page.locator('[data-hub-dialog]');
  await expect(box).toContainText('Wallet added');
  await box.getByRole('button', { name: 'Add another wallet first' }).click();
  await expect(box).toHaveCount(0);
  await goBack(page);

  await openMenuEntry(page, 'Fetch/Update');
  // Tap the progress bar while the fetch runs: "Fetch status" box opens.
  await page.getByText(/^\d+%$/).first().click();
  await expect(box).toContainText('Fetch status');
  // Leave it open - the fetch must still finish.
  await expect(page.getByText('2 Devikins')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 30_000 });
  await expect(box).toHaveCount(1); // still open
  await box.getByRole('button').first().click();
  await expect(box).toHaveCount(0);
  expect(browserPopups, "the browser's own pop-ups (they pause the page)").toEqual([]);
  expect(fake.blocked).toEqual([]);
});
