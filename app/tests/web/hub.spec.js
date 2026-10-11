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
const { litStarCount, openHub, openMenuEntry, goBack, addWalletAndFetch, storedPictureUrls, shownPictureSources } = require('./helpers');

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
  await expect(page.getByText(/First add a wallet, then scan the chain/)).toBeVisible();
  await openMenuEntry(page, 'About');
  await expect(page.getByText(new RegExp(`Version ${APP_VERSION.replace(/\./g, '\\.')}`))).toBeVisible();
  await expect(page.getByText('Website', { exact: false }).first()).toBeVisible();
  // The user counter comes from the (pretend) relay.
  for (const label of ['Today', '7 days', '30 days', 'Since launch', 'People', 'Visits', '61']) {
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

  await openMenuEntry(page, 'Wallets');
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(TEST_WALLET);
  await page.getByText('Add', { exact: true }).click();
  await expect.poll(pings).toBe(1);

  // Each later opening of the Hub is one more visit.
  await page.reload();
  await expect.poll(pings).toBe(2);
  await page.reload();
  await expect.poll(pings).toBe(3);
});

test('Ask Devi shows the website answers and hides app-only ones', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Ask Devi (Help)');
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
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.getByText('Import a set').click()]);
  await chooser.setFiles(zipPath);
  await expect.poll(() => dialogs.join('\n')).toMatch(/matched exactly/);
  await page2.getByText(/\(imported\)$/).first().click();
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
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Import a set').click()]);
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
