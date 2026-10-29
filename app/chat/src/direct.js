/**
 * direct.js — sealing and opening 1:1 messages
 *
 * Uses Nostr's published formats (NIP-17 style), via nostr-tools:
 *   1. the message ("rumor", kind 14) names the real sender,
 *   2. it's encrypted for the receiver and signed by the sender ("seal",
 *      NIP-44 encryption),
 *   3. the seal is encrypted again inside a "gift wrap" (NIP-59) signed by
 *      a throwaway key made for this one envelope.
 * The postman therefore only sees "an envelope for device X" with a blurred
 * time: not who sent it, not what's in it. Opening checks the seal's
 * signature and that the sender inside matches it (done by nostr-tools).
 *
 * One envelope per receiving DEVICE (a player may have the website and a
 * phone linked), plus copies for the sender's own other devices.
 *
 * Messages carry a type: 'text' (what people write) or a control message
 * the Hub itself sends (e.g. accepting a contact request, a new group key).
 */

import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import { getEventHash } from 'nostr-tools/pure';
import { isPublicKey, secretBytes } from './identity.js';
import { cleanText } from './rules.js';

export const DIRECT_KIND = 14;
/** Envelopes bigger than this are refused before any work (against floods). */
export const MAX_ENVELOPE_CHARS = 64 * 1024;
const TYPES = /^[a-z][a-z0-9-]{0,31}$/;
/** A message's own id (29 Oct 2026): 16 random bytes as hex. */
export const MID = /^[0-9a-f]{32}$/;

/**
 * sealDirect — envelopes for one message.
 *   from:       the sender's device identity
 *   toDevices:  the receiver's device public keys
 *   ownDevices: the sender's OTHER devices (they get a copy), optional
 *   type:       'text' (default) or a control type
 *   body:       the text, or for control types a plain object
 *   mid:        optional: the message's own id (32 hex characters), so it
 *               can be edited or deleted later (29 Oct 2026). Older Hubs
 *               ignore the extra tag.
 * → [{ to, envelope }]
 */
export function sealDirect({ from, toDevices, ownDevices = [], type = 'text', body, mid = null }) {
  if (mid !== null && !MID.test(mid)) throw new Error('Damaged message id.');
  if (!TYPES.test(type)) throw new Error('Unknown message type.');
  const content = type === 'text' ? cleanText(body) : JSON.stringify(body ?? {});
  if (!content) throw new Error('Nothing to send.');
  const receivers = [...new Set([...(toDevices || []), ...(ownDevices || [])])];
  if (receivers.length === 0 || !receivers.every(isPublicKey)) throw new Error('No valid receiver.');
  const secret = secretBytes(from);
  const rumor = {
    kind: DIRECT_KIND,
    content,
    tags: [['devi', type], ...(mid ? [['mid', mid]] : []), ...(toDevices || []).map((p) => ['p', p])],
  };
  return receivers.map((to) => ({ to, envelope: wrapEvent(rumor, secret, to) }));
}

/**
 * openDirect — opens an envelope meant for this device.
 * → { from, type, text | data, sentAt, mid } ; throws if it isn't genuine.
 */
export function openDirect(envelope, identity) {
  if (!envelope || typeof envelope !== 'object' || JSON.stringify(envelope).length > MAX_ENVELOPE_CHARS) {
    throw new Error('Not a chat envelope.');
  }
  // A fresh copy, so nothing remembered on the caller's object counts as "checked".
  const rumor = unwrapEvent(JSON.parse(JSON.stringify(envelope)), secretBytes(identity));
  if (rumor.kind !== DIRECT_KIND) throw new Error('Not a chat message.');
  if (getEventHash(rumor) !== rumor.id) throw new Error('The message was changed.');
  const type = (rumor.tags || []).find((t) => t[0] === 'devi')?.[1] || 'text';
  if (!TYPES.test(type)) throw new Error('Unknown message type.');
  const mid = (rumor.tags || []).find((t) => t[0] === 'mid')?.[1];
  const base = { from: rumor.pubkey, type, sentAt: rumor.created_at * 1000, mid: MID.test(mid || '') ? mid : null };
  if (type === 'text') return { ...base, text: cleanText(rumor.content) };
  return { ...base, data: JSON.parse(rumor.content) };
}
