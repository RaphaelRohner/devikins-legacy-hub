/**
 * ChatView.web.js — the Chat screen (website)
 *
 * Stage 2a of the chat (design: CHAT-DESIGN-DRAFT.md in the claude.ai
 * project). Players who hold at least one Devikin sign in once with the
 * Klever browser extension (signing a text, no transaction), pick a
 * nickname, find each other, send contact requests and write 1:1.
 *
 * All the chat logic lives in app/chat (the portable chat core, through
 * src/api/chatStore.js); this file is only the screen. Messages are sealed
 * on this computer and opened on the receiver's; the "blind postman" in
 * between can't read them. History is kept only in this browser.
 *
 * While the screen is open it looks for new mail every few seconds
 * (MAIL_CHECK_EVERY_MS). On the phone the chat comes later (ChatView.js).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Alert, BackHandler,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { getMessenger } from '../api/chatStore';
import { isExtensionAvailable, signTextWithExtension } from '../api/kleverExtension';
import { MAIL_CHECK_EVERY_MS } from '../constants/chat';
import { CONTACT_STATUS } from '../../chat/src/index.js';
import { MAX_TEXT_LENGTH, nicknameKey } from '../../chat/src/rules.js';

function timeLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hhmm;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hhmm}`;
}

function minutesUntil(ms) {
  const min = Math.ceil((ms - Date.now()) / 60000);
  if (min >= 120) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.max(1, min)} min`;
}

export default function ChatView({ onClose }) {
  const { colors } = useTheme();
  const [messenger, setMessenger] = useState(null);
  const [status, setStatus] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mailProblem, setMailProblem] = useState('');
  const [nickname, setNickname] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState(null);
  const [draft, setDraft] = useState('');
  const openIdRef = useRef(null);
  openIdRef.current = openId;
  const scrollRef = useRef(null);

  const refresh = useCallback(async (m) => {
    const s = await m.status();
    setStatus(s);
    if (s.state === 'ready' || s.state === 'signed-out') setContacts(await m.listContacts());
    if (openIdRef.current) setThread(await m.messages(openIdRef.current));
    return s;
  }, []);

  // Start: open the chat's database and see where this browser stands.
  useEffect(() => {
    let alive = true;
    getMessenger()
      .then(async (m) => {
        if (!alive) return;
        setMessenger(m);
        await refresh(m);
      })
      .catch((e) => alive && setError(`The chat could not start: ${e?.message || e}`));
    return () => {
      alive = false;
    };
  }, [refresh]);

  // Look for new mail while the screen is open (and once right away).
  const checkMail = useCallback(async () => {
    if (!messenger) return;
    try {
      await messenger.checkMail();
      setMailProblem('');
    } catch (e) {
      setMailProblem(e?.message || String(e));
    }
    await refresh(messenger).catch(() => {});
  }, [messenger, refresh]);

  const isReady = status?.state === 'ready';
  useEffect(() => {
    if (!isReady) return undefined;
    checkMail();
    const timer = setInterval(checkMail, MAIL_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [isReady, checkMail]);

  // Back (browser or phone) closes an open conversation first.
  useEffect(() => {
    if (!openId) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpenId(null);
      return true;
    });
    return () => sub.remove();
  }, [openId]);

  // Once a contact can be reached again (e.g. they unblocked you), the
  // old "isn't receiving your messages" error line goes away too.
  const openEnded = openId ? contacts.find((c) => c.id === openId)?.ended : undefined;
  const wasEnded = useRef(false);
  useEffect(() => {
    if (wasEnded.current && openEnded === false) setError('');
    wasEnded.current = !!openEnded;
  }, [openEnded]);

  async function act(fn) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
      if (messenger) await refresh(messenger).catch(() => {});
    }
  }

  const signIn = () => act(async () => {
    const { code, text } = await messenger.startSignIn();
    const { address, signature } = await signTextWithExtension(text);
    await messenger.finishSignIn({ code, wallet: address, signature });
  });

  const saveNickname = () => act(async () => {
    await messenger.setNickname(nickname.trim());
  });

  const findPlayers = () => act(async () => {
    setResults(await messenger.findPlayers(search.trim()));
  });

  const ask = (name) => act(async () => {
    await messenger.requestContact(name);
    setResults(null);
    setSearch('');
  });

  const openThread = (id) => act(async () => {
    setThread(await messenger.messages(id));
    setOpenId(id);
    setDraft('');
  });

  const send = () => {
    const text = draft;
    if (!text.trim() || busy) return;
    act(async () => {
      await messenger.sendMessage(openId, text);
      setDraft('');
    });
  };

  function confirm(title, message, okLabel, onOk) {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: okLabel, style: 'destructive', onPress: onOk },
    ]);
  }

  const header = (title, onBack) => (
    <View style={styles.topRow}>
      <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onBack} accessibilityLabel="Back">
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
    </View>
  );

  const button = (label, onPress, { disabled = false, quiet = false, testID } = {}) => (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      style={[
        styles.button,
        quiet ? { borderWidth: 1, borderColor: colors.border } : { backgroundColor: colors.primary },
        (disabled || busy) && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.buttonText, { color: quiet ? colors.text : colors.primaryText }]}>{label}</Text>
    </TouchableOpacity>
  );

  const errorLine = error ? <Text style={[styles.note, { color: colors.cancelText }]} testID="chat-error">{error}</Text> : null;
  const card = (children) => (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
  );

  // --- starting up ---
  if (!status) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('Chat', onClose)}
        {error ? card(errorLine) : <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />}
      </View>
    );
  }

  // --- sign in ---
  if (status.state === 'signed-out') {
    const hasExtension = isExtensionAvailable();
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('Chat', onClose)}
        <ScrollView contentContainerStyle={styles.scroll}>
          {card(
            <>
              <Text style={[styles.text, { color: colors.text }]}>
                Chat with other Devikins players: 1:1 for now, groups are coming. Only for wallets that hold at least one
                Devikin.
              </Text>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                {'• Messages are sealed on your computer and opened only on the other player\'s. The Hub\'s "postman" in between can\'t read them.\n'
                  + '• Your chat history is kept only in this browser.\n'
                  + '• Your wallet address is never shown to other players.'}
              </Text>
              {status.expired ? (
                <Text style={[styles.text, { color: colors.text, fontWeight: '700' }]}>
                  Once a week the Hub checks again that your wallet holds Devikins. Please sign in again with the same wallet.
                </Text>
              ) : null}
              {hasExtension ? (
                <>
                  <Text style={[styles.note, { color: colors.secondaryText }]}>
                    Signing in: your Klever extension asks you to sign a short text. It is NOT a transaction: it costs nothing
                    and moves nothing. It only shows that you hold Devikins.
                  </Text>
                  {button(busy ? 'Waiting for the extension…' : 'Sign in with the Klever extension', signIn, { testID: 'chat-sign-in' })}
                </>
              ) : (
                <Text style={[styles.text, { color: colors.text }]}>
                  To sign in, you need the Klever Wallet browser extension (for Chrome, Brave or Edge) with the wallet that
                  holds your Devikins. Install it, open it once, then reload this page.
                </Text>
              )}
              {errorLine}
            </>,
          )}
        </ScrollView>
      </View>
    );
  }

  // --- nickname ---
  if (status.state === 'needs-nickname') {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header('Chat', onClose)}
        <ScrollView contentContainerStyle={styles.scroll}>
          {card(
            <>
              <Text style={[styles.text, { color: colors.text, fontWeight: '700' }]}>Choose your nickname</Text>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Tip: use your in-game name, so other players can find you. 2 to 20 letters or digits (spaces, _ . - in
                between are fine). First come, first served.
              </Text>
              <TextInput
                testID="chat-nickname"
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                value={nickname}
                onChangeText={setNickname}
                placeholder="Nickname"
                placeholderTextColor={colors.secondaryText}
                maxLength={20}
                onSubmitEditing={saveNickname}
              />
              {button('Save nickname', saveNickname, { disabled: nickname.trim().length < 2, testID: 'chat-save-nickname' })}
              {errorLine}
            </>,
          )}
        </ScrollView>
      </View>
    );
  }

  // --- one conversation ---
  const open = openId ? contacts.find((c) => c.id === openId) : null;
  if (open) {
    const isBlocked = open.status === CONTACT_STATUS.BLOCKED;
    const canWrite = open.status === CONTACT_STATUS.ACCEPTED;
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header(open.nickname, () => setOpenId(null))}
        <View style={styles.threadActions}>
          {isBlocked
            ? button('Unblock', () => act(() => messenger.unblockContact(open.id)), { quiet: true })
            : button('Block', () => confirm(`Block ${open.nickname}?`, 'They can\'t send you anything until you unblock them. They aren\'t told.', 'Block', () => act(() => messenger.blockContact(open.id))), { quiet: true })}
          {button('Remove', () => confirm(`Remove ${open.nickname}?`, 'The contact and your messages with them are deleted from this browser, and they can\'t write to you any more.', 'Remove', () => act(async () => {
            await messenger.removeContact(open.id);
            setOpenId(null);
          })), { quiet: true })}
        </View>
        <ScrollView
          ref={scrollRef}
          style={styles.thread}
          contentContainerStyle={styles.threadContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {thread.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText, textAlign: 'center' }]}>
              {open.status === CONTACT_STATUS.OUTGOING ? `Waiting for ${open.nickname} to accept your request.` : 'No messages yet.'}
            </Text>
          ) : null}
          {thread.map((m) => (
            <View
              key={m.id}
              style={[
                styles.bubble,
                m.mine
                  ? { alignSelf: 'flex-end', backgroundColor: colors.primary }
                  : { alignSelf: 'flex-start', backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderWidth: 1 },
              ]}
            >
              <Text selectable style={[styles.bubbleText, { color: m.mine ? colors.primaryText : colors.text }]}>{m.text}</Text>
              <Text style={[styles.bubbleTime, { color: m.mine ? colors.primaryText : colors.secondaryText }]}>{timeLabel(m.mine ? m.sentAt : m.receivedAt)}</Text>
            </View>
          ))}
        </ScrollView>
        {open.ended ? (
          <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>
            {open.nickname} isn't receiving your messages at the moment (they left the chat or blocked you).
          </Text>
        ) : null}
        {isBlocked ? <Text style={[styles.note, styles.pad, { color: colors.secondaryText }]}>You blocked {open.nickname}.</Text> : null}
        {errorLine ? <View style={styles.pad}>{errorLine}</View> : null}
        {canWrite ? (
          <View style={[styles.composer, { borderColor: colors.border }]}>
            <TextInput
              testID="chat-draft"
              style={[styles.input, styles.draft, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              value={draft}
              onChangeText={setDraft}
              placeholder={`Message to ${open.nickname}`}
              placeholderTextColor={colors.secondaryText}
              maxLength={MAX_TEXT_LENGTH}
              onSubmitEditing={send}
              blurOnSubmit={false}
            />
            {button('Send', send, { disabled: !draft.trim(), testID: 'chat-send' })}
          </View>
        ) : null}
      </View>
    );
  }

  // --- the overview: requests, contacts, find players ---
  const incoming = contacts.filter((c) => c.status === CONTACT_STATUS.INCOMING);
  const others = contacts.filter((c) => c.status !== CONTACT_STATUS.INCOMING);
  const pausedUntil = status.nextRequestAt > Date.now() ? status.nextRequestAt : 0;
  const known = new Set(contacts.map((c) => nicknameKey(c.nickname)));

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {header(`Chat · ${status.nickname}`, onClose)}
      <ScrollView contentContainerStyle={styles.scroll}>
        {mailProblem ? <Text style={[styles.note, styles.pad, { color: colors.cancelText }]}>{mailProblem}</Text> : null}
        {errorLine ? <View style={styles.pad}>{errorLine}</View> : null}

        {incoming.length > 0 ? card(
          <>
            <Text style={[styles.section, { color: colors.text }]}>Contact requests</Text>
            {incoming.map((c) => (
              <View key={c.id} style={styles.row} testID="chat-request">
                <Text style={[styles.rowName, { color: colors.text }]}>{c.nickname}</Text>
                {button('Accept', () => act(() => messenger.acceptContact(c.id)), { testID: 'chat-accept' })}
                {button('Decline', () => act(() => messenger.declineContact(c.id)), { quiet: true })}
              </View>
            ))}
          </>,
        ) : null}

        {card(
          <>
            <Text style={[styles.section, { color: colors.text }]}>Contacts</Text>
            {others.length === 0 ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>No contacts yet. Find a player below and ask them to chat.</Text>
            ) : null}
            {others.map((c) => (
              <TouchableOpacity key={c.id} style={[styles.row, styles.contactRow, { borderColor: colors.border }]} onPress={() => openThread(c.id)} testID="chat-contact">
                <Text style={[styles.rowName, { color: colors.text }]}>{c.nickname}</Text>
                {c.status === CONTACT_STATUS.OUTGOING ? <Text style={[styles.note, { color: colors.secondaryText }]}>waiting for answer</Text> : null}
                {c.status === CONTACT_STATUS.BLOCKED ? <Text style={[styles.note, { color: colors.secondaryText }]}>blocked</Text> : null}
                {c.unread > 0 ? (
                  <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                    <Text style={[styles.badgeText, { color: colors.primaryText }]}>{c.unread}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))}
          </>,
        )}

        {card(
          <>
            <Text style={[styles.section, { color: colors.text }]}>Find a player</Text>
            <View style={styles.row}>
              <TextInput
                testID="chat-search"
                style={[styles.input, { flex: 1, color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                value={search}
                onChangeText={setSearch}
                placeholder="Nickname (empty: everyone)"
                placeholderTextColor={colors.secondaryText}
                maxLength={20}
                onSubmitEditing={findPlayers}
              />
              {button('Search', findPlayers, { testID: 'chat-search-button' })}
            </View>
            {pausedUntil ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Next contact request possible in {minutesUntil(pausedUntil)} (the pause grows with each request: 5, 10, 20 … minutes,
                and starts over after a day).
              </Text>
            ) : null}
            {results && results.length === 0 ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>No player found. Nicknames are listed once a player has signed in.</Text>
            ) : null}
            {(results || []).map((p) => (
              <View key={p.nickname} style={styles.row} testID="chat-result">
                <Text style={[styles.rowName, { color: colors.text }]}>{p.nickname}</Text>
                {known.has(nicknameKey(p.nickname))
                  ? <Text style={[styles.note, { color: colors.secondaryText }]}>in your contacts</Text>
                  : button('Ask to chat', () => ask(p.nickname), { disabled: !!pausedUntil, testID: 'chat-ask' })}
              </View>
            ))}
          </>,
        )}

        <View style={styles.pad}>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Signed in until {new Date(status.verifiedUntil).toLocaleDateString()} (checked weekly). Your chat history is
            kept only in this browser.
          </Text>
          <TouchableOpacity
            onPress={() => Alert.alert(
              'Leave the chat in this browser?',
              'Your contacts and messages here are deleted.\n\n'
                + '"Only this browser": the chat keeps working in the other browser where you brought it with a backup.\n\n'
                + '"Leave the chat": the postman forgets this chat key everywhere, and your nickname is freed if this was its only browser. You can sign in again later.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Leave the chat', style: 'destructive', onPress: () => act(() => messenger.leave()) },
                { text: 'Only this browser', onPress: () => act(() => messenger.forgetHere()) },
              ],
            )}
            testID="chat-leave"
          >
            <Text style={[styles.note, { color: colors.cancelText, textDecorationLine: 'underline', marginTop: 8 }]}>Leave the chat in this browser</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  scroll: { paddingBottom: 24, gap: 12 },
  card: { marginHorizontal: 12, padding: 16, borderRadius: 12, borderWidth: 1, gap: 12, maxWidth: 720 },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18 },
  section: { fontSize: 16, fontWeight: '700' },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  contactRow: { borderTopWidth: 1, paddingTop: 10 },
  rowName: { flex: 1, fontSize: 15, fontWeight: '600' },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  pad: { marginHorizontal: 12 },
  threadActions: { flexDirection: 'row', gap: 8, marginHorizontal: 12, marginBottom: 8 },
  thread: { flex: 1 },
  threadContent: { padding: 12, gap: 8, maxWidth: 720, width: '100%' },
  bubble: { maxWidth: '80%', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, gap: 2 },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTime: { fontSize: 11, opacity: 0.8, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, alignItems: 'center', maxWidth: 744 },
  draft: { flex: 1 },
});
