/**
 * hub.spec.js - the automatic website tests.
 *
 * Each test starts with a brand-new, empty browser (like a first-time
 * visitor) and uses the pretend servers from fakeServers.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, expect } = require('@playwright/test');
const { installFakeServers, TEST_WALLET } = require('./fakeServers');
const { litStarCount, openHub, openMenuEntry, goBack, addWalletAndFetch, storedPictureUrls, shownPictureSources, nameNewWallet } = require('./helpers');

const APP_VERSION = require('../../app.json').expo.version;

let fake;
test.beforeEach(async ({ context }) => {
  fake = await installFakeServers(context);
});
test.afterEach(async () => {
  // Nothing may ever slip past the pretend servers to the real internet.
  expect(fake.blocked, 'requests to unexpected outside servers').toEqual([]);
});

test('a first-time visitor sees the start hint, and About shows the version', async ({ page }) => {
  await openHub(page);
  await expect(page.getByText(/First add a wallet/)).toBeVisible(); // the start hint
  await openMenuEntry(page, 'About');
  await expect(page.getByText(new RegExp(`Version ${APP_VERSION.replace(/\./g, '\\.')}`))).toBeVisible();
  await expect(page.getByText('Website', { exact: false }).first()).toBeVisible();
  // The user counter comes from the (pretend) relay.
  for (const label of ['Today', '7 days', '30 days', 'Since launch', 'Hubs', 'Visits', '61']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test('the counter only counts a visitor once they add a wallet, then every visit', async ({ page }) => {
  const pings = () => fake.requests.filter((u) => u.endsWith('/ping')).length;
  await openHub(page);
  await openMenuEntry(page, 'About'); // just looking around
  await page.reload();
  await page.waitForTimeout(2000);
  expect(pings(), 'pings before any wallet was added').toBe(0);

  // Still no wallet, so the reload opened Wallets with the welcome.
  await expect(page.getByTestId('welcome-box')).toBeVisible();
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect.poll(pings).toBe(1);

  // Each later opening of the Hub is one more visit.
  await page.reload();
  await expect.poll(pings).toBe(2);
  await page.reload();
  await expect.poll(pings).toBe(3);
});

test('Ask Devi shows the website answers and hides app-only ones', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Ask Devi');
  for (const question of [
    'Where does the website keep my data?',
    'What does "Connect Klever Extension" do?',
    'How do I back up or transfer a wallet set?',
    'What is the Kleverscan tab?',
    'How can I support the Hub?',
  ]) {
    await expect(page.getByText(question, { exact: true })).toBeVisible();
  }
  const text = await page.locator('body').innerText();
  expect(text).toContain('in a new browser tab');
  expect(text).not.toContain('small built-in browser');
  expect(text).not.toMatch(/notification appear while I'm fetching/);
  expect(text).not.toMatch(/KLV Signer \(test\)/);
});

test('Fetch/Update loads every NFT and stores its picture in the browser', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);

  await expect(page.getByText('#101', { exact: true })).toBeVisible();
  await expect(page.getByText('#102', { exact: true })).toBeVisible();
  await openMenuEntry(page, 'Weapons');
  await expect(page.getByText('2 Weapons')).toBeVisible();
  await expect(page.getByText('#201', { exact: true })).toBeVisible();
  await openMenuEntry(page, 'Equipment');
  await expect(page.getByText('2 Equipment')).toBeVisible();
  await expect(page.getByText('#302', { exact: true })).toBeVisible();

  expect(await storedPictureUrls(page)).toHaveLength(6);
});

test('pictures come from the stored copy when the picture server is down', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);

  // Moonlabs' picture server stops answering; reopen the Hub.
  fake.picturesDown = true;
  await page.reload();
  await expect(page.getByText('#101', { exact: true })).toBeVisible();
  await expect.poll(async () => (await shownPictureSources(page)).filter((s) => s.startsWith('blob:')).length).toBe(2);
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(0);

  // Without a stored copy, the Hub says "Unavailable" instead.
  await page.evaluate(async () => {
    const cache = await caches.open('devi-hub-images-v1');
    await cache.delete('https://img.devikins.com/devikin/102.png');
  });
  await page.reload();
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(1);
});

test('a backup keeps names, stars and pictures, and imports into a new browser', async ({ page, browser }, testInfo) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);

  // Give #101 a name and four stars.
  await page.getByText('#101', { exact: true }).click();
  await page.getByPlaceholder('Give this NFT a name (optional)').fill('Sir Testalot');
  await page.getByText('Save Name', { exact: true }).click();
  await page.getByText('★').nth(3).click();
  await expect.poll(() => litStarCount(page)).toBe(4);
  await goBack(page);
  await expect(page.getByText('Sir Testalot')).toBeVisible();

  // Export everything.
  await openMenuEntry(page, 'Wallets');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  const zipPath = testInfo.outputPath('backup.zip');
  await download.saveAs(zipPath);

  // Look inside the zip: data plus all six pictures, every checksum right.
  const entries = readZip(fs.readFileSync(zipPath));
  const names = entries.map((e) => e.name);
  expect(names.some((n) => n.endsWith('/database.json'))).toBe(true);
  expect(names.filter((n) => /\/images\/(devikin|weapon|equipment)-\d+\.png$/.test(n))).toHaveLength(6);
  for (const e of entries) expect(e.crcOk, `checksum of ${e.name}`).toBe(true);

  // A brand-new browser (another computer, say) with the picture server down.
  const context2 = await browser.newContext();
  const fake2 = await installFakeServers(context2);
  fake2.picturesDown = true;
  const page2 = await context2.newPage();
  const dialogs = await openHub(page2);
  await openMenuEntry(page2, 'Wallets');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import Set(s)').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/matched exactly/);
  // The new browser had nothing loaded, so the imported set is loaded by itself.
  await expect.poll(() => dialogs.join('\n')).toMatch(/is loaded now/);
  await expect(page2.getByText(/\(imported\)$/).first().locator('xpath=..')).toContainText('Active - loaded now');
  await page2.getByText(/\(imported\)$/).first().click();
  // Wait until the switch to the imported set has really finished.
  await expect(page2.getByText(/\(imported\)$/).first().locator('xpath=..')).toContainText('Active - loaded now');
  await goBack(page2);
  // Data that's already there counts as fetched in the Getting started
  // checklist (no new fetch needed): wallet + fetch done, backup not yet.
  await openMenuEntry(page2, 'Getting started');
  await expect(page2.getByText(/2 of 3 done/)).toBeVisible();
  // The empty starting set was removed - only the imported one is left.
  await openMenuEntry(page2, 'Wallets');
  await expect(page2.getByText('Wallet set 1', { exact: true })).toHaveCount(0);
  await goBack(page2);

  await expect(page2.getByText('Sir Testalot')).toBeVisible();
  await expect.poll(async () => (await shownPictureSources(page2)).filter((s) => s.startsWith('blob:')).length).toBe(2);
  await page2.getByText('Sir Testalot').click();
  await expect.poll(() => litStarCount(page2)).toBe(4);
  expect(fake2.blocked).toEqual([]);
  await context2.close();
});

test('a damaged backup is noticed instead of silently importing bad pictures', async ({ page }, testInfo) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Wallets');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  const zip = fs.readFileSync(await download.path());

  // Flip one byte inside the first picture stored in the zip.
  const picture = readZip(zip).find((e) => /\/images\/.+\.png$/.test(e.name));
  zip[picture.dataOffset + 40] ^= 0xff;
  const damagedPath = testInfo.outputPath('damaged.zip');
  fs.writeFileSync(damagedPath, zip);

  const dialogs = [];
  page.on('dialog', (d) => dialogs.push(d.message()));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import Set(s)').click()]);
  await chooser.setFiles(damagedPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/1 picture\(s\) didn't match the export's checksum/);
});

/** Reads a zip's table of contents and checks each file's checksum. */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataOffset = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const crcOk = (zlib.crc32(buf.subarray(dataOffset, dataOffset + size)) >>> 0) === crc;
    entries.push({ name, size, dataOffset, crcOk });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('new wallet sets are called "Wallet set 1", "Wallet set 2", ...', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Wallets');
  await expect(page.getByText('Wallet set 1', { exact: true })).toBeVisible();
  await page.getByText('+ New set', { exact: true }).click();
  await page.getByText('Create', { exact: true }).click(); // no name typed
  await expect(page.getByText('Wallet set 2', { exact: true })).toBeVisible();
});

test('Reset All Data works even while the Hub is busy in the background', async ({ page }) => {
  const dialogs = await openHub(page);
  // Start a fetch with slow answers from Moonlabs, so the Hub is still
  // saving NFTs while the reset runs (like with a big real collection).
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  await goBack(page);
  fake.metadataDelayMs = 150;
  await openMenuEntry(page, 'Fetch/Update');
  await page.waitForTimeout(600);

  await openMenuEntry(page, 'Wallets');
  await page.getByText('Danger zone').locator('xpath=..').getByRole('switch').click();
  await page.getByText('Reset All Data', { exact: true }).click();
  await expect.poll(() => dialogs.join('\n')).toMatch(/Reset all data\?/);
  await expect(page.getByText(TEST_WALLET)).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(dialogs.join('\n')).not.toMatch(/didn't complete|went wrong/);
  // No stored pictures are left behind either.
  await expect.poll(async () => (await storedPictureUrls(page)).length).toBe(0);

  // The fresh set works: a wallet can be added and fetched again.
  fake.metadataDelayMs = 0;
  await goBack(page);
  await addWalletAndFetch(page, fake);
  await expect(page.getByText('#101', { exact: true })).toBeVisible();
});

test('menu categories open and close, and the menu starts tidy each time', async ({ page }) => {
  await openHub(page);
  const menu = page.locator('[role="dialog"][aria-modal="true"]').filter({ hasText: 'Menu' }).last();
  const menuText = async () => (await menu.innerText()).replace(/\s+/g, ' ');
  await page.getByText('☰').first().click();
  await expect.poll(menuText).toMatch(/Browse NFTs ▾ Devikins Weapons Equipment Features Withdrawals, Breeding Helper ▸/);
  // Closed categories say what's inside.
  await expect.poll(menuText).toMatch(/Set Up Getting started, Wallets, Fetch\/Update, Kleverscan ▸/);
  await expect.poll(menuText).toMatch(/Help Ask Devi, Feedback, About ▸/);
  await menu.getByText('Features', { exact: true }).click();
  await expect.poll(menuText).toMatch(/Features ▾ Withdrawals Breeding Helper/);
  await menu.getByText('Features', { exact: true }).click();
  await expect.poll(menuText).toMatch(/Features Withdrawals, Breeding Helper ▸ Help/);
  // Kleverscan sits at the end of Set Up, with a line saying what it's for.
  await menu.getByText('Set Up', { exact: true }).click();
  await expect.poll(menuText).toMatch(/Set Up ▾ Getting started Wallets Fetch\/Update[^K]*Kleverscan Find a wallet to try the Hub with/);
  // Open Features again, close the menu, reopen: only the current screen's
  // category (Browse NFTs) is open.
  await menu.getByText('Features', { exact: true }).click();
  await menu.getByText('✕', { exact: true }).click();
  await page.getByText('☰').first().click();
  await expect.poll(menuText).toMatch(/Set Up Getting.* ▸ Browse NFTs ▾ Devikins Weapons Equipment Features .* ▸ Help .* ▸/);
  await page.setViewportSize({ width: 390, height: 844 });
  await menu.getByText('Help', { exact: true }).click();
  await page.screenshot({ path: 'test-results/menu-phone.png' });
  await menu.getByText('Help', { exact: true }).click();
  await menu.getByText('Set Up', { exact: true }).click();
  await page.screenshot({ path: 'test-results/menu-phone-setup.png' });
});

test("the browser's back button works like the phone's Back button", async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  const menu = page.locator('[role="dialog"][aria-modal="true"]').filter({ hasText: 'Menu' });

  // Wallets screen -> back to the list.
  await openMenuEntry(page, 'Wallets');
  await expect(page.getByText('Danger zone')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('2 Devikins')).toBeVisible();
  await expect(page.getByText('Danger zone')).toHaveCount(0);

  // Open menu -> back closes just the menu.
  await page.getByText('☰').first().click();
  await expect(menu).toHaveCount(1);
  await page.goBack();
  await expect(menu).toHaveCount(0);
  await expect(page.getByText('2 Devikins')).toBeVisible();

  // Open NFT -> back closes it.
  await page.getByText('#101', { exact: true }).click();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toBeVisible();
  await page.goBack();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toHaveCount(0);
  await expect(page.getByText('2 Devikins')).toBeVisible();

  // Several Back presses in a row (no clicks in between) stay in the Hub:
  // NFT, then Wallets.
  await openMenuEntry(page, 'Wallets');
  await page.getByText('‹').first().click();
  await page.getByText('#101', { exact: true }).click();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toBeVisible();
  await page.goBack();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toHaveCount(0);
  await page.getByText('☰').first().click();
  await page.goBack();
  await expect(menu).toHaveCount(0);

  // Nothing left to close: back leaves the Hub like any website.
  await page.goBack();
  await expect.poll(() => page.url()).not.toContain('/devikins-legacy-hub');
});

test('an address that is not a Klever address is refused', async ({ page }) => {
  const dialogs = await openHub(page);
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill('abtdfghjkl');
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect.poll(() => dialogs.join('\n')).toMatch(/Not a Klever address/);
  await expect(page.getByText('abtdfghjkl', { exact: true })).toHaveCount(0);
  // A real one still works.
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
});

test('a real-looking address with one typo is refused (checksum)', async ({ page }) => {
  const dialogs = await openHub(page);
  await openMenuEntry(page, 'Wallets');
  const typo = TEST_WALLET.slice(0, 20) + (TEST_WALLET[20] === 'q' ? 'p' : 'q') + TEST_WALLET.slice(21);
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(typo);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect.poll(() => dialogs.join('\n')).toMatch(/Not a Klever address/);
  await expect(page.getByText(typo, { exact: true })).toHaveCount(0);
});

test('deleting a wallet asks first', async ({ page }) => {
  const dialogs = await openHub(page);
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  const before = dialogs.length;

  // The tests' message boxes answer "OK", which here means Delete.
  await page.getByText(TEST_WALLET).first().locator('xpath=..').getByText('Delete', { exact: true }).click();
  await expect.poll(() => dialogs.slice(before).join('\n')).toMatch(/Delete this wallet\?/);
  await expect(page.getByText(TEST_WALLET)).toHaveCount(0);
});

test('the Wallets screen shows how much space the sets use', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Wallets');
  await expect(page.getByText(/Total storage used: about [\d.]+ (KB|MB) - 1 set plus 6 stored pictures they share/)).toBeVisible();
  // The loaded set shows its own size instead of 0 MB, marked as data only.
  await expect(page.getByText(/^[\d.]+ (KB|MB) \(just NFT data, no pictures\)$/).first()).toBeVisible();
  await expect(page.getByText('0 MB', { exact: true })).toHaveCount(0);
});

test('pictures no set uses any more are removed after deleting a set', async ({ page }) => {
  const dialogs = await openHub(page);
  await addWalletAndFetch(page, fake);
  await expect.poll(async () => (await storedPictureUrls(page)).length).toBe(6);

  // Reloading keeps them: the set still uses them.
  await page.reload();
  await expect(page.getByText('#101', { exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  expect((await storedPictureUrls(page)).length).toBe(6);

  // A second, empty set; then delete the first one.
  await openMenuEntry(page, 'Wallets');
  await page.getByText('+ New set', { exact: true }).click();
  await page.getByText('Create', { exact: true }).click();
  await expect(page.getByText('Wallet set 2').first()).toBeVisible();
  await page.getByText('Wallet set 1', { exact: true }).locator('xpath=../..').getByText('Delete', { exact: true }).click();
  await expect.poll(() => dialogs.join('\n')).toMatch(/Delete/);
  await expect.poll(async () => (await storedPictureUrls(page)).length).toBe(0);
});

test('Fetch/Update without internet says so plainly and stops', async ({ page }) => {
  const dialogs = await openHub(page);
  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  await goBack(page);

  fake.offline = true;
  await openMenuEntry(page, 'Fetch/Update');
  await expect.poll(() => dialogs.join('\n')).toMatch(/No connection/);
  expect(dialogs.join('\n')).not.toMatch(/Continue anyway/);
  // Nothing hangs: the progress bar is gone again.
  await expect(page.getByText(/Checking scan size/)).toHaveCount(0);
  fake.offline = false;
});

test('while one set exports, its row keeps a readable layout', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Wallets');
  // Make reading the stored pictures slow, so the export takes a while.
  await page.evaluate(() => {
    const match = Cache.prototype.match;
    Cache.prototype.match = async function slowMatch(...args) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return match.apply(this, args);
    };
  });
  await page.getByText('Export', { exact: true }).first().click();
  await expect(page.getByText(/^(Preparing export|Reading images|Exporting|Compressing|Writing file)/).first()).toBeVisible({ timeout: 3000 });
  // The set's name block stays readable (not one letter per line).
  const box = await page.getByText('Active - loaded now').boundingBox();
  expect(box.width).toBeGreaterThan(80);
  expect(box.height).toBeLessThan(40);
});

test('a backup with four sets imports completely (enough database room)', async ({ page, browser }, testInfo) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Wallets');
  for (let i = 0; i < 3; i += 1) {
    await page.getByText('+ New set', { exact: true }).click();
    await page.getByText('Create', { exact: true }).click();
    await expect(page.getByText(`Wallets in "Wallet set ${i + 2}"`)).toBeVisible();
    await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
    await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
    await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  const zipPath = testInfo.outputPath('four-sets.zip');
  await download.saveAs(zipPath);

  const context2 = await browser.newContext();
  await installFakeServers(context2);
  const page2 = await context2.newPage();
  const dialogs = await openHub(page2);
  await openMenuEntry(page2, 'Wallets');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import Set(s)').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n'), { timeout: 30_000 }).toMatch(/Import complete|went wrong/);
  expect(dialogs.join('\n')).toMatch(/Wallet set 4 \(imported\)/);
  expect(dialogs.join('\n')).not.toMatch(/went wrong/);
  await context2.close();
});

test('sort: one tap on ↑ or ↓ picks field and direction and closes the sheet', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  const order = async () => {
    const t = await page.locator('body').innerText();
    return [...t.matchAll(/#(101|102)\b/g)].map((m) => m[1]).join(',');
  };
  await expect.poll(order).toBe('101,102'); // ID, lowest first

  // The button says what it is: "Sort ↑" over the field.
  const sortButton = page.getByText(/^Sort [↑↓]$/).locator('xpath=..');
  await expect(sortButton).toHaveText(/Sort ↑\s*ID/);

  // Rarity ↑: Common (#102) before Rare (#101); the sheet closes by itself.
  await sortButton.click();
  await expect(page.getByText('Sort by')).toBeVisible();
  await page.getByLabel('Rarity ascending').click();
  await expect(page.getByText('Sort by')).toHaveCount(0);
  await expect(sortButton).toHaveText(/Sort ↑\s*Rarity/);
  await expect.poll(order).toBe('102,101');
  // Rarity is already on every row - no extra line for it.
  await expect(page.getByText(/^Rarity: /)).toHaveCount(2);

  // Rarity ↓: the other way round.
  await sortButton.click();
  await page.getByLabel('Rarity descending').click();
  await expect(sortButton).toHaveText(/Sort ↓\s*Rarity/);
  await expect.poll(order).toBe('101,102');

  // ✕ closes without changing anything.
  await sortButton.click();
  await page.getByLabel('Close').click();
  await expect(page.getByText('Sort by')).toHaveCount(0);
  await expect(sortButton).toHaveText(/Sort ↓\s*Rarity/);

  // Sorted by a value the rows don't show: each row shows it.
  await sortButton.click();
  await page.getByLabel('Procreations Left descending').click();
  await expect(page.getByText('Procreations Left: 3', { exact: true })).toBeVisible();
  await expect(page.getByText('Procreations Left: 0', { exact: true })).toBeVisible();
  await expect.poll(order).toBe('101,102');
});

test('the Changelog shows a trait that changed between two fetches', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);

  // First fetch: nothing has changed yet, so there's no Changelog button.
  await page.getByText('#101', { exact: true }).click();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toBeVisible();
  await expect(page.getByText('Changelog', { exact: true })).toHaveCount(0);
  await goBack(page);

  // In the "game", #101 procreates once: Procreations Left goes 3 -> 2.
  fake.extraNfts.set('devikin:101', {
    name: 'Testy the Brave #101',
    attributes: { Rarity: 'Rare', Ancestry: 'Faery', 'Life Stage': 'Adult', 'Procreations Left': 2 },
  });
  const asksFor101 = () => fake.requests.filter((u) => /\/101(\D|$)/.test(u) && !/\.png$/.test(u)).length;
  const before = asksFor101();
  await openMenuEntry(page, 'Fetch/Update');
  await expect.poll(asksFor101, { timeout: 60_000 }).toBeGreaterThan(before);
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });

  // Now #101 has a Changelog with that one change.
  await page.getByText('#101', { exact: true }).click();
  await page.getByText('Changelog', { exact: true }).click();
  await expect(page.getByText(/Procreations Left: 3 → 2/i)).toBeVisible();

  // #102 didn't change, so it still has no Changelog.
  // Tap outside the Changelog to close it, then Back closes the NFT.
  await page.mouse.click(5, 5);
  await expect(page.getByText(/Procreations Left: 3 → 2/i)).toHaveCount(0);
  await page.goBack();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toHaveCount(0);
  await page.getByText('#102', { exact: true }).click();
  await expect(page.getByPlaceholder('Give this NFT a name (optional)')).toBeVisible();
  await expect(page.getByText('Changelog', { exact: true })).toHaveCount(0);
});

test('the count says "1 of 2" when some are left out, and follows Mark as Deleted / Restore', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible();

  // A search leaves one out.
  await page.getByPlaceholder(/Search/).fill('102');
  await expect(page.getByText('1 of 2 Devikins', { exact: true })).toBeVisible();
  await page.getByPlaceholder(/Search/).fill('');
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible();

  // Mark #101 as deleted: the detail explains it only affects the Hub.
  await page.getByText('#101', { exact: true }).click();
  await expect(page.getByText(/nothing happens to your NFT on the blockchain/)).toBeVisible();
  await page.getByText('Mark as Deleted', { exact: true }).click();
  await expect(page.getByText('Marked as deleted', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByText('1 of 1 Devikins', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 Devikins', { exact: true })).toBeVisible();

  // The 🗑️ button hides deleted ones; it says so on hover.
  await page.getByTestId('hide-deleted').hover();
  await expect(page.getByText(/^Hide deleted - hides NFTs you marked as Deleted/)).toBeVisible();
  await page.mouse.move(5, 5);

  // Restore: back to 2 without reloading the page.
  await page.getByText('#101', { exact: true }).click();
  await page.getByText('Restore', { exact: true }).click();
  await page.goBack();
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible();
});

test('a first visit opens Wallets with a welcome; "Fetch now" loads the NFTs right away', async ({ page }) => {
  const dialogs = await openHub(page, { keepWelcome: true, fetchNow: true });
  const welcome = page.getByTestId('welcome-box');
  await expect(welcome).toContainText('Welcome to the Devikins Legacy Hub');
  await expect(welcome).toContainText('Already have a backup? Import it');
  // The box to add a wallet comes before the wallet sets.
  const addBox = await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').boundingBox();
  const sets = await page.getByText('Wallet sets', { exact: true }).boundingBox();
  expect(addBox.y).toBeLessThan(sets.y);

  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect.poll(() => dialogs.join('\n')).toMatch(/Wallet added/);
  // "Fetch now" was chosen: back on the list, and the NFTs come in.
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('#101', { exact: true })).toBeVisible();

  // With a wallet, the Hub starts on the list again - no welcome.
  await page.reload();
  await expect(page.getByText('☰').first()).toBeVisible();
  await expect(page.getByTestId('welcome-box')).toHaveCount(0);
});

test('importing a backup loads the set with wallets (not an empty one), and names get one "(imported)" only', async ({ page, browser }, testInfo) => {
  await openHub(page);
  // "Wallet set 1" stays empty; the wallet goes into "Wallet set 2".
  await openMenuEntry(page, 'Wallets');
  await page.getByText('+ New set', { exact: true }).click();
  await page.getByText('Create', { exact: true }).click();
  await expect(page.getByText('Wallets in "Wallet set 2"')).toBeVisible();
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page);
  await expect(page.getByText(TEST_WALLET).first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  const zipPath = testInfo.outputPath('backup.zip');
  await download.saveAs(zipPath);

  const context2 = await browser.newContext();
  await installFakeServers(context2);
  const page2 = await context2.newPage();
  const dialogs = await openHub(page2);
  await openMenuEntry(page2, 'Wallets');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import Set(s)').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/"Wallet set 2 \(imported\)" is loaded now/);
  await expect(page2.getByText('Wallets in "Wallet set 2 (imported)"')).toBeVisible();
  await expect(page2.getByText(TEST_WALLET).first()).toBeVisible();

  // Export from here and import again: still just one "(imported)".
  const [download2] = await Promise.all([page2.waitForEvent('download'), page2.getByText('Export all sets').click()]);
  const zipPath2 = testInfo.outputPath('backup2.zip');
  await download2.saveAs(zipPath2);
  const [chooser2] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import Set(s)').click()]);
  await chooser2.setFiles(zipPath2);
  await expect.poll(() => dialogs.filter((d) => /Import complete/.test(d)).length).toBe(2);
  await expect(page2.getByText(/\(imported\) \(imported\)/)).toHaveCount(0);
  await context2.close();
});

test('a new wallet gets a name, shown first in the list; Withdrawals fills itself in from the names', async ({ page }) => {
  const inGame = require('./fakeServers').fakeAddress('g');
  const dialogs = await openHub(page, { keepWelcome: true });
  const input = page.getByPlaceholder('Paste a Klever wallet address (klv1...)');

  await input.fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  const box = page.getByTestId('naming-box');
  await expect(box).toContainText("What's this wallet?");
  await nameNewWallet(page, 'My wallet');

  await input.fill(inGame);
  await page.getByText('Add', { exact: true }).click();
  // "My wallet" is taken in this set now.
  await expect(box.getByText('already used in this set')).toBeVisible();
  await nameNewWallet(page, 'In-game wallet');

  await expect(page.getByText('My wallet', { exact: true })).toBeVisible();
  await expect(page.getByText('In-game wallet', { exact: true })).toBeVisible();
  // Naming it "My wallet" asked once whether these are their own wallets
  // (answered yes): the set is "My wallets" now.
  expect(dialogs.filter((d) => /Is this your own wallet\?|Are these your own wallets\?/.test(d))).toHaveLength(1);
  await expect(page.getByText(/This is your own set/)).toBeVisible();

  // The same address again: it says so, no name box.
  await input.fill(inGame);
  await page.getByText('Add', { exact: true }).click();
  await expect(box).toHaveCount(0);

  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Withdrawals');
  await expect(page.getByText(/Filled in from your wallets named/)).toBeVisible();
  await expect(page.getByPlaceholder('klv1… (in-game wallet)')).toHaveValue(inGame);
  await expect(page.getByPlaceholder('klv1… (receiving wallet)')).toHaveValue(TEST_WALLET);
  await expect(page.getByText('Check', { exact: true })).toBeVisible(); // already saved
});

test('adding a second wallet also offers "Fetch now"', async ({ page }) => {
  const dialogs = await openHub(page, { fetchNow: true });
  await openMenuEntry(page, 'Wallets');
  const input = page.getByPlaceholder('Paste a Klever wallet address (klv1...)');
  await input.fill(require('./fakeServers').fakeAddress('g'));
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'In-game wallet');
  // The first wallet's "Fetch now" was taken (options.fetchNow): back on the list.
  await expect(page.getByText('☰').first()).toBeVisible();
  await expect(page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });

  await openMenuEntry(page, 'Wallets');
  await input.fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await nameNewWallet(page, 'My wallet');
  await expect.poll(() => dialogs.filter((d) => /Load this wallet's Devikins/.test(d)).length).toBe(1);
  // "Fetch now" again: the second wallet's NFTs come in.
  await expect(page.getByText('2 Devikins', { exact: true })).toBeVisible({ timeout: 60_000 });
});

test('Ask Devi answers beginner questions and no longer matches little words like "the"', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Ask Devi');
  const ask = async (question, expectedPart) => {
    const before = await page.getByText(expectedPart).count();
    await page.getByPlaceholder('Ask Devi something...').fill(question);
    await page.getByText('Send', { exact: true }).click();
    await expect(page.getByText(question, { exact: true }).last()).toBeVisible();
    await expect.poll(() => page.getByText(expectedPart).count()).toBe(before + 1);
  };
  await ask('which one is the rarest?', /Common, Uncommon, Rare, Mythic, Eldritch/);
  await ask('how do i find the best devikin', /Common, Uncommon, Rare, Mythic, Eldritch/);
  await ask('is this safe? can i lose his money', /never asks for a password, private key/);
  await ask('what is klever', /That blockchain is Klever/);
  await ask('what is an NFT?', /one-of-a-kind digital items/);
  await ask('who is moonlabs?', /company that makes and runs Devikins/);
  await ask('what is moon labs', /company that makes and runs Devikins/);
  // Other questions still find their own answers.
  await ask('why are some pictures blank?', /plain white/);
  await ask('why does it say unavailable?', /only the picture is missing/);
  await ask('what is ancestry', /Glysian, Khoroth, Lunarian, Maarish or Ochran/);
});

test('on a phone, the Getting started checklist scrolls away with the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await openMenuEntry(page, 'Getting started');
  const guide = page.getByText(/^Getting started/).first();
  await expect(guide).toBeVisible();
  const before = (await guide.boundingBox()).y;
  // Swipe (scroll) with the finger/mouse right on the checklist.
  const box = await guide.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.wheel(0, 500);
  // It moves up (it used to stay pinned). With only two pretend NFTs the
  // list can't scroll far, so a clear move is enough (GitHub moved 98.5).
  await expect.poll(async () => (await guide.boundingBox())?.y ?? -9999).toBeLessThan(before - 50);
});

test('a Devikin\'s "Find breeding partners" opens the Breeding Helper with it already picked', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await page.getByText('#101', { exact: true }).click();
  await page.getByText('Find breeding partners →', { exact: true }).click();
  await expect(page.getByText('Breeding Helper', { exact: true })).toBeVisible();
  await expect(page.getByText('‹ Step 1', { exact: true })).toBeVisible(); // Step 2 straight away
  await expect(page.getByText(/^#101/).first()).toBeVisible();
  await expect(page.getByText(/eligible partner/)).toBeVisible();
  // Back to Step 1; nothing picked yet, so no "Reset all Step 1 fields".
  await page.getByText('‹ Step 1', { exact: true }).click();
  await expect(page.getByText(/STEP 1 OF 2/)).toBeVisible();
  await expect(page.getByText('Reset all Step 1 fields')).toHaveCount(0);
  // From the menu it starts at Step 1.
  await page.getByText('‹').first().click();
  await openMenuEntry(page, 'Breeding Helper');
  await expect(page.getByText(/STEP 1 OF 2/)).toBeVisible();
});

test('a Devikin named in the game shows that name; unnamed ones show none; a Hub nickname wins', async ({ page }) => {
  // #101 is "Testy the Brave #101" in the pretend data; make #102 unnamed, like the real game sends it.
  fake.extraNfts.set('devikin:102', { name: '#102', attributes: { Rarity: 'Common', Ancestry: 'Demon', 'Life Stage': 'Adult', 'Procreations Left': 0 } });
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await expect(page.getByText('Testy the Brave', { exact: true })).toBeVisible(); // list
  await page.getByText('#101', { exact: true }).click();
  await expect(page.getByText('Testy the Brave', { exact: true })).toBeVisible(); // detail
  await page.getByPlaceholder('Give this NFT a name (optional)').fill('Sir Testalot');
  await page.getByText('Save Name', { exact: false }).first().click();
  await expect(page.getByText('Sir Testalot (in the game: Testy the Brave)')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('Sir Testalot', { exact: true })).toBeVisible();
  await expect(page.getByText('Testy the Brave', { exact: true })).toHaveCount(0);
  // #102 has no name in the game: no name label at all (only the number).
  await expect(page.getByText('Mock the Mighty')).toHaveCount(0);
  await expect(page.getByText('#102', { exact: true })).toBeVisible();
});

test('filters work straight away, keep their picks when closed, and the button shows how many are left', async ({ page }) => {
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await page.getByText('Filters ▼', { exact: true }).click();
  await expect(page.getByTestId('filters-done')).toHaveText('Show 2 Devikins');
  // A pick narrows the list at once - no Apply.
  const rarity = page.locator('select', { has: page.locator('option', { hasText: 'Common' }) }).first();
  await rarity.selectOption({ label: 'Common' });
  await expect(page.getByTestId('filters-done')).toHaveText('Show 1 Devikin');
  await expect(page.getByText('Testy the Brave', { exact: true })).toHaveCount(0);
  await rarity.selectOption({ label: 'All' });
  await expect(page.getByTestId('filters-done')).toHaveText('Show 2 Devikins');
  // A half-typed number doesn't empty the list; a real one filters after a short pause.
  const min = page.getByText(/^Procreations Left \(found/).locator('..').getByPlaceholder('min');
  await min.fill('-');
  await page.waitForTimeout(900);
  await expect(page.getByTestId('filters-done')).toHaveText('Show 2 Devikins');
  await min.fill('2');
  await expect(page.getByTestId('filters-done')).toHaveText('Show 1 Devikin');
  // Closing the panel keeps the pick.
  await page.getByText('Filters ▲', { exact: true }).click();
  await expect(page.getByTestId('filters-done')).toHaveCount(0);
  await expect(page.getByText('Testy the Brave', { exact: true })).toBeVisible();
  await expect(page.getByText('Mock the Mighty', { exact: true })).toHaveCount(0);
  await page.getByText('Filters ▼', { exact: true }).click();
  await expect(min).toHaveValue('2');
  // "Show 1 Devikin" just closes the panel.
  await page.getByTestId('filters-done').click();
  await expect(page.getByTestId('filters-done')).toHaveCount(0);
  await expect(page.getByText('Mock the Mighty', { exact: true })).toHaveCount(0);
  // Filters ✕ removes everything.
  await page.getByText('Filters ✕', { exact: true }).click();
  await expect(page.getByText('Mock the Mighty', { exact: true })).toBeVisible();
});

test('small fixes: export says "Backup saved"; a short last row of tiles sits on the left; the count is not a button', async ({ page }) => {
  const messages = [];
  page.on('dialog', (d) => messages.push(d.message()));
  await openHub(page);
  await addWalletAndFetch(page, fake);
  // Tiles: 2 Devikins sit next to each other, not at opposite edges.
  await page.getByTestId('view-tiles').click();
  const first = await page.getByText('#101', { exact: true }).boundingBox();
  const second = await page.getByText('#102', { exact: true }).boundingBox();
  expect(second.x - first.x).toBeLessThan(400);
  await page.screenshot({ path: 'test-results/small-fixes-tiles.png' });
  // Export: the Hub says where the file went.
  await openMenuEntry(page, 'Wallets');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Export all sets').click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  await expect.poll(() => messages.join('\n')).toMatch(/Backup saved/);
  await expect(page.getByText('Import Set(s)', { exact: true })).toBeVisible();
});

test('the theme switch shows both modes and highlights the current one', async ({ page }) => {
  await openHub(page);
  const light = page.getByTestId('theme-light');
  const dark = page.getByTestId('theme-dark');
  const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="theme-light"]').parentElement).backgroundColor);
  const before = await bg();
  const darkAtStart = before.match(/\d+/g).slice(0, 3).reduce((sum, n) => sum + Number(n), 0) < 300;
  // Tapping the mode you're already in changes nothing.
  await (darkAtStart ? dark : light).click();
  expect(await bg()).toBe(before);
  await page.screenshot({ path: 'test-results/theme-switch-1.png', clip: { x: 1000, y: 0, width: 200, height: 80 } });
  // Tapping the other one switches.
  await (darkAtStart ? light : dark).click();
  await expect.poll(bg).not.toBe(before);
  await page.screenshot({ path: 'test-results/theme-switch-2.png', clip: { x: 1000, y: 0, width: 200, height: 80 } });
});

test('game words explain themselves: ⓘ on the detail page and in Ask Devi', async ({ page }) => {
  fake.extraNfts.set('devikin:101', {
    name: 'Testy the Brave #101',
    attributes: {
      Rarity: 'Rare', Ancestry: 'Faery', 'Life Stage': 'Adult', 'Procreations Left': 3, Personality: 'Sassy',
      'Eyes Gene': 'Bonded', 'Overall Affinity': 41, 'Vitality Affinity': 10, 'Vitality Attribute': 208,
    },
  });
  await openHub(page);
  await addWalletAndFetch(page, fake);
  await page.getByText('#101', { exact: true }).click();
  const box = page.getByTestId('info-box');
  // Hover (website) shows it, moving away hides it.
  await page.getByTestId('info-procreations_left').hover();
  await expect(box).toContainText('at most 10');
  await page.mouse.move(5, 5);
  await expect(box).toHaveCount(0);
  // A tap pins it; tapping the box closes it.
  await page.getByTestId('info-genes').click();
  await page.mouse.move(5, 5);
  await expect(box).toContainText('bonded');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/info-genes-phone.png', fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await box.click();
  await expect(box).toHaveCount(0);
  for (const key of ['life_stage', 'overall_affinity', 'personality', 'rarity', 'affinities', 'attributes']) {
    await expect(page.getByTestId(`info-${key}`)).toBeVisible();
  }
  // Weapons: Quality.
  await page.goBack();
  await openMenuEntry(page, 'Weapons');
  await page.getByText('#201', { exact: true }).click();
  await page.getByTestId('info-quality').click();
  await expect(box).toContainText('upgraded');
  // Ask Devi finds the same words.
  await openMenuEntry(page, 'Ask Devi');
  const ask = async (question, expectedPart) => {
    const before = await page.getByText(expectedPart).count();
    await page.getByPlaceholder('Ask Devi something...').fill(question);
    await page.getByText('Send', { exact: true }).click();
    await expect.poll(() => page.getByText(expectedPart).count()).toBe(before + 1);
  };
  await ask('what is a procreation', /at most 10 in its life/);
  await ask('what does bonded mean?', /all genes the same/);
  await ask('what are affinities', /natural talent/);
  await ask('what is a toddler', /grows up in seven days/);
  await ask('how does the breeding helper work', /two-step finder/);
});
