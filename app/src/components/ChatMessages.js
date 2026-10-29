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
 *   - editing and deleting my own messages (29 Oct 2026, Raphael: "like in
 *     Telegram"): on a phone, tap or keep a finger on your message; on the
 *     website, move the mouse over it and click ⋯. The options: ✏️ Edit
 *     (at most twice, within 24 hours) and 🗑️ Delete (always, after a
 *     "really?"). An edited message shows "edited" next to its time; a
 *     deleted one stays as "Message deleted".
 *
 * items: [{ id, mine, author (who - for grouping and colour), nickname, text, at,
 *           pid, reactions: { counts: { emoji: n }, mine: emoji | '' },
 *           edited, deleted, canEdit, canDelete, editsLeft }]
 * onReact(pid, emoji) - reactions on (groups); left out: none (1:1 chats)
 * onEdit(item, text) / onDelete(item) - editing and deleting my own messages
 *   (both chats); each returns a promise of true when it worked
 * scrollRef - the chat's ScrollView: what opens under the LAST message (the
 *   emojis, the options, the edit box) is scrolled into view, and the edit box
 *   stays above the phone's keyboard (Raphael, 29 Oct 2026)
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Pressable, Platform, Keyboard, StyleSheet } from 'react-native';
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
  // ("+1" is letters, not an emoji: bold, so it reads as a sign)
  // (red and slanted, like a handwritten +1 - Raphael, 29 Oct 2026)
  if (value === '+1') return <Text style={{ fontSize: size * 0.8, fontWeight: '800', fontStyle: 'italic', color: PLUS_ONE_RED }}>+1</Text>;
  return <Text style={{ fontSize: size * 0.85 }}>{value}</Text>;
}

const PLUS_ONE_RED = '#e53935';

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

// Blank room at the end of a message for the time shown in the bubble's
// corner: one normal space (so the room may move to its own line), then
// "figure spaces" (U+2007, each as wide as a digit and never visible) -
// a few more than the time has characters, for the gap and for "PM".
function timeRoom(time) {
  return ' ' + '\u2007'.repeat(time.length + 2);
}

export function Avatar({ name, size = 32 }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: NAME_COLORS_LIGHT[colorIndex(name)] }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>{initials(name)}</Text>
    </View>
  );
}

export default function ChatMessages({ items, showAuthors = false, onReact = null, onEdit = null, onDelete = null, busy = false, scrollRef = null }) {
  const { colors, isDark } = useTheme();
  const [pickerFor, setPickerFor] = useState(null);
  // Editing and deleting (29 Oct 2026): the message whose options are open,
  // the one under the mouse (website), the one being edited (and its text),
  // and the one waiting for "really delete?".
  const [menuFor, setMenuFor] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const closeOptions = () => {
    setMenuFor(null);
    setConfirmDelete(null);
  };

  // Making room (29 Oct 2026): where each line sits in the chat (from its
  // layout), so whatever opens under a message can be scrolled into view.
  const lineY = useRef({});
  const lastId = items.length ? items[items.length - 1].id : null;
  const opened = pickerFor ?? menuFor ?? confirmDelete ?? editing?.id ?? null;
  useEffect(() => {
    if (opened === null || opened !== lastId || !scrollRef?.current) return undefined;
    // (after the new part has its size)
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [opened, lastId, scrollRef, confirmDelete]);
  // The edit box: once the phone's keyboard is up, the message being edited
  // goes to the top of what's left of the chat, so the keyboard never covers it.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId === null || !scrollRef?.current) return undefined;
    const reveal = () => {
      const y = lineY.current[editingId];
      if (typeof y === 'number') scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    };
    const timer = setTimeout(reveal, 300);
    const sub = Keyboard.addListener('keyboardDidShow', () => setTimeout(reveal, 50));
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [editingId, scrollRef]);
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
    const time = m.edited && !m.deleted ? `edited ${clock(m.at)}` : clock(m.at);
    const textColor = m.mine ? colors.primaryText : colors.text;
    const changeable = !m.deleted && ((m.canEdit && !!onEdit) || (m.canDelete && !!onDelete));
    const isEditing = editing?.id === m.id;
    const openOptions = () => {
      if (!changeable || busy) return;
      setPickerFor(null);
      setConfirmDelete(null);
      setMenuFor(menuFor === m.id ? null : m.id);
    };
    const saveEdit = async () => {
      const ok = await onEdit(m, editing.text);
      if (ok !== false) setEditing(null);
    };
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
        {isEditing ? (
          <View style={styles.editBox}>
            <TextInput
              value={editing.text}
              onChangeText={(text) => setEditing({ id: m.id, text })}
              multiline
              autoFocus
              maxLength={2000}
              style={[styles.editInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              accessibilityLabel="Edit your message"
              testID="chat-edit-input"
            />
            <View style={styles.editButtons}>
              <TouchableOpacity onPress={() => setEditing(null)} style={styles.optionButton} testID="chat-edit-cancel">
                <Text style={[styles.optionText, { color: textColor }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveEdit}
                disabled={busy || !editing.text.trim()}
                style={[styles.optionButton, { backgroundColor: colors.background }]}
                testID="chat-edit-save"
              >
                <Text style={[styles.optionText, { color: colors.text, fontWeight: '700' }]}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : m.deleted ? (
          <Text style={[styles.text, styles.deletedText, { color: textColor }]} testID="chat-message-deleted">
            🗑️ Message deleted
            <Text style={styles.timeRoom}>{timeRoom(time)}</Text>
          </Text>
        ) : (
          <Text selectable style={[styles.text, { color: textColor }]}>
            {m.text}
            {/* (room for the time, so it never covers the last word. Blank
                "figure spaces" (each as wide as a digit) rather than the time
                in see-through colour: on Android the see-through copy
                sometimes showed as a shadow behind the real time - Raphael,
                29 Oct 2026) */}
            <Text style={styles.timeRoom}>{timeRoom(time)}</Text>
          </Text>
        )}
        {isEditing ? null : <Text style={[styles.time, { color: textColor }]}>{time}</Text>}
      </View>
    );
    // My own message: tap or keep pressed (phone), or ⋯ (website) opens the options.
    const pressableBubble = changeable && !isEditing ? (
      <Pressable
        onPress={Platform.OS === 'web' ? undefined : openOptions}
        onLongPress={openOptions}
        delayLongPress={350}
        accessibilityHint="Opens the options: edit or delete"
        testID="chat-message-press"
      >
        {bubble}
      </Pressable>
    ) : bubble;
    const options = menuFor === m.id && changeable ? (
      <View style={[styles.options, { backgroundColor: otherBubble, borderColor: colors.border }]} testID="chat-msg-options">
        {confirmDelete === m.id ? (
          <>
            <Text style={[styles.optionText, { color: colors.text }]}>Delete for everyone?</Text>
            <TouchableOpacity
              onPress={async () => {
                const ok = await onDelete(m);
                if (ok !== false) closeOptions();
              }}
              disabled={busy}
              style={[styles.optionButton, { backgroundColor: colors.cancelText }]}
              testID="chat-msg-delete-yes"
            >
              <Text style={[styles.optionText, { color: '#fff', fontWeight: '700' }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setConfirmDelete(null)} style={styles.optionButton} testID="chat-msg-delete-no">
              <Text style={[styles.optionText, { color: colors.text }]}>Keep</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {m.canEdit && onEdit ? (
              <TouchableOpacity
                onPress={() => {
                  closeOptions();
                  setEditing({ id: m.id, text: m.text });
                }}
                style={styles.optionButton}
                testID="chat-msg-edit"
              >
                <Text style={[styles.optionText, { color: colors.text }]}>
                  ✏️ Edit{m.editsLeft === 1 ? ' (last time)' : ''}
                </Text>
              </TouchableOpacity>
            ) : null}
            {m.canDelete && onDelete ? (
              <TouchableOpacity onPress={() => setConfirmDelete(m.id)} style={styles.optionButton} testID="chat-msg-delete">
                <Text style={[styles.optionText, { color: colors.text }]}>🗑️ Delete</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={closeOptions} style={styles.optionButton} accessibilityLabel="Close the options" testID="chat-msg-options-close">
              <Text style={[styles.optionText, { color: colors.secondaryText }]}>✕</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    ) : null;
    // Website: ⋯ next to my message while the mouse is over it (or its options are open).
    const moreButton = Platform.OS === 'web' && changeable && !isEditing ? (
      <TouchableOpacity
        onPress={openOptions}
        style={[styles.moreButton, { opacity: hoverId === m.id || menuFor === m.id ? 1 : 0 }]}
        accessibilityLabel="Options: edit or delete"
        testID="chat-msg-more"
      >
        <Text style={[styles.reactIcon, { color: colors.secondaryText }]}>⋯</Text>
      </TouchableOpacity>
    ) : null;
    // (codes of Hub emojis this version doesn't know yet are left out)
    const counts = m.deleted ? [] : Object.entries(m.reactions?.counts || {}).filter(([v, n]) => n > 0 && (REACTIONS.includes(v) || isHubEmoji(v)));
    const canReact = !!onReact && !m.mine && !!m.pid && !m.deleted;
    const react = (emoji) => {
      setPickerFor(null);
      onReact(m.pid, emoji);
    };
    out.push(
      <Pressable
        key={m.id}
        onLayout={(e) => { lineY.current[m.id] = e.nativeEvent.layout.y; }}
        // (website: the mouse over a line shows its ⋯; nothing happens on a click here)
        onHoverIn={changeable ? () => setHoverId(m.id) : undefined}
        onHoverOut={changeable ? () => setHoverId((h) => (h === m.id ? null : h)) : undefined}
        focusable={false}
        style={[styles.line, { justifyContent: m.mine ? 'flex-end' : 'flex-start', marginTop: newDay ? 0 : together ? 2 : 10 }]}
      >
        {showAuthors && !m.mine ? (
          together ? <View style={styles.avatarRoom} /> : <Avatar name={name} />
        ) : null}
        {m.mine ? moreButton : null}
        <View style={[styles.column, { alignItems: m.mine ? 'flex-end' : 'flex-start' }]}>
          {pressableBubble}
          {options}
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
                    <ReactionGlyph value={emoji} size={26} />
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
      </Pressable>,
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
  reactButton: { alignSelf: 'center', paddingHorizontal: 4, opacity: 0.6 },
  // Editing and deleting (29 Oct 2026)
  moreButton: { alignSelf: 'center', paddingHorizontal: 6 },
  options: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 4, borderRadius: 14, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 3 },
  optionButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  optionText: { fontSize: 14 },
  editBox: { gap: 6, minWidth: 220 },
  editInput: { fontSize: 15, lineHeight: 21, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, minHeight: 44, maxHeight: 200 },
  editButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6 },
  deletedText: { fontStyle: 'italic', opacity: 0.8 },
  reactIcon: { fontSize: 18 },
  bubble: { maxWidth: '100%', borderRadius: 14, paddingTop: 6, paddingBottom: 6, paddingHorizontal: 11 },
  author: { fontSize: 13, fontWeight: '700', marginBottom: 1 },
  text: { fontSize: 15, lineHeight: 21 },
  timeRoom: { fontSize: 11, userSelect: 'none' },
  time: { position: 'absolute', right: 10, bottom: 5, fontSize: 11, opacity: 0.7 },
});
