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
const { openHub, openMenuEntry, goBack, nameNewWallet } = require('./helpers');

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
  const fake = await installFakeServers(context);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  await context.route(`https://${POSTMAN_HOST}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    const headers = {};
    if (request.headers().authorization) headers.authorization = request.headers().authorization;
    let r;
    try {
      r = await fetch(postman.local + url.pathname + url.search, { method: request.method(), headers, body: request.postData() || undefined });
    } catch {
      // (the test's postman has stopped while a page still checks for mail: answer like an unreachable server)
      return route.abort('connectionrefused').catch(() => {});
    }
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: await r.text() });
  });
  const page = await context.newPage();
  await page.addInitScript(() => { window.__HUB_CHAT_MAIL_MS = 700; window.__HUB_CHAT_DEVICES_MS = 1000; });
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
  return { context, page, dialogs, fake };
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
  await expect(alice.page.getByTestId('chat-group-new-too-few')).toContainText('Starting a group takes at least 10 Devikins, the same as voting (your last sign-in counted 2–4).');
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
  await expect(bob.page.getByTestId('chat-group-limit')).toContainText('10 of 10 posts left for today'); // (24 Devikins: band 10–24)
  await bob.page.getByTestId('chat-group-draft').fill('Hi everyone');
  await bob.page.getByTestId('chat-group-draft').press('Enter');
  await expect(bob.page.getByText('Hi everyone')).toBeVisible();
  // One of his 24 posts for the day is used
  await expect(bob.page.getByTestId('chat-group-limit')).toContainText('9 of 10 posts left for today', { timeout: 30_000 });

  // Alice sees Bob's post with his name
  await expect(alice.page.getByText('Hi everyone')).toBeVisible();
  await expect(alice.page.getByText('Bob', { exact: true })).toBeVisible();
  // Laid out like Telegram / WhatsApp (24 Oct 2026): a date line, Bob's initial as his avatar
  await expect(alice.page.getByTestId('chat-day').first()).toHaveText('Today');
  await expect(alice.page.getByText('B', { exact: true })).toBeVisible();
  // Reactions (free): Alice gives Bob's post a 👍, then switches to 🔥; Bob sees it
  await alice.page.getByTestId('chat-react').last().click();
  await alice.page.getByTestId('chat-reaction-picker').getByText('👍').click();
  await expect(alice.page.getByTestId('chat-reaction')).toHaveText('👍 1');
  await alice.page.getByTestId('chat-react').last().click();
  await alice.page.getByTestId('chat-reaction-picker').getByText('🔥').click();
  await expect(alice.page.getByTestId('chat-reaction')).toHaveText('🔥 1');
  await expect(bob.page.getByTestId('chat-reaction')).toHaveText('🔥 1', { timeout: 30_000 });
  // The Hub's own emojis: an Ancestry colour, then a face (25 Oct 2026)
  await alice.page.getByTestId('chat-react').last().click();
  await alice.page.getByTestId('chat-emoji-ancestry').filter({ hasText: 'Ochran' }).click();
  await alice.page.getByLabel('React with Laughing (Ochran)').click();
  await expect(alice.page.getByTestId('chat-reaction')).toHaveAccessibleName('Laughing (Ochran) 1, yours');
  await expect(bob.page.getByTestId('chat-reaction')).toHaveAccessibleName('Laughing (Ochran) 1', { timeout: 30_000 });

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
  await expect(bob.page.getByTestId('chat-group-members')).toContainText('Your chat sign-in counted 2–4 Devikins');
  await bobWallet.setHoldings(12);
  await bob.page.getByTestId('chat-update-holdings').click();
  await expect(bob.page.getByTestId('chat-update-holdings')).toHaveCount(0, { timeout: 30_000 });
  await bob.page.getByTestId('chat-group-member').filter({ hasText: 'Max' }).getByTestId('chat-vote-start').click();
  await bob.page.getByTestId('chat-vote-reason').fill('Posts scam links');
  await bob.page.getByTestId('chat-vote-open').click();
  // Votes and polls share one line (25 Oct 2026)
  await expect(bob.page.getByTestId('chat-group-votes')).toContainText('🗳 Votes & polls · 1 open');
  await bob.page.getByTestId('chat-group-votes-toggle').click();
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('Vote: remove Max?');
  await expect(bob.page.getByTestId('chat-group-vote')).not.toContainText('Reason:'); // one line until opened
  await bob.page.getByTestId('chat-group-vote-toggle').click();
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('Reason: Posts scam links');
  await expect(bob.page.getByTestId('chat-group-vote')).toContainText('You voted yes.');
  // The owner can't be voted out (no button next to Alice)
  await expect(bob.page.getByTestId('chat-group-member').filter({ hasText: 'Alice' }).getByTestId('chat-vote-start')).toHaveCount(0);

  // Max sees it's about him and can't vote
  await expect(max.page.getByTestId('chat-group-votes')).toContainText('1 open', { timeout: 30_000 });
  await max.page.getByTestId('chat-group-votes-toggle').click();
  await expect(max.page.getByTestId('chat-group-vote')).toContainText('Vote: remove Max?');
  await max.page.getByTestId('chat-group-vote-toggle').click();
  await expect(max.page.getByTestId('chat-group-vote')).toContainText('This vote is about you');
  await expect(max.page.getByTestId('chat-vote-yes')).toHaveCount(0);

  // Alice supports it: now Max's posting is paused
  await expect(alice.page.getByTestId('chat-group-votes')).toContainText('your vote?', { timeout: 30_000 });
  await alice.page.getByTestId('chat-group-votes-toggle').click();
  await alice.page.getByTestId('chat-group-vote-toggle').click();
  await alice.page.getByTestId('chat-vote-yes').click();
  await expect(alice.page.getByTestId('chat-group-vote')).toContainText('2 yes / 0 no');
  await expect(max.page.getByTestId('chat-group-paused')).toBeVisible({ timeout: 30_000 });

  // A poll (25 Oct 2026): Bob asks, Alice answers, Bob closes it; it moves to "Past"
  await bob.page.getByTestId('chat-poll-new').click();
  await bob.page.getByTestId('chat-poll-question').fill('Next meetup?');
  await bob.page.getByTestId('chat-poll-answer').nth(0).fill('Saturday');
  await bob.page.getByTestId('chat-poll-answer').nth(1).fill('Sunday');
  await bob.page.getByTestId('chat-poll-start').click();
  await expect(bob.page.getByTestId('chat-group-poll')).toContainText('📊 Next meetup? · 0 votes');
  // Alice sees it as a line in the chat; a tap opens it
  await expect(alice.page.getByTestId('chat-system-line')).toContainText('📊 Bob started a poll: Next meetup?', { timeout: 30_000 });
  await alice.page.getByTestId('chat-system-line').click();
  await alice.page.getByTestId('chat-poll-option').filter({ hasText: 'Sunday' }).click();
  await expect(alice.page.getByTestId('chat-poll-option').filter({ hasText: 'Sunday' })).toContainText('✓ Sunday');
  await expect(bob.page.getByTestId('chat-group-poll')).toContainText('1 vote', { timeout: 30_000 });
  await bob.page.getByTestId('chat-group-poll-toggle').click();
  await expect(bob.page.getByTestId('chat-poll-option').filter({ hasText: 'Sunday' })).toContainText('Alice');
  await bob.page.getByTestId('chat-poll-close').click();
  await expect(bob.page.getByTestId('chat-votes-past-toggle')).toContainText('Past (1)');
  await bob.page.getByTestId('chat-votes-past-toggle').click();
  await expect(bob.page.getByTestId('chat-group-poll')).toContainText(/Next meetup\? · 1 vote · closed/);

  for (const p of [alice, bob, max]) await p.context.close();
  postman.stop();
});

test('linked devices: the same player in a second browser gets the history after a yes on the first', async ({ browser }) => {
  const postman = await startPostman();
  try {
    const aliceWallet = await postman.newWallet(3);
    const alice = await openPlayer(browser, postman, aliceWallet);
    const bob = await openPlayer(browser, postman, await postman.newWallet(3));
    await signInAs(alice.page, 'Alice');
    await signInAs(bob.page, 'Bob');
    await alice.page.getByTestId('chat-search').fill('Bob');
    await alice.page.getByTestId('chat-search-button').click();
    await alice.page.getByTestId('chat-ask').click();
    await bob.page.getByTestId('chat-accept').click({ timeout: 15_000 });
    await alice.page.getByTestId('chat-contact').filter({ hasText: 'Bob' }).click();
    await expect(alice.page.getByTestId('chat-draft')).toBeEnabled({ timeout: 15_000 });
    await alice.page.getByTestId('chat-draft').fill('Before the phone');
    await alice.page.getByTestId('chat-send').click();
    await alice.page.getByLabel('Back').first().click();

    // The same wallet in a second browser: straight in (same account, same nickname), no history yet.
    const second = await openPlayer(browser, postman, aliceWallet);
    await second.page.getByTestId('chat-sign-in').click();
    await expect(second.page.getByText('Chat · Alice')).toBeVisible();
    await expect(second.page.getByTestId('chat-contact')).toHaveCount(0);

    // The first browser offers to copy the history; yes.
    await expect(alice.page.getByTestId('chat-new-device')).toBeVisible({ timeout: 20_000 });
    // (named by its browser and system, from the device's own sealed hello)
    await expect(alice.page.getByTestId('chat-new-device')).toContainText(/Chrome on \w+ signed in with your wallet/);
    await alice.page.getByTestId('chat-copy-history').click();
    await expect(alice.page.getByTestId('chat-new-device')).toHaveCount(0);
    await expect(alice.page.getByTestId('chat-device')).toHaveCount(1);

    // The second browser has the contact and the message, and can write; Bob gets it.
    await expect(second.page.getByTestId('chat-contact').filter({ hasText: 'Bob' })).toBeVisible({ timeout: 20_000 });
    await second.page.getByTestId('chat-contact').filter({ hasText: 'Bob' }).click();
    await expect(second.page.getByText('Before the phone')).toBeVisible();
    await second.page.getByTestId('chat-draft').fill('From my second browser');
    await second.page.getByTestId('chat-send').click();
    await bob.page.getByTestId('chat-contact').filter({ hasText: 'Alice' }).click();
    await expect(bob.page.getByText('From my second browser')).toBeVisible({ timeout: 20_000 });
    // ... and the first browser shows it as Alice's own.
    await alice.page.getByTestId('chat-contact').filter({ hasText: 'Bob' }).click();
    await expect(alice.page.getByText('From my second browser')).toBeVisible({ timeout: 20_000 });
    for (const p of [alice, bob, second]) await p.context.close();
  } finally {
    postman.stop();
  }
});

test('linking by QR code: a second browser without the Klever extension joins with the code shown on the first', async ({ browser }) => {
  const postman = await startPostman();
  try {
    const alice = await openPlayer(browser, postman, await postman.newWallet(3));
    await signInAs(alice.page, 'Alice');
    await alice.page.getByTestId('chat-link-start').click();
    await expect(alice.page.getByTestId('chat-link-qr')).toBeVisible();
    const shown = (await alice.page.getByTestId('chat-link-shown').textContent()).trim();
    expect(shown).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);

    // No wallet in the second browser: it links with the code instead.
    const second = await openPlayer(browser, postman, null, { extension: false });
    await second.page.getByTestId('chat-link-code').fill(shown.toLowerCase());
    await second.page.getByTestId('chat-link-finish').click();
    await expect(second.page.getByText('Chat · Alice')).toBeVisible({ timeout: 15_000 });

    // The first browser lists it among Alice's devices (no history to offer yet: no contacts, no groups).
    await expect(alice.page.getByTestId('chat-device')).toHaveCount(1, { timeout: 20_000 });
    await expect(alice.page.getByTestId('chat-device')).toContainText('Chrome on');
    // A used code doesn't work twice.
    const third = await openPlayer(browser, postman, null, { extension: false });
    await third.page.getByTestId('chat-link-code').fill(shown);
    await third.page.getByTestId('chat-link-finish').click();
    await expect(third.page.getByTestId('chat-error')).toContainText(/expired or was already used/);
    for (const p of [alice, second, third]) await p.context.close();
  } finally {
    postman.stop();
  }
});

test('Collectors Albums: a player publishes an album with notes; a visitor without signing in sees it checked', async ({ browser }) => {
  test.setTimeout(180_000);
  const postman = await startPostman();
  try {
    const wallet = await postman.newWallet(3);
    const alice = await openPlayer(browser, postman, wallet);
    await signInAs(alice.page, 'Alice');
    await alice.page.getByTestId('chat-dock-minimise').click();
    // Alice's wallet holds Testy (Devikin 101) and the Fine Test Hammer (weapon 201); she loads them into the Hub.
    for (const id of ['devikin:101', 'weapon:201']) alice.fake.chain.holders.set(id, wallet.address);
    await openMenuEntry(alice.page, 'Wallets');
    await alice.page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(wallet.address);
    await alice.page.getByText('Add', { exact: true }).click();
    await nameNewWallet(alice.page);
    await goBack(alice.page);
    await openMenuEntry(alice.page, 'Fetch/Update');
    await expect.poll(() => new Set(alice.fake.requests.filter((u) => /devikins\.com\/.+\.png$/.test(u))).size, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await expect(alice.page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });

    // My albums > New album: the privacy note (accepted), the wallet signs, two NFTs with a note.
    await openMenuEntry(alice.page, 'Collectors Albums');
    await expect(alice.page.getByText('No albums yet', { exact: false })).toBeVisible();
    await alice.page.getByTestId('albums-mine').click();
    await alice.page.getByTestId('album-new').click();
    await alice.page.getByTestId('album-sign').click();
    await expect.poll(() => alice.dialogs.some((d) => /^Albums are public/.test(d) && /Kleverscan/.test(d))).toBe(true);
    await alice.page.getByTestId('album-title-input').fill('My first finds');
    // The picker shows one kind at a time: Devikins first, then Weapons.
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(1);
    await alice.page.getByTestId('album-pick').filter({ hasText: '#101' }).click();
    await alice.page.getByTestId('album-pick-kind-weapon').click();
    await alice.page.getByTestId('album-pick').filter({ hasText: '#201' }).click();
    await alice.page.getByTestId('album-picked').filter({ hasText: '#101' }).getByPlaceholder(/Note/).fill('May event 2025 Bonded Yoda');
    await alice.page.getByTestId('album-picked').filter({ hasText: '#101' }).getByTestId('album-section-input').fill('Events');
    // (a section used once is offered on the other NFTs too)
    await expect(alice.page.getByTestId('album-picked').filter({ hasText: '#201' }).getByTestId('album-section-chip')).toHaveText('Events');
    await alice.page.getByTestId('album-publish').click();
    await expect(alice.page.getByTestId('album-published')).toBeVisible();

    // A visitor: no extension, no chat. The album is anonymous; both NFTs are checked as still in the wallet.
    const visitor = await openPlayer(browser, postman, null, { extension: false, openChat: false });
    for (const id of ['devikin:101', 'weapon:201']) visitor.fake.chain.holders.set(id, wallet.address);
    await openMenuEntry(visitor.page, 'Collectors Albums');
    const row = visitor.page.getByTestId('album-row').filter({ hasText: 'My first finds' });
    await expect(row).toContainText('Anonymous collector');
    await expect(row).toContainText('2 NFTs');
    await row.click();
    await expect(visitor.page.getByTestId('album-title')).toHaveText('My first finds');
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(2);
    await expect(visitor.page.getByText('May event 2025 Bonded Yoda')).toBeVisible();
    await expect(visitor.page.getByTestId('album-item').filter({ hasText: "✓ in the owner's wallet" })).toHaveCount(2, { timeout: 20_000 });
    // Section heading, with Testy under it; the hammer (no section) first.
    await expect(visitor.page.getByTestId('album-section')).toHaveText('Events');
    await expect(visitor.page.getByTestId('album-item').filter({ hasText: 'Testy the Brave' })).toContainText('Rare');
    // No wallet, no numbers, no Kleverscan links for visitors (28 Oct 2026).
    await expect(visitor.page.getByText(wallet.address.slice(0, 10), { exact: false })).toHaveCount(0);
    await expect(visitor.page.getByText('#101', { exact: false })).toHaveCount(0);
    await expect(visitor.page.getByText('Kleverscan', { exact: true })).toHaveCount(0);
    await expect(visitor.page.getByText('Alice')).toHaveCount(0);
    // Filters: only the weapons.
    await visitor.page.getByTestId('album-filter-weapon').click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(1);
    await expect(visitor.page.getByTestId('album-item')).toContainText('Fine Test Hammer');
    await expect(visitor.page.getByTestId('album-shown-count')).toHaveText('Showing 1 of 2');
    await visitor.page.getByTestId('album-filter-kind-all').click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(2);
    // The hammer's picture came straight from Moonlabs' picture server (folder 0), without its data first.
    expect(visitor.fake.requests.some((u) => u === 'https://imgweapon.devikins.com/0/201.png')).toBe(true);

    // Testy is sold: the next visit shows it faded, "no longer in the wallet".
    visitor.fake.chain.holders.set('devikin:101', 'klv1someoneelse');
    await goBack(visitor.page);
    await row.click();
    await expect(visitor.page.getByTestId('album-gone')).toContainText("1 of these NFTs is no longer in the owner's wallet", { timeout: 20_000 });

    // Alice deletes it: gone for everyone.
    await goBack(alice.page);
    await alice.page.getByTestId('my-album-delete').click();
    await expect(alice.page.getByTestId('my-album')).toHaveCount(0);
    await goBack(visitor.page);
    await expect(visitor.page.getByText('No albums yet', { exact: false })).toBeVisible();
    for (const p of [alice, visitor]) await p.context.close();
  } finally {
    postman.stop();
  }
});

test('Collectors Albums with a big wallet: picker by kind with "show more", sections, filters, pictures straight from Moonlabs', async ({ browser }) => {
  test.setTimeout(300_000);
  const postman = await startPostman();
  try {
    const wallet = await postman.newWallet(3);
    const alice = await openPlayer(browser, postman, wallet);
    await signInAs(alice.page, 'Alice');
    await alice.page.getByTestId('chat-dock-minimise').click();
    // A big wallet: 150 Devikins, 40 Weapons, 20 Equipment, every rarity; Devikin pictures in folders 0-11 like Moonlabs'.
    const RARITIES = ['Common', 'Uncommon', 'Rare', 'Mythic', 'Eldritch'];
    const ANCESTRIES = ['Faery', 'Demon', 'Elf', 'Undead'];
    const visitorNfts = [];
    const add = (kind, nonce, i) => {
      const attributes = kind === 'devikin'
        ? { Rarity: RARITIES[i % 5], Ancestry: ANCESTRIES[i % 4], 'Life Stage': 'Adult', 'Overall Affinity': 50 + (i % 40) }
        : { Rarity: RARITIES[i % 5], Type: kind === 'weapon' ? 'Sword' : 'Boots', Quality: 'Fine' };
      const nft = { name: `#${nonce}`, attributes, ...(kind === 'devikin' ? { image: `https://img.devikins.com/${i % 12}/${nonce}.png` } : {}) };
      visitorNfts.push([`${kind}:${nonce}`, nft]);
    };
    for (let i = 0; i < 150; i += 1) add('devikin', 5000 + i, i);
    for (let i = 0; i < 40; i += 1) add('weapon', 6000 + i, i);
    for (let i = 0; i < 20; i += 1) add('equipment', 7000 + i, i);
    for (const [id, nft] of visitorNfts) {
      alice.fake.extraNfts.set(id, nft);
      alice.fake.chain.holders.set(id, wallet.address);
    }
    await openMenuEntry(alice.page, 'Wallets');
    await alice.page.getByPlaceholder('Paste a Klever wallet address (klv1...)').fill(wallet.address);
    await alice.page.getByText('Add', { exact: true }).click();
    await nameNewWallet(alice.page);
    await goBack(alice.page);
    await openMenuEntry(alice.page, 'Fetch/Update');
    await expect.poll(() => new Set(alice.fake.requests.filter((u) => /devikins\.com\/.+\.png$/.test(u))).size, { timeout: 180_000 }).toBeGreaterThanOrEqual(210);
    await expect(alice.page.getByText(/^\d+%$/)).toHaveCount(0, { timeout: 60_000 });

    await openMenuEntry(alice.page, 'Collectors Albums');
    await alice.page.getByTestId('albums-mine').click();
    await alice.page.getByTestId('album-new').click();
    await alice.page.getByTestId('album-sign').click();
    await alice.page.getByTestId('album-title-input').fill('The big one');

    // The picker: one kind at a time, with counts, 60 at a time.
    await expect(alice.page.getByTestId('album-pick-kind-devikin')).toHaveText('Devikins (150)');
    await expect(alice.page.getByTestId('album-pick-kind-weapon')).toHaveText('Weapons (40)');
    await expect(alice.page.getByTestId('album-pick-kind-equipment')).toHaveText('Equipment (20)');
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(60);
    await expect(alice.page.getByTestId('album-pick-more')).toHaveText('Show more (90 left)');
    await alice.page.getByTestId('album-pick-more').click();
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(120);
    await alice.page.getByTestId('album-pick-more').click();
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(150);
    await expect(alice.page.getByTestId('album-pick-more')).toHaveCount(0);
    // Search by rarity: every fifth one is Eldritch.
    await alice.page.getByTestId('album-search').fill('eldritch');
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(30);
    await alice.page.getByTestId('album-search').fill('');

    // 10 Devikins, 5 Weapons, 3 Equipment (the list moves up as they're picked).
    for (let i = 0; i < 10; i += 1) await alice.page.getByTestId('album-pick').first().click();
    await alice.page.getByTestId('album-pick-kind-weapon').click();
    await expect(alice.page.getByTestId('album-pick')).toHaveCount(40);
    for (let i = 0; i < 5; i += 1) await alice.page.getByTestId('album-pick').first().click();
    await alice.page.getByTestId('album-pick-kind-equipment').click();
    for (let i = 0; i < 3; i += 1) await alice.page.getByTestId('album-pick').first().click();
    await expect(alice.page.getByTestId('album-picked')).toHaveCount(18);
    // Two sections: the first two Devikins in "Bonded", the first weapon in "Event swords" (the chip offers a used section).
    const picked = alice.page.getByTestId('album-picked');
    await picked.nth(0).getByTestId('album-section-input').fill('Bonded');
    await picked.nth(1).getByTestId('album-section-chip').filter({ hasText: 'Bonded' }).click();
    await picked.nth(10).getByTestId('album-section-input').fill('Event swords');
    await alice.page.getByTestId('album-publish').click();
    await expect(alice.page.getByTestId('album-published')).toBeVisible();

    // A visitor sees it all, grouped, and can filter and sort.
    const visitor = await openPlayer(browser, postman, null, { extension: false, openChat: false });
    for (const [id, nft] of visitorNfts) {
      visitor.fake.extraNfts.set(id, nft);
      visitor.fake.chain.holders.set(id, wallet.address);
    }
    await openMenuEntry(visitor.page, 'Collectors Albums');
    await visitor.page.getByTestId('album-row').filter({ hasText: 'The big one' }).click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(18);
    await expect(visitor.page.getByTestId('album-section')).toHaveText(['Bonded', 'Event swords']);
    await expect(visitor.page.getByTestId('album-item').filter({ hasText: "✓ in the owner's wallet" })).toHaveCount(18, { timeout: 60_000 });
    // Pictures came straight from Moonlabs' picture server, also from a Devikin's own folder (5003 is in folder 3).
    await expect.poll(() => visitor.fake.requests.includes('https://img.devikins.com/3/5003.png')).toBe(true);
    await visitor.page.getByTestId('album-filter-devikin').click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(10);
    await expect(visitor.page.getByTestId('album-shown-count')).toHaveText('Showing 10 of 18');
    await visitor.page.getByTestId('album-filter-rarity-Eldritch').click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(2);
    await visitor.page.getByTestId('album-filter-kind-all').click();
    await expect(visitor.page.getByTestId('album-item')).toHaveCount(18);
    // Rarest first: the Eldritch ones lead, and the sections step aside.
    await visitor.page.getByTestId('album-sort-rarity').click();
    await expect(visitor.page.getByTestId('album-item').first()).toContainText('Eldritch');
    await expect(visitor.page.getByTestId('album-section')).toHaveCount(0);
    for (const p of [alice, visitor]) await p.context.close();
  } finally {
    postman.stop();
  }
});
