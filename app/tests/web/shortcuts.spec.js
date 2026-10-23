/**
 * shortcuts.spec.js - keyboard shortcuts on the website: G then a letter
 * jumps to a section, ? lists them, and typing in a text box never jumps.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers } = require('./fakeServers');
const { openHub, addWalletAndFetch } = require('./helpers');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

async function keys(page, ...list) {
  for (const k of list) await page.keyboard.press(k);
}

test('G then a letter jumps to a section; ? lists the shortcuts; typing in a box never jumps', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);

  await keys(page, 'g', 'w');
  await expect(page.getByText('1. Your wallets', { exact: true })).toBeVisible();
  await keys(page, 'g', 'a');
  await expect(page.getByText('2 Weapons', { exact: true })).toBeVisible();
  await keys(page, 'g', 'o');
  await expect(page.getByText('Where are my NFTs?', { exact: true })).toBeVisible();
  await keys(page, 'g', 'd');
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible();

  // A letter on its own, or G too long before it, does nothing
  await keys(page, 'w');
  await page.keyboard.press('g');
  await page.waitForTimeout(1800);
  await page.keyboard.press('w');
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible();

  // Typing "gw" in the search box searches; it doesn't jump
  await page.getByPlaceholder('Search by name or ID').click();
  await page.keyboard.type('gw');
  await expect(page.getByPlaceholder('Search by name or ID')).toHaveValue('gw');
  await expect(page.getByText('1. Your wallets', { exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Search by name or ID').fill('');
  await page.getByText('☰').first().click(); // (focus back on the page)

  // The ☰ menu shows the keys, and ? opens the list
  await expect(page.getByText('G D', { exact: true })).toBeVisible();
  await page.getByTestId('menu-shortcuts').click();
  await expect(page.getByTestId('shortcuts-help')).toContainText('Withdrawals');
  await page.getByTestId('shortcuts-help-close').click();
  await expect(page.getByTestId('shortcuts-help')).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-help')).toBeVisible();
  await page.getByTestId('shortcuts-help-close').click();
});
