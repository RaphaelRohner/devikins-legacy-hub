/**
 * badge.js — the postman's signed badge
 *
 * After someone proves (once, with the Klever extension) that their wallet
 * holds Devikins, the postman signs a small badge for their chat key:
 * "this chat key belongs to a verified holder of N NFTs, valid until …".
 * There is NO wallet in it. Group members' Hubs check badges to apply the
 * posting limits (rules.js), without ever learning anyone's wallet.
 *
 * Format: a signed Nostr event (standard signature, checkable by anyone
 * with the postman's public key), never published anywhere:
 *   kind BADGE_KIND, content "", tags:
 *     ["p", <holder's chat public key>], ["nfts", "<N>"], ["expiration", "<unix seconds>"],
 *     and (from the real postman) ["account", <random account number>]: the
 *     same for all devices of one player, so limits count once per player.
 *     It is a random number made by the postman, not the wallet.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { isPublicKey, secretBytes } from './identity.js';

export const BADGE_KIND = 20777; // our own number, in Nostr's "never stored" range
export const BADGE_DAYS = 7;

const tag = (event, name) => (event.tags || []).find((t) => Array.isArray(t) && t[0] === name)?.[1];

const ACCOUNT = /^[0-9a-f]{32}$/;

/**
 * Postman side: a badge for `holder` (chat public key) holding `nfts`, valid
 * `days` days - or until `expiresAtSec` (a device linked by QR code gets the
 * same count and end as the device that linked it, 27 Oct 2026).
 */
export function issueBadge(postmanIdentity, { holder, nfts, now, days = BADGE_DAYS, account, expiresAtSec }) {
  if (!isPublicKey(holder)) throw new Error('Not a chat key.');
  const n = Math.floor(Number(nfts));
  if (!Number.isFinite(n) || n < 1) throw new Error('Only holders get a badge.');
  if (account !== undefined && !ACCOUNT.test(account)) throw new Error('Not an account number.');
  const issued = Math.floor(now / 1000);
  const end = Number.isInteger(expiresAtSec) ? expiresAtSec : issued + days * 86400;
  const tags = [['p', holder], ['nfts', String(n)], ['expiration', String(end)]];
  if (account) tags.push(['account', account]);
  return finalizeEvent(
    {
      kind: BADGE_KIND,
      created_at: issued,
      content: '',
      tags,
    },
    secretBytes(postmanIdentity),
  );
}

/**
 * checkBadge — is this a genuine, current badge of the postman for this
 * chat key? → { ok: true, nfts, until, account } or { ok: false, problem }
 * (`account` is null for badges without one).
 * `at` = the moment that matters (e.g. when the postman received a post).
 */
export function checkBadge(input, { postmanPublicKey, holder, at }) {
  try {
    // Always check a fresh copy: nostr-tools remembers "already checked" on
    // the object itself, and a copied object would carry that over (found by
    // the tests, 21 Oct 2026). Badges normally arrive as text anyway.
    const badge = JSON.parse(JSON.stringify(input));
    if (!badge || badge.kind !== BADGE_KIND) return { ok: false, problem: 'not a badge' };
    if (badge.pubkey !== postmanPublicKey) return { ok: false, problem: 'not from the postman' };
    if (!verifyEvent(badge)) return { ok: false, problem: 'signature broken' };
    if (tag(badge, 'p') !== holder) return { ok: false, problem: 'badge of someone else' };
    const nfts = Number(tag(badge, 'nfts'));
    const until = Number(tag(badge, 'expiration')) * 1000;
    if (!Number.isInteger(nfts) || nfts < 1 || !Number.isFinite(until)) return { ok: false, problem: 'damaged' };
    if (at > until) return { ok: false, problem: 'expired' };
    if (at < badge.created_at * 1000 - 5 * 60 * 1000) return { ok: false, problem: 'not valid yet' };
    const account = tag(badge, 'account') ?? null;
    if (account !== null && !ACCOUNT.test(account)) return { ok: false, problem: 'damaged' };
    return { ok: true, nfts, until, account };
  } catch {
    return { ok: false, problem: 'damaged' };
  }
}
