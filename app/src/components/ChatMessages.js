/**
 * ChatMessages.js (website and Android app) - the messages of a 1:1 chat or a group, laid out like
 * Telegram or WhatsApp (Raphael, 24 Oct 2026: easier to read, still in the
 * Hub's colours):
 *
 *   - a date line ("Today", "Yesterday", "Fri 23 Oct") when the day changes,
 *     and only the time inside each bubble, bottom right;
 *   - in groups: each sender's name in their own colour (always the same
 *     colour for the same name), with a round avatar holding their initial;
 *     posts in a row by the same sender within a few minutes are kept
 *     together (name and avatar only on the first);
 *   - your own messages on the right in the Hub's blue, the others on the
 *     left in a grey bubble, text in the normal text colour.
 *
 *   - reactions (groups, 24 Oct 2026): the ☺ next to someone else's post
 *     opens 👍 👎 ❤️ 😂 😮 🔥; the counts show under the bubble, yours
 *     highlighted - tap it again to take it back, another one to switch.
 *
 * items: [{ id, mine, author (who - for grouping and colour), nickname, text, at,
 *           pid, reactions: { counts: { emoji: n }, mine: emoji | '' } }]
 * onReact(pid, emoji) - reactions on (groups); left out: none (1:1 chats)
 */
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { REACTIONS } from '../../chat/src/group.js';
import { ANCESTRIES, HUB_FACES, isHubEmoji, hubEmojiLabel } from '../constants/hubEmojis';
import HubEmojiImage from './HubEmojiImage';

// The Ancestry colour last picked for the Hub's own emojis (this browser only).
const ANCESTRY_KEY = 'devi-hub-emoji-ancestry';
function readAncestry() {
  try {
    const v = window.localStorage.getItem(ANCESTRY_KEY);
    return ANCESTRIES.some((a) => a.key === v) ? v : ANCESTRIES[0].key;
  } catch (e) {
    return ANCESTRIES[0].key;
  }
}

/** A reaction as shown: the Hub's own emojis as their drawing, others as text. */
function ReactionGlyph({ value, size }) {
  if (isHubEmoji(value)) {
    return <HubEmojiImage code={value} size={size} />;
  }
  return <Text style={{ fontSize: size * 0.85 }}>{value}</Text>;
}

// Name colours: light ones on the dark theme, deeper ones on the light theme
// (both readable on the bubble). Avatars use the deeper ones with white text.
const NAME_COLORS_DARK = ['#ff8e86', '#7fd36d', '#f7c35f', '#6fb8f0', '#b59cf5', '#f58cc1', '#5fd1d4', '#ffaa6e'];
const NAME_COLORS_LIGHT = ['#c8413b', '#3a8f2b', '#9a6d00', '#2b74b8', '#7550cc', '#bb3a7c', '#13807f', '#c4621a'];
const KEEP_TOGETHER_MS = 5 * 60 * 1000;

/** The same name always gets the same colour. */
export function colorIndex(name) {
  let h = 0;
  for (const ch of String(name || '?').toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % NAME_COLORS_DARK.length;
}

function initials(name) {
  const words = String(name || '?').trim().split(/[\s_.-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '?').slice(0, 1).toUpperCase();
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLine(ms, nowMs = Date.now()) {
  const today = new Date(nowMs);
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000);
  if (dayKey(ms) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ms) === dayKey(yesterday.getTime())) return 'Yesterday';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Avatar({ name, size = 32 }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: NAME_COLORS_LIGHT[colorIndex(name)] }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>{initials(name)}</Text>
    </View>
  );
}

export default function ChatMessages({ items, showAuthors = false, onReact = null, busy = false }) {
  const { colors, isDark } = useTheme();
  const [pickerFor, setPickerFor] = useState(null);
  const [ancestry, setAncestryState] = useState(readAncestry);
  const setAncestry = (key) => {
    setAncestryState(key);
    try {
      window.localStorage.setItem(ANCESTRY_KEY, key);
    } catch (e) {
      // (private window: just not remembered)
    }
  };
  const nameColors = isDark ? NAME_COLORS_DARK : NAME_COLORS_LIGHT;
  const otherBubble = isDark ? '#26262c' : '#eceef3';
  const out = [];
  let prev = null;
  let lastDay = null;
  for (const m of items) {
    const newDay = lastDay === null || dayKey(lastDay) !== dayKey(m.at);
    lastDay = m.at;
    if (newDay) {
      out.push(
        <View key={`day-${m.id}`} style={styles.dayRow} testID="chat-day">
          <Text style={[styles.day, { color: colors.secondaryText, backgroundColor: otherBubble }]}>{dayLine(m.at)}</Text>
        </View>,
      );
    }
    if (m.system) {
      // A line about something that happened (e.g. "📊 Bob started a poll: …"), tap to open it.
      out.push(
        <View key={m.id} style={styles.dayRow}>
          <TouchableOpacity onPress={m.onPress} disabled={!m.onPress} testID="chat-system-line">
            <Text style={[styles.systemLine, { color: colors.text, backgroundColor: otherBubble, borderColor: colors.border }]}>
              {m.system} <Text style={{ color: colors.secondaryText }}>{clock(m.at)}</Text>
            </Text>
          </TouchableOpacity>
        </View>,
      );
      prev = null;
      continue;
    }
    const together = !newDay && prev && prev.mine === m.mine && prev.author === m.author && m.at - prev.at < KEEP_TOGETHER_MS;
    const name = m.nickname || 'a former member';
    const time = clock(m.at);
    const textColor = m.mine ? colors.primaryText : colors.text;
    const bubble = (
      <View
        style={[
          styles.bubble,
          m.mine
            ? { backgroundColor: colors.primary, borderBottomRightRadius: 4 }
            : { backgroundColor: otherBubble, borderBottomLeftRadius: 4 },
          together && (m.mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
        ]}
        testID="chat-message"
      >
        {showAuthors && !m.mine && !together ? (
          <Text style={[styles.author, { color: nameColors[colorIndex(name)] }]} numberOfLines={1}>
            {name}
          </Text>
        ) : null}
        <Text selectable style={[styles.text, { color: textColor }]}>
          {m.text}
          {/* (room for the time, so it never covers the last word) */}
          <Text style={[styles.timeRoom]}>{`   ${time}`}</Text>
        </Text>
        <Text style={[styles.time, { color: textColor }]}>{time}</Text>
      </View>
    );
    // (codes of Hub emojis this version doesn't know yet are left out)
    const counts = Object.entries(m.reactions?.counts || {}).filter(([v, n]) => n > 0 && (REACTIONS.includes(v) || isHubEmoji(v)));
    const canReact = !!onReact && !m.mine && !!m.pid;
    const react = (emoji) => {
      setPickerFor(null);
      onReact(m.pid, emoji);
    };
    out.push(
      <View
        key={m.id}
        style={[styles.line, { justifyContent: m.mine ? 'flex-end' : 'flex-start', marginTop: newDay ? 0 : together ? 2 : 10 }]}
      >
        {showAuthors && !m.mine ? (
          together ? <View style={styles.avatarRoom} /> : <Avatar name={name} />
        ) : null}
        <View style={[styles.column, { alignItems: m.mine ? 'flex-end' : 'flex-start' }]}>
          {bubble}
          {counts.length > 0 ? (
            <View style={styles.chips} testID="chat-reactions">
              {counts.map(([emoji, n]) => {
                const own = m.reactions.mine === emoji;
                return (
                  <TouchableOpacity
                    key={emoji}
                    disabled={!canReact || busy}
                    onPress={() => react(emoji)}
                    style={[styles.chip, { backgroundColor: own ? colors.primary : otherBubble, borderColor: own ? colors.primary : colors.border }]}
                    accessibilityLabel={`${isHubEmoji(emoji) ? hubEmojiLabel(emoji) : emoji} ${n}${own ? ', yours' : ''}`}
                    testID="chat-reaction"
                  >
                    <ReactionGlyph value={emoji} size={17} />
                    <Text style={[styles.chipText, { color: own ? colors.primaryText : colors.text }]}>{` ${n}`}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
          {pickerFor === m.id ? (
            <View style={[styles.picker, { backgroundColor: otherBubble, borderColor: colors.border }]} testID="chat-reaction-picker">
              <View style={styles.pickerRow}>
                {REACTIONS.map((emoji) => (
                  <TouchableOpacity key={emoji} onPress={() => react(emoji)} disabled={busy} style={styles.pickerItem} accessibilityLabel={`React with ${emoji}`} testID="chat-reaction-pick">
                    <Text style={styles.pickerEmoji}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {/* The Hub's own emojis: pick an Ancestry colour, then a face (25 Oct 2026) */}
              <View style={[styles.pickerRow, styles.ancestryRow, { borderColor: colors.border }]}>
                {ANCESTRIES.map((a) => (
                  <TouchableOpacity
                    key={a.key}
                    onPress={() => setAncestry(a.key)}
                    style={[styles.ancestryChip, { borderColor: ancestry === a.key ? colors.primary : 'transparent' }]}
                    accessibilityLabel={`${a.label} colour`}
                    testID="chat-emoji-ancestry"
                  >
                    <View style={[styles.ancestryDot, { backgroundColor: a.body, borderColor: a.dark }]} />
                    <Text style={[styles.ancestryText, { color: colors.text }]}>{a.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.pickerRow}>
                {HUB_FACES.map((f) => {
                  const code = `dvk:${f.key}:${ancestry}`;
                  return (
                    <TouchableOpacity key={code} onPress={() => react(code)} disabled={busy} style={styles.pickerItem} accessibilityLabel={`React with ${hubEmojiLabel(code)}`} testID="chat-hub-emoji">
                      <ReactionGlyph value={code} size={28} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}
        </View>
        {canReact ? (
          <TouchableOpacity
            onPress={() => setPickerFor(pickerFor === m.id ? null : m.id)}
            style={styles.reactButton}
            accessibilityLabel="React"
            testID="chat-react"
          >
            <Text style={[styles.reactIcon, { color: colors.secondaryText }]}>☺</Text>
          </TouchableOpacity>
        ) : null}
      </View>,
    );
    prev = m;
  }
  return <>{out}</>;
}

const styles = StyleSheet.create({
  dayRow: { alignItems: 'center', marginTop: 14, marginBottom: 6 },
  systemLine: { fontSize: 13, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12, borderWidth: 1, overflow: 'hidden', textAlign: 'center' },
  day: { fontSize: 12, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#ffffff', fontWeight: '700' },
  avatarRoom: { width: 32 },
  column: { maxWidth: '78%', flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  chip: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 1 },
  chipText: { fontSize: 13 },
  picker: { marginTop: 4, borderRadius: 14, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 4, maxWidth: 330, gap: 4 },
  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  ancestryRow: { borderTopWidth: 1, paddingTop: 4, gap: 4 },
  ancestryChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 4, paddingVertical: 1 },
  ancestryDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1 },
  ancestryText: { fontSize: 11 },
  pickerItem: { paddingHorizontal: 4, paddingVertical: 2 },
  pickerEmoji: { fontSize: 22 },
  reactButton: { alignSelf: 'center', paddingHorizontal: 4, opacity: 0.6 },
  reactIcon: { fontSize: 18 },
  bubble: { maxWidth: '100%', borderRadius: 14, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 11 },
  author: { fontSize: 13, fontWeight: '700', marginBottom: 1 },
  text: { fontSize: 15, lineHeight: 21 },
  timeRoom: { fontSize: 11, color: 'transparent', userSelect: 'none' },
  time: { position: 'absolute', right: 10, bottom: 5, fontSize: 11, opacity: 0.7 },
});
