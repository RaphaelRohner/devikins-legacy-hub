/**
 * chat.spec.js - the Chat screen (stage 2a): two players, each in their
 * own browser, sign in with a pretend Klever extension, choose nicknames,
 * find each other, send and accept a contact request, write, and block.
 *
 * The postman here is the REAL postman code (app/chat/postman), run as a
 * little local server by chatPostman.mjs - only Cloudflare and Klever's
 * API are pretend. The wallet signatures are real ones, made with
 * Klever's own library, so the sign-in check is the real one too.
 */
const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { installFakeServers } = require('./fakeServers');
const { openHub, openMenuEntry } = require('./helpers');

const POSTMAN_HOST = 'devi-postman-test.raphaelrohner.workers.dev';

/** Starts the real postman code as a little local server (chatPostman.mjs). */
async function startPostman() {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', path.join(__dirname, 'chatPostman.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      const m = String(d).match(/ready (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`postman stopped (${code})`)));
  });
  const local = `http://127.0.0.1:${port}`;
  const post = async (p, body) => (await fetch(local + p, { method: 'POST', body: JSON.stringify(body) })).json();
  return {
    local,
    stop: () => child.kill(),
    newWallet: async (nfts) => {
      const { address } = await post('/__test/wallet', { nfts });
      return { address, sign: async (text) => (await post('/__test/sign', { address, text })).signature };
    },
  };
}

/** One player: a browser context with the fake servers, the postman and a pretend Klever extension. */
async function openPlayer(browser, postman, wallet, { extension = true } = {}) {
  const context = await browser.newContext();
  await installFakeServers(context);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  await context.route(`https://${POSTMAN_HOST}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    const headers = {};
    if (request.headers().authorization) headers.authorization = request.headers().authorization;
    const r = await fetch(postman.local + url.pathname + url.search, { method: request.method(), headers, body: request.postData() || undefined });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: await r.text() });
  });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__HUB_CHAT_MAIL_MS = 700; });
  if (extension) {
    await page.exposeFunction('__testSign', (text) => wallet.sign(text));
    await page.addInitScript((address) => {
      window.kleverWeb = {
        getWalletAddress: () => address,
        getProvider: () => ({ api: 'https://api.mainnet.klever.org' }),
        signMessage: (text) => window.__testSign(text),
      };
      window.kleverHub = { initialize: async () => {} };
    }, wallet.address);
  }
  await openHub(page);
  await openMenuEntry(page, 'Chat');
  return { context, page };
}

async function signInAs(page, nickname) {
  await page.getByTestId('chat-sign-in').click();
  await page.getByTestId('chat-nickname').fill(nickname);
  await page.getByTestId('chat-save-nickname').click();
  await expect(page.getByText(`Chat · ${nickname}`)).toBeVisible();
}

test('two players: sign in, find each other, request, accept, write, block', async ({ browser }) => {
  test.setTimeout(180_000);
  const postman = await startPostman();
  const alice = await openPlayer(browser, postman, await postman.newWallet(3));
  const bob = await openPlayer(browser, postman, await postman.newWallet(12));

  await expect(alice.page.getByText(/This is NOT a transaction|It is NOT a transaction/)).toBeVisible();
  await signInAs(alice.page, 'Alice');
  await signInAs(bob.page, 'Bob');

  // Alice finds Bob and asks him
  await alice.page.getByTestId('chat-search').fill('bo');
  await alice.page.getByTestId('chat-search-button').click();
  await expect(alice.page.getByTestId('chat-result')).toHaveText(/Bob/);
  await alice.page.getByTestId('chat-ask').click();
  await expect(alice.page.getByText('waiting for answer')).toBeVisible();
  await expect(alice.page.getByText(/Next contact request possible in 5 min/)).toBeVisible();

  // Bob gets the request (by himself, within a moment) and accepts
  await expect(bob.page.getByTestId('chat-request')).toHaveText(/Alice/);
  await bob.page.getByTestId('chat-accept').click();
  await expect(bob.page.getByTestId('chat-contact')).toHaveText(/Alice/);

  // Alice's side turns into a contact; she writes
  await expect(alice.page.getByText('waiting for answer')).toHaveCount(0);
  await alice.page.getByTestId('chat-contact').click();
  await alice.page.getByTestId('chat-draft').fill('Hi Bob! Want to trade?');
  await alice.page.getByTestId('chat-send').click();
  await expect(alice.page.getByText('Hi Bob! Want to trade?')).toBeVisible();
  await expect(alice.page.getByTestId('chat-draft')).toHaveValue('');

  // Bob sees an unread message, opens it and answers (Enter sends)
  await expect(bob.page.getByTestId('chat-contact')).toContainText('1');
  await bob.page.getByTestId('chat-contact').click();
  await expect(bob.page.getByText('Hi Bob! Want to trade?')).toBeVisible();
  await bob.page.getByTestId('chat-draft').fill('Sure, which one?');
  await bob.page.getByTestId('chat-draft').press('Enter');
  await expect(alice.page.getByText('Sure, which one?')).toBeVisible();

  // Bob blocks Alice: her next message is refused by the postman
  await bob.page.getByText('Block', { exact: true }).click();
  await expect(bob.page.getByText('You blocked Alice.')).toBeVisible();
  await alice.page.getByTestId('chat-draft').fill('Hello?');
  await alice.page.getByTestId('chat-send').click();
  await expect(alice.page.getByTestId('chat-error')).toContainText("isn't receiving your messages");

  // ... and unblocking lets her write again
  await bob.page.getByText('Unblock', { exact: true }).click();
  await expect(alice.page.getByText(/isn't receiving your messages at the moment/)).toHaveCount(0);
  await alice.page.getByTestId('chat-draft').fill('Back again');
  await alice.page.getByTestId('chat-send').click();
  await expect(bob.page.getByText('Back again')).toBeVisible();

  // History stays after a reload (it's kept in the browser)
  await alice.page.reload();
  const welcome = alice.page.getByTestId('welcome-box');
  await expect(alice.page.getByText('☰').first().or(welcome)).toBeVisible();
  if (await welcome.isVisible()) await alice.page.getByText('‹').first().click();
  await openMenuEntry(alice.page, 'Chat');
  await alice.page.getByTestId('chat-contact').click();
  await expect(alice.page.getByText('Hi Bob! Want to trade?')).toBeVisible();
  await expect(alice.page.getByText('Sure, which one?')).toBeVisible();

  await alice.context.close();
  await bob.context.close();
  postman.stop();
});

test('without the Klever extension, or without Devikins, the chat explains what is needed', async ({ browser }) => {
  const postman = await startPostman();
  const nobody = await openPlayer(browser, postman, await postman.newWallet(0), { extension: false });
  await expect(nobody.page.getByText(/you need the Klever Wallet browser extension/)).toBeVisible();
  await nobody.context.close();

  const empty = await openPlayer(browser, postman, await postman.newWallet(0));
  await empty.page.getByTestId('chat-sign-in').click();
  await expect(empty.page.getByTestId('chat-error')).toContainText('holds no Devikins');
  await empty.context.close();
  postman.stop();
});
