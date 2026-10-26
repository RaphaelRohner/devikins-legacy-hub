/**
 * HubEmojiImage.web.js - one of the Hub's own emojis (hubEmojis.js) as a
 * picture, on the website: the drawing as an image address. The Android
 * app's version is HubEmojiImage.js (Android's image component can't show
 * SVG drawings).
 */
import { Image } from 'react-native';
import { hubEmojiUri, hubEmojiLabel } from '../constants/hubEmojis';

export default function HubEmojiImage({ code, size }) {
  return <Image source={{ uri: hubEmojiUri(code) }} style={{ width: size, height: size }} accessibilityLabel={hubEmojiLabel(code)} />;
}
