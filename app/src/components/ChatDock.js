/**
 * ChatDock.js - the 💬 handle in the Android app (Raphael, 26 Oct 2026).
 * (The website's chat window is ChatDock.web.js.)
 *
 *   - A small tab on the right edge of every screen; tapping it opens the
 *     chat. The ☰ menu's "Chat" stays as well.
 *   - It can be DRAGGED up or down with a finger when it's in the way, and
 *     the Hub remembers where you left it (also after closing the app).
 *   - It steps aside while the keyboard is open (so it never sits on what
 *     you're typing), on the chat screen itself, and while the Hub starts.
 *     Pop-ups (the ☰ menu, Kleverscan, pictures) cover it.
 *   - No unread count yet: in the app the chat only checks for new mail
 *     while it's open.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, PanResponder, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Storage } from 'expo-sqlite/kv-store';
import { useTheme } from '../context/ThemeContext';
import { openChatScreen, useAppScreen } from '../web/chatDock';

const HEIGHT = 52;
const WIDTH = 44;
const STORE_KEY = 'chat-handle-position'; // 0 = highest, 1 = lowest place
const DEFAULT_POSITION = 0.62; // a bit below the middle
const TAP_SLOP = 8; // moved less than this (pixels): a tap, not a drag

export default function ChatDock() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const screen = useAppScreen();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Where it may go: below the top row, above the system buttons.
  const minY = insets.top + 72;
  const maxY = Math.max(minY, height - insets.bottom - HEIGHT - 24);
  const range = useRef({ minY, maxY });
  range.current = { minY, maxY };

  const position = useRef(DEFAULT_POSITION);
  const y = useRef(new Animated.Value(minY + DEFAULT_POSITION * (maxY - minY))).current;
  const yNow = useRef(minY + DEFAULT_POSITION * (maxY - minY));
  const place = (fraction) => {
    const { minY: lo, maxY: hi } = range.current;
    yNow.current = lo + fraction * (hi - lo);
    y.setValue(yNow.current);
  };

  // The remembered place (after the screen size is known; again if it changes).
  useEffect(() => {
    let cancelled = false;
    Storage.getItemAsync(STORE_KEY)
      .then((v) => {
        const f = Number(v);
        if (!cancelled && v !== null && f >= 0 && f <= 1) position.current = f;
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) place(position.current); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minY, maxY]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const pan = useMemo(() => {
    let startY = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { startY = yNow.current; },
      onPanResponderMove: (e, g) => {
        const { minY: lo, maxY: hi } = range.current;
        yNow.current = Math.min(hi, Math.max(lo, startY + g.dy));
        y.setValue(yNow.current);
      },
      onPanResponderRelease: (e, g) => {
        if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) {
          openChatScreen();
          return;
        }
        const { minY: lo, maxY: hi } = range.current;
        position.current = hi > lo ? (yNow.current - lo) / (hi - lo) : DEFAULT_POSITION;
        Storage.setItemAsync(STORE_KEY, String(position.current)).catch(() => {});
      },
    });
  }, [y]);

  if (!screen || screen === 'loading' || screen === 'chat' || keyboardOpen) return null;

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[styles.handle, { backgroundColor: colors.primary, transform: [{ translateY: y }] }]}
      accessible
      accessibilityRole="button"
      accessibilityLabel="Chat"
      accessibilityHint="Opens the chat. Drag up or down to move this button."
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => openChatScreen()}
      testID="chat-handle"
    >
      <Text style={styles.icon}>💬</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  handle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: WIDTH,
    height: HEIGHT,
    borderTopLeftRadius: HEIGHT / 2,
    borderBottomLeftRadius: HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 4,
    opacity: 0.92,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  icon: { fontSize: 20 },
});
