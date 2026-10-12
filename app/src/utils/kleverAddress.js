/**
 * kleverAddress.js - is this text a real Klever wallet address?
 *
 * A Klever address is "klv1" followed by 58 characters from a fixed set of
 * 32 (no b, i, o or 1). The last 6 characters are a checksum calculated
 * from everything before them (the "bech32" format, also used by Bitcoin).
 * A single mistyped or swapped character makes the checksum wrong, so
 * typos are caught right here, without asking any server - and without
 * refusing brand-new wallets that have never been used on the chain.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function expandPrefix(prefix) {
  const codes = [...prefix].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

export function isValidKleverAddress(address) {
  const text = String(address || '').trim();
  if (!/^klv1[02-9ac-hj-np-z]{58}$/.test(text)) return false;
  const data = [...text.slice(4)].map((c) => CHARSET.indexOf(c));
  return polymod([...expandPrefix('klv'), ...data]) === 1;
}
