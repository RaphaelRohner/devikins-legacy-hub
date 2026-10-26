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
 *      Tick "Requested in game" (or mark rows later): anything marked
 *      that hasn't arrived after N minutes (default 30) is overdue.
 *   3. Check: asks Klever's API where every NFT that hasn't arrived yet is.
 *   4. Results: filters, the list, and the tools for ticked rows (Mark
 *      requested, Undo request, Check selected, Unselect, Remove).
 * Sections 3 and 4 were split on 14 Oct 2026 (Raphael): one Check button
 * for the whole list, and everything about specific NFTs next to the list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useKeepFocusedInputVisible from '../hooks/useKeepFocusedInputVisible';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
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
import { IN_GAME_WALLET_NAME, MY_WALLET_NAME } from '../constants/walletNames';
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
import { openKleverscan } from '../api/openKleverscan';

// Where withdrawal problems are reported (Klever's help centre).
const SUPPORT_URL = 'https://support.klever.org/';

const IS_WEB = Platform.OS === 'web';
const KEY_FROM = WITHDRAW_SETTING_KEYS.from;
const KEY_TO = WITHDRAW_SETTING_KEYS.to;
const KEY_OVERDUE = WITHDRAW_SETTING_KEYS.overdue;
const KEY_LAST_CHECK = WITHDRAW_SETTING_KEYS.lastCheck;
// Requested NFTs that haven't arrived are looked up by themselves this
// often while the screen is open (Raphael, 16 Oct 2026: "Overdue" came by
// itself, but "Arrived" needed a manual Check). Only those few, so it
// puts little load on Klever's servers.
const AUTO_CHECK_MINUTES = 5;
const ROWS_PER_PAGE = 100;

const STATUS_TEXT = {
  arrived: 'Arrived',
  overdue: 'Overdue',
  requested: 'Requested - waiting',
  'requested-elsewhere': 'Requested - in another wallet!',
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
const STATUS_ORDER = ['overdue', 'requested-elsewhere', 'requested', 'elsewhere', 'not-found', 'in-game', 'main', 'unchecked', 'arrived'];

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

// What each chip means - shown when the mouse rests on a chip (website)
// or when a chip is pressed and held (app). Raphael, 14 Oct 2026: "a mouse
// over pop up explaining exactly what it does would be great". The kind
// chips (Devikins, Weapons, ...) explain themselves and have none.
const CHIP_HELP = {
  game: "Still in the game: NFTs in your in-game wallet or in the game's main wallet - everything you'd still have to withdraw.",
  'in-game': 'In-game wallet: NFTs in your own in-game wallet (the "Withdraw from" address in step 1).',
  main: "Game's main wallet: NFTs in the big wallet the game keeps for all players (klv1a35l…).",
  elsewhere:
    "Another wallet: NFTs held by an address that is neither yours nor the game's - for example a seller's game wallet after a marketplace buy, or an NFT sent to the wrong place.",
  'not-found': 'Not found: IDs that don\'t exist on the chain - never created, or burned. Often a typo in the ID.',
  any: 'Anywhere: no filter by place - shows NFTs wherever they are.',
  attention: 'Needs attention first: Overdue at the top, then Requested, Another wallet, Not found, still in the game, not checked yet - Arrived at the bottom.',
  'id-asc': 'ID ↑: smallest ID first.',
  'id-desc': 'ID ↓: biggest ID first.',
  all: 'All: every NFT the other chips above let through.',
  requested: 'Requested: NFTs you marked as requested that haven\'t arrived yet (Overdue ones included). One marked in red sits in someone else\'s wallet - worth a look.',
  overdue: 'Overdue: marked as requested, but not arrived within the time set in step 1. These are the ones for a support ticket.',
  arrived: 'Arrived: NFTs found in your receiving wallet ("Receive in" in step 1).',
  'not-requested': "Not requested: NFTs on the list you haven't marked as requested and that haven't arrived - the Hub only tells you where they are.",
};
// Kind chips use the key 'all' too; they get no explanation.
// What each button for ticked rows does - on hover (website) or when the
// button is held (phone). Raphael, 16 Oct 2026.
const BAR_HELP = {
  mark: "You've asked the game to withdraw these. The Hub notes the time and shows them as Overdue if they haven't arrived after the waiting time.",
  undo: 'You marked these as requested by mistake (or not yet). This only removes the Hub\'s note - it doesn\'t cancel anything in the game.',
  check: 'Looks up on the Klever blockchain where just these NFTs are right now.',
  unselect: 'Unticks all rows. Nothing else changes.',
  remove: "Takes these off your Withdrawals list. The NFTs themselves aren't touched.",
};

function chipHelpFor(options, key) {
  if (options === KIND_FILTERS) return null;
  return CHIP_HELP[key] || null;
}

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

export default function WithdrawalTrackerView({ onClose, isMySetActive = false, onFetchNow }) {
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
  // Kind / Where / Order fold away behind "More filters" so the list starts
  // right under the Status row on a phone (fresh-eyes review, 15 Oct 2026:
  // 17 chips on 9 lines before the first NFT).
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const moreFiltersSummary = [
    kindFilter !== 'all' ? KIND_FILTERS.find((o) => o.key === kindFilter)?.label : null,
    placeFilter !== 'any' ? PLACE_FILTERS.find((o) => o.key === placeFilter)?.label : null,
    sortMode !== 'attention' ? SORTS.find((o) => o.key === sortMode)?.label : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // The chip explanation on show: { row, text } (row = which chip row it belongs under).
  const [chipHint, setChipHint] = useState(null);
  // Press-and-hold (phone): the box shows while the finger is down and
  // closes by itself 3 seconds after letting go, so it never stays on top
  // of the chips below (fresh-eyes review, 14 Oct 2026). Tapping it closes
  // it at once.
  const hintTimer = useRef(null);
  function showHeldHint(row, text) {
    clearTimeout(hintTimer.current);
    setChipHint({ row, text, held: true });
  }
  function releaseHeldHint(text) {
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setChipHint((h) => (h && h.held && h.text === text ? null : h)), 3000);
  }
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  const [selected, setSelected] = useState(() => new Set());
  const [shownRows, setShownRows] = useState(ROWS_PER_PAGE);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState('');
  const [checkMessage, setCheckMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [pickerFor, setPickerFor] = useState(null); // 'from' | 'to' | null
  const [myWallets, setMyWallets] = useState(null); // null = not loaded yet
  const cancelRef = useRef(false);
  // True when step 1 was filled in from the wallet names (shown as a note).
  const [autoFilledNote, setAutoFilledNote] = useState(false);

  // The newest list, for a check started from a box's button (whose
  // callback was made before the list was reloaded).
  const itemsRef = useRef([]);
  const scrollRef = useRef(null);
  // The field you type in stays in view when the keyboard opens (Android app, 26 Oct 2026).
  useKeepFocusedInputVisible(scrollRef);
  const checkSectionYRef = useRef(0);
  const reload = useCallback(async () => {
    const [list, log] = await Promise.all([getWithdrawalItems(), getWithdrawalArrivals()]);
    itemsRef.current = list;
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
      let savedFrom = from || '';
      let savedTo = to || '';
      let draftFrom = savedFrom;
      let draftTo = savedTo;
      // Not set up yet: use the wallets named "In-game wallet" / "My wallet"
      // on the Wallets screen (14 Oct 2026). Both found -> saved straight
      // away; only one -> filled in, waiting for Save.
      if (!savedFrom || !savedTo) {
        try {
          const all = await getWalletsFromAllSets();
          const named = (name) => all.find((w) => (w.alias || '').trim().toLowerCase() === name.toLowerCase())?.address || '';
          if (!draftFrom) draftFrom = named(IN_GAME_WALLET_NAME);
          if (!draftTo) draftTo = named(MY_WALLET_NAME);
          if (
            !savedFrom && !savedTo &&
            isValidKleverAddress(draftFrom) && isValidKleverAddress(draftTo) && draftFrom !== draftTo
          ) {
            await setGlobalSetting(KEY_FROM, draftFrom);
            await setGlobalSetting(KEY_TO, draftTo);
            savedFrom = draftFrom;
            savedTo = draftTo;
            setAutoFilledNote(true);
          }
        } catch (e) {
          // Not fatal - the addresses can still be entered by hand.
        }
      }
      setFromAddress(savedFrom);
      setFromDraft(draftFrom);
      setToAddress(savedTo);
      setToDraft(draftTo);
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

  // "Adding…" on the button while it works - with a long list and a fetch
  // running it can take a moment, and a silent button looked dead.
  const [isAdding, setIsAdding] = useState(false);
  async function addFromPaste(kindOverride = null) {
    if (isAdding) return;
    setIsAdding(true);
    try {
      await addFromPasteNow(kindOverride);
    } catch (err) {
      setAddMessage(`Something went wrong while adding: ${err?.message || String(err)}`);
    } finally {
      setIsAdding(false);
    }
  }

  async function addFromPasteNow(kindOverride = null) {
    const { items: parsed, unassigned, ignored } = parseIdList(pasteText, kindOverride || pasteKind);
    // Only numbers, no heading and no kind picked: ask right away instead of
    // a small note under the button (Raphael, 15 Oct 2026: the button
    // seemed to do nothing).
    if (parsed.length === 0 && unassigned.length > 0) {
      Alert.alert(
        'Which kind are these?',
        `${unassigned.length} ID${unassigned.length === 1 ? '' : 's'} without a heading. Are they Devikins, Weapons or Equipment? (For a mixed list, put a heading - "Devikins", "Weapons", "Equipment" - above each part.)`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Devikins', onPress: () => addFromPaste('devikin') },
          { text: 'Weapons', onPress: () => addFromPaste('weapon') },
          { text: 'Equipment', onPress: () => addFromPaste('equipment') },
        ]
      );
      return;
    }
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
      // Back off after each add, so the next paste isn't marked by accident
      // (fresh-eyes review, 14 Oct 2026).
      setMarkOnAdd(false);
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
    // Nothing added at all: say so in a box too, not only in the small line
    // under the button (Raphael, 15 Oct 2026: "not just nothing").
    if (parsed.length === 0) {
      Alert.alert('Nothing added', `${notes.join(' ')}\n\nPaste NFT ID numbers, e.g. "Weapons" on one line and the numbers below it.`);
    }
    await reload(); // first refresh the list, then say what happened
    setAddMessage(notes.join(' '));
    // Guided setup: in the "My wallets" set these NFTs show in the
    // collection after the next fetch - offer it right away.
    if (parsed.length > 0 && isMySetActive && onFetchNow) {
      const canCheck = walletsReady;
      Alert.alert(
        'Show them in your collection?',
        canCheck
          ? 'First the Hub looks up where each one is (that takes a moment for a long list - the progress shows under "3. Check"), then a Fetch/Update loads their details and pictures, so they appear next to the ones in your wallets - each with a small note saying where it is.'
          : 'A Fetch/Update loads the details and pictures of the NFTs you just added, so they appear next to the ones in your wallets.',
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Fetch now',
            onPress: async () => {
              // Where each one is first (Raphael, 15 Oct 2026: they all said
              // "not checked yet"), then the fetch.
              // Jump down to "3. Check" so the counting progress is in view
              // (Raphael, 15 Oct 2026: the page stayed at the top and it
              // looked like nothing was happening).
              scrollRef.current?.scrollTo({ y: Math.max(0, checkSectionYRef.current - 8), animated: false }); // instant: an animation could be cut short when the check finishes quickly
              if (canCheck) await check(false);
              onFetchNow();
            },
          },
        ]
      );
    }
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
        items: onlyItems || itemsRef.current || items,
        fromAddress,
        toAddress,
        full: onlyItems ? true : full,
        knownHashes,
        shouldCancel: () => cancelRef.current,
        onProgress: (p) => {
          if (p.phase === 'arrivals') setProgress('Reading arrivals in your receiving wallet…');
          else if (p.phase === 'lookups') setProgress(p.total ? `Looking up NFTs: ${p.current} of ${p.total}` : '');
          else if (p.phase === 'waiting') setProgress(`Looking up NFTs: ${p.current} of ${p.total} - Klever asks to slow down, waiting a moment…`);
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

  // The automatic check (see AUTO_CHECK_MINUTES): runs when the screen
  // opens if the last check is older than that, then again every 5 minutes.
  const lastAutoCheckRef = useRef(0);
  useEffect(() => {
    if (!loaded || !walletsReady || checking) return;
    const waiting = withStatus.filter((i) => i.requested_at && i.status !== 'arrived');
    if (waiting.length === 0) return;
    const last = Math.max(lastCheck || 0, lastAutoCheckRef.current);
    if (Date.now() - last < AUTO_CHECK_MINUTES * 60 * 1000) return;
    lastAutoCheckRef.current = Date.now();
    check(true, waiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, loaded, walletsReady, checking, withStatus, lastCheck]);

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
    if (item.status === 'requested-elsewhere' || (item.status === 'overdue' && item.place === 'elsewhere')) {
      parts.push("check this - if you bought it on the marketplace, it may still sit in the seller's game wallet until the game sends it");
    }
    if (item.previous_holder && item.previous_holder !== item.holder) {
      parts.push(`moved from ${walletName(item.previous_holder)}`);
    }
    if (item.checked_at) parts.push(`as of ${formatTime(item.checked_at)}`);
    return parts.join(' · ');
  }

  // Overdue AND in a stranger's wallet keeps saying so - the scariest case,
  // and the one support most needs to hear about (fresh-eyes review, 15 Oct 2026).
  function statusLabel(item) {
    if (item.status === 'overdue' && item.place === 'elsewhere') return 'Overdue - in another wallet!';
    return STATUS_TEXT[item.status];
  }

  function statusColor(status) {
    if (status === 'overdue' || status === 'requested-elsewhere' || status === 'elsewhere' || status === 'not-found') return colors.cancelText;
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

      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        {/* Sections 1 and 2 share a wrapper whose size is tracked: on the
            website a section's own position isn't reported again when
            something above it grows, but a size change is - so "3. Check"
            starts right below this wrapper. */}
        <View
          style={{ gap: 12 }}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            checkSectionYRef.current = y + height + 12;
          }}
        >
        {/* 1. Wallets */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>1. Your wallets</Text>
          <Text style={[styles.note, { color: colors.secondaryText }]}>
            The game sends withdrawals from your in-game wallet (or from the game's main wallet) to your own wallet.
            Only public addresses are used - never keys.
          </Text>
          {autoFilledNote ? (
            <Text style={[styles.note, { color: colors.primary }]}>
              Filled in from your wallets named "{IN_GAME_WALLET_NAME}" and "{MY_WALLET_NAME}".
            </Text>
          ) : null}
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
            placeholder={'Example (use your own IDs):\nWeapons\n111\n222, 333\n\nEquipment\n444'}
            placeholderTextColor={colors.secondaryText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.switchRow}>
            <Text style={[styles.text, { color: colors.text, flex: 1 }]}>Requested in game</Text>
            <Switch value={markOnAdd} onValueChange={setMarkOnAdd} />
          </View>
          <TouchableOpacity style={[button, (!pasteText.trim() || isAdding) && { opacity: 0.5 }]} onPress={() => addFromPaste()} disabled={!pasteText.trim() || isAdding}>
            <Text style={buttonText}>{isAdding ? 'Adding…' : 'Add to the list'}</Text>
          </TouchableOpacity>
          {addMessage ? <Text style={[styles.note, { color: colors.text }]}>{addMessage}</Text> : null}
        </View>

        </View>

        {/* 3. Check */}
        <View testID="check-section" style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>3. Check</Text>
          {!walletsReady ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Save both wallets first (step 1).</Text>
          ) : (
            <>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={[button, (checking || items.length === 0) && { opacity: 0.5 }]} onPress={() => check(false)} disabled={checking || items.length === 0}>
                  <Text style={buttonText}>Check</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.note, { color: colors.secondaryText }]}>
                Looks up every NFT on the list that hasn't arrived yet - for long lists that takes a few minutes. To
                look up specific NFTs (arrived ones too), tick them under Results and tap "Check selected".
                {' '}NFTs you've requested are also checked by themselves every {AUTO_CHECK_MINUTES} minutes while this screen is open.
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
        </View>

        {/* 4. Results */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>4. Results</Text>
          {[
            [FILTERS, filter, setFilter, null, 0],
            ...(moreFiltersOpen
              ? [
                  [KIND_FILTERS, kindFilter, setKindFilter, 'Kind:', 1],
                  [PLACE_FILTERS, placeFilter, setPlaceFilter, 'Where:', 2],
                  [SORTS, sortMode, setSortMode, 'Order:', 3],
                ]
              : []),
          ].map(([options, value, setValue, rowLabel, rowIndex]) => {
            const big = options === FILTERS;
            // The explanation floats over what's below (like a tooltip), so
            // the chips never jump around under the mouse.
            return (
              <View key={rowIndex} style={{ position: 'relative', zIndex: chipHint && chipHint.row === rowIndex ? 10 : 1 }}>
                <View style={styles.chipRow}>
                  {rowLabel ? <Text style={[styles.chipRowLabel, { color: colors.secondaryText }]}>{rowLabel}</Text> : null}
                  {options.map((o) => {
                    const on = value === o.key;
                    const help = chipHelpFor(options, o.key);
                    const label = options === KIND_FILTERS ? `${o.label} (${kindCounts[o.key] ?? 0})` : big ? `${o.label} (${counts[o.key]})` : o.label;
                    return (
                      <Pressable
                        key={o.key}
                        style={
                          big
                            ? [styles.chip, { borderColor: colors.border, backgroundColor: on ? colors.primary : colors.surfaceAlt }]
                            : [styles.chipSmall, { borderColor: on ? colors.primary : colors.border }]
                        }
                        onPress={() => {
                          setChipHint(null);
                          setValue(o.key);
                          setShownRows(ROWS_PER_PAGE);
                        }}
                        onLongPress={help ? () => showHeldHint(rowIndex, help) : undefined}
                        onPressOut={help ? () => releaseHeldHint(help) : undefined}
                        onHoverIn={help ? () => setChipHint({ row: rowIndex, text: help }) : undefined}
                        onHoverOut={help ? () => setChipHint((h) => (h && h.text === help ? null : h)) : undefined}
                        accessibilityHint={help || undefined}
                      >
                        <Text
                          style={
                            big
                              ? { color: on ? colors.primaryText : colors.text, fontSize: 13 }
                              : { color: on ? colors.primary : colors.secondaryText, fontSize: 12, fontWeight: on ? '700' : '400' }
                          }
                        >
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {chipHint && chipHint.row === rowIndex ? (
                  <Pressable
                    onPress={() => setChipHint(null)}
                    style={[styles.chipHint, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                    testID="chip-hint"
                  >
                    <Text style={[styles.note, { color: colors.text }]}>{chipHint.text}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          <TouchableOpacity
            testID="more-filters"
            onPress={() => {
              setChipHint(null);
              setMoreFiltersOpen((open) => !open);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded: moreFiltersOpen }}
            style={styles.moreFiltersButton}
          >
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>
              {moreFiltersOpen ? 'Fewer filters ▴' : 'More filters ▾'}
            </Text>
            {/* Folded away but in use: say so, so the list never looks
                mysteriously short. */}
            {!moreFiltersOpen && moreFiltersSummary ? (
              <Text style={[styles.note, { color: colors.secondaryText, flexShrink: 1 }]} numberOfLines={1}>
                {moreFiltersSummary}
              </Text>
            ) : null}
          </TouchableOpacity>
          {!IS_WEB ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Hold a chip or button to see what it means.</Text>
          ) : null}

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
              {/* Each button explains itself on hover (website) or when held
                  (phone); Remove sits last so it isn't hit by accident
                  (Raphael, 16 Oct 2026: "Clear mark" was jargon). */}
              <View style={{ position: 'relative', zIndex: chipHint && chipHint.row === 'bar' ? 10 : 1 }}>
                <View style={styles.buttonRow}>
                  {[
                    { key: 'mark', label: 'Mark requested', main: true, onPress: () => markSelected(true) },
                    { key: 'undo', label: 'Undo request', onPress: () => markSelected(false) },
                    {
                      key: 'check',
                      label: 'Check selected',
                      bold: true,
                      disabled: checking || !walletsReady,
                      onPress: () => check(true, selectedItems),
                    },
                    { key: 'unselect', label: 'Unselect', onPress: () => setSelected(new Set()) },
                    { key: 'remove', label: 'Remove', danger: true, onPress: removeSelected },
                  ].map((b) => {
                    const help = BAR_HELP[b.key];
                    return (
                      <Pressable
                        key={b.key}
                        testID={`bar-${b.key}`}
                        style={[b.main ? button : smallButton, b.disabled && { opacity: 0.5 }]}
                        disabled={b.disabled}
                        onPress={() => {
                          setChipHint(null);
                          b.onPress();
                        }}
                        onLongPress={() => showHeldHint('bar', help)}
                        onPressOut={() => releaseHeldHint(help)}
                        onHoverIn={() => setChipHint({ row: 'bar', text: help })}
                        onHoverOut={() => setChipHint((h) => (h && h.text === help ? null : h))}
                        accessibilityRole="button"
                        accessibilityHint={help}
                      >
                        <Text
                          style={
                            b.main
                              ? buttonText
                              : { color: b.danger ? colors.cancelText : colors.text, fontWeight: b.bold ? '700' : '400' }
                          }
                        >
                          {b.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {chipHint && chipHint.row === 'bar' ? (
                  <Pressable
                    onPress={() => setChipHint(null)}
                    style={[styles.chipHint, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}
                    testID="bar-hint"
                  >
                    <Text style={[styles.note, { color: colors.text }]}>{chipHint.text}</Text>
                  </Pressable>
                ) : null}
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
                      <Text style={{ color: statusColor(item.status), fontWeight: '700' }}>  {statusLabel(item)}</Text>
                    </Text>
                    {describe(item) ? <Text style={[styles.note, { color: colors.secondaryText }]}>{describe(item)}</Text> : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => openKleverscan(kleverscanNftUrl(item.kind, item.nonce))}
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

        {/* Arrivals log */}
        <View style={card}>
          <Text style={[styles.heading, { color: colors.text }]}>Arrivals in your receiving wallet</Text>
          {arrivals.length === 0 ? (
            <Text style={[styles.note, { color: colors.secondaryText }]}>Nothing yet - each check adds new arrivals here.</Text>
          ) : (
            arrivals.slice(0, 50).map((a) => (
              <TouchableOpacity key={`${a.tx_hash}:${a.kind}:${a.nonce}`} onPress={() => openKleverscan(`https://kleverscan.org/transaction/${a.tx_hash}`)}>
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chipRowLabel: { fontSize: 12, fontWeight: '600', minWidth: 46 },
  moreFiltersButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipSmall: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  chipHint: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
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
