// Linked devices (27 Oct 2026): the same player on the website and a phone.
// Signing in with the same wallet makes a device part of the account; the
// devices keep each other up to date, and a new one gets the history once
// the player says yes on an existing one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, SYNC_PART_CHARS } from '../src/messenger.js';
import { sealDirect, MAX_ENVELOPE_CHARS } from '../src/direct.js';
import { createIdentity } from '../src/identity.js';
import { world } from './world.mjs';
import { MINUTE } from '../src/rules.js';

/** Alice (website) and Bob, already chatting. */
async function chatting(w) {
  const alice = await w.player('Alice', 3, null, 'Website');
  const bob = await w.player('Bob');
  const id = await alice.requestContact('Bob');
  await bob.checkMail();
  await bob.acceptContact((await bob.listContacts())[0].id);
  await alice.checkMail();
  await alice.sendMessage(id, 'Hi Bob');
  await bob.checkMail();
  await bob.sendMessage((await bob.listContacts())[0].id, 'Hi Alice');
  await alice.checkMail();
  return { alice, bob };
}

const texts = async (m, nickname) => {
  const c = (await m.listContacts()).find((x) => x.nickname === nickname);
  return c ? (await m.messages(c.id)).map((x) => [x.mine, x.text]) : null;
};

test('a new device is offered the history; after "yes" it has the contacts and messages', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const phone = await w.player('Alice', 3, alice, 'Android app');
  assert.equal((await phone.status()).state, 'ready'); // same account: nickname known

  // The website notices the new device and offers to copy the history.
  w.clock.t += 2 * MINUTE;
  const seen = await alice.linkedDevices();
  assert.equal(seen.others.length, 1);
  assert.equal(seen.others[0].key, phone.identity.publicKey);
  assert.equal(seen.others[0].isNew, true);
  // The phone (nothing to copy) just knows the website, by its kind.
  await phone.checkMail();
  assert.equal((await phone.linkedDevices()).others[0].label, 'Website');
  assert.equal((await phone.linkedDevices()).others[0].isNew, false);
  assert.equal(await texts(phone, 'Bob'), null); // nothing yet: no history without a yes

  const { parts } = await alice.copyHistoryTo(phone.identity.publicKey);
  assert.ok(parts >= 1);
  assert.equal((await alice.linkedDevices()).others[0].isNew, false);
  const got = await phone.checkMail();
  assert.equal(got.history, 1);
  assert.deepEqual(await texts(phone, 'Bob'), [[true, 'Hi Bob'], [false, 'Hi Alice']]);
  assert.equal((await phone.listContacts())[0].status, STATUS.ACCEPTED);
  // (the phone's hello says what kind of device it is)
  await alice.checkMail();
  assert.equal((await alice.linkedDevices()).others[0].label, 'Android app');
});

test('after linking: messages reach both devices, and what I write on one shows on the other', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();

  // Bob's Hub still knows only the website: it refreshes Alice's devices before sending.
  await bob.sendMessage((await bob.listContacts())[0].id, 'Both of you?');
  await alice.checkMail();
  await phone.checkMail();
  assert.deepEqual((await texts(alice, 'Bob')).at(-1), [false, 'Both of you?']);
  assert.deepEqual((await texts(phone, 'Bob')).at(-1), [false, 'Both of you?']);

  // Alice writes from the phone: Bob gets it (a device he didn't know: he
  // checks with the postman), and the website shows it as hers.
  await phone.sendMessage((await phone.listContacts())[0].id, 'Yes, from my phone');
  assert.equal((await bob.checkMail()).messages, 1);
  assert.deepEqual((await texts(bob, 'Alice')).at(-1), [false, 'Yes, from my phone']);
  await alice.checkMail();
  assert.deepEqual((await texts(alice, 'Bob')).at(-1), [true, 'Yes, from my phone']);
  // No double copies anywhere.
  assert.equal((await texts(alice, 'Bob')).filter(([, t]) => t === 'Yes, from my phone').length, 1);
});

test('contact changes on one device reach the other (block, unblock, new contact)', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const carol = await w.player('Carol');
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();

  await phone.blockContact((await phone.listContacts()).find((c) => c.nickname === 'Bob').id);
  await alice.checkMail();
  assert.equal((await alice.listContacts()).find((c) => c.nickname === 'Bob').status, STATUS.BLOCKED);

  await alice.unblockContact((await alice.listContacts()).find((c) => c.nickname === 'Bob').id);
  await phone.checkMail();
  assert.equal((await phone.listContacts()).find((c) => c.nickname === 'Bob').status, STATUS.ACCEPTED);

  w.clock.t += 30 * MINUTE; // (the pause between contact requests)
  // A request from the website: Carol's answer reaches the phone too, and the phone can write.
  await alice.requestContact('Carol');
  await phone.checkMail();
  assert.equal((await phone.listContacts()).find((c) => c.nickname === 'Carol').status, STATUS.OUTGOING);
  await carol.checkMail();
  await carol.acceptContact((await carol.listContacts())[0].id);
  await alice.checkMail();
  await phone.checkMail();
  const onPhone = (await phone.listContacts()).find((c) => c.nickname === 'Carol');
  assert.equal(onPhone.status, STATUS.ACCEPTED);
  await phone.sendMessage(onPhone.id, 'Hello Carol');
  await carol.checkMail();
  assert.deepEqual(await texts(carol, 'Alice'), [[false, 'Hello Carol']]);
});

test('groups: the new device gets them with their keys; my posts from either device count as mine', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const gid = await alice.startGroup('Breeders', 'Talk shop');
  await alice.postToGroup(gid, 'Welcome');
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();
  const g = (await phone.listGroups()).find((x) => x.id === gid);
  assert.equal(g.member, true);
  assert.deepEqual((await phone.groupPosts(gid)).map((p) => [p.mine, p.text]), [[true, 'Welcome']]);

  w.clock.t += 2 * MINUTE;
  await phone.postToGroup(gid, 'From the phone');
  await alice.checkMail();
  const onWeb = (await alice.groupPosts(gid)).map((p) => [p.mine, p.text]);
  assert.deepEqual(onWeb.at(-1), [true, 'From the phone']);
});

test('"not mine": a device can be taken out of the account from another one', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const stranger = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  assert.equal((await alice.linkedDevices()).others.length, 1);
  await alice.removeDevice(stranger.identity.publicKey);
  assert.equal((await alice.linkedDevices()).others.length, 0);
  // The removed device is signed out at the postman.
  assert.equal((await stranger.postman.me()).signedIn, false);
});

test('only my own devices can send me sync envelopes', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  // Bob's Hub can't use the postman's "own devices" door to reach Alice.
  const items = sealDirect({ from: { publicKey: bob.identity.publicKey, secretKey: JSON.parse((await bob.db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v).secretKey },
    toDevices: [alice.identity.publicKey], type: 'sync', body: { t: 'contact', c: { nickname: 'Bob', status: STATUS.BLOCKED, devices: '[]' } } });
  await assert.rejects(() => bob.postman.self(items), /other devices/);
  // And a sync envelope dropped in through a contact's code is ignored.
  const aliceAtBob = (await bob.listContacts())[0];
  await bob.postman.drop(aliceAtBob.theirCode, items);
  await alice.checkMail();
  assert.equal((await alice.listContacts())[0].status, STATUS.ACCEPTED);
});

test('a long history goes in parts that each fit in one envelope', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const c = (await alice.listContacts())[0];
  // Worst case for the size: quotes and emoji (both grow when sealed).
  const long = '"❤️🐉"'.repeat(150);
  for (let i = 0; i < 40; i += 1) {
    w.clock.t += 2000;
    await alice.sendMessage(c.id, `${i} ${long}`);
  }
  // One part, as big as it gets, sealed: still under the envelope limit.
  const part = JSON.stringify({ t: 'history', transfer: 'x'.repeat(16), part: 0, total: 99, data: JSON.stringify('"❤️🐉"'.repeat(SYNC_PART_CHARS)).slice(0, SYNC_PART_CHARS) });
  const [{ envelope }] = sealDirect({ from: createIdentity(), toDevices: [createIdentity().publicKey], type: 'sync', body: JSON.parse(part) });
  assert.ok(JSON.stringify(envelope).length < MAX_ENVELOPE_CHARS, `envelope ${JSON.stringify(envelope).length}`);

  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  const { parts } = await alice.copyHistoryTo(phone.identity.publicKey);
  assert.ok(parts > 3, `parts ${parts}`);
  // (the phone may need more than one mail check: 100 envelopes per collection)
  for (let i = 0; i < 5; i += 1) await phone.checkMail();
  assert.equal((await texts(phone, 'Bob')).length, 42);
  assert.equal((await phone.linkedDevices()).copying, null);
});

test('two devices that both have a history (linked before this update): each copies to the other, nothing is lost', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const carol = await w.player('Carol');
  const phone = await w.player('Alice', 3, alice, 'Android app');
  // The phone starts a chat of its own before the devices know each other.
  w.clock.t += 30 * MINUTE;
  await phone.requestContact('Carol');
  await carol.checkMail();
  await carol.acceptContact((await carol.listContacts())[0].id);
  await phone.checkMail();
  await phone.sendMessage((await phone.listContacts()).find((c) => c.nickname === 'Carol').id, 'Phone-only chat');
  // (sync envelopes only go to devices this device already knows about)
  w.clock.t += 2 * MINUTE;
  assert.equal((await alice.linkedDevices()).others[0].isNew, true);
  assert.equal((await phone.linkedDevices()).others[0].isNew, true);
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.copyHistoryTo(alice.identity.publicKey);
  await alice.checkMail();
  await phone.checkMail();
  for (const m of [alice, phone]) {
    assert.deepEqual((await m.listContacts()).map((c) => c.nickname).sort(), ['Bob', 'Carol']);
    assert.deepEqual(await texts(m, 'Bob'), [[true, 'Hi Bob'], [false, 'Hi Alice']]);
    assert.deepEqual(await texts(m, 'Carol'), [[true, 'Phone-only chat']]);
  }
});

test('group posts written on another device before the devices knew each other count as mine', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const gid = await alice.startGroup('Breeders', '');
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await phone.checkMail();
  await phone.joinGroup(gid).catch(() => {});
  await alice.checkMail();
  await phone.checkMail();
  w.clock.t += 2 * MINUTE;
  await phone.postToGroup(gid, 'Written on the phone');
  // The website files it while it doesn't know the phone yet (as an older Hub would have) ...
  await alice.db.runAsync('DELETE FROM chat_devices');
  await alice.checkMail();
  await alice.db.runAsync("UPDATE chat_group_posts SET mine = 0 WHERE text = 'Written on the phone'");
  // ... and puts it right once it knows the phone is one of hers.
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  assert.deepEqual((await alice.groupPosts(gid)).map((p) => [p.mine, p.text]).at(-1), [true, 'Written on the phone']);
});

// --- linking by QR code (27 Oct 2026) ---

test('QR code: a device without a wallet joins with a one-time code, then gets the history after a yes', async () => {
  const w = world();
  const { alice, bob } = await chatting(w);
  const link = await alice.startLink();
  assert.match(link.qr, /^devi-link:[0-9a-f]{20}$/);
  assert.match(link.shown, /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);

  const phone = await w.blank();
  const s = await phone.finishLink(link.qr);
  assert.equal(s.state, 'ready');
  assert.equal(s.nickname, 'Alice');
  assert.equal(s.linked, true);
  assert.equal(s.nfts, 2); // (the band 2–4 of the linking device's badge)
  // One use only.
  const other = await w.blank();
  await assert.rejects(() => other.finishLink(link.shown), /expired or was already used/);

  w.clock.t += 2 * MINUTE;
  const seen = await alice.linkedDevices();
  assert.equal(seen.others.length, 1);
  assert.equal(seen.others[0].isNew, true);
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();
  assert.deepEqual(await texts(phone, 'Bob'), [[true, 'Hi Bob'], [false, 'Hi Alice']]);
  // The linked phone can write, and its group posts carry a valid badge.
  await phone.sendMessage((await phone.listContacts())[0].id, 'Linked by QR');
  await bob.checkMail();
  assert.deepEqual((await texts(bob, 'Alice')).at(-1), [false, 'Linked by QR']);
  const gid = await alice.startGroup('Breeders', '');
  await bob.joinGroup(gid);
  await alice.checkMail(); // (lets Bob in)
  await bob.checkMail();
  await phone.checkMail();
  w.clock.t += 2 * MINUTE;
  await phone.postToGroup(gid, 'Phone post');
  await bob.checkMail();
  assert.deepEqual((await bob.groupPosts(gid)).map((p) => p.text), ['Phone post']);
});

test('QR code: expired after 5 minutes; only signed-in players can make one', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const link = await alice.startLink();
  w.clock.t += 6 * MINUTE;
  const phone = await w.blank();
  await assert.rejects(() => phone.finishLink(link.code), /expired/);
  await assert.rejects(() => phone.finishLink('not a code'), /isn't a link code/);
  await assert.rejects(() => phone.startLink(), /sign in/i);
});

test('a linked device stays signed in: the weekly wallet sign-in on another device renews it too', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const phone = await w.blank();
  await phone.finishLink((await alice.startLink()).code);
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await phone.checkMail();
  const before = (await phone.status()).verifiedUntil;
  // Six days later: the website signs in again with the wallet ...
  w.clock.t += 6 * 24 * 60 * MINUTE;
  await alice.setHoldings(5);
  // ... and the phone gets the fresh badge (and the new count) with its next mail check.
  await phone.checkMail();
  const after = await phone.status();
  assert.ok(after.verifiedUntil > before);
  assert.equal(after.nfts, 5);
  w.clock.t += 2 * 24 * 60 * MINUTE; // past the first week
  assert.equal((await phone.status()).state, 'ready');
});

test('answering "new device" on one device answers it on all of them; each device shows the day it was last active (28 Oct 2026)', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const phone = await w.player('Alice', 3, alice, 'Android app');
  w.clock.t += 2 * MINUTE;
  await alice.linkedDevices();
  await alice.copyHistoryTo(phone.identity.publicKey);
  await phone.checkMail();
  // A third device: both the website and the phone (which has the history now) ask about it.
  const laptop = await w.player('Alice', 3, alice, 'Laptop');
  w.clock.t += 2 * MINUTE;
  assert.equal((await alice.linkedDevices()).others.find((d) => d.key === laptop.identity.publicKey).isNew, true);
  assert.equal((await phone.linkedDevices()).others.find((d) => d.key === laptop.identity.publicKey).isNew, true);
  // "Not now" on the website: the phone stops asking too.
  await alice.dismissNewDevice(laptop.identity.publicKey);
  await phone.checkMail();
  assert.equal((await phone.linkedDevices()).others.find((d) => d.key === laptop.identity.publicKey).isNew, false);

  // Last active: the day each device last talked to the postman.
  const day = (t) => Math.floor(t / (24 * 60 * MINUTE)) * 24 * 60 * MINUTE;
  const today = day(w.clock.t);
  w.clock.t += 3 * 24 * 60 * MINUTE;
  await alice.checkMail();
  w.clock.t += 2 * MINUTE;
  const list = (await alice.linkedDevices()).others;
  assert.equal(list.find((d) => d.key === phone.identity.publicKey).seen, today);
  assert.equal(list.find((d) => d.key === laptop.identity.publicKey).seen, today);
});

test('a device nobody has used for 60 days is taken out of the account (an old phone, a reinstalled app)', async () => {
  const w = world();
  const { alice } = await chatting(w);
  const oldPhone = await w.player('Alice', 3, alice, 'Old phone');
  w.clock.t += 2 * MINUTE;
  assert.equal((await alice.linkedDevices()).others.length, 1);
  // Alice keeps using the website (it checks mail); the old phone is never opened again.
  for (let i = 0; i < 61; i += 1) {
    w.clock.t += 24 * 60 * MINUTE;
    await alice.checkMail();
    if (i % 7 === 0) await alice.setHoldings(3); // (the weekly wallet check)
    w.office.cleanUp();
  }
  w.clock.t += 2 * MINUTE;
  assert.equal((await alice.linkedDevices()).others.length, 0);
  assert.equal((await alice.status()).state, 'ready');
  // The old phone, opened again, simply has to sign in again.
  assert.equal((await oldPhone.postman.me()).signedIn, false);
});
