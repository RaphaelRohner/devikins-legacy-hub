/**
 * guide.spec.js - the "Getting started" checklist and the menu categories.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, TEST_WALLET } = require('./fakeServers');
const { openHub, openMenuEntry, goBack, addWalletAndFetch } = require('./helpers');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});

test('the Getting started checklist ticks off steps, hides, and comes back from Help', async ({ page }) => {
  await openHub(page);
  await expect(page.getByText(/^Getting started/)).toBeVisible();
  await expect(page.getByText(/0 of 3 done/)).toBeVisible();

  await addWalletAndFetch(page, fake);
  await expect(page.getByText(/2 of 3 done/)).toBeVisible();

  // Backup ticks the last required step - the checklist then goes away.
  await openMenuEntry(page, 'Wallets');
  await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  await goBack(page);
  await expect(page.getByText(/^Getting started/)).toHaveCount(0);

  // Help > Getting started brings it back ("All set"), Hide removes it.
  await openMenuEntry(page, 'Getting started');
  await expect(page.getByText(/All set ✓/)).toBeVisible();
  await page.getByText('Hide ✕').click();
  await expect(page.getByText(/All set ✓/)).toHaveCount(0);
});

test('the menu is grouped in categories that open and close', async ({ page }) => {
  await openHub(page);
  await page.getByText('☰').first().click();
  const menu = page.locator('[role="dialog"][aria-modal="true"]').filter({ hasText: 'Menu' }).last();
  for (const title of ['Set Up', 'Browse NFTs', 'Tools', 'Help']) {
    await expect(menu.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(menu.getByText('Donate', { exact: true })).toBeVisible();
  await expect(menu.getByText('Withdrawals', { exact: true })).toHaveCount(0); // Tools closed
  await menu.getByText('Tools', { exact: true }).click();
  await expect(menu.getByText('Withdrawals', { exact: true })).toBeVisible();
  await expect(menu.getByText('KLV Signer (test)', { exact: true })).toHaveCount(0); // app only
  await menu.getByText('Tools', { exact: true }).click();
  await expect(menu.getByText('Withdrawals', { exact: true })).toHaveCount(0);
});
