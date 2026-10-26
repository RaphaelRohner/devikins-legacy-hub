/**
 * HubEmojiImage.js - one of the Hub's own emojis (hubEmojis.js) in the
 * Android app: the SVG drawing is drawn directly (react-native-svg),
 * because Android's image component can't show SVG pictures. The website
 * uses HubEmojiImage.web.js.
 */
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { hubEmojiSvg, hubEmojiLabel } from '../constants/hubEmojis';

// The drawings style their lines with a little stylesheet (class "i").
// SvgXml doesn't read stylesheets, so the same look is written onto each
// line itself (keeping a line's own width where it has one).
const LINE = { fill: 'none', stroke: '#2a1d2a', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
function withoutStylesheet(svg) {
  return svg
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[a-z]+\b[^>]*\bclass="i"[^>]*>/g, (tag) => {
      const extra = Object.entries(LINE)
        .filter(([name]) => !new RegExp(`\\s${name}="`).test(tag))
        .map(([name, value]) => `${name}="${value}"`)
        .join(' ');
      return tag.replace('class="i"', extra);
    });
}

export default function HubEmojiImage({ code, size }) {
  const raw = hubEmojiSvg(code);
  const svg = raw ? withoutStylesheet(raw) : null;
  if (!svg) return null;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel={hubEmojiLabel(code)}>
      <SvgXml xml={svg} width={size} height={size} />
    </View>
  );
}
