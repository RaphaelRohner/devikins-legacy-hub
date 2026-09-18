/**
 * imageStorage.js
 *
 * NFT images are hosted on the game studio's own image servers
 * (img.devikins.com and friends), not something we control. Up to now,
 * the app only ever stored that remote URL, and asked the phone to
 * re-download the actual picture from the internet every single time it
 * needed to show it. If that image host was ever slow or briefly down,
 * the picture would just fail to appear that one time - even though we'd
 * successfully shown it before.
 *
 * This file downloads an NFT's image to the phone's own persistent
 * storage the first time we see it, and hands back a local file:// path
 * to use instead. Once saved, the picture no longer depends on that
 * server being reachable at all.
 *
 * On naming: this used to be called imageCache.js/cacheImage(), which
 * was a bit misleading - "cache" on a phone usually means a folder the
 * operating system is allowed to wipe without warning when storage runs
 * low. That's NOT what this uses. It saves into `documentDirectory`
 * (Expo's persistent, private app storage - the OS won't touch it), not
 * `cacheDirectory` (which it could clear at any time). Renamed to make
 * that distinction obvious at a glance.
 *
 * IMPORTANT SDK NOTE: as of expo-file-system 57 (installed here), the
 * plain `import * as FileSystem from 'expo-file-system'` gives you a
 * NEW, class-based API (File/Directory) - the classic promise-based
 * functions this file uses (getInfoAsync, downloadAsync,
 * makeDirectoryAsync, deleteAsync, documentDirectory) now live under the
 * '/legacy' subpath instead, and calling them from the main import path
 * logs a "deprecated" error rather than working. That was actually
 * breaking every image download silently until this was caught in the
 * dev logs - hence the '/legacy' import below being load-bearing, not
 * cosmetic.
 *
 * Two other defensive details worth knowing about:
 *
 *   - The download gets its own timeout (separate from metadataApi.js's
 *     timeout for the trait data itself), so a hung image download can
 *     never stall the fetch that's happening around it.
 *   - After downloading, we sanity-check the file isn't suspiciously
 *     tiny. A flaky host can sometimes answer with an HTTP 200 status
 *     but an error page's HTML instead of the actual image - if we
 *     didn't check this, we'd "successfully save" a broken file and then
 *     never retry it, since as far as the rest of the app could tell,
 *     saving that image had already succeeded.
 *
 * Trade-off worth knowing about: this assumes an NFT's image doesn't
 * change once saved. That's true for almost everything here, but
 * NOTES.md flags that OTHER fields (level, slots) genuinely can change
 * over time for the same NFT. If the game ever changes an NFT's artwork
 * after we've already saved it, this would keep showing the old picture.
 * If that turns out to matter, the fix is to compare the freshly-fetched
 * image URL against the one already stored in the database (see
 * database.js's upsertNft) and only reuse the saved file when the URL is
 * unchanged - upsertNft already has both values on hand to do that check
 * cheaply, without touching this file.
 */

import * as FileSystem from 'expo-file-system/legacy';

const IMAGE_STORAGE_DIR = `${FileSystem.documentDirectory}nft-images/`;
const DOWNLOAD_TIMEOUT_MS = 15000;
// A real NFT thumbnail is essentially never this small - anything under
// this is almost certainly an error page or an empty response, not a
// picture, so we treat it as a failed download rather than saving it.
const MIN_VALID_IMAGE_BYTES = 200;

async function ensureStorageDirExists() {
  const dirInfo = await FileSystem.getInfoAsync(IMAGE_STORAGE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(IMAGE_STORAGE_DIR, { intermediates: true });
  }
}

// Picks a file extension from the URL so the saved file opens correctly
// (e.g. a Image viewer/OS can tell it's a PNG vs a JPEG). Falls back to
// .jpg if the URL doesn't obviously end in a known image extension.
function extensionFromUrl(url) {
  const match = url.match(/\.(png|jpe?g|gif|webp)(\?|$)/i);
  return match ? match[1].toLowerCase() : 'jpg';
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/**
 * Downloads `remoteUrl` into local, persistent app storage (unless we
 * already have a good saved copy for this exact nonce), and returns a
 * local file:// path to use in place of the remote URL. Never throws -
 * if the download fails for any reason, this just returns null, and the
 * caller falls back to the remote URL (or a placeholder) for that one
 * item, same as before this file existed. Safe to call again later for
 * the same nonce - a missing or previously-broken file is retried, a
 * good one is reused.
 */
export async function storeImage(kind, nonce, remoteUrl) {
  if (!remoteUrl) return null;

  const localPath = `${IMAGE_STORAGE_DIR}${kind}-${nonce}.${extensionFromUrl(remoteUrl)}`;

  try {
    await ensureStorageDirExists();

    const existingFile = await FileSystem.getInfoAsync(localPath);
    if (existingFile.exists && existingFile.size >= MIN_VALID_IMAGE_BYTES) {
      return localPath;
    }

    const result = await withTimeout(
      FileSystem.downloadAsync(remoteUrl, localPath),
      DOWNLOAD_TIMEOUT_MS,
      'image download timed out'
    );

    if (result.status !== 200) {
      return null;
    }

    const savedFile = await FileSystem.getInfoAsync(localPath);
    if (!savedFile.exists || savedFile.size < MIN_VALID_IMAGE_BYTES) {
      // Got an HTTP 200, but what we saved doesn't look like a real
      // image (see MIN_VALID_IMAGE_BYTES above) - don't leave a broken
      // file behind that we'd otherwise mistake for a good save later.
      await FileSystem.deleteAsync(localPath, { idempotent: true });
      return null;
    }

    return localPath;
  } catch (err) {
    console.log(`[imageStorage] Couldn't save image for ${kind} #${nonce}: ${err.message}`);
    return null;
  }
}

/**
 * Deletes every image this app has ever downloaded and saved locally -
 * used by the "Reset All Data" button in WalletManager.js, alongside
 * resetAllData() in database.js, so a reset genuinely starts from
 * nothing rather than leaving a folder of orphaned pictures behind for
 * NFTs that no longer have a database row pointing at them. Safe to
 * call even if the folder was never created yet (a brand-new install
 * that's never fetched anything).
 */
export async function deleteAllStoredImages() {
  const dirInfo = await FileSystem.getInfoAsync(IMAGE_STORAGE_DIR);
  if (dirInfo.exists) {
    await FileSystem.deleteAsync(IMAGE_STORAGE_DIR, { idempotent: true });
  }
}
