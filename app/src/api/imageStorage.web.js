/**
 * imageStorage.web.js
 *
 * The website version of imageStorage.js. When the Hub is built for the
 * browser, the build tool automatically picks this ".web.js" file instead
 * of the phone one.
 *
 * On the phone, imageStorage.js saves every NFT picture into the app's own
 * storage. On the website, storeImage() keeps a copy in the browser's own
 * picture store instead (see webImageCache.js), so website backups can
 * include the pictures. It still answers "no local file" (null), so the
 * screen keeps showing the picture from Moonlabs' image server.
 *
 * Same function names and answers as the phone file, so the rest of the
 * app doesn't need to know the difference.
 */

import { ensureCachedImage } from './webImageCache';

export function setActiveImagesDirName() {}

export async function storeImage(kind, nonce, remoteUrl) {
  if (remoteUrl) await ensureCachedImage(remoteUrl);
  return { localImagePath: null, etag: null };
}

// Used by the "has this picture changed?" check. Returning null means
// "couldn't tell", which makes that check leave everything as it is.
export async function fetchImageEtag() {
  return null;
}

export async function deleteStoredImagesForDir() {}
