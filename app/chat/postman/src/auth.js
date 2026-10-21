/**
 * auth.js — "this request really comes from chat key X"
 *
 * Each request a device makes carries a small signed note in its
 * Authorization header, in Nostr's published format for this (NIP-98,
 * "HTTP Auth"): kind 27235, the exact address and method of the request,
 * the SHA-256 of the request body, and the time. It is signed with the
 * device's chat key, so nobody else can make it, it can't be reused for a
 * different request, and it's only accepted for one minute.
 *
 * The device (Hub) side is makeAuthHeader below; the postman uses
 * checkAuthHeader.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isPublicKey, secretBytes } from '../../src/identity.js';

export const HTTP_AUTH_KIND = 27235;
export const AUTH_WINDOW_SECONDS = 60;

const tag = (event, name) => (event.tags || []).find((t) => Array.isArray(t) && t[0] === name)?.[1];
const bodyHash = (bodyText) => bytesToHex(sha256(new TextEncoder().encode(bodyText || '')));

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

/** Device side: the Authorization header for one request. */
export function makeAuthHeader(identity, { url, method, bodyText = '', now = Date.now() }) {
  const event = finalizeEvent(
    {
      kind: HTTP_AUTH_KIND,
      created_at: Math.floor(now / 1000),
      content: '',
      tags: [['u', url], ['method', method.toUpperCase()], ['payload', bodyHash(bodyText)]],
    },
    secretBytes(identity),
  );
  return `Nostr ${toBase64(JSON.stringify(event))}`;
}

/**
 * Postman side: → the device's chat public key, or throws (with a plain
 * reason) if the header isn't a genuine, fresh note for exactly this request.
 */
export function checkAuthHeader(header, { url, method, bodyText = '', now = Date.now() }) {
  if (typeof header !== 'string' || !header.startsWith('Nostr ') || header.length > 4096) {
    throw new Error('Not signed in with a chat key.');
  }
  let event;
  try {
    event = JSON.parse(fromBase64(header.slice(6).trim()));
  } catch {
    throw new Error('The chat key signature is damaged.');
  }
  if (!event || typeof event !== 'object' || event.kind !== HTTP_AUTH_KIND || !isPublicKey(event.pubkey)) {
    throw new Error('The chat key signature is damaged.');
  }
  if (!verifyEvent(event)) throw new Error('The chat key signature is wrong.');
  if (Math.abs(Math.floor(now / 1000) - event.created_at) > AUTH_WINDOW_SECONDS) {
    throw new Error("The request is too old (or this device's clock is wrong).");
  }
  if (tag(event, 'u') !== url || String(tag(event, 'method')).toUpperCase() !== method.toUpperCase()) {
    throw new Error('The signature was made for a different request.');
  }
  if (tag(event, 'payload') !== bodyHash(bodyText)) throw new Error('The request was changed on the way.');
  return event.pubkey;
}
