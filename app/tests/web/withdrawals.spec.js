/**
 * withdrawals.spec.js - automatic tests for the Withdrawals screen, on a
 * pretend blockchain (see fakeServers.js: fake.chain).
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, fakeAddress, GAME_MAIN_WALLET } = require('./fakeServers');
const { openHub, openMenuEntry, addWalletAndFetch, nameNewWallet } = require('./helpers');

const IN_GAME = fakeAddress('g');
const RECEIVING = fakeAddress('r');
const SELLER = fakeAddress('s');
const STRANGER = fakeAddress('x');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

/** The row of one NFT on the list. */
function row(page, label) {
  return page.locator('div[tabindex="0"]').filter({ hasText: new RegExp(`^.?${label}\\b`) }).first();
}

test('the tracker shows where each NFT is, spots overdue ones and arrivals', async ({ page }) => {
  const start = new Date('2026-10-11T12:00:00Z');
  await page.clock.install({ time: start });

  // The pretend chain before anything happens:
  const now = Math.floor(start.getTime() / 1000);
  fake.chain.holders.set('weapon:3265', RECEIVING); // already withdrawn (bought from a seller)
  fake.chain.transfers.push({ hash: 'tx3265', kind: 'weapon', nonce: 3265, from: SELLER, to: RECEIVING, timestamp: now - 600 });
  fake.chain.holders.set('weapon:1442', IN_GAME); // requested, still in the in-game wallet
  fake.chain.holders.set('weapon:1450', GAME_MAIN_WALLET); // never moved
  fake.chain.holders.set('equipment:1022', STRANGER); // somewhere else
  // devikin 999 doesn't exist on the chain

  await openHub(page);
  // The in-game wallet is already in a wallet set, as for most users.
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(IN_GAME);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(IN_GAME).first()).toBeVisible();
  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Withdrawals');

  // 1. Wallets: pick the in-game wallet from the set, paste the other
  await page.getByText('Choose from my wallets').first().click();
  await page.getByText(/set: /).first().click();
  await expect(page.getByPlaceholder('klv1… (in-game wallet)')).toHaveValue(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await expect(page.getByText('Check', { exact: true })).toBeVisible();

  // 2. Paste a list with headings (like Raphael's own list)
  await page.locator('textarea').fill('Weapons\n3265\n1442, 1450\n\nEquipment\n#1022\n\nDevikins\n999');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/^5 added\./)).toBeVisible();
  await expect(page.getByText('All (5)')).toBeVisible();

  // 3. Mark the two that were requested in the game
  await row(page, 'Weapon #3265').click();
  await row(page, 'Weapon #1442').click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByText('Mark requested', { exact: true }).click();
  await expect(page.getByText('Requested (2)')).toBeVisible();

  // 4. Check
  await page.getByText('Check', { exact: true }).click();
  await expect(page.getByText(/Last check:/)).toBeVisible();
  await expect(row(page, 'Weapon #3265')).toContainText('Arrived');
  await expect(row(page, 'Weapon #3265')).toContainText('sent from klv1ssss');
  await expect(row(page, 'Weapon #1442')).toContainText('Requested - waiting');
  await expect(row(page, 'Weapon #1442')).toContainText('still in your in-game wallet');
  await expect(row(page, 'Weapon #1450')).toContainText("In the game's main wallet");
  await expect(row(page, 'Weapon #1450')).toContainText('as of Oct 11');
  await expect(row(page, 'Equipment #1022')).toContainText('In another wallet');
  await expect(row(page, 'Equipment #1022')).toContainText('held by klv1xxxx');
  await expect(row(page, 'Devikin #999')).toContainText('Not found on the chain');
  await expect(page.getByText(/Weapon #3265 · from klv1ssss/)).toBeVisible(); // arrivals log

  // Narrow and sort: weapons still in the game, by number
  // The kind chips say how many of each are on the whole list.
  await expect(page.getByText('All kinds (5)', { exact: true })).toBeVisible();
  await expect(page.getByText('Equipment (1)', { exact: true })).toBeVisible();
  await page.getByText('Weapons (3)', { exact: true }).click();
  await page.getByText('Still in the game', { exact: true }).click();
  await page.getByText('ID ↑', { exact: true }).click();
  const shown = await page.locator('div[tabindex="0"]').filter({ hasText: /^.?(Weapon|Equipment|Devikin) #\d+/ }).allInnerTexts();
  expect(shown.map((t) => t.match(/#(\d+)/)[1])).toEqual(['1442', '1450']);
  await page.getByText('ID ↓', { exact: true }).click();
  await page.getByText('Anywhere', { exact: true }).click();
  const shown2 = await page.locator('div[tabindex="0"]').filter({ hasText: /^.?(Weapon|Equipment|Devikin) #\d+/ }).allInnerTexts();
  expect(shown2.map((t) => t.match(/#(\d+)/)[1])).toEqual(['3265', '1450', '1442']);
  await page.getByText('All kinds (5)', { exact: true }).click();
  await page.getByText('Needs attention first', { exact: true }).click();

  // 5. 31 minutes later, #1442 still hasn't come: overdue
  await page.clock.fastForward('31:00');
  await expect(row(page, 'Weapon #1442')).toContainText('Overdue');
  await expect(page.getByText('Overdue (1)')).toBeVisible();
  await expect(page.getByText('Open a ticket at Klever support ↗')).toBeVisible();
  await expect(page.getByText(/overdue list \(1\)/)).toBeVisible();

  // 6. The game finally sends it
  fake.chain.holders.set('weapon:1442', RECEIVING);
  fake.chain.transfers.push({ hash: 'tx1442', kind: 'weapon', nonce: 1442, from: IN_GAME, to: RECEIVING, timestamp: now + 1900 });
  await page.getByText('Check', { exact: true }).click();
  await expect(row(page, 'Weapon #1442')).toContainText('Arrived', { timeout: 20_000 });
  await expect(row(page, 'Weapon #1442')).toContainText('sent from your in-game wallet');
  await expect(page.getByText('Arrived (2)')).toBeVisible();
  await expect(page.getByText('Overdue (0)')).toBeVisible();

  // The list survives reopening the Hub.
  await page.reload();
  await openMenuEntry(page, 'Withdrawals');
  await expect(page.getByText('Arrived (2)')).toBeVisible();
});

test('the tracker travels with a full backup into a new browser', async ({ page, browser }, testInfo) => {
  fake.chain.holders.set('weapon:3265', RECEIVING);
  fake.chain.transfers.push({ hash: 'tx3265', kind: 'weapon', nonce: 3265, from: SELLER, to: RECEIVING, timestamp: 1791720000 });
  fake.chain.holders.set('weapon:1442', IN_GAME);

  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await page.locator('textarea').fill('W3265 W1442');
  await page.locator('input[type="checkbox"], [role="switch"]').first().click(); // "I've requested these just now"
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added - all marked as requested/)).toBeVisible();
  await page.getByText('Check', { exact: true }).click();
  await expect(page.getByText('Arrived (1)')).toBeVisible();

  // Full backup
  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Wallets');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  const zipPath = testInfo.outputPath('backup.zip');
  await download.saveAs(zipPath);

  // Another browser
  const context2 = await browser.newContext();
  const fake2 = await installFakeServers(context2);
  const page2 = await context2.newPage();
  const dialogs = await openHub(page2);
  await openMenuEntry(page2, 'Wallets');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import a set').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/Withdrawals tracker: 2 NFT\(s\) added/);
  await page2.getByText('‹').first().click();
  await openMenuEntry(page2, 'Withdrawals');
  await expect(page2.getByPlaceholder('klv1… (in-game wallet)')).toHaveValue(IN_GAME);
  await expect(page2.getByPlaceholder('klv1… (receiving wallet)')).toHaveValue(RECEIVING);
  await expect(page2.getByText('Arrived (1)')).toBeVisible();
  await expect(page2.getByText('Requested (1)')).toBeVisible();
  await expect(page2.getByText(/Weapon #3265 · from klv1ssss/)).toBeVisible();
  expect(fake2.blocked).toEqual([]);
  await context2.close();
});

test('Reset All Data also empties the Withdrawals list', async ({ page }) => {
  const dialogs = await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await page.locator('textarea').fill('W3265 W1442');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added/)).toBeVisible();

  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Wallets');
  await expect(page.getByText(/Your IDs \(2\)/)).toBeVisible();
  await page.getByText('Danger zone').locator('xpath=..').getByRole('switch').click();
  await page.getByText('Reset All Data', { exact: true }).click();
  await expect.poll(() => dialogs.join('\n')).toMatch(/Reset all data\?/);
  await expect(page.getByText(/Your IDs \(\d+\)/)).toHaveCount(0);

  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Withdrawals');
  await expect(page.getByPlaceholder('klv1… (in-game wallet)')).toHaveValue('');
  await expect(page.getByText(/W3265|#3265/)).toHaveCount(0);
});

test('a long Withdrawals list scrolls in its own box', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await page.locator('textarea').fill(Array.from({ length: 60 }, (_, i) => `W${5000 + i}`).join(' '));
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/60 added/)).toBeVisible();
  const box = page.getByTestId('withdrawals-list-box');
  const size = await box.evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(size.shown).toBeLessThanOrEqual(430);
  expect(size.full).toBeGreaterThan(size.shown); // the rest is reached by scrolling inside the box
});

test('"Check selected" looks up exactly the selected NFTs', async ({ page }) => {
  fake.chain.holders.set('weapon:3265', IN_GAME);
  fake.chain.holders.set('weapon:1442', IN_GAME);
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await page.locator('textarea').fill('W3265 W1442');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added/)).toBeVisible();

  const lookups = (nonce) => fake.requests.filter((u) => u.includes('/assets/nft/holder/') && u.endsWith(`/${nonce}`)).length;
  await row(page, 'Weapon #1442').click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByText('Check selected', { exact: true }).click();
  await expect(page.getByText(/Last check:/)).toBeVisible();
  expect(lookups(1442)).toBe(1);
  expect(lookups(3265)).toBe(0);
});

test('NFT details and Withdrawals rows link to the NFT on Kleverscan', async ({ page }) => {
  // Don't really open Kleverscan: just note which page was asked for.
  await page.addInitScript(() => {
    window.open = (url) => { window.__opened = (window.__opened || []).concat(String(url)); return null; };
  });
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await page.getByText('#101', { exact: true }).click();
  await page.getByText('View on Kleverscan ↗').click();
  await expect.poll(() => page.evaluate(() => window.__opened || [])).toContain('https://kleverscan.org/asset/DVKNFT-1SW5%2F101');
  await page.goBack();

  await openMenuEntry(page, 'Withdrawals');
  await page.locator('textarea').fill('E38441');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/1 added/)).toBeVisible();
  await page.getByLabel('Equipment #38441 on Kleverscan').click();
  await expect.poll(() => page.evaluate(() => window.__opened || [])).toContain('https://kleverscan.org/asset/DVKEQNFT-1Q56%2F38441');
  // Tapping the link doesn't select the row.
  await expect(page.getByText('1 selected')).toHaveCount(0);
});

test('pasting a list file with wallet addresses says they were skipped', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.locator('textarea').fill(
    `Private Wallet ID\n${RECEIVING}\n\nIn-Game Wallet ID\n${IN_GAME}\n\nDevikin ID's\n101\n102\n\nWeapon IDs\n3265\n\nEquipment IDs\n1022`
  );
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/4 added\. 2 wallet addresses skipped \(only NFT IDs go on the list\)\./)).toBeVisible();
  await expect(page.getByText(/Skipped \(not an ID\)/)).toHaveCount(0);
  await expect(page.getByText('All kinds (4)', { exact: true })).toBeVisible();
});

test('"Check" skips arrived NFTs; "Check selected" can look at an arrived one again', async ({ page }) => {
  fake.chain.holders.set('weapon:3265', RECEIVING);
  fake.chain.transfers.push({ hash: 'tx3265b', kind: 'weapon', nonce: 3265, from: IN_GAME, to: RECEIVING, timestamp: 1791720000 });
  fake.chain.holders.set('weapon:1442', IN_GAME);
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await expect(page.getByText('3. Check', { exact: true })).toBeVisible();
  await expect(page.getByText('4. Results', { exact: true })).toBeVisible();
  await expect(page.getByText('Full check', { exact: true })).toHaveCount(0);
  await page.locator('textarea').fill('W3265 W1442');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added/)).toBeVisible();

  const lookups = (nonce) => fake.requests.filter((u) => u.includes('/assets/nft/holder/') && u.endsWith(`/${nonce}`)).length;
  await page.getByText('Check', { exact: true }).click();
  await expect(row(page, 'Weapon #3265')).toContainText('Arrived');
  expect(lookups(3265)).toBe(1);
  expect(lookups(1442)).toBe(1);

  // A second Check only looks at the one that hasn't arrived.
  await page.getByText('Check', { exact: true }).click();
  await expect.poll(() => lookups(1442)).toBe(2);
  await expect(page.getByText(/Looking up|Reading arrivals/)).toHaveCount(0);
  expect(lookups(3265)).toBe(1);

  // Later #3265 is sold on (the marketplace case): Check selected sees it.
  fake.chain.holders.set('weapon:3265', SELLER);
  await row(page, 'Weapon #3265').click();
  await page.getByText('Check selected', { exact: true }).click();
  await expect(row(page, 'Weapon #3265')).toContainText('In another wallet');
  expect(lookups(3265)).toBe(2);
});

test('resting the mouse on a chip explains it; tapping still filters', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.locator('textarea').fill('W3265 W1442');
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added/)).toBeVisible();

  const hint = page.getByTestId('chip-hint');
  await page.getByText('Still in the game', { exact: true }).hover();
  await expect(hint).toContainText("in your in-game wallet or in the game's main wallet");
  await page.getByText('Overdue (0)', { exact: true }).hover();
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText('support ticket');
  await page.mouse.move(5, 5);
  await expect(hint).toHaveCount(0);

  // Kind chips explain themselves: no box.
  await page.getByText('Weapons (2)', { exact: true }).hover();
  await page.waitForTimeout(300);
  await expect(hint).toHaveCount(0);

  // A tap still switches the filter.
  await page.getByText('Arrived (0)', { exact: true }).click();
  await expect(page.getByText('Weapon #3265')).toHaveCount(0);

  // Press and hold (like on the phone) shows it too.
  await page.mouse.move(5, 5);
  const box = await page.getByText('Not found', { exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await expect(hint).toContainText("don't exist on the chain");
});

test('a requested NFT in a stranger\'s wallet is flagged at once; the "requested" switch turns itself off', async ({ page }) => {
  fake.chain.holders.set('equipment:1022', fakeAddress('x'));
  fake.chain.holders.set('weapon:1442', IN_GAME);
  await openHub(page);
  await openMenuEntry(page, 'Withdrawals');
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();

  const requestedSwitch = page.locator('[role="switch"]').first();
  await page.locator('textarea').fill('E1022 W1442');
  await requestedSwitch.click();
  await page.getByText('Add to the list', { exact: true }).click();
  await expect(page.getByText(/2 added - all marked as requested/)).toBeVisible();
  // Off again, so the next paste isn't marked by accident.
  await expect(requestedSwitch).not.toBeChecked();

  await page.getByText('Check', { exact: true }).click();
  await expect(row(page, 'Equipment #1022')).toContainText('Requested - in another wallet!');
  await expect(row(page, 'Equipment #1022')).toContainText("seller's game wallet");
  await expect(row(page, 'Weapon #1442')).toContainText('Requested - waiting');
  // Not overdue yet - that still waits for the time limit.
  await expect(page.getByText('Overdue (0)')).toBeVisible();
});
