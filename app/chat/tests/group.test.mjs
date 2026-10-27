/*
 * group.test.mjs — group posts, keys, badges and posting limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdentity, createGroup, nextEpoch, groupKeyMessage, readGroupKeyMessage, sealGroupPost, openGroupPost,
  acceptPosts, issueBadge, checkBadge, sealDirect, openDirect, createFakePostman, HOUR, DAY, MINUTE,
} from '../src/index.js';

const postman = createIdentity();
const alice = createIdentity();
const bob = createIdentity();
const eve = createIdentity();
const T0 = 1_800_000_000_000;

test('a badge proves "verified holder of N NFTs" for one chat key, without a wallet', () => {
  const badge = issueBadge(postman, { holder: alice.publicKey, nfts: 3, now: T0 });
  assert.ok(!JSON.stringify(badge).includes('klv1'), 'wallet in badge');
  assert.deepEqual(checkBadge(badge, { postmanPublicKey: postman.publicKey, holder: alice.publicKey, at: T0 + HOUR }), { ok: true, nfts: 2, until: T0 + 7 * DAY - (T0 % 1000), account: null });
  // Only the band, never the exact count: 3 → 2 (2–4), 37 → 25 (25–49), 1066 → 50 (50+).
  for (const [n, band] of [[1, 1], [3, 2], [9, 5], [10, 10], [37, 25], [1066, 50]]) {
    assert.equal(checkBadge(issueBadge(postman, { holder: alice.publicKey, nfts: n, now: T0 }), { postmanPublicKey: postman.publicKey, holder: alice.publicKey, at: T0 }).nfts, band);
  }
  assert.equal(checkBadge(badge, { postmanPublicKey: postman.publicKey, holder: bob.publicKey, at: T0 }).problem, 'badge of someone else');
  assert.equal(checkBadge(badge, { postmanPublicKey: postman.publicKey, holder: alice.publicKey, at: T0 + 8 * DAY }).problem, 'expired');
  assert.equal(checkBadge(badge, { postmanPublicKey: eve.publicKey, holder: alice.publicKey, at: T0 }).problem, 'not from the postman');
  const raised = { ...badge, tags: badge.tags.map((t) => (t[0] === 'nfts' ? ['nfts', '500'] : t)) };
  assert.equal(checkBadge(raised, { postmanPublicKey: postman.publicKey, holder: alice.publicKey, at: T0 }).problem, 'signature broken');
  const selfMade = issueBadge(eve, { holder: eve.publicKey, nfts: 999, now: T0 });
  assert.equal(checkBadge(selfMade, { postmanPublicKey: postman.publicKey, holder: eve.publicKey, at: T0 }).ok, false);
});

test('one sealed copy per post; members read it, outsiders and the postman can\'t', () => {
  const group = createGroup();
  const keys = { [group.epoch]: group.key };
  const box = createFakePostman({ clock: () => T0 });
  const badge = issueBadge(postman, { holder: alice.publicKey, nfts: 1, now: T0 });
  box.post(group.id, sealGroupPost({ group, from: alice, text: 'Selling Devikin #4821', badge, now: T0 }));
  assert.equal(box.storedCount(), 1); // once per group, not once per member
  const [{ envelope }] = box.fetchGroup(group.id);
  assert.ok(!JSON.stringify(envelope).includes('Selling') && !JSON.stringify(envelope).includes(alice.publicKey));
  const post = openGroupPost(envelope, { groupId: group.id, keys });
  assert.equal(post.from, alice.publicKey);
  assert.equal(post.text, 'Selling Devikin #4821');
  assert.throws(() => openGroupPost(envelope, { groupId: group.id, keys: { 1: createGroup().key } }));
});

test('new keys when someone joins: the newcomer can\'t read older posts; removed members can\'t read newer ones', () => {
  const g1 = createGroup();
  const badge = issueBadge(postman, { holder: alice.publicKey, nfts: 50, now: T0 });
  const before = sealGroupPost({ group: g1, from: alice, text: 'before Bob joined', badge, now: T0 });
  const g2 = nextEpoch(g1); // Bob joins
  // the new key travels to Bob over 1:1
  const [{ envelope }] = sealDirect({ from: alice, toDevices: [bob.publicKey], type: 'group-key', body: groupKeyMessage(g2) });
  const k = readGroupKeyMessage(openDirect(envelope, bob).data);
  const bobKeys = { [k.epoch]: k.key };
  const after = sealGroupPost({ group: g2, from: alice, text: 'welcome Bob', badge, now: T0 + HOUR });
  assert.equal(openGroupPost(before, { groupId: g1.id, keys: bobKeys }), null);
  assert.equal(openGroupPost(after, { groupId: g1.id, keys: bobKeys }).text, 'welcome Bob');
  // Bob is removed: new key without him
  const g3 = nextEpoch(g2);
  const later = sealGroupPost({ group: g3, from: alice, text: 'after Bob left', badge, now: T0 + 2 * HOUR });
  assert.equal(openGroupPost(later, { groupId: g1.id, keys: bobKeys }), null);
  assert.throws(() => readGroupKeyMessage({ group: 'x', epoch: 1, key: 'y' }));
});

test('posting limits by holdings are applied by every member\'s Hub, using the postman\'s time', () => {
  const group = createGroup();
  const keys = { 1: group.key };
  const one = issueBadge(postman, { holder: alice.publicKey, nfts: 1, now: T0 });
  const three = issueBadge(postman, { holder: bob.publicKey, nfts: 3, now: T0 }); // 3 Devikins = band 2–4 → 2 posts a day
  const item = (from, badge, at, text = 'hi') => ({ post: openGroupPost(sealGroupPost({ group, from, text, badge, now: at }), { groupId: group.id, keys }), receivedAt: at });
  const items = [
    item(alice, one, T0, 'For sale: #4821'),
    item(alice, one, T0 + HOUR, 'spam'), // too early: 1 NFT = one post a day
    item(alice, one, T0 + DAY, 'still for sale'),
    item(bob, three, T0, 'b1'),
    item(bob, three, T0 + 5 * 1000, 'too quick'), // under 10 seconds: too early
    item(bob, three, T0 + 10 * 1000, 'b2'),
    item(bob, three, T0 + 20 * 1000, 'b3'), // ...but 2 a day are used up
    item(bob, three, T0 + 30 * 1000, 'b4'),
    item(bob, three, T0 + DAY + 1, 'b5'), // the first one is 24 h old: one more
  ];
  const lastAccepted = {};
  const { shown, dropped } = acceptPosts(items, { postmanPublicKey: postman.publicKey, lastAccepted });
  assert.deepEqual(shown.map((s) => s.post.text), ['For sale: #4821', 'b1', 'b2', 'still for sale', 'b5']);
  assert.deepEqual(dropped.map((d) => d.post?.text ?? d.item.post.text), ['too quick', 'b3', 'b4', 'spam']);
  assert.ok(dropped.every((d) => d.reason === 'too early'));
  // a post without a genuine badge is dropped; so is one from a paused author
  const fake = issueBadge(eve, { holder: eve.publicKey, nfts: 99, now: T0 });
  const r = acceptPosts([item(eve, fake, T0)], { postmanPublicKey: postman.publicKey });
  assert.equal(r.dropped[0].reason, 'badge not from the postman');
  const p = acceptPosts([item(alice, one, T0 + 3 * DAY)], { postmanPublicKey: postman.publicKey, paused: [alice.publicKey] });
  assert.equal(p.dropped[0].reason, 'posting paused by a vote');
  // blocking hides the author for this member only (and still counts for the limit)
  const b = acceptPosts([item(alice, one, T0 + 4 * DAY)], { postmanPublicKey: postman.publicKey, blocked: [alice.publicKey] });
  assert.equal(b.dropped[0].reason, 'blocked by you');
});

test('a post can\'t be moved into another group or replayed under another key generation', () => {
  const g = createGroup();
  const other = createGroup();
  const badge = issueBadge(postman, { holder: alice.publicKey, nfts: 5, now: T0 });
  const env = sealGroupPost({ group: g, from: alice, text: 'hi', badge, now: T0 });
  assert.throws(() => openGroupPost({ ...env, group: other.id }, { groupId: other.id, keys: { 1: g.key } }), /moved/);
  assert.throws(() => openGroupPost({ ...env, epoch: 2 }, { groupId: g.id, keys: { 2: g.key } }), /moved/);
});

test('the fake postman deletes group posts after 30 days', () => {
  let now = T0;
  const box = createFakePostman({ clock: () => now });
  const g = createGroup();
  const badge = issueBadge(postman, { holder: alice.publicKey, nfts: 5, now: T0 });
  box.post(g.id, sealGroupPost({ group: g, from: alice, text: 'old', badge, now }));
  now += 31 * DAY;
  box.post(g.id, sealGroupPost({ group: g, from: alice, text: 'new', badge: issueBadge(postman, { holder: alice.publicKey, nfts: 5, now }), now }));
  box.cleanUp();
  assert.equal(box.fetchGroup(g.id).length, 1);
  assert.equal(box.fetchGroup(g.id, 1).length, 1);
});
