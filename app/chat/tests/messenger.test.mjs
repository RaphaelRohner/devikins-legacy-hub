// The chat as two (or three) players' Hubs use it: messenger.js on each
// "device", talking to the real postman code (chat/postman) through a
// pretend network, with real Klever wallet signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, signMessageSync, prepareKlvMessage } from '@klever/connect-crypto';
import { bech32Encode } from '@klever/connect-encoding';
import { createMessenger, STATUS } from '../src/messenger.js';
import { createPostOffice } from '../postman/src/postOffice.js';
import { MINUTE } from '../src/rules.js';

const BASE = 'https://postman.test';

/** Node's SQLite dressed like expo-sqlite's async calls (the Hub's local database). */
function localDb() {
  const db = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: r.changes };
    },
    async getAllAsync(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
  };
}

/** The postman's own database (like Cloudflare's ctx.storage.sql). */
function postmanSql() {
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } };
}

function world() {
  const clock = { t: Date.UTC(2026, 9, 22, 10, 0, 0) };
  const holdings = new Map([['klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf', 1066763]]); // the game account: voting threshold 10
  const office = createPostOffice({
    sql: postmanSql(),
    now: () => clock.t,
    fetchKlever: async (url) => {
      const address = url.split('/address/')[1];
      if (!holdings.has(address)) return new Response('{}', { status: 404 });
      return Response.json({ data: { account: { address, assets: { 'DVKNFT-1SW5': { balance: holdings.get(address) } } } } });
    },
  });
  const network = { down: false };
  const fetchFn = async (url, init = {}) => {
    if (network.down) throw new TypeError('Failed to fetch');
    if (network.directoryDown && url.includes('/directory')) throw new TypeError('Failed to fetch');
    const r = await office.handle({ method: init.method || 'GET', url, bodyText: init.body || '', authorization: init.headers?.Authorization ?? null });
    return Response.json(r.body, { status: r.status });
  };
  async function player(nickname, nfts = 3, sameWalletAs = null) {
    const { privateKey, publicKey } = sameWalletAs ? sameWalletAs.walletKeys : generateKeyPairSync();
    const wallet = bech32Encode(publicKey.bytes, 'klv');
    if (!sameWalletAs) holdings.set(wallet, nfts);
    const db = localDb();
    const m = await createMessenger({ db, postmanUrl: BASE, fetchFn, now: () => clock.t });
    // (for tests that play a modified Hub: the device's raw key and postman)
    m.db = db;
    const { createPostmanClient } = await import('../src/client.js');
    m.postman = createPostmanClient({ baseUrl: BASE, identity: JSON.parse((await db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v), fetchFn, now: () => clock.t });
    const { code, text } = await m.startSignIn();
    const signature = Buffer.from(signMessageSync(prepareKlvMessage(text), privateKey.bytes)).toString('hex');
    const signedIn = await m.finishSignIn({ code, wallet, signature });
    m.walletKeys = { privateKey, publicKey };
    // What the Klever extension does when asked to sign a text:
    m.sign = async (t) => ({ address: wallet, signature: Buffer.from(signMessageSync(prepareKlvMessage(t), privateKey.bytes)).toString('hex') });
    m.wallet = wallet;
    m.holdings = holdings;
    /** "Update my holdings": the wallet now holds `n`, and the player signs in again. */
    m.setHoldings = async (n) => {
      holdings.set(wallet, n);
      const again = await m.startSignIn();
      await m.finishSignIn({ code: again.code, wallet, signature: (await m.sign(again.text)).signature });
    };
    /**
     * Starting a group takes the voting threshold (10 here): players below it
     * hold 10 just long enough to start one (most tests are about other things).
     */
    m.startGroup = async (name, description) => {
      const before = holdings.get(wallet);
      if (before >= 10) return m.createGroup(name, description);
      await m.setHoldings(10);
      const id = await m.createGroup(name, description);
      await m.setHoldings(before);
      return id;
    };
    if (sameWalletAs) return m; // a second browser of the same player
    assert.equal(signedIn.state, 'needs-nickname');
    assert.equal((await m.setNickname(nickname)).state, 'ready');
    return m;
  }
  /** A browser without a chat yet (not signed in). */
  async function blank() {
    const db = localDb();
    const m = await createMessenger({ db, postmanUrl: BASE, fetchFn, now: () => clock.t });
    m.db = db;
    return m;
  }
  /** The postman's alarm: counts the votes whose time is over. */
  async function decide() {
    while (await office.decideAllVotes()) { /* (a few wallets per run) */ }
  }
  return { clock, network, player, blank, decide, office };
}

test('request → accept → messages both ways; history stays on each device', async () => {
  const { player } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');

  assert.deepEqual((await alice.findPlayers('b')).map((p) => p.nickname), ['Bob']);
  assert.deepEqual((await alice.findPlayers('')).map((p) => p.nickname), ['Bob']); // not herself
  const id = await alice.requestContact('Bob');
  assert.equal((await alice.listContacts())[0].status, STATUS.OUTGOING);

  assert.deepEqual(await bob.checkMail(), { messages: 0, requests: 1, accepted: 0 });
  const [request] = await bob.listContacts();
  assert.deepEqual([request.nickname, request.status, request.unread], ['Alice', STATUS.INCOMING, 1]);
  await bob.acceptContact(request.id);

  assert.equal((await alice.checkMail()).accepted, 1);
  assert.equal((await alice.listContacts())[0].status, STATUS.ACCEPTED);
  await alice.sendMessage(id, 'Hi Bob! Selling a Devikin?');
  await bob.checkMail();
  const bobsView = (await bob.listContacts())[0];
  assert.equal(bobsView.unread, 1);
  assert.deepEqual((await bob.messages(bobsView.id)).map((m) => [m.mine, m.text]), [[false, 'Hi Bob! Selling a Devikin?']]);
  assert.equal((await bob.listContacts())[0].unread, 0);
  await bob.sendMessage(bobsView.id, 'Yes, a Fire one.');
  await alice.checkMail();
  assert.deepEqual((await alice.messages(id)).map((m) => [m.mine, m.text]), [[true, 'Hi Bob! Selling a Devikin?'], [false, 'Yes, a Fire one.']]);
  // Nothing left at the postman
  assert.deepEqual(await bob.checkMail(), { messages: 0, requests: 0, accepted: 0 });
});

test('no writing before the answer; declining is silent; the request pause shows', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  const carol = await player('Carol');
  const id = await alice.requestContact('Bob');
  await assert.rejects(alice.sendMessage(id, 'hello?'), /accepted/);
  await assert.rejects(alice.requestContact('Carol'), /Next contact request possible in 5 min/);
  assert.equal((await alice.status()).nextRequestAt, clock.t + 5 * MINUTE);
  await bob.checkMail();
  const [req] = await bob.listContacts();
  await bob.declineContact(req.id);
  assert.equal((await bob.listContacts()).length, 0);
  assert.equal((await alice.checkMail()).accepted, 0);
  clock.t += 5 * MINUTE;
  await alice.requestContact('Carol');
  assert.equal((await carol.checkMail()).requests, 1);
});

test('both ask each other: that counts as yes on both sides', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  const aid = await alice.requestContact('Bob');
  clock.t += MINUTE;
  // Bob hasn't looked at his mail yet and asks Alice too
  await bob.requestContact('Alice');
  await alice.checkMail();
  await bob.checkMail();
  assert.equal((await alice.listContacts())[0].status, STATUS.ACCEPTED);
  assert.equal((await bob.listContacts())[0].status, STATUS.ACCEPTED);
  await alice.sendMessage(aid, 'Ha, same idea');
  assert.equal((await bob.checkMail()).messages, 1);
});

test('blocking stops their messages at the postman; unblocking lets them write again', async () => {
  const { player } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  const aid = await alice.requestContact('Bob');
  await bob.checkMail();
  const bid = (await bob.listContacts())[0].id;
  await bob.acceptContact(bid);
  await alice.checkMail();

  await bob.blockContact(bid);
  assert.equal((await bob.listContacts())[0].status, STATUS.BLOCKED);
  await assert.rejects(alice.sendMessage(aid, 'are you there?'), /isn't receiving your messages/);
  assert.equal((await alice.listContacts())[0].ended, true);

  await bob.unblockContact(bid);
  await alice.checkMail(); // gets Bob's new code
  assert.equal((await alice.listContacts())[0].ended, false);
  await alice.sendMessage(aid, 'welcome back');
  assert.equal((await bob.checkMail()).messages, 1);
});

test('a request claiming someone else\'s nickname is ignored; strangers can\'t write', async () => {
  const { player } = world();
  await player('Alice');
  const bob = await player('Bob');
  const mallory = await player('Mallory');
  const malloryKey = JSON.parse((await mallory.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v);
  const bobDevices = (await mallory.findPlayers('Bob'))[0].devices;
  // A modified Hub sends a request that claims to come from "Alice"
  const { sealDirect } = await import('../src/direct.js');
  const fake = sealDirect({
    from: malloryKey, toDevices: bobDevices, type: 'contact-request',
    body: { nickname: 'Alice', code: 'ab'.repeat(32), devices: [malloryKey.publicKey] },
  });
  await mallory.postman.request('Bob', fake);
  assert.equal((await bob.checkMail()).requests, 0);
  assert.equal((await bob.listContacts()).length, 0);
  // A text from someone who isn't a contact is dropped too (if they ever get a code)
  const text = sealDirect({ from: malloryKey, toDevices: bobDevices, body: 'buy my NFTs' });
  const leaked = 'cd'.repeat(32);
  await bob.postman.codes({ add: [leaked] });
  await mallory.postman.drop(leaked, text);
  assert.equal((await bob.checkMail()).messages, 0);
});

test('a damaged envelope doesn\'t block the mailbox; the postman being unreachable gives a plain message', async () => {
  const { player, network } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  const code = 'ef'.repeat(32);
  await bob.postman.codes({ add: [code] });
  const { sealDirect } = await import('../src/direct.js');
  const good = sealDirect({ from: JSON.parse((await alice.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v), toDevices: [bob.identity.publicKey], body: 'x' })[0];
  const broken = { ...good.envelope, content: good.envelope.content.slice(0, -8) + 'AAAAAAAA' };
  await alice.postman.drop(code, [{ to: bob.identity.publicKey, envelope: broken }]);
  assert.deepEqual(await bob.checkMail(), { messages: 0, requests: 0, accepted: 0 });
  assert.equal((await bob.postman.mail()).items.length, 0); // handed back as done
  network.down = true;
  await assert.rejects(bob.checkMail(), /Can't reach the chat postman/);
});

test('after a week the badge runs out: sign in again', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  clock.t += 7 * 24 * 60 * MINUTE + 1;
  const s = await alice.status();
  assert.deepEqual([s.state, s.expired, s.nickname], ['signed-out', true, 'Alice']);
});

const identityOf = async (m) => JSON.parse((await m.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v);

async function connect(a, b, clock) {
  await a.requestContact((await b.status()).nickname);
  await b.checkMail();
  const req = (await b.listContacts()).find((c) => c.status === STATUS.INCOMING);
  await b.acceptContact(req.id);
  await a.checkMail();
  clock.t += 25 * 60 * 60 * 1000; // past the request pause
}

test('a contact can\'t slip someone else\'s device into their entry', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  const mallory = await player('Mallory');
  await connect(alice, bob, clock);
  await connect(mallory, bob, clock);
  // Mallory asks Bob again, claiming Alice's device as one of hers
  const { sealDirect } = await import('../src/direct.js');
  const mk = await identityOf(mallory);
  const bobDevices = (await mallory.findPlayers('Bob'))[0].devices;
  const myCode = 'ab'.repeat(32);
  await mallory.postman.codes({ add: [myCode] });
  const fake = sealDirect({ from: mk, toDevices: bobDevices, type: 'contact-request', body: { nickname: 'Mallory', code: myCode, devices: [mk.publicKey, alice.identity.publicKey] } });
  await mallory.postman.request('Bob', fake);
  await bob.checkMail();
  const entries = await bob.listContacts();
  assert.deepEqual(entries.find((c) => c.nickname === 'Mallory').devices, [mk.publicKey]);
  assert.deepEqual(entries.find((c) => c.nickname === 'Alice').devices, [alice.identity.publicKey]);
  // Alice's messages still land in Alice's thread
  const aliceOnBob = (await alice.listContacts())[0];
  await alice.sendMessage(aliceOnBob.id, 'it is really me');
  await bob.checkMail();
  const aliceEntry = (await bob.listContacts()).find((c) => c.nickname === 'Alice');
  assert.deepEqual((await bob.messages(aliceEntry.id)).map((m) => m.text), ['it is really me']);
});

test('a new player taking a freed nickname doesn\'t get the old conversation', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await connect(alice, bob, clock);
  const bobId = (await alice.listContacts())[0].id;
  await alice.sendMessage(bobId, 'secret plans');
  await bob.leave(); // Bob's nickname is free again
  const eve = await player('BOB');
  await eve.requestContact('Alice');
  assert.equal((await alice.checkMail()).requests, 1);
  const list = await alice.listContacts();
  const old = list.find((c) => c.id === bobId);
  assert.equal(old.nickname, 'Bob (earlier player)');
  assert.equal(old.ended, true);
  const fresh = list.find((c) => c.nickname === 'BOB');
  assert.equal(fresh.status, STATUS.INCOMING);
  assert.deepEqual(await alice.messages(fresh.id), []);
});

test('asking again after removing a contact works (the other side answers by itself)', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await connect(alice, bob, clock);
  const aliceOnBob = (await bob.listContacts())[0];
  await bob.removeContact(aliceOnBob.id);
  await bob.requestContact('Alice');
  await alice.checkMail(); // Alice still had Bob: her Hub answers with her code
  assert.equal((await bob.checkMail()).accepted, 1);
  const again = (await bob.listContacts())[0];
  assert.equal(again.status, STATUS.ACCEPTED);
  await bob.sendMessage(again.id, 'sorry, misclick');
  await alice.checkMail();
  const bobOnAlice = (await alice.listContacts())[0];
  assert.deepEqual((await alice.messages(bobOnAlice.id)).map((m) => m.text), ['sorry, misclick']);
});

test('if a check can\'t be done, the envelope waits at the postman instead of getting lost', async () => {
  const { player, network } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await alice.requestContact('Bob');
  network.directoryDown = true;
  await assert.rejects(bob.checkMail(), /Can't reach the chat postman/);
  assert.equal((await bob.listContacts()).length, 0);
  network.directoryDown = false;
  assert.equal((await bob.checkMail()).requests, 1);
});

test('unblocking a blocked request makes it an open request again (not accepted)', async () => {
  const { player } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await alice.requestContact('Bob');
  await bob.checkMail();
  const req = (await bob.listContacts())[0];
  await bob.blockContact(req.id);
  await bob.unblockContact(req.id);
  assert.equal((await bob.listContacts())[0].status, STATUS.INCOMING);
  assert.equal((await alice.checkMail()).accepted, 0);
});

test('look-alike spellings find the player, and checks overlap safely', async () => {
  const { player } = world();
  const alice = await player('Alice');
  const devi = await player('DeviFan');
  await alice.requestContact('dev1-fan');
  assert.equal((await alice.listContacts())[0].nickname, 'DeviFan');
  const [a, b] = await Promise.all([devi.checkMail(), devi.checkMail()]);
  assert.equal(a.requests + b.requests, 2); // the same run, counted once each caller
  assert.equal((await devi.listContacts()).length, 1);
});

test('the chat backup: locked with a password, brought back in another browser, chatting goes on', async () => {
  const { lockBackup, unlockBackup } = await import('../src/backup.js');
  const { player, blank, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await connect(alice, bob, clock);
  await alice.sendMessage((await alice.listContacts())[0].id, 'before the move');

  const locked = JSON.stringify(await lockBackup(await alice.backupData(), 'correct horse', { rounds: 100000 }));
  assert.ok(!locked.includes('before the move'));
  assert.ok(!locked.includes((await identityOf(alice)).secretKey));
  await assert.rejects(unlockBackup(JSON.parse(locked), 'wrong horse'), (e) => e.wrongPassword === true);
  const tampered = JSON.parse(locked);
  tampered.data = tampered.data.slice(0, -8) + 'AAAAAAA=';
  await assert.rejects(unlockBackup(tampered, 'correct horse'), (e) => e.wrongPassword === true);
  await assert.rejects(lockBackup({}, 'short'), /at least 8/);

  // Not into a browser that has its own chat
  await assert.rejects(bob.restoreBackupData(await unlockBackup(JSON.parse(locked), 'correct horse')), /already has a chat/);

  // A new browser: everything comes back, and the conversation goes on
  const moved = await blank();
  assert.equal(await moved.hasChat(), false);
  const s = await moved.restoreBackupData(await unlockBackup(JSON.parse(locked), 'correct horse'));
  assert.deepEqual([s.state, s.nickname], ['ready', 'Alice']);
  assert.equal(moved.identity.publicKey, alice.identity.publicKey);
  const bobThere = (await moved.listContacts())[0];
  assert.equal(bobThere.nickname, 'Bob');
  assert.deepEqual((await moved.messages(bobThere.id)).map((m) => m.text), ['before the move']);
  await moved.sendMessage(bobThere.id, 'hello from my new browser');
  await bob.checkMail();
  const aliceOnBob = (await bob.listContacts())[0];
  assert.deepEqual((await bob.messages(aliceOnBob.id)).map((m) => m.text), ['before the move', 'hello from my new browser']);
  await bob.sendMessage(aliceOnBob.id, 'got it');
  assert.equal((await moved.checkMail()).messages, 1);
});

test('a chat started with an earlier version (no before_block column) still works and backs up fine', async () => {
  const { player, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await connect(alice, bob, clock);
  // Make Bob's database look like one made by the earlier version, then start his messenger again
  const rows = await bob.db.getAllAsync('SELECT * FROM chat_contacts');
  await bob.db.execAsync('DROP TABLE chat_contacts; CREATE TABLE chat_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL, devices TEXT NOT NULL, their_code TEXT, my_code TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, last_at INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0);');
  for (const r of rows) {
    await bob.db.runAsync('INSERT INTO chat_contacts (id, nickname, devices, their_code, my_code, status, created, last_at, unread, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.id, r.nickname, r.devices, r.their_code, r.my_code, r.status, r.created, r.last_at, r.unread, r.ended]);
  }
  const { createMessenger: make } = await import('../src/messenger.js');
  const again = await make({ db: bob.db, postmanUrl: 'https://postman.test', fetchFn: undefined });
  const [c] = await again.listContacts();
  assert.equal(c.nickname, 'Alice');
  const data = await again.backupData();
  assert.equal(data.contacts.length, 1);
  assert.ok('before_block' in data.contacts[0]);
});

test('a restore that fails half-way leaves no half chat behind', async () => {
  const { blank } = world();
  const target = await blank();
  const before = target.identity.publicKey;
  const { createIdentity } = await import('../src/identity.js');
  const bad = { kind: 'chat', version: 1, me: { identity: createIdentity(), nickname: 'X', account: 'ab'.repeat(16) }, contacts: [{ id: 1, nickname: 'Y', devices: '[]', status: 'accepted', created: 1, last_at: 1 }], messages: [{ contact: 1, text: { not: 'text' } }] };
  // a message that can't be stored: make the database refuse it
  const realRun = target.db.runAsync.bind(target.db);
  target.db.runAsync = async (sql, params) => {
    if (sql.startsWith('INSERT INTO chat_contacts')) throw new Error('disk full');
    return realRun(sql, params);
  };
  await assert.rejects(target.restoreBackupData(bad), /couldn't be brought back/);
  target.db.runAsync = realRun;
  assert.equal(await target.hasChat(), false);
  assert.equal(target.identity.publicKey, before);
  assert.equal((await target.status()).state, 'signed-out');
});

test('"only this browser" removes the chat here and leaves it working in the other browser', async () => {
  const { lockBackup, unlockBackup } = await import('../src/backup.js');
  const { player, blank, clock } = world();
  const alice = await player('Alice');
  const bob = await player('Bob');
  await connect(alice, bob, clock);
  const moved = await blank();
  await moved.restoreBackupData(await unlockBackup(await lockBackup(await alice.backupData(), 'password1', { rounds: 100000 }), 'password1'));
  await alice.forgetHere();
  assert.equal(await alice.hasChat(), false);
  assert.notEqual(alice.identity.publicKey, moved.identity.publicKey);
  const c = (await moved.listContacts())[0];
  await moved.sendMessage(c.id, 'still here');
  assert.equal((await bob.checkMail()).messages, 1);
  await bob.sendMessage((await bob.listContacts())[0].id, 'hi');
  assert.equal((await moved.checkMail()).messages, 1);
});

test('groups: create, ask to join, a member\'s Hub lets you in, posts from joining on, limits by holdings, pinned rules', async () => {
  const { player, clock } = world();
  const alice = await player('Alice', 3); // 3 Devikins: 3 posts a day
  const bob = await player('Bob', 50); // 50: 50 posts a day
  // Starting a group takes the voting threshold (10 Devikins at the last sign-in).
  assert.deepEqual(await alice.groupCreateInfo().then((i) => [i.threshold === null || i.threshold === 10, i.nfts]), [true, 3]);
  await assert.rejects(alice.createGroup('Too Small'), /at least 10 Devikins \(your last sign-in counted 3\)/);
  await alice.listGroups();
  assert.deepEqual(await alice.groupCreateInfo(), { threshold: 10, nfts: 3, allowed: false });
  const gid = await alice.startGroup('Fire Breeders', 'Trading Fire Devikins');
  await alice.postToGroup(gid, 'Welcome, Fire fans!');
  await assert.rejects(alice.postToGroup(gid, 'and again'), /Not yet/);
  const next = await alice.nextGroupPostAt(gid);
  assert.equal(next.nfts, 3);
  // The owner may answer every 10 seconds, whatever she holds
  assert.deepEqual([next.owner, next.allowedAt - clock.t], [true, 10 * 1000]);

  let list = await bob.listGroups();
  assert.deepEqual(list.map((g) => [g.name, g.owner, g.members, g.member, g.asking]), [['Fire Breeders', 'Alice', 1, false, false]]);
  assert.equal(await bob.joinGroup(gid), 'asking');
  assert.equal((await bob.listGroups())[0].asking, true);
  await alice.checkMail(); // Alice's Hub sees Bob waiting and hands him the key
  assert.equal((await bob.checkMail()).joined, 1);
  list = await bob.listGroups();
  assert.deepEqual([list[0].member, list[0].asking, list[0].members], [true, false, 2]);
  assert.deepEqual(await bob.groupPosts(gid), []); // nothing from before he joined

  clock.t += MINUTE;
  await bob.postToGroup(gid, 'Hi everyone');
  await alice.checkMail();
  const seen = await alice.groupPosts(gid);
  assert.deepEqual(seen.map((p) => [p.nickname, p.text, p.mine]), [['Alice', 'Welcome, Fire fans!', true], ['Bob', 'Hi everyone', false]]);
  assert.deepEqual((await bob.groupPosts(gid)).map((p) => [p.nickname, p.mine]), [['Bob', true]]);

  // Pinned rules: only the owner; members see them after the next check
  await alice.setPinned(gid, 'Rules: be nice, no spam.');
  await assert.rejects(bob.setPinned(gid, 'I rule now'), /Only the group owner/);
  await bob.checkMail();
  assert.deepEqual((await bob.listGroups())[0].pinned.pins, ['Rules: be nice, no spam.']);

  // A newcomer gets the pinned rules right away, but no older posts
  const carol = await player('Carol', 1);
  await carol.joinGroup(gid);
  await bob.checkMail(); // any member's Hub can let her in
  await carol.checkMail();
  await carol.checkMail();
  const cg = (await carol.listGroups())[0];
  assert.equal(cg.member, true);
  assert.deepEqual(cg.pinned?.pins, ['Rules: be nice, no spam.']);
  assert.deepEqual(await carol.groupPosts(gid), []);

  // Unread counts, and leaving
  clock.t += 30 * MINUTE;
  await bob.postToGroup(gid, 'Carol, welcome!');
  await carol.checkMail();
  assert.equal((await carol.listGroups())[0].unread, 1);
  assert.equal((await carol.groupPosts(gid)).length, 1);
  assert.equal((await carol.listGroups())[0].unread, 0);
  await carol.leaveGroup(gid);
  assert.deepEqual((await carol.listGroups()).map((g) => [g.member, g.members]), [[false, 2]]);
});

test('groups: posts that come too early are hidden by every Hub; blocked players\' posts are hidden for you', async () => {
  const { player, clock } = world();
  const alice = await player('Alice', 1);
  const bob = await player('Bob', 50);
  const gid = await bob.startGroup('Open Talk'); // Bob runs it; Alice is a member (limit: 1 post a day)
  await alice.joinGroup(gid);
  await bob.checkMail();
  await alice.checkMail();
  // A modified Hub posts twice within a day for Alice: the postman takes it, every reader drops the 2nd
  clock.t += MINUTE;
  await alice.postToGroup(gid, 'first');
  clock.t += 2 * MINUTE;
  const { sealGroupPost } = await import('../src/group.js');
  const aliceKey = await identityOf(alice);
  const g = (await alice.db.getAllAsync('SELECT * FROM chat_groups'))[0];
  const badge = JSON.parse((await alice.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'badge'"))[0].v);
  await alice.postman.groupPost(sealGroupPost({ group: { id: gid, epoch: g.epoch, key: g.key }, from: aliceKey, text: 'sneaky second', badge, now: clock.t }));
  await bob.checkMail();
  assert.deepEqual((await bob.groupPosts(gid)).map((p) => p.text), ['first']);

  // Bob blocks Alice (as a contact): her later posts are hidden for him only
  await connect(alice, bob, clock);
  const aliceOnBob = (await bob.listContacts())[0];
  await bob.blockContact(aliceOnBob.id);
  clock.t += 25 * 60 * MINUTE;
  await alice.postToGroup(gid, 'after the block');
  await bob.checkMail();
  assert.deepEqual((await bob.groupPosts(gid)).map((p) => p.text), ['first']);
  assert.ok((await alice.groupPosts(gid)).some((p) => p.text === 'after the block'));
});

test('reactions: free (no allowance, no 10-second gap), one per player and post, switched or taken back; not counted as new posts; kept in the backup', async () => {
  const { lockBackup, unlockBackup } = await import('../src/backup.js');
  const { player, blank, clock } = world();
  const alice = await player('Alice', 12);
  const bob = await player('Bob', 1); // 1 Devikin: one post a day
  const gid = await alice.startGroup('React Club');
  await bob.joinGroup(gid);
  await alice.checkMail();
  await bob.checkMail();
  await alice.postToGroup(gid, 'Who likes Fire Devikins?');
  await bob.checkMail();
  const [post] = await bob.groupPosts(gid);
  await bob.postToGroup(gid, 'Me!'); // his one post for the day
  // …and still reacts, straight after posting, as often as he likes
  assert.equal(await bob.reactToPost(gid, post.pid, '👍'), '👍');
  assert.equal(await bob.reactToPost(gid, post.pid, '❤️'), '❤️'); // switched
  await assert.rejects(bob.reactToPost(gid, post.pid, '🍕'), /Unknown reaction/);
  assert.deepEqual((await bob.groupPosts(gid))[0].reactions, { counts: { '❤️': 1 }, mine: '❤️' });
  clock.t += MINUTE;
  const unreadBefore = (await alice.listGroups()).find((g) => g.id === gid).unread;
  await alice.checkMail();
  const seen = await alice.groupPosts(gid);
  assert.deepEqual(seen.map((p) => p.text), ['Who likes Fire Devikins?', 'Me!']);
  assert.deepEqual(seen[0].reactions, { counts: { '❤️': 1 }, mine: '' }); // Bob's latest counts, once
  await alice.reactToPost(gid, seen[1].pid, '😂');
  await bob.checkMail();
  assert.deepEqual((await bob.groupPosts(gid))[1].reactions, { counts: { '😂': 1 }, mine: '' });
  // The same again takes it back
  assert.equal(await bob.reactToPost(gid, post.pid, '❤️'), '');
  await alice.checkMail();
  assert.deepEqual((await alice.groupPosts(gid))[0].reactions, { counts: {}, mine: '' });
  assert.ok(unreadBefore <= 1);
  // In the backup
  const moved = await blank();
  await moved.restoreBackupData(await unlockBackup(await lockBackup(await alice.backupData(), 'password1', { rounds: 100000 }), 'password1'));
  assert.deepEqual((await moved.groupPosts(gid))[1].reactions, { counts: { '😂': 1 }, mine: '😂' });
});

test('groups travel in the chat backup', async () => {
  const { lockBackup, unlockBackup } = await import('../src/backup.js');
  const { player, blank, clock } = world();
  const alice = await player('Alice', 3);
  const gid = await alice.startGroup('Backup Club');
  await alice.postToGroup(gid, 'kept');
  const moved = await blank();
  await moved.restoreBackupData(await unlockBackup(await lockBackup(await alice.backupData(), 'password1', { rounds: 100000 }), 'password1'));
  await alice.forgetHere();
  assert.deepEqual((await moved.groupPosts(gid)).map((p) => p.text), ['kept']);
  clock.t += 9 * 60 * MINUTE;
  await moved.postToGroup(gid, 'from the new browser');
  assert.equal((await moved.groupPosts(gid)).length, 2);
});

test('groups (review fixes): a fake key is refused, an old post sent again is dropped, limits count per player, a second browser gets the key, the group passes on', async () => {
  const { sealDirect } = await import('../src/direct.js');
  const { sealGroupPost } = await import('../src/group.js');
  const { player, clock } = world();
  const alice = await player('Alice', 3);
  const mallory = await player('Mallory', 10);
  const gid = await alice.startGroup('Safe Group');
  await mallory.joinGroup(gid);
  await alice.checkMail();
  await mallory.checkMail();

  // Bob asks; Mallory (a member) sees his code and sends him a FAKE key first
  const bob = await player('Bob', 50);
  await bob.joinGroup(gid);
  const join = (await mallory.postman.groupJoins(gid)).joins[0];
  const mk = await identityOf(mallory);
  await mallory.postman.drop(join.code, sealDirect({ from: mk, toDevices: join.devices, type: 'group-key', body: { group: gid, epoch: 1, key: 'ee'.repeat(32) } }));
  assert.equal((await bob.checkMail()).joined ?? 0, 0); // refused: doesn't match the group's key check
  await alice.checkMail(); // the real key
  assert.equal((await bob.checkMail()).joined, 1);

  // Mallory copies Alice's post and sends it again later: dropped by every Hub
  clock.t += MINUTE;
  await alice.postToGroup(gid, 'real post');
  await bob.checkMail();
  const copy = (await mallory.postman.groupPosts(gid, 0)).posts.find((p) => p.receivedAt === clock.t);
  clock.t += 10 * MINUTE;
  await mallory.postman.groupPost(copy.envelope);
  await bob.checkMail();
  assert.deepEqual((await bob.groupPosts(gid)).map((p) => p.text), ['real post']);
  // ... and Alice's (the owner's) own next post isn't blocked by it
  assert.equal((await alice.nextGroupPostAt(gid)).allowedAt, clock.t - 10 * MINUTE + 10 * 1000);

  // A second browser of Bob's (same wallet): in the group, but no key → "Get the key"
  const bob2 = await player('Bob', 50, bob);
  let g2 = (await bob2.listGroups()).find((x) => x.id === gid);
  assert.deepEqual([g2.member, g2.needsKey, g2.asking], [false, true, false]);
  await bob2.joinGroup(gid);
  await alice.checkMail();
  await bob2.checkMail();
  g2 = (await bob2.listGroups()).find((x) => x.id === gid);
  assert.deepEqual([g2.member, g2.needsKey], [true, false]);
  // Bob's two browsers share ONE posting allowance (50 Devikins: every ~29 min)
  clock.t += 30 * MINUTE;
  await bob.postToGroup(gid, 'from browser 1');
  await bob2.checkMail();
  await assert.rejects(bob2.postToGroup(gid, 'from browser 2'), /Not yet/);

  // The group passes on when its owner leaves
  await alice.leaveGroup(gid);
  await mallory.checkMail();
  const g = (await mallory.listGroups()).find((x) => x.id === gid);
  assert.deepEqual([g.owner, g.isOwner], ['Mallory', true]);
  await mallory.setPinned(gid, 'New rules');
});

test('groups: the owner may always answer (once a minute); several pinned messages, changed any time', async () => {
  const { player, clock } = world();
  const owner = await player('Owner', 1); // 1 Devikin: a member would have to wait 24 h
  const member = await player('Member', 1);
  const gid = await owner.startGroup('Owner Rules');
  await member.joinGroup(gid);
  await owner.checkMail();
  await member.checkMail();
  for (let i = 1; i <= 3; i += 1) {
    clock.t += MINUTE;
    await owner.postToGroup(gid, `answer ${i}`);
  }
  clock.t += MINUTE;
  await member.postToGroup(gid, 'question');
  clock.t += MINUTE;
  await assert.rejects(member.postToGroup(gid, 'another'), /Not yet/);
  await member.checkMail();
  assert.deepEqual((await member.groupPosts(gid)).map((p) => p.text), ['answer 1', 'answer 2', 'answer 3', 'question']);

  await owner.setPins(gid, ['Rule 1: be nice', 'Rule 2: no spam', 'Trading day: Sundays']);
  await member.checkMail();
  assert.deepEqual((await member.listGroups())[0].pinned.pins, ['Rule 1: be nice', 'Rule 2: no spam', 'Trading day: Sundays']);
  await owner.setPins(gid, ['Rule 1: be nice', 'Trading day: Saturdays']);
  await member.checkMail();
  assert.deepEqual((await member.listGroups())[0].pinned.pins, ['Rule 1: be nice', 'Trading day: Saturdays']);
  await owner.setPins(gid, []);
  await member.checkMail();
  assert.equal((await member.listGroups())[0].pinned, null);
  await assert.rejects(owner.setPins(gid, ['1', '2', '3', '4', '5', '6']), /At most 5/);
});

test('removal votes: threshold from the game account, a paused accused, 48 h, removal, a new key, and letting back in', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const dot = await player('Dot', 3); // below the threshold of 10
  const max = await player('Max', 12); // the accused
  const gid = await owner.startGroup('Vote Club');
  await owner.setPins(gid, ['Be nice']);
  for (const p of [bea, cid, dot, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  assert.equal((await owner.listGroups())[0].members, 5);

  let v = await bea.groupVotes(gid);
  assert.deepEqual([v.threshold, v.canVote, v.canOpen], [10, true, true]);
  assert.equal((await dot.groupVotes(gid)).canVote, false);
  await assert.rejects(bea.openVote(gid, 'Owner', 'bossy', bea.sign), /owner can't be voted out/);
  await assert.rejects(dot.openVote(gid, 'Max', 'spam', dot.sign), /at least 10 Devikins/);
  await bea.openVote(gid, 'Max', 'Spams links all day', bea.sign);
  await assert.rejects(bea.openVote(gid, 'Dot', 'again', bea.sign), /one vote per week/);

  // Everyone in the group sees it, with the reason
  v = await cid.groupVotes(gid);
  assert.deepEqual(v.votes.map((x) => [x.accused, x.opener, x.reason, x.yes, x.no]), [['Max', 'Bea', 'Spams links all day', 1, 0]]);
  assert.equal((await max.groupVotes(gid)).votes[0].aboutMe, true);

  // Max can still post until a second member supports the vote
  clock.t += MINUTE;
  await max.postToGroup(gid, 'I did nothing!');
  await cid.castVote(v.votes[0].id, true, cid.sign);
  await assert.rejects(dot.castVote(v.votes[0].id, true, dot.sign), /at least 10 Devikins/);
  await assert.rejects(max.castVote(v.votes[0].id, false, max.sign), /about yourself/);
  await assert.rejects(cid.castVote(v.votes[0].id, false, cid.sign), /voted already/);
  clock.t += 3 * 60 * MINUTE; // (past Max's own posting limit)
  await assert.rejects(max.postToGroup(gid, 'still here'), /paused while a vote about you is open/);
  await max.checkMail();
  assert.ok((await max.listGroups())[0].pausedUntil > clock.t);
  await owner.castVote(v.votes[0].id, true, owner.sign);

  // 48 h later: decided, Max is out, the owner's Hub makes a new key
  clock.t += 48 * 60 * MINUTE;
  await assert.rejects(cid.castVote(v.votes[0].id, true, cid.sign), /voted already|has ended/);
  await decide();
  await owner.checkMail();
  const decided = (await owner.groupVotes(gid)).votes[0];
  assert.deepEqual([decided.decided, decided.valid, decided.passed, decided.removed], [true, true, true, true]);
  assert.equal((await owner.listGroups())[0].members, 4);
  assert.equal((await bea.checkMail()).newKeys, 1);
  await owner.postToGroup(gid, 'With the new key');
  await bea.checkMail();
  assert.ok((await bea.groupPosts(gid)).some((p) => p.text === 'With the new key'));
  const maxView = (await max.listGroups()).find((g) => g.id === gid);
  assert.deepEqual([maxView.member, maxView.banned], [false, true]);
  await assert.rejects(max.joinGroup(gid), /removed from this group by a vote/);

  // The owner can let him back in
  const banned = (await owner.groupVotes(gid)).banned;
  assert.deepEqual(banned.map((b) => b.nickname), ['Max']);
  await owner.letBackIn(gid, banned[0].id);
  assert.equal(await max.joinGroup(gid), 'asking');
  await max.listGroups({ maxAgeMs: 60 * MINUTE }); // (the screen's cached list)
  await bea.checkMail();
  await max.checkMail();
  // Let in: shown as a member at once, even from the cached list
  assert.equal((await max.listGroups({ maxAgeMs: 60 * MINUTE })).find((g) => g.id === gid).member, true);
  assert.equal((await max.listGroups()).find((g) => g.id === gid).member, true);
  // A newcomer after the new key only gets that key: the owner's Hub sealed
  // the pinned messages again with it, so she can read them (Raphael's test,
  // 24 Oct 2026: they were missing for a new member)
  const eve = await player('Eve', 12);
  assert.equal(await eve.joinGroup(gid), 'asking');
  await owner.checkMail();
  await eve.checkMail();
  await eve.checkMail();
  assert.deepEqual((await eve.listGroups()).find((g) => g.id === gid).pinned?.pins, ['Be nice']);
});

test('removal votes end early once the result can\'t change: removed, kept, or open again when a wallet emptied', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const max = await player('Max', 5);
  const gid = await owner.startGroup('Quick Votes');
  for (const p of [bea, cid, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  // 3 may vote (Max is the accused). Two yes isn't certain yet.
  await bea.openVote(gid, 'Max', 'spam', bea.sign);
  const id = (await bea.groupVotes(gid)).votes[0].id;
  await cid.castVote(id, true, cid.sign);
  await decide();
  assert.equal((await owner.groupVotes(gid)).votes[0].decided, false);
  // All three yes: decided straight away, no 48 h wait
  clock.t += MINUTE;
  await owner.castVote(id, true, owner.sign);
  await decide();
  let d = (await owner.groupVotes(gid)).votes[0];
  assert.deepEqual([d.decided, d.valid, d.passed, d.removed], [true, true, true, true]);
  assert.equal((await owner.listGroups())[0].members, 3);
});

test('removal votes end early: enough "no" keeps the member and lifts the pause; an emptied wallet keeps a vote open', async () => {
  const { player, clock, decide, office } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const dee = await player('Dee', 12);
  const eve = await player('Eve', 12);
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Fair Club');
  for (const p of [bea, cid, dee, eve, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  // 5 may vote. Bea and Cid say yes (Max is paused), Dee, Eve and the owner say no.
  await bea.openVote(gid, 'Max', 'rude', bea.sign);
  const id = (await bea.groupVotes(gid)).votes[0].id;
  await cid.castVote(id, true, cid.sign);
  clock.t += 3 * 60 * MINUTE;
  await assert.rejects(max.postToGroup(gid, 'hello?'), /paused/);
  await dee.castVote(id, false, dee.sign);
  await eve.castVote(id, false, eve.sign);
  await decide();
  assert.equal((await owner.groupVotes(gid)).votes[0].decided, false); // 2 no of 5: yes could still reach 60 %
  await owner.castVote(id, false, owner.sign);
  await decide();
  const d = (await owner.groupVotes(gid)).votes[0];
  assert.deepEqual([d.decided, d.passed], [true, false]);
  clock.t += MINUTE;
  await max.postToGroup(gid, 'Thanks, all'); // not paused any more

  // A second vote in a group of 4 (3 may vote): all yes, but one voter's
  // wallet is empty by the time it's counted - not certain any more, so it
  // stays open, and that wallet is checked again at the end.
  const gid2 = await owner.startGroup('Second Club');
  for (const p of [bea, cid, max]) {
    await p.joinGroup(gid2);
    await owner.checkMail();
    await p.checkMail();
  }
  // (Bea started a vote this week already, so Cid starts this one.)
  await cid.openVote(gid2, 'Max', 'again', cid.sign);
  const id2 = (await owner.groupVotes(gid2)).votes[0].id;
  await bea.castVote(id2, true, bea.sign);
  cid.holdings.set(cid.wallet, 0);
  await owner.castVote(id2, true, owner.sign);
  await decide();
  assert.equal((await owner.groupVotes(gid2)).votes[0].decided, false);
  // ...and isn't counted again and again meanwhile: the alarm waits for its end
  assert.ok(office.nextVoteEnd() > clock.t + 47 * 60 * MINUTE);
  clock.t += 49 * 60 * MINUTE;
  await decide();
  const d2 = (await owner.groupVotes(gid2)).votes[0];
  assert.deepEqual([d2.decided, d2.valid, d2.passed], [true, false, false]); // Cid's vote doesn't count: 2 of 3 needed
});

test('removal votes: the owner may start one whatever they hold; their own "yes" counts only with the threshold', async () => {
  const { player, decide } = world();
  const owner = await player('Owner', 3); // below the threshold of 10
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const dee = await player('Dee', 12);
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Small Owner');
  for (const p of [bea, cid, dee, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  // (a member below the threshold still can't)
  const low = await player('Low', 3);
  await low.joinGroup(gid);
  await owner.checkMail();
  await low.checkMail();
  await assert.rejects(low.openVote(gid, 'Cid', 'z', low.sign), /at least 10 Devikins/);
  // The owner (3 Devikins) starts one about Dee
  await owner.openVote(gid, 'Dee', 'spams', owner.sign);
  const v2 = (await owner.groupVotes(gid)).votes.find((v) => v.accused === 'Dee');
  assert.deepEqual(v2.ballots.map((b) => [b.voter, b.yes, b.counts]), [['Owner', true, false]]);
  await bea.castVote(v2.id, true, bea.sign);
  await cid.castVote(v2.id, true, cid.sign);
  await max.castVote(v2.id, true, max.sign);
  await decide();
  const d = (await owner.groupVotes(gid)).votes.find((v) => v.accused === 'Dee');
  assert.deepEqual([d.decided, d.passed], [true, true]);
  assert.deepEqual(d.ballots.filter((b) => b.counts).map((b) => b.voter).sort(), ['Bea', 'Cid', 'Max']);
});

test('removal votes: too few votes means no removal', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Small Club');
  for (const p of [bea, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  await bea.openVote(gid, 'Max', 'rude', bea.sign);
  await owner.castVote((await owner.groupVotes(gid)).votes[0].id, true, owner.sign);
  clock.t += 49 * 60 * MINUTE;
  await decide();
  const d = (await owner.groupVotes(gid)).votes[0];
  assert.deepEqual([d.decided, d.valid, d.passed], [true, false, false]); // only 2 votes, 3 needed
  assert.equal((await owner.listGroups())[0].members, 3);
});

test('removal votes: moving Devikins to a second wallet doesn\'t give extra votes (wallets are checked again at the end)', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const sly = await player('Sly', 12);
  const sly2 = await player('SlyTwo', 1); // Sly's second wallet, almost empty for now
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Fair Votes');
  for (const p of [bea, cid, sly, sly2, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  await sly.openVote(gid, 'Max', 'I just dislike him', sly.sign);
  const id = (await sly.groupVotes(gid)).votes[0].id;
  await assert.rejects(sly2.castVote(id, true, sly2.sign), /holds 1 right now/);
  // Sly moves his 12 Devikins to the second wallet, which then votes too
  sly.holdings.set(sly.wallet, 0);
  sly.holdings.set(sly2.wallet, 12);
  await sly2.castVote(id, true, sly2.sign);
  await bea.castVote(id, false, bea.sign);
  await cid.castVote(id, false, cid.sign);
  // Someone else's wallet can't be used to vote
  await assert.rejects(owner.castVote(id, true, bea.sign), /wallet you signed in/);
  clock.t += 49 * 60 * MINUTE;
  await decide();
  const d = (await owner.groupVotes(gid)).votes[0];
  // Sly's first vote no longer counts (that wallet is empty now): 1 yes, 2 no
  assert.deepEqual(d.ballots.map((b) => [b.voter, b.yes, b.counts]).sort(), [['Bea', false, true], ['Cid', false, true], ['Sly', true, false], ['SlyTwo', true, true]]);
  assert.deepEqual([d.valid, d.passed], [true, false]);
});

test('removal votes (review fixes): leaving early or starting over doesn\'t dodge the ban; late joiners can\'t vote', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Strict Club');
  for (const p of [bea, cid, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  await bea.openVote(gid, 'Max', 'scams', bea.sign);
  const id = (await bea.groupVotes(gid)).votes[0].id;
  // A friend who joins after the vote started can't vote in it
  clock.t += MINUTE;
  const pal = await player('Pal', 12);
  await pal.joinGroup(gid);
  await owner.checkMail();
  await pal.checkMail();
  await assert.rejects(pal.castVote(id, false, pal.sign), /when the vote started/);
  await cid.castVote(id, true, cid.sign);
  await owner.castVote(id, true, owner.sign);
  // Max leaves the group before the end, and even leaves the chat entirely
  await max.leaveGroup(gid);
  clock.t += 49 * 60 * MINUTE;
  await decide();
  const d = (await owner.groupVotes(gid)).votes[0];
  assert.deepEqual([d.passed, d.removed], [true, false]); // passed; he had left already
  // Signing in again with the same wallet: still banned from this group
  await max.leave();
  const maxAgain = await player('Max', 12, max);
  await maxAgain.setNickname('Max');
  await assert.rejects(maxAgain.joinGroup(gid), /removed from this group by a vote/);
  // The weekly limit on starting votes also stays with the wallet
  const beaAgain = bea;
  await assert.rejects(beaAgain.openVote(gid, 'Pal', 'test', beaAgain.sign), /one vote per week/);
});

test('removal votes: a member who missed the new key gets it again; nobody can be left out of the new key', async () => {
  const { player, clock, decide } = world();
  const owner = await player('Owner', 12);
  const bea = await player('Bea', 12);
  const cid = await player('Cid', 12);
  const max = await player('Max', 12);
  const gid = await owner.startGroup('Key Club');
  for (const p of [bea, cid, max]) {
    await p.joinGroup(gid);
    await owner.checkMail();
    await p.checkMail();
  }
  await bea.openVote(gid, 'Max', 'scams', bea.sign);
  const id = (await bea.groupVotes(gid)).votes[0].id;
  await cid.castVote(id, true, cid.sign);
  await owner.castVote(id, true, owner.sign);
  clock.t += 49 * 60 * MINUTE;
  await decide();
  // A member's Hub can't hand the new key to only some members
  const { sealDirect } = await import('../src/direct.js');
  const ck = await identityOf(cid);
  const onlyMe = sealDirect({ from: ck, toDevices: [cid.identity.publicKey], type: 'group-key', body: { group: gid, epoch: 2, key: 'ab'.repeat(32) } });
  await assert.rejects(cid.postman.rekey({ group: gid, epoch: 2, keyCheck: 'cd'.repeat(32), items: onlyMe }), /every member/);
  await owner.checkMail(); // the owner's Hub makes the new key for everyone
  // Bea's mailbox loses it (e.g. away longer than 30 days)
  const lost = (await bea.postman.mail()).items.map((m) => m.id);
  await bea.postman.mailDone(lost);
  await bea.checkMail(); // she notices the group has a newer key and asks again
  await owner.checkMail(); // a member's Hub hands it over
  await bea.checkMail();
  clock.t += 3 * MINUTE;
  await owner.postToGroup(gid, 'new epoch post');
  await bea.checkMail();
  assert.ok((await bea.groupPosts(gid)).some((p) => p.text === 'new epoch post'));
});
