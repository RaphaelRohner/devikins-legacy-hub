/**
 * overview.spec.js - "Where are my NFTs?": wallets as rows, Devikins /
 * Weapons / Equipment as columns, the Withdrawals list included for the
 * "My wallets" set; tapping a row shows just those NFTs; "Check now"
 * looks everything up on the chain.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, fakeAddress, GAME_MAIN_WALLET, TEST_WALLET, TEST_NFTS } = require('./fakeServers');
const { openHub, openMenuEntry, goBack, addWalletAndFetch } = require('./helpers');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

function rowOf(page, label) {
  return page.getByTestId('overview-row').filter({ hasText: label });
}

test('the overview counts per wallet, opens one wallet in Browse, and "Check now" finds moved NFTs', async ({ page }) => {
  test.setTimeout(180_000);
  // On the chain: the test wallet's own NFTs, plus weapon #3265 (on the
  // Withdrawals list) still in the game's main wallet.
  for (const kind of Object.keys(TEST_NFTS)) for (const n of TEST_NFTS[kind]) fake.chain.holders.set(`${kind}:${n.nonce}`, TEST_WALLET);
  fake.chain.holders.set('weapon:3265', GAME_MAIN_WALLET);
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });

  await openHub(page);
  await addWalletAndFetch(page, fake);
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
  await openMenuEntry(page, 'Wallets');
  await page.getByText('My wallets', { exact: true }).locator('..').locator('input').click();
  await goBack(page);
  await openMenuEntry(page, 'Fetch/Update');
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('3 Weapons')).toBeVisible({ timeout: 60_000 });

  // The table: the test wallet, and the game's main wallet holding #3265.
  await openMenuEntry(page, 'Where are my NFTs?');
  await expect(page.getByTestId('overview-table')).toBeVisible();
  await expect(rowOf(page, "The game's main wallet")).toContainText(/0\s*1\s*0/);
  await expect(page.getByTestId('overview-total-devikin')).toHaveText('2');
  await expect(page.getByTestId('overview-total-weapon')).toHaveText('3');
  await expect(page.getByTestId('overview-total-equipment')).toHaveText('2');

  // Tap the game's main wallet: Browse shows just #3265.
  await rowOf(page, "The game's main wallet").click();
  await expect(page.getByTestId('wallet-focus')).toContainText("Only NFTs in: The game's main wallet");
  await expect(page.getByText(/^#3265/)).toBeVisible();
  await expect(page.getByText(/^#201/)).toHaveCount(0);
  await page.getByTestId('wallet-focus-clear').click();
  await expect(page.getByText('3 Weapons')).toBeVisible();

  // Devikin #102 moves to someone else, and a new Devikin #105 arrives in
  // the test wallet: "Check now" finds both.
  fake.chain.holders.set('devikin:102', fakeAddress('o'));
  fake.chain.holders.set('devikin:105', TEST_WALLET);
  fake.extraNfts.set('devikin:105', { name: 'Newbie #105', attributes: { Rarity: 'Common', Ancestry: 'Faery', 'Life Stage': 'Adult', 'Procreations Left': 3 } });
  await openMenuEntry(page, 'Where are my NFTs?');
  // The check box sits at the top, folded: open it first (28 Oct 2026).
  await expect(page.getByTestId('overview-check-toggle')).toContainText('Last check:', { timeout: 15_000 });
  await expect(page.getByTestId('overview-check')).toHaveCount(0);
  await page.getByTestId('overview-check-toggle').click();
  await page.getByTestId('overview-check').click();
  await expect(page.getByText(/Last looked up on the chain:/)).toBeVisible({ timeout: 60_000 });
  await expect(rowOf(page, 'Another wallet')).toContainText(/1\s*0\s*0/);
  await expect(page.getByTestId('overview-new')).toContainText('1 new NFT found in your wallets');
  await expect(page.getByTestId('overview-total-devikin')).toHaveText('3');
  // "Fetch now" loads its details: it shows up in Devikins
  await page.getByTestId('overview-fetch').click();
  await expect.poll(() => fake.requests.some((u) => /\/devikin\/105$/.test(u)), { timeout: 60_000 }).toBe(true);
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });
  await openMenuEntry(page, 'Devikins');
  await expect(page.getByText(/^#105/)).toBeVisible();
  await openMenuEntry(page, 'Where are my NFTs?');
  await expect(page.getByTestId('overview-total-devikin')).toHaveText('3');

  // Open it and mark it as deleted: it isn't counted any more.
  await rowOf(page, 'Another wallet').click();
  await expect(page.getByTestId('wallet-focus')).toContainText('Only NFTs in: Another wallet');
  await expect(page.getByText(/^#102/)).toBeVisible();
  await expect(page.getByText(/^#101/)).toHaveCount(0);
  await page.getByText(/^#102/).first().click();
  await page.getByText('Mark as Deleted', { exact: true }).click();
  await expect(page.getByText('Marked as deleted', { exact: true })).toBeVisible();
  await page.goBack();
  await openMenuEntry(page, 'Where are my NFTs?');
  await expect(rowOf(page, 'Another wallet')).toHaveCount(0);
  await expect(page.getByText("1 NFT marked as deleted isn't counted.")).toBeVisible();
  await expect(page.getByTestId('overview-total-devikin')).toHaveText('2');
});
