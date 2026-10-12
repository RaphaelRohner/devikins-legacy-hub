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

/**
 * Removes every stored picture whose address isn't in `keepUrls` - the
 * pictures no wallet set uses any more (after deleting a set or Reset All
 * Data). Returns how many were removed. Before 12 Oct 2026 these were never
 * removed on the website, so old pictures quietly took up space (Raphael
 * saw 226 MB in total with two small test sets).
 */
export async function pruneCachedImages(keepUrls) {
  if (!available()) return 0;
  try {
    // Compare addresses in the browser's own spelling (e.g. spaces become
    // %20), the same way the store saved them.
    const keep = new Set();
    for (const url of keepUrls) {
      try {
        keep.add(new Request(url).url);
      } catch (e) {
        keep.add(url);
      }
    }
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    let removed = 0;
    for (const request of requests) {
      if (!keep.has(request.url)) {
        await cache.delete(request);
        removed += 1;
      }
    }
    return removed;
  } catch (e) {
    return 0;
  }
}
