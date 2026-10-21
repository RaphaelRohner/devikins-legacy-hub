/**
 * identity.js — the chat key of one device
 *
 * Every device (the website in one browser, later the phone) gets its own
 * chat key: a random secret number and the public key that goes with it.
 * The public key is the device's "address" in the chat; the secret key
 * opens envelopes sealed for it and signs what the device sends.
 *
 * It is NOT a wallet key: it was made only for the chat and can't move any
 * NFT or coin. The Hub's rule "never store or handle wallet keys" stays.
 * Keys are made by nostr-tools (secp256k1, the curve Nostr's formats use).
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** A new chat key for this device: { secretKey (hex), publicKey (hex) }. */
export function createIdentity() {
  const secret = generateSecretKey();
  return { secretKey: bytesToHex(secret), publicKey: getPublicKey(secret) };
}

/** True for a well-formed public key (64 lower-case hex characters). */
export function isPublicKey(value) {
  return typeof value === 'string' && HEX64.test(value);
}

/** The secret key as bytes, for nostr-tools. Throws on anything malformed. */
export function secretBytes(identity) {
  if (!identity || typeof identity.secretKey !== 'string' || !HEX64.test(identity.secretKey)) {
    throw new Error('This chat key is damaged.');
  }
  const bytes = hexToBytes(identity.secretKey);
  if (getPublicKey(bytes) !== identity.publicKey) throw new Error('This chat key is damaged.');
  return bytes;
}
