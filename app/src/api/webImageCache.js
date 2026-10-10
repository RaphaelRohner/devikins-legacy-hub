/**
 * webImageCache.js
 *
 * Website only (used by imageStorage.web.js and exportImport.web.js).
 *
 * Keeps a copy of every NFT picture inside the visitor's browser, in the
 * browser's "Cache Storage" (a storage area each website gets for its own
 * files), keyed by the picture's original address on Moonlabs' image
 * server. That copy is what lets website backups include the pictures,
 * and lets a phone backup's pictures be kept when it's imported here.
 * (Moonlabs' image servers explicitly allow websites to download them.)
 *
 * The pictures on screen still load from Moonlabs' server as before.
 */

const CACHE_NAME = 'devi-hub-images-v1';
const MIN_VALID_IMAGE_BYTES = 200; // same rule as the phone app: smaller = error page, not a picture

function available() {
  return typeof caches !== 'undefined';
}

/** Returns the picture's bytes from the browser's store, or null. */
export async function getCachedImageBytes(url) {
  if (!available() || !url) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(url);
    if (!res) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
}

/** Saves picture bytes under the picture's original address. */
export async function putCachedImageBytes(url, bytes, contentType) {
  if (!available() || !url || !bytes || bytes.length < MIN_VALID_IMAGE_BYTES) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(bytes, { headers: { 'Content-Type': contentType || 'image/png' } }));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Makes sure a picture is in the store (downloads it if not) and returns
 * its bytes, or null if it can't be had right now.
 */
export async function ensureCachedImage(url) {
  const existing = await getCachedImageBytes(url);
  if (existing) return existing;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < MIN_VALID_IMAGE_BYTES) return null;
    await putCachedImageBytes(url, bytes, res.headers.get('content-type'));
    return bytes;
  } catch (e) {
    return null;
  }
}

/** Same file-extension rule as the phone app (imageStorage.js). */
export function extensionFromUrl(url) {
  const match = String(url).match(/\.(png|jpe?g|gif|webp)(\?|$)/i);
  return match ? match[1].toLowerCase() : 'jpg';
}
