/**
 * ChatDock.web.js - the chat as a window over the Hub (website; Raphael,
 * 22-23 Oct 2026).
 *
 *   - A small 💬 tab on the right edge opens it (half-way down, where it
 *     doesn't cover buttons - a bubble at the bottom right covered Ask
 *     Devi's button and the Danger zone switch); it shows how many
 *     messages and group posts are unread.
 *   - On a narrow screen (a phone) there's no tab - it covered buttons like
 *     the "My wallets" switch. The chat opens from ☰ > Chat (or G C), and
 *     the ☰ button and the menu's "Chat" show the unread count (24 Oct 2026).
 *   - On a narrow screen (a phone) there's no tab: it covered buttons like
 *     the "My wallets" switch. The chat opens from the ☰ menu's "Chat" (or
 *     G C), and ☰ and "Chat" show the unread count (24 Oct 2026).
 *   - The window stays open while you switch sections of the Hub. "—"
 *     makes it the bubble again, "⤢" fills the screen (and back). On a
 *     narrow screen (a phone) it always fills the screen.
 *   - There is only ever one chat (ChatScreen.js) running: it stays
 *     mounted while minimised, so it keeps checking for new mail in the
 *     background and the bubble's count stays current.
 *   - Nothing runs in the background for someone who has never used the
 *     chat in this browser: the chat only starts when the bubble is first
 *     tapped. After that (a remembered flag), it starts with the Hub.
 *
 * Opened from elsewhere through src/web/chatDock.js (☰ menu, G C).
 */
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import ChatView from './ChatView';
import { setChatDockOpener, whenHubReady, setChatUnread } from '../web/chatDock';
import { useWebKeyboardRoom } from '../web/keyboardRoom';

// Remembered in this browser once the chat is set up here (signed in), so
// it can start in the background with the Hub next time.
const ACTIVE_FLAG = 'devi-hub-chat-active';
const NARROW = 640;

function readFlag() {
  try {
    return window.localStorage.getItem(ACTIVE_FLAG) === '1';
  } catch (e) {
    return false;
  }
}
function writeFlag(on) {
  try {
    if (on) window.localStorage.setItem(ACTIVE_FLAG, '1');
    else window.localStorage.removeItem(ACTIVE_FLAG);
  } catch (e) {
    // (private window etc.: the chat then starts when the bubble is tapped)
  }
}

export default function ChatDock() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // 'closed' (the bubble) | 'window' | 'full'
  const [mode, setMode] = useState('closed');
  const [started, setStarted] = useState(() => readFlag());
  const [unread, setUnread] = useState(0);
  // Nothing (no bubble, no chat) until the Hub itself has started.
  const [hubReady, setHubReadyState] = useState(false);
  useEffect(() => whenHubReady(() => setHubReadyState(true)), []);

  const open = () => {
    setStarted(true);
    setMode((m) => (m === 'closed' ? 'window' : m));
  };
  useEffect(() => {
    setChatDockOpener(open);
    return () => setChatDockOpener(null);
  }, []);

  const narrow = width < NARROW;
  const keyboardRoom = useWebKeyboardRoom();
  const isOpen = mode !== 'closed';
  const full = mode === 'full' || narrow;

  if (!hubReady) return null;
  return (
    <>
      {started ? (
        <View
          testID="chat-dock"
          style={[
            styles.window,
            full ? styles.full : styles.floating,
            { backgroundColor: colors.background, borderColor: colors.border },
            // (a phone's keyboard: the chat window ends above it - src/web/keyboardRoom.js)
            keyboardRoom ? { bottom: (full ? 0 : 16) + keyboardRoom, maxHeight: `calc(100vh - ${(full ? 0 : 32) + keyboardRoom}px)` } : null,
            !isOpen && styles.hidden,
          ]}
        >
          <View style={[styles.bar, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
            <Text style={[styles.barTitle, { color: colors.text }]} numberOfLines={1}>
              💬 Chat{unread > 0 ? ` · ${unread} new` : ''}
            </Text>
            {!narrow ? (
              <TouchableOpacity
                onPress={() => setMode(mode === 'full' ? 'window' : 'full')}
                style={styles.barButton}
                accessibilityLabel={mode === 'full' ? 'Smaller window' : 'Fill the screen'}
                testID="chat-dock-size"
              >
                <Text style={[styles.barButtonText, { color: colors.text }]}>{mode === 'full' ? '⤡' : '⤢'}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={() => setMode('closed')} style={styles.barButton} accessibilityLabel="Minimise the chat" testID="chat-dock-minimise">
              <Text style={[styles.barButtonText, { color: colors.text }]}>—</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.body}>
            <ChatView
              onClose={() => setMode('closed')}
              onUnreadChange={(n) => {
                setUnread(n);
                setChatUnread(n);
              }}
              onSetUpChange={(ready) => writeFlag(ready)}
              visible={isOpen}
            />
          </View>
        </View>
      ) : null}

      {!isOpen && !narrow ? (
        <TouchableOpacity
          testID="chat-bubble"
          onPress={open}
          style={[styles.bubble, { backgroundColor: colors.primary }]}
          accessibilityLabel={unread > 0 ? `Chat, ${unread} new` : 'Chat'}
        >
          <Text style={styles.bubbleIcon}>💬</Text>
          {unread > 0 ? (
            <View style={[styles.badge, { backgroundColor: colors.cancelText }]} testID="chat-bubble-count">
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  window: { position: 'fixed', zIndex: 50, overflow: 'hidden', borderWidth: 1 },
  floating: {
    right: 16,
    bottom: 16,
    width: 400,
    height: 600,
    maxHeight: 'calc(100vh - 32px)',
    borderRadius: 14,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
  },
  full: { top: 0, left: 0, right: 0, bottom: 0, borderWidth: 0 },
  hidden: { display: 'none' },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 36, borderBottomWidth: 1, gap: 6 },
  barTitle: { flex: 1, fontSize: 14, fontWeight: '700' },
  barButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  barButtonText: { fontSize: 18, fontWeight: '700' },
  body: { flex: 1 },
  bubble: {
    position: 'fixed',
    zIndex: 50,
    right: 0,
    top: '45%',
    width: 38,
    height: 64,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  bubbleIcon: { fontSize: 20 },
  badge: { position: 'absolute', top: -8, left: -8, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
