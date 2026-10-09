/**
 * DonateView.js
 *
 * The "Donate" screen. The Hub is free; this screen only shows where
 * someone can send a voluntary donation in KLV if they'd like to.
 *
 * It deliberately doesn't send anything itself: the person copies the
 * address and sends from their own wallet (Klever app or browser
 * extension). That keeps the Hub free of any signing or keys.
 *
 * The address comes from src/constants/donation.js. While it's empty, the
 * menu doesn't show the Donate entry at all (see HamburgerMenu.js).
 */

import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { DONATION_ADDRESS } from '../constants/donation';

export default function DonateView({ onClose }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);

  // Copying works directly in the browser. On the phone the address is
  // selectable instead (long-press it), so no extra package is needed.
  const canCopy = Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(DONATION_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // Some browsers block copying; the address is still selectable.
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Donate</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.text, { color: colors.text }]}>
          The Hub is free and stays free. If it helps you and you'd like to support it, you can send any
          amount of KLV to this address:
        </Text>

        <Text selectable style={[styles.address, { color: colors.text, borderColor: colors.border }]}>
          {DONATION_ADDRESS}
        </Text>

        <View style={styles.buttonRow}>
          {canCopy ? (
            <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={copyAddress}>
              <Text style={[styles.buttonText, { color: colors.primaryText }]}>{copied ? 'Copied ✓' : 'Copy address'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={() => Linking.openURL(`https://kleverscan.org/account/${DONATION_ADDRESS}`)}
          >
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>View on Kleverscan</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.note, { color: colors.secondaryText }]}>
          Please double-check the address after pasting it. Blockchain transfers can't be undone.
          Donations are voluntary and don't unlock anything; thank you!
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  card: { marginHorizontal: 12, padding: 16, borderRadius: 12, borderWidth: 1, gap: 14, maxWidth: 640 },
  text: { fontSize: 15, lineHeight: 21 },
  address: { fontSize: 14, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, padding: 10, borderWidth: 1, borderRadius: 8 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 18 },
});
