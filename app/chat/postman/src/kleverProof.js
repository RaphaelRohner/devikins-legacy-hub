/**
 * kleverProof.js — proving "this wallet holds Devikins", the postman's side
 *
 * 1. The Hub asks the Klever browser extension to SIGN A TEXT (not a
 *    transaction: no fee, nothing moves). The text names the chat key, a
 *    one-time code and an expiry time (signInText below).
 * 2. The postman checks that signature with Klever's own code
 *    (@klever/connect-crypto, verifyWalletSignedMessage: the text is
 *    prefixed with "\x17Klever Signed Message:\n" and its length, hashed
 *    with keccak256 and checked as an Ed25519 signature of the wallet).
 *    A Klever address (klv1…) is the wallet's public key itself, so the
 *    address is all that's needed to check it.
 * 3. It asks Klever's public API how many Devikins the wallet holds right
 *    now. Only NFTs in the wallet count – listed or rented ones don't.
 */

import { verifyWalletSignedMessage } from '@klever/connect-crypto';
import { bech32Decode } from '@klever/connect-encoding';

export const COLLECTION = 'DVKNFT-1SW5';
export const KLEVER_API = 'https://api.mainnet.klever.org/v1.0';
const ADDRESS = /^klv1[02-9ac-hj-np-z]{58}$/;

/**
 * The text the wallet signs at sign-in. It names the postman's address, so
 * a signature made for another site can't be used here.
 */
export function signInText({ site, deviceKey, code, expiresAt }) {
  return [
    'Devikins Legacy Hub – chat sign-in',
    `Postman: ${site}`,
    '',
    'This is NOT a transaction. It costs nothing and moves nothing.',
    '',
    'It shows that this wallet holds Devikins, for this chat key:',
    deviceKey,
    '',
    `One-time code: ${code}`,
    `Valid until: ${new Date(expiresAt).toISOString().replace('.000Z', 'Z')}`,
  ].join('\n');
}

/** The wallet's public key (32 bytes) from its klv1… address; throws if it isn't one. */
export function walletPublicKey(address) {
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Error('Not a Klever address.');
  const { prefix, data } = bech32Decode(address);
  if (prefix !== 'klv' || data.length !== 32) throw new Error('Not a Klever address.');
  return data;
}

/** The 64 signature bytes, from hex (what the extension gives) or base64. */
export function signatureBytes(signature) {
  if (typeof signature !== 'string') throw new Error('No signature.');
  const s = signature.trim().replace(/^0x/, '');
  if (/^[0-9a-fA-F]{128}$/.test(s)) {
    return Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  }
  if (/^[A-Za-z0-9+/]{86}==$/.test(s)) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }
  throw new Error('The signature has an unknown format.');
}

/** True if `signature` is the wallet's signature of exactly `text`. */
export async function isWalletSignature(text, wallet, signature) {
  try {
    return await verifyWalletSignedMessage(text, signatureBytes(signature), walletPublicKey(wallet));
  } catch {
    return false;
  }
}

/**
 * How many Devikins the wallet holds right now (one question to Klever's
 * API). A wallet Klever has never seen holds 0. Throws if Klever's server
 * doesn't answer properly (the player can simply try again).
 */
export async function devikinsHeld(wallet, fetchFn = fetch) {
  walletPublicKey(wallet);
  const response = await fetchFn(`${KLEVER_API}/address/${wallet}`, { headers: { accept: 'application/json' } });
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Klever's server answered ${response.status}.`);
  const json = await response.json();
  const account = json?.data?.account;
  if (!account || account.address !== wallet) throw new Error("Klever's server gave an unexpected answer.");
  const balance = Number(account.assets?.[COLLECTION]?.balance ?? 0);
  if (!Number.isInteger(balance) || balance < 0) throw new Error("Klever's server gave an unexpected answer.");
  return balance;
}
