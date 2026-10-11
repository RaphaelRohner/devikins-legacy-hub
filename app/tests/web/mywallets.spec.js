/**
 * mywallets.spec.js - "My wallets": the set marked as your own also shows
 * the NFTs on the Withdrawals list, wherever they are.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, fakeAddress, GAME_MAIN_WALLET, TEST_WALLET } = require('./fakeServers');
const { openHub, openMenuEntry, goBack, addWalletAndFetch } = require('./helpers');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

function switchNear(page, label) {
  return page.getByText(label, { exact: true }).locator('..').locator('input');
}

test('the set marked "My wallets" also shows the Withdrawals list NFTs, with where they are', async ({ page }) => {
  // Weapon #3265 is ours but still sits in the game's main wallet.
  fake.chain.holders.set('weapon:3265', GAME_MAIN_WALLET);
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });

  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('2 Weapons')).toBeVisible();

  // Put #3265 on the Withdrawals list and check where it is.
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(fakeAddress('g'));
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(TEST_WALLET);
  await page.getByText('Save', { exact: true }).click();
  await page.locator('textarea').fill('W3265');
  await page.getByText('Add to the list', { exact: true }).click();
  await page.getByText('Check now', { exact: true }).click();
  await expect(page.getByText(/Last check:/)).toBeVisible();
  await goBack(page);

  // Not "My wallets" yet: nothing changes.
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('#3265', { exact: true })).toHaveCount(0);

  // Mark this set as my own, then fetch.
  await openMenuEntry(page, 'Wallets');
  await switchNear(page, 'My wallets').click();
  await expect(page.getByText(/also shows the 1 NFTs on your Withdrawals list/)).toBeVisible();
  await goBack(page);
  await openMenuEntry(page, 'Fetch/Update');
  await expect(page.getByText('3 Weapons')).toBeVisible({ timeout: 60_000 });
  await openMenuEntry(page, 'Weapons');
  await page.getByText('#3265', { exact: true }).click();
  await expect(page.getByText(/In the game's main wallet \(as of/)).toBeVisible();
  await goBack(page);

  // Switching "My wallets" off takes it out again.
  await openMenuEntry(page, 'Wallets');
  await switchNear(page, 'My wallets').click();
  await goBack(page);
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('#3265', { exact: true })).toHaveCount(0);
});
