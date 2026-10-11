/**
 * imageBytes.web.js (website)
 *
 * Reads a stored NFT picture back as bytes, for the blank-picture check
 * (imageQuality.js). The website keeps its copies in the browser's
 * picture store (webImageCache.js), under the picture's address.
 */
import { getCachedImageBytes } from './webImageCache';

export async function readStoredImageBytes(localImagePath, remoteUrl) {
  return getCachedImageBytes(remoteUrl);
}
