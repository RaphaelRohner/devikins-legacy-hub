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
  const holdings = new Map();
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
  async function player(nickname, nfts = 3) {
    const { privateKey, publicKey } = generateKeyPairSync();
    const wallet = bech32Encode(publicKey.bytes, 'klv');
    holdings.set(wallet, nfts);
    const db = localDb();
    const m = await createMessenger({ db, postmanUrl: BASE, fetchFn, now: () => clock.t });
    // (for tests that play a modified Hub: the device's raw key and postman)
    m.db = db;
    const { createPostmanClient } = await import('../src/client.js');
    m.postman = createPostmanClient({ baseUrl: BASE, identity: JSON.parse((await db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v), fetchFn, now: () => clock.t });
    const { code, text } = await m.startSignIn();
    const signature = Buffer.from(signMessageSync(prepareKlvMessage(text), privateKey.bytes)).toString('hex');
    assert.equal((await m.finishSignIn({ code, wallet, signature })).state, 'needs-nickname');
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
  return { clock, network, player, blank };
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
