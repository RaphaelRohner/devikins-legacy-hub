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

test('the Getting started checklist is an overview under Help: ticks off steps and hides', async ({ page }) => {
  await openHub(page);
  // The guided setup does the steps now - the checklist doesn't show by itself.
  await expect(page.getByText(/^Getting started/)).toHaveCount(0);
  await addWalletAndFetch(page, fake);
  await expect(page.getByText(/^Getting started/)).toHaveCount(0);

  await openMenuEntry(page, 'Getting started');
  await expect(page.getByText(/2 of 3 done/)).toBeVisible();
  // Backup ticks the last required step.
  await openMenuEntry(page, 'Wallets');
  await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  await goBack(page);
  await openMenuEntry(page, 'Getting started');
  await expect(page.getByText(/All set ✓/)).toBeVisible();
  await page.getByText('Hide ✕').click();
  await expect(page.getByText(/All set ✓/)).toHaveCount(0);
});

test('the guided setup walks through every step, ending with a backup', async ({ page }) => {
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });
  fake.chain.holders.set('weapon:3265', require('./fakeServers').GAME_MAIN_WALLET);
  const dialogs = await openHub(page, { keepWelcome: true, followGuide: true });
  const { nameNewWallet } = require('./helpers');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'My wallet');
  // "Is this your own wallet?" -> yes; "Wallet added" -> Fetch now.
  await expect.poll(() => dialogs.join('\n')).toMatch(/Is this your own wallet\?/);
  // After the fetch: what came in, and "NFTs still in the game?" -> Add their IDs.
  await expect.poll(() => dialogs.join('\n'), { timeout: 60_000 }).toMatch(/Your collection is loaded[\s\S]*Loaded: 2 Devikins, 2 Weapons, 2 Equipment/);
  await expect(page.getByText('2. Add the IDs of your NFTs')).toBeVisible();
  await page.locator('textarea').fill('W3265');
  await page.getByText('Add to the list', { exact: true }).click();
  // "Show them in your collection?" -> Fetch now -> they're in the list.
  await expect.poll(() => dialogs.join('\n')).toMatch(/Show them in your collection\?/);
  await expect.poll(() => dialogs.join('\n'), { timeout: 60_000 }).toMatch(/Save a backup\?/);
  // "Save a backup now" -> Wallets, and the backup file downloads by itself.
  const download = await page.waitForEvent('download', { timeout: 30_000 });
  expect(download.suggestedFilename()).toMatch(/^devikins-all-sets-.*\.zip$/);
  await goBack(page);
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('3 Weapons', { exact: true })).toBeVisible();
  // Each question came once.
  expect(dialogs.filter((d) => /^Save a backup\?/.test(d))).toHaveLength(1);
  expect(dialogs.filter((d) => /^Your collection is loaded/.test(d))).toHaveLength(1);
});

test('"Someone else\'s wallet" next to your own goes into a set of its own', async ({ page }) => {
  const dialogs = await openHub(page, { keepWelcome: true });
  const { nameNewWallet } = require('./helpers');
  const input = page.getByPlaceholder('Paste a Klever wallet address (klv1...)');
  await input.fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'My wallet'); // "Is this your own wallet?" -> yes
  const friend = require('./fakeServers').fakeAddress('f');
  await input.fill(friend);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, "Someone else's wallet");
  // "Keep it separate from yours?" -> Own set (accepted).
  await expect.poll(() => dialogs.join('\n')).toMatch(/Keep it separate from yours\?/);
  await expect(page.getByText(/Wallets in "Just looking \(/)).toBeVisible();
  await expect(page.getByText('Just looking', { exact: true })).toBeVisible();
  // Never asked whether the friend's wallet is yours.
  expect(dialogs.filter((d) => /^(Is this your own wallet\?|Are these your own wallets\?)/.test(d))).toHaveLength(1);
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
