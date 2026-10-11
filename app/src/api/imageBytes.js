/**
 * imageBytes.js (phone app)
 *
 * Reads a downloaded NFT picture back as bytes, for the blank-picture
 * check (imageQuality.js). The phone keeps pictures as files (see
 * imageStorage.js). Website version: imageBytes.web.js.
 */
import * as FileSystem from 'expo-file-system/legacy';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i += 1) LOOKUP[B64.charCodeAt(i)] = i;

function base64ToBytes(base64) {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = LOOKUP[clean.charCodeAt(i + 2)];
    const d = LOOKUP[clean.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

/** The picture's bytes, or null if there's no downloaded copy. */
export async function readStoredImageBytes(localImagePath) {
  if (!localImagePath) return null;
  try {
    const base64 = await FileSystem.readAsStringAsync(localImagePath, { encoding: FileSystem.EncodingType.Base64 });
    return base64ToBytes(base64);
  } catch (e) {
    return null;
  }
}
