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
  // "Fetch now" says it may take a while and that the Hub will come back.
  await expect.poll(() => dialogs.join('\n')).toMatch(/Loading your NFTs[\s\S]*tells you what came in/);
  // After the fetch: what came in, and "NFTs still in the game?" -> Add their IDs.
  await expect.poll(() => dialogs.join('\n'), { timeout: 60_000 }).toMatch(/Your collection is loaded[\s\S]*Loaded: 2 Devikins, 2 Weapons, 2 Equipment/);
  await expect(page.getByText('2. Add the IDs of your NFTs')).toBeVisible();
  await page.locator('textarea').fill('W3265');
  await page.getByText('Add to the list', { exact: true }).click();
  // "Show them in your collection?" -> Fetch now -> they're in the list.
  // (Start listening for the backup download now - on a fast machine it can
  // arrive before the next lines run.)
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  await expect.poll(() => dialogs.join('\n')).toMatch(/Show them in your collection\?/);
  await expect.poll(() => dialogs.join('\n'), { timeout: 60_000 }).toMatch(/Save a backup\?/);
  // "Save a backup now" -> Wallets, and the backup file downloads by itself.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^devikins-all-sets-.*\.zip$/);
  await goBack(page);
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('3 Weapons', { exact: true })).toBeVisible();
  // Each question came once.
  expect(dialogs.filter((d) => /^Save a backup\?/.test(d))).toHaveLength(1);
  expect(dialogs.filter((d) => /^Your collection is loaded/.test(d))).toHaveLength(1);
  // Only the first fetch gets the "Loading your NFTs" note.
  expect(dialogs.filter((d) => /^Loading your NFTs/.test(d))).toHaveLength(1);
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
  for (const title of ['Set Up', 'Browse NFTs', 'Features', 'Help']) {
    await expect(menu.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(menu.getByText('Donate', { exact: true })).toBeVisible();
  await expect(menu.getByText('Withdrawals', { exact: true })).toHaveCount(0); // Features closed
  await menu.getByText('Features', { exact: true }).click();
  await expect(menu.getByText('Withdrawals', { exact: true })).toBeVisible();
  await expect(menu.getByText('KLV Signer (test)', { exact: true })).toHaveCount(0); // app only
  await menu.getByText('Features', { exact: true }).click();
  await expect(menu.getByText('Withdrawals', { exact: true })).toHaveCount(0);
});

test('"Fetch now" while the Hub is busy in the background still fetches (it waits its turn)', async ({ page }) => {
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });
  // First fetch without pictures, so the Hub has picture retries to do.
  fake.picturesDown = true;
  await openHub(page, { accept: ['Show them in your collection?'] });
  await addWalletAndFetch(page, fake).catch(() => {}); // pictures missing - the helper's picture count may not be reached
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });
  await openMenuEntry(page, 'Wallets');
  await page.getByText('My wallets', { exact: true }).locator('..').locator('input').click();
  await expect(page.getByText(/This is your own set/)).toBeVisible();
  await goBack(page);
  // Pictures come back, but slowly: the background retry (started when the
  // Hub opens) stays busy for a while.
  fake.picturesDown = false;
  fake.pictureDelayMs = 8000;
  const before = fake.requests.filter((u) => /\.png$/.test(u)).length;
  await page.reload();
  // The background retry asks for pictures again (and waits on each).
  await expect.poll(() => fake.requests.filter((u) => /\.png$/.test(u)).length, { timeout: 30_000 }).toBeGreaterThan(before);

  await openMenuEntry(page, 'Withdrawals');
  await page.locator('textarea').fill('W3265');
  await page.getByText('Add to the list', { exact: true }).click();
  // "Show them in your collection?" -> Fetch now (accepted by the test).
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('3 Weapons', { exact: true })).toBeVisible({ timeout: 90_000 });
});

test('IDs added in the guided setup are looked up first; the collection says where each one is', async ({ page }) => {
  const { nameNewWallet, GAME } = { nameNewWallet: require('./helpers').nameNewWallet };
  const { fakeAddress, GAME_MAIN_WALLET } = require('./fakeServers');
  fake.extraNfts.set('weapon:3265', { name: 'Rusty Test Wand #3265', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Rusty' } });
  fake.extraNfts.set('weapon:1442', { name: 'Odd Test Axe #1442', attributes: { Rarity: 'Common', Type: 'Axe', Quality: 'Rusty' } });
  fake.chain.holders.set('weapon:3265', GAME_MAIN_WALLET);
  fake.chain.holders.set('weapon:1442', fakeAddress('x'));
  await openHub(page, { keepWelcome: true, accept: ['Show them in your collection?'] });
  const input = page.getByPlaceholder('Paste a Klever wallet address (klv1...)');
  await input.fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'My wallet'); // "Is this your own wallet?" -> yes
  await input.fill(fakeAddress('g'));
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'In-game wallet');
  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Withdrawals'); // filled in from the wallet names
  await page.locator('textarea').fill('W3265 W1442');
  // Remember how far the page scrolls: "Fetch now" jumps down to "3. Check".
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(() => {
    // How close "3. Check" got to the top of the screen.
    window.__checkTop = 9999;
    document.addEventListener('scroll', () => {
      const box = document.querySelector('[data-testid="check-section"]');
      if (box) window.__checkTop = Math.min(window.__checkTop, box.getBoundingClientRect().top);
    }, true);
  });
  await page.getByText('Add to the list', { exact: true }).click();
  // "Show them in your collection?" -> Fetch now: Check first, then the fetch.
  // With only a few NFTs the page can't scroll far enough to put "3. Check"
  // at the very top; it lands in the upper part of the screen (it started
  // around 430 px down, below the fold).
  await expect.poll(() => page.evaluate(() => window.__checkTop)).toBeLessThan(320);
  await page.setViewportSize({ width: 1200, height: 900 });
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('4 Weapons', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/#3265\s*·\s*In the game/)).toBeVisible();
  await expect(page.getByText(/#1442\s*·\s*In another wallet/)).toBeVisible();
  // NFTs in your own wallet get no tag.
  await expect(page.getByText(/#201\s*·/)).toHaveCount(0);
});
