/**
 * postOffice.js — the blind postman's rules (all of them, in one place)
 *
 * Runs inside ONE Cloudflare Durable Object (see worker.js) with its own
 * small SQLite database. The same code runs in the automatic tests on a
 * computer, with a stand-in database and a pretend clock and Klever.
 *
 * What it keeps (and nothing else):
 *   accounts  – a random account number per player, a keyed fingerprint of
 *               the wallet (so one wallet = one account; the wallet itself is
 *               never stored), the nickname, and until when the player's
 *               holding was last proven. No NFT count, no wallet.
 *   devices   – the chat keys (public) of each account's devices.
 *   signins   – one-time sign-in codes, for 5 minutes.
 *   codes     – "drop codes": a player hands one to each accepted contact
 *               (inside a sealed message); the postman stores only a
 *               fingerprint of each code and which account it opens – not
 *               who holds it.
 *   mail      – sealed 1:1 envelopes waiting for a device; deleted when the
 *               device confirms it has them, or after 30 days.
 *   posts     – sealed group envelopes, ONE copy per post for the whole
 *               group, deleted after 30 days.
 *   requests  – the times of each player's contact requests (for the
 *               growing pause), deleted after 24 h. Not who was asked.
 *   lastpost  – the time of each player's last group post (flood limit).
 *   budget    – a daily count of each player's (and each drop code's)
 *               actions, so nobody can fill the postman's free daily
 *               allowance; deleted after 2 days.
 *   (These three are kept by wallet fingerprint, so leaving and signing in
 *   again doesn't reset them.)
 * Times on waiting mail are rounded to the hour, so they can't be matched
 * up with a contact request or with each other.
 * It can't open any envelope: they're sealed for the receivers' keys.
 * Accounts not signed in for 180 days are forgotten (cleanUp).
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { issueBadge, checkBadge, BADGE_DAYS } from '../../src/badge.js';
import { isPublicKey } from '../../src/identity.js';
import { checkAlbum } from '../../src/album.js';
import {
  contactRequestWait, DAY, MINUTE, MIN_POST_INTERVAL, nicknameKey, cleanText,
  GAME_ACCOUNT, votingThreshold, voteResult, voteDecidedEarly, canOpenVote, isPostingPaused, VOTE_DURATION, holdingBand, bandLabel,
} from '../../src/rules.js';
import { checkAuthHeader } from '../../src/httpAuth.js';
import { signInText, voteProofText, isWalletSignature, devikinsHeld, walletPublicKey } from './kleverProof.js';

export const VERSION = '1';
export const KEEP_FOR = 30 * DAY;
export const FORGET_AFTER = 180 * DAY;
export const SIGNIN_VALID_FOR = 5 * MINUTE;
/** A link code (QR code to add a device without a wallet, 27 Oct 2026) works once, for this long. */
export const LINK_VALID_FOR = 5 * MINUTE;
/** Collectors Albums (27 Oct 2026): kept this long after the owner's Hub last refreshed them; at most this many in all. */
export const ALBUM_KEEP_DAYS = 60;
export const MAX_ALBUMS = 5000;
/** Comments on NFTs (28 Oct 2026): length, how many per NFT, how many a player may write per day. */
export const MAX_COMMENT_CHARS = 200;
export const MAX_COMMENTS_PER_NFT = 50;
export const DAILY_COMMENTS_PER_PLAYER = 30;
/** The album mailbox (28 Oct 2026): new conversations a player may start per day; messages are kept 30 days. */
export const DAILY_ALBUM_THREADS_PER_PLAYER = 10;
/** Linked devices (28 Oct 2026): a device that hasn't checked its mail for this long is taken out of the account. */
export const DEVICE_IDLE_DAYS = 60;
export const MAX_OPEN_SIGNINS = 3;
export const MAX_DEVICES = 5;
export const MAX_ENVELOPE_CHARS = 64 * 1024;
export const MAX_ITEMS_PER_SEND = 10;
export const MAX_WAITING_PER_DEVICE = 500;
export const MAX_CODES_PER_ACCOUNT = 1000;
export const MAX_MAIL_PER_FETCH = 100;
export const MAX_POSTS_PER_FETCH = 200;
export const MAX_DIRECTORY_RESULTS = 50;
/** Group posts are at most 2,000 characters of text; sealed with a badge they stay well under this. */
export const MAX_GROUP_ENVELOPE_CHARS = 24 * 1024;
/** Daily allowance of actions per player (requests, drop-code changes, group posts) … */
export const DAILY_ACTIONS_PER_PLAYER = 1500;
/** … and of envelopes dropped with one drop code. */
export const DAILY_DROPS_PER_CODE = 300;
/**
 * Linked devices (27 Oct 2026): envelopes a player's device sends to its
 * OWN other devices per day (copies of what it sent and changed, and once
 * the whole history for a new device, in parts).
 */
export const DAILY_SELF_ITEMS = 3000;
export const MAX_GROUPS_CREATED_PER_PLAYER = 5;
export const MAX_GROUPS = 1000;
/**
 * A group nobody but its owner has joined for this long goes (Raphael,
 * 24 Oct 2026: against dozens of empty groups crowding the list).
 */
export const OWNER_ONLY_GROUP_DAYS = 30;
export const GROUP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.,'&!?()-]{1,38}[A-Za-z0-9.!?)])$/;
export const MAX_GROUP_DESCRIPTION = 200;
export const MAX_PINNED_CHARS = 32 * 1024;
export const JOIN_WAIT_DAYS = 14;
/** Wallets checked per counting run (Cloudflare's free plan allows 50 outside requests per run). */
export const DECIDE_BATCH = 20;
export const MAX_BODY_CHARS = MAX_ENVELOPE_CHARS * (MAX_ITEMS_PER_SEND + 1);
const HOUR_MS = 60 * MINUTE;
export const NICKNAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,18}[A-Za-z0-9])?$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isCode = (c) => typeof c === 'string' && HEX64.test(c);
const GIFT_WRAP_KIND = 1059;

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const refuse = (status, message) => { throw new Refusal(status, message); };

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, wallet_fp TEXT NOT NULL UNIQUE,
     nickname TEXT, nick_key TEXT UNIQUE, verified_until INTEGER NOT NULL, created INTEGER NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS devices (key TEXT PRIMARY KEY, account TEXT NOT NULL, added INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS devices_by_account ON devices (account)',
  'CREATE TABLE IF NOT EXISTS signins (code TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS codes (fp TEXT PRIMARY KEY, account TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS codes_by_account ON codes (account)',
  `CREATE TABLE IF NOT EXISTS mail (id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL,
     kind TEXT NOT NULL, envelope TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS mail_by_device ON mail (device, id)',
  `CREATE TABLE IF NOT EXISTS posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL,
     envelope TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS posts_by_group ON posts (grp, seq)',
  'CREATE TABLE IF NOT EXISTS requests (player TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS requests_by_player ON requests (player)',
  'CREATE TABLE IF NOT EXISTS lastpost (player TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS budget (who TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (who, day))',
  `CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL, pinned TEXT, pinned_at INTEGER,
     key_check TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_members (grp TEXT NOT NULL, account TEXT NOT NULL, joined_seq INTEGER NOT NULL,
     joined_at INTEGER NOT NULL, PRIMARY KEY (grp, account))`,
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account)',
  `CREATE TABLE IF NOT EXISTS group_joins (grp TEXT NOT NULL, account TEXT NOT NULL, code TEXT NOT NULL,
     code_fp TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (grp, account))`,
  `CREATE TABLE IF NOT EXISTS votes (id TEXT PRIMARY KEY, grp TEXT NOT NULL, accused TEXT NOT NULL, opener TEXT NOT NULL,
     accused_fp TEXT NOT NULL, accused_nick TEXT, opener_fp TEXT NOT NULL,
     reason TEXT NOT NULL, opened_at INTEGER NOT NULL, members INTEGER NOT NULL, decided INTEGER NOT NULL DEFAULT 0,
     passed INTEGER, valid INTEGER, removed INTEGER, decided_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS votes_by_group ON votes (grp)',
  `CREATE TABLE IF NOT EXISTS ballots (vote TEXT NOT NULL, account TEXT NOT NULL, yes INTEGER NOT NULL,
     eligible INTEGER NOT NULL, at INTEGER NOT NULL, wallet TEXT, checked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vote, account))`,
  'CREATE TABLE IF NOT EXISTS proofs (code TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL)',
  // Link codes (QR codes, 27 Oct 2026): only a fingerprint of the code; the Devikins count and end of
  // the linking device's badge, so the new device gets the same; gone after use or 5 minutes.
  'CREATE TABLE IF NOT EXISTS links (fp TEXT PRIMARY KEY, account TEXT NOT NULL, nfts INTEGER NOT NULL, badge_until INTEGER NOT NULL, expires INTEGER NOT NULL)',
  // Collectors Albums (27 Oct 2026): stored under the ALBUM's own key only - no account, no device.
  `CREATE TABLE IF NOT EXISTS albums (key TEXT PRIMARY KEY, event TEXT NOT NULL, title TEXT NOT NULL, name TEXT,
     count INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS albums_by_updated ON albums (updated)',
  // Comments on NFTs (28 Oct 2026): by signed-in holders, under their nickname; one vote per player.
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, nonce INTEGER NOT NULL,
     account TEXT NOT NULL, nickname TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS comments_by_nft ON comments (kind, nonce)',
  'CREATE TABLE IF NOT EXISTS comment_votes (comment INTEGER NOT NULL, account TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment, account))',
  'CREATE TABLE IF NOT EXISTS album_hidden (album TEXT NOT NULL, comment INTEGER NOT NULL, PRIMARY KEY (album, comment))',
  // The album mailbox (28 Oct 2026): a conversation between one player and the owner of one album
  // (who stays anonymous); sealed envelopes, each for one key (the album's, or one of the player's devices).
  `CREATE TABLE IF NOT EXISTS album_threads (id TEXT PRIMARY KEY, album TEXT NOT NULL, account TEXT NOT NULL,
     blocked INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, UNIQUE (album, account))`,
  `CREATE TABLE IF NOT EXISTS album_talk (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, to_key TEXT NOT NULL,
     envelope TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS album_talk_by_key ON album_talk (to_key, id)',
  // Bans are kept by wallet fingerprint, so leaving the chat and signing in again doesn't undo them.
  `CREATE TABLE IF NOT EXISTS group_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, player TEXT NOT NULL,
     nickname TEXT, at INTEGER NOT NULL, UNIQUE (grp, player))`,
];

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function sha256Hex(text) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

async function hmacHex(keyHex, text) {
  const key = await crypto.subtle.importKey(
    'raw', Uint8Array.from(keyHex.match(/../g), (h) => parseInt(h, 16)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))));
}

// nicknameKey (look-alike nicknames count as the same) is in the chat
// core's rules.js, so the Hubs compare nicknames exactly like the postman.
export { nicknameKey };

/**
 * createPostOffice
 *   sql:  { exec(query, ...params) → { toArray() } } – Cloudflare's
 *         ctx.storage.sql, or the stand-in used by the tests
 *   now:  () → milliseconds
 *   fetchKlever: fetch function used to ask Klever's API
 */
export function createPostOffice({ sql, now = () => Date.now(), fetchKlever = (...a) => fetch(...a) }) {
  for (const statement of SCHEMA) sql.exec(statement);
  // Columns added after a table first went live (stage 4: group keys renewed after a removal;
  // 23 Oct 2026: votes.closing = the result is already certain, count it now).
  // 28 Oct 2026: devices.seen = the day a device last checked its mail (rounded to the day), so a player
  // sees which of their devices is still in use, and devices idle for DEVICE_IDLE_DAYS are taken out.
  const hadSeen = sql.exec('PRAGMA table_info(devices)').toArray().some((c) => c.name === 'seen');
  for (const [table, name, type] of [['groups', 'epoch', 'INTEGER NOT NULL DEFAULT 1'], ['groups', 'needs_rekey', 'INTEGER NOT NULL DEFAULT 0'], ['votes', 'closing', 'INTEGER NOT NULL DEFAULT 0'], ['groups', 'alone_since', 'INTEGER'], ['devices', 'seen', 'INTEGER']]) {
    if (!sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  // groups.alone_since (24 Oct 2026): since when only the owner is in it
  // (NULL = others are in it too). Groups that were already alone count
  // from the first start with this rule.
  sql.exec(`UPDATE groups SET alone_since = ? WHERE alone_since IS NULL
    AND (SELECT COUNT(*) FROM group_members m WHERE m.grp = groups.id) = 1`, now()).toArray();
  // (devices from before: counted as seen today, so none is taken out sooner than DEVICE_IDLE_DAYS from now)
  if (!hadSeen) sql.exec('UPDATE devices SET seen = ?', Math.floor(now() / DAY) * DAY).toArray();
  const rows = (query, ...params) => sql.exec(query, ...params).toArray();
  const row = (query, ...params) => rows(query, ...params)[0];
  const run = (query, ...params) => { sql.exec(query, ...params).toArray(); };

  function meta(name, make) {
    const found = row('SELECT v FROM meta WHERE k = ?', name);
    if (found) return found.v;
    const value = make();
    run('INSERT INTO meta (k, v) VALUES (?, ?)', name, value);
    return value;
  }
  // The postman's own keys, made once on first start and kept only in its
  // database: one signs badges, the other makes the wallet fingerprints.
  const postmanSecret = meta('postman_secret', () => bytesToHex(generateSecretKey()));
  const postman = { secretKey: postmanSecret, publicKey: getPublicKey(Uint8Array.from(postmanSecret.match(/../g), (h) => parseInt(h, 16))) };
  const walletSalt = meta('wallet_salt', () => randomHex(32));

  const accountOf = (device) => row(
    'SELECT a.* FROM devices d JOIN accounts a ON a.id = d.account WHERE d.key = ?', device,
  );
  const devicesOf = (account) => rows('SELECT key FROM devices WHERE account = ? ORDER BY added', account).map((r) => r.key);
  const requestTimes = (player) => rows('SELECT at FROM requests WHERE player = ?', player).map((r) => r.at);
  const nextRequestAt = (player, t) => t + contactRequestWait(requestTimes(player), t);

  /** Counts one more action of `who` today; refuses once the daily allowance is used up. */
  function spend(who, limit, t, amount = 1) {
    const day = Math.floor(t / DAY);
    const used = row('SELECT n FROM budget WHERE who = ? AND day = ?', who, day)?.n ?? 0;
    if (used + amount > limit) refuse(429, "Today's allowance is used up; please try again tomorrow.");
    run('INSERT INTO budget (who, day, n) VALUES (?, ?, ?) ON CONFLICT (who, day) DO UPDATE SET n = n + ?', who, day, amount, amount);
  }

  function verifiedAccount(device, t) {
    const account = accountOf(device);
    if (!account) refuse(403, 'Please sign in with your wallet first.');
    if (account.verified_until <= t) refuse(403, 'Please sign in with your wallet again (it is checked once a week).');
    return account;
  }

  /** One device taken out of its account (by the player, or idle too long): it and what waits for it. */
  function forgetDevice(key) {
    run('DELETE FROM devices WHERE key = ?', key);
    run('DELETE FROM mail WHERE device = ?', key);
    run('DELETE FROM album_talk WHERE to_key = ?', key);
    run('DELETE FROM signins WHERE device = ?', key);
    run('DELETE FROM proofs WHERE device = ?', key);
  }

  /** Everything a player wrote about albums (comments, votes, album conversations) - when their account goes. */
  function forgetAlbumActivity(accountId) {
    for (const c of rows('SELECT id FROM comments WHERE account = ?', accountId)) {
      run('DELETE FROM comment_votes WHERE comment = ?', c.id);
      run('DELETE FROM album_hidden WHERE comment = ?', c.id);
    }
    run('DELETE FROM comments WHERE account = ?', accountId);
    run('DELETE FROM comment_votes WHERE account = ?', accountId);
    for (const th of rows('SELECT id FROM album_threads WHERE account = ?', accountId)) run('DELETE FROM album_talk WHERE thread = ?', th.id);
    run('DELETE FROM album_threads WHERE account = ?', accountId);
  }

  /** An album and everything hanging on it (its conversations, the comments it hid). */
  function deleteAlbum(key) {
    for (const th of rows('SELECT id FROM album_threads WHERE album = ?', key)) run('DELETE FROM album_talk WHERE thread = ?', th.id);
    run('DELETE FROM album_threads WHERE album = ?', key);
    run('DELETE FROM album_hidden WHERE album = ?', key);
    return rows('DELETE FROM albums WHERE key = ? RETURNING key', key).length > 0;
  }

  /** The NFTs in a published album: Set of "kind/nonce" (null if there's no such album). */
  function albumItems(key, t) {
    const a = row('SELECT event FROM albums WHERE key = ? AND expires > ?', key, t);
    if (!a) return null;
    try {
      const items = JSON.parse(JSON.parse(a.event).content).items;
      return new Set((Array.isArray(items) ? items : []).map((i) => `${i.kind}/${i.nonce}`));
    } catch {
      return new Set();
    }
  }

  function checkSealedItems(items, allowed) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_SEND) refuse(400, 'Nothing to send.');
    for (const it of items) {
      if (!allowed.includes(it?.to)) refuse(400, 'An envelope is for someone outside this conversation.');
      const text = stringify(it.envelope);
      if (!text || text.length > MAX_ENVELOPE_CHARS) refuse(413, 'This envelope is too big.');
    }
  }

  function stringify(value) {
    try { return JSON.stringify(value); } catch { return refuse(400, 'Damaged envelope.'); }
  }

  function checkEnvelopeFor(to, envelope) {
    if (!isPublicKey(to)) refuse(400, 'Not a chat key.');
    const text = stringify(envelope);
    if (!text || text.length > MAX_ENVELOPE_CHARS) refuse(413, 'This envelope is too big.');
    const pTag = Array.isArray(envelope?.tags) ? envelope.tags.find((x) => Array.isArray(x) && x[0] === 'p')?.[1] : null;
    if (envelope?.kind !== GIFT_WRAP_KIND || pTag !== to) refuse(400, 'Not a sealed envelope for this device.');
    return text;
  }

  function checkItems(items) {
    if (!Array.isArray(items) || items.length === 0) refuse(400, 'Nothing to send.');
    if (items.length > MAX_ITEMS_PER_SEND) refuse(400, 'Too many envelopes at once.');
    return items.map((i) => ({ to: i?.to, text: checkEnvelopeFor(i?.to, i?.envelope) }));
  }

  function deliver(items, kind, t) {
    // A device whose mailbox is full (e.g. one that's never opened any more)
    // is skipped, so the player's other devices still get the envelope
    // (linked devices, 27 Oct 2026). Only if none can take it is it refused.
    const open = items.filter((item) => row('SELECT COUNT(*) AS n FROM mail WHERE device = ?', item.to).n < MAX_WAITING_PER_DEVICE);
    if (open.length === 0) refuse(507, "This player's mailbox is full; they need to open the Hub first.");
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    for (const item of open) run('INSERT INTO mail (device, kind, envelope, at) VALUES (?, ?, ?, ?)', item.to, kind, item.text, hour);
    return open.length;
  }

  const isGroupId = (g) => typeof g === 'string' && HEX32.test(g);
  /** The group id, if `account` is a member of it; refuses otherwise. */
  function memberGroup(group, account) {
    if (!isGroupId(group) || !row('SELECT 1 AS x FROM groups WHERE id = ?', group)) refuse(404, 'This group no longer exists.');
    if (!row('SELECT 1 AS x FROM group_members WHERE grp = ? AND account = ?', group, account.id)) refuse(403, "You're not a member of this group.");
    return group;
  }
  /** Join requests that can still be answered: the asker is signed in and their code still works. */
  const OPEN_JOINS = `FROM group_joins j JOIN accounts a ON a.id = j.account
     WHERE j.grp = ? AND a.verified_until > ? AND a.nickname IS NOT NULL AND j.code_fp IN (SELECT fp FROM codes WHERE account = j.account)`;

  /** Takes an account out of a group; the group goes to the earliest member if the owner leaves, and is deleted when empty. */
  function removeMember(group, account) {
    run('DELETE FROM group_members WHERE grp = ? AND account = ?', group, account);
    const next = row('SELECT account FROM group_members WHERE grp = ? ORDER BY joined_at, rowid LIMIT 1', group);
    if (!next) {
      deleteGroup(group);
      return { deleted: true };
    }
    if (row('SELECT owner FROM groups WHERE id = ?', group).owner === account) {
      // The pinned message was the old owner's: the new owner pins anew.
      const before = row('SELECT pinned_at FROM groups WHERE id = ?', group).pinned_at ?? 0;
      run('UPDATE groups SET owner = ?, pinned = NULL, pinned_at = ? WHERE id = ?', next.account, Math.max(now(), before + 1), group);
    }
    if (row('SELECT COUNT(*) AS n FROM group_members WHERE grp = ?', group).n === 1) {
      run('UPDATE groups SET alone_since = ? WHERE id = ? AND alone_since IS NULL', now(), group);
    }
    return { deleted: false };
  }

  function dropJoin(group, account) {
    const j = row('SELECT code_fp FROM group_joins WHERE grp = ? AND account = ?', group, account);
    if (!j) return;
    // The code was shown to the group's members: it's single-use, so it goes now.
    run('DELETE FROM codes WHERE fp = ? AND account = ?', j.code_fp, account);
    run('DELETE FROM group_joins WHERE grp = ? AND account = ?', group, account);
  }

  // --- removal votes (stage 4) -------------------------------------------------

  /** The voting threshold, from the game account's holdings (asked once a day). */
  async function currentThreshold() {
    const t = now();
    const at = Number(row('SELECT v FROM meta WHERE k = ?', 'game_balance_at')?.v ?? 0);
    if (t - at > DAY) {
      // (the attempt counts too, so a Klever outage doesn't mean a question on every request)
      run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'game_balance_at', String(t - DAY + 60 * MINUTE));
      try {
        const balance = await devikinsHeld(GAME_ACCOUNT, fetchKlever);
        run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'game_balance', String(balance));
        run('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'game_balance_at', String(t));
      } catch {
        // Klever didn't answer: the last known figure (or, if none, the safe maximum).
      }
    }
    const known = row('SELECT v FROM meta WHERE k = ?', 'game_balance')?.v;
    return votingThreshold(known === undefined ? null : Number(known));
  }

  /**
   * A vote needs a fresh wallet signature (POST /proof/start gives the text):
   * it must be this player's own wallet (its fingerprint), holding at least
   * the threshold right now. → { wallet, held } (the address is kept with the
   * ballot only until the vote is counted, to check it again then).
   * `anyHoldings`: a group's owner may start a vote whatever they hold (their
   * own "yes" then counts only with the threshold; Raphael, 24 Oct 2026).
   */
  async function checkVoteProof({ device, account, body, threshold, host, anyHoldings = false }) {
    const { code, wallet, signature } = body.proof || {};
    const p = typeof code === 'string' ? row('SELECT * FROM proofs WHERE code = ?', code) : null;
    if (p) run('DELETE FROM proofs WHERE code = ?', code);
    if (!p || p.device !== device || p.expires <= now()) refuse(400, 'The wallet check has expired; please try again.');
    try { walletPublicKey(wallet); } catch { refuse(400, 'Not a Klever address.'); }
    const text = voteProofText({ site: host, deviceKey: device, code, expiresAt: p.expires });
    if (!(await isWalletSignature(text, wallet, signature))) refuse(403, "The wallet's signature doesn't match.");
    if ((await hmacHex(walletSalt, wallet)) !== account.wallet_fp) refuse(403, 'Please use the wallet you signed in to the chat with.');
    let held;
    try { held = await devikinsHeld(wallet, fetchKlever); } catch { refuse(502, "Klever's server didn't answer; please try again in a minute."); }
    if (held < threshold && !anyHoldings) refuse(403, `Only members holding at least ${threshold} Devikins can vote (this wallet holds ${held} right now).`);
    return { wallet, held };
  }

  const ballotsOf = (vote) => rows('SELECT * FROM ballots WHERE vote = ? ORDER BY at, rowid', vote);

  const isBanned = (group, walletFp) => !!row('SELECT 1 AS x FROM group_bans WHERE grp = ? AND player = ?', group, walletFp);

  /** Who may vote in `v`: members since before it opened, without the accused. */
  function votersOf(v) {
    return new Set(rows('SELECT account FROM group_members WHERE grp = ? AND joined_at <= ? AND account != ?', v.grp, v.opened_at, v.accused)
      .map((m) => m.account));
  }

  /** The early outcome of `v` from its ballots as they stand ('pass' | 'keep' | null). */
  function earlyOutcome(v) {
    const voters = votersOf(v);
    const counted = ballotsOf(v.id).filter((b) => b.eligible && voters.has(b.account));
    const yes = counted.filter((b) => b.yes).length;
    return voteDecidedEarly({ members: v.members, voters: voters.size, yes, no: counted.length - yes });
  }

  /**
   * If the result can't change any more, count the vote now (from the alarm).
   * votes.closing: 0 = open, 1 = to be counted now, -1 = an early count found
   * an emptied wallet; tried again only after a new ballot (not in a loop).
   */
  function closeEarlyIfDecided(voteId, { afterBallot = false } = {}) {
    const v = row('SELECT * FROM votes WHERE id = ?', voteId);
    if (!v || v.decided || v.closing === 1 || (v.closing === -1 && !afterBallot)) return;
    if (earlyOutcome(v)) run('UPDATE votes SET closing = 1 WHERE id = ?', v.id);
  }

  /**
   * Counts votes whose 48 h are over, or whose result is already certain
   * (votes.closing), a few wallets per run (Cloudflare allows only so many
   * outside questions per request): every voter's wallet is checked again -
   * a vote counts only if that wallet still holds the threshold and the
   * voter is still a member, so Devikins moved to another wallet count once.
   * Once all are checked, the vote is decided; if it passed, the member is
   * banned (by wallet fingerprint, even if they left meanwhile) and removed,
   * and the group is marked for a new key. Each wallet address is deleted
   * once the vote is decided. Early: if the checks change the picture so the
   * result isn't certain any more, the vote stays open, and every wallet is
   * checked again when it ends. Runs from the alarm.
   * → true if votes are still waiting to be counted.
   */
  async function decideAllVotes(budget = DECIDE_BATCH) {
    const t = now();
    const due = rows('SELECT * FROM votes WHERE decided = 0 AND (opened_at <= ? OR closing = 1) ORDER BY opened_at', t - VOTE_DURATION);
    if (!due.length) return false;
    const threshold = await currentThreshold();
    for (const v of due) {
      const final = v.opened_at <= t - VOTE_DURATION;
      const members = new Set(rows('SELECT account FROM group_members WHERE grp = ?', v.grp).map((m) => m.account));
      for (const b of rows('SELECT * FROM ballots WHERE vote = ? AND checked = 0', v.id)) {
        if (budget <= 0) return true;
        let held = 0;
        if (b.wallet) {
          try { held = await devikinsHeld(b.wallet, fetchKlever); } catch { return true; }
          budget -= 1;
        }
        // (Early, the address is kept until the vote is decided: it may have to be checked again at the end.)
        run(`UPDATE ballots SET eligible = ?, checked = 1${final ? ', wallet = NULL' : ''} WHERE vote = ? AND account = ?`,
          b.eligible && held >= threshold && members.has(b.account) ? 1 : 0, v.id, b.account);
      }
      if (row('SELECT decided FROM votes WHERE id = ?', v.id).decided) continue;
      const result = voteResult({
        members: v.members,
        accused: v.accused,
        votes: ballotsOf(v.id).map((b) => ({ voter: b.account, yes: !!b.yes, counts: !!b.eligible })),
      });
      let outcome = result.passed;
      if (!final) {
        const early = earlyOutcome(v);
        if (!early) {
          // Not certain any more: stays open; every ballot is checked again at the end.
          run('UPDATE ballots SET eligible = 1, checked = 0 WHERE vote = ? AND wallet IS NOT NULL', v.id);
          run('UPDATE votes SET closing = -1 WHERE id = ?', v.id);
          continue;
        }
        outcome = early === 'pass';
      }
      const g = row('SELECT owner FROM groups WHERE id = ?', v.grp);
      // (If the accused has become the group's owner meanwhile, they stay.)
      const passed = outcome && !!g && g.owner !== v.accused;
      let removed = false;
      if (passed) {
        run('INSERT OR IGNORE INTO group_bans (grp, player, nickname, at) VALUES (?, ?, ?, ?)', v.grp, v.accused_fp, v.accused_nick, t);
        dropJoin(v.grp, v.accused);
        if (members.has(v.accused)) {
          removed = true;
          const r = removeMember(v.grp, v.accused);
          // A new key, so the removed member can't read on: a member's Hub makes it.
          if (!r.deleted) run('UPDATE groups SET needs_rekey = 1 WHERE id = ?', v.grp);
        }
      }
      run('UPDATE votes SET decided = 1, passed = ?, valid = ?, removed = ?, decided_at = ?, closing = 0 WHERE id = ?',
        passed ? 1 : 0, result.valid || outcome ? 1 : 0, removed ? 1 : 0, t, v.id);
      run('UPDATE ballots SET wallet = NULL WHERE vote = ?', v.id);
    }
    return false;
  }

  /** When the next vote has to be counted (for the alarm), or null: when one ends, or right away if one is already certain. */
  function nextVoteEnd() {
    // (Also catches votes that became certain some other way - e.g. a member
    // leaving - or before this rule existed: votes cast before 23 Oct 2026.)
    for (const v of rows('SELECT id FROM votes WHERE decided = 0 AND closing = 0')) closeEarlyIfDecided(v.id);
    if (row('SELECT 1 AS x FROM votes WHERE decided = 0 AND closing = 1')) return now() + 1000;
    const v = row('SELECT MIN(opened_at) AS o FROM votes WHERE decided = 0');
    return v?.o ? v.o + VOTE_DURATION : null;
  }

  /** Is this member's posting paused by a supported, still open vote about them? → the vote's end time, or 0 */
  function pausedUntil(group, account, t) {
    for (const v of rows('SELECT * FROM votes WHERE grp = ? AND accused = ? AND decided = 0', group, account)) {
      const supporters = ballotsOf(v.id).filter((b) => b.yes && b.eligible).map((b) => b.account);
      if (isPostingPaused({ openedAt: v.opened_at, opener: v.opener, supporters, decided: false }, t)) return v.opened_at + VOTE_DURATION;
    }
    return 0;
  }

  function deleteGroup(group) {
    for (const v of rows('SELECT id FROM votes WHERE grp = ?', group)) run('DELETE FROM ballots WHERE vote = ?', v.id);
    run('DELETE FROM votes WHERE grp = ?', group);
    run('DELETE FROM group_bans WHERE grp = ?', group);
    run('DELETE FROM posts WHERE grp = ?', group);
    run('DELETE FROM group_joins WHERE grp = ?', group);
    run('DELETE FROM group_members WHERE grp = ?', group);
    run('DELETE FROM groups WHERE id = ?', group);
  }

  // --- the requests -------------------------------------------------------

  const routes = {
    'GET /hello': () => ({
      postman: postman.publicKey,
      version: VERSION,
      keepsDays: KEEP_FOR / DAY,
      badgeDays: BADGE_DAYS,
    }),

    'POST /signin/start': ({ device, t, host }) => {
      run('DELETE FROM signins WHERE expires <= ?', t);
      const open = row('SELECT COUNT(*) AS n FROM signins WHERE device = ?', device).n;
      if (open >= MAX_OPEN_SIGNINS) refuse(429, 'Too many sign-ins started; please wait 5 minutes.');
      const code = randomHex(8);
      const expiresAt = t + SIGNIN_VALID_FOR;
      run('INSERT INTO signins (code, device, expires) VALUES (?, ?, ?)', code, device, expiresAt);
      return { code, expiresAt, text: signInText({ site: host, deviceKey: device, code, expiresAt }) };
    },

    'POST /proof/start': ({ device, t, host }) => {
      verifiedAccount(device, t);
      run('DELETE FROM proofs WHERE expires <= ?', t);
      if (row('SELECT COUNT(*) AS n FROM proofs WHERE device = ?', device).n >= MAX_OPEN_SIGNINS) refuse(429, 'Too many wallet checks started; please wait 5 minutes.');
      const code = randomHex(8);
      const expiresAt = t + SIGNIN_VALID_FOR;
      run('INSERT INTO proofs (code, device, expires) VALUES (?, ?, ?)', code, device, expiresAt);
      return { code, expiresAt, text: voteProofText({ site: host, deviceKey: device, code, expiresAt }) };
    },

    'POST /signin/finish': async ({ device, body, t, host }) => {
      const { code, wallet, signature } = body;
      const signin = typeof code === 'string' ? row('SELECT * FROM signins WHERE code = ?', code) : null;
      // One try per code, whatever happens next.
      if (signin) run('DELETE FROM signins WHERE code = ?', code);
      if (!signin || signin.device !== device || signin.expires <= t) refuse(400, 'This sign-in has expired; please start again.');
      try { walletPublicKey(wallet); } catch { refuse(400, 'Not a Klever address.'); }
      const text = signInText({ site: host, deviceKey: device, code, expiresAt: signin.expires });
      if (!(await isWalletSignature(text, wallet, signature))) refuse(403, "The wallet's signature doesn't match.");
      let nfts;
      try { nfts = await devikinsHeld(wallet, fetchKlever); } catch { refuse(502, "Klever's server didn't answer; please try again in a minute."); }
      if (nfts < 1) refuse(403, 'This wallet holds no Devikins right now (NFTs listed or rented out elsewhere don\'t count).');

      const t2 = now();
      const fingerprint = await hmacHex(walletSalt, wallet);
      let account = row('SELECT * FROM accounts WHERE wallet_fp = ?', fingerprint);
      const current = accountOf(device);
      if (current && (!account || current.id !== account.id)) {
        refuse(409, 'This chat key already belongs to another wallet. Leave the chat on this device first.');
      }
      if (!account) {
        // (OR IGNORE: if the same wallet signs in on two devices at the same moment, both join one account.)
        run('INSERT OR IGNORE INTO accounts (id, wallet_fp, verified_until, created) VALUES (?, ?, ?, ?)', randomHex(16), fingerprint, 0, t2);
        account = row('SELECT * FROM accounts WHERE wallet_fp = ?', fingerprint);
      }
      if (!current) {
        if (devicesOf(account.id).length >= MAX_DEVICES) refuse(409, `At most ${MAX_DEVICES} devices per player; remove one first.`);
        run('INSERT INTO devices (key, account, added, seen) VALUES (?, ?, ?, ?)', device, account.id, t2, Math.floor(t2 / DAY) * DAY);
      }
      const badge = issueBadge(postman, { holder: device, nfts, now: t2, account: account.id });
      const verifiedUntil = Number(badge.tags.find((x) => x[0] === 'expiration')[1]) * 1000;
      run('UPDATE accounts SET verified_until = ? WHERE id = ?', verifiedUntil, account.id);
      return { account: account.id, nickname: account.nickname ?? null, nfts, badge, verifiedUntil };
    },

    'GET /me': ({ device, t }) => {
      const account = accountOf(device);
      if (!account) return { signedIn: false };
      return {
        signedIn: true,
        account: account.id,
        nickname: account.nickname ?? null,
        verifiedUntil: account.verified_until,
        devices: devicesOf(account.id),
        // (with the day each was added - for the list of linked devices)
        deviceList: rows('SELECT key, added, seen FROM devices WHERE account = ? ORDER BY added', account.id).map((d) => ({ key: d.key, added: d.added, seen: d.seen ?? null })),
        nextRequestAt: nextRequestAt(account.wallet_fp, t),
      };
    },

    // --- linked devices (27 Oct 2026) ------------------------------------------
    // A player's devices (website, phone …) form one account. They keep each
    // other up to date with sealed envelopes sent to the account's OTHER
    // devices only; the postman can't read them, as with all mail.

    'POST /self': ({ device, body, t }) => {
      const account = accountOf(device);
      if (!account) refuse(403, 'Please sign in with your wallet first.');
      const items = checkItems(body.items);
      const allowed = new Set(devicesOf(account.id).filter((d) => d !== device));
      if (!items.every((i) => allowed.has(i.to))) refuse(400, "One envelope isn't for one of your other devices.");
      spend(`self:${account.id}`, DAILY_SELF_ITEMS, t, items.length);
      return { delivered: deliver(items, 'self', t) };
    },

    /**
     * Linking by QR code (27 Oct 2026): a signed-in device asks for a one-time
     * code (shown as a QR code); a new device hands it in and joins the
     * account - no wallet needed on the new device. The linking device shows
     * its badge, so the new one gets the same Devikins count and end (the
     * postman keeps no counts).
     */
    'POST /link/start': async ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const badge = checkBadge(body.badge, { postmanPublicKey: postman.publicKey, holder: device, at: t });
      if (!badge.ok || badge.account !== account.id) refuse(403, 'Please sign in with your wallet again first.');
      if (devicesOf(account.id).length >= MAX_DEVICES) refuse(409, `At most ${MAX_DEVICES} devices per player; take one out first.`);
      run('DELETE FROM links WHERE expires <= ?', t);
      if (row('SELECT COUNT(*) AS n FROM links WHERE account = ?', account.id).n >= MAX_OPEN_SIGNINS) refuse(429, 'Too many link codes open; please wait 5 minutes.');
      const code = randomHex(10);
      const expiresAt = t + LINK_VALID_FOR;
      run('INSERT INTO links (fp, account, nfts, badge_until, expires) VALUES (?, ?, ?, ?, ?)',
        await sha256Hex(code), account.id, badge.nfts, Math.floor(badge.until / 1000), expiresAt);
      return { code, expiresAt };
    },

    'POST /link/finish': async ({ device, body, t }) => {
      const code = typeof body.code === 'string' ? body.code.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
      const fp = code.length === 20 ? await sha256Hex(code) : null;
      const link = fp ? row('SELECT * FROM links WHERE fp = ?', fp) : null;
      if (link) run('DELETE FROM links WHERE fp = ?', fp); // one try per code
      if (!link || link.expires <= t) refuse(400, 'This link code has expired or was already used; show a new one.');
      const account = row('SELECT * FROM accounts WHERE id = ?', link.account);
      if (!account) refuse(400, 'This link code has expired or was already used; show a new one.');
      const current = accountOf(device);
      if (current && current.id !== account.id) refuse(409, 'This device already has a chat of its own. Leave the chat on it first.');
      if (!current) {
        if (devicesOf(account.id).length >= MAX_DEVICES) refuse(409, `At most ${MAX_DEVICES} devices per player; take one out first.`);
        run('INSERT INTO devices (key, account, added, seen) VALUES (?, ?, ?, ?)', device, account.id, t, Math.floor(t / DAY) * DAY);
      }
      const badge = issueBadge(postman, { holder: device, nfts: link.nfts, now: t, account: account.id, expiresAtSec: link.badge_until });
      return { account: account.id, nickname: account.nickname ?? null, nfts: link.nfts, badge, verifiedUntil: Math.min(account.verified_until, link.badge_until * 1000) };
    },

    /**
     * After a wallet sign-in on one device: the same fresh badge (Devikins
     * count, end) for each of the player's OTHER devices, so devices linked
     * by QR code stay signed in. The asking device passes them on, sealed.
     */
    'POST /badges/mine': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const badge = checkBadge(body.badge, { postmanPublicKey: postman.publicKey, holder: device, at: t });
      if (!badge.ok || badge.account !== account.id) refuse(403, 'Please sign in with your wallet again first.');
      const until = Math.floor(badge.until / 1000);
      return {
        badges: devicesOf(account.id).filter((d) => d !== device)
          .map((d) => ({ device: d, badge: issueBadge(postman, { holder: d, nfts: badge.nfts, now: t, account: account.id, expiresAtSec: until }) })),
      };
    },

    // --- Collectors Albums (27 Oct 2026) ----------------------------------------
    // Everyone may read them (also without signing in). Publishing needs a
    // signed-in holder (against spam; counted in the daily allowance), but
    // what's stored is only the album, under its own key.

    'POST /albums/publish': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const r = checkAlbum(body.album);
      if (!r.ok) refuse(400, `This album can't be published (${r.problem}).`);
      const a = r.album;
      if (a.name !== null && nicknameKey(a.name) !== nicknameKey(account.nickname || '')) refuse(403, 'The name on an album must be your own chat nickname.');
      const old = row('SELECT updated FROM albums WHERE key = ?', a.key);
      if (old && old.updated > a.updatedAt) refuse(409, 'A newer version of this album is already published.');
      if (!old && row('SELECT COUNT(*) AS n FROM albums').n >= MAX_ALBUMS) refuse(507, 'The postman has as many albums as it can hold.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t, 10);
      run(`INSERT INTO albums (key, event, title, name, count, updated, expires) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET event = excluded.event, title = excluded.title, name = excluded.name,
             count = excluded.count, updated = excluded.updated, expires = excluded.expires`,
        a.key, stringify(body.album), a.title, a.name, a.items.length, a.updatedAt, t + ALBUM_KEEP_DAYS * DAY);
      return { published: true, key: a.key };
    },

    /** Deleting an album: the request is signed with the ALBUM's key (only its owner has it). */
    'POST /albums/delete': ({ device }) => ({ deleted: deleteAlbum(device) }),

    // --- Comments on NFTs (28 Oct 2026) -------------------------------------------
    // Belong to the NFT (they stay when it changes hands and show in every
    // album with it); written and voted on by signed-in holders, read by anyone.

    /** The comments on an album's NFTs: { comments: [{ id, kind, nonce, nickname, text, at, confirms, disputes, hidden }] } */
    'GET /comments': ({ query, t }) => {
      const key = String(query.get('album') || '');
      const items = albumItems(key, t);
      if (!items) refuse(404, 'This album no longer exists.');
      const out = [];
      for (const id of items) {
        const [kind, nonce] = id.split('/');
        out.push(...rows(`SELECT c.id, c.kind, c.nonce, c.nickname, c.text, c.at,
            (SELECT COUNT(*) FROM comment_votes v WHERE v.comment = c.id AND v.vote = 1) AS confirms,
            (SELECT COUNT(*) FROM comment_votes v WHERE v.comment = c.id AND v.vote = -1) AS disputes,
            EXISTS (SELECT 1 FROM album_hidden h WHERE h.album = ? AND h.comment = c.id) AS hidden
          FROM comments c WHERE c.kind = ? AND c.nonce = ? ORDER BY c.at`, key, kind, Number(nonce)));
      }
      return { comments: out.map((c) => ({ ...c, hidden: !!c.hidden })) };
    },

    /** { album, kind, nonce, text } - a comment on an NFT that's in that album. */
    'POST /comments/add': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      if (!account.nickname) refuse(403, 'Please pick a chat nickname first.');
      const items = albumItems(String(body.album || ''), t);
      if (!items) refuse(404, 'This album no longer exists.');
      if (!items.has(`${body.kind}/${body.nonce}`)) refuse(400, "That NFT isn't in this album.");
      const text = cleanText(typeof body.text === 'string' ? body.text : '');
      if (!text) refuse(400, 'The comment is empty.');
      if ([...text].length > MAX_COMMENT_CHARS) refuse(413, `A comment can have at most ${MAX_COMMENT_CHARS} characters.`);
      if (row('SELECT COUNT(*) AS n FROM comments WHERE kind = ? AND nonce = ?', body.kind, body.nonce).n >= MAX_COMMENTS_PER_NFT) {
        refuse(507, 'This NFT has as many comments as it can hold.');
      }
      spend(`comments:${account.wallet_fp}`, DAILY_COMMENTS_PER_PLAYER, t);
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      const id = row('INSERT INTO comments (kind, nonce, account, nickname, text, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        body.kind, body.nonce, account.id, account.nickname, text, t).id;
      return { id };
    },

    /** { comment, vote: 1 (I can confirm) | -1 (not right) | 0 (take my vote back) } - not on one's own. */
    'POST /comments/vote': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const c = row('SELECT id, account FROM comments WHERE id = ?', Number(body.comment));
      if (!c) refuse(404, 'This comment no longer exists.');
      if (c.account === account.id) refuse(403, "You can't vote on your own comment.");
      if (![1, -1, 0].includes(body.vote)) refuse(400, 'Damaged request.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      if (body.vote === 0) run('DELETE FROM comment_votes WHERE comment = ? AND account = ?', c.id, account.id);
      else run('INSERT INTO comment_votes (comment, account, vote) VALUES (?, ?, ?) ON CONFLICT (comment, account) DO UPDATE SET vote = excluded.vote', c.id, account.id, body.vote);
      return { voted: body.vote };
    },

    /** { comment } - deleting one's own comment. */
    'POST /comments/delete': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const c = row('SELECT id FROM comments WHERE id = ? AND account = ?', Number(body.comment), account.id);
      if (!c) refuse(404, 'This comment no longer exists (or isn\'t yours).');
      run('DELETE FROM comment_votes WHERE comment = ?', c.id);
      run('DELETE FROM album_hidden WHERE comment = ?', c.id);
      run('DELETE FROM comments WHERE id = ?', c.id);
      return { deleted: true };
    },

    /** { comment, hidden } - the album's owner hides a comment in THEIR album (signed with the album key). */
    'POST /albums/hide-comment': ({ device, body, t }) => {
      if (!albumItems(device, t)) refuse(404, 'This album no longer exists.');
      const id = Number(body.comment);
      if (body.hidden) run('INSERT OR IGNORE INTO album_hidden (album, comment) VALUES (?, ?)', device, id);
      else run('DELETE FROM album_hidden WHERE album = ? AND comment = ?', device, id);
      return { hidden: !!body.hidden };
    },

    // --- The album mailbox (28 Oct 2026) -----------------------------------------
    // A signed-in player writes to "the owner of album X"; the owner answers
    // under the album's name (signed with the album key), so they stay
    // anonymous. Envelopes are sealed for each key (the album's, and the
    // player's devices); the postman can't read them, but it does know which
    // player talks to which album.

    /** Player: { album, items: [{ to, envelope }] } - for the album key and my own devices. */
    'POST /albums/talk/send': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      if (!account.nickname) refuse(403, 'Please pick a chat nickname first.');
      const album = String(body.album || '');
      if (!albumItems(album, t)) refuse(404, 'This album no longer exists.');
      let th = row('SELECT * FROM album_threads WHERE album = ? AND account = ?', album, account.id);
      if (th?.blocked) refuse(403, "The album's owner doesn't take messages from you.");
      checkSealedItems(body.items, [album, ...devicesOf(account.id)]);
      if (!th) {
        spend(`threads:${account.wallet_fp}`, DAILY_ALBUM_THREADS_PER_PLAYER, t);
        th = { id: randomHex(16) };
        run('INSERT INTO album_threads (id, album, account, at) VALUES (?, ?, ?, ?)', th.id, album, account.id, t);
      }
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      for (const it of body.items) run('INSERT INTO album_talk (thread, to_key, envelope, at) VALUES (?, ?, ?, ?)', th.id, it.to, stringify(it.envelope), t);
      run('UPDATE album_threads SET at = ? WHERE id = ?', t, th.id);
      return { thread: th.id };
    },

    /**
     * Messages for this key after number `after` (a player's device, or an
     * album key: the owner's devices share it, so nothing is deleted on
     * pickup - they go after 30 days): { items: [{ id, album, thread, envelope,
     * nickname, devices }] } - nickname and devices only for the album's owner (to answer).
     */
    'GET /albums/talk': ({ device, query }) => {
      const after = Number(query.get('after')) || 0;
      const isAlbum = !!row('SELECT key FROM albums WHERE key = ?', device);
      const found = rows(`SELECT m.id, m.envelope, th.id AS thread, th.album, th.account, th.blocked FROM album_talk m
          JOIN album_threads th ON th.id = m.thread WHERE m.to_key = ? AND m.id > ? ORDER BY m.id LIMIT 200`, device, after);
      return {
        items: found.map((m) => {
          const out = { id: m.id, album: m.album, thread: m.thread, envelope: JSON.parse(m.envelope) };
          if (!isAlbum) return out;
          const a = row('SELECT nickname FROM accounts WHERE id = ?', m.account);
          return { ...out, nickname: a?.nickname ?? null, devices: devicesOf(m.account), blocked: !!m.blocked };
        }),
      };
    },

    /** Owner (album key): { thread, items } - an answer, for the player's devices and the album key (my other devices). */
    'POST /albums/talk/reply': ({ device, body, t }) => {
      const th = row('SELECT * FROM album_threads WHERE id = ? AND album = ?', String(body.thread || ''), device);
      if (!th) refuse(404, 'This conversation no longer exists.');
      checkSealedItems(body.items, [device, ...devicesOf(th.account)]);
      for (const it of body.items) run('INSERT INTO album_talk (thread, to_key, envelope, at) VALUES (?, ?, ?, ?)', th.id, it.to, stringify(it.envelope), t);
      run('UPDATE album_threads SET at = ? WHERE id = ?', t, th.id);
      return { sent: true };
    },

    /** Owner (album key): { thread, blocked } - no more messages from that player to this album. */
    'POST /albums/talk/block': ({ device, body }) => {
      const th = row('SELECT id FROM album_threads WHERE id = ? AND album = ?', String(body.thread || ''), device);
      if (!th) refuse(404, 'This conversation no longer exists.');
      run('UPDATE album_threads SET blocked = ? WHERE id = ?', body.blocked ? 1 : 0, th.id);
      return { blocked: !!body.blocked };
    },

    /** The albums, newest first: { albums: [{ key, title, name, count, updated }] }; `before` = updated time for the next page. */
    'GET /albums': ({ query, t }) => {
      const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
      return {
        albums: rows('SELECT key, title, name, count, updated FROM albums WHERE expires > ? AND updated < ? ORDER BY updated DESC LIMIT 50', t, before),
      };
    },

    'GET /albums/one': ({ query, t }) => {
      const a = row('SELECT event FROM albums WHERE key = ? AND expires > ?', String(query.get('key') || ''), t);
      if (!a) refuse(404, 'This album no longer exists.');
      return { album: JSON.parse(a.event) };
    },

    /** Takes one of the player's OTHER devices out of the account (e.g. a lost phone). */
    'POST /me/devices/remove': ({ device, body }) => {
      const account = accountOf(device);
      if (!account) refuse(403, 'Please sign in with your wallet first.');
      const key = body.key;
      if (key === device) refuse(400, 'To take this device out, leave the chat on it.');
      if (!isPublicKey(key) || !devicesOf(account.id).includes(key)) refuse(404, 'That is not one of your devices.');
      forgetDevice(key);
      return { removed: true };
    },

    'POST /nickname': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
      if (nickname.length < 2 || !NICKNAME.test(nickname)) {
        refuse(400, 'A nickname has 2–20 letters or digits (spaces, _ . - in between are fine).');
      }
      const key = nicknameKey(nickname);
      const taken = row('SELECT id FROM accounts WHERE nick_key = ?', key);
      if (taken && taken.id !== account.id) refuse(409, 'This nickname is taken.');
      run('UPDATE accounts SET nickname = ?, nick_key = ? WHERE id = ?', nickname, key, account.id);
      return { nickname };
    },

    'GET /directory': ({ device, query, t }) => {
      verifiedAccount(device, t);
      const q = nicknameKey(String(query.get('q') || '').trim().slice(0, 20));
      const found = rows(
        `SELECT id, nickname FROM accounts WHERE nickname IS NOT NULL AND verified_until > ?
           AND substr(nick_key, 1, ?) = ? ORDER BY nick_key LIMIT ?`,
        t, q.length, q, MAX_DIRECTORY_RESULTS,
      );
      return { players: found.map((a) => ({ nickname: a.nickname, devices: devicesOf(a.id) })) };
    },

    'POST /request': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
      const target = nickname ? row('SELECT id FROM accounts WHERE nick_key = ? AND verified_until > ?', nicknameKey(nickname), t) : null;
      if (!target) refuse(404, 'No player with this nickname.');
      if (target.id === account.id) refuse(400, "That's you.");
      const wait = contactRequestWait(requestTimes(account.wallet_fp), t);
      if (wait > 0) refuse(429, `Next contact request possible in ${Math.ceil(wait / MINUTE)} min.`);
      const items = checkItems(body.items);
      // Only for that player's devices (copies for your own devices go separately, with your own drop code).
      const allowed = new Set(devicesOf(target.id));
      if (!items.every((i) => allowed.has(i.to))) refuse(400, "One envelope isn't for this player.");
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      deliver(items, 'request', t);
      run('INSERT INTO requests (player, at) VALUES (?, ?)', account.wallet_fp, t);
      return { delivered: items.length, nextRequestAt: nextRequestAt(account.wallet_fp, t) };
    },

    'POST /codes': async ({ device, body, t }) => {
      verifiedAccount(device, t);
      const add = Array.isArray(body.add) ? body.add : [];
      const remove = Array.isArray(body.remove) ? body.remove : [];
      if (add.length + remove.length > 100 || ![...add, ...remove].every(isCode)) refuse(400, 'Damaged drop codes.');
      if (add.length + remove.length === 0) refuse(400, 'Nothing to change.');
      const addFp = await Promise.all(add.map(sha256Hex));
      const removeFp = await Promise.all(remove.map(sha256Hex));
      // (no waiting after this point, so nothing else happens in between)
      const fresh = verifiedAccount(device, now());
      spend(fresh.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t, add.length + remove.length);
      for (const fp of removeFp) run('DELETE FROM codes WHERE fp = ? AND account = ?', fp, fresh.id);
      const count = row('SELECT COUNT(*) AS n FROM codes WHERE account = ?', fresh.id).n;
      if (count + add.length > MAX_CODES_PER_ACCOUNT) refuse(507, 'Too many drop codes.');
      let refused = 0;
      for (const fp of addFp) {
        const owner = row('SELECT account FROM codes WHERE fp = ?', fp);
        if (owner && owner.account !== fresh.id) refused += 1;
        else if (!owner) run('INSERT INTO codes (fp, account) VALUES (?, ?)', fp, fresh.id);
      }
      return { count: row('SELECT COUNT(*) AS n FROM codes WHERE account = ?', fresh.id).n, refused };
    },

    // No chat-key signature here on purpose: whoever has a drop code may
    // drop into that player's mailboxes, and the postman doesn't learn who.
    'POST /drop': async ({ body, t }) => {
      const fp = isCode(body.code) ? await sha256Hex(body.code) : null;
      const owner = fp ? row('SELECT account FROM codes WHERE fp = ?', fp) : null;
      if (!owner) refuse(403, 'This contact has ended the chat (or the code is wrong).');
      const items = checkItems(body.items);
      const allowed = new Set(devicesOf(owner.account));
      if (!items.every((i) => allowed.has(i.to))) refuse(400, "One envelope isn't for this player.");
      spend(`code:${fp}`, DAILY_DROPS_PER_CODE, t, items.length);
      return { delivered: deliver(items, 'direct', t) };
    },

    'POST /drop/devices': async ({ body }) => {
      const owner = isCode(body.code) ? row('SELECT account FROM codes WHERE fp = ?', await sha256Hex(body.code)) : null;
      if (!owner) refuse(403, 'This contact has ended the chat (or the code is wrong).');
      return { devices: devicesOf(owner.account) };
    },

    'GET /mail': ({ device }) => ({
      items: rows('SELECT id, kind, envelope, at FROM mail WHERE device = ? ORDER BY id LIMIT ?', device, MAX_MAIL_PER_FETCH)
        .map((m) => ({ id: m.id, kind: m.kind, envelope: JSON.parse(m.envelope), at: m.at })),
    }),

    'POST /mail/done': ({ device, body }) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, MAX_MAIL_PER_FETCH) : [];
      let deleted = 0;
      for (const id of ids) {
        deleted += rows('DELETE FROM mail WHERE id = ? AND device = ? RETURNING id', id, device).length;
      }
      return { deleted };
    },

    // --- groups -------------------------------------------------------------
    // Open groups: listed for all signed-in players; anyone may ask to join.
    // A member's Hub hands the group key to a new member (sealed, with the
    // drop code the newcomer gave) and tells the postman "let them in" – the
    // postman never has the key. From then on the postman hands the new
    // member only posts from after joining.

    'GET /groups': async ({ device, t }) => {
      const account = verifiedAccount(device, t);
      const mine = new Set(rows('SELECT grp FROM group_members WHERE account = ?', account.id).map((r) => r.grp));
      const asking = new Set(rows('SELECT grp FROM group_joins WHERE account = ?', account.id).map((r) => r.grp));
      const banned = new Set(rows('SELECT grp FROM group_bans WHERE player = ?', account.wallet_fp).map((r) => r.grp));
      return {
        groups: rows(
          // Biggest first, then the ones with the latest post (24 Oct 2026).
          `SELECT g.id, g.name, g.description, g.owner, g.pinned_at, g.key_check, g.epoch, g.alone_since, a.nickname AS owner_nickname,
             (SELECT COUNT(*) FROM group_members m WHERE m.grp = g.id) AS members,
             (SELECT MAX(at) FROM posts p WHERE p.grp = g.id) AS last_post
           FROM groups g LEFT JOIN accounts a ON a.id = g.owner ORDER BY members DESC, last_post IS NULL, last_post DESC, g.created`,
        ).map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          owner: g.owner_nickname ?? null,
          isOwner: g.owner === account.id,
          members: g.members,
          member: mine.has(g.id),
          asking: asking.has(g.id),
          banned: banned.has(g.id),
          keyCheck: g.key_check,
          epoch: g.epoch,
          // For the owner of a group nobody else is in: when it goes.
          removeAt: g.owner === account.id && g.alone_since ? g.alone_since + OWNER_ONLY_GROUP_DAYS * DAY : null,
        })),
        // What starting a group takes (the same as voting).
        createThreshold: await currentThreshold(),
      };
    },

    // Only the groups this player is in, with what their Hub needs to keep up
    // (asked on every mail check, so it stays small).
    'GET /groups/mine': async ({ device, t }) => {
      const account = verifiedAccount(device, t);
      return {
        groups: rows(
          `SELECT g.id, g.owner, g.pinned_at, g.key_check, g.epoch, g.needs_rekey, a.nickname AS owner_nickname,
             (SELECT MAX(opened_at) FROM votes v WHERE v.grp = g.id) AS last_vote,
             (SELECT MAX(seq) FROM posts p WHERE p.grp = g.id) AS last_seq
           FROM group_members m JOIN groups g ON g.id = m.grp LEFT JOIN accounts a ON a.id = g.owner
           WHERE m.account = ?`, account.id,
        ).map((g) => ({
          id: g.id,
          owner: g.owner_nickname ?? null,
          // The owner's account number (as in their badge): every Hub lets the
          // owner post as often as the postman allows.
          ownerAccount: g.owner,
          isOwner: g.owner === account.id,
          lastSeq: g.last_seq ?? 0,
          pinnedAt: g.pinned_at ?? null,
          keyCheck: g.key_check,
          epoch: g.epoch,
          needsRekey: !!g.needs_rekey,
          lastVote: g.last_vote ?? null,
          pausedUntil: pausedUntil(g.id, account.id, t),
          waiting: row(`SELECT COUNT(*) AS n ${OPEN_JOINS}`, g.id, t).n,
        })),
      };
    },

    'POST /groups/create': async ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      if (!account.nickname) refuse(400, 'Please choose a nickname first.');
      // (asked first, so nothing below waits in between)
      const threshold = await currentThreshold();
      if (!isGroupId(body.id) || row('SELECT 1 AS x FROM groups WHERE id = ?', body.id)) refuse(400, 'Please try again.');
      if (!HEX64.test(body.keyCheck || '')) refuse(400, 'Damaged request.');
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!GROUP_NAME.test(name)) refuse(400, 'A group name has 3–40 letters, digits and simple punctuation.');
      if (description.length > MAX_GROUP_DESCRIPTION) refuse(400, `The description can have at most ${MAX_GROUP_DESCRIPTION} characters.`);
      if (row('SELECT COUNT(*) AS n FROM groups WHERE owner = ?', account.id).n >= MAX_GROUPS_CREATED_PER_PLAYER) {
        refuse(429, `At most ${MAX_GROUPS_CREATED_PER_PLAYER} groups per player.`);
      }
      if (row('SELECT COUNT(*) AS n FROM groups').n >= MAX_GROUPS) refuse(507, 'The postman has as many groups as it can hold.');
      const nameKey = nicknameKey(name);
      if (row('SELECT id FROM groups WHERE name_key = ?', nameKey)) refuse(409, 'A group with this name exists already.');
      // Starting a group takes as many Devikins as voting (Raphael, 24 Oct
      // 2026), counted at the last sign-in: the badge this device was given.
      const badge = checkBadge(body.badge, { postmanPublicKey: postman.publicKey, holder: device, at: t });
      if (!badge.ok || (badge.account !== null && badge.account !== account.id)) refuse(403, 'Please sign in with your wallet again (it is checked once a week).');
      // (Badges carry bands since 27 Oct 2026: the threshold is compared by its band, e.g. 12 → 10.)
      if (badge.nfts < holdingBand(threshold)) {
        refuse(403, `Starting a group takes at least ${threshold} Devikins (your last sign-in counted ${bandLabel(badge.nfts)}). "Update my holdings" counts again.`);
      }
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      const id = body.id;
      run('INSERT INTO groups (id, name, name_key, description, owner, created, key_check, alone_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, name, nameKey, description, account.id, t, body.keyCheck, t);
      run('INSERT INTO group_members (grp, account, joined_seq, joined_at) VALUES (?, ?, 0, ?)', id, account.id, t);
      return { id, name };
    },

    'POST /groups/join': async ({ device, body, t }) => {
      verifiedAccount(device, t);
      const g = isGroupId(body.group) ? row('SELECT id FROM groups WHERE id = ?', body.group) : null;
      if (!g) refuse(404, 'This group no longer exists.');
      if (!isCode(body.code)) refuse(400, 'Damaged request.');
      const fp = await sha256Hex(body.code);
      const account = verifiedAccount(device, now());
      if (!account.nickname) refuse(400, 'Please choose a nickname first.');
      if (isBanned(g.id, account.wallet_fp)) {
        refuse(403, 'You were removed from this group by a vote. Only its owner can let you back in (you can ask them in a 1:1 chat).');
      }
      // (A member asking again - e.g. a new browser without the key - is handed the key again too.)
      const isMember = !!row('SELECT 1 AS x FROM group_members WHERE grp = ? AND account = ?', g.id, account.id);
      // The code must open this player's own mailboxes (the new member's Hub registered it).
      if (row('SELECT account FROM codes WHERE fp = ?', fp)?.account !== account.id) refuse(400, 'Please try again.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      const old = row('SELECT code_fp FROM group_joins WHERE grp = ? AND account = ?', g.id, account.id);
      if (old && old.code_fp !== fp) run('DELETE FROM codes WHERE fp = ? AND account = ?', old.code_fp, account.id);
      run(`INSERT INTO group_joins (grp, account, code, code_fp, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (grp, account) DO UPDATE SET code = excluded.code, code_fp = excluded.code_fp, at = excluded.at`,
        g.id, account.id, body.code, fp, t);
      return { member: isMember, asking: true };
    },

    'GET /groups/joins': ({ device, query, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(query.get('group'), account);
      return {
        joins: rows(`SELECT j.account, j.code, a.nickname ${OPEN_JOINS} ORDER BY j.at LIMIT 20`, group, t).map((j) => ({ account: j.account, nickname: j.nickname, code: j.code, devices: devicesOf(j.account) })),
      };
    },

    'POST /groups/admit': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(body.group, account);
      const join = typeof body.account === 'string' ? row('SELECT * FROM group_joins WHERE grp = ? AND account = ?', group, body.account) : null;
      if (!join) return { admitted: false };
      const joiner = row('SELECT wallet_fp FROM accounts WHERE id = ?', join.account);
      if (!joiner || isBanned(group, joiner.wallet_fp)) {
        dropJoin(group, join.account);
        return { admitted: false };
      }
      const lastSeq = row('SELECT MAX(seq) AS s FROM posts WHERE grp = ?', group).s ?? 0;
      dropJoin(group, join.account);
      run('INSERT OR IGNORE INTO group_members (grp, account, joined_seq, joined_at) VALUES (?, ?, ?, ?)', group, join.account, lastSeq, t);
      run('UPDATE groups SET alone_since = NULL WHERE id = ?', group);
      return { admitted: true };
    },

    'GET /groups/members': ({ device, query, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(query.get('group'), account);
      return {
        members: rows(
          `SELECT a.id, a.nickname FROM group_members m JOIN accounts a ON a.id = m.account
           WHERE m.grp = ? AND a.nickname IS NOT NULL ORDER BY m.joined_at, m.rowid`, group,
        ).map((m) => ({ nickname: m.nickname, devices: devicesOf(m.id) })),
      };
    },

    'POST /groups/leave': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const g = isGroupId(body.group) ? row('SELECT * FROM groups WHERE id = ?', body.group) : null;
      if (!g) return { left: true };
      dropJoin(g.id, account.id);
      if (!row('SELECT 1 AS x FROM group_members WHERE grp = ? AND account = ?', g.id, account.id)) return { left: true };
      return { left: true, ...removeMember(g.id, account.id) };
    },

    'POST /groups/pin': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(body.group, account);
      if (row('SELECT owner FROM groups WHERE id = ?', group).owner !== account.id) refuse(403, 'Only the group owner can pin messages.');
      let text = null;
      if (body.envelope !== null) {
        const e = body.envelope;
        if (!e || e.v !== 1 || e.group !== group || !Number.isInteger(e.epoch) || typeof e.payload !== 'string') refuse(400, 'Not a group envelope.');
        text = stringify(e);
        if (text.length > MAX_PINNED_CHARS) refuse(413, 'The pinned text is too long.');
      }
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      // (always a new time, so every Hub notices the change)
      const before = row('SELECT pinned_at FROM groups WHERE id = ?', group).pinned_at ?? 0;
      run('UPDATE groups SET pinned = ?, pinned_at = ? WHERE id = ?', text, Math.max(t, before + 1), group);
      return { pinned: text !== null };
    },

    'GET /groups/pin': ({ device, query, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(query.get('group'), account);
      const g = row('SELECT pinned, pinned_at FROM groups WHERE id = ?', group);
      return { envelope: g.pinned ? JSON.parse(g.pinned) : null, at: g.pinned_at ?? null };
    },

    // --- removal votes ------------------------------------------------------

    'GET /groups/votes': async ({ device, query, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(query.get('group'), account);
      const nick = (id) => row('SELECT nickname FROM accounts WHERE id = ?', id)?.nickname ?? null;
      const myJoin = row('SELECT joined_at FROM group_members WHERE grp = ? AND account = ?', group, account.id).joined_at;
      return {
        threshold: await currentThreshold(),
        canOpen: canOpenVote(rows('SELECT opened_at FROM votes WHERE opener_fp = ?', account.wallet_fp).map((v) => v.opened_at), t),
        votes: rows('SELECT * FROM votes WHERE grp = ? AND (decided = 0 OR decided_at > ?) ORDER BY opened_at DESC', group, t - 7 * DAY).map((v) => {
          const ballots = ballotsOf(v.id);
          return {
            id: v.id,
            accused: nick(v.accused) ?? v.accused_nick ?? null,
            aboutMe: v.accused === account.id,
            opener: nick(v.opener),
            reason: JSON.parse(v.reason),
            openedAt: v.opened_at,
            endsAt: v.opened_at + VOTE_DURATION,
            members: v.members,
            decided: !!v.decided,
            passed: v.passed === null ? null : !!v.passed,
            valid: v.valid === null ? null : !!v.valid,
            removed: !!v.removed,
            // Members who joined after the vote started can't vote in it.
            mayVote: myJoin <= v.opened_at && v.accused !== account.id,
            // Who voted how is visible inside the group (decided 21 Oct 2026);
            // whether a voter's holdings count is only "counts / doesn't".
            ballots: ballots.map((b) => ({ voter: nick(b.account), yes: !!b.yes, counts: !!b.eligible })),
            myBallot: ballots.find((b) => b.account === account.id) ? { yes: !!ballots.find((b) => b.account === account.id).yes } : null,
          };
        }),
        banned: account.id === row('SELECT owner FROM groups WHERE id = ?', group).owner
          ? rows('SELECT id, nickname FROM group_bans WHERE grp = ?', group).map((b) => ({ id: b.id, nickname: b.nickname }))
          : [],
      };
    },

    'POST /groups/vote/open': async ({ device, body, t, host }) => {
      let account = verifiedAccount(device, t);
      let group = memberGroup(body.group, account);
      const threshold = await currentThreshold();
      const isOwner = row('SELECT owner FROM groups WHERE id = ?', group).owner === account.id;
      const { wallet, held } = await checkVoteProof({ device, account, body, threshold, host, anyHoldings: isOwner });
      account = verifiedAccount(device, now());
      group = memberGroup(body.group, account);
      const accused = typeof body.accused === 'string' ? row('SELECT id, wallet_fp, nickname FROM accounts WHERE nick_key = ?', nicknameKey(body.accused)) : null;
      if (!accused || !row('SELECT 1 AS x FROM group_members WHERE grp = ? AND account = ?', group, accused.id)) refuse(404, 'No member with this nickname.');
      if (accused.id === account.id) refuse(400, "That's you.");
      if (accused.id === row('SELECT owner FROM groups WHERE id = ?', group).owner) refuse(403, "The group's owner can't be voted out. Members who disagree can leave and start their own group.");
      if (row('SELECT 1 AS x FROM votes WHERE grp = ? AND accused = ? AND decided = 0', group, accused.id)) refuse(409, 'There is already an open vote about this member.');
      if (!canOpenVote(rows('SELECT opened_at FROM votes WHERE opener_fp = ?', account.wallet_fp).map((v) => v.opened_at), t)) refuse(429, 'You can start at most one vote per week.');
      const e = body.reason;
      if (!e || e.v !== 1 || e.group !== group || typeof e.payload !== 'string') refuse(400, 'Please give a reason.');
      const reason = stringify(e);
      if (reason.length > MAX_GROUP_ENVELOPE_CHARS) refuse(413, 'The reason is too long.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      const id = randomHex(16);
      const members = row('SELECT COUNT(*) AS n FROM group_members WHERE grp = ?', group).n;
      run(`INSERT INTO votes (id, grp, accused, opener, accused_fp, accused_nick, opener_fp, reason, opened_at, members)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, group, accused.id, account.id, accused.wallet_fp, accused.nickname, account.wallet_fp, reason, t, members);
      // (The opener's "yes" counts only with the threshold - an owner below it can start the vote, not decide it.)
      run('INSERT INTO ballots (vote, account, yes, eligible, at, wallet) VALUES (?, ?, 1, ?, ?, ?)', id, account.id, held >= threshold ? 1 : 0, t, wallet);
      closeEarlyIfDecided(id, { afterBallot: true });
      return { id, endsAt: t + VOTE_DURATION };
    },

    'POST /groups/vote/cast': async ({ device, body, t, host }) => {
      let account = verifiedAccount(device, t);
      const v = typeof body.vote === 'string' && HEX32.test(body.vote) ? row('SELECT * FROM votes WHERE id = ?', body.vote) : null;
      if (!v) refuse(404, 'This vote no longer exists.');
      memberGroup(v.grp, account);
      if (v.accused === account.id) refuse(403, "You can't vote about yourself. You can contact the group owner.");
      if (row('SELECT 1 AS x FROM ballots WHERE vote = ? AND account = ?', v.id, account.id)) refuse(409, 'You have voted already.');
      if (v.decided || t >= v.opened_at + VOTE_DURATION) refuse(409, 'This vote has ended.');
      if (row('SELECT joined_at FROM group_members WHERE grp = ? AND account = ?', v.grp, account.id).joined_at > v.opened_at) {
        refuse(403, 'Only members who were in the group when the vote started can vote.');
      }
      const threshold = await currentThreshold();
      const { wallet } = await checkVoteProof({ device, account, body, threshold, host });
      account = verifiedAccount(device, now());
      memberGroup(v.grp, account);
      if (row('SELECT decided FROM votes WHERE id = ?', v.id).decided || now() >= v.opened_at + VOTE_DURATION) refuse(409, 'This vote has ended.');
      if (row('SELECT 1 AS x FROM ballots WHERE vote = ? AND account = ?', v.id, account.id)) refuse(409, 'You have voted already.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      run('INSERT INTO ballots (vote, account, yes, eligible, at, wallet) VALUES (?, ?, ?, 1, ?, ?)', v.id, account.id, body.yes === true ? 1 : 0, t, wallet);
      closeEarlyIfDecided(v.id, { afterBallot: true });
      return { voted: true };
    },

    'POST /groups/unban': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(body.group, account);
      if (row('SELECT owner FROM groups WHERE id = ?', group).owner !== account.id) refuse(403, 'Only the group owner can let someone back in.');
      run('DELETE FROM group_bans WHERE grp = ? AND id = ?', group, Number(body.ban) || 0);
      return { unbanned: true };
    },

    // A member's Hub hands the group's NEW key (after a removal) to every
    // member's devices, sealed for each. Only the first new key counts.
    'POST /groups/rekey': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(body.group, account);
      const g = row('SELECT epoch, needs_rekey FROM groups WHERE id = ?', group);
      if (!g.needs_rekey || body.epoch !== g.epoch + 1) refuse(409, 'The group has its new key already.');
      if (!HEX64.test(body.keyCheck || '')) refuse(400, 'Damaged request.');
      if (!Array.isArray(body.items) || body.items.length > 500) refuse(400, 'Damaged request.');
      const allowed = new Set();
      for (const m of rows('SELECT account FROM group_members WHERE grp = ?', group)) for (const d of devicesOf(m.account)) allowed.add(d);
      const items = body.items.map((i) => ({ to: i?.to, text: checkEnvelopeFor(i?.to, i?.envelope) }));
      // Every member's every device, exactly once: nobody can be left out of the new key.
      const to = new Set(items.map((i) => i.to));
      if (to.size !== items.length || to.size !== allowed.size || ![...allowed].every((d) => to.has(d))) {
        refuse(409, "The new key must go to every member's devices; please try again.");
      }
      for (const item of items) run('INSERT INTO mail (device, kind, envelope, at) VALUES (?, ?, ?, ?)', item.to, 'direct', item.text, Math.floor(t / (60 * MINUTE)) * 60 * MINUTE);
      run('UPDATE groups SET epoch = ?, key_check = ?, needs_rekey = 0 WHERE id = ?', body.epoch, body.keyCheck, group);
      return { epoch: body.epoch };
    },

    'POST /group/post': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const envelope = body.envelope;
      if (!envelope || envelope.v !== 1 || !HEX32.test(envelope.group) || !Number.isInteger(envelope.epoch)
          || envelope.epoch < 1 || typeof envelope.payload !== 'string') {
        refuse(400, 'Not a group envelope.');
      }
      memberGroup(envelope.group, account);
      if (envelope.epoch !== row('SELECT epoch FROM groups WHERE id = ?', envelope.group).epoch) {
        refuse(409, 'This group has a new key; your Hub is fetching it. Please try again in a moment.');
      }
      const pause = pausedUntil(envelope.group, account.id, t);
      if (pause) refuse(403, `Your posting in this group is paused while a vote about you is open (until ${new Date(pause).toISOString().slice(0, 16).replace('T', ' ')} UTC). You can contact the group owner.`);
      const text = stringify(envelope);
      if (text.length > MAX_GROUP_ENVELOPE_CHARS) refuse(413, 'This envelope is too big.');
      // A reaction (👍 ❤️ …, sealed like a post - the postman can't tell, the Hubs can) is free:
      // no 10-second gap; it only counts towards the daily actions (24 Oct 2026).
      const reaction = body.reaction === true;
      const last = reaction ? null : row('SELECT at FROM lastpost WHERE player = ?', account.wallet_fp);
      if (last && t - last.at < MIN_POST_INTERVAL) refuse(429, 'At most one group post every 10 seconds.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      if (!reaction) run('INSERT INTO lastpost (player, at) VALUES (?, ?) ON CONFLICT (player) DO UPDATE SET at = excluded.at', account.wallet_fp, t);
      const seq = row('INSERT INTO posts (grp, envelope, at) VALUES (?, ?, ?) RETURNING seq', envelope.group, text, t).seq;
      return { seq, receivedAt: t };
    },

    'GET /group/posts': ({ device, query, t }) => {
      const account = verifiedAccount(device, t);
      const group = memberGroup(query.get('group'), account);
      const after = Number(query.get('after') || 0);
      if (!Number.isInteger(after) || after < 0) refuse(400, 'Unknown group.');
      // A member only gets posts from after joining.
      const from = Math.max(after, row('SELECT joined_seq FROM group_members WHERE grp = ? AND account = ?', group, account.id).joined_seq);
      return {
        posts: rows('SELECT seq, envelope, at FROM posts WHERE grp = ? AND seq > ? ORDER BY seq LIMIT ?', group, from, MAX_POSTS_PER_FETCH)
          .map((p) => ({ seq: p.seq, envelope: JSON.parse(p.envelope), receivedAt: p.at })),
      };
    },

    'POST /leave': ({ device }) => {
      const account = accountOf(device);
      run('DELETE FROM devices WHERE key = ?', device);
      run('DELETE FROM mail WHERE device = ?', device);
      run('DELETE FROM album_talk WHERE to_key = ?', device);
      run('DELETE FROM signins WHERE device = ?', device);
      let accountDeleted = false;
      if (account && devicesOf(account.id).length === 0) {
        run('DELETE FROM group_joins WHERE account = ?', account.id);
        for (const m of rows('SELECT grp FROM group_members WHERE account = ?', account.id)) removeMember(m.grp, account.id);
        // (The contact-request pause and post times stay until they run out
        // by themselves, so leaving and coming back doesn't reset them.)
        run('DELETE FROM codes WHERE account = ?', account.id);
        forgetAlbumActivity(account.id);
        run('DELETE FROM accounts WHERE id = ?', account.id);
        accountDeleted = true;
      }
      return { left: true, accountDeleted };
    },
  };

  const OPEN = new Set(['GET /hello', 'POST /drop', 'POST /drop/devices', 'GET /albums', 'GET /albums/one', 'GET /comments']);

  /**
   * handle — one request. → { status, body }
   * `url` is the full address the device called (it's part of its signature).
   */
  async function handle({ method, url, bodyText = '', authorization = null }) {
    const t = now();
    try {
      const parsed = new URL(url);
      const name = `${method.toUpperCase()} ${parsed.pathname}`;
      const route = routes[name];
      if (!route) refuse(404, 'Unknown request.');
      let body = {};
      if (bodyText.length > MAX_BODY_CHARS) refuse(413, 'Too big.');
      if (method.toUpperCase() === 'POST') {
        try { body = JSON.parse(bodyText || '{}'); } catch { refuse(400, 'Damaged request.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'Damaged request.');
      }
      let device = null;
      if (!OPEN.has(name)) {
        try {
          device = checkAuthHeader(authorization, { url, method, bodyText, now: t });
        } catch (e) {
          refuse(401, e.message);
        }
        // The day this device was last in use (only the day: "active today" is all the player's
        // other devices see; idle for DEVICE_IDLE_DAYS = taken out, see cleanUp).
        const today = Math.floor(t / DAY) * DAY;
        run('UPDATE devices SET seen = ? WHERE key = ? AND (seen IS NULL OR seen < ?)', today, device, today);
      }
      return { status: 200, body: await route({ device, body, query: parsed.searchParams, t, host: parsed.host }) };
    } catch (e) {
      if (e instanceof Refusal) return { status: e.status, body: { error: e.message } };
      return { status: 500, body: { error: 'Something went wrong at the postman.' } };
    }
  }

  /** The daily clean-up (Cloudflare calls it with an alarm). */
  function cleanUp() {
    const t = now();
    const cutoff = t - KEEP_FOR;
    run('DELETE FROM mail WHERE at < ?', cutoff);
    run('DELETE FROM posts WHERE at < ?', cutoff);
    run('DELETE FROM signins WHERE expires <= ?', t);
    run('DELETE FROM proofs WHERE expires <= ?', t);
    for (const a of rows('SELECT key FROM albums WHERE expires <= ?', t)) deleteAlbum(a.key);
    run('DELETE FROM album_talk WHERE at < ?', cutoff);
    run('DELETE FROM album_threads WHERE at < ? AND blocked = 0', cutoff);
    run('DELETE FROM requests WHERE at < ?', t - DAY);
    // Devices nobody has used for DEVICE_IDLE_DAYS (an old phone, a reinstalled app): out of the account.
    // (The account itself stays while it has other devices; with none left it goes after 180 days as before.)
    for (const d of rows('SELECT key FROM devices WHERE seen IS NOT NULL AND seen < ?', t - DEVICE_IDLE_DAYS * DAY)) forgetDevice(d.key);
    run('DELETE FROM lastpost WHERE at < ?', t - DAY);
    run('DELETE FROM budget WHERE day < ?', Math.floor(t / DAY) - 1);
    for (const j of rows('SELECT grp, account FROM group_joins WHERE at < ?', t - JOIN_WAIT_DAYS * DAY)) dropJoin(j.grp, j.account);
    // Groups only their owner has been in for 30 days (unless someone is waiting to be let in).
    for (const g of rows(`SELECT id FROM groups WHERE alone_since IS NOT NULL AND alone_since < ?
        AND NOT EXISTS (SELECT 1 FROM group_joins j WHERE j.grp = groups.id)`, t - OWNER_ONLY_GROUP_DAYS * DAY)) deleteGroup(g.id);
    // Players who haven't signed in for half a year: their account, nickname,
    // devices, drop codes and waiting mail go (they can simply sign in again).
    for (const gone of rows('SELECT id FROM accounts WHERE verified_until < ?', t - FORGET_AFTER)) {
      for (const d of devicesOf(gone.id)) run('DELETE FROM mail WHERE device = ?', d);
      run('DELETE FROM devices WHERE account = ?', gone.id);
      run('DELETE FROM codes WHERE account = ?', gone.id);
      run('DELETE FROM group_joins WHERE account = ?', gone.id);
      for (const m of rows('SELECT grp FROM group_members WHERE account = ?', gone.id)) removeMember(m.grp, gone.id);
      forgetAlbumActivity(gone.id);
      run('DELETE FROM accounts WHERE id = ?', gone.id);
    }
  }

  return { handle, cleanUp, decideAllVotes, nextVoteEnd, postmanPublicKey: postman.publicKey };
}

