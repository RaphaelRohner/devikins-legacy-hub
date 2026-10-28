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
// Klever's node answers "does this wallet hold this NFT?" straight from the
// chain, without the API's limit (23 Oct 2026: the API's "who holds this
// NFT" allows only 30 questions a minute per visitor - lookups beyond that
// failed quietly, which left most of a long list "not looked up yet").
const KLEVER_NODE_BASE = 'https://node.mainnet.klever.org';

export const KINDS = ['devikin', 'weapon', 'equipment'];
export const KIND_LABEL = { devikin: 'Devikin', weapon: 'Weapon', equipment: 'Equipment' };

// The Devikins game's main (custody) wallet, where most game NFTs sit.
export const GAME_MAIN_WALLET = 'klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf';

export const DEFAULT_OVERDUE_MINUTES = 30;

// One-by-one lookups: a few at a time with a short pause, so even a list
// of 1,500 NFTs doesn't hammer Klever's API.
const LOOKUP_PARALLEL = 8;
const LOOKUP_PAUSE_MS = 150;
// The API's "who holds this NFT" (only needed when none of the likely
// wallets holds it): at most 30 a minute, so one every 2.5 seconds, and a
// pause when Klever says "too many".
const API_HOLDER_GAP_MS = 2500;
const API_BUSY_WAIT_MS = 20000;
const API_BUSY_TRIES = 6;
// How far back the arrivals log looks the first time (later checks stop
// at the newest arrival already known).
const ARRIVALS_MAX_PAGES = 20;

const KIND_BY_COLLECTION = Object.fromEntries(KINDS.map((k) => [COLLECTIONS[k].assetId, k]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Format + checksum check (src/utils/kleverAddress.js).
export { isValidKleverAddress } from '../utils/kleverAddress';

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
 * One of: 'arrived', 'overdue', 'requested', 'requested-elsewhere', 'in-game', 'main',
 * 'elsewhere', 'not-found', 'unchecked'.
 *   arrived    - in the receiving wallet, or in another of your own wallets
 *                (`ownAddresses`: every wallet of every set), or it arrived
 *                once and was sent on since (28 Oct 2026, Raphael: 10
 *                Devikins sent on to a friend's wallet showed as overdue)
 *   overdue    - marked requested, not arrived after `overdueMinutes`
 *   requested  - marked requested, still within the time
 *   requested-elsewhere - same, but in someone else's wallet (a warning)
 * For NFTs that aren't marked requested, where they are:
 *   in-game / main / elsewhere / not-found / unchecked
 * `place` always says where it is: 'receiving' | 'own' | 'in-game' | 'main' |
 * 'elsewhere' | 'not-found' | 'unchecked'.
 */
export function statusOf(item, { fromAddress, toAddress, overdueMinutes, now = Date.now(), ownAddresses = [] }) {
  let place;
  if (!item.checked_at) place = 'unchecked';
  else if (!item.holder) place = 'not-found';
  else if (item.holder === toAddress) place = 'receiving';
  else if (item.holder === fromAddress) place = 'in-game';
  else if (item.holder === GAME_MAIN_WALLET) place = 'main';
  else if (ownAddresses.includes(item.holder)) place = 'own';
  else place = 'elsewhere';

  if (place === 'receiving' || place === 'own') return { status: 'arrived', place };
  // Arrived once and sent on since (to a friend, sold …): done - never overdue again.
  if (item.arrived_at) return { status: 'arrived', place };
  if (item.requested_at) {
    const minutes = (now - item.requested_at) / 60000;
    if (minutes >= (overdueMinutes || DEFAULT_OVERDUE_MINUTES)) return { status: 'overdue', place };
    // Requested, but sitting in a wallet that is neither yours nor the
    // game's: flagged straight away instead of a calm "waiting" (fresh-eyes
    // review, 14 Oct 2026: "the scariest result possible"). Not overdue yet,
    // though - a marketplace buy can legitimately still sit in the seller's
    // game wallet until the game sends it.
    if (place === 'elsewhere') return { status: 'requested-elsewhere', place };
    return { status: 'requested', place };
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

/** Does `address` hold this NFT right now? (Klever's node; true/false, throws on network trouble) */
export async function holdsNft(address, kind, nonce) {
  const url = `${KLEVER_NODE_BASE}/address/${address}/kda?asset=${COLLECTIONS[kind].assetId}/${nonce}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Klever's node answered ${response.status}`);
  const json = await response.json();
  return Number(json?.data?.userKDA?.Balance || 0) > 0;
}

// One API holder question at a time, spaced out (see API_HOLDER_GAP_MS).
let apiQueue = Promise.resolve();
function askApiForHolder(kind, nonce, onWait) {
  const job = apiQueue.then(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const holder = await fetchNftHolder(kind, nonce);
        // (The website tests use a shorter gap: their pretend Klever has no limit.)
        await sleep((typeof window !== 'undefined' && window.__HUB_KLEVER_API_GAP_MS) || API_HOLDER_GAP_MS);
        return holder;
      } catch (e) {
        if (!/answered 429/.test(e.message) || attempt >= API_BUSY_TRIES) throw e;
        onWait?.();
        await sleep(API_BUSY_WAIT_MS);
      }
    }
  });
  apiQueue = job.catch(() => {});
  return job;
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
 * Looks up who holds each NFT, a few at a time. `list` = [{ kind, nonce,
 * known }] (`known` = where it was last seen, if anywhere). First Klever's
 * node is asked whether the NFT is still where it was, or in one of the
 * likely wallets (`guesses`: the in-game wallet, the game's main wallet,
 * your own wallets) - fast and without a limit; only NFTs found in none of
 * them are asked from the API, which allows 30 a minute (so those take
 * longer). Returns a Map "kind:nonce" -> address (or null = not found on
 * the chain); NFTs whose lookup failed are left out and named in `errors`.
 * Also used by the wallet overview.
 */
export async function lookUpHolders(list, { guesses = [], onProgress, shouldCancel, errors = [] } = {}) {
  const holderByKey = new Map();
  let done = 0;
  let slowCount = 0;
  onProgress?.({ phase: 'lookups', current: 0, total: list.length, slow: 0 });
  for (let i = 0; i < list.length; i += LOOKUP_PARALLEL) {
    if (shouldCancel?.()) break;
    const batch = list.slice(i, i + LOOKUP_PARALLEL);
    await Promise.all(
      batch.map(async (item) => {
        try {
          const candidates = [...new Set([item.known, ...guesses].filter((a) => typeof a === 'string' && a.startsWith('klv1')))];
          let holder;
          for (const address of candidates) {
            if (shouldCancel?.()) return;
            if (await holdsNft(address, item.kind, item.nonce)) {
              holder = address;
              break;
            }
          }
          if (holder === undefined) {
            slowCount += 1;
            if (shouldCancel?.()) return;
            holder = await askApiForHolder(item.kind, item.nonce, () => onProgress?.({ phase: 'waiting', current: done, total: list.length }));
          }
          holderByKey.set(`${item.kind}:${item.nonce}`, holder);
        } catch (e) {
          errors.push(`${KIND_LABEL[item.kind]} #${item.nonce}: ${e.message}`);
        }
      })
    );
    done += batch.length;
    onProgress?.({ phase: 'lookups', current: done, total: list.length, slow: slowCount });
    await sleep(LOOKUP_PAUSE_MS);
  }
  return holderByKey;
}

/**
 * Runs one check. Returns { updates, arrivals, errors } for the caller to
 * save (database.js: saveWithdrawalCheckResults / addWithdrawalArrivals).
 *
 *   items        the list (rows from getWithdrawalItems)
 *   full         true = look up every NFT given (used by "Check selected");
 *                false = every NFT that hasn't arrived yet (the "Check"
 *                button - arrived ones are done; Raphael, 14 Oct 2026:
 *                the old "Check now" vs "Full check" split did nearly the
 *                same thing for real users and confused more than it helped)
 *   knownHashes  arrivals already in the log
 *   onProgress   ({ phase, current, total }) for the progress line
 */
export async function runWithdrawalCheck({ items, fromAddress, toAddress, full, knownHashes, onProgress, shouldCancel, ownAddresses = [] }) {
  const checkedAt = Date.now();
  const errors = [];
  const holderByKey = new Map();

  // 1. Arrivals into the receiving wallet.
  onProgress?.({ phase: 'arrivals' });
  let arrivals = [];
  if (toAddress) {
    try {
      arrivals = await fetchArrivals(toAddress, knownHashes);
    } catch (e) {
      errors.push(`Arrivals log: ${e.message}`);
    }
  }

  // 2. (No bulk wallet listing: Klever's "what does this wallet hold" list
  // keeps showing NFTs under the old wallet after they've been sent on -
  // seen 11 Oct 2026 with equipment #1038, withdrawn on 8 Oct but still
  // listed in the in-game wallet. The per-NFT holder lookup is always
  // right, so every NFT is looked up on its own.)

  // 3. One by one for the rest.
  const own = new Set(ownAddresses);
  const toLookUp = items.filter((item) => {
    if (full) return true;
    if (!item.checked_at) return true; // new on the list
    // (arrived: in the receiving wallet or another of mine, or arrived once and sent on)
    return item.holder !== toAddress && !own.has(item.holder) && !item.arrived_at;
  });
  const found = await lookUpHolders(
    toLookUp.map((item) => ({ kind: item.kind, nonce: item.nonce, known: item.holder })),
    // (my other wallets are likely places too: asking them first is quick, unlike the API's "who holds it")
    { guesses: [fromAddress, GAME_MAIN_WALLET, toAddress, ...[...own].filter((a) => a && a !== fromAddress && a !== toAddress).slice(0, 10)], onProgress, shouldCancel, errors }
  );
  for (const [key, holder] of found) holderByKey.set(key, holder);

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
    } else if (holder && own.has(holder) && holder !== fromAddress && !item.arrived_at) {
      // Straight into another of my wallets (the arrivals log only reads the receiving wallet).
      update.arrivedAt = checkedAt;
      update.arrivedFrom = null;
      update.arrivedTx = null;
    }
    updates.push(update);
  }

  return { updates, arrivals, errors, checkedAt };
}

/** Where an NFT is, in words, from the tracker's last check - used in
 *  the NFT details for NFTs that come from the Withdrawals list. */
export function placeInWords(item, { fromAddress, toAddress, ownWallets = [] }) {
  if (!item || !item.checked_at) return 'Not checked yet - run a check on the Withdrawals screen';
  const when = new Date(item.checked_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const own = ownWallets.find((w) => w.address === item.holder);
  let where;
  if (!item.holder) where = 'Not found on the chain';
  else if (item.holder === toAddress) where = 'In your receiving wallet';
  else if (own && item.holder !== fromAddress) where = `In your wallet "${own.alias || `${item.holder.slice(0, 8)}…${item.holder.slice(-6)}`}"`;
  else if (item.holder === fromAddress) where = 'In your in-game wallet';
  else if (item.holder === GAME_MAIN_WALLET) where = "In the game's main wallet";
  else where = `In another wallet (${item.holder.slice(0, 8)}…${item.holder.slice(-6)})`;
  return `${where} (as of ${when})`;
}

/** Plain text of overdue NFTs, ready to paste into a support ticket.
 *  Says for each one when it was requested and where it is now, plus both
 *  wallets (fresh-eyes review, 15 Oct 2026: the old text was just a list of
 *  numbers, and "Equipments"). Times in UTC, so support reads them the
 *  same wherever they are. */
export function overdueListText(items, ctx) {
  const PLURAL = { devikin: 'Devikins', weapon: 'Weapons', equipment: 'Equipment' };
  const utc = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown time');
  const where = (item) => {
    if (!item.checked_at) return 'not checked yet';
    if (!item.holder) return 'not found on the chain';
    if (item.holder === ctx.fromAddress) return 'still in my in-game wallet';
    if (item.holder === GAME_MAIN_WALLET) return `still in the game's main wallet (${GAME_MAIN_WALLET})`;
    return `held by another wallet: ${item.holder}`;
  };
  const lines = [];
  let lastCheck = 0;
  for (const kind of KINDS) {
    const overdue = items.filter((i) => i.kind === kind && statusOf(i, ctx).status === 'overdue');
    if (overdue.length === 0) continue;
    lines.push(`${PLURAL[kind]} (${overdue.length}):`);
    for (const i of overdue) {
      lines.push(`#${i.nonce} - requested ${utc(i.requested_at)} - ${where(i)}`);
      if (i.checked_at && i.checked_at > lastCheck) lastCheck = i.checked_at;
    }
    lines.push('');
  }
  if (lines.length === 0) return '';
  return [
    'Withdrawal requested in the game but not arrived.',
    `Sent from (my in-game wallet): ${ctx.fromAddress}`,
    `Should arrive in (my wallet): ${ctx.toAddress}`,
    '',
    ...lines,
    `Checked on the Klever blockchain: ${utc(lastCheck)}`,
  ].join('\n').trim();
}
