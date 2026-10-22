/**
 * ChatGroupView.web.js — open groups in the Chat screen (stage 3, website)
 *
 * GroupsCard: the list on the Chat overview – every open group, the ones
 * you're in first (with new posts counted), "Join" for the others, and
 * "Create a group".
 * ChatGroupView: one group – the owner's pinned message on top, the posts,
 * and the box to write, which says openly when your next post is possible
 * (one post per 24 h ÷ your Devikins, at most one a minute).
 *
 * The logic is in app/chat/src/messenger.js; joining works like this: you
 * ask, and the Hub of the first member that's open hands you the group's
 * key (sealed for you) and lets you in. You see posts from then on.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { MAX_TEXT_LENGTH, postInterval } from '../../chat/src/rules.js';

function timeLabel(ms) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return hhmm;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hhmm}`;
}

function waitLabel(ms) {
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

function intervalLabel(nfts) {
  const ms = postInterval(nfts);
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

function Button({ label, onPress, disabled, quiet, testID }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        quiet ? { borderWidth: 1, borderColor: colors.border } : { backgroundColor: colors.primary },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.buttonText, { color: quiet ? colors.text : colors.primaryText }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function GroupsCard({ groups, busy, onOpen, onJoin, onCreate }) {
  const { colors } = useTheme();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const list = groups || [];
  const mine = list.filter((g) => g.member);
  const others = list.filter((g) => !g.member);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="chat-groups">
      <Text style={[styles.section, { color: colors.text }]}>Groups</Text>
      {groups === null ? <Text style={[styles.note, { color: colors.secondaryText }]}>Loading the groups…</Text> : null}
      {groups && list.length === 0 ? (
        <Text style={[styles.note, { color: colors.secondaryText }]}>No groups yet. Start the first one!</Text>
      ) : null}
      {mine.map((g) => (
        <TouchableOpacity key={g.id} style={[styles.row, styles.groupRow, { borderColor: colors.border }]} onPress={() => onOpen(g.id)} testID="chat-group">
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: colors.text }]}>{g.name}</Text>
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              {g.members} member{g.members === 1 ? '' : 's'}{g.isOwner ? ' · you started it' : ` · by ${g.owner ?? '?'}`}
            </Text>
          </View>
          {g.unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.primary }]}>
              <Text style={[styles.badgeText, { color: colors.primaryText }]}>{g.unread}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ))}
      {others.map((g) => (
        <View key={g.id} style={[styles.row, styles.groupRow, { borderColor: colors.border }]} testID="chat-group-other">
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowName, { color: colors.text }]}>{g.name}</Text>
            {g.description ? <Text style={[styles.note, { color: colors.text }]}>{g.description}</Text> : null}
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              {g.members} member{g.members === 1 ? '' : 's'} · by {g.owner ?? '?'}
              {g.needsKey ? ' · you are in it, but this browser has no key yet' : ''}
            </Text>
          </View>
          {g.needsKey ? (
            <Button label="Get the key" onPress={() => onJoin(g.id)} disabled={busy} testID="chat-group-getkey" />
          ) : g.asking ? (
            <Text style={[styles.note, { color: colors.secondaryText, maxWidth: 220 }]} testID="chat-group-waiting">
              Waiting to be let in – happens as soon as a member's Hub is open.
            </Text>
          ) : (
            <Button label="Join" onPress={() => onJoin(g.id)} disabled={busy} testID="chat-group-join" />
          )}
        </View>
      ))}
      {creating ? (
        <View style={styles.form}>
          <TextInput
            testID="chat-group-name"
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={name}
            onChangeText={setName}
            placeholder="Group name (3–40 characters)"
            placeholderTextColor={colors.secondaryText}
            maxLength={40}
          />
          <TextInput
            testID="chat-group-description"
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={description}
            onChangeText={setDescription}
            placeholder="What it's about (optional)"
            placeholderTextColor={colors.secondaryText}
            maxLength={200}
          />
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Groups are open: every signed-in player sees the name and can join. New members read from the moment they join.
          </Text>
          <View style={styles.row}>
            <Button
              label="Create group"
              testID="chat-group-create"
              disabled={busy || name.trim().length < 3}
              onPress={() => {
                onCreate(name.trim(), description.trim());
                setCreating(false);
                setName('');
                setDescription('');
              }}
            />
            <Button label="Cancel" quiet onPress={() => setCreating(false)} />
          </View>
        </View>
      ) : (
        <TouchableOpacity onPress={() => setCreating(true)} testID="chat-group-new">
          <Text style={[styles.link, { color: colors.primary }]}>+ Create a group</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function ChatGroupView({ group, posts, next, busy, error, onBack, onPost, onPin, onLeave }) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  const [editingPin, setEditingPin] = useState(false);
  const [pinDraft, setPinDraft] = useState('');
  const [, setTick] = useState(0);
  const scrollRef = useRef(null);

  // Keep "next post possible in …" fresh.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const waitMs = next?.allowedAt ? Math.max(0, next.allowedAt - Date.now()) : 0;
  const canPost = next?.allowedAt !== null && next?.allowedAt !== undefined && waitMs === 0;

  const send = async () => {
    if (!draft.trim() || busy || !canPost) return;
    // The text stays in the box if posting fails, so it can be sent again.
    if (await onPost(draft)) setDraft('');
  };

  const leave = () => Alert.alert(
    `Leave ${group.name}?`,
    group.isOwner
      ? 'You started this group: if you leave, it goes to the member who joined first (your pinned message is removed). If you are the last one, the group is deleted.'
      : 'Its posts are deleted from this browser. You can ask to join again later.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: onLeave },
    ],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onBack} accessibilityLabel="Back">
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{group.name}</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            {group.members} member{group.members === 1 ? '' : 's'} · {group.isOwner ? 'you started it' : `by ${group.owner ?? '?'}`}
          </Text>
        </View>
        <Button label="Leave" quiet onPress={leave} disabled={busy} testID="chat-group-leave" />
      </View>

      {group.pinned || group.isOwner ? (
        <View style={[styles.pinned, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]} testID="chat-group-pinned">
          {editingPin ? (
            <>
              <TextInput
                testID="chat-group-pin-draft"
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background, minHeight: 70 }]}
                value={pinDraft}
                onChangeText={setPinDraft}
                multiline
                maxLength={MAX_TEXT_LENGTH}
                placeholder="Rules or important info for everyone (empty: no pinned message)"
                placeholderTextColor={colors.secondaryText}
              />
              <View style={styles.row}>
                <Button label="Save" testID="chat-group-pin-save" disabled={busy} onPress={() => { onPin(pinDraft); setEditingPin(false); }} />
                <Button label="Cancel" quiet onPress={() => setEditingPin(false)} />
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.note, { color: colors.secondaryText, fontWeight: '700' }]}>📌 Pinned by the owner</Text>
              <Text selectable style={[styles.text, { color: colors.text }]}>
                {group.pinned?.text || (group.isOwner ? 'Nothing pinned yet. Pin rules or important info for everyone.' : '')}
              </Text>
              {group.isOwner ? (
                <TouchableOpacity onPress={() => { setPinDraft(group.pinned?.text || ''); setEditingPin(true); }} testID="chat-group-pin-edit">
                  <Text style={[styles.link, { color: colors.primary }]}>{group.pinned ? 'Edit' : 'Pin a message'}</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.thread}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {posts.length === 0 ? (
          <Text style={[styles.note, { color: colors.secondaryText, textAlign: 'center' }]}>No posts yet since you joined.</Text>
        ) : null}
        {posts.map((p) => (
          <View
            key={p.id}
            style={[
              styles.bubble,
              p.mine
                ? { alignSelf: 'flex-end', backgroundColor: colors.primary }
                : { alignSelf: 'flex-start', backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderWidth: 1 },
            ]}
          >
            {!p.mine ? <Text style={[styles.author, { color: colors.text }]}>{p.nickname || 'a former member'}</Text> : null}
            <Text selectable style={[styles.text, { color: p.mine ? colors.primaryText : colors.text }]}>{p.text}</Text>
            <Text style={[styles.time, { color: p.mine ? colors.primaryText : colors.secondaryText }]}>{timeLabel(p.receivedAt)}</Text>
          </View>
        ))}
      </ScrollView>

      {error ? <Text style={[styles.note, styles.pad, { color: colors.cancelText }]} testID="chat-error">{error}</Text> : null}
      <View style={[styles.composer, { borderColor: colors.border }]}>
        <Text style={[styles.note, { color: colors.secondaryText }]} testID="chat-group-limit">
          {next?.allowedAt === null || next?.allowedAt === undefined
            ? 'Please sign in again to post (your weekly check has run out).'
            : waitMs > 0
              ? `Next post possible in ${waitLabel(waitMs)}. With ${next.nfts} Devikin${next.nfts === 1 ? '' : 's'} you can post once every ${intervalLabel(next.nfts)}.`
              : `With ${next.nfts} Devikin${next.nfts === 1 ? '' : 's'} you can post once every ${intervalLabel(next.nfts)}.`}
        </Text>
        <View style={styles.row}>
          <TextInput
            testID="chat-group-draft"
            style={[styles.input, { flex: 1, color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={canPost ? `Post in ${group.name}` : 'Not yet – see above'}
            placeholderTextColor={colors.secondaryText}
            maxLength={MAX_TEXT_LENGTH}
            onSubmitEditing={send}
            blurOnSubmit={false}
            editable={canPost}
          />
          <Button label="Post" onPress={send} disabled={!canPost || !draft.trim() || busy} testID="chat-group-post" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { fontSize: 18, fontWeight: '700' },
  card: { marginHorizontal: 12, padding: 16, borderRadius: 12, borderWidth: 1, gap: 12, maxWidth: 720 },
  section: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 20 },
  note: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  groupRow: { borderTopWidth: 1, paddingTop: 10 },
  rowName: { fontSize: 15, fontWeight: '600' },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
  form: { gap: 10 },
  pinned: { marginHorizontal: 12, padding: 12, borderRadius: 10, borderWidth: 1, gap: 6, maxWidth: 720 },
  thread: { padding: 12, gap: 8, maxWidth: 720, width: '100%' },
  bubble: { maxWidth: '80%', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, gap: 2 },
  author: { fontSize: 12, fontWeight: '700' },
  time: { fontSize: 11, opacity: 0.8, alignSelf: 'flex-end' },
  pad: { marginHorizontal: 12 },
  composer: { padding: 12, borderTopWidth: 1, gap: 8, maxWidth: 744 },
});
