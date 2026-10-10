/**
 * useNftImage.js
 *
 * Decides which picture an NFT shows, and handles a picture that fails to
 * load (then the "Unavailable" placeholder is shown instead of a blank
 * box). Shared by every list/tile/detail view.
 *
 * Phone version: prefer the copy the app saved on the phone
 * (local_image_path), otherwise the address on Moonlabs' image server.
 * The website has its own version, useNftImage.web.js.
 */
import { useEffect, useState } from 'react';

export default function useNftImage(nft) {
  const imageSource = nft?.local_image_path || nft?.image || null;
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageSource]);
  return { imageSource, imageLoadFailed, onImageError: () => setImageLoadFailed(true) };
}
