/*
 * direct.test.mjs — 1:1 messages: sealing, opening, and what must fail.
 * Run: npm run test:chat (from the app folder).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, sealDirect, openDirect, createFakePostman } from '../src/index.js';
import { wrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';

const alice = createIdentity();
const bobWeb = createIdentity();
const bobPhone = createIdentity();
const eve = createIdentity();

test('a text reaches every device of the receiver, and a copy goes to the sender\'s other devices', () => {
  const aliceOther = createIdentity();
  const out = sealDirect({ from: alice, toDevices: [bobWeb.publicKey, bobPhone.publicKey], ownDevices: [aliceOther.publicKey], body: 'Hi Bob! Selling #4821' });
  assert.equal(out.length, 3);
  for (const [who, id] of [[bobWeb.publicKey, bobWeb], [bobPhone.publicKey, bobPhone], [aliceOther.publicKey, aliceOther]]) {
    const env = out.find((o) => o.to === who).envelope;
    const msg = openDirect(env, id);
    assert.equal(msg.from, alice.publicKey);
    assert.equal(msg.type, 'text');
    assert.equal(msg.text, 'Hi Bob! Selling #4821');
  }
});

test('the postman only sees a sealed envelope: no sender, no text', () => {
  const [{ envelope }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: 'secret plans' });
  const seen = JSON.stringify(envelope);
  assert.ok(!seen.includes(alice.publicKey), 'sender visible');
  assert.ok(!seen.includes('secret plans'), 'text visible');
  assert.notEqual(envelope.pubkey, alice.publicKey); // signed by a throwaway key
  assert.deepEqual(envelope.tags, [['p', bobWeb.publicKey]]);
  // two envelopes of the same message don't look alike
  const [{ envelope: again }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: 'secret plans' });
  assert.notEqual(again.content, envelope.content);
  assert.notEqual(again.pubkey, envelope.pubkey);
});

test('only the receiver can open it; changed envelopes are refused', () => {
  const [{ envelope }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: 'hello' });
  assert.throws(() => openDirect(envelope, eve));
  const changed = { ...envelope, content: envelope.content.slice(0, -4) + 'AAAA' };
  assert.throws(() => openDirect(changed, bobWeb));
});

test('nobody can pretend to be someone else', () => {
  // Eve builds a message claiming to be from Alice, sealed with Eve's own key:
  // nostr-tools sees that the sender inside doesn't match the seal's signer.
  const forged = wrapEvent({ kind: 14, content: 'I am Alice', tags: [['devi', 'text']], pubkey: alice.publicKey }, hexToBytes(eve.secretKey), bobWeb.publicKey);
  const msg = (() => { try { return openDirect(forged, bobWeb); } catch { return null; } })();
  assert.ok(msg === null || msg.from === eve.publicKey, 'forged sender accepted');
});

test('text only: control characters and hidden direction marks are removed; long texts cut', () => {
  const [{ envelope }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: '  Hi‮evil​\u0007 there\r\nline 2  ' });
  assert.equal(openDirect(envelope, bobWeb).text, 'Hievil there\nline 2');
  const [{ envelope: long }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: 'x'.repeat(5000) });
  assert.equal(openDirect(long, bobWeb).text.length, 2000);
  assert.throws(() => sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: ' ​ ' }), /Nothing to send/);
});

test('control messages (e.g. accepting a contact request) carry data, not text', () => {
  const [{ envelope }] = sealDirect({ from: alice, toDevices: [bobWeb.publicKey], type: 'contact-accept', body: { nickname: 'Alice' } });
  const msg = openDirect(envelope, bobWeb);
  assert.equal(msg.type, 'contact-accept');
  assert.deepEqual(msg.data, { nickname: 'Alice' });
  assert.throws(() => sealDirect({ from: alice, toDevices: [bobWeb.publicKey], type: 'Bad Type!', body: {} }));
});

test('bad input is refused before any work', () => {
  assert.throws(() => sealDirect({ from: alice, toDevices: ['not-a-key'], body: 'x' }));
  assert.throws(() => sealDirect({ from: alice, toDevices: [], body: 'x' }));
  assert.throws(() => openDirect({ kind: 1059, content: 'x'.repeat(70000), tags: [] }, bobWeb), /Not a chat envelope/);
  assert.throws(() => sealDirect({ from: { secretKey: '00', publicKey: 'x' }, toDevices: [bobWeb.publicKey], body: 'x' }), /damaged/);
});

test('through the fake postman: delivered once, then gone', () => {
  const postman = createFakePostman();
  for (const { to, envelope } of sealDirect({ from: alice, toDevices: [bobWeb.publicKey], body: 'one' })) postman.drop(to, envelope);
  const got = postman.collect(bobWeb.publicKey).map((e) => openDirect(e, bobWeb).text);
  assert.deepEqual(got, ['one']);
  assert.deepEqual(postman.collect(bobWeb.publicKey), []);
  assert.equal(postman.storedCount(), 0);
});
