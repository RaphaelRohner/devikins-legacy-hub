// The blind postman (chat/postman), run on this computer: the same code as
// on Cloudflare, with a stand-in database (Node's built-in SQLite), a
// pretend clock and a pretend Klever API. Wallet signatures are real
// (made with Klever's own library), so the signature check is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, signMessageSync, prepareKlvMessage } from '@klever/connect-crypto';
import { bech32Encode } from '@klever/connect-encoding';
import {
  createIdentity, sealDirect, openDirect, checkBadge, createGroup, sealGroupPost, openGroupPost, acceptPosts,
  DAY, MINUTE, HOUR,
} from '../src/index.js';
import { MAX_ENVELOPE_CHARS as DIRECT_MAX } from '../src/direct.js';
import { MAX_GROUP_ENVELOPE_CHARS } from '../src/group.js';
import { KEEP_FOR as FAKE_KEEP_FOR } from '../src/fakePostman.js';
import {
  createPostOffice, KEEP_FOR, MAX_ENVELOPE_CHARS, MAX_GROUP_ENVELOPE_CHARS as POSTMAN_GROUP_MAX, MAX_DEVICES, MAX_WAITING_PER_DEVICE,
  DAILY_DROPS_PER_CODE, DAILY_ACTIONS_PER_PLAYER, MAX_BODY_CHARS, nicknameKey,
} from '../postman/src/postOffice.js';
import { makeAuthHeader } from '../postman/src/auth.js';
import { devikinsHeld, signatureBytes, walletPublicKey } from '../postman/src/kleverProof.js';

const BASE = 'https://devi-postman-test.example.workers.dev';

/** Node's SQLite, dressed like Cloudflare's ctx.storage.sql. */
function standInSql(db = new DatabaseSync(':memory:')) {
  return {
    db,
    exec(query, ...params) {
      const rows = db.prepare(query).all(...params);
      return { toArray: () => rows };
    },
  };
}

function newWallet(nfts) {
  const { privateKey, publicKey } = generateKeyPairSync();
  return { address: bech32Encode(publicKey.bytes, 'klv'), secret: privateKey.bytes, nfts };
}
const signAs = (wallet, text) => Buffer.from(signMessageSync(prepareKlvMessage(text), wallet.secret)).toString('hex');

function setUp({ sql = standInSql(), kleverDown = false } = {}) {
  const clock = { t: Date.UTC(2026, 9, 21, 12, 0, 0) };
  const holdings = new Map();
  const fetchKlever = async (url) => {
    if (kleverDown) return new Response('', { status: 503 });
    const address = url.split('/address/')[1];
    if (!holdings.has(address)) return Response.json({ data: null, error: 'cannot find account in database', code: 'not_found' }, { status: 404 });
    return Response.json({ data: { account: { address, assets: { 'DVKNFT-1SW5': { balance: holdings.get(address) } } } }, code: 'successful' });
  };
  const office = createPostOffice({ sql, now: () => clock.t, fetchKlever });
  const call = async (identity, method, path, body, { authNow, url: signedUrl } = {}) => {
    const url = BASE + path;
    const bodyText = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const authorization = identity
      ? makeAuthHeader(identity, { url: signedUrl ?? url, method, bodyText, now: authNow ?? clock.t })
      : null;
    return office.handle({ method, url, bodyText, authorization });
  };
  const signIn = async (device, wallet) => {
    holdings.set(wallet.address, wallet.nfts);
    const start = await call(device, 'POST', '/signin/start');
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return call(device, 'POST', '/signin/finish', { code: start.body.code, wallet: wallet.address, signature: signAs(wallet, start.body.text) });
  };
  return { office, call, signIn, clock, holdings, sql };
}

/** Two signed-in players with nicknames. */
async function twoPlayers() {
  const env = setUp();
  const a = { device: createIdentity(), wallet: newWallet(3) };
  const b = { device: createIdentity(), wallet: newWallet(12) };
  for (const [p, name] of [[a, 'Alice'], [b, 'Bob']]) {
    const r = await env.signIn(p.device, p.wallet);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    p.badge = r.body.badge;
    p.account = r.body.account;
    assert.equal((await env.call(p.device, 'POST', '/nickname', { nickname: name })).status, 200);
  }
  return { ...env, a, b };
}

const randomCode = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

test('the postman uses the same limits as the chat core', () => {
  assert.equal(MAX_ENVELOPE_CHARS, DIRECT_MAX);
  assert.ok(POSTMAN_GROUP_MAX <= MAX_GROUP_ENVELOPE_CHARS);
  assert.equal(KEEP_FOR, FAKE_KEEP_FOR);
  assert.equal(KEEP_FOR, 30 * DAY);
});

test('sign-in: a wallet holding Devikins gets a badge for the chat key (no wallet in it)', async () => {
  const { office, call, signIn } = setUp();
  const device = createIdentity();
  const wallet = newWallet(7);
  const hello = await call(null, 'GET', '/hello');
  assert.equal(hello.body.postman, office.postmanPublicKey);

  const start = await call(device, 'POST', '/signin/start');
  assert.match(start.body.text, /This is NOT a transaction/);
  assert.ok(start.body.text.includes(device.publicKey));
  assert.ok(start.body.text.includes(start.body.code));
  assert.ok(start.body.text.includes('Postman: devi-postman-test.example.workers.dev'));

  const r = await signIn(device, wallet);
  assert.equal(r.status, 200);
  assert.equal(r.body.nfts, 7);
  const badge = checkBadge(JSON.parse(JSON.stringify(r.body.badge)), { postmanPublicKey: office.postmanPublicKey, holder: device.publicKey, at: Date.UTC(2026, 9, 22) });
  assert.deepEqual([badge.ok, badge.nfts, badge.account], [true, 7, r.body.account]);
  assert.ok(!JSON.stringify(r.body.badge).includes(wallet.address));
  assert.equal(r.body.verifiedUntil, Date.UTC(2026, 9, 28, 12, 0, 0));
});

test('sign-in is refused: wrong signature, reused / expired / someone else\'s code, no Devikins, Klever down', async () => {
  const { call, holdings, clock } = setUp();
  const device = createIdentity();
  const other = createIdentity();
  const wallet = newWallet(2);
  holdings.set(wallet.address, 2);

  // Signed by another wallet
  let s = await call(device, 'POST', '/signin/start');
  let r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(newWallet(1), s.body.text) });
  assert.equal(r.status, 403);
  // ... and that code is used up now, even with the right signature
  r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(wallet, s.body.text) });
  assert.equal(r.status, 400);

  // A different text signed (e.g. a changed expiry)
  s = await call(device, 'POST', '/signin/start');
  r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(wallet, s.body.text.replace('chat key', 'chat-key')) });
  assert.equal(r.status, 403);

  // Another device can't use my code
  s = await call(device, 'POST', '/signin/start');
  r = await call(other, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(wallet, s.body.text) });
  assert.equal(r.status, 400);

  // Expired after 5 minutes
  s = await call(device, 'POST', '/signin/start');
  clock.t += 5 * MINUTE + 1000;
  r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(wallet, s.body.text) });
  assert.equal(r.status, 400);

  // No Devikins (and a wallet Klever has never seen)
  for (const nfts of [0, undefined]) {
    const empty = newWallet(0);
    if (nfts !== undefined) holdings.set(empty.address, nfts);
    s = await call(device, 'POST', '/signin/start');
    r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: empty.address, signature: signAs(empty, s.body.text) });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /no Devikins/);
  }

  // At most 3 sign-ins open at a time
  const busy = createIdentity();
  for (let i = 0; i < 3; i += 1) assert.equal((await call(busy, 'POST', '/signin/start')).status, 200);
  assert.equal((await call(busy, 'POST', '/signin/start')).status, 429);
});

test('sign-in when Klever\'s server is down: a clear "try again"', async () => {
  const { call } = setUp({ kleverDown: true });
  const device = createIdentity();
  const wallet = newWallet(5);
  const s = await call(device, 'POST', '/signin/start');
  const r = await call(device, 'POST', '/signin/finish', { code: s.body.code, wallet: wallet.address, signature: signAs(wallet, s.body.text) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /try again/);
});

test('requests must carry a fresh chat-key signature for exactly this request', async () => {
  const { office, call, clock } = setUp();
  const device = createIdentity();
  assert.equal((await call(null, 'GET', '/me')).status, 401);
  assert.equal((await call(device, 'GET', '/me', null, { authNow: clock.t - 61 * 1000 })).status, 401);
  assert.equal((await call(device, 'GET', '/me', null, { url: `${BASE}/mail` })).status, 401);
  assert.equal((await call(device, 'GET', '/me')).status, 200);
  // The body changed after signing
  const url = `${BASE}/nickname`;
  const authorization = makeAuthHeader(device, { url, method: 'POST', bodyText: '{"nickname":"A"}', now: clock.t });
  const r = await office.handle({ method: 'POST', url, bodyText: '{"nickname":"B"}', authorization });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /changed/);
});

test('one wallet = one account: a second device joins it; at most 5 devices; a chat key can\'t switch wallets', async () => {
  const { call, signIn } = setUp();
  const wallet = newWallet(4);
  const devices = Array.from({ length: MAX_DEVICES + 1 }, () => createIdentity());
  const first = await signIn(devices[0], wallet);
  for (let i = 1; i < MAX_DEVICES; i += 1) {
    const r = await signIn(devices[i], wallet);
    assert.equal(r.body.account, first.body.account);
  }
  const me = await call(devices[1], 'GET', '/me');
  assert.equal(me.body.devices.length, MAX_DEVICES);
  assert.equal((await signIn(devices[MAX_DEVICES], wallet)).status, 409);
  // Signing in again (weekly) with the same wallet is fine
  assert.equal((await signIn(devices[0], wallet)).status, 200);
  // ... with another wallet is not
  assert.equal((await signIn(devices[0], newWallet(9))).status, 409);
});

test('nicknames: first come, first served; look-alikes count as taken; only verified players see the directory', async () => {
  const { call, signIn, clock, a, b } = await twoPlayers();
  assert.equal((await call(b.device, 'POST', '/nickname', { nickname: 'alice' })).status, 409);
  for (const lookAlike of ['devi fan', 'DEVIFAN', 'Dev1-Fan', 'devl.fan']) assert.equal(nicknameKey(lookAlike), nicknameKey('Devi_Fan'), lookAlike);
  assert.equal(nicknameKey('B0b'), nicknameKey('bob'));
  assert.equal((await call(b.device, 'POST', '/nickname', { nickname: 'A1ice' })).status, 409);
  for (const bad of ['', 'x', '-abc', 'a'.repeat(21), 'emoji🙂', 'two  spaces!']) {
    assert.equal((await call(b.device, 'POST', '/nickname', { nickname: bad })).status, 400, bad);
  }
  const dir = await call(a.device, 'GET', '/directory?q=bo');
  assert.deepEqual(dir.body.players, [{ nickname: 'Bob', devices: [b.device.publicKey] }]);
  assert.equal((await call(a.device, 'GET', '/directory')).body.players.length, 2);
  // Not signed in → no directory
  assert.equal((await call(createIdentity(), 'GET', '/directory')).status, 403);
  // A week later without signing in again: not listed, can't look
  clock.t += 7 * DAY + 1000;
  assert.equal((await call(a.device, 'GET', '/directory')).status, 403);
  await signIn(a.device, a.wallet);
  assert.deepEqual((await call(a.device, 'GET', '/directory')).body.players.map((p) => p.nickname), ['Alice']);
});

test('the whole 1:1 path: contact request → accept with drop codes → messages → blocking', async () => {
  const { call, a, b } = await twoPlayers();
  const bobDevices = (await call(a.device, 'GET', '/directory?q=bob')).body.players[0].devices;

  // Alice makes a drop code for Bob and sends it with her request.
  const codeForBob = randomCode();
  assert.equal((await call(a.device, 'POST', '/codes', { add: [codeForBob] })).status, 200);
  const request = sealDirect({ from: a.device, toDevices: bobDevices, type: 'contact-request', body: { nickname: 'Alice', code: codeForBob, devices: [a.device.publicKey] } });
  const sent = await call(a.device, 'POST', '/request', { nickname: 'Bob', items: request });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  // Bob collects it: the postman only had a sealed envelope.
  const mail = await call(b.device, 'GET', '/mail');
  assert.equal(mail.body.items.length, 1);
  assert.equal(mail.body.items[0].kind, 'request');
  const opened = openDirect(mail.body.items[0].envelope, b.device);
  assert.equal(opened.from, a.device.publicKey);
  assert.equal(opened.data.nickname, 'Alice');
  assert.equal((await call(b.device, 'POST', '/mail/done', { ids: [mail.body.items[0].id] })).body.deleted, 1);
  assert.equal((await call(b.device, 'GET', '/mail')).body.items.length, 0);

  // Bob accepts: his own drop code for Alice, dropped with Alice's code (no chat-key signature needed).
  const codeForAlice = randomCode();
  await call(b.device, 'POST', '/codes', { add: [codeForAlice] });
  const devicesOfAlice = (await call(null, 'POST', '/drop/devices', { code: opened.data.code })).body.devices;
  assert.deepEqual(devicesOfAlice, [a.device.publicKey]);
  const accept = sealDirect({ from: b.device, toDevices: devicesOfAlice, type: 'contact-accept', body: { code: codeForAlice } });
  assert.equal((await call(null, 'POST', '/drop', { code: opened.data.code, items: accept })).status, 200);

  // Alice writes; Bob reads.
  const aMail = (await call(a.device, 'GET', '/mail')).body.items;
  const theirCode = openDirect(aMail[0].envelope, a.device).data.code;
  const hi = sealDirect({ from: a.device, toDevices: bobDevices, body: 'Hi Bob, want to trade?' });
  assert.equal((await call(null, 'POST', '/drop', { code: theirCode, items: hi })).status, 200);
  const bMail = (await call(b.device, 'GET', '/mail')).body.items;
  assert.equal(openDirect(bMail[0].envelope, b.device).text, 'Hi Bob, want to trade?');

  // An envelope for someone else can't be dropped with Bob's code.
  const wrong = sealDirect({ from: a.device, toDevices: [a.device.publicKey], body: 'x' });
  assert.equal((await call(null, 'POST', '/drop', { code: theirCode, items: wrong })).status, 400);

  // Bob blocks Alice: removes her code. Her next drop is refused.
  await call(b.device, 'POST', '/codes', { remove: [codeForAlice] });
  const again = await call(null, 'POST', '/drop', { code: theirCode, items: hi });
  assert.equal(again.status, 403);
});

test('contact requests: 5 min, then 10 min pause; not to yourself; envelopes only for that player', async () => {
  const env = await twoPlayers();
  const { call, clock, a, b } = env;
  const c = { device: createIdentity(), wallet: newWallet(1) };
  await env.signIn(c.device, c.wallet);
  await call(c.device, 'POST', '/nickname', { nickname: 'Carol' });
  const req = (to) => sealDirect({ from: a.device, toDevices: [to], type: 'contact-request', body: {} });

  assert.equal((await call(a.device, 'POST', '/request', { nickname: 'Alice', items: req(a.device.publicKey) })).status, 400);
  assert.equal((await call(a.device, 'POST', '/request', { nickname: 'Bob', items: req(c.device.publicKey) })).status, 400);
  assert.equal((await call(a.device, 'POST', '/request', { nickname: 'Nobody', items: req(b.device.publicKey) })).status, 404);
  // Copies for your own devices don't travel with a request (so it can't be traced back to you).
  assert.equal((await call(a.device, 'POST', '/request', { nickname: 'Bob', items: [...req(b.device.publicKey), ...req(a.device.publicKey)] })).status, 400);

  const first = await call(a.device, 'POST', '/request', { nickname: 'Bob', items: req(b.device.publicKey) });
  assert.equal(first.body.nextRequestAt, clock.t + 5 * MINUTE);
  clock.t += 4 * MINUTE;
  const tooSoon = await call(a.device, 'POST', '/request', { nickname: 'Carol', items: req(c.device.publicKey) });
  assert.equal(tooSoon.status, 429);
  assert.match(tooSoon.body.error, /1 min/);
  clock.t += MINUTE;
  const second = await call(a.device, 'POST', '/request', { nickname: 'Carol', items: req(c.device.publicKey) });
  assert.equal(second.status, 200);
  assert.equal(second.body.nextRequestAt, clock.t + 10 * MINUTE);

  // Leaving and signing in again with the same wallet doesn't reset the pause.
  await call(a.device, 'POST', '/leave', {});
  const back = createIdentity();
  await env.signIn(back, a.wallet);
  await call(back, 'POST', '/nickname', { nickname: 'Alice' });
  const fresh = await call(back, 'POST', '/request', { nickname: 'Bob', items: sealDirect({ from: back, toDevices: [b.device.publicKey], type: 'contact-request', body: {} }) });
  assert.equal(fresh.status, 429);
});

test('envelopes are checked for shape and size; a full mailbox says so', async () => {
  const { call, a, b } = await twoPlayers();
  const code = randomCode();
  await call(b.device, 'POST', '/codes', { add: [code] });
  const good = sealDirect({ from: a.device, toDevices: [b.device.publicKey], body: 'x' })[0];
  const drop = (items) => call(null, 'POST', '/drop', { code, items });
  assert.equal((await drop([{ to: b.device.publicKey, envelope: { ...good.envelope, kind: 1 } }])).status, 400);
  assert.equal((await drop([{ to: b.device.publicKey, envelope: { ...good.envelope, tags: [['p', a.device.publicKey]] } }])).status, 400);
  assert.equal((await drop([{ to: b.device.publicKey, envelope: { ...good.envelope, content: 'x'.repeat(MAX_ENVELOPE_CHARS) } }])).status, 413);
  assert.equal((await drop([])).status, 400);
  assert.equal((await drop(Array(11).fill(good))).status, 400);
  // (several contacts' codes: one code alone may drop at most DAILY_DROPS_PER_CODE a day)
  let other = null;
  for (let i = 0; i < MAX_WAITING_PER_DEVICE / 10; i += 1) {
    if (i % 10 === 0) {
      other = randomCode();
      await call(b.device, 'POST', '/codes', { add: [other] });
    }
    assert.equal((await call(null, 'POST', '/drop', { code: other, items: Array(10).fill(good) })).status, 200);
  }
  assert.equal((await drop([good])).status, 507);
});

test('mail waits until collected – or 30 days; a device only sees and deletes its own', async () => {
  const { office, call, clock, a, b } = await twoPlayers();
  const code = randomCode();
  await call(b.device, 'POST', '/codes', { add: [code] });
  const env = sealDirect({ from: a.device, toDevices: [b.device.publicKey], body: 'hello' });
  await call(null, 'POST', '/drop', { code, items: env });
  const id = (await call(b.device, 'GET', '/mail')).body.items[0].id;
  assert.equal((await call(a.device, 'POST', '/mail/done', { ids: [id] })).body.deleted, 0);
  assert.equal((await call(a.device, 'GET', '/mail')).body.items.length, 0);
  clock.t += 29 * DAY;
  office.cleanUp();
  assert.equal((await call(b.device, 'GET', '/mail')).body.items.length, 1);
  clock.t += 2 * DAY;
  office.cleanUp();
  assert.equal((await call(b.device, 'GET', '/mail')).body.items.length, 0);
});

test('groups: one stored copy per post, numbered; members read with the postman\'s badges and limits', async () => {
  const { office, call, clock, a, b } = await twoPlayers();
  const group = createGroup();
  const post = async (who, text) => call(who.device, 'POST', '/group/post', { envelope: sealGroupPost({ group, from: who.device, text, badge: who.badge, now: clock.t }) });

  const p1 = await post(a, 'Selling a Devikin, anyone?');
  assert.equal(p1.status, 200);
  assert.equal((await post(a, 'Again!')).status, 429); // flood limit: 1 per minute
  clock.t += MINUTE;
  assert.equal((await post(b, 'Me!')).status, 200);
  assert.equal((await call(createIdentity(), 'POST', '/group/post', { envelope: { v: 1, group: group.id, epoch: 1, payload: 'x' } })).status, 403);

  const all = (await call(b.device, 'GET', `/group/posts?group=${group.id}`)).body.posts;
  assert.equal(all.length, 2);
  const newer = (await call(b.device, 'GET', `/group/posts?group=${group.id}&after=${p1.body.seq}`)).body.posts;
  assert.equal(newer.length, 1);

  const items = all.map((p) => ({ post: openGroupPost(p.envelope, { groupId: group.id, keys: { 1: group.key } }), receivedAt: p.receivedAt }));
  const { shown, dropped } = acceptPosts(items, { postmanPublicKey: office.postmanPublicKey });
  assert.equal(shown.length, 2, JSON.stringify(dropped));
  assert.equal(shown[0].post.text, 'Selling a Devikin, anyone?');

  clock.t += 30 * DAY + 1000;
  office.cleanUp();
  await call(a.device, 'POST', '/signin/start'); // (keeps nothing else)
  assert.equal((await call(b.device, 'GET', `/group/posts?group=${group.id}`)).status, 403); // badge week is over
});

test('leaving: the device is forgotten; with the last device the account and nickname go too', async () => {
  const { call, signIn, a, b } = await twoPlayers();
  const r = await call(a.device, 'POST', '/leave', {});
  assert.deepEqual(r.body, { left: true, accountDeleted: true });
  assert.equal((await call(a.device, 'GET', '/me')).body.signedIn, false);
  const newcomer = createIdentity();
  await signIn(newcomer, newWallet(1));
  assert.equal((await call(newcomer, 'POST', '/nickname', { nickname: 'Alice' })).status, 200);
  assert.equal((await call(b.device, 'GET', '/me')).body.nickname, 'Bob');
});

test('after 180 days without signing in, an account is forgotten', async () => {
  const { office, call, clock, a } = await twoPlayers();
  clock.t += 7 * DAY + 180 * DAY + 1000; // the badge week, then 180 days
  office.cleanUp();
  assert.equal((await call(a.device, 'GET', '/me')).body.signedIn, false);
});

test('the postman keeps its key across restarts and never stores a wallet', async () => {
  const sql = standInSql();
  const env = setUp({ sql });
  const device = createIdentity();
  const wallet = newWallet(3);
  await env.signIn(device, wallet);
  const again = createPostOffice({ sql, fetchKlever: async () => { throw new Error('no'); } });
  assert.equal(again.postmanPublicKey, env.office.postmanPublicKey);

  const everything = [];
  for (const { name } of sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    everything.push(JSON.stringify(sql.db.prepare(`SELECT * FROM ${name}`).all()));
  }
  const dump = everything.join('\n');
  assert.ok(!dump.includes(wallet.address));
  assert.ok(!dump.includes(Buffer.from(walletPublicKey(wallet.address)).toString('hex')));
});

test('Klever API answers and signature formats are read carefully', async () => {
  const w = newWallet(1).address;
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await devikinsHeld(w, answer(200, { data: { account: { address: w, assets: { 'DVKNFT-1SW5': { balance: 42 } } } } })), 42);
  assert.equal(await devikinsHeld(w, answer(200, { data: { account: { address: w, assets: { 'DVK-34ZH': { balance: 5 } } } } })), 0);
  assert.equal(await devikinsHeld(w, answer(404, { data: null, code: 'not_found' })), 0);
  await assert.rejects(devikinsHeld(w, answer(200, { data: { account: { address: 'klv1other', assets: {} } } })));
  await assert.rejects(devikinsHeld(w, answer(500, {})));
  await assert.rejects(devikinsHeld('klv1nope', answer(200, {})));
  const hex = 'ab'.repeat(64);
  assert.equal(signatureBytes(hex).length, 64);
  assert.equal(signatureBytes(Buffer.from(hex, 'hex').toString('base64')).length, 64);
  assert.throws(() => signatureBytes('abc'));
});

test('a postman badge with an account number is checked like any other', () => {
  // (badge.js: the account tag is optional; damaged ones are refused)
  const postman = createIdentity();
  const holder = createIdentity().publicKey;
  return import('../src/badge.js').then(({ issueBadge }) => {
    const b = issueBadge(postman, { holder, nfts: 2, now: Date.now(), account: 'ab'.repeat(16) });
    assert.equal(checkBadge(b, { postmanPublicKey: postman.publicKey, holder, at: Date.now() }).account, 'ab'.repeat(16));
    assert.throws(() => issueBadge(postman, { holder, nfts: 2, now: Date.now(), account: 'wallet' }));
    const old = issueBadge(postman, { holder, nfts: 2, now: Date.now() });
    assert.equal(checkBadge(old, { postmanPublicKey: postman.publicKey, holder, at: Date.now() }).account, null);
    void HOUR;
  });
});

test('privacy: waiting mail only carries the hour; the wallet fingerprint is the only trace of the wallet', async () => {
  const { call, clock, a, b } = await twoPlayers();
  clock.t += 17 * MINUTE + 4321;
  const code = randomCode();
  await call(b.device, 'POST', '/codes', { add: [code] });
  await call(null, 'POST', '/drop', { code, items: sealDirect({ from: a.device, toDevices: [b.device.publicKey], body: 'x' }) });
  const at = (await call(b.device, 'GET', '/mail')).body.items[0].at;
  assert.equal(at % HOUR, 0);
  assert.ok(clock.t - at < HOUR);
});

test('daily allowances: drops per code, actions per player; a code already used by someone else is refused', async () => {
  const { call, clock, a, b } = await twoPlayers();
  const code = randomCode();
  const r1 = await call(b.device, 'POST', '/codes', { add: [code] });
  assert.equal(r1.body.refused, 0);
  assert.equal((await call(a.device, 'POST', '/codes', { add: [code] })).body.refused, 1);
  const env = sealDirect({ from: a.device, toDevices: [b.device.publicKey], body: 'x' })[0];
  for (let i = 0; i < DAILY_DROPS_PER_CODE / 10; i += 1) {
    assert.equal((await call(null, 'POST', '/drop', { code, items: Array(10).fill(env) })).status, 200);
    if (i % 4 === 3) { // Bob keeps reading, so the mailbox doesn't fill up
      const ids = (await call(b.device, 'GET', '/mail')).body.items.map((m) => m.id);
      await call(b.device, 'POST', '/mail/done', { ids });
    }
  }
  assert.equal((await call(null, 'POST', '/drop', { code, items: [env] })).status, 429);
  clock.t += DAY;
  assert.equal((await call(null, 'POST', '/drop', { code, items: [env] })).status, 200);

  const many = Array.from({ length: 100 }, randomCode);
  for (let used = 0; used + 200 <= DAILY_ACTIONS_PER_PLAYER; used += 200) {
    assert.equal((await call(a.device, 'POST', '/codes', { add: many })).status, 200);
    assert.equal((await call(a.device, 'POST', '/codes', { remove: many })).status, 200);
  }
  assert.equal((await call(a.device, 'POST', '/codes', { add: many })).status, 200); // exactly the allowance
  assert.equal((await call(a.device, 'POST', '/codes', { remove: [many[0]] })).status, 429);
});

test('too-big or damaged requests are refused, not crashing the postman', async () => {
  const { office, call, a, b } = await twoPlayers();
  const url = `${BASE}/drop`;
  assert.equal((await office.handle({ method: 'POST', url, bodyText: 'x'.repeat(MAX_BODY_CHARS + 1) })).status, 413);
  let deep = 'null';
  for (let i = 0; i < 100000; i += 1) deep = `[${deep}]`;
  const code = randomCode();
  await call(b.device, 'POST', '/codes', { add: [code] });
  const r = await office.handle({ method: 'POST', url, bodyText: `{"code":"${code}","items":[{"to":"${b.device.publicKey}","envelope":${deep}}]}` });
  assert.ok([400, 413].includes(r.status), String(r.status));
  assert.equal((await call(null, 'POST', '/drop', { code: [code], items: [] })).status, 403);
  // The longest possible group post fits the postman's group limit.
  const group = createGroup();
  const longest = sealGroupPost({ group, from: a.device, text: '\u{FFFD}'.repeat(2000), badge: a.badge });
  assert.ok(JSON.stringify(longest).length <= POSTMAN_GROUP_MAX, String(JSON.stringify(longest).length));
  assert.equal((await call(a.device, 'POST', '/group/post', { envelope: longest })).status, 200);
});
