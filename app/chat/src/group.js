/**
 * group.js — group messages: one sealed envelope for the whole group
 *
 * Each group has a secret GROUP KEY that all current members know. A post
 * is signed by its author's chat key (so members know who wrote it and that
 * nobody changed it) and then encrypted ONCE with the group key (NIP-44,
 * the same audited encryption as 1:1 messages). The postman stores that
 * single envelope in the group's mailbox – once per group, never once per
 * member. It can't read the post. (It does see which chat key handed the
 * envelope in, because only signed-in players may post – it keeps nothing
 * about that except the time, for its one-post-per-minute flood limit.)
 *
 * How it's used since stage 3 (22 Oct 2026): a group keeps one key; a new
 * member gets it from a member's Hub (sealed, control message 'group-key',
 * checked against the group's key check at the postman), and the postman
 * hands a new member only posts from after they joined. Renewing the key
 * ("new epoch", nextEpoch below) when someone is removed comes with the
 * removal votes (stage 4), so a removed member can't read on.
 *
 * Posting limits (rules.js) are checked by every member's Hub using the
 * time the POSTMAN received a post (the author can't fake that) and the
 * author's badge (badge.js).
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secretBytes } from './identity.js';
import { checkBadge } from './badge.js';
import { cleanText, nextPostAllowedAt, MIN_POST_INTERVAL } from './rules.js';

export const GROUP_POST_KIND = 9; // Nostr's kind for a chat message in a group
export const MAX_GROUP_ENVELOPE_CHARS = 64 * 1024;
const HEX32 = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[0-9a-f]{32}$/;

const tag = (event, name) => (event.tags || []).find((t) => Array.isArray(t) && t[0] === name)?.[1];

/** A new group: { id, epoch: 1, key } (the creator's starting key). */
export function createGroup() {
  return { id: bytesToHex(randomBytes(16)), epoch: 1, key: bytesToHex(randomBytes(32)) };
}

/**
 * The group's "key check": a fingerprint of the key, stored openly at the
 * postman when the group is created. A newcomer only accepts a key that
 * matches it, so nobody can hand them a fake one.
 */
export function groupKeyCheck(groupId, keyHex) {
  return bytesToHex(sha256(new TextEncoder().encode(`devi-group-key:${groupId}:${keyHex}`)));
}

/** A post's own time and the postman's receive time may differ by at most this (older posts sent again are dropped). */
export const MAX_POST_DELAY = 5 * 60 * 1000;

/** The next key for a group (someone joined or was removed). */
export function nextEpoch(group) {
  return { id: group.id, epoch: group.epoch + 1, key: bytesToHex(randomBytes(32)) };
}

/** The control message that hands a group key to a member (sent with sealDirect, type 'group-key'). */
export function groupKeyMessage(group) {
  return { group: group.id, epoch: group.epoch, key: group.key };
}

/** Checks a received 'group-key' control message → { id, epoch, key } or throws. */
export function readGroupKeyMessage(data) {
  if (!data || !GROUP_ID.test(data.group) || !Number.isInteger(data.epoch) || data.epoch < 1 || !HEX32.test(data.key)) {
    throw new Error('Damaged group key.');
  }
  return { id: data.group, epoch: data.epoch, key: data.key };
}

/**
 * sealGroupPost — one envelope for the group's mailbox.
 *   group: { id, epoch, key } (the current key)
 *   from:  the author's device identity
 *   badge: the author's current badge (badge.js)
 * → { v: 1, group, epoch, payload }
 */
export function sealGroupPost({ group, from, text, badge, now = Date.now() }) {
  const content = cleanText(text);
  if (!content) throw new Error('Nothing to send.');
  const post = finalizeEvent(
    {
      kind: GROUP_POST_KIND,
      created_at: Math.floor(now / 1000),
      content,
      tags: [['h', group.id], ['epoch', String(group.epoch)], ['badge', JSON.stringify(badge)]],
    },
    secretBytes(from),
  );
  return { v: 1, group: group.id, epoch: group.epoch, payload: nip44.encrypt(JSON.stringify(post), hexToBytes(group.key)) };
}

/**
 * openGroupPost — opens a post with the keys this member has
 * (keys: { [epoch]: keyHex }). Posts from epochs the member has no key for
 * (from before they joined) can't be opened: → null.
 * → { from, text, badge, writtenAt } ; throws if the envelope isn't genuine.
 */
export function openGroupPost(envelope, { groupId, keys }) {
  if (!envelope || envelope.v !== 1 || envelope.group !== groupId || typeof envelope.payload !== 'string'
      || envelope.payload.length > MAX_GROUP_ENVELOPE_CHARS) {
    throw new Error('Not a post of this group.');
  }
  const key = keys && keys[envelope.epoch];
  if (!key) return null;
  const post = JSON.parse(nip44.decrypt(envelope.payload, hexToBytes(key)));
  if (post.kind !== GROUP_POST_KIND || !verifyEvent(post)) throw new Error('The post was changed.');
  if (tag(post, 'h') !== groupId || Number(tag(post, 'epoch')) !== envelope.epoch) throw new Error('The post was moved from elsewhere.');
  let badge = null;
  try { badge = JSON.parse(tag(post, 'badge')); } catch { badge = null; }
  return { id: post.id, from: post.pubkey, text: cleanText(post.content), badge, writtenAt: post.created_at * 1000 };
}

/**
 * acceptPosts — which opened posts a member's Hub shows, applying the
 * posting limits. `items` = [{ post (from openGroupPost), receivedAt }]
 * where receivedAt is the POSTMAN's time. Posts without a valid badge, or
 * that came before the author was allowed to post again, are dropped – the
 * same way on every member's Hub, so an author with a modified Hub gains
 * nothing. `lastAccepted` carries each author's last accepted time over from
 * earlier calls ({ [author]: time }, updated in place).
 * `blocked` = authors this member blocked (hidden for them only).
 * `paused` = authors whose posting is paused by a supported removal vote.
 * `seen` = ids of posts already shown (a Set, updated): a post sent again
 * is dropped, and so is one whose own time is far from when the postman
 * got it (an old post copied and sent again to use up its author's limit).
 * The limit counts per PLAYER (the badge's account number), not per device.
 * `owners` = account numbers of the group's owner: they may post as often as
 * the postman allows (once a minute), whatever they hold – so the person who
 * runs a group can always answer (Raphael, 22 Oct 2026).
 * → { shown: [...], dropped: [{ item, reason }] }
 */
export function acceptPosts(items, { postmanPublicKey, lastAccepted = {}, blocked = [], paused = [], seen = new Set(), owners = [] }) {
  const shown = [];
  const dropped = [];
  const sorted = [...(items || [])].filter((i) => i && i.post).sort((a, b) => a.receivedAt - b.receivedAt);
  for (const item of sorted) {
    const { post, receivedAt } = item;
    if (post.id && seen.has(post.id)) { dropped.push({ item, reason: 'sent again' }); continue; }
    if (Math.abs(receivedAt - post.writtenAt) > MAX_POST_DELAY) { dropped.push({ item, reason: 'old post sent again' }); continue; }
    const badge = checkBadge(post.badge, { postmanPublicKey, holder: post.from, at: receivedAt });
    if (!badge.ok) { dropped.push({ item, reason: `badge ${badge.problem}` }); continue; }
    if (paused.includes(post.from)) { dropped.push({ item, reason: 'posting paused by a vote' }); continue; }
    const player = badge.account ?? post.from;
    const allowedAt = owners.includes(badge.account)
      ? (lastAccepted[player] ?? -Infinity) + MIN_POST_INTERVAL
      : nextPostAllowedAt(lastAccepted[player] ?? null, badge.nfts);
    if (receivedAt < allowedAt) { dropped.push({ item, reason: 'too early' }); continue; }
    lastAccepted[player] = receivedAt;
    if (post.id) seen.add(post.id);
    if (blocked.includes(post.from)) { dropped.push({ item, reason: 'blocked by you' }); continue; }
    shown.push(item);
  }
  return { shown, dropped };
}

// --- Pinned messages (the owner's rules / important info) ---------------------

/** Our own kind number for a pinned message, so it can never pass as a post (or the other way round). */
export const PINNED_KIND = 39777;

/** The reason given for a removal vote: sealed like a pinned message, with its own kind number. */
export const VOTE_REASON_KIND = 39778;

/** At most this many pinned messages per group. */
export const MAX_PINS = 5;

/**
 * The owner's pinned messages (a list, up to MAX_PINS), signed and sealed
 * with the group key as ONE envelope (one per group at the postman).
 */
export function sealPinned({ group, from, pins, now = Date.now(), kind = PINNED_KIND }) {
  const list = (pins || []).map((p) => cleanText(p)).filter(Boolean);
  if (list.length === 0) throw new Error('Nothing to pin.');
  if (list.length > MAX_PINS) throw new Error(`At most ${MAX_PINS} pinned messages.`);
  const pinned = finalizeEvent(
    {
      kind,
      created_at: Math.floor(now / 1000),
      content: JSON.stringify({ pins: list }),
      tags: [['h', group.id], ['epoch', String(group.epoch)]],
    },
    secretBytes(from),
  );
  return { v: 1, group: group.id, epoch: group.epoch, payload: nip44.encrypt(JSON.stringify(pinned), hexToBytes(group.key)) };
}

/** Opens the pinned messages → { from, pins: [text …], writtenAt } or null (no key); throws if it isn't genuine. */
export function openPinned(envelope, { groupId, keys, kind = PINNED_KIND }) {
  if (!envelope || envelope.v !== 1 || envelope.group !== groupId || typeof envelope.payload !== 'string'
      || envelope.payload.length > MAX_GROUP_ENVELOPE_CHARS) {
    throw new Error('Not a pinned message of this group.');
  }
  const key = keys && keys[envelope.epoch];
  if (!key) return null;
  const pinned = JSON.parse(nip44.decrypt(envelope.payload, hexToBytes(key)));
  if (pinned.kind !== kind || !verifyEvent(JSON.parse(JSON.stringify(pinned)))) throw new Error('The pinned message was changed.');
  if (tag(pinned, 'h') !== groupId || Number(tag(pinned, 'epoch')) !== envelope.epoch) throw new Error('The pinned message was moved from elsewhere.');
  let pins;
  try {
    const parsed = JSON.parse(pinned.content);
    pins = Array.isArray(parsed?.pins) ? parsed.pins : [String(pinned.content)];
  } catch {
    pins = [pinned.content]; // (a single pinned text, as written before 22 Oct 2026)
  }
  pins = pins.map((p) => cleanText(String(p))).filter(Boolean).slice(0, MAX_PINS);
  return { from: pinned.pubkey, pins, writtenAt: pinned.created_at * 1000 };
}
