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
import { issueBadge, BADGE_DAYS } from '../../src/badge.js';
import { isPublicKey } from '../../src/identity.js';
import { contactRequestWait, DAY, MINUTE, MIN_POST_INTERVAL } from '../../src/rules.js';
import { checkAuthHeader } from './auth.js';
import { signInText, isWalletSignature, devikinsHeld, walletPublicKey } from './kleverProof.js';

export const VERSION = '1';
export const KEEP_FOR = 30 * DAY;
export const FORGET_AFTER = 180 * DAY;
export const SIGNIN_VALID_FOR = 5 * MINUTE;
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

/**
 * Folds look-alike nicknames together, so nobody can pose as someone else:
 * "Devi_Fan" = "devi fan" = "DEVIFAN" = "Dev1Fan"; 0 and O count the same,
 * as do 1, l and I.
 */
export function nicknameKey(nickname) {
  return nickname.toLowerCase().replace(/[ _.-]+/g, '').replace(/0/g, 'o').replace(/[1l]/g, 'i');
}

/**
 * createPostOffice
 *   sql:  { exec(query, ...params) → { toArray() } } – Cloudflare's
 *         ctx.storage.sql, or the stand-in used by the tests
 *   now:  () → milliseconds
 *   fetchKlever: fetch function used to ask Klever's API
 */
export function createPostOffice({ sql, now = () => Date.now(), fetchKlever = (...a) => fetch(...a) }) {
  for (const statement of SCHEMA) sql.exec(statement);
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
    for (const item of items) {
      const waiting = row('SELECT COUNT(*) AS n FROM mail WHERE device = ?', item.to).n;
      if (waiting >= MAX_WAITING_PER_DEVICE) refuse(507, "This player's mailbox is full; they need to open the Hub first.");
    }
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    for (const item of items) run('INSERT INTO mail (device, kind, envelope, at) VALUES (?, ?, ?, ?)', item.to, kind, item.text, hour);
    return items.length;
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
        run('INSERT INTO devices (key, account, added) VALUES (?, ?, ?)', device, account.id, t2);
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
        nextRequestAt: nextRequestAt(account.wallet_fp, t),
      };
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

    'POST /group/post': ({ device, body, t }) => {
      const account = verifiedAccount(device, t);
      const envelope = body.envelope;
      if (!envelope || envelope.v !== 1 || !HEX32.test(envelope.group) || !Number.isInteger(envelope.epoch)
          || envelope.epoch < 1 || typeof envelope.payload !== 'string') {
        refuse(400, 'Not a group envelope.');
      }
      const text = stringify(envelope);
      if (text.length > MAX_GROUP_ENVELOPE_CHARS) refuse(413, 'This envelope is too big.');
      const last = row('SELECT at FROM lastpost WHERE player = ?', account.wallet_fp);
      if (last && t - last.at < MIN_POST_INTERVAL) refuse(429, 'At most one group post per minute.');
      spend(account.wallet_fp, DAILY_ACTIONS_PER_PLAYER, t);
      run('INSERT INTO lastpost (player, at) VALUES (?, ?) ON CONFLICT (player) DO UPDATE SET at = excluded.at', account.wallet_fp, t);
      const seq = row('INSERT INTO posts (grp, envelope, at) VALUES (?, ?, ?) RETURNING seq', envelope.group, text, t).seq;
      return { seq, receivedAt: t };
    },

    'GET /group/posts': ({ device, query, t }) => {
      verifiedAccount(device, t);
      const group = String(query.get('group') || '');
      const after = Number(query.get('after') || 0);
      if (!HEX32.test(group) || !Number.isInteger(after) || after < 0) refuse(400, 'Unknown group.');
      return {
        posts: rows('SELECT seq, envelope, at FROM posts WHERE grp = ? AND seq > ? ORDER BY seq LIMIT ?', group, after, MAX_POSTS_PER_FETCH)
          .map((p) => ({ seq: p.seq, envelope: JSON.parse(p.envelope), receivedAt: p.at })),
      };
    },

    'POST /leave': ({ device }) => {
      const account = accountOf(device);
      run('DELETE FROM devices WHERE key = ?', device);
      run('DELETE FROM mail WHERE device = ?', device);
      run('DELETE FROM signins WHERE device = ?', device);
      let accountDeleted = false;
      if (account && devicesOf(account.id).length === 0) {
        // (The contact-request pause and post times stay until they run out
        // by themselves, so leaving and coming back doesn't reset them.)
        run('DELETE FROM codes WHERE account = ?', account.id);
        run('DELETE FROM accounts WHERE id = ?', account.id);
        accountDeleted = true;
      }
      return { left: true, accountDeleted };
    },
  };

  const OPEN = new Set(['GET /hello', 'POST /drop', 'POST /drop/devices']);

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
    run('DELETE FROM requests WHERE at < ?', t - DAY);
    run('DELETE FROM lastpost WHERE at < ?', t - DAY);
    run('DELETE FROM budget WHERE day < ?', Math.floor(t / DAY) - 1);
    // Players who haven't signed in for half a year: their account, nickname,
    // devices, drop codes and waiting mail go (they can simply sign in again).
    for (const gone of rows('SELECT id FROM accounts WHERE verified_until < ?', t - FORGET_AFTER)) {
      for (const d of devicesOf(gone.id)) run('DELETE FROM mail WHERE device = ?', d);
      run('DELETE FROM devices WHERE account = ?', gone.id);
      run('DELETE FROM codes WHERE account = ?', gone.id);
      run('DELETE FROM accounts WHERE id = ?', gone.id);
    }
  }

  return { handle, cleanUp, postmanPublicKey: postman.publicKey };
}

