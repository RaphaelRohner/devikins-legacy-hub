/**
 * album.js — Collectors Albums (27 Oct 2026): a player shows chosen NFTs
 * from one of their wallets, for everyone to browse (website and app).
 *
 * How an album stays honest and anonymous (decided with Raphael):
 *   - Each album has its OWN key, made on the player's device. The album
 *     (title, description, the NFTs with notes) is signed with that key, so
 *     nobody else can change it, and only that key can delete it.
 *   - The wallet whose NFTs it shows signs a short text naming the album
 *     key (the "proof", made with the Klever extension or the KLV Signer):
 *     no made-up collections. Every viewer's Hub checks that proof itself,
 *     and that each NFT is still in that wallet.
 *   - The album is NOT linked to the player's chat nickname, unless they
 *     choose to put it on (the postman checks it's really theirs).
 *   - The postman stores the album under its key only: no account, no
 *     device next to it.
 * Anyone can still look the wallet up on Kleverscan: the Hub says so before
 * publishing, and the player confirms.
 *
 * Plain calculations only (no network), shared by the Hub and the postman.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { prepareKlvMessage, verifySignatureSync } from '@klever/connect-crypto';
import { bech32Decode } from '@klever/connect-encoding';
import { createIdentity, isPublicKey, secretBytes } from './identity.js';
import { cleanText } from './rules.js';

export const ALBUM_KIND = 31890;
export const ALBUM_KINDS = ['devikin', 'weapon', 'equipment'];
export const MAX_ALBUM_ITEMS = 100;
export const MAX_ALBUM_TITLE = 60;
export const MAX_ALBUM_DESCRIPTION = 500;
export const MAX_ALBUM_NOTE = 200;

const ADDRESS = /^klv1[02-9ac-hj-np-z]{58}$/;

/** A new album key (like a chat key: { publicKey, secretKey }). */
export const createAlbumKey = () => createIdentity();

/** What the wallet signs to show it's the wallet behind the album (not a transaction). */
export function albumProofText(albumKey) {
  return [
    'Devikins Legacy Hub – Collectors Album',
    '',
    'This is NOT a transaction. It costs nothing and moves nothing.',
    '',
    'It shows that this wallet holds the NFTs in the album with the key:',
    albumKey,
  ].join('\n');
}

function signatureBytes(signature) {
  const s = String(signature || '').trim().replace(/^0x/, '');
  if (/^[0-9a-fA-F]{128}$/.test(s)) return Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  if (/^[A-Za-z0-9+/]{86}==$/.test(s)) return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return null;
}

/** Did `wallet` sign the proof for `albumKey`? (Klever's message format, or a plain signature; synchronous, works in the app too.) */
export function isAlbumProof(albumKey, wallet, signature) {
  try {
    if (!ADDRESS.test(wallet || '')) return false;
    const { prefix, data } = bech32Decode(wallet);
    if (prefix !== 'klv' || data.length !== 32) return false;
    const sig = signatureBytes(signature);
    if (!sig || sig.length !== 64) return false;
    const text = albumProofText(albumKey);
    return verifySignatureSync(prepareKlvMessage(text), sig, data) || verifySignatureSync(new TextEncoder().encode(text), sig, data);
  } catch {
    return false;
  }
}

/** The album's contents, cleaned and checked; throws with a plain message if something's wrong. */
export function cleanAlbum({ title, description = '', name = null, wallet, proof, items }) {
  const t = cleanText(title || '');
  if (!t) throw new Error('The album needs a title.');
  if ([...t].length > MAX_ALBUM_TITLE) throw new Error(`The title can have at most ${MAX_ALBUM_TITLE} characters.`);
  const d = cleanText(description || '');
  if ([...d].length > MAX_ALBUM_DESCRIPTION) throw new Error(`The description can have at most ${MAX_ALBUM_DESCRIPTION} characters.`);
  const n = name == null ? null : cleanText(String(name));
  if (n !== null && (!n || [...n].length > 20)) throw new Error('Not a nickname.');
  if (!ADDRESS.test(wallet || '')) throw new Error('Not a Klever address.');
  if (typeof proof !== 'string' || !proof) throw new Error('The wallet\'s proof is missing.');
  if (!Array.isArray(items) || items.length === 0) throw new Error('Pick at least one NFT.');
  if (items.length > MAX_ALBUM_ITEMS) throw new Error(`An album can show at most ${MAX_ALBUM_ITEMS} NFTs.`);
  const seen = new Set();
  const clean = items.map((i) => {
    if (!ALBUM_KINDS.includes(i?.kind) || !Number.isInteger(i.nonce) || i.nonce < 1 || i.nonce > 1e9) throw new Error('One of the NFTs is damaged.');
    const id = `${i.kind}/${i.nonce}`;
    if (seen.has(id)) throw new Error('An NFT is in the album twice.');
    seen.add(id);
    const note = cleanText(i.note || '');
    if ([...note].length > MAX_ALBUM_NOTE) throw new Error(`A note can have at most ${MAX_ALBUM_NOTE} characters.`);
    return note ? { kind: i.kind, nonce: i.nonce, note } : { kind: i.kind, nonce: i.nonce };
  });
  return { title: t, description: d, name: n, wallet, proof, items: clean };
}

/** The album, signed with its key. → a Nostr-style event (JSON) */
export function sealAlbum(albumKey, contents, now = Date.now()) {
  const c = cleanAlbum(contents);
  return finalizeEvent(
    { kind: ALBUM_KIND, created_at: Math.floor(now / 1000), tags: [['d', 'album']], content: JSON.stringify(c) },
    secretBytes(albumKey),
  );
}

/**
 * checkAlbum — is this a genuine album? Its signature, its contents, and the
 * wallet's proof. → { ok: true, album: { key, updatedAt, title, description,
 * name, wallet, items } } or { ok: false, problem }
 */
export function checkAlbum(input) {
  try {
    const event = JSON.parse(JSON.stringify(input)); // (a fresh copy: see badge.js)
    if (!event || event.kind !== ALBUM_KIND || !isPublicKey(event.pubkey)) return { ok: false, problem: 'not an album' };
    if (!verifyEvent(event)) return { ok: false, problem: 'signature broken' };
    let c;
    try { c = cleanAlbum(JSON.parse(event.content)); } catch (e) { return { ok: false, problem: e.message }; }
    if (!isAlbumProof(event.pubkey, c.wallet, c.proof)) return { ok: false, problem: 'the wallet\'s proof doesn\'t match' };
    return { ok: true, album: { key: event.pubkey, updatedAt: event.created_at * 1000, ...c } };
  } catch {
    return { ok: false, problem: 'damaged' };
  }
}
