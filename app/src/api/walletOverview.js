/**
 * walletOverview.js - the logic behind "Where are my NFTs?"
 * (WalletOverviewView.js, under Browse NFTs). Agreed with Raphael on
 * 22-23 Oct 2026 (project doc HUB-NEXT-FEATURES-23-OCT.md):
 *
 *   - one row per wallet: the wallets of the loaded set first, then, for
 *     the "My wallets" set, wherever the NFTs on the Withdrawals list are
 *     (the game's main wallet, other people's wallets, ...);
 *   - columns Devikins / Weapons / Equipment, plus a total;
 *   - tapping a row opens the normal Browse list with just those NFTs;
 *   - "Check now" looks every NFT up on the chain, one by one (Klever's
 *     "what does this wallet hold" list can lag behind - see
 *     withdrawalTracker.js), and the table then shows those answers.
 *
 * Lookups ask Klever's node first whether an NFT is still where it was (or
 * in one of the likely wallets) - quick; only the rest go through the API,
 * which allows 30 a minute (see withdrawalTracker.js lookUpHolders).
 *
 * Where each NFT is comes from:
 *   - NFTs from the Withdrawals list: the tracker's last lookup (the same
 *     lookup "Check now" runs, so the tracker is updated too);
 *   - the wallets' own NFTs: the last "Check now" (kept in the set's own
 *     settings, OVERVIEW_CHECK_KEY), or else the wallet the last
 *     Fetch/Update found it in.
 * NFTs marked as deleted aren't counted (only how many there are).
 */
import { COLLECTIONS } from '../constants/schema';
import { ID_LIST_OWNER } from '../constants/idList';
import { GAME_MAIN_WALLET, KINDS, lookUpHolders, runWithdrawalCheck } from './withdrawalTracker';

// Per-set setting: { checkedAt, holders: { "kind:nonce": address | null } }
export const OVERVIEW_CHECK_KEY = 'wallet_overview_check';

export function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function emptyCounts() {
  return Object.fromEntries(KINDS.map((k) => [k, 0]));
}
function emptyNonces() {
  return Object.fromEntries(KINDS.map((k) => [k, []]));
}

/** Reads the saved "Check now" result (or an empty one). */
export function parseOverviewCheck(text) {
  try {
    const value = JSON.parse(text || 'null');
    if (value && typeof value.checkedAt === 'number' && value.holders && typeof value.holders === 'object') return value;
  } catch (e) {
    // fall through
  }
  return { checkedAt: 0, holders: {} };
}

/**
 * Builds the table.
 *   wallets       [{ address, alias }] of the loaded set, in their order
 *   rowsByKind    { kind: [{ nonce, owner_address, deleted }] } (getNftPlaces)
 *   listItems     rows of the Withdrawals list (getWithdrawalItems)
 *   includeList   true for the "My wallets" set: list NFTs count even
 *                 before a Fetch/Update has loaded their details
 *   check         parseOverviewCheck(...)
 *   fromAddress / toAddress  the tracker's in-game and receiving wallets
 * Returns { rows: [{ key, label, detail, type, counts, nonces, total }],
 *           totals, deleted }.
 */
export function buildOverview({ wallets, rowsByKind, listItems = [], includeList = false, check = { checkedAt: 0, holders: {} }, fromAddress = '', toAddress = '' }) {
  const own = new Map(wallets.map((w) => [w.address, w]));
  const listByKey = new Map(listItems.map((i) => [`${i.kind}:${i.nonce}`, i]));
  const rows = new Map();
  const totals = emptyCounts();
  let deleted = 0;

  function rowFor(place) {
    if (rows.has(place)) return rows.get(place);
    let row;
    if (place === 'unchecked') {
      row = { label: 'Not looked up yet', detail: 'On your Withdrawals list - "Check now" finds them', type: 'unchecked' };
    } else if (place === 'notfound') {
      row = { label: 'Not found on the chain', detail: 'Klever doesn\'t know this NFT (any more)', type: 'notfound' };
    } else if (own.has(place)) {
      const w = own.get(place);
      row = { label: w.alias || shortAddress(place), detail: w.alias ? shortAddress(place) : '', type: 'own' };
    } else if (place === GAME_MAIN_WALLET) {
      row = { label: "The game's main wallet", detail: shortAddress(place), type: 'game' };
    } else if (place === fromAddress) {
      row = { label: 'Your in-game wallet', detail: shortAddress(place), type: 'game' };
    } else if (place === toAddress) {
      row = { label: 'Your receiving wallet', detail: shortAddress(place), type: 'own' };
    } else {
      row = { label: 'Another wallet', detail: shortAddress(place), type: 'other' };
    }
    row = { key: place, address: own.has(place) || place.startsWith('klv1') ? place : null, ...row, counts: emptyCounts(), nonces: emptyNonces(), total: 0 };
    rows.set(place, row);
    return row;
  }

  // The set's own wallets always get a row, even when empty.
  for (const w of wallets) rowFor(w.address);

  function place(kind, nonce, where) {
    const row = rowFor(where);
    row.counts[kind] += 1;
    row.nonces[kind].push(nonce);
    row.total += 1;
    totals[kind] += 1;
  }
  const listPlace = (item) => (!item || !item.checked_at ? 'unchecked' : item.holder || 'notfound');

  const seen = new Set();
  for (const kind of KINDS) {
    for (const nft of rowsByKind[kind] || []) {
      seen.add(`${kind}:${nft.nonce}`);
      if (nft.deleted) {
        deleted += 1;
        continue;
      }
      const key = `${kind}:${nft.nonce}`;
      let where;
      if (nft.owner_address === ID_LIST_OWNER) where = listPlace(listByKey.get(key));
      else if (Object.prototype.hasOwnProperty.call(check.holders, key)) where = check.holders[key] || 'notfound';
      else where = nft.owner_address;
      place(kind, nft.nonce, where);
    }
  }
  // List NFTs whose details haven't been fetched yet still count.
  if (includeList) {
    for (const item of listItems) {
      if (!KINDS.includes(item.kind) || seen.has(`${item.kind}:${item.nonce}`)) continue;
      place(item.kind, item.nonce, listPlace(item));
    }
  }

  const ORDER = { own: 0, game: 1, other: 2, notfound: 3, unchecked: 4 };
  const ownOrder = new Map(wallets.map((w, i) => [w.address, i]));
  const sorted = [...rows.values()].sort((a, b) => {
    if (ORDER[a.type] !== ORDER[b.type]) return ORDER[a.type] - ORDER[b.type];
    if (ownOrder.has(a.key) && ownOrder.has(b.key)) return ownOrder.get(a.key) - ownOrder.get(b.key);
    if (ownOrder.has(a.key) !== ownOrder.has(b.key)) return ownOrder.has(a.key) ? -1 : 1;
    return b.total - a.total || a.key.localeCompare(b.key);
  });
  return { rows: sorted, totals, deleted };
}

/**
 * "Check now": looks up every (not deleted) NFT of the set on the chain.
 *   rowsByKind   as for buildOverview
 *   listItems    the Withdrawals list (looked up through the tracker's own
 *                check, so it learns the answers too) - [] if not included
 * Returns { check, listResult } for the caller to save:
 *   check        the new OVERVIEW_CHECK_KEY value for the wallets' own NFTs
 *   listResult   runWithdrawalCheck's result (or null)
 *   errors       lookups that failed
 *   stopped      true if Stop was pressed (whatever was found is kept)
 */
export async function runOverviewCheck({ wallets = [], rowsByKind, listItems = [], previousCheck, fromAddress, toAddress, knownHashes, onProgress, shouldCancel }) {
  const ownNfts = [];
  const before = previousCheck?.holders || {};
  for (const kind of KINDS) {
    for (const nft of rowsByKind[kind] || []) {
      if (nft.deleted || nft.owner_address === ID_LIST_OWNER) continue;
      const key = `${kind}:${nft.nonce}`;
      ownNfts.push({ kind, nonce: nft.nonce, known: before[key] || nft.owner_address });
    }
  }
  const total = ownNfts.length + listItems.length;
  const errors = [];

  // 1. The wallets' own NFTs.
  const found = await lookUpHolders(ownNfts, {
    guesses: [...wallets.map((w) => w.address), fromAddress, GAME_MAIN_WALLET, toAddress],
    errors,
    shouldCancel,
    onProgress: (p) => onProgress?.({ current: p.current, total, waiting: p.phase === 'waiting' }),
  });
  const holders = { ...(previousCheck?.holders || {}) };
  for (const [key, holder] of found) holders[key] = holder;
  // Forget answers about NFTs that aren't in these wallets any more.
  const stillHere = new Set(ownNfts.map((n) => `${n.kind}:${n.nonce}`));
  for (const key of Object.keys(holders)) if (!stillHere.has(key)) delete holders[key];
  const check = { checkedAt: Date.now(), holders };

  // 2. The Withdrawals list (through the tracker).
  let listResult = null;
  if (listItems.length > 0 && !shouldCancel?.()) {
    listResult = await runWithdrawalCheck({
      items: listItems,
      fromAddress,
      toAddress,
      full: true,
      knownHashes,
      shouldCancel,
      onProgress: (p) => (p.phase === 'lookups' || p.phase === 'waiting') && onProgress?.({ current: ownNfts.length + p.current, total, waiting: p.phase === 'waiting' }),
    });
    errors.push(...listResult.errors);
  }
  return { check, listResult, errors, stopped: Boolean(shouldCancel?.()) };
}

export const KIND_COLUMNS = KINDS.map((kind) => ({ kind, label: COLLECTIONS[kind].label }));
