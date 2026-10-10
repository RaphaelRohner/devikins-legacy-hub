/**
 * DonateView.js
 *
 * The "Donate" screen. The Hub is free; this screen only shows where
 * someone can send a voluntary donation in KLV if they'd like to.
 *
 * Two ways to donate:
 *   - copy the address and send from any Klever wallet (app or extension);
 *   - on the website, "Donate with Klever Extension": the Hub asks the
 *     Klever browser extension to send the amount, and the person approves
 *     or rejects it in the extension. The Hub never sees a private key.
 *
 * The address comes from src/constants/donation.js. While it's empty, the
 * menu doesn't show the Donate entry at all (see HamburgerMenu.js).
 */

import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Linking, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { DONATION_ADDRESS } from '../constants/donation';
import { sendKlvWithExtension } from '../api/kleverExtension';

const IS_WEB = Platform.OS === 'web';

export default function DonateView({ onClose }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sentHash, setSentHash] = useState('');
  const [sendError, setSendError] = useState('');

  async function donateWithExtension() {
    setSendError('');
    setSentHash('');
    setIsSending(true);
    try {
      const hash = await sendKlvWithExtension(DONATION_ADDRESS, amount.replace(',', '.'));
      setSentHash(hash);
      setAmount('');
    } catch (e) {
      setSendError(e?.message || String(e));
    } finally {
      setIsSending(false);
    }
  }

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

        {IS_WEB ? (
          <View style={[styles.extensionBox, { borderColor: colors.border }]}>
            <Text style={[styles.text, { color: colors.text, fontWeight: '700' }]}>Donate with the Klever browser extension</Text>
            {/* Fee figures checked on a real donation (10 Oct 2026): 1 KLV
                transaction fee + 2 KLV network (bandwidth) fee. Klever sets
                these, so they can change; the extension always shows the
                exact amount before confirming. */}
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              Klever adds a network fee of about 3 KLV per transfer (1 KLV transaction fee + 2 KLV network fee),
              on top of the amount you donate. The extension shows the exact fee before you confirm.
            </Text>
            <View style={styles.buttonRow}>
              <TextInput
                style={[styles.amountInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
                placeholder="Amount in KLV"
                placeholderTextColor={colors.secondaryText}
                value={amount}
                onChangeText={(t) => setAmount(t.replace(/[^0-9.,]/g, ''))}
                inputMode="decimal"
                editable={!isSending}
              />
              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.primary }, (isSending || !amount) && { opacity: 0.5 }]}
                onPress={donateWithExtension}
                disabled={isSending || !amount}
              >
                {isSending ? (
                  <ActivityIndicator color={colors.primaryText} />
                ) : (
                  <Text style={[styles.buttonText, { color: colors.primaryText }]}>Donate with Klever Extension</Text>
                )}
              </TouchableOpacity>
            </View>
            {isSending ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>Please confirm (or reject) the donation in your Klever extension.</Text>
            ) : null}
            {sentHash ? (
              <Text style={[styles.note, { color: colors.text }]}>
                Thank you! Sent.{' '}
                <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(`https://kleverscan.org/transaction/${sentHash}`)}>
                  View the transaction
                </Text>
              </Text>
            ) : null}
            {sendError ? <Text style={[styles.note, { color: colors.text }]}>{sendError}</Text> : null}
          </View>
        ) : null}

        <Text style={[styles.note, { color: colors.secondaryText }]}>
          When sending by hand, double-check the address after pasting it. Blockchain transfers can't be undone.
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
  extensionBox: { borderTopWidth: 1, paddingTop: 14, gap: 10 },
  amountInput: { minWidth: 140, flexGrow: 1, maxWidth: 220, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 15 },
});
