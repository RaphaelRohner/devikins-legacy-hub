/**
 * helpers.js - small building blocks the website tests share, written so
 * each test reads like the steps a person would take.
 */
const { expect } = require('@playwright/test');
const { TEST_WALLET } = require('./fakeServers');

/** Opens the Hub and waits until the start screen is ready. Pop-up
 *  messages are recorded (and closed) so a test can check their text. */
async function openHub(page, options = {}) {
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    // "Wallet added" offers "Fetch now"; the tests choose "Add another
    // wallet first" and start the fetch themselves, step by step
    // (options.fetchNow picks "Fetch now" instead).
    if (/^Wallet added/.test(dialog.message()) && dialog.type() === 'confirm' && !options.fetchNow) await dialog.dismiss();
    else await dialog.accept();
  });
  // Use the browser's own message boxes, which the tests read and close
  // automatically (see src/web/alertForWeb.js). One test checks the
  // Hub's in-page box on purpose (dialogs.spec.js).
  if (!options.inPageDialogs) await page.addInitScript(() => { window.__HUB_NATIVE_DIALOGS = true; });
  await page.goto('./');
  // A brand-new visitor lands on Wallets with the welcome box (14 Oct
  // 2026). Most tests start from the NFT list, so they go back there
  // (options.keepWelcome stays on the welcome screen).
  const welcome = page.getByTestId('welcome-box');
  await expect(page.getByText('☰').first().or(welcome)).toBeVisible();
  if (!options.keepWelcome && (await welcome.isVisible())) {
    await page.getByText('‹').first().click();
    await expect(page.getByText('☰').first()).toBeVisible();
  }
  return dialogs;
}

/** Opens one entry of the ☰ menu, e.g. "Wallets" or "Weapons". Some
 *  entries carry a count once there's data, like "Wallets (1)". */
async function openMenuEntry(page, label) {
  await page.getByText('☰').first().click();
  // Look only inside the menu (other parts of the page, like the Getting
  // started checklist, use some of the same words).
  const menu = page.locator('[role="dialog"][aria-modal="true"]').filter({ hasText: 'Menu' }).last();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = menu.getByText(new RegExp(`^${escaped}( \\(\\d+\\))?$`)).first();
  // The menu has collapsible categories: open the one holding the entry.
  for (const category of ['Set Up', 'Browse NFTs', 'Tools', 'Help']) {
    if (await target.isVisible()) break;
    const header = menu.getByText(category, { exact: true }).first();
    await header.click();
    if (!(await target.isVisible())) await header.click(); // not in here - close it again
  }
  await target.click();
}

/** Goes back from a sub-screen (the round ‹ button). */
async function goBack(page) {
  await page.getByText('‹').first().click();
}

/** Adds the test wallet, runs Fetch/Update and waits until all six test
 *  NFTs and their pictures are in. */
async function addWalletAndFetch(page, fake) {
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  await goBack(page);
  await openMenuEntry(page, 'Fetch/Update');
  // Done when every NFT's details and picture have been asked for and the
  // progress bar has gone again.
  await expect.poll(() => countPictureRequests(fake), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('2 Devikins')).toBeVisible();
}

function countPictureRequests(fake) {
  return new Set(fake.requests.filter((u) => /devikins\.com\/.+\.png$/.test(u))).size;
}

/** How many pictures the website has stored in the browser. */
async function storedPictureUrls(page) {
  return page.evaluate(async () => {
    const cache = await caches.open('devi-hub-images-v1');
    return (await cache.keys()).map((request) => request.url).sort();
  });
}

/** The picture addresses currently shown on screen ("blob:" = the stored
 *  copy, "https:" = straight from the picture server). */
async function shownPictureSources(page) {
  return page.evaluate(() => [...document.querySelectorAll('img')].map((img) => img.src));
}

/** The colours of the five rating stars in an NFT's detail view. Lit
 *  stars share one colour, unlit ones another. */
async function starColours(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('div')]
      .filter((el) => el.childElementCount === 0 && el.textContent === '★')
      .map((el) => getComputedStyle(el).color)
  );
}

/** How many of the five stars are lit (counted from the left). */
async function litStarCount(page) {
  const colours = await starColours(page);
  if (colours.length !== 5) return -1; // not (yet) showing one set of 5 stars
  // With 1-4 stars, the last star is unlit and the first is lit. (0 or 5
  // lit stars look the same to this check, so the tests use 4.)
  if (colours.every((c) => c === colours[0])) return -1; // 0 or 5 - can't tell
  return colours.filter((c) => c !== colours[4]).length;
}

module.exports = { litStarCount, openHub, openMenuEntry, goBack, addWalletAndFetch, storedPictureUrls, shownPictureSources };
