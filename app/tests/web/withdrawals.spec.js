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
  await openMenuEntry(page, 'Withdrawals');

  // 1. Wallets
  await page.getByPlaceholder('klv1… (in-game wallet)').fill(IN_GAME);
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
  await expect(row(page, 'Equipment #1022')).toContainText('In another wallet');
  await expect(row(page, 'Equipment #1022')).toContainText('held by klv1xxxx');
  await expect(row(page, 'Devikin #999')).toContainText('Not found on the chain');
  await expect(page.getByText(/Weapon #3265 · from klv1ssss/)).toBeVisible(); // arrivals log

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
