/**
 * WalletOverviewView.js - "Where are my NFTs?" (Browse NFTs > Wallet
 * overview). Raphael, 22-23 Oct 2026: a simple table, wallets as rows and
 * Devikins / Weapons / Equipment as columns, including where the NFTs on
 * the Withdrawals list are; tapping a row opens the normal Browse list
 * with just those NFTs; "Check now" looks everything up on the chain.
 * The logic is in src/api/walletOverview.js.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import {
  getNftPlaces,
  getSetting,
  setSetting,
  getGlobalSetting,
  setGlobalSetting,
  getWithdrawalItems,
  getWithdrawalArrivals,
  saveWithdrawalCheckResults,
  addWithdrawalArrivals,
  WITHDRAW_SETTING_KEYS,
} from '../db/database';
import { KINDS } from '../api/withdrawalTracker';
import { buildOverview, parseOverviewCheck, runOverviewCheck, OVERVIEW_CHECK_KEY, KIND_COLUMNS } from '../api/walletOverview';

function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function WalletOverviewView({ wallets, ownerAddresses, includeIdList, setName, onClose, onShowWallet }) {
  const { colors } = useTheme();
  const [data, setData] = useState(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    const rowsByKind = {};
    for (const kind of KINDS) rowsByKind[kind] = await getNftPlaces(kind, ownerAddresses);
    const [listItems, checkText, fromAddress, toAddress, lastListCheck] = await Promise.all([
      includeIdList ? getWithdrawalItems() : Promise.resolve([]),
      getSetting(OVERVIEW_CHECK_KEY),
      getGlobalSetting(WITHDRAW_SETTING_KEYS.from),
      getGlobalSetting(WITHDRAW_SETTING_KEYS.to),
      getGlobalSetting(WITHDRAW_SETTING_KEYS.lastCheck),
    ]);
    const check = parseOverviewCheck(checkText);
    const overview = buildOverview({ wallets, rowsByKind, listItems, includeList: includeIdList, check, fromAddress: fromAddress || '', toAddress: toAddress || '' });
    setData({ overview, rowsByKind, listItems, check, fromAddress, toAddress, lastListCheck: Number(lastListCheck) || 0 });
  }, [wallets, ownerAddresses, includeIdList]);

  useEffect(() => {
    load();
  }, [load]);

  // Leaving the screen stops a running check (what was found is kept).
  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

  async function checkNow() {
    if (!data || checking) return;
    setChecking(true);
    setMessage('');
    cancelRef.current = false;
    try {
      const arrivals = data.toAddress ? await getWithdrawalArrivals(1000) : [];
      const result = await runOverviewCheck({
        wallets,
        rowsByKind: data.rowsByKind,
        listItems: data.listItems,
        previousCheck: data.check,
        fromAddress: data.fromAddress,
        toAddress: data.toAddress,
        knownHashes: new Set(arrivals.map((a) => a.tx_hash)),
        shouldCancel: () => cancelRef.current,
        onProgress: ({ current, total, waiting }) =>
          setProgress(
            waiting
              ? `Looking up your NFTs: ${current} of ${total} - Klever asks to slow down, waiting a moment…`
              : `Looking up your NFTs: ${current} of ${total}`
          ),
      });
      await setSetting(OVERVIEW_CHECK_KEY, JSON.stringify(result.check));
      if (result.listResult) {
        await addWithdrawalArrivals(result.listResult.arrivals);
        await saveWithdrawalCheckResults(result.listResult.updates);
        if (!result.stopped) await setGlobalSetting(WITHDRAW_SETTING_KEYS.lastCheck, String(result.listResult.checkedAt));
      }
      if (result.stopped) setMessage('Stopped - the NFTs looked up so far are counted where they are now.');
      else if (result.errors.length > 0) setMessage(`Done, but some lookups failed (try again later):\n${result.errors.slice(0, 5).join('\n')}`);
      await load();
    } catch (e) {
      setMessage(`The check didn't finish: ${e?.message || e}`);
    } finally {
      setChecking(false);
      setProgress('');
    }
  }

  const overview = data?.overview;
  const lastCheck = data ? Math.max(data.check.checkedAt || 0, includeIdList ? data.lastListCheck : 0) : 0;
  const cell = [styles.cell, { color: colors.text }];
  const headCell = [styles.cell, styles.headText, { color: colors.secondaryText }];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Where are my NFTs?</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!overview ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              {setName ? `Wallet set "${setName}". ` : ''}
              {includeIdList ? 'Your wallets, and where the NFTs on your Withdrawals list are. ' : 'The wallets of this set. '}
              Tap a row to see those NFTs.
            </Text>

            <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.surface }]} testID="overview-table">
              <View style={[styles.row, styles.headRow, { borderColor: colors.border }]}>
                <Text style={[styles.walletCell, styles.headText, { color: colors.secondaryText }]}>Wallet</Text>
                {KIND_COLUMNS.map((c) => (
                  <Text key={c.kind} style={headCell} numberOfLines={1}>{c.label}</Text>
                ))}
              </View>
              {overview.rows.map((row) => {
                const tappable = row.total > 0;
                const warn = row.type === 'other' || row.type === 'notfound';
                return (
                  <TouchableOpacity
                    key={row.key}
                    testID="overview-row"
                    disabled={!tappable}
                    onPress={() => onShowWallet({ label: row.detail && row.type === 'other' ? `${row.label} ${row.detail}` : row.label, nonces: row.nonces })}
                    style={[styles.row, { borderColor: colors.border }]}
                  >
                    <View style={styles.walletCell}>
                      <Text style={[styles.walletLabel, { color: warn ? colors.cancelText : tappable ? colors.primary : colors.text }]} numberOfLines={1}>
                        {row.label}
                      </Text>
                      {row.detail ? (
                        <Text style={[styles.small, { color: colors.secondaryText }]} numberOfLines={2}>{row.detail}</Text>
                      ) : null}
                    </View>
                    {KINDS.map((kind) => (
                      <Text key={kind} style={[cell, row.counts[kind] === 0 && { color: colors.secondaryText }]}>{row.counts[kind]}</Text>
                    ))}
                  </TouchableOpacity>
                );
              })}
              <View style={[styles.row, styles.totalRow, { borderColor: colors.border }]}>
                <Text style={[styles.walletCell, styles.walletLabel, { color: colors.text }]}>Total</Text>
                {KINDS.map((kind) => (
                  <Text key={kind} style={[cell, { fontWeight: '700' }]} testID={`overview-total-${kind}`}>{overview.totals[kind]}</Text>
                ))}
              </View>
            </View>

            {overview.deleted > 0 ? (
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                {overview.deleted} NFT{overview.deleted === 1 ? '' : 's'} marked as deleted {overview.deleted === 1 ? "isn't" : "aren't"} counted.
              </Text>
            ) : null}

            <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Text style={[styles.note, { color: colors.text }]}>
                {lastCheck
                  ? `Last looked up on the chain: ${formatTime(lastCheck)}. NFTs added since then are shown where the last Fetch/Update found them.`
                  : 'These are the places the Hub knows from your last Fetch/Update. "Check now" looks every NFT up on the chain.'}
              </Text>
              {checking ? (
                <View style={styles.inlineRow}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={[styles.note, { color: colors.text, flex: 1 }]} testID="overview-progress">{progress || 'Starting…'}</Text>
                  <TouchableOpacity
                    style={[styles.smallButton, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                    onPress={() => {
                      cancelRef.current = true;
                    }}
                  >
                    <Text style={[styles.smallButtonText, { color: colors.text }]}>Stop</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={checkNow} testID="overview-check">
                  <Text style={[styles.buttonText, { color: colors.primaryText }]}>Check now</Text>
                </TouchableOpacity>
              )}
              <Text style={[styles.small, { color: colors.secondaryText }]}>
                NFTs still where they were are confirmed quickly; NFTs that moved are found more slowly (Klever allows 30 of those lookups a minute). It also updates the Withdrawals tracker.
              </Text>
              {message ? <Text style={[styles.note, { color: colors.text }]}>{message}</Text> : null}
            </View>
          </>
        )}
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
  content: { paddingHorizontal: 12, paddingBottom: 32, gap: 12, maxWidth: 760, width: '100%' },
  table: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  headRow: { borderTopWidth: 0 },
  totalRow: { borderTopWidth: 1 },
  walletCell: { flex: 1, minWidth: 0 },
  walletLabel: { fontSize: 15, fontWeight: '600' },
  cell: { width: 76, textAlign: 'right', fontSize: 15, fontVariant: ['tabular-nums'] },
  headText: { fontSize: 13, fontWeight: '700' },
  small: { fontSize: 12, lineHeight: 16 },
  note: { fontSize: 13, lineHeight: 18 },
  card: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 10 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  button: { paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '700' },
  smallButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  smallButtonText: { fontSize: 14, fontWeight: '600' },
});
