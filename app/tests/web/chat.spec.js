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
const fs = require('node:fs');
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
      return {
        address,
        sign: async (text) => (await post('/__test/sign', { address, text })).signature,
        setHoldings: (nfts) => post('/__test/holdings', { address, nfts }),
      };
    },
  };
}

/**
 * A group of someone else in the list, ready to join. Groups only their
 * owner is in yet are folded away under "New groups (N)".
 */
async function findGroup(page, name) {
  const row = page.getByTestId('chat-group-other').filter({ hasText: name });
  await expect(async () => {
    const toggle = page.getByTestId('chat-groups-new-toggle');
    if ((await row.count()) === 0 && (await toggle.isVisible()) && !(await page.getByText(/Only their owner is in them yet/).isVisible())) await toggle.click();
    await expect(row).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  return row;
}

/** One player: a browser context with the fake servers, the postman and a pretend Klever extension. */
async function openPlayer(browser, postman, wallet, { extension = true, openChat = true, kleverApp = false } = {}) {
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
        // (kleverApp: like the Klever app's own browser - base64 of the hex signature)
        signMessage: async (text) => (window.__kleverApp ? btoa(await window.__testSign(text)) : window.__testSign(text)),
      };
      window.kleverHub = { initialize: async () => {} };
    }, wallet.address);
  }
  if (kleverApp) await page.addInitScript(() => { window.__kleverApp = true; });
  const dialogs = await openHub(page);
  if (openChat) await openMenuEntry(page, 'Chat');
  return { context, page, dialogs };
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

  // The chat is a window over the Hub (23 Oct 2026): Bob minimises it and
  // looks at his withdrawals; it keeps checking for mail meanwhile
  await bob.page.getByTestId('chat-dock-minimise').click();
  await expect(bob.page.getByTestId('chat-dock')).toBeHidden();
  await openMenuEntry(bob.page, 'Withdrawals');
  await expect(bob.page.getByText('1. Your wallets', { exact: true })).toBeVisible();

  // Alice's side turns into a contact; she writes
  await expect(alice.page.getByText('waiting for answer')).toHaveCount(0);
  await alice.page.getByTestId('chat-contact').click();
  await alice.page.getByTestId('chat-draft').fill('Hi Bob! Want to trade?');
  await alice.page.getByTestId('chat-send').click();
  await expect(alice.page.getByText('Hi Bob! Want to trade?')).toBeVisible();
  await expect(alice.page.getByTestId('chat-draft')).toHaveValue('');

  // Bob's bubble counts the new message; he opens the window over Withdrawals,
  // makes it fill the screen and back
  await expect(bob.page.getByTestId('chat-bubble-count')).toHaveText('1', { timeout: 30_000 });
  await bob.page.getByTestId('chat-bubble').click();
  await expect(bob.page.getByTestId('chat-dock')).toBeVisible();
  await expect(bob.page.getByText('1. Your wallets', { exact: true })).toBeVisible(); // (the Hub stays where it was)
  await bob.page.getByTestId('chat-dock-size').click();
  await bob.page.getByTestId('chat-dock-size').click();

  // Bob sees an unread message, opens it and answers (Enter sends)
  await expect(bob.page.getByTestId('chat-contact')).toContainText('1');
  await bob.page.getByTestId('chat-contact').click();
  await expect(bob.page.getByText('Hi Bob! Want to trade?')).toBeVisible();
  await bob.page.getByTestId('chat-draft').fill('Sure, which one?');
  await bob.page.getByTestId('chat-draft').press('Enter');
  await expect(alice.page.getByText('Sure, which one?')).toBeVisible();

  // Bob minimises the chat with Alice's conversation still open: her next
  // message stays counted as new until he opens the window again
  await bob.page.getByTestId('chat-dock-minimise').click();
  await alice.page.getByTestId('chat-draft').fill('Still there?');
  await alice.page.getByTestId('chat-send').click();
  await expect(bob.page.getByTestId('chat-bubble-count')).toHaveText('1', { timeout: 30_000 });
  await bob.page.waitForTimeout(3000); // (a few mail checks later)
  await expect(bob.page.getByTestId('chat-bubble-count')).toHaveText('1');
  await bob.page.getByTestId('chat-bubble').click();
  await expect(bob.page.getByText('Still there?')).toBeVisible();

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

  // On a phone-sized screen there's no chat tab (it covered buttons); the ☰
  // button and the menu's "Chat" show what's new instead
  await alice.page.setViewportSize({ width: 390, height: 844 });
  await alice.page.getByTestId('chat-dock-minimise').click();
  await expect(alice.page.getByTestId('chat-bubble')).toHaveCount(0);
  await bob.page.getByTestId('chat-draft').fill('On your phone?');
  await bob.page.getByTestId('chat-send').click();
  await expect(alice.page.getByTestId('menu-chat-count')).toHaveText('1', { timeout: 30_000 });
  await openMenuEntry(alice.page, 'Chat');
  await expect(alice.page.getByText('On your phone?')).toBeVisible();
  await expect(alice.page.getByTestId('menu-chat-count')).toHaveCount(0);

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

test('the chat goes into "Export all sets" with a password and comes back in a new browser', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const postman = await startPostman();
  const alice = await openPlayer(browser, postman, await postman.newWallet(3));
  const bob = await openPlayer(browser, postman, await postman.newWallet(5));
  await signInAs(alice.page, 'Alice');
  await signInAs(bob.page, 'Bob');
  await alice.page.getByTestId('chat-search').fill('Bob');
  await alice.page.getByTestId('chat-search-button').click();
  await alice.page.getByTestId('chat-ask').click();
  await bob.page.getByTestId('chat-accept').click();
  await expect(alice.page.getByText('waiting for answer')).toHaveCount(0);
  await alice.page.getByTestId('chat-contact').click();
  await alice.page.getByTestId('chat-draft').fill('Before the backup');
  await alice.page.getByTestId('chat-send').click();
  await expect(alice.page.getByText('Before the backup')).toBeVisible();

  // Export all sets: the chat is offered, with a password (typed twice)
  await alice.page.getByText('‹').first().click();
  await alice.page.getByText('‹').first().click();
  await openMenuEntry(alice.page, 'Wallets');
  await alice.page.getByText('Export all sets').click();
  const box = alice.page.getByTestId('chat-backup-box');
  await expect(box).toContainText('Include your chat?');
  await alice.page.getByTestId('chat-backup-password').fill('my chat secret');
  await alice.page.getByTestId('chat-backup-repeat').fill('my chat secrex');
  await alice.page.getByTestId('chat-backup-ok').click();
  await expect(alice.page.getByTestId('chat-backup-problem')).toContainText("aren't the same");
  await alice.page.getByTestId('chat-backup-repeat').fill('my chat secret');
  const [download] = await Promise.all([alice.page.waitForEvent('download'), alice.page.getByTestId('chat-backup-ok').click()]);
  const zipPath = testInfo.outputPath('backup-with-chat.zip');
  await download.saveAs(zipPath);
  const zipText = fs.readFileSync(zipPath).toString('latin1');
  expect(zipText).toContain('chat-backup.json');
  expect(zipText).not.toContain('Before the backup'); // locked, not readable

  // Alice moves to a new browser and closes the old one. (Two browsers with
  // the same chat would share its mail: since 23 Oct 2026 the chat keeps
  // checking in the background, so the old one would pick up Bob's message.)
  await alice.context.close();

  // A new browser: import asks for the chat's password (a wrong one first)
  const moved = await openPlayer(browser, postman, null, { extension: false, openChat: false });
  await openMenuEntry(moved.page, 'Wallets');
  const [chooser] = await Promise.all([moved.page.waitForEvent('filechooser'), moved.page.getByText('Import Set(s)').click()]);
  await chooser.setFiles(zipPath);
  await expect(moved.page.getByTestId('chat-backup-box')).toContainText('Bring your chat back?');
  await moved.page.getByTestId('chat-backup-password').fill('not my password');
  await moved.page.getByTestId('chat-backup-ok').click();
  await expect(moved.page.getByTestId('chat-backup-problem')).toContainText('Wrong password');
  await moved.page.getByTestId('chat-backup-password').fill('my chat secret');
  await moved.page.getByTestId('chat-backup-ok').click();
  await expect.poll(() => moved.dialogs.join('\n')).toMatch(/Chat: back as Alice/);

  // The chat is there, and the conversation goes on
  await moved.page.getByText('‹').first().click();
  await openMenuEntry(moved.page, 'Chat');
  await expect(moved.page.getByText('Chat · Alice')).toBeVisible();
  await moved.page.getByTestId('chat-contact').click();
  await expect(moved.page.getByText('Before the backup')).toBeVisible();
  await bob.page.getByTestId('chat-contact').click();
  await bob.page.getByTestId('chat-draft').fill('Welcome to your new browser');
  await bob.page.getByTestId('chat-send').click();
  await expect(moved.page.getByText('Welcome to your new browser')).toBeVisible();

  await bob.context.close();
  await moved.context.close();
  postman.stop();
});

test('groups: create with pinned rules, another player joins (let in by the owner\'s Hub), posts with the holding limit shown', async ({ browser }) => {
  test.setTimeout(180_000);
  const postman = await startPostman();
  // (Alice signs like the Klever app's own browser: base64 of the hex signature)
  const aliceWallet = await postman.newWallet(3);
  const alice = await openPlayer(browser, postman, aliceWallet, { kleverApp: true });
  const bob = await openPlayer(browser, postman, await postman.newWallet(24));
  await signInAs(alice.page, 'Alice');
  await signInAs(bob.page, 'Bob');

  // Starting a group takes as many Devikins as voting (10 here; 24 Oct 2026)
  await expect(alice.page.getByTestId('chat-group-new-too-few')).toContainText('Starting a group takes at least 10 Devikins, the same as voting (your last sign-in counted 3).');
  await expect(alice.page.getByTestId('chat-group-new')).toHaveCount(0);
  await aliceWallet.setHoldings(12);
  await alice.page.getByTestId('chat-group-new-update').click();

  // Alice starts a group, pins rules and posts
  await alice.page.getByTestId('chat-group-new').click();
  await alice.page.getByTestId('chat-group-name').fill('Fire Breeders');
  await alice.page.getByTestId('chat-group-description').fill('Trading Fire Devikins');
  await alice.page.getByTestId('chat-group-create').click();
  await expect(alice.page.getByText('you started it')).toBeVisible();
  // Pinned messages, a vote and the members each take one line that opens (Raphael, 23 Oct 2026)
  await alice.page.getByTestId('chat-group-pinned-toggle').click();
  await alice.page.getByTestId('chat-group-pin-add').click();
  await alice.page.getByTestId('chat-group-pin-draft').fill('Rules: be nice, no spam.');
  await alice.page.getByTestId('chat-group-pin-save').click();
  await expect(alice.page.getByTestId('chat-group-pinned')).toContainText('Rules: be nice, no spam.');
  // A second pinned message, then removed again; several can be pinned any time
  await alice.page.getByTestId('chat-group-pin-add').click();
  await alice.page.getByTestId('chat-group-pin-draft').fill('Trading day: Sundays');
  await alice.page.getByTestId('chat-group-pin-save').click();
  await expect(alice.page.getByTestId('chat-group-pin')).toHaveCount(2);
  await alice.page.getByTestId('chat-group-pin-remove').nth(1).click();
  await expect(alice.page.getByTestId('chat-group-pin')).toHaveCount(1);
  await alice.page.getByTestId('chat-group-draft').fill('Welcome, Fire fans!');
  await alice.page.getByTestId('chat-group-post').click();
  await expect(alice.page.getByText('Welcome, Fire fans!')).toBeVisible();
  // The owner may always answer (every 10 seconds)
  await expect(alice.page.getByTestId('chat-group-limit')).toContainText("As the group's owner you can always answer (one post every 10 seconds).");

  // Bob finds it under "New groups" (only Alice is in it) and asks to join; Alice's open Hub lets him in
  await expect(bob.page.getByTestId('chat-groups-new-toggle')).toContainText('New groups (1)', { timeout: 30_000 });
  await bob.page.getByTestId('chat-groups-new-toggle').click();
  await expect(bob.page.getByTestId('chat-group-other')).toContainText('Fire Breeders');
  await expect(bob.page.getByTestId('chat-group-other')).toContainText('Trading Fire Devikins');
  await bob.page.getByTestId('chat-group-join').click();
  await expect(bob.page.getByTestId('chat-group-waiting')).toBeVisible();
  await expect(bob.page.getByTestId('chat-group')).toContainText('Fire Breeders');
  await bob.page.getByTestId('chat-group').click();
  await expect(bob.page.getByTestId('chat-group-pinned')).toContainText('Rules: be nice, no spam.');
  await expect(bob.page.getByText('No posts yet since you joined.')).toBeVisible();
  await expect(bob.page.getByText('Welcome, Fire fans!')).toHaveCount(0);
  await expect(bob.page.getByTestId('chat-group-limit')).toContainText('24 of 24 posts left for today');
  await bob.page.getByTestId('chat-group-draft').fill('Hi everyone');
  await bob.page.getByTestId('chat-group-draft').press('Enter');
  await expect(bob.page.getByText('Hi everyone')).toBeVisible();
  // One of his 24 posts for the day is used
  await expect(bob.page.getByTestId('chat-group-limit')).toContainText('23 of 24 posts left for today', { timeout: 30_000 });

  // Alice sees Bob's post with his name
  await expect(alice.page.getByText('Hi everyone')).toBeVisible();
  await expect(alice.page.getByText('Bob', { exact: true })).toBeVisible();
  // Laid out like Telegram / WhatsApp (24 Oct 2026): a date line, Bob's initial as his avatar
  await expect(alice.page.getByTestId('chat-day').first()).toHaveText('Today');
  await expect(alice.page.getByText('B', { exact: true })).toBeVisible();

  await alice.context.close();
  await bob.context.close();
  postman.stop();
});

test('removal votes: a member starts a vote with a reason, another supports it, the accused is paused and told', async ({ browser }) => {
  test.setTimeout(240_000);
  const postman = await startPostman();
  const alice = await openPlayer(browser, postman, await postman.newWallet(12));
  // Bob signs in holding only 2; he gets more later (see "Update my holdings").
  const bobWallet = await postman.newWallet(2);
  const bob = await openPlayer(browser, postman, bobWallet);
  const max = await openPlayer(browser, postman, await postman.newWallet(12));
  await signInAs(alice.page, 'Alice');
  await signInAs(bob.page, 'Bob');
  await signInAs(max.page, 'Max');
  await alice.page.getByTestId('chat-group-new').click();
  await alice.page.getByTestId('chat-group-name').fill('Vote Club');
  await alice.page.getByTestId('chat-group-create').click();
  await expect(alice.page.getByText('you started it')).toBeVisible();
  for (const p of [bob, max]) {
    await (await findGroup(p.page, 'Vote Club')).getByTestId('chat-group-join').click();
    await expect(p.page.getByTestId('chat-group')).toContainText('Vote Club', { timeout: 30_000 });
    await p.page.getByTestId('chat-group').click();
  }

  // Bob starts a vote about Max (his extension signs a short text)
  await bob.page.getByTestId('chat-group-members-toggle').click();
  await expect(bob.page.getByTestId('chat-group-member')).toHaveCount(3);
  // His sign-in counted 2: no vote link yet. He now holds 12 and updates.
  await expect(bob.page.getByTestId('chat-vote-start')).toHaveCount(0);
  await expect(bob.page.getByTestId('chat-group-members')).toContainText('Your chat sign-in counted 2 Devikins');
  await bobWallet.setHoldings(12);
  await bob.page.getByTestId('chat-update-holdings').click();
  await expect(bob.page.getByTestId('chat-update-holdings')).toHaveCount(0, { timeout: 30_000 });
  await bob.page.getByTestId('chat-group-member').filter({ hasText: 'Max' }).getByTestId('chat-vote-start').click();
  await bob.page.getByTestId('chat-vote-reason').fill('Posts scam links');
  await bob.page.getByTestId('chat-vote-open').click();
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('Vote: remove Max?');
  await expect(bob.page.getByTestId('chat-group-vote')).not.toContainText('Reason:'); // one line until opened
  await bob.page.getByTestId('chat-group-vote-toggle').click();
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('Reason: Posts scam links');
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('You voted yes.');
  // The owner can't be voted out (no button next to Alice)
  await expect(bob.page.getByTestId('chat-group-member').filter({ hasText: 'Alice' }).getByTestId('chat-vote-start')).toHaveCount(0);

  // Max sees it's about him and can't vote
  await expect(max.page.getByTestId('chat-group-vote')).toContainText('Vote: remove Max?', { timeout: 30_000 });
  await max.page.getByTestId('chat-group-vote-toggle').click();
  await expect(max.page.getByTestId('chat-group-vote')).toContainText('This vote is about you');
  await expect(max.page.getByTestId('chat-vote-yes')).toHaveCount(0);

  // Alice supports it: now Max's posting is paused
  await expect(alice.page.getByTestId('chat-group-vote')).toContainText('your vote?', { timeout: 30_000 });
  await alice.page.getByTestId('chat-group-vote-toggle').click();
  await alice.page.getByTestId('chat-vote-yes').click();
  await expect(alice.page.getByTestId('chat-group-vote')).toContainText('2 yes / 0 no');
  await expect(max.page.getByTestId('chat-group-paused')).toBeVisible({ timeout: 30_000 });

  for (const p of [alice, bob, max]) await p.context.close();
  postman.stop();
});
