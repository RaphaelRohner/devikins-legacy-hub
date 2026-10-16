/**
 * GettingStartedCard.js
 *
 * The "Getting started" checklist at the top of the home screen (Raphael,
 * 11 Oct 2026): the order that gets the most out of the Hub, ticked off
 * by itself as each step is done, with a button to the right screen.
 *
 *   1. Add your wallets (private + in-game)
 *   2. Fetch/Update
 *   3. Optional: add the IDs of NFTs you own (Withdrawals screen)
 *   4. Switch on "My wallets", then Fetch/Update again
 *   5. Let the Hub work (background retries, Hide blanks)
 *   6. Save a backup (Export all sets)
 *
 * Shown until everything is done or the user hides it; Set Up > Getting
 * started shows it again. Progress flags are global settings starting
 * with "guide_" (set by App.js after a fetch and by WalletManager.js
 * after an export).
 */
import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { getGlobalSetting, setGlobalSetting, countWithdrawalItems, getGuideDataFacts } from '../db/database';
import { MY_WALLETS_SET_KEY, ID_LIST_OWNER } from '../constants/idList';

export const GUIDE_KEYS = {
  hidden: 'guide_hidden',
  fetched: 'guide_fetched',
  fetchedWithIds: 'guide_fetched_with_ids',
  backup: 'guide_backup',
  // The guided setup's one-time questions after a fetch (App.js).
  idsAsked: 'guide_ids_asked',
  backupReminded: 'guide_backup_reminded',
  // A wallet that was just added and whose "What's this wallet?" question
  // (or its follow-ups) isn't answered yet - JSON {id, address, isFirst,
  // setId}. A reload picks the guided setup up again from there
  // (Raphael, 16 Oct 2026). '' = nothing pending.
  namingPending: 'guide_naming_pending',
};

/** Loads what's done so far. */
export async function loadGuideState(walletCount, activeWalletSetId) {
  const [hidden, fetched, fetchedWithIds, backup, mySetId, idCount, facts] = await Promise.all([
    getGlobalSetting(GUIDE_KEYS.hidden),
    getGlobalSetting(GUIDE_KEYS.fetched),
    getGlobalSetting(GUIDE_KEYS.fetchedWithIds),
    getGlobalSetting(GUIDE_KEYS.backup),
    getGlobalSetting(MY_WALLETS_SET_KEY),
    countWithdrawalItems(),
    activeWalletSetId != null ? getGuideDataFacts(ID_LIST_OWNER) : Promise.resolve({ anyNfts: false, anyFromIds: false }),
  ]);
  const isMySet = mySetId !== null && activeWalletSetId != null && String(mySetId) === String(activeWalletSetId);
  const steps = {
    wallets: walletCount > 0,
    // Done if a fetch finished since the checklist exists - or if the set
    // already holds NFTs (fetched before the checklist was added).
    fetched: fetched === '1' || facts.anyNfts,
    ids: idCount > 0,
    myWallets: isMySet && (fetchedWithIds === '1' || facts.anyFromIds),
    backup: backup === '1',
  };
  const complete = steps.wallets && steps.fetched && steps.backup && (!steps.ids || steps.myWallets);
  return { hidden: hidden === '1', steps, idCount, isMySet, complete };
}

export default function GettingStartedCard({ state, onHide, onOpenWallets, onFetch, onOpenWithdrawals, isBusy }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (state?.complete) setOpen(false);
  }, [state?.complete]);
  if (!state) return null;
  const { steps, idCount, isMySet } = state;

  const rows = [
    {
      key: 'wallets',
      done: steps.wallets,
      title: 'Add your wallets',
      text: 'Your private wallet and your in-game wallet.',
      button: 'Wallets',
      onPress: onOpenWallets,
    },
    {
      key: 'fetched',
      done: steps.fetched,
      title: 'Fetch/Update',
      text: 'Loads the Devikins, Weapons and Equipment those wallets hold.',
      button: isBusy ? 'Busy…' : 'Fetch now',
      onPress: onFetch,
      disabled: isBusy || !steps.wallets,
    },
    {
      key: 'ids',
      done: steps.ids,
      optional: true,
      title: 'Add the IDs of NFTs you own',
      text: "For NFTs still in the game's main wallet (not in yours): paste their IDs on the Withdrawals screen.",
      button: 'Withdrawals',
      onPress: onOpenWithdrawals,
    },
    {
      key: 'myWallets',
      done: steps.myWallets,
      optional: !steps.ids,
      title: 'Switch on "My wallets", then Fetch/Update again',
      text: steps.ids
        ? `Your own set then also shows the ${idCount} ID${idCount === 1 ? '' : 's'} on your list.`
        : 'Only needed if you added IDs above.',
      button: isMySet ? (isBusy ? 'Busy…' : 'Fetch now') : 'Wallets',
      onPress: isMySet ? onFetch : onOpenWallets,
      disabled: isMySet && isBusy,
    },
    {
      key: 'work',
      info: true,
      title: 'Let the Hub do its job',
      text: 'Moonlabs\' server doesn\'t always answer: the Hub keeps retrying in the background. "Hide blanks" keeps incomplete NFTs out of view until they come through.',
    },
    {
      key: 'backup',
      done: steps.backup,
      title: 'Save a backup',
      text: 'Wallets > Export all sets: everything in one file, to import again anywhere.',
      button: 'Wallets',
      onPress: onOpenWallets,
    },
  ];
  const required = rows.filter((r) => !r.info && !r.optional);
  const doneCount = required.filter((r) => r.done).length;

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => setOpen((v) => !v)}>
          <Text style={[styles.title, { color: colors.text }]}>
            {state.complete ? 'All set ✓' : 'Getting started'}
            <Text style={[styles.count, { color: colors.secondaryText }]}>
              {'  '}
              {doneCount} of {required.length} done {open ? '▾' : '▸'}
            </Text>
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onHide} accessibilityLabel="Hide the getting started guide">
          <Text style={[styles.hide, { color: colors.secondaryText }]}>Hide ✕</Text>
        </TouchableOpacity>
      </View>
      {open
        ? rows.map((r, i) => (
            <View key={r.key} style={[styles.row, { borderTopColor: colors.border }]}>
              <Text style={[styles.mark, { color: r.done ? colors.primary : colors.secondaryText }]}>
                {r.info ? 'ⓘ' : r.done ? '✓' : `${i + 1}`}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.stepTitle, { color: colors.text }, r.done && styles.doneTitle]}>
                  {r.title}
                  {r.optional && !r.done ? <Text style={{ color: colors.secondaryText, fontWeight: '400' }}> (optional)</Text> : null}
                </Text>
                <Text style={[styles.stepText, { color: colors.secondaryText }]}>{r.text}</Text>
              </View>
              {r.button && !r.done ? (
                <TouchableOpacity
                  style={[styles.stepButton, { borderColor: colors.primary }, r.disabled && { opacity: 0.5 }]}
                  onPress={r.onPress}
                  disabled={r.disabled}
                >
                  <Text style={[styles.stepButtonText, { color: colors.primary }]}>{r.button}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

/** Marks the guide hidden (Set Up > Getting started brings it back). */
export async function setGuideHidden(hidden) {
  await setGlobalSetting(GUIDE_KEYS.hidden, hidden ? '1' : '0');
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 8, borderWidth: 1, borderRadius: 12, padding: 12, gap: 4, maxWidth: 760, alignSelf: 'center', width: '96%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  count: { fontSize: 13, fontWeight: '400' },
  hide: { fontSize: 13, fontWeight: '600', paddingVertical: 4, paddingHorizontal: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, marginTop: 4, borderTopWidth: 1 },
  mark: { width: 20, textAlign: 'center', fontSize: 15, fontWeight: '700' },
  stepTitle: { fontSize: 14, fontWeight: '700' },
  doneTitle: { textDecorationLine: 'line-through', opacity: 0.6 },
  stepText: { fontSize: 12, lineHeight: 17 },
  stepButton: { borderWidth: 1, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  stepButtonText: { fontSize: 13, fontWeight: '700' },
});
