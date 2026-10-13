/**
 * WithdrawalTrackerView.js
 *
 * The "Withdrawals" screen: follow NFTs you asked the game to withdraw
 * until they arrive in your own wallet. Design agreed with Raphael on
 * 11 Oct 2026 (project doc WITHDRAWAL-TRACKER.md); the logic lives in
 * src/api/withdrawalTracker.js, the saved data in database.js
 * (withdrawal_items / withdrawal_arrivals).
 *
 * In short:
 *   1. Wallets: "Withdraw from" (your in-game wallet) and "Receive in"
 *      (your own wallet). One tracker for the whole Hub.
 *   2. Add NFTs: paste ID lists (with headings, or per kind).
 *   3. Mark the ones you actually requested in the game. Anything marked
 *      that hasn't arrived after N minutes (default 30) is overdue.
 *   4. Check now: asks Klever's API where each NFT is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Linking,
  Share,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import {
  getGlobalSetting,
  setGlobalSetting,
  getWithdrawalItems,
  addWithdrawalItems,
  removeWithdrawalItems,
  setWithdrawalRequested,
  saveWithdrawalCheckResults,
  addWithdrawalArrivals,
  getWithdrawalArrivals,
  clearWithdrawalArrivals,
  getWalletsFromAllSets,
  WITHDRAW_SETTING_KEYS,
} from '../db/database';
import { requestPersistentStorage } from '../api/persistStorage';
import { markUsageActive } from '../api/usage';
import {
  KINDS,
  KIND_LABEL,
  DEFAULT_OVERDUE_MINUTES,
  GAME_MAIN_WALLET,
  isValidKleverAddress,
  parseIdList,
  statusOf,
  runWithdrawalCheck,
  overdueListText,
} from '../api/withdrawalTracker';
import { kleverscanNftUrl } from '../constants/schema';

// Where withdrawal problems are reported (Klever's help centre).
const SUPPORT_URL = 'https://support.klever.org/';

const IS_WEB = Platform.OS === 'web';
const KEY_FROM = WITHDRAW_SETTING_KEYS.from;
const KEY_TO = WITHDRAW_SETTING_KEYS.to;
const KEY_OVERDUE = WITHDRAW_SETTING_KEYS.overdue;
const KEY_LAST_CHECK = WITHDRAW_SETTING_KEYS.lastCheck;
const ROWS_PER_PAGE = 100;

const STATUS_TEXT = {
  arrived: 'Arrived',
  overdue: 'Overdue',
  requested: 'Requested - waiting',
  'in-game': 'In your in-game wallet',
  main: "In the game's main wallet",
  elsewhere: 'In another wallet',
  'not-found': 'Not found on the chain',
  unchecked: 'Not checked yet',
};
const PLACE_TEXT = {
  receiving: 'in your receiving wallet',
  'in-game': 'still in your in-game wallet',
  main: "still in the game's main wallet",
  elsewhere: 'in another wallet',
  'not-found': 'not found on the chain',
  unchecked: 'not checked yet',
};
// Order in the list: what needs attention first.
const STATUS_ORDER = ['overdue', 'requested', 'elsewhere', 'not-found', 'in-game', 'main', 'unchecked', 'arrived'];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'requested', label: 'Requested' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'arrived', label: 'Arrived' },
  { key: 'not-requested', label: 'Not requested' },
];

// Narrowing the list further: which kind, where it is, and in what order.
const KIND_FILTERS = [
  { key: 'all', label: 'All kinds' },
  { key: 'devikin', label: 'Devikins' },
  { key: 'weapon', label: 'Weapons' },
  { key: 'equipment', label: 'Equipment' },
];
const PLACE_FILTERS = [
  { key: 'any', label: 'Anywhere' },
  { key: 'game', label: 'Still in the game' }, // in-game wallet or game's main wallet
  { key: 'in-game', label: 'In-game wallet' },
  { key: 'main', label: "Game's main wallet" },
  { key: 'elsewhere', label: 'Another wallet' },
  { key: 'not-found', label: 'Not found' },
];
const SORTS = [
  { key: 'attention', label: 'Needs attention first' },
  { key: 'id-asc', label: 'ID ↑' },
  { key: 'id-desc', label: 'ID ↓' },
];

const PASTE_KINDS = [
  { key: null, label: 'Use headings' },
  { key: 'devikin', label: 'Devikins' },
  { key: 'weapon', label: 'Weapons' },
  { key: 'equipment', label: 'Equipment' },
];

function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function keyOf(item) {
  return `${item.kind}:${item.nonce}`;
}

export default function WithdrawalTrackerView({ onClose }) {
  const { colors } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [fromAddress, setFromAddress] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [overdueMinutes, setOverdueMinutes] = useState(DEFAULT_OVERDUE_MINUTES);
  const [overdueDraft, setOverdueDraft] = useState(String(DEFAULT_OVERDUE_MINUTES));
  const [items, setItems] = useState([]);
  const [arrivals, setArrivals] = useState([]);
  const [lastCheck, setLastCheck] = useState(null);
  const [pasteText, setPasteText] = useState('');
  const [pasteKind, setPasteKind] = useState(null);
  const [markOnAdd, setMarkOnAdd] = useState(false);
  const [addMessage, setAddMessage] = useState('');
  const [filter, setFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [placeFilter, setPlaceFilter] = useState('any');
  const [sortMode, setSortMode] = useState('attention');
  const [selected, setSelected] = useState(() => new Set());
  const [shownRows, setShownRows] = useState(ROWS_PER_PAGE);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState('');
  const [checkMessage, setCheckMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [pickerFor, setPickerFor] = useState(null); // 'from' | 'to' | null
  const [myWallets, setMyWallets] = useState(null); // null = not loaded yet
  const cancelRef = useRef(false);

  const reload = useCallback(async () => {
    const [list, log] = await Promise.all([getWithdrawalItems(), getWithdrawalArrivals()]);
    setItems(list);
    setArrivals(log);
  }, []);

  useEffect(() => {
    (async () => {
      const [from, to, overdue, last] = await Promise.all([
        getGlobalSetting(KEY_FROM),
        getGlobalSetting(KEY_TO),
        getGlobalSetting(KEY_OVERDUE),
        getGlobalSetting(KEY_LAST_CHECK),
      ]);
      setFromAddress(from || '');
      setFromDraft(from || '');
      setToAddress(to || '');
      setToDraft(to || '');
      const minutes = Number(overdue) > 0 ? Number(overdue) : DEFAULT_OVERDUE_MINUTES;
      setOverdueMinutes(minutes);
      setOverdueDraft(String(minutes));
      setLastCheck(last ? Number(last) : null);
      await reload();
      setLoaded(true);
    })();
    // Re-evaluate "overdue" every half minute while the screen is open.
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      clearInterval(timer);
      cancelRef.current = true;
    };
  }, [reload]);

  const ctx = useMemo(() => ({ fromAddress, toAddress, overdueMinutes, now }), [fromAddress, toAddress, overdueMinutes, now]);

  const withStatus = useMemo(() => {
    const list = items.map((item) => ({ ...item, ...statusOf(item, ctx) }));
    const byNumber = (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.nonce - b.nonce;
    if (sortMode === 'id-asc') list.sort(byNumber);
    else if (sortMode === 'id-desc') list.sort((a, b) => -byNumber(a, b));
    else list.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byNumber(a, b));
    return list;
  }, [items, ctx, sortMode]);

  // Kind and place narrow the list first; the status chips (with their
  // counts) then work within that.
  const narrowed = useMemo(
    () =>
      withStatus.filter((i) => {
        if (kindFilter !== 'all' && i.kind !== kindFilter) return false;
        if (placeFilter === 'any') return true;
        if (placeFilter === 'game') return i.place === 'in-game' || i.place === 'main';
        return i.place === placeFilter;
      }),
    [withStatus, kindFilter, placeFilter]
  );

  // How many of each kind are on the whole list - shown on the kind chips,
  // so it's always clear what the list holds in total (13 Oct 2026: with
  // "Equipment" picked, "Select all" + "Remove" only removed the Equipment).
  const kindCounts = useMemo(() => {
    const c = { all: items.length, devikin: 0, weapon: 0, equipment: 0 };
    for (const i of items) c[i.kind] = (c[i.kind] || 0) + 1;
    return c;
  }, [items]);

  const counts = useMemo(() => {
    const c = { all: narrowed.length, requested: 0, overdue: 0, arrived: 0, 'not-requested': 0 };
    for (const i of narrowed) {
      if (i.status === 'arrived') c.arrived += 1;
      if (i.status === 'overdue') c.overdue += 1;
      if (i.requested_at && i.status !== 'arrived') c.requested += 1;
      if (!i.requested_at && i.status !== 'arrived') c['not-requested'] += 1;
    }
    return c;
  }, [narrowed]);

  const filtered = useMemo(
    () =>
      narrowed.filter((i) => {
        if (filter === 'all') return true;
        if (filter === 'arrived') return i.status === 'arrived';
        if (filter === 'overdue') return i.status === 'overdue';
        if (filter === 'requested') return i.requested_at && i.status !== 'arrived';
        return !i.requested_at && i.status !== 'arrived';
      }),
    [narrowed, filter]
  );

  // Overall overdue count (for the "copy overdue list" button), regardless
  // of the kind/place narrowing.
  const overdueTotal = useMemo(() => withStatus.filter((i) => i.status === 'overdue').length, [withStatus]);

  const walletsReady = isValidKleverAddress(fromAddress) && isValidKleverAddress(toAddress);
  const draftsChanged =
    fromDraft.trim() !== fromAddress || toDraft.trim() !== toAddress || String(overdueMinutes) !== overdueDraft.trim();

  async function saveWallets() {
    const from = fromDraft.trim();
    const to = toDraft.trim();
    if (!isValidKleverAddress(from) || !isValidKleverAddress(to)) {
      Alert.alert('Check the addresses', 'Both wallets need a full Klever address (starting with klv1).');
      return;
    }
    if (from === to) {
      Alert.alert('Check the addresses', 'The in-game wallet and the receiving wallet must be different.');
      return;
    }
    if (from === GAME_MAIN_WALLET || to === GAME_MAIN_WALLET) {
      Alert.alert('Check the addresses', "That's the game's main wallet, not yours. Use your own in-game wallet address.");
      return;
    }
    const minutes = Math.max(1, Math.min(10080, Math.round(Number(overdueDraft) || DEFAULT_OVERDUE_MINUTES)));
    const receivingChanged = toAddress && to !== toAddress;
    await setGlobalSetting(KEY_FROM, from);
    await setGlobalSetting(KEY_TO, to);
    await setGlobalSetting(KEY_OVERDUE, String(minutes));
    if (receivingChanged) await clearWithdrawalArrivals();
    // Website: ask the browser to keep this data (see persistStorage.web.js);
    // and someone setting up the tracker is using the Hub (user count).
    requestPersistentStorage();
    markUsageActive();
    setFromAddress(from);
    setToAddress(to);
    setOverdueMinutes(minutes);
    setOverdueDraft(String(minutes));
    await reload();
  }

  async function addFromPaste() {
    const { items: parsed, unassigned, ignored } = parseIdList(pasteText, pasteKind);
    const notes = [];
    if (parsed.length > 0) {
      const added = await addWithdrawalItems(parsed);
      if (markOnAdd) await setWithdrawalRequested(parsed, Date.now());
      notes.push(
        `${added} added` +
          (parsed.length > added ? `, ${parsed.length - added} already on the list` : '') +
          (markOnAdd ? ' - all marked as requested.' : '.')
      );
      setPasteText('');
    }
    if (unassigned.length > 0) {
      notes.push(
        `${unassigned.length} ID(s) had no kind: put a heading (Devikins / Weapons / Equipment) above them, or pick the kind above the box.`
      );
    }
    // Wallet addresses in the pasted text (Raphael's list starts with his
    // two) are named as such; words like "Private Wallet ID" are just
    // labels and aren't worth a mention (13 Oct 2026: the old "Skipped (not
    // an ID): Private, Wallet, ID, klv1..." note was easy to misread).
    const addresses = ignored.filter((t) => /^klv1[0-9a-z]{20,}$/i.test(t));
    const LABEL_WORDS = /^(private|in-?game|wallet|wallets|id|ids|id's|address|addresses|my|main|receiving|from|to|the|and|nft|nfts|list|liste)$/i;
    const other = ignored.filter((t) => !addresses.includes(t) && !LABEL_WORDS.test(t.replace(/[^a-z'-]/gi, '')));
    if (addresses.length > 0) {
      notes.push(`${addresses.length} wallet address${addresses.length === 1 ? '' : 'es'} skipped (only NFT IDs go on the list).`);
    }
    if (other.length > 0) notes.push(`Skipped (not an ID): ${other.slice(0, 5).join(', ')}${other.length > 5 ? ' …' : ''}`);
    if (notes.length === 0) notes.push('No NFT IDs found in the text.');
    await reload(); // first refresh the list, then say what happened
    setAddMessage(notes.join(' '));
  }

  function toggleSelected(item) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const selectedItems = useMemo(() => items.filter((i) => selected.has(keyOf(i))), [items, selected]);

  async function markSelected(requested) {
    await setWithdrawalRequested(selectedItems, requested ? Date.now() : null);
    setSelected(new Set());
    await reload();
  }

  function removeSelected() {
    const n = selectedItems.length;
    Alert.alert('Remove from the list?', `${n} NFT(s) will be removed from the tracker. Nothing happens on the chain.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeWithdrawalItems(selectedItems);
          setSelected(new Set());
          await reload();
        },
      },
    ]);
  }

  // full = look up every NFT on the list; onlyItems = look up exactly these
  // (the "Check selected" button), whatever their state.
  async function check(full, onlyItems = null) {
    if (!walletsReady || checking) return;
    setChecking(true);
    setCheckMessage('');
    cancelRef.current = false;
    try {
      const knownHashes = new Set(arrivals.map((a) => a.tx_hash));
      const result = await runWithdrawalCheck({
        items: onlyItems || items,
        fromAddress,
        toAddress,
        full: onlyItems ? true : full,
        knownHashes,
        shouldCancel: () => cancelRef.current,
        onProgress: (p) => {
          if (p.phase === 'arrivals') setProgress('Reading arrivals in your receiving wallet…');
          else if (p.phase === 'lookups') setProgress(p.total ? `Looking up NFTs one by one: ${p.current} of ${p.total}` : '');
        },
      });
      await addWithdrawalArrivals(result.arrivals);
      await saveWithdrawalCheckResults(result.updates);
      await setGlobalSetting(KEY_LAST_CHECK, String(result.checkedAt));
      setLastCheck(result.checkedAt);
      setNow(Date.now());
      setCheckMessage(
        result.errors.length > 0
          ? `Done, but some lookups failed (try again later):\n${result.errors.slice(0, 5).join('\n')}`
          : ''
      );
      await reload();
    } catch (e) {
      setCheckMessage(`The check didn't finish: ${e?.message || e}`);
    } finally {
      setChecking(false);
      setProgress('');
    }
  }

  async function copyOverdue() {
    const text = overdueListText(items, ctx);
    if (!text) return;
    try {
      if (IS_WEB && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        Alert.alert('Copied', 'The overdue list is copied - paste it into your ticket at support.klever.org (the button next to it opens the page).');
      } else {
        await Share.share({ message: text });
      }
    } catch (e) {
      // Clipboard blocked: nothing else to do.
    }
  }

  async function openPicker(which) {
    if (pickerFor === which) {
      setPickerFor(null);
      return;
    }
    setPickerFor(which);
    if (myWallets === null) setMyWallets(await getWalletsFromAllSets());
  }

  function pickWallet(address) {
    if (pickerFor === 'from') setFromDraft(address);
    else setToDraft(address);
    setPickerFor(null);
  }

  function renderPicker(which) {
    if (pickerFor !== which) return null;
    if (myWallets === null) return <ActivityIndicator color={colors.primary} />;
    const seen = new Set();
    const choices = myWallets.filter((w) => (seen.has(w.address) ? false : seen.add(w.address)));
    if (choices.length === 0) {
      return <Text style={[styles.note, { color: colors.secondaryText }]}>No wallets in your sets yet - add them on the Wallets screen, or paste the address.</Text>;
    }
    return (
      <View style={[styles.pickerBox, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
        {choices.map((w) => (
          <TouchableOpacity key={w.address} style={styles.pickerRow} onPress={() => pickWallet(w.address)}>
            <Text style={[styles.text, { color: colors.text }]}>{w.alias || shortAddress(w.address)}</Text>
            <Text style={[styles.note, { color: colors.secondaryText }]}>
              {w.alias ? `${shortAddress(w.address)} · ` : ''}set: {w.setName}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  // A wallet address in words where we know it, otherwise shortened.
  function walletName(address) {
    if (!address) return 'unknown';
    if (address === fromAddress) return 'your in-game wallet';
    if (address === toAddress) return 'your receiving wallet';
    if (address === GAME_MAIN_WALLET) return "the game's main wallet";
    return shortAddress(address);
  }

  function describe(item) {
    if (item.status === 'arrived') {
      const when = item.arrived_at ? formatTime(item.arrived_at) : '';
      if (item.arrived_tx) return `${when}, sent from ${walletName(item.arrived_from)}`;
      return `found in your receiving wallet${when ? ` (${when})` : ''}`;
    }
    const parts = [];
    if (item.requested_at) {
      parts.push(`requested ${formatTime(item.requested_at)}`);
      if (item.place !== 'elsewhere') parts.push(PLACE_TEXT[item.place]);
    }
    if (item.place === 'elsewhere') parts.push(`held by ${shortAddress(item.holder)}`);
    if (item.previous_holder && item.previous_holder !== item.holder) {
      parts.push(`moved from ${walletName(item.previous_holder)}`);
    }
    if (item.checked_at) parts.push(`as of ${formatTime(item.checked_at)}`);
    return parts.join(' · ');
  }

  function statusColor(status) {
    if (status === 'overdue' || status === 'elsewhere' || status === 'not-found') return colors.cancelText;
    if (status === 'arrived') return colors.primary;
    return colors.text;
  }

  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  const input = [styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }];
  const button = [styles.button, { backgroundColor: colors.primary }];
  const buttonText = [styles.buttonText, { color: colors.primaryText }];
  const smallButton = [styles.smallButton, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }];

  if (!loaded) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={onClose}>
          <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Withdrawals</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* 1. Wallets */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>1. Your wallets</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            The game sends withdrawals from your in-game wallet (or from the game's main wallet) to your own wallet.
            Only public addresses are used - never keys.
          </Text>
          <Text style={[styles.label, { color: colors.text }]}>Withdraw from (your in-game wallet)</Text>
          <TextInput style={input} value={fromDraft} onChangeText={setFromDraft} placeholder="klv1… (in-game wallet)" placeholderTextColor={colors.secondaryText} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity onPress={() => openPicker('from')}>
            <Text style={[styles.link, { color: colors.primary }]}>{pickerFor === 'from' ? 'Close the list' : 'Choose from my wallets'}</Text>
          </TouchableOpacity>
          {renderPicker('from')}
          <Text style={[styles.label, { color: colors.text }]}>Receive in (your own wallet)</Text>
          <TextInput style={input} value={toDraft} onChangeText={setToDraft} placeholder="klv1… (receiving wallet)" placeholderTextColor={colors.secondaryText} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity onPress={() => openPicker('to')}>
            <Text style={[styles.link, { color: colors.primary }]}>{pickerFor === 'to' ? 'Close the list' : 'Choose from my wallets'}</Text>
          </TouchableOpacity>
          {renderPicker('to')}
          <View style={styles.inlineRow}>
            <Text style={[styles.label, { color: colors.text, flex: 1 }]}>Overdue after (minutes)</Text>
            <TextInput style={[input, styles.minutesInput]} value={overdueDraft} onChangeText={(t) => setOverdueDraft(t.replace(/[^0-9]/g, ''))} inputMode="numeric" keyboardType="number-pad" />
          </View>
          <TouchableOpacity style={[button, !draftsChanged && { opacity: 0.5 }]} onPress={saveWallets} disabled={!draftsChanged}>
            <Text style={buttonText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* 2. Add NFTs */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>2. Add the IDs of your NFTs</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            Paste NFT IDs - separated by spaces, commas or new lines. With headings like "Devikins", "Weapons" and
            "Equipment", one paste can hold all three; otherwise pick the kind first.
          </Text>
          <View style={styles.chipRow}>
            {PASTE_KINDS.map((k) => (
              <TouchableOpacity
                key={String(k.key)}
                style={[styles.chip, { borderColor: colors.border, backgroundColor: pasteKind === k.key ? colors.primary : colors.surfaceAlt }]}
                onPress={() => setPasteKind(k.key)}
              >
                <Text style={{ color: pasteKind === k.key ? colors.primaryText : colors.text, fontSize: 13 }}>{k.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={[input, styles.pasteBox]}
            value={pasteText}
            onChangeText={setPasteText}
            placeholder={'Weapons\n3265\n1442, 1450\n\nEquipment\n1022'}
            placeholderTextColor={colors.secondaryText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.switchRow}>
            <Text style={[styles.text, { color: colors.text, flex: 1 }]}>I've requested these in the game just now</Text>
            <Switch value={markOnAdd} onValueChange={setMarkOnAdd} />
          </View>
          <TouchableOpacity style={[button, !pasteText.trim() && { opacity: 0.5 }]} onPress={addFromPaste} disabled={!pasteText.trim()}>
            <Text style={buttonText}>Add to the list</Text>
          </TouchableOpacity>
          {addMessage ? <Text style={[styles.note, { color: colors.text }]}>{addMessage}</Text> : null}
        </View>

        {/* 3. Status */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>3. Status</Text>
          {!walletsReady ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Save both wallets first (step 1).</Text>
          ) : (
            <>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={[button, (checking || items.length === 0) && { opacity: 0.5 }]} onPress={() => check(false)} disabled={checking || items.length === 0}>
                  <Text style={buttonText}>Check now</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[smallButton, (checking || items.length === 0) && { opacity: 0.5 }]} onPress={() => check(true)} disabled={checking || items.length === 0}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>Full check</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                "Check now" looks up the NFTs marked as requested (and new ones). "Full check" looks up every NFT on the
                list - for long lists that takes a few minutes.
                {lastCheck ? ` Last check: ${formatTime(lastCheck)}.` : ''}
              </Text>
              {checking ? (
                <View style={styles.inlineRow}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={[styles.note, { color: colors.text, flex: 1 }]}>{progress}</Text>
                </View>
              ) : null}
              {checkMessage ? <Text style={[styles.note, { color: colors.cancelText }]}>{checkMessage}</Text> : null}
            </>
          )}

          {[
            [KIND_FILTERS, kindFilter, setKindFilter],
            [PLACE_FILTERS, placeFilter, setPlaceFilter],
            [SORTS, sortMode, setSortMode],
          ].map(([options, value, setValue], rowIndex) => (
            <View key={rowIndex} style={styles.chipRow}>
              {options.map((o) => (
                <TouchableOpacity
                  key={o.key}
                  style={[styles.chipSmall, { borderColor: value === o.key ? colors.primary : colors.border }]}
                  onPress={() => {
                    setValue(o.key);
                    setShownRows(ROWS_PER_PAGE);
                  }}
                >
                  <Text style={{ color: value === o.key ? colors.primary : colors.secondaryText, fontSize: 12, fontWeight: value === o.key ? '700' : '400' }}>
                    {options === KIND_FILTERS ? `${o.label} (${kindCounts[o.key] ?? 0})` : o.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}

          <View style={styles.chipRow}>
            {FILTERS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.chip, { borderColor: colors.border, backgroundColor: filter === f.key ? colors.primary : colors.surfaceAlt }]}
                onPress={() => {
                  setFilter(f.key);
                  setShownRows(ROWS_PER_PAGE);
                }}
              >
                <Text style={{ color: filter === f.key ? colors.primaryText : colors.text, fontSize: 13 }}>
                  {f.label} ({counts[f.key]})
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {overdueTotal > 0 ? (
            <View style={styles.buttonRow}>
              <TouchableOpacity style={smallButton} onPress={copyOverdue}>
                <Text style={{ color: colors.cancelText, fontWeight: '700' }}>
                  {IS_WEB ? 'Copy' : 'Share'} the overdue list ({overdueTotal}) for a support ticket
                </Text>
              </TouchableOpacity>
              {/* Where the ticket goes (Raphael: "I need to look it up every
                  single time"). */}
              <TouchableOpacity
                style={smallButton}
                onPress={() => Linking.openURL(SUPPORT_URL)}
                accessibilityRole="link"
              >
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Open a ticket at Klever support ↗</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {selected.size > 0 ? (
            <View style={[styles.selectionBar, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
              <Text style={[styles.text, { color: colors.text }]}>{selected.size} selected</Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={button} onPress={() => markSelected(true)}>
                  <Text style={buttonText}>Mark requested</Text>
                </TouchableOpacity>
                <TouchableOpacity style={smallButton} onPress={() => markSelected(false)}>
                  <Text style={{ color: colors.text }}>Clear mark</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[smallButton, (checking || !walletsReady) && { opacity: 0.5 }]}
                  onPress={() => check(true, selectedItems)}
                  disabled={checking || !walletsReady}
                >
                  <Text style={{ color: colors.text, fontWeight: '700' }}>Check selected</Text>
                </TouchableOpacity>
                <TouchableOpacity style={smallButton} onPress={removeSelected}>
                  <Text style={{ color: colors.cancelText }}>Remove</Text>
                </TouchableOpacity>
                <TouchableOpacity style={smallButton} onPress={() => setSelected(new Set())}>
                  <Text style={{ color: colors.text }}>Unselect</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : filtered.length > 0 ? (
            <TouchableOpacity onPress={() => setSelected(new Set(filtered.map(keyOf)))}>
              <Text style={[styles.link, { color: colors.primary }]}>Select all {filtered.length} shown</Text>
            </TouchableOpacity>
          ) : null}

          {items.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>No NFTs on the list yet (step 2).</Text>
          ) : null}

          {/* The rows sit in their own box that scrolls by itself, so a long
              list doesn't push the rest of the screen far down (Raphael,
              12 Oct 2026). */}
          {filtered.length > 0 ? (
            <ScrollView
              style={[styles.listBox, { borderColor: colors.border }]}
              nestedScrollEnabled
              testID="withdrawals-list-box"
            >
            {filtered.slice(0, shownRows).map((item) => {
              const isSelected = selected.has(keyOf(item));
              return (
                <TouchableOpacity
                  key={keyOf(item)}
                  style={[styles.row, { borderColor: colors.border, backgroundColor: isSelected ? colors.progressBackground : 'transparent' }]}
                  onPress={() => toggleSelected(item)}
                >
                  <Text style={[styles.checkbox, { color: isSelected ? colors.primary : colors.secondaryText }]}>{isSelected ? '☑' : '☐'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                      {KIND_LABEL[item.kind]} #{item.nonce}
                      <Text style={{ color: statusColor(item.status), fontWeight: '700' }}>  {STATUS_TEXT[item.status]}</Text>
                    </Text>
                    {describe(item) ? <Text style={[styles.note, { color: colors.secondaryText }]}>{describe(item)}</Text> : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => Linking.openURL(kleverscanNftUrl(item.kind, item.nonce))}
                    accessibilityRole="link"
                    accessibilityLabel={`${KIND_LABEL[item.kind]} #${item.nonce} on Kleverscan`}
                    style={{ paddingHorizontal: 6, paddingVertical: 2 }}
                  >
                    <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>Kleverscan ↗</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })}
            {filtered.length > shownRows ? (
              <TouchableOpacity style={{ padding: 10 }} onPress={() => setShownRows((n) => n + ROWS_PER_PAGE)}>
                <Text style={[styles.link, { color: colors.primary }]}>Show more ({filtered.length - shownRows} left)</Text>
              </TouchableOpacity>
            ) : null}
            </ScrollView>
          ) : null}
        </View>

        {/* 4. Arrivals log */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>Arrivals in your receiving wallet</Text>
          {arrivals.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Nothing yet - each check adds new arrivals here.</Text>
          ) : (
            arrivals.slice(0, 50).map((a) => (
              <TouchableOpacity key={`${a.tx_hash}:${a.kind}:${a.nonce}`} onPress={() => Linking.openURL(`https://kleverscan.org/transaction/${a.tx_hash}`)}>
                <Text style={[styles.note, { color: colors.text }]}>
                  {formatTime(a.timestamp)} · {KIND_LABEL[a.kind]} #{a.nonce} · from {walletName(a.from_address)}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  listBox: {
    maxHeight: 420,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 6,
  },
  container: { flex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 12, gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  backButtonText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  content: { paddingHorizontal: 12, paddingBottom: 32, gap: 12, maxWidth: 760, width: '100%' },
  card: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 10 },
  heading: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 14, fontWeight: '600' },
  text: { fontSize: 15, lineHeight: 21 },
  note: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14 },
  minutesInput: { width: 80, textAlign: 'center' },
  pasteBox: { minHeight: 120, textAlignVertical: 'top' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipSmall: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  button: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '700' },
  smallButton: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  selectionBar: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 },
  link: { fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  pickerBox: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  pickerRow: { paddingVertical: 8, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderTopWidth: 1, borderRadius: 6 },
  checkbox: { fontSize: 20, lineHeight: 22 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
});
