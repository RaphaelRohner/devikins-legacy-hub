/**
 * OfflineNote.js - "You're offline" (website / installed Hub, 25 Nov 2026)
 *
 * The installed Hub starts without internet from its offline copy
 * (public/sw.js), but some parts still need the internet. Raphael: say so in
 * the Hub itself, not only in Ask Devi. So while the browser reports "no
 * connection", a slim note sits at the top of the screen; it goes away by
 * itself when the connection is back. Nothing shows in the Android app.
 */
import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';

/** true while the browser has no connection (website only). */
function useOffline() {
  const [offline, setOffline] = useState(
    Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return offline;
}

export default function OfflineNote() {
  const { colors } = useTheme();
  const offline = useOffline();
  if (!offline) return null;
  return (
    <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="offline-note" accessibilityRole="alert">
      <Text style={[styles.text, { color: colors.text }]}>
        <Text style={styles.strong}>You're offline</Text>
        {' – showing your saved collection. Fetching, new pictures, chat and albums need the internet.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { borderBottomWidth: 1, paddingVertical: 6, paddingHorizontal: 12 },
  text: { fontSize: 13, textAlign: 'center' },
  strong: { fontWeight: '700' },
});
