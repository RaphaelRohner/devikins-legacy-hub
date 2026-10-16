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
  await expect(page.getByText('All (1)')).toBeVisible();
  await page.getByText('Check', { exact: true }).click();
  await expect(page.getByText(/Last check:/)).toBeVisible();
  await goBack(page);

  // Not "My wallets" yet: nothing changes.
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText(/^#3265/)).toHaveCount(0);

  // Mark this set as my own, then fetch.
  await openMenuEntry(page, 'Wallets');
  await switchNear(page, 'My wallets').click();
  await expect(page.getByText(/also shows the 1 ID on your Withdrawals list/)).toBeVisible();
  await goBack(page);
  await openMenuEntry(page, 'Fetch/Update');
  await expect(page.getByText('3 Weapons')).toBeVisible({ timeout: 60_000 });
  await openMenuEntry(page, 'Weapons');
  // Its row says why it's there: still in the game.
  await expect(page.getByText(/^#3265\s*·\s*In the game/)).toBeVisible();
  await page.getByText(/^#3265/).click();
  await expect(page.getByText(/In the game's main wallet \(as of/)).toBeVisible();
  await goBack(page);

  // Switching "My wallets" off takes it out again.
  await openMenuEntry(page, 'Wallets');
  await switchNear(page, 'My wallets').click();
  await goBack(page);
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText(/^#3265/)).toHaveCount(0);
});

test('exporting the "My wallets" set on its own also takes the IDs along', async ({ page, browser }, testInfo) => {
  fake.chain.holders.set('weapon:3265', GAME_MAIN_WALLET);
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });

  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Withdrawals');
  await page.locator('textarea').fill('W3265');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText('All (1)')).toBeVisible();
  await goBack(page);
  await openMenuEntry(page, 'Wallets');
  await switchNear(page, 'My wallets').click();
  await goBack(page);
  await openMenuEntry(page, 'Weapons');
  await openMenuEntry(page, 'Fetch/Update');
  await expect(page.getByText('3 Weapons')).toBeVisible({ timeout: 60_000 });

  // Export just this one set (its own Export button, not "Export all sets").
  await openMenuEntry(page, 'Wallets');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('Export', { exact: true }).first().click(),
  ]);
  const zipPath = testInfo.outputPath('my-set.zip');
  await download.saveAs(zipPath);

  // A brand-new browser: import - the set loads by itself and is already
  // marked "My wallets", like it was when exported.
  const context2 = await browser.newContext();
  const fake2 = await installFakeServers(context2);
  fake2.chain.holders.set('weapon:3265', GAME_MAIN_WALLET);
  const page2 = await context2.newPage();
  const dialogs = await openHub(page2);
  await openMenuEntry(page2, 'Wallets');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import Set(s)').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/Withdrawals tracker: 1 NFT/);
  await expect(page2.getByText(/Wallets in ".*\(imported\)"/)).toBeVisible();
  await expect(page2.getByText(/This is your own set/)).toBeVisible();
  await expect(page2.getByText(/Your IDs \(1\)/)).toBeVisible();
  await goBack(page2);

  // #3265 shows straight away - no new fetch needed.
  await openMenuEntry(page2, 'Weapons');
  await expect(page2.getByText('3 Weapons')).toBeVisible();
  await context2.close();
});
