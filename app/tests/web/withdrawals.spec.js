/**
 * withdrawals.spec.js - automatic tests for the Withdrawals screen, on a
 * pretend blockchain (see fakeServers.js: fake.chain).
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, fakeAddress, GAME_MAIN_WALLET } = require('./fakeServers');
const { openHub, openMenuEntry } = require('./helpers');

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
  await expect(page.getByText(IN_GAME).first()).toBeVisible();
  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Withdrawals');

  // 1. Wallets: pick the in-game wallet from the set, paste the other
  await page.getByText('Choose from my wallets').first().click();
  await page.getByText(/set: /).first().click();
  await expect(page.getByPlaceholder('klv1… (in-game wallet)')).toHaveValue(IN_GAME);
  await page.getByPlaceholder('klv1… (receiving wallet)').fill(RECEIVING);
  await page.getByText('Save', { exact: true }).click();
  await expect(page.getByText('Check now', { exact: true })).toBeVisible();

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
  await page.getByText('Check now', { exact: true }).click();
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
  await page.getByText('Weapons', { exact: true }).last().click();
  await page.getByText('Still in the game', { exact: true }).click();
  await page.getByText('ID ↑', { exact: true }).click();
  const shown = await page.locator('div[tabindex="0"]').filter({ hasText: /^.?(Weapon|Equipment|Devikin) #\d+/ }).allInnerTexts();
  expect(shown.map((t) => t.match(/#(\d+)/)[1])).toEqual(['1442', '1450']);
  await page.getByText('ID ↓', { exact: true }).click();
  await page.getByText('Anywhere', { exact: true }).click();
  const shown2 = await page.locator('div[tabindex="0"]').filter({ hasText: /^.?(Weapon|Equipment|Devikin) #\d+/ }).allInnerTexts();
  expect(shown2.map((t) => t.match(/#(\d+)/)[1])).toEqual(['3265', '1450', '1442']);
  await page.getByText('All kinds', { exact: true }).click();
  await page.getByText('Needs attention first', { exact: true }).click();

  // 5. 31 minutes later, #1442 still hasn't come: overdue
  await page.clock.fastForward('31:00');
  await expect(row(page, 'Weapon #1442')).toContainText('Overdue');
  await expect(page.getByText('Overdue (1)')).toBeVisible();
  await expect(page.getByText(/overdue list \(1\)/)).toBeVisible();

  // 6. The game finally sends it
  fake.chain.holders.set('weapon:1442', RECEIVING);
  fake.chain.transfers.push({ hash: 'tx1442', kind: 'weapon', nonce: 1442, from: IN_GAME, to: RECEIVING, timestamp: now + 1900 });
  await page.getByText('Check now', { exact: true }).click();
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
  await page.getByText('Check now', { exact: true }).click();
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
