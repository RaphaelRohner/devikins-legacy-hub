/**
 * SignerTestView.js
 *
 * "KLV Signer (test)" - the Hub's first step towards DOING things on the
 * Klever chain (sending, and later selling or renting NFTs), not just
 * looking at it. Opened from the hamburger menu.
 *
 * The Hub never holds a wallet's private key. Signing is done by the
 * separate KLV Signer app (its own project, "KLV Signer App"): the Hub
 * prepares an unsigned transaction, the Signer shows it to the user and
 * asks for their password, signs, and hands back the signature. See
 * src/api/klvSigner.js for the handoff and src/api/kleverTx.js for
 * preparing and sending.
 *
 * TESTNET ONLY: everything here happens on Klever's practice network,
 * where coins and NFTs have no real value - the Signer refuses real-network
 * transactions for now. That's also why this is a separate test screen and
 * not yet a "Send" button on each NFT: the NFTs this app shows live on the
 * real network (mainnet).
 *
 * The screen has two parts:
 *   1. Connect: asks the Signer which wallet it holds (remembered in the
 *      global_settings table as 'klvSignerAddress'), and shows its testnet
 *      KLV balance.
 *   2. Send: receiver (typed or scanned), amount, and optionally a token or
 *      NFT id. "Send with KLV Signer" prepares the transaction, opens the
 *      Signer for approval, then sends the signed result and links to it
 *      on testnet Kleverscan.
 *
 * Same full-screen-takeover pattern as Kleverscan/Feedback/Devi, with the
 * small round "‹" back button in the top-left corner.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Linking,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { getGlobalSetting, setGlobalSetting } from '../db/database';
import QrScannerModal, { extractAddress } from './QrScannerModal';
import { getSignerAddress, signWithSigner } from '../api/klvSigner';
import {
  broadcastSigned, buildTransfer, explorerUrl, getKlvBalance, klvToUnits, unitsToKlv,
} from '../api/kleverTx';

const SETTING_KEY = 'klvSignerAddress';

export default function SignerTestView({ onClose }) {
  const { colors } = useTheme();

  const [signerAddress, setSignerAddress] = useState(null);
  const [balance, setBalance] = useState(null); // BigInt units, or null while unknown
  const [receiver, setReceiver] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busyStep, setBusyStep] = useState(null); // plain-English "what's happening" text while working
  const [error, setError] = useState(null);
  const [sentHash, setSentHash] = useState(null);

  // Loads the testnet KLV balance of the connected wallet.
  const refreshBalance = useCallback(async (address) => {
    if (!address) return;
    try {
      setBalance(await getKlvBalance(address));
    } catch {
      setBalance(null);
    }
  }, []);

  // On opening: remember a previously connected Signer wallet.
  useEffect(() => {
    getGlobalSetting(SETTING_KEY).then((saved) => {
      if (saved) {
        setSignerAddress(saved);
        refreshBalance(saved);
      }
    });
  }, [refreshBalance]);

  async function handleConnect() {
    setError(null);
    setBusyStep('Waiting for the KLV Signer…');
    try {
      const address = await getSignerAddress();
      setSignerAddress(address);
      await setGlobalSetting(SETTING_KEY, address);
      refreshBalance(address);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyStep(null);
    }
  }

  async function handleSend() {
    setError(null);
    setSentHash(null);
    const to = receiver.trim();
    const kda = token.trim().toUpperCase();
    if (!/^klv1[0-9a-z]{58}$/.test(to)) {
      setError('Please enter a valid receiver address (klv1… , 62 characters).');
      return;
    }
    let amountUnits;
    try {
      if (!kda) amountUnits = klvToUnits(amount);                 // KLV: decimal amount
      else if (kda.includes('/')) amountUnits = '1';              // an NFT: always 1
      else if (/^\d+$/.test(amount.trim())) amountUnits = amount.trim(); // other token: smallest units
      else throw new Error('For a token, enter the amount in its smallest units (a whole number).');
    } catch (e) {
      setError(e.message);
      return;
    }

    try {
      setBusyStep('Preparing the transaction…');
      const unsignedHex = await buildTransfer({ sender: signerAddress, receiver: to, amountUnits, kda: kda || undefined });

      setBusyStep('Waiting for your approval in the KLV Signer…');
      const signed = await signWithSigner(unsignedHex);

      setBusyStep('Sending to the Klever testnet…');
      const hash = await broadcastSigned(signed.signedTransaction);
      setSentHash(hash);
      setAmount('');
      // The balance changes once the network has processed it - check again shortly.
      setTimeout(() => refreshBalance(signerAddress), 5000);
    } catch (e) {
      setError(e.code === 'USER_REJECTED' ? 'Cancelled in the KLV Signer - nothing was sent.' : e.message);
    } finally {
      setBusyStep(null);
    }
  }

  const inputStyle = [styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }];
  const busy = busyStep !== null;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>KLV Signer (test)</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.paragraph, { color: colors.secondaryText }]}>
          Send KLV, tokens or NFTs on Klever's TESTNET (practice network, no real value) using the separate KLV
          Signer app. The Hub never sees your private key: the Signer shows you each transaction and signs it
          only after you enter your Signer password.
        </Text>

        {/* 1. Connect */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>1. Connect</Text>
        {signerAddress ? (
          <View style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.secondaryText }]}>Signer wallet</Text>
            <Text selectable style={[styles.mono, { color: colors.text }]}>{signerAddress}</Text>
            <Text style={[styles.label, { color: colors.secondaryText, marginTop: 8 }]}>Testnet balance</Text>
            <Text style={[styles.value, { color: colors.text }]}>
              {balance === null ? '…' : `${unitsToKlv(balance)} KLV`}
            </Text>
            <View style={styles.row}>
              <SmallButton title="Refresh balance" onPress={() => refreshBalance(signerAddress)} colors={colors} disabled={busy} />
              <SmallButton title="Reconnect" onPress={handleConnect} colors={colors} disabled={busy} />
            </View>
          </View>
        ) : (
          <MainButton title="Connect KLV Signer" onPress={handleConnect} colors={colors} disabled={busy} />
        )}

        {/* 2. Send */}
        {signerAddress ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>2. Send (testnet)</Text>
            <Text style={[styles.label, { color: colors.secondaryText }]}>Receiver address</Text>
            <View style={styles.row}>
              <TextInput
                style={[inputStyle, styles.flex]}
                placeholder="klv1…"
                placeholderTextColor={colors.secondaryText}
                value={receiver}
                onChangeText={setReceiver}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
              <SmallButton title="Scan" onPress={() => setScannerOpen(true)} colors={colors} disabled={busy} />
            </View>

            <Text style={[styles.label, { color: colors.secondaryText }]}>Token or NFT (leave empty for KLV)</Text>
            <TextInput
              style={inputStyle}
              placeholder="e.g. SIGNTEST-AB12/1 for an NFT"
              placeholderTextColor={colors.secondaryText}
              value={token}
              onChangeText={setToken}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!busy}
            />

            {!token.includes('/') ? (
              <>
                <Text style={[styles.label, { color: colors.secondaryText }]}>
                  {token.trim() ? 'Amount (in the token\'s smallest units)' : 'Amount (KLV)'}
                </Text>
                <TextInput
                  style={inputStyle}
                  placeholder={token.trim() ? 'e.g. 100' : 'e.g. 0.5'}
                  placeholderTextColor={colors.secondaryText}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  editable={!busy}
                />
              </>
            ) : null}

            <MainButton title="Send with KLV Signer" onPress={handleSend} colors={colors} disabled={busy} />
          </>
        ) : null}

        {/* Status */}
        {busy ? (
          <View style={styles.row}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.paragraph, { color: colors.text, marginLeft: 8 }]}>{busyStep}</Text>
          </View>
        ) : null}
        {error ? (
          <Text style={[styles.paragraph, { color: colors.cancelText }]}>{error}</Text>
        ) : null}
        {sentHash ? (
          <View style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Text style={[styles.value, { color: colors.text }]}>✔ Sent to the testnet</Text>
            <Text selectable style={[styles.mono, { color: colors.secondaryText }]}>{sentHash}</Text>
            <SmallButton title="View on Kleverscan" onPress={() => Linking.openURL(explorerUrl(sentHash))} colors={colors} />
          </View>
        ) : null}
      </ScrollView>

      <QrScannerModal
        visible={scannerOpen}
        onScanned={(text) => { setReceiver(extractAddress(text)); setScannerOpen(false); }}
        onClose={() => setScannerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

function MainButton({ title, onPress, colors, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.mainButton, { backgroundColor: disabled ? colors.primaryDisabled : colors.primary }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.mainButtonText, { color: colors.primaryText }]}>{title}</Text>
    </TouchableOpacity>
  );
}

function SmallButton({ title, onPress, colors, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.smallButton, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.smallButtonText, { color: colors.text }]}>{title}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 12 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { fontSize: 20, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  paragraph: { fontSize: 15, lineHeight: 21, marginVertical: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, marginVertical: 8 },
  label: { fontSize: 13, marginTop: 8, marginBottom: 4 },
  value: { fontSize: 17, fontWeight: '600' },
  mono: { fontSize: 13, fontFamily: 'monospace' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15 },
  mainButton: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  mainButtonText: { fontSize: 16, fontWeight: '600' },
  smallButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  smallButtonText: { fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
