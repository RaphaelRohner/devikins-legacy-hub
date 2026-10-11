/**
 * withdrawalTracker.js
 *
 * The logic behind the Withdrawal tracker screen (WithdrawalTrackerView.js).
 * Design agreed with Raphael on 11 Oct 2026 (project doc
 * WITHDRAWAL-TRACKER.md):
 *
 *   - The chain never sees a withdrawal *request* (that happens on
 *     Moonlabs' server). It does show where every NFT is right now and
 *     every transfer, so the tracker asks Klever's API:
 *       1. which NFTs were transferred into the receiving wallet, when and
 *          from where (the arrivals log),
 *       2. where each NFT is right now (one request per NFT, gently).
 *   - NFTs the person marked "withdrawal requested" that haven't arrived
 *     after OVERDUE minutes (default 30 - the chain is fast) are overdue.
 *
 * Everything here talks to Klever's public API directly (it allows
 * websites), never to Moonlabs.
 */
import { COLLECTIONS } from '../constants/schema';

const KLEVER_API_BASE = 'https://api.mainnet.klever.org/v1.0';

export const KINDS = ['devikin', 'weapon', 'equipment'];
export const KIND_LABEL = { devikin: 'Devikin', weapon: 'Weapon', equipment: 'Equipment' };

// The Devikins game's main (custody) wallet, where most game NFTs sit.
export const GAME_MAIN_WALLET = 'klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf';

export const DEFAULT_OVERDUE_MINUTES = 30;

// One-by-one lookups: a few at a time with a short pause, so even a list
// of 1,500 NFTs doesn't hammer Klever's API.
const LOOKUP_PARALLEL = 4;
const LOOKUP_PAUSE_MS = 150;
// How far back the arrivals log looks the first time (later checks stop
// at the newest arrival already known).
const ARRIVALS_MAX_PAGES = 20;

const KIND_BY_COLLECTION = Object.fromEntries(KINDS.map((k) => [COLLECTIONS[k].assetId, k]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isValidKleverAddress(address) {
  return /^klv1[02-9ac-hj-np-z]{58}$/.test(String(address || '').trim());
}

// ---------------------------------------------------------------------------
// Reading an ID list
// ---------------------------------------------------------------------------

const HEADING_KIND = [
  [/devikin/i, 'devikin'],
  [/weapon/i, 'weapon'],
  [/equipment|equip/i, 'equipment'],
];

/**
 * Turns pasted text into NFTs. Understands:
 *   - section headings ("Devikins", "Weapon NFTs:", "Equipment") - the
 *     numbers below them belong to that kind (the format of Raphael's list)
 *   - numbers separated by spaces, commas, semicolons or new lines,
 *     with or without "#"
 *   - letter prefixes on single numbers: D123 / W123 / E123
 * `defaultKind` is used for numbers that come before any heading; if it's
 * null, those are reported in `unassigned` instead.
 * Returns { items: [{kind, nonce}], unassigned: [numbers], ignored: [text] }.
 */
export function parseIdList(text, defaultKind = null) {
  const items = [];
  const seen = new Set();
  const unassigned = [];
  const ignored = [];
  let currentKind = defaultKind;

  function add(kind, nonce) {
    const key = `${kind}:${nonce}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, nonce });
  }

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = HEADING_KIND.find(([re]) => re.test(line));
    // A heading line is mostly words; a line like "Weapon 123" still
    // counts as heading + number.
    if (heading) currentKind = heading[1];
    for (const token of line.split(/[\s,;]+/)) {
      const t = token.replace(/^#/, '').replace(/[.:)]+$/, '');
      if (!t) continue;
      let m = t.match(/^([DdWwEe])#?(\d{1,9})$/);
      if (m) {
        add({ d: 'devikin', w: 'weapon', e: 'equipment' }[m[1].toLowerCase()], Number(m[2]));
        continue;
      }
      m = t.match(/^\d{1,9}$/);
      if (m) {
        if (currentKind) add(currentKind, Number(t));
        else unassigned.push(Number(t));
        continue;
      }
      if (!heading) ignored.push(token);
    }
  }
  return { items, unassigned, ignored };
}

// ---------------------------------------------------------------------------
// Status of one NFT
// ---------------------------------------------------------------------------

/**
 * One of: 'arrived', 'overdue', 'requested', 'in-game', 'main',
 * 'elsewhere', 'not-found', 'unchecked'.
 *   arrived    - in the receiving wallet
 *   overdue    - marked requested, not arrived after `overdueMinutes`
 *   requested  - marked requested, still within the time
 * For NFTs that aren't marked requested, where they are:
 *   in-game / main / elsewhere / not-found / unchecked
 * `place` always says where it is: 'receiving' | 'in-game' | 'main' |
 * 'elsewhere' | 'not-found' | 'unchecked'.
 */
export function statusOf(item, { fromAddress, toAddress, overdueMinutes, now = Date.now() }) {
  let place;
  if (!item.checked_at) place = 'unchecked';
  else if (!item.holder) place = 'not-found';
  else if (item.holder === toAddress) place = 'receiving';
  else if (item.holder === fromAddress) place = 'in-game';
  else if (item.holder === GAME_MAIN_WALLET) place = 'main';
  else place = 'elsewhere';

  if (place === 'receiving') return { status: 'arrived', place };
  if (item.requested_at) {
    const minutes = (now - item.requested_at) / 60000;
    return { status: minutes >= (overdueMinutes || DEFAULT_OVERDUE_MINUTES) ? 'overdue' : 'requested', place };
  }
  return { status: place, place };
}

// ---------------------------------------------------------------------------
// Asking the chain
// ---------------------------------------------------------------------------

/** Who holds one NFT right now: an address, or null if Klever doesn't know
 *  it (never minted / burned). Throws on network trouble. */
export async function fetchNftHolder(kind, nonce) {
  const url = `${KLEVER_API_BASE}/assets/nft/holder/${COLLECTIONS[kind].assetId}/${nonce}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  let json = null;
  try {
    json = await response.json();
  } catch (e) {
    // fall through
  }
  const address = json?.data?.account?.address;
  if (address) return address;
  if (!response.ok && response.status !== 400) throw new Error(`Klever API answered ${response.status}`);
  return null; // e.g. "not found" error message
}

/**
 * NFT transfers into `address` (newest first), stopping at transfers
 * already known (`knownHashes`) or after ARRIVALS_MAX_PAGES pages.
 * Returns [{ txHash, kind, nonce, from, timestamp (ms) }].
 */
export async function fetchArrivals(address, knownHashes = new Set()) {
  const arrivals = [];
  for (let page = 1; page <= ARRIVALS_MAX_PAGES; page += 1) {
    const response = await fetch(`${KLEVER_API_BASE}/transaction/list?toAddress=${address}&limit=100&page=${page}`);
    if (!response.ok) throw new Error(`Klever API answered ${response.status}`);
    const json = await response.json();
    const transactions = json?.data?.transactions || [];
    let reachedKnown = false;
    for (const tx of transactions) {
      if (knownHashes.has(tx.hash)) {
        reachedKnown = true;
        continue;
      }
      if (tx.status && tx.status !== 'success') continue;
      for (const r of tx.receipts || []) {
        if (r.to !== address || r.assetType !== 'NonFungible') continue;
        const kind = KIND_BY_COLLECTION[r.collection];
        const nonce = Number(r.nonce);
        if (!kind || !Number.isInteger(nonce)) continue;
        arrivals.push({ txHash: tx.hash, kind, nonce, from: r.from || tx.sender, timestamp: (tx.timestamp || 0) * 1000 });
      }
    }
    const totalPages = json?.pagination?.totalPages;
    if (reachedKnown || transactions.length < 100 || (totalPages && page >= totalPages)) break;
  }
  return arrivals;
}

/**
 * Runs one check. Returns { updates, arrivals, errors } for the caller to
 * save (database.js: saveWithdrawalCheckResults / addWithdrawalArrivals).
 *
 *   items        the list (rows from getWithdrawalItems)
 *   full         true = look up every NFT on the list;
 *                false = only those marked requested and not yet arrived,
 *                plus any never checked before
 *   knownHashes  arrivals already in the log
 *   onProgress   ({ phase, current, total }) for the progress line
 */
export async function runWithdrawalCheck({ items, fromAddress, toAddress, full, knownHashes, onProgress, shouldCancel }) {
  const checkedAt = Date.now();
  const errors = [];
  const holderByKey = new Map();

  // 1. Arrivals into the receiving wallet.
  onProgress?.({ phase: 'arrivals' });
  let arrivals = [];
  try {
    arrivals = await fetchArrivals(toAddress, knownHashes);
  } catch (e) {
    errors.push(`Arrivals log: ${e.message}`);
  }

  // 2. (No bulk wallet listing: Klever's "what does this wallet hold" list
  // keeps showing NFTs under the old wallet after they've been sent on -
  // seen 11 Oct 2026 with equipment #1038, withdrawn on 8 Oct but still
  // listed in the in-game wallet. The per-NFT holder lookup is always
  // right, so every NFT is looked up on its own.)

  // 3. One by one for the rest.
  const toLookUp = items.filter((item) => {
    if (full) return true;
    if (!item.checked_at) return true; // new on the list
    return Boolean(item.requested_at) && item.holder !== toAddress; // requested, not arrived yet
  });
  let done = 0;
  onProgress?.({ phase: 'lookups', current: 0, total: toLookUp.length });
  for (let i = 0; i < toLookUp.length; i += LOOKUP_PARALLEL) {
    if (shouldCancel?.()) break;
    const batch = toLookUp.slice(i, i + LOOKUP_PARALLEL);
    await Promise.all(
      batch.map(async (item) => {
        try {
          holderByKey.set(`${item.kind}:${item.nonce}`, await fetchNftHolder(item.kind, item.nonce));
        } catch (e) {
          errors.push(`${KIND_LABEL[item.kind]} #${item.nonce}: ${e.message}`);
        }
      })
    );
    done += batch.length;
    onProgress?.({ phase: 'lookups', current: done, total: toLookUp.length });
    await sleep(LOOKUP_PAUSE_MS);
  }

  // 4. Results per NFT (NFTs not looked up this time keep their last place).
  const arrivalByKey = new Map();
  for (const a of arrivals) {
    const key = `${a.kind}:${a.nonce}`;
    const prev = arrivalByKey.get(key);
    if (!prev || a.timestamp > prev.timestamp) arrivalByKey.set(key, a);
  }
  const updates = [];
  for (const item of items) {
    const key = `${item.kind}:${item.nonce}`;
    if (!holderByKey.has(key)) continue;
    const holder = holderByKey.get(key);
    const update = { kind: item.kind, nonce: item.nonce, holder, checkedAt };
    if (holder === toAddress && !item.arrived_at) {
      const a = arrivalByKey.get(key);
      update.arrivedAt = a ? a.timestamp : checkedAt;
      update.arrivedFrom = a ? a.from : null;
      update.arrivedTx = a ? a.txHash : null;
    }
    updates.push(update);
  }

  return { updates, arrivals, errors, checkedAt };
}

/** Where an NFT is, in words, from the tracker's last check - used in
 *  the NFT details for NFTs that come from the Withdrawals list. */
export function placeInWords(item, { fromAddress, toAddress }) {
  if (!item || !item.checked_at) return 'Not checked yet - run a check on the Withdrawals screen';
  const when = new Date(item.checked_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  let where;
  if (!item.holder) where = 'Not found on the chain';
  else if (item.holder === toAddress) where = 'In your receiving wallet';
  else if (item.holder === fromAddress) where = 'In your in-game wallet';
  else if (item.holder === GAME_MAIN_WALLET) where = "In the game's main wallet";
  else where = `In another wallet (${item.holder.slice(0, 8)}…${item.holder.slice(-6)})`;
  return `${where} (as of ${when})`;
}

/** Plain text of overdue NFTs, ready to paste into a support ticket. */
export function overdueListText(items, ctx) {
  const lines = [];
  for (const kind of KINDS) {
    const overdue = items.filter((i) => i.kind === kind && statusOf(i, ctx).status === 'overdue');
    if (overdue.length === 0) continue;
    lines.push(`${KIND_LABEL[kind]}s (${overdue.length}):`);
    lines.push(overdue.map((i) => `#${i.nonce}`).join(', '));
    lines.push('');
  }
  if (lines.length === 0) return '';
  return [
    `Withdrawal requested but not arrived in ${ctx.toAddress}:`,
    '',
    ...lines,
  ].join('\n').trim();
}
