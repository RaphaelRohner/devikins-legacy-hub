/**
 * keyboard.spec.js - the website on a phone whose browser lays the keyboard
 * over the page without saying so (Raphael, 28 Oct 2026: the Klever app's K5
 * browser hid the field being typed in, on Wallets and in the chat). A touch
 * screen with no keyboard events at all is the worst case: the Hub then
 * counts the lower 42 % as keyboard and keeps the field above it.
 */
const { test, expect } = require('@playwright/test');
const { installFakeServers } = require('./fakeServers');
const { openHub, openMenuEntry } = require('./helpers');

test.use({ hasTouch: true, viewport: { width: 390, height: 800 } });

const KEYBOARD_TOP = 800 * (1 - 0.42);

test.beforeEach(async ({ context }) => {
  await installFakeServers(context);
  // (a pretend postman: the chat's sign-in screen asks it for nothing that matters here)
  await context.route('https://devi-postman-test.raphaelrohner.workers.dev/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}',
  }));
});

async function bottomOf(locator) {
  const box = await locator.boundingBox();
  return box.y + box.height;
}

test('Wallets: the address field stays above the keyboard', async ({ page }) => {
  await openHub(page, { keepWelcome: true }); // (a new visitor starts on Wallets)
  const field = page.getByPlaceholder('Paste a Klever wallet address (klv1...)');
  await field.tap();
  await expect.poll(() => bottomOf(field)).toBeLessThan(KEYBOARD_TOP);
});

test('Chat: the field at the bottom of the chat stays above the keyboard', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Chat');
  const field = page.getByTestId('chat-link-code');
  await field.scrollIntoViewIfNeeded();
  await field.tap();
  await expect.poll(() => bottomOf(field)).toBeLessThan(KEYBOARD_TOP);
  // The chat window ends above the keyboard.
  await expect.poll(() => bottomOf(page.getByTestId('chat-dock'))).toBeLessThanOrEqual(KEYBOARD_TOP + 2);
});

test('Ask Devi: the question field stays above the keyboard', async ({ page }) => {
  await openHub(page);
  await openMenuEntry(page, 'Ask Devi');
  const field = page.getByPlaceholder('Ask Devi something...');
  await field.tap();
  await expect.poll(() => bottomOf(field)).toBeLessThan(KEYBOARD_TOP);
});

test('a pop-up with a text field (naming a new wallet) moves above the keyboard', async ({ page }) => {
  await openHub(page, { keepWelcome: true });
  await page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill('klv170t523zjwkvc8j0k0smgysevegx0ddwjxx4nu2xpcsy7e3jvdccsh2m2sg');
  await page.getByText('Add', { exact: true }).click();
  const box = page.getByTestId('naming-box');
  await expect(box).toBeVisible();
  const field = box.locator('input[type="text"], input:not([type])').first();
  if (await field.count()) {
    await field.tap();
    await expect.poll(() => bottomOf(field)).toBeLessThan(KEYBOARD_TOP);
  }
});
