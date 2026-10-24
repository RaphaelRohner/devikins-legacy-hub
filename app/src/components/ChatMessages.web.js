/**
 * ChatMessages.web.js - the messages of a 1:1 chat or a group, laid out like
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
 * items: [{ id, mine, author (who - for grouping and colour), nickname, text, at }]
 */
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';

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

export default function ChatMessages({ items, showAuthors = false }) {
  const { colors, isDark } = useTheme();
  const nameColors = isDark ? NAME_COLORS_DARK : NAME_COLORS_LIGHT;
  const otherBubble = isDark ? '#26262c' : '#eceef3';
  const out = [];
  let prev = null;
  for (const m of items) {
    const newDay = !prev || dayKey(prev.at) !== dayKey(m.at);
    if (newDay) {
      out.push(
        <View key={`day-${m.id}`} style={styles.dayRow} testID="chat-day">
          <Text style={[styles.day, { color: colors.secondaryText, backgroundColor: otherBubble }]}>{dayLine(m.at)}</Text>
        </View>,
      );
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
    out.push(
      <View
        key={m.id}
        style={[styles.line, { justifyContent: m.mine ? 'flex-end' : 'flex-start', marginTop: newDay ? 0 : together ? 2 : 10 }]}
      >
        {showAuthors && !m.mine ? (
          together ? <View style={styles.avatarRoom} /> : <Avatar name={name} />
        ) : null}
        {bubble}
      </View>,
    );
    prev = m;
  }
  return <>{out}</>;
}

const styles = StyleSheet.create({
  dayRow: { alignItems: 'center', marginTop: 14, marginBottom: 6 },
  day: { fontSize: 12, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#ffffff', fontWeight: '700' },
  avatarRoom: { width: 32 },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 11 },
  author: { fontSize: 13, fontWeight: '700', marginBottom: 1 },
  text: { fontSize: 15, lineHeight: 21 },
  timeRoom: { fontSize: 11, color: 'transparent', userSelect: 'none' },
  time: { position: 'absolute', right: 10, bottom: 5, fontSize: 11, opacity: 0.7 },
});
