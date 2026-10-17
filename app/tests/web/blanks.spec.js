/**
 * blanks.spec.js - the "Hide blanks" switch: NFTs with a missing, plain
 * white or background-only picture can be hidden from the lists.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers, IMAGE_URL } = require('./fakeServers');
const { openHub, openMenuEntry, addWalletAndFetch } = require('./helpers');

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

function blanksSwitch(page) {
  return page.getByText('Hide blanks', { exact: true }).locator('..').locator('input');
}

test('Hide blanks hides NFTs with missing or empty pictures, and steps aside for Compare', async ({ page }) => {
  fake.blankPictures.set(IMAGE_URL.devikin(102), 'missing');
  fake.blankPictures.set(IMAGE_URL.weapon(202), 'white');
  fake.blankPictures.set(IMAGE_URL.equipment(302), 'background');

  await openHub(page);
  await addWalletAndFetch(page, fake);

  // Off: everything shows.
  await expect(page.getByText('#101', { exact: true })).toBeVisible();
  await expect(page.getByText('#102', { exact: true })).toBeVisible();

  // On: the Devikin without a picture disappears.
  await blanksSwitch(page).click();
  await expect(page.getByText('#102', { exact: true })).toHaveCount(0);
  await expect(page.getByText('#101', { exact: true })).toBeVisible();

  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('#201', { exact: true })).toBeVisible();
  await expect(page.getByText('#202', { exact: true })).toHaveCount(0); // plain white

  await openMenuEntry(page, 'Equipment');
  await expect(page.getByText('#301', { exact: true })).toBeVisible();
  await expect(page.getByText('#302', { exact: true })).toHaveCount(0); // only the background

  // Remembered after reopening the Hub.
  await page.reload();
  await openMenuEntry(page, 'Equipment');
  await expect(page.getByText('#301', { exact: true })).toBeVisible();
  await expect(page.getByText('#302', { exact: true })).toHaveCount(0);

  // Compare: both switches step aside, and come back afterwards.
  await page.getByText('Compare', { exact: true }).click();
  await expect(page.getByText('Hide blanks', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Hide deleted', { exact: true })).toHaveCount(0);
  await page.getByText('Tap one to compare', { exact: true }).click();
  await expect(page.getByText('Hide blanks', { exact: true })).toBeVisible();

  // Off again: the blank one is back.
  await blanksSwitch(page).click();
  await expect(page.getByText('#302', { exact: true })).toBeVisible();
});

test('a picture first stored as blank is checked again and shows once Moonlabs fixed it', async ({ page }) => {
  await page.clock.install();
  fake.blankPictures.set(IMAGE_URL.devikin(102), 'background');
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await blanksSwitch(page).click();
  await expect(page.getByText('#102', { exact: true })).toHaveCount(0);

  // Moonlabs now delivers the full picture; the next hourly check (about a
  // minute after opening) downloads blank-marked pictures again.
  fake.blankPictures.delete(IMAGE_URL.devikin(102));
  await page.clock.fastForward(65_000);
  await expect(page.getByText('#102', { exact: true })).toBeVisible({ timeout: 30_000 });
});

test('Hide blanks also hides an NFT whose picture arrived broken (shows "Unavailable")', async ({ page }) => {
  fake.blankPictures.set(IMAGE_URL.devikin(102), 'broken');
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await expect(page.getByText('#102', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable').first()).toBeVisible();
  await blanksSwitch(page).click();
  await expect(page.getByText('#102', { exact: true })).toHaveCount(0);
  await expect(page.getByText('#101', { exact: true })).toBeVisible();
});
