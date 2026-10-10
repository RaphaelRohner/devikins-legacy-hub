/**
 * useNftImage.web.js
 *
 * Website version of useNftImage.js (the build tool picks this file for
 * the browser).
 *
 * 1. Show the picture from Moonlabs' image server, as usual.
 * 2. If that fails (server down, or the picture no longer exists there),
 *    look for a copy in the browser's own picture store (see
 *    src/api/webImageCache.js - filled during fetches and from imported
 *    backups) and show that instead.
 * 3. Only if there's no copy either, show the "Unavailable" placeholder.
 *
 * Phone file locations (local_image_path) are ignored here: they point
 * into a phone's storage and mean nothing in a browser.
 */
import { useEffect, useState } from 'react';
import { getCachedImageBytes } from '../api/webImageCache';

function mimeFor(url) {
  return /\.png(\?|$)/i.test(String(url)) ? 'image/png' : 'image/jpeg';
}

export default function useNftImage(nft) {
  const remote = nft?.image || null;
  const [imageSource, setImageSource] = useState(remote);
  const [triedBackup, setTriedBackup] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    setImageSource(remote);
    setTriedBackup(false);
    setImageLoadFailed(false);
  }, [remote]);

  // Free the temporary in-browser address of a backup copy when it's no
  // longer shown.
  useEffect(() => {
    return () => {
      if (imageSource && imageSource.startsWith('blob:')) URL.revokeObjectURL(imageSource);
    };
  }, [imageSource]);

  async function onImageError() {
    if (triedBackup || !remote) {
      setImageLoadFailed(true);
      return;
    }
    setTriedBackup(true);
    const bytes = await getCachedImageBytes(remote);
    if (bytes) {
      setImageSource(URL.createObjectURL(new Blob([bytes], { type: mimeFor(remote) })));
    } else {
      setImageLoadFailed(true);
    }
  }

  return { imageSource, imageLoadFailed, onImageError };
}
