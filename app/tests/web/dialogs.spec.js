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

  fake.metadataDelayMs = 700; // slow enough to watch the numbers move
  await openMenuEntry(page, 'Fetch/Update');
  // Tap the progress bar while the fetch runs: the "Fetch status" box opens
  // and its numbers keep updating while it stays open (19 Oct 2026).
  await page.getByText(/^\d+%$/).first().click();
  const status = page.getByTestId('fetch-status-text');
  await expect(page.getByTestId('fetch-status')).toContainText('Fetch status');
  const first = await status.innerText();
  await expect.poll(() => status.innerText(), { timeout: 20_000 }).not.toBe(first);
  // Leave it open - the fetch must still finish, and the box closes with it.
  fake.metadataDelayMs = 0;
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('fetch-status')).toHaveCount(0);
  // (The guided setup's "Save a backup?" may have opened on top - close every box.)
  while ((await box.count()) > 0) {
    await box.last().getByRole('button').first().click();
  }
  await expect(box).toHaveCount(0);
  expect(browserPopups, "the browser's own pop-ups (they pause the page)").toEqual([]);
  expect(fake.blocked).toEqual([]);
});

test('the setup questions follow each other in the Hub\'s own boxes', async ({ page, context }) => {
  await installFakeServers(context);
  await openHub(page, { inPageDialogs: true, keepWelcome: true });
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'My wallet');
  const box = page.locator('[data-hub-dialog]');
  await expect(box).toContainText('Is this your own wallet?');
  await box.getByRole('button', { name: "Yes, it's mine" }).click();
  await expect(box).toContainText('Wallet added');
  await box.getByRole('button', { name: 'Add another wallet first' }).click();
  await expect(box).toHaveCount(0);
  await expect(page.getByText(/This is your own set/)).toBeVisible();
});
