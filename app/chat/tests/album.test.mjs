// Collectors Albums (27 Oct 2026): the album itself (album.js), the postman's
// album routes, and the Hub's side (messenger.js) - with real wallet signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, signMessageSync, prepareKlvMessage } from '@klever/connect-crypto';
import { bech32Encode } from '@klever/connect-encoding';
import {
  createAlbumKey, albumProofText, isAlbumProof, sealAlbum, checkAlbum, cleanAlbum, MAX_ALBUM_ITEMS, publicAlbums, DAY,
} from '../src/index.js';
import { world, BASE } from './world.mjs';

function wallet() {
  const { privateKey, publicKey } = generateKeyPairSync();
  const address = bech32Encode(publicKey.bytes, 'klv');
  return { address, sign: (text) => Buffer.from(signMessageSync(prepareKlvMessage(text), privateKey.bytes)).toString('hex') };
}
const ITEMS = [{ kind: 'devikin', nonce: 123, note: 'May event 2025 Bonded Yoda' }, { kind: 'weapon', nonce: 7 }];

test('an album: signed with its own key, the wallet proves it holds the NFTs', () => {
  const key = createAlbumKey();
  const w = wallet();
  const proof = w.sign(albumProofText(key.publicKey));
  assert.match(albumProofText(key.publicKey), /NOT a transaction/);
  assert.ok(isAlbumProof(key.publicKey, w.address, proof));
  assert.ok(!isAlbumProof(createAlbumKey().publicKey, w.address, proof), 'the proof names one album key');
  assert.ok(!isAlbumProof(key.publicKey, wallet().address, proof), "another wallet's address");

  const event = sealAlbum(key, { title: ' My Yodas ', description: 'Best of', wallet: w.address, proof, items: ITEMS });
  const c = checkAlbum(event);
  assert.equal(c.ok, true, c.problem);
  assert.equal(c.album.key, key.publicKey);
  assert.equal(c.album.title, 'My Yodas');
  assert.equal(c.album.name, null);
  assert.deepEqual(c.album.items, ITEMS);

  // Changed by someone else: the signature breaks.
  const changed = { ...event, content: event.content.replace('My Yodas', 'Your Yodas') };
  assert.equal(checkAlbum(changed).ok, false);
  // Someone copying the proof into an album with another key: the proof doesn't match.
  const copied = sealAlbum(createAlbumKey(), { title: 'Not mine', wallet: w.address, proof, items: ITEMS });
  assert.deepEqual(checkAlbum(copied), { ok: false, problem: "the wallet's proof doesn't match" });
});

test('an album is refused: no title, too many NFTs, an NFT twice, a long note', () => {
  const base = { title: 'A', wallet: wallet().address, proof: 'x', items: ITEMS };
  assert.throws(() => cleanAlbum({ ...base, title: '  ' }), /needs a title/);
  assert.throws(() => cleanAlbum({ ...base, items: [] }), /at least one/);
  assert.throws(() => cleanAlbum({ ...base, items: Array.from({ length: MAX_ALBUM_ITEMS + 1 }, (_, i) => ({ kind: 'devikin', nonce: i + 1 })) }), /at most/);
  assert.throws(() => cleanAlbum({ ...base, items: [ITEMS[0], ITEMS[0]] }), /twice/);
  assert.throws(() => cleanAlbum({ ...base, items: [{ kind: 'devikin', nonce: 1, note: 'x'.repeat(201) }] }), /note/);
  assert.throws(() => cleanAlbum({ ...base, items: [{ kind: 'pet', nonce: 1 }] }), /damaged/);
  assert.throws(() => cleanAlbum({ ...base, wallet: 'klv1nope' }), /Klever address/);
});

/** A player with an album wallet (another wallet than the chat sign-in, like a showcase wallet). */
async function playerWithAlbum(w, nickname = 'Alice') {
  const p = await w.player(nickname, 3);
  const showcase = wallet();
  const { key, proofText } = await p.newAlbum();
  const proof = showcase.sign(proofText);
  return { p, showcase, key, proof };
}
const reader = (w) => publicAlbums({ baseUrl: BASE, fetchFn: async (url) => {
  const r = await w.office.handle({ method: 'GET', url, bodyText: '', authorization: null });
  return Response.json(r.body, { status: r.status });
} });

test('publishing: everyone can read it, without signing in; not linked to the player unless they choose', async () => {
  const w = world();
  const { p, showcase, key, proof } = await playerWithAlbum(w);
  const album = await p.publishAlbum(key, { title: 'Yodas', description: 'Mine', wallet: showcase.address, proof, items: ITEMS });
  assert.equal(album.name, null);

  const r = reader(w);
  const { albums } = await r.list();
  assert.deepEqual(albums.map((a) => [a.key, a.title, a.name, a.count]), [[key, 'Yodas', null, 2]]);
  const one = await r.one(key);
  assert.equal(one.wallet, showcase.address);
  assert.deepEqual(one.items, ITEMS);
  // What the postman has: the album, under its key - nothing about the account or device.
  const stored = JSON.stringify(await r.one(key));
  assert.ok(!stored.includes(p.identity.publicKey));
  assert.ok(!stored.includes(p.wallet));

  // With my nickname on it (my own only).
  w.clock.t += 60 * 1000;
  const named = await p.publishAlbum(key, { title: 'Yodas', wallet: showcase.address, proof, items: ITEMS, showName: true });
  assert.equal(named.name, 'Alice');
  assert.equal((await r.list()).albums[0].name, 'Alice');
  const other = await w.player('Bob', 3);
  const k2 = createAlbumKey();
  const ev = sealAlbum(k2, { title: 'Fake', name: 'Alice', wallet: showcase.address, proof: showcase.sign(albumProofText(k2.publicKey)), items: ITEMS });
  await assert.rejects(other.postman.publishAlbum(ev), /your own chat nickname/);
});

test('publishing is refused: not signed in, a wrong proof, an older version', async () => {
  const w = world();
  const { p, showcase, key, proof } = await playerWithAlbum(w);
  await assert.rejects(p.publishAlbum(key, { title: 'Y', wallet: wallet().address, proof, items: ITEMS }), /doesn't match this wallet/);

  const blank = await w.blank();
  const k = createAlbumKey();
  const ev = sealAlbum(k, { title: 'Spam', wallet: showcase.address, proof: showcase.sign(albumProofText(k.publicKey)), items: ITEMS });
  const { createPostmanClient } = await import('../src/client.js');
  const anon = createPostmanClient({ baseUrl: BASE, identity: createAlbumKey(), fetchFn: async (url, init) => {
    const r = await w.office.handle({ method: init.method, url, bodyText: init.body || '', authorization: init.headers?.Authorization ?? null });
    return Response.json(r.body, { status: r.status });
  }, now: () => w.clock.t });
  await assert.rejects(anon.publishAlbum(ev), /sign in/);
  assert.ok(blank);

  await p.publishAlbum(key, { title: 'New', wallet: showcase.address, proof, items: ITEMS });
  const older = sealAlbum({ publicKey: key, secretKey: (await p.db.getAllAsync('SELECT secret FROM chat_albums'))[0].secret },
    { title: 'Old', wallet: showcase.address, proof, items: ITEMS }, w.clock.t - 60 * 1000);
  await assert.rejects(p.postman.publishAlbum(older), /newer version/);
});

test('deleting: only with the album key; my other devices get the album and can delete it', async () => {
  const w = world();
  const { p, showcase, key, proof } = await playerWithAlbum(w);
  await p.publishAlbum(key, { title: 'Yodas', wallet: showcase.address, proof, items: ITEMS });

  // Someone else asking the postman to delete it (signed with their own key): nothing happens.
  const bob = await w.player('Bob', 3);
  await bob.postman.deleteAlbum();
  assert.equal((await reader(w).list()).albums.length, 1);

  // My second device (same wallet) gets my albums with the history copy.
  const phone = await w.player('Alice', 0, p, 'Phone');
  await p.checkMail();
  await p.copyHistoryTo((await p.linkedDevices()).others[0].key);
  await phone.checkMail();
  const mine = await phone.myAlbums();
  assert.deepEqual(mine.map((a) => [a.key, a.album?.title]), [[key, 'Yodas']]);

  // ... and a change made there reaches the first device.
  w.clock.t += 60 * 1000;
  await phone.publishAlbum(key, { title: 'Yodas 2', wallet: showcase.address, proof, items: ITEMS });
  await p.checkMail();
  assert.equal((await p.myAlbums())[0].album.title, 'Yodas 2');

  await phone.deleteAlbum(key);
  assert.equal((await reader(w).list()).albums.length, 0);
  await assert.rejects(reader(w).one(key), /no longer exists/);
  await p.checkMail();
  assert.equal((await p.myAlbums()).length, 0);
});

test('albums are refreshed weekly, and forgotten 60 days after the last refresh', async () => {
  const w = world();
  const { p, showcase, key, proof } = await playerWithAlbum(w);
  await p.publishAlbum(key, { title: 'Yodas', wallet: showcase.address, proof, items: ITEMS });
  const first = (await reader(w).list()).albums[0].updated;
  w.clock.t += 8 * DAY;
  await p.setHoldings(3); // (signed in again: the weekly wallet check)
  await p.checkMail();
  assert.ok((await reader(w).list()).albums[0].updated > first, 'refreshed');

  // A player who stops using the Hub: the album goes after 60 days.
  w.clock.t += 61 * DAY;
  w.office.cleanUp();
  assert.equal((await reader(w).list()).albums.length, 0);
});

test('leaving the chat on my last device takes my albums down', async () => {
  const w = world();
  const { p, showcase, key, proof } = await playerWithAlbum(w);
  await p.publishAlbum(key, { title: 'Yodas', wallet: showcase.address, proof, items: ITEMS });
  await p.leave();
  assert.equal((await reader(w).list()).albums.length, 0);
});
