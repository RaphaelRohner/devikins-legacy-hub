/**
 * hubEmojis.js - the Hub's own emojis (Raphael, 25 Oct 2026): emoji faces
 * with little horns, in the colours of the five Ancestries. Original
 * drawings (SVG, made here in code) - not the game's art.
 *
 * A reaction with one of them is sent as a short code, e.g.
 * "dvk:laugh:ochran"; Hubs that don't know a code simply ignore it.
 */

export const ANCESTRIES = [
  { key: 'glysian', label: 'Glysian', body: '#7b9cc6', dark: '#3f5f8f' },
  { key: 'khoroth', label: 'Khoroth', body: '#8a6f84', dark: '#4e3a4b' },
  { key: 'lunarian', label: 'Lunarian', body: '#ece6e4', dark: '#9b8f8f' },
  { key: 'maarish', label: 'Maarish', body: '#72b3a8', dark: '#3b7069' },
  { key: 'ochran', label: 'Ochran', body: '#e27a64', dark: '#9c3f33' },
];

const INK = '#2a1d2a';

// Each face: what's drawn on top of the round head (64 × 64 box, head centre 32/36).
const FACES = {
  happy: {
    label: 'Happy',
    parts: `<path d="M21 34 q4 -5 8 0" class="i"/><path d="M35 34 q4 -5 8 0" class="i"/>
      <path d="M22 42 q10 10 20 0" class="i"/>`,
  },
  laugh: {
    label: 'Laughing',
    parts: `<path d="M20 33 l6 3 l-6 3" class="i"/><path d="M44 33 l-6 3 l6 3" class="i"/>
      <path d="M21 42 h22 q-2 12 -11 12 q-9 0 -11 -12 z" fill="${INK}"/><path d="M25 49 q7 4 14 0" fill="#e66b7a"/>
      <path d="M14 38 q-3 5 0 8 q3 -3 0 -8 z" fill="#6cc4f0"/><path d="M50 38 q-3 5 0 8 q3 -3 0 -8 z" fill="#6cc4f0"/>`,
  },
  love: {
    label: 'In love',
    parts: `<path d="M25 37 l-5 -5 a3 3 0 0 1 5 -3 a3 3 0 0 1 5 3 z" fill="#e23b55"/>
      <path d="M39 37 l-5 -5 a3 3 0 0 1 5 -3 a3 3 0 0 1 5 3 z" fill="#e23b55"/>
      <path d="M23 43 q9 9 18 0" class="i"/>`,
  },
  wow: {
    label: 'Surprised',
    parts: `<circle cx="25" cy="33" r="3.2" fill="${INK}"/><circle cx="39" cy="33" r="3.2" fill="${INK}"/>
      <path d="M21 27 q4 -3 8 -1" class="i"/><path d="M35 26 q4 -2 8 1" class="i"/>
      <ellipse cx="32" cy="46" rx="4.5" ry="5.5" fill="${INK}"/>`,
  },
  sad: {
    label: 'Sad',
    parts: `<circle cx="25" cy="35" r="2.6" fill="${INK}"/><circle cx="39" cy="35" r="2.6" fill="${INK}"/>
      <path d="M21 30 q4 -3 8 -2" class="i"/><path d="M35 28 q4 -1 8 2" class="i"/>
      <path d="M24 49 q8 -7 16 0" class="i"/><path d="M42 39 q-3 5 0 8 q3 -3 0 -8 z" fill="#6cc4f0"/>`,
  },
  angry: {
    label: 'Angry',
    parts: `<path d="M20 29 l9 4" class="i"/><path d="M44 29 l-9 4" class="i"/>
      <circle cx="26" cy="36" r="2.6" fill="${INK}"/><circle cx="38" cy="36" r="2.6" fill="${INK}"/>
      <path d="M24 49 q8 -6 16 0" class="i"/>`,
  },
  cool: {
    label: 'Cool',
    parts: `<path d="M17 31 h30 v3 q-1 7 -7 7 q-6 0 -7 -6 h-2 q-1 6 -7 6 q-6 0 -7 -7 z" fill="${INK}"/>
      <path d="M22 33 l3 -1" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
      <path d="M25 46 q8 5 15 -1" class="i"/>`,
  },
  wink: {
    label: 'Wink',
    parts: `<circle cx="25" cy="34" r="2.8" fill="${INK}"/><path d="M35 35 q4 -4 8 0" class="i"/>
      <path d="M23 43 q9 8 18 0" class="i"/><path d="M38 47 q2 5 5 2" fill="#e66b7a"/>`,
  },
  yawn: {
    label: 'Yawning',
    parts: `<path d="M20 34 q5 3 9 0" class="i"/><path d="M35 34 q5 3 9 0" class="i"/>
      <ellipse cx="32" cy="47" rx="6" ry="7" fill="${INK}"/><ellipse cx="32" cy="51" rx="3.5" ry="2.2" fill="#e66b7a"/>
      <path d="M45 37 q-2 4 0 6 q2 -2 0 -6 z" fill="#6cc4f0"/>`,
  },
  sleepy: {
    label: 'Sleepy',
    parts: `<path d="M20 36 q5 3 9 0" class="i"/><path d="M35 36 q5 3 9 0" class="i"/>
      <path d="M27 47 h10" class="i"/>
      <path d="M36 21 h5 l-5 6 h5" class="i" stroke-width="2"/><path d="M44 15 h4 l-4 5 h4" class="i" stroke-width="1.8"/>`,
  },
  thinking: {
    label: 'Thinking',
    parts: `<circle cx="25" cy="35" r="2.6" fill="${INK}"/><circle cx="39" cy="34" r="2.6" fill="${INK}"/>
      <path d="M21 30 q4 -2 8 0" class="i"/><path d="M35 26 q4 -3 8 0" class="i"/>
      <path d="M27 47 q6 -3 11 0" class="i"/>
      <path d="M44 41 q0 -4 3 -4 q3 0 3 3 q0 2 -3 3 v1.5" class="i" stroke-width="2"/><circle cx="47" cy="47.5" r="1.3" fill="${INK}"/>`,
  },
  crying: {
    label: 'Crying',
    parts: `<path d="M20 33 q5 -3 9 1" class="i"/><path d="M35 34 q4 -4 9 -1" class="i"/>
      <path d="M22 51 q10 -9 20 0 z" fill="${INK}"/>
      <path d="M22 35 q-3 9 -1 19 h4 q1 -10 -1 -19 z" fill="#6cc4f0" opacity="0.9"/>
      <path d="M42 35 q-3 9 -1 19 h4 q1 -10 -1 -19 z" fill="#6cc4f0" opacity="0.9"/>`,
  },
  kiss: {
    label: 'Kiss',
    parts: `<path d="M21 34 q4 -5 8 0" class="i"/><circle cx="39" cy="33" r="2.6" fill="${INK}"/>
      <path d="M30 42 q4 1 2 3 q3 1 0 4" class="i"/>
      <path d="M46 46 l-4 -4 a2.5 2.5 0 0 1 4 -2.5 a2.5 2.5 0 0 1 4 2.5 z" fill="#e23b55"/>`,
  },
  tongue: {
    label: 'Tongue out',
    parts: `<path d="M20 31 l6 3 l-6 3" class="i"/><circle cx="39" cy="34" r="2.8" fill="${INK}"/>
      <path d="M22 43 q10 6 20 0" class="i"/><path d="M30 45 q0 9 5 9 q5 0 4 -10" fill="#e66b7a" stroke="${INK}" stroke-width="1.5"/>`,
  },
  meh: {
    label: 'Meh',
    parts: `<path d="M20 33 h8" class="i"/><path d="M36 33 h8" class="i"/>
      <circle cx="25" cy="36" r="2.2" fill="${INK}"/><circle cx="41" cy="36" r="2.2" fill="${INK}"/>
      <path d="M25 47 h14" class="i"/>`,
  },
  eyeroll: {
    label: 'Eye-roll',
    parts: `<circle cx="25" cy="33" r="4.5" fill="#ffffff" stroke="${INK}" stroke-width="1.5"/><circle cx="25" cy="30.5" r="2" fill="${INK}"/>
      <circle cx="39" cy="33" r="4.5" fill="#ffffff" stroke="${INK}" stroke-width="1.5"/><circle cx="39" cy="30.5" r="2" fill="${INK}"/>
      <path d="M26 47 q6 -3 12 0" class="i"/>`,
  },
};

export const HUB_FACES = Object.entries(FACES).map(([key, f]) => ({ key, label: f.label }));

/** All codes ("dvk:<face>:<ancestry>"), for the list of reactions the Hub accepts. */
export const HUB_EMOJI_CODES = ANCESTRIES.flatMap((a) => Object.keys(FACES).map((f) => `dvk:${f}:${a.key}`));

export const isHubEmoji = (code) => typeof code === 'string' && HUB_EMOJI_CODES.includes(code);

/** The SVG drawing (text) for a code, or null. */
export function hubEmojiSvg(code) {
  if (!isHubEmoji(code)) return null;
  const [, face, ancestry] = code.split(':');
  const a = ANCESTRIES.find((x) => x.key === ancestry);
  const f = FACES[face];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>.i{fill:none;stroke:${INK};stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}</style>
  <path d="M17 22 q-6 -9 -3 -17 q6 6 13 12 z" fill="${a.dark}" stroke="${a.dark}" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M47 22 q6 -9 3 -17 q-6 6 -13 12 z" fill="${a.dark}" stroke="${a.dark}" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="32" cy="36" r="25" fill="${a.body}" stroke="${a.dark}" stroke-width="2"/>
  <ellipse cx="24" cy="24" rx="7" ry="4" fill="#ffffff" opacity="0.25"/>
  ${f.parts}
</svg>`;
}

/** As a picture address for <Image source={{ uri }}> (website). */
export function hubEmojiUri(code) {
  const svg = hubEmojiSvg(code);
  if (!svg) return null;
  // (base64: the website's image component doesn't load the plain-text form)
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(svg))) : Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

export function hubEmojiLabel(code) {
  if (!isHubEmoji(code)) return '';
  const [, face, ancestry] = code.split(':');
  return `${FACES[face].label} (${ANCESTRIES.find((x) => x.key === ancestry).label})`;
}
