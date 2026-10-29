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
import { cleanText, nextPostAllowedAt, MIN_POST_INTERVAL, POST_WINDOW } from './rules.js';

export const GROUP_POST_KIND = 9; // Nostr's kind for a chat message in a group
export const MAX_GROUP_ENVELOPE_CHARS = 64 * 1024;
/**
 * Reactions (24 Oct 2026, Raphael: free and unlimited): one of REACTIONS on a post,
 * '' takes it back (more emojis can be added to the list later; older Hubs
 * then simply ignore the ones they don't know). They travel like posts (sealed with the group
 * key, signed, with the badge), but under Nostr's kind for a reaction, so
 * they never count as posts and don't use the daily allowance. Each
 * player's latest reaction on a post counts.
 */
export const GROUP_REACTION_KIND = 7;
// (+1 and 💯 added 29 Oct 2026 – Raphael: 👍 reads as "I like it", a literal
// +1 says "I agree and want to push the post"; 💯 is plain agreement too)
export const REACTIONS = ['👍', '+1', '💯', '👎', '❤️', '😂', '😮', '🔥'];
export const REACTION_VALUES = [...REACTIONS, ''];
/**
 * The Hub's own emojis (25 Oct 2026): short codes like "dvk:laugh:ochran"
 * (face and Ancestry colour; the drawings are in the website's
 * src/constants/hubEmojis.js). Any such code travels; a Hub draws the ones
 * it knows and leaves out the others (newer ones it doesn't know yet).
 */
export const HUB_EMOJI_CODE = /^dvk:[a-z]{2,12}:[a-z]{2,12}$/;
export const isReactionValue = (v) => REACTION_VALUES.includes(v) || (typeof v === 'string' && HUB_EMOJI_CODE.test(v));

/**
 * Polls (25 Oct 2026, Raphael): any member asks a question with 2–6 answers
 * and an end time; every member has one vote (whatever they hold), can change
 * it until the end, and sees who voted what. The creator can close it early.
 * All sealed in the group mailbox and counted by every member's Hub (the
 * postman sees nothing new). Starting a poll counts as a post (the daily
 * allowance); voting is free like reactions. Nostr's kinds for a poll and a
 * poll answer (NIP-88), and our own number for "closed".
 */
export const GROUP_POLL_KIND = 1068;
export const GROUP_POLL_VOTE_KIND = 1018;
export const GROUP_POLL_CLOSE_KIND = 21068;
/**
 * Editing and deleting a post (29 Oct 2026, Raphael): sealed in the group
 * mailbox like a reaction (free, never a post). Every member's Hub applies
 * them only if they come from the post's author (the same device, or
 * another device of the same player - by the badge), an edit at most
 * MAX_EDITS times and within EDIT_WINDOW (rules.js), counted by the
 * postman's receive times. Nostr's kind for a deletion (NIP-09) and our own
 * number for an edit. Older Hubs can't open these and skip them.
 */
export const GROUP_EDIT_KIND = 21009;
export const GROUP_DELETE_KIND = 5;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
export const POLL_MAX_OPTION_CHARS = 80;
export const POLL_MAX_QUESTION_CHARS = 300;
export const POLL_MIN_DURATION = 60 * 60 * 1000;
export const POLL_MAX_DURATION = 7 * 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

function sealEvent({ group, from, kind, content, tags, badge, now }) {
  const event = finalizeEvent(
    {
      kind,
      created_at: Math.floor(now / 1000),
      content,
      tags: [['h', group.id], ['epoch', String(group.epoch)], ...tags, ['badge', JSON.stringify(badge)]],
    },
    secretBytes(from),
  );
  return { v: 1, group: group.id, epoch: group.epoch, payload: nip44.encrypt(JSON.stringify(event), hexToBytes(group.key)) };
}

/** The answers of a poll, cleaned: 2–6, each 1–80 characters, no repeats. */
export function cleanPollOptions(options) {
  const list = (options || []).map((o) => cleanText(o).slice(0, POLL_MAX_OPTION_CHARS)).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length < POLL_MIN_OPTIONS) throw new Error(`A poll needs at least ${POLL_MIN_OPTIONS} different answers.`);
  if (unique.length > POLL_MAX_OPTIONS) throw new Error(`A poll can have at most ${POLL_MAX_OPTIONS} answers.`);
  return unique;
}

/** sealGroupPoll — a new poll: question, answers, how long it runs (ms, 1 hour – 7 days). */
export function sealGroupPoll({ group, from, question, options, durationMs, badge, now = Date.now() }) {
  const q = cleanText(question).slice(0, POLL_MAX_QUESTION_CHARS);
  if (!q) throw new Error('Please write a question.');
  const answers = cleanPollOptions(options);
  const d = Math.round(Number(durationMs));
  if (!(d >= POLL_MIN_DURATION && d <= POLL_MAX_DURATION)) throw new Error('A poll runs between 1 hour and 7 days.');
  return sealEvent({
    group, from, badge, now, kind: GROUP_POLL_KIND, content: q,
    tags: [...answers.map((a, i) => ['option', String(i), a]), ['duration', String(d)]],
  });
}

/** sealGroupPollVote — my answer (its number) to poll `pollId`; '' takes my vote back. */
export function sealGroupPollVote({ group, from, pollId, option, badge, now = Date.now() }) {
  if (!HEX64.test(pollId || '')) throw new Error('Unknown poll.');
  const choice = option === '' ? '' : String(option);
  if (choice !== '' && !/^[0-5]$/.test(choice)) throw new Error('Unknown answer.');
  return sealEvent({ group, from, badge, now, kind: GROUP_POLL_VOTE_KIND, content: '', tags: [['e', pollId], ['response', choice]] });
}

/** sealGroupEdit — the new text for my post `postId`. */
export function sealGroupEdit({ group, from, postId, text, badge, now = Date.now() }) {
  if (!HEX64.test(postId || '')) throw new Error('Unknown post.');
  const content = cleanText(text);
  if (!content) throw new Error('Nothing to send.');
  return sealEvent({ group, from, badge, now, kind: GROUP_EDIT_KIND, content, tags: [['e', postId]] });
}

/** The group owner's short reason when removing someone else's post (29 Oct 2026). */
export const MAX_REMOVE_REASON_CHARS = 80;

/**
 * sealGroupDelete — removes post (or poll) `postId` for everyone: my own, or
 * - as the group's owner - someone else's (29 Oct 2026), then with an
 * optional short reason (NIP-09 keeps the reason in the content).
 */
export function sealGroupDelete({ group, from, postId, badge, reason = '', now = Date.now() }) {
  if (!HEX64.test(postId || '')) throw new Error('Unknown post.');
  const why = cleanText(reason || '').slice(0, MAX_REMOVE_REASON_CHARS);
  return sealEvent({ group, from, badge, now, kind: GROUP_DELETE_KIND, content: why, tags: [['e', postId]] });
}

/** sealGroupPollClose — the creator ends poll `pollId` now. */
export function sealGroupPollClose({ group, from, pollId, badge, now = Date.now() }) {
  if (!HEX64.test(pollId || '')) throw new Error('Unknown poll.');
  return sealEvent({ group, from, badge, now, kind: GROUP_POLL_CLOSE_KIND, content: '', tags: [['e', pollId]] });
}
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

/** sealGroupReaction — 👍 / 👎 / taken back ('') on post `postId`. */
export function sealGroupReaction({ group, from, postId, value, badge, now = Date.now() }) {
  if (!/^[0-9a-f]{64}$/.test(postId || '')) throw new Error('Unknown post.');
  if (!isReactionValue(value)) throw new Error('Unknown reaction.');
  const reaction = finalizeEvent(
    {
      kind: GROUP_REACTION_KIND,
      created_at: Math.floor(now / 1000),
      content: value,
      tags: [['h', group.id], ['epoch', String(group.epoch)], ['e', postId], ['badge', JSON.stringify(badge)]],
    },
    secretBytes(from),
  );
  return { v: 1, group: group.id, epoch: group.epoch, payload: nip44.encrypt(JSON.stringify(reaction), hexToBytes(group.key)) };
}

/**
 * openGroupPost — opens a post with the keys this member has
 * (keys: { [epoch]: keyHex }). Posts from epochs the member has no key for
 * (from before they joined) can't be opened: → null.
 * → { kind: 'post', id, from, text, badge, writtenAt }, or for a reaction
 *   { kind: 'reaction', id, from, target (post id), value, badge, writtenAt };
 * throws if the envelope isn't genuine.
 */
export function openGroupPost(envelope, { groupId, keys }) {
  if (!envelope || envelope.v !== 1 || envelope.group !== groupId || typeof envelope.payload !== 'string'
      || envelope.payload.length > MAX_GROUP_ENVELOPE_CHARS) {
    throw new Error('Not a post of this group.');
  }
  const key = keys && keys[envelope.epoch];
  if (!key) return null;
  const post = JSON.parse(nip44.decrypt(envelope.payload, hexToBytes(key)));
  const KINDS = [GROUP_POST_KIND, GROUP_REACTION_KIND, GROUP_POLL_KIND, GROUP_POLL_VOTE_KIND, GROUP_POLL_CLOSE_KIND, GROUP_EDIT_KIND, GROUP_DELETE_KIND];
  if (!KINDS.includes(post.kind) || !verifyEvent(post)) throw new Error('The post was changed.');
  if (tag(post, 'h') !== groupId || Number(tag(post, 'epoch')) !== envelope.epoch) throw new Error('The post was moved from elsewhere.');
  let badge = null;
  try { badge = JSON.parse(tag(post, 'badge')); } catch { badge = null; }
  const base = { id: post.id, from: post.pubkey, badge, writtenAt: post.created_at * 1000 };
  if (post.kind === GROUP_POLL_KIND) {
    const options = (post.tags || []).filter((t) => Array.isArray(t) && t[0] === 'option').map((t) => cleanText(t[2]).slice(0, POLL_MAX_OPTION_CHARS));
    const durationMs = Number(tag(post, 'duration'));
    const question = cleanText(post.content).slice(0, POLL_MAX_QUESTION_CHARS);
    if (!question || options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS || options.some((o) => !o)
        || !(durationMs >= POLL_MIN_DURATION && durationMs <= POLL_MAX_DURATION)) throw new Error('Not a poll.');
    return { kind: 'poll', ...base, question, options, durationMs };
  }
  if (post.kind === GROUP_POLL_VOTE_KIND || post.kind === GROUP_POLL_CLOSE_KIND) {
    const target = tag(post, 'e');
    if (!HEX64.test(target || '')) throw new Error('Not about a poll.');
    if (post.kind === GROUP_POLL_CLOSE_KIND) return { kind: 'poll-close', ...base, target };
    const option = tag(post, 'response') ?? '';
    if (option !== '' && !/^[0-5]$/.test(option)) throw new Error('Not a poll answer.');
    return { kind: 'poll-vote', ...base, target, option: option === '' ? null : Number(option) };
  }
  if (post.kind === GROUP_EDIT_KIND || post.kind === GROUP_DELETE_KIND) {
    const target = tag(post, 'e');
    if (!HEX64.test(target || '')) throw new Error('Not about a post.');
    if (post.kind === GROUP_DELETE_KIND) return { kind: 'delete', ...base, target, reason: cleanText(post.content || '').slice(0, MAX_REMOVE_REASON_CHARS) };
    const text = cleanText(post.content);
    if (!text) throw new Error('An empty edit.');
    return { kind: 'edit', ...base, target, text };
  }
  if (post.kind === GROUP_REACTION_KIND) {
    const target = tag(post, 'e');
    if (!/^[0-9a-f]{64}$/.test(target || '') || !isReactionValue(post.content)) throw new Error('Not a reaction.');
    return { kind: 'reaction', id: post.id, from: post.pubkey, target, value: post.content, badge, writtenAt: post.created_at * 1000 };
  }
  return { kind: 'post', id: post.id, from: post.pubkey, text: cleanText(post.content), badge, writtenAt: post.created_at * 1000 };
}

/**
 * acceptPosts — which opened posts a member's Hub shows, applying the
 * posting limits. `items` = [{ post (from openGroupPost), receivedAt }]
 * where receivedAt is the POSTMAN's time. Posts without a valid badge, or
 * that came before the author was allowed to post again, are dropped – the
 * same way on every member's Hub, so an author with a modified Hub gains
 * nothing. `lastAccepted` carries each author's last accepted time over from
 * earlier calls ({ [player]: [times of accepted posts] }, updated in place;
 * only the last 24 h are kept).
 * `blocked` = authors this member blocked (hidden for them only).
 * `paused` = authors whose posting is paused by a supported removal vote.
 * `seen` = ids of posts already shown (a Set, updated): a post sent again
 * is dropped, and so is one whose own time is far from when the postman
 * got it (an old post copied and sent again to use up its author's limit).
 * The limit counts per PLAYER (the badge's account number), not per device.
 * `owners` = account numbers of the group's owner: they may post as often as
 * the postman allows (every 10 seconds), whatever they hold – so the person who
 * runs a group can always answer (Raphael, 22 Oct 2026).
 * → { shown: [...], dropped: [{ item, reason }] }
 */
export function acceptPosts(items, { postmanPublicKey, lastAccepted = {}, blocked = [], paused = [], seen = new Set(), owners = [] }) {
  const shown = [];
  const dropped = [];
  const sorted = [...(items || [])].filter((i) => i && i.post && !FREE_KINDS.includes(i.post.kind)).sort((a, b) => a.receivedAt - b.receivedAt);
  for (const item of sorted) {
    const { post, receivedAt } = item;
    if (post.id && seen.has(post.id)) { dropped.push({ item, reason: 'sent again' }); continue; }
    if (Math.abs(receivedAt - post.writtenAt) > MAX_POST_DELAY) { dropped.push({ item, reason: 'old post sent again' }); continue; }
    const badge = checkBadge(post.badge, { postmanPublicKey, holder: post.from, at: receivedAt });
    if (!badge.ok) { dropped.push({ item, reason: `badge ${badge.problem}` }); continue; }
    if (paused.includes(post.from)) { dropped.push({ item, reason: 'posting paused by a vote' }); continue; }
    const player = badge.account ?? post.from;
    const times = Array.isArray(lastAccepted[player]) ? lastAccepted[player] : lastAccepted[player] ? [lastAccepted[player]] : [];
    const allowedAt = owners.includes(badge.account)
      ? (times.length ? Math.max(...times) : -Infinity) + MIN_POST_INTERVAL
      : nextPostAllowedAt(times, badge.nfts, receivedAt);
    if (receivedAt < allowedAt) { dropped.push({ item, reason: 'too early' }); continue; }
    lastAccepted[player] = [...times.filter((t) => t > receivedAt - POST_WINDOW), receivedAt];
    if (post.id) seen.add(post.id);
    if (blocked.includes(post.from)) { dropped.push({ item, reason: 'blocked by you' }); continue; }
    shown.push(item);
  }
  return { shown, dropped };
}

// Free: they don't use the daily allowance (reactions, poll answers, closing a poll; edits and deletes, 29 Oct 2026).
const FREE_KINDS = ['reaction', 'poll-vote', 'poll-close', 'edit', 'delete'];

/**
 * acceptReactions — which opened reactions count: a valid badge at the time
 * the postman got it (only holders react), not sent again, not an old one
 * copied. No allowance (free). → [{ item, player }] (player = the badge's
 * account number: one reaction per player and post, the latest counts).
 */
export function acceptReactions(items, { postmanPublicKey, seen = new Set(), paused = [], kinds = ['reaction'] }) {
  const accepted = [];
  for (const item of items || []) {
    const { post, receivedAt } = item || {};
    if (!post || !kinds.includes(post.kind) || (post.id && seen.has(post.id))) continue;
    if (Math.abs(receivedAt - post.writtenAt) > MAX_POST_DELAY || paused.includes(post.from)) continue;
    const badge = checkBadge(post.badge, { postmanPublicKey, holder: post.from, at: receivedAt });
    if (!badge.ok) continue;
    if (post.id) seen.add(post.id);
    accepted.push({ item, player: badge.account ?? post.from });
  }
  return accepted;
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
