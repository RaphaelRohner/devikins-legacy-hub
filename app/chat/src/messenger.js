/**
 * messenger.js — one device's chat: contacts, requests and 1:1 messages
 *
 * Ties the pieces together for an app (the Hub, or another one later):
 *   - the device's chat key (identity.js), made once and kept,
 *   - the postman (client.js),
 *   - sealing / opening (direct.js),
 *   - and a small local database for contacts and message history.
 * No screens here. The database is passed in, with the same three calls
 * expo-sqlite offers (execAsync, runAsync, getAllAsync), so the Hub uses
 * its own SQLite and the tests use Node's.
 *
 * Contacts, in plain words:
 *   - Sending a contact request: I make a secret "drop code" for that
 *     player, tell the postman to accept envelopes for me with it, and send
 *     it inside the sealed request. They can then write to me.
 *   - Accepting: they get a drop code from me in the same way. From then on
 *     each side drops envelopes into the other's mailbox with the code the
 *     other gave them; the postman doesn't learn who wrote.
 *   - Blocking: I take back the code I gave them (the postman refuses their
 *     envelopes from then on). Unblocking: a new code, sent to them.
 *   - Declining a request: it's simply forgotten; they're not told.
 *
 * Message history stays only in this local database.
 *
 * Linked devices (27 Oct 2026): signing in with the same wallet on another
 * device (website, phone …) makes it part of the same account. The devices
 * keep each other up to date with sealed "sync" envelopes sent only to the
 * account's own other devices (postman: POST /self):
 *   - what I write in a 1:1 chat, and every change to a contact (request,
 *     accept, block, remove …), and groups I start or ask to join;
 *   - once, when a new device turns up and I say yes on a device that has
 *     the history: all contacts, messages, groups (with their keys), posts,
 *     polls and votes, in parts (the "history copy").
 * A new device never gets history without a yes on an existing one.
 * Messages from contacts reach every device directly (each sender seals one
 * envelope per device; device lists are refreshed from the postman).
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createIdentity, isPublicKey, secretBytes } from './identity.js';
import { sealDirect, openDirect, MID } from './direct.js';
import { cleanText, nicknameKey, nextPostAllowedAt, MIN_POST_INTERVAL, POST_WINDOW, postsPerDay, postsLeft, holdingBand, MAX_EDITS, EDIT_WINDOW } from './rules.js';
import {
  sealGroupPost, sealGroupReaction, sealGroupPoll, sealGroupPollVote, sealGroupPollClose, sealGroupEdit, sealGroupDelete, openGroupPost, acceptPosts, acceptReactions, readGroupKeyMessage, sealPinned, openPinned, groupKeyCheck, VOTE_REASON_KIND,
} from './group.js';
import { checkBadge } from './badge.js';
import { createPostmanClient } from './client.js';
import { createAlbumKey, sealAlbum, checkAlbum, albumProofText, cleanAlbum } from './album.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_me (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  devices TEXT NOT NULL,
  their_code TEXT,
  my_code TEXT,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0,
  before_block TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact INTEGER NOT NULL,
  mine INTEGER NOT NULL,
  text TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_by_contact ON chat_messages (contact, id);
CREATE TABLE IF NOT EXISTS chat_seen (id TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  key TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  code TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  pinned_text TEXT,
  pinned_at INTEGER,
  owner_account TEXT,
  joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_group_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grp TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pid TEXT,
  author TEXT NOT NULL,
  nickname TEXT,
  text TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  mine INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_group_posts_by_group ON chat_group_posts (grp, seq);
CREATE TABLE IF NOT EXISTS chat_group_last (grp TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (grp, author));
-- Times of each player's accepted posts over the last 24 h (the daily allowance, 24 Oct 2026).
CREATE TABLE IF NOT EXISTS chat_group_recent (grp TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (grp, author, at));
-- 👍 / 👎 on posts (24 Oct 2026): each player's latest reaction per post ('' = taken back).
CREATE TABLE IF NOT EXISTS chat_group_reactions (grp TEXT NOT NULL, pid TEXT NOT NULL, player TEXT NOT NULL, value TEXT NOT NULL,
  at INTEGER NOT NULL, mine INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grp, pid, player));
-- Polls (25 Oct 2026): kept for good here (and in the backup), the mailbox only 30 days.
CREATE TABLE IF NOT EXISTS chat_group_polls (grp TEXT NOT NULL, pid TEXT NOT NULL, seq INTEGER NOT NULL, creator TEXT NOT NULL,
  author TEXT NOT NULL, nickname TEXT, question TEXT NOT NULL, options TEXT NOT NULL, opened_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL, closed_at INTEGER, mine INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grp, pid));
CREATE TABLE IF NOT EXISTS chat_group_poll_votes (grp TEXT NOT NULL, poll TEXT NOT NULL, player TEXT NOT NULL, choice INTEGER,
  nickname TEXT, at INTEGER NOT NULL, mine INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grp, poll, player));
-- Removal votes' results, copied from the postman (which shows them for 7 days) to keep for good.
CREATE TABLE IF NOT EXISTS chat_vote_history (grp TEXT NOT NULL, id TEXT NOT NULL, opened_at INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (grp, id));
CREATE TABLE IF NOT EXISTS chat_group_names (grp TEXT NOT NULL, device TEXT NOT NULL, nickname TEXT NOT NULL, PRIMARY KEY (grp, device));
CREATE TABLE IF NOT EXISTS chat_group_keys (grp TEXT NOT NULL, epoch INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (grp, epoch));
-- Linked devices (27 Oct 2026): this account's OTHER devices ('new' = not offered the history yet),
-- sync envelopes waiting to go out, and parts of a history copy coming in.
CREATE TABLE IF NOT EXISTS chat_devices (key TEXT PRIMARY KEY NOT NULL, added INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, label TEXT);
CREATE TABLE IF NOT EXISTS chat_sync_out (id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_sync_in (transfer TEXT NOT NULL, part INTEGER NOT NULL, total INTEGER NOT NULL, data TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (transfer, part));
-- Collectors Albums (27 Oct 2026): my albums, each with its OWN key (secret: only this account's devices
-- have it). event = the album as last published (NULL = made, not published yet); published = when.
CREATE TABLE IF NOT EXISTS chat_albums (key TEXT PRIMARY KEY NOT NULL, secret TEXT NOT NULL, event TEXT, published INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
-- The album mailbox (28 Oct 2026): conversations with the owner of someone's album (side 'visitor') and with
-- visitors of my albums (side 'owner'); devices = the visitor's devices (to answer them).
CREATE TABLE IF NOT EXISTS chat_album_threads (album TEXT NOT NULL, side TEXT NOT NULL, thread TEXT NOT NULL, title TEXT, nickname TEXT,
  devices TEXT, blocked INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album, side, thread));
CREATE TABLE IF NOT EXISTS chat_album_talk (id INTEGER PRIMARY KEY AUTOINCREMENT, album TEXT NOT NULL, side TEXT NOT NULL, thread TEXT NOT NULL,
  mine INTEGER NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS chat_album_talk_once ON chat_album_talk (album, side, thread, mine, text, sent_at);
-- My votes on comments (28 Oct 2026), to show which button I pressed.
CREATE TABLE IF NOT EXISTS chat_comment_votes (comment INTEGER PRIMARY KEY NOT NULL, vote INTEGER NOT NULL);
`;

/** Group states on this device. */
export const GROUP_STATUS = {
  ASKING: 'asking', // asked to join; waiting for a member's Hub to hand over the key
  MEMBER: 'member',
};

/**
 * What this Hub understands in a group's mailbox. When a new version learns
 * something new (2 = reactions, 24 Oct 2026; 3 = polls), it reads its groups' mailboxes
 * once more from the start (the last 30 days), so what an older page skipped
 * isn't lost - posts it already has aren't added or counted again.
 */
const GROUP_FORMAT = 4; // 3 = polls (25 Oct 2026); 4 = edited and deleted posts (29 Oct 2026)

const GROUP_TABLES = ['chat_groups', 'chat_group_posts', 'chat_group_last', 'chat_group_recent', 'chat_group_reactions', 'chat_group_polls',
  'chat_group_poll_votes', 'chat_vote_history', 'chat_group_names', 'chat_group_keys'];
const DEVICE_TABLES = ['chat_devices', 'chat_sync_out', 'chat_sync_in'];
const ALBUM_TABLES = ['chat_albums', 'chat_album_threads', 'chat_album_talk', 'chat_comment_votes'];

/** My published albums are published again (fresh date) when older than this: the postman keeps them 60 days after that. */
export const ALBUM_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** A history copy goes in parts this long (each sealed envelope must stay under 64 KB). */
export const SYNC_PART_CHARS = 6000;
/** At most this many parts (about 2.4 MB of history). */
export const SYNC_MAX_PARTS = 400;

/** Contact states. */
export const STATUS = {
  OUTGOING: 'outgoing', // I asked; waiting for their answer
  INCOMING: 'incoming', // they asked; waiting for mine
  ACCEPTED: 'accepted',
  BLOCKED: 'blocked', // I blocked them
};

const SEEN_KEEP = 40 * 24 * 60 * 60 * 1000;

function randomCode() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

// Nicknames are compared the way the postman compares them (look-alikes count as the same).
const sameName = (a, b) => nicknameKey(a) === nicknameKey(b);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * createMessenger
 *   db:        { execAsync, runAsync, getAllAsync } (expo-sqlite style)
 *   postmanUrl: the postman's address
 *   deviceLabel: which device this is ("Chrome on Mac", "Motorola moto g(5) (Android app)"), shown
 *              in the list of linked devices on the player's other devices
 *   devicesCheckEveryMs: how often to ask the postman for the account's devices
 *   fetchFn, now: for tests
 */
export async function createMessenger({ db, postmanUrl, deviceLabel = '', devicesCheckEveryMs = 60 * 1000, fetchFn, now = () => Date.now() }) {
  await db.execAsync(SCHEMA);
  const all = (sql, params = []) => db.getAllAsync(sql, params);
  const first = async (sql, params = []) => (await all(sql, params))[0] ?? null;
  const run = (sql, params = []) => db.runAsync(sql, params);

  // Chats started with an earlier version: add the columns added since
  // (CREATE TABLE IF NOT EXISTS leaves an existing table as it was).
  const added = {
    chat_contacts: [['ended', 'INTEGER NOT NULL DEFAULT 0'], ['before_block', 'TEXT']],
    chat_groups: [['owner_account', 'TEXT'], ['paused_until', 'INTEGER NOT NULL DEFAULT 0']],
    // (28 Oct 2026: the day each of my other devices last checked its mail, from the postman)
    chat_devices: [['seen', 'INTEGER']],
    // (28 Oct 2026: when I voted - a comment edited after that has lost my vote)
    chat_comment_votes: [['at', 'INTEGER']],
    // Editing and deleting (29 Oct 2026): a message's own id (the same on both
    // sides and on all my devices), how often it was edited, deleted or not.
    chat_messages: [['mid', 'TEXT'], ['edits', 'INTEGER NOT NULL DEFAULT 0'], ['deleted', 'INTEGER NOT NULL DEFAULT 0']],
    // For group posts: the author's account (so their other devices may edit
    // too), the ids of the edits already applied (each counts once, also when
    // the mailbox is read again), deleted or not.
    chat_group_posts: [['account', 'TEXT'], ['edit_ids', 'TEXT'], ['deleted', 'INTEGER NOT NULL DEFAULT 0']],
  };
  for (const [table, cols] of Object.entries(added)) {
    const columns = new Set((await all(`PRAGMA table_info(${table})`)).map((c) => c.name));
    for (const [name, type] of cols) {
      if (!columns.has(name)) await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  // One copy of each group post (25 Oct 2026): two mail checks at the same
  // moment could both store the same post. Copies from before go, then the
  // database itself refuses a second one.
  await db.execAsync(`DELETE FROM chat_group_posts WHERE id NOT IN (SELECT MIN(id) FROM chat_group_posts GROUP BY grp, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS chat_group_posts_once ON chat_group_posts (grp, seq);`);

  // (finding a message by its own id, for edits and deletes)
  await db.execAsync('CREATE INDEX IF NOT EXISTS chat_messages_by_mid ON chat_messages (contact, mid)');

  // Every key a group ever had (older posts stay readable after a new key).
  await db.execAsync('INSERT OR IGNORE INTO chat_group_keys (grp, epoch, key) SELECT id, epoch, key FROM chat_groups WHERE key IS NOT NULL');

  async function getMe(k) {
    const r = await first('SELECT v FROM chat_me WHERE k = ?', [k]);
    return r ? JSON.parse(r.v) : null;
  }
  async function setMe(k, value) {
    if (value === null || value === undefined) await run('DELETE FROM chat_me WHERE k = ?', [k]);
    else await run('INSERT OR REPLACE INTO chat_me (k, v) VALUES (?, ?)', [k, JSON.stringify(value)]);
  }

  // This device's chat key: made once, then kept.
  let identity = await getMe('identity');
  if (!identity) {
    identity = createIdentity();
    await setMe('identity', identity);
  }
  hexToBytes(identity.secretKey); // (throws if damaged)
  let postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });

  // This account's OTHER devices (linked devices), as last told by the postman.
  let ownDevices = (await all('SELECT key FROM chat_devices')).map((r) => r.key);
  let devicesCheckedAt = 0;
  /** Was this chat key (a group post's author, say) one of mine - this device or another of my devices? */
  const isMe = (key) => key === identity.publicKey || ownDevices.includes(key);

  const contactRow = (r) => r && ({
    id: r.id,
    nickname: r.nickname,
    devices: JSON.parse(r.devices),
    status: r.status,
    unread: r.unread,
    ended: !!r.ended,
    lastAt: r.last_at,
    theirCode: r.their_code,
    myCode: r.my_code,
    beforeBlock: r.before_block,
  });
  const contactById = async (id) => contactRow(await first('SELECT * FROM chat_contacts WHERE id = ?', [id]));
  async function contactByName(nickname) {
    for (const r of await all('SELECT * FROM chat_contacts')) {
      if (sameName(r.nickname, nickname)) return contactRow(r);
    }
    return null;
  }
  async function contactByDevice(device) {
    for (const r of await all('SELECT * FROM chat_contacts')) {
      if (JSON.parse(r.devices).includes(device)) return contactRow(r);
    }
    return null;
  }

  async function account() {
    return {
      chatKey: identity.publicKey,
      account: await getMe('account'),
      nickname: await getMe('nickname'),
      verifiedUntil: (await getMe('verifiedUntil')) ?? 0,
      nfts: await getMe('nfts'),
      nextRequestAt: (await getMe('nextRequestAt')) ?? 0,
      // Joined by QR code from another device (no wallet signed in here)
      linked: !!(await getMe('linked')),
    };
  }

  /** Where this device stands: 'signed-out' | 'needs-nickname' | 'ready' (+ details). */
  async function status() {
    const a = await account();
    if (!a.account) return { state: 'signed-out', ...a };
    if (a.verifiedUntil <= now()) return { state: 'signed-out', expired: true, ...a };
    if (!a.nickname) return { state: 'needs-nickname', ...a };
    return { state: 'ready', ...a };
  }

  // --- signing in ------------------------------------------------------------

  /** Step 1: the text the wallet has to sign. → { code, text } */
  async function startSignIn() {
    const { code, text } = await postman.startSignIn();
    return { code, text };
  }

  /** Step 2: hand in the wallet's signature. */
  async function finishSignIn({ code, wallet, signature }) {
    const r = await postman.finishSignIn({ code, wallet, signature });
    await setMe('account', r.account);
    await setMe('badge', r.badge);
    await setMe('verifiedUntil', r.verifiedUntil);
    await setMe('nfts', r.nfts);
    await setMe('nickname', r.nickname ?? null);
    await setMe('linked', null);
    // My devices linked by QR code get the fresh badge too (they can't sign in with a wallet themselves).
    await shareBadges().catch(() => {});
    return status();
  }

  // --- linking a device by QR code (27 Oct 2026) -------------------------------

  /**
   * On a signed-in device: a one-time link code (valid 5 minutes) to show as
   * a QR code. → { code, shown ("4F2A-91C3-…"), qr ("devi-link:…"), expiresAt }
   */
  async function startLink() {
    const { code, expiresAt } = await postman.linkStart(await getMe('badge'));
    return { code, shown: code.toUpperCase().match(/.{1,4}/g).join('-'), qr: `devi-link:${code}`, expiresAt };
  }

  /** On the new device: hand in the code (scanned or typed) and join that chat account. → status() */
  async function finishLink(text) {
    const code = String(text || '').replace(/^devi-link:/i, '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (code.length !== 20) throw new Error("That isn't a link code from the Hub's chat.");
    const r = await postman.linkFinish(code);
    await setMe('account', r.account);
    await setMe('badge', r.badge);
    await setMe('verifiedUntil', r.verifiedUntil);
    await setMe('nfts', r.nfts);
    await setMe('nickname', r.nickname ?? null);
    await setMe('linked', true);
    devicesCheckedAt = 0;
    return status();
  }

  /** After a wallet sign-in: fresh badges for my other devices, passed on sealed. */
  async function shareBadges() {
    // (straight from the postman's list - noting new devices is left to the next mail check)
    const others = ((await postman.me()).devices || []).filter((d) => d !== identity.publicKey && isPublicKey(d));
    if (!others.length) return;
    const { badges } = await postman.badgesMine(await getMe('badge'));
    for (const b of badges || []) if (others.includes(b.device)) await queueSync({ t: 'badge', badge: b.badge }, [b.device]);
  }

  async function setNickname(nickname) {
    const r = await postman.setNickname(nickname);
    await setMe('nickname', r.nickname);
    return status();
  }

  /** Players whose nickname starts with `q` (not me). */
  async function findPlayers(q) {
    const { players } = await postman.directory(q);
    const me = await getMe('nickname');
    return players.filter((p) => !sameName(p.nickname, me));
  }

  // --- contacts ------------------------------------------------------------

  async function listContacts() {
    return (await all('SELECT * FROM chat_contacts ORDER BY last_at DESC')).map(contactRow);
  }

  async function newCode() {
    const code = randomCode();
    const r = await postman.codes({ add: [code] });
    if (r.refused) throw new Error('Please try again.');
    return code;
  }

  /** Send a contact request to a player (by nickname). */
  async function requestContact(nickname) {
    const existing = await contactByName(nickname);
    if (existing && existing.status === STATUS.INCOMING) return acceptContact(existing.id);
    if (existing && existing.status !== STATUS.OUTGOING) throw new Error(`${existing.nickname} is already in your contacts.`);
    const player = await playerAt(nickname);
    if (!player || sameName(player.nickname, await getMe('nickname'))) throw new Error('No player with this nickname.');
    const code = existing?.myCode ?? await newCode();
    const items = sealDirect({
      from: identity,
      toDevices: player.devices,
      type: 'contact-request',
      body: { nickname: await getMe('nickname'), code, devices: [identity.publicKey] },
    });
    let answer;
    try {
      answer = await postman.request(player.nickname, items);
    } catch (e) {
      if (!existing) await postman.codes({ remove: [code] }).catch(() => {});
      throw e;
    }
    await setMe('nextRequestAt', answer.nextRequestAt);
    const t = now();
    if (existing) {
      await run('UPDATE chat_contacts SET devices = ?, last_at = ? WHERE id = ?', [JSON.stringify(player.devices), t, existing.id]);
      await syncContact(existing.id);
      return existing.id;
    }
    const r = await run(
      'INSERT INTO chat_contacts (nickname, devices, my_code, status, created, last_at) VALUES (?, ?, ?, ?, ?, ?)',
      [player.nickname, JSON.stringify(player.devices), code, STATUS.OUTGOING, t, t],
    );
    await syncContact(r.lastInsertRowId);
    return r.lastInsertRowId;
  }

  /**
   * The contact's current devices, asked from the postman with the drop code
   * they gave me (they may have linked a phone since). Devices that belong to
   * another contact are never taken. Keeps the old list if the postman can't
   * be asked.
   */
  async function freshDevices(c) {
    try {
      let devices = null;
      if (c.theirCode) devices = (await postman.devicesFor(c.theirCode)).devices;
      else if (c.status === STATUS.OUTGOING) devices = (await playerAt(c.nickname))?.devices ?? null;
      if (!Array.isArray(devices)) return c;
      const theirs = await ownDevicesOnly(devices.filter(isPublicKey), c.id);
      if (theirs.length && JSON.stringify(theirs) !== JSON.stringify(c.devices)) {
        await run('UPDATE chat_contacts SET devices = ? WHERE id = ?', [JSON.stringify(theirs), c.id]);
        return { ...c, devices: theirs };
      }
    } catch {
      // (keep the list we have)
    }
    return c;
  }

  async function sendControl(contact, type, body, { mid = null } = {}) {
    const c = contact.id ? await freshDevices(contact) : contact;
    const items = sealDirect({ from: identity, toDevices: c.devices, type, body, mid });
    await postman.drop(c.theirCode, items);
  }

  /** Accept a contact request. */
  async function acceptContact(id) {
    const c = await contactById(id);
    if (!c || c.status !== STATUS.INCOMING) throw new Error('This request is no longer open.');
    const code = await newCode();
    try {
      await sendControl(c, 'contact-accept', { nickname: await getMe('nickname'), code, devices: [identity.publicKey] });
    } catch (e) {
      await postman.codes({ remove: [code] }).catch(() => {});
      if (e.status === 403) {
        await run('UPDATE chat_contacts SET ended = 1 WHERE id = ?', [id]);
        throw new Error(`${c.nickname} has left the chat or taken the request back.`);
      }
      throw e;
    }
    await run('UPDATE chat_contacts SET my_code = ?, status = ?, last_at = ?, unread = 0 WHERE id = ?', [code, STATUS.ACCEPTED, now(), id]);
    await syncContact(id);
    return id;
  }

  /** Decline a contact request: it's forgotten; they aren't told. */
  async function declineContact(id) {
    const c = await contactById(id);
    if (!c || c.status !== STATUS.INCOMING) return;
    await run('DELETE FROM chat_contacts WHERE id = ? AND status = ?', [id, STATUS.INCOMING]);
    await syncContactGone(c.nickname);
  }

  /** Block: take back my drop code, so the postman refuses their envelopes. */
  async function blockContact(id) {
    const c = await contactById(id);
    if (!c) return;
    if (c.status === STATUS.BLOCKED) return;
    if (c.myCode) await postman.codes({ remove: [c.myCode] });
    await run('UPDATE chat_contacts SET status = ?, my_code = NULL, before_block = ? WHERE id = ?', [STATUS.BLOCKED, c.status, id]);
    await syncContact(id);
  }

  /** Unblock: a new drop code, sent to them, so they can write again. */
  async function unblockContact(id) {
    const c = await contactById(id);
    if (!c || c.status !== STATUS.BLOCKED) return;
    // A blocked request goes back to being an open request (not accepted).
    if (c.beforeBlock === STATUS.INCOMING && c.theirCode) {
      await run('UPDATE chat_contacts SET status = ?, before_block = NULL WHERE id = ?', [STATUS.INCOMING, id]);
      await syncContact(id);
      return;
    }
    // Never accepted by them (or no way to reach them): simply forget it.
    if (c.beforeBlock !== STATUS.ACCEPTED || !c.theirCode) {
      await run('DELETE FROM chat_contacts WHERE id = ?', [id]);
      await syncContactGone(c.nickname);
      return;
    }
    const code = await newCode();
    await sendControl(c, 'contact-accept', { nickname: await getMe('nickname'), code, devices: [identity.publicKey] });
    await run('UPDATE chat_contacts SET my_code = ?, status = ?, before_block = NULL WHERE id = ?', [code, STATUS.ACCEPTED, id]);
    await syncContact(id);
  }

  /** Remove a contact from the list (blocks them first, so they can't write any more). */
  async function removeContact(id) {
    const c = await contactById(id);
    if (!c) return;
    if (c.myCode) await postman.codes({ remove: [c.myCode] }).catch(() => {});
    await run('DELETE FROM chat_messages WHERE contact = ?', [id]);
    await run('DELETE FROM chat_contacts WHERE id = ?', [id]);
    await syncContactGone(c.nickname);
  }

  // --- messages ------------------------------------------------------------

  /** May my message (row) still be edited? Within EDIT_WINDOW, at most MAX_EDITS times, not deleted, sent with an id. */
  const canEditRow = (m, sentAt) => !!m.mine && !!m.mid && !m.deleted && (m.edits || 0) < MAX_EDITS && now() - sentAt < EDIT_WINDOW;

  async function messages(contactId) {
    await run('UPDATE chat_contacts SET unread = 0 WHERE id = ?', [contactId]);
    return (await all('SELECT * FROM chat_messages WHERE contact = ? ORDER BY id', [contactId]))
      .map((m) => ({
        id: m.id, mine: !!m.mine, text: m.text, sentAt: m.sent_at, receivedAt: m.received_at,
        // Editing and deleting (29 Oct 2026): only my own messages that have an id
        // (sent from this version on); deleted ones show as "deleted".
        mid: m.mid ?? null, edits: m.edits || 0, edited: (m.edits || 0) > 0, deleted: !!m.deleted,
        canEdit: canEditRow(m, m.sent_at), editsLeft: Math.max(0, MAX_EDITS - (m.edits || 0)),
        canDelete: !!m.mine && !!m.mid && !m.deleted,
      }));
  }

  /** A new id for a message (16 random bytes, hex). */
  function newMid() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return bytesToHex(b);
  }

  /** The writable contact for an edit or delete (as for sending). */
  async function writableContact(contactId) {
    const c = await contactById(contactId);
    if (!c || c.status !== STATUS.ACCEPTED || !c.theirCode) throw new Error('You can change messages once they have accepted.');
    return c;
  }

  /** Sends a change to the contact; a 403 means they left or blocked me (as for sending). */
  async function sendChange(c, type, body) {
    try {
      await sendControl(c, type, body);
    } catch (e) {
      if (e.status === 403) {
        await run('UPDATE chat_contacts SET ended = 1 WHERE id = ?', [c.id]);
        throw new Error(`${c.nickname} isn't receiving your messages any more (they left the chat or blocked you).`);
      }
      throw e;
    }
  }

  /**
   * Edits one of my messages (its local id) - at most MAX_EDITS times, within
   * EDIT_WINDOW (29 Oct 2026). Free: never counts as a message.
   */
  async function editMessage(contactId, messageId, text) {
    const m = await first('SELECT * FROM chat_messages WHERE id = ? AND contact = ?', [messageId, contactId]);
    if (!m || !m.mine) throw new Error('Only your own messages can be edited.');
    if (!m.mid) throw new Error('Messages from before editing existed can\'t be edited.');
    if (m.deleted) throw new Error('This message was deleted.');
    if ((m.edits || 0) >= MAX_EDITS) throw new Error(`A message can be edited at most ${MAX_EDITS} times.`);
    if (now() - m.sent_at >= EDIT_WINDOW) throw new Error('A message can only be edited within 24 hours.');
    const clean = cleanText(text);
    if (!clean) throw new Error('Nothing to send. (To remove the message, delete it.)');
    if (clean === m.text) return;
    const c = await writableContact(contactId);
    await sendChange(c, 'msg-edit', { mid: m.mid, text: clean });
    await run('UPDATE chat_messages SET text = ?, edits = edits + 1 WHERE id = ?', [clean, m.id]);
    await queueSync({ t: 'msg-edit', peer: c.nickname, mid: m.mid, text: clean });
  }

  /** Deletes one of my messages for everyone (29 Oct 2026). Always possible; it stays as "deleted". */
  async function deleteMessage(contactId, messageId) {
    const m = await first('SELECT * FROM chat_messages WHERE id = ? AND contact = ?', [messageId, contactId]);
    if (!m || !m.mine) throw new Error('Only your own messages can be deleted.');
    if (!m.mid) throw new Error('Messages from before deleting existed can\'t be deleted.');
    if (m.deleted) return;
    const c = await contactById(contactId);
    // (a contact who left or blocked me can't be told; it goes here and on my devices anyway)
    if (c && c.status === STATUS.ACCEPTED && c.theirCode && !c.ended) await sendChange(c, 'msg-delete', { mid: m.mid }).catch(() => {});
    await run("UPDATE chat_messages SET text = '', deleted = 1 WHERE id = ?", [m.id]);
    if (c) await queueSync({ t: 'msg-delete', peer: c.nickname, mid: m.mid });
  }

  /**
   * A change to a message (edit or delete) from its author, applied here.
   * `mine` = it's one of my messages (from my other device), else the contact's.
   * `at` = when the edit was made (the author's clock), for the 24 hours.
   */
  async function applyMessageChange(contactId, { mine, mid, text = null, deleted = false, at = now() }) {
    if (!MID.test(mid || '')) return 'damaged';
    const m = await first('SELECT * FROM chat_messages WHERE contact = ? AND mine = ? AND mid = ?', [contactId, mine ? 1 : 0, mid]);
    if (!m) return 'ignored';
    if (deleted) {
      await run("UPDATE chat_messages SET text = '', deleted = 1 WHERE id = ?", [m.id]);
      return mine ? 'synced' : 'changed';
    }
    const clean = cleanText(text || '');
    // Every Hub keeps the limits itself: not after a delete, at most MAX_EDITS times, within 24 hours (+5 min for clocks).
    if (!clean || m.deleted || (m.edits || 0) >= MAX_EDITS || at - m.sent_at > EDIT_WINDOW + 5 * 60 * 1000) return 'ignored';
    await run('UPDATE chat_messages SET text = ?, edits = edits + 1 WHERE id = ?', [clean, m.id]);
    return mine ? 'synced' : 'changed';
  }

  async function sendMessage(contactId, text) {
    const c = await contactById(contactId);
    if (!c || c.status !== STATUS.ACCEPTED || !c.theirCode) throw new Error('You can write once they have accepted.');
    const clean = cleanText(text);
    if (!clean) throw new Error('Nothing to send.');
    const t = now();
    const mid = newMid();
    try {
      await sendControl(c, 'text', clean, { mid });
    } catch (e) {
      if (e.status === 403) {
        await run('UPDATE chat_contacts SET ended = 1 WHERE id = ?', [contactId]);
        throw new Error(`${c.nickname} isn't receiving your messages any more (they left the chat or blocked you).`);
      }
      throw e;
    }
    await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at, mid) VALUES (?, 1, ?, ?, ?, ?)', [contactId, clean, t, t, mid]);
    await run('UPDATE chat_contacts SET last_at = ?, ended = 0 WHERE id = ?', [t, contactId]);
    // (my other devices show it too)
    await queueSync({ t: 'msg', peer: c.nickname, text: clean, sentAt: t, mid });
  }

  // --- the mailbox -----------------------------------------------------------

  /**
   * The player with this nickname at the postman's directory, as
   * { nickname (their spelling), devices }, or null if there's none.
   * Throws if the postman can't be asked (the envelope is then kept for
   * the next try, not thrown away).
   */
  async function playerAt(nickname) {
    const players = (await postman.directory(nickname)).players;
    return players.find((p) => sameName(p.nickname, nickname)) || null;
  }

  /** `devices` without any device that belongs to another contact. */
  async function ownDevicesOnly(devices, contactId) {
    const taken = new Set();
    for (const r of await all('SELECT id, devices FROM chat_contacts WHERE id != ?', [contactId ?? -1])) {
      for (const d of JSON.parse(r.devices)) taken.add(d);
    }
    return devices.filter((d) => !taken.has(d));
  }

  // (contacts' device lists are refreshed at most once per mail collection)
  let refreshedThisRun = false;

  async function handle(opened) {
    const { from, type } = opened;
    const t = now();
    let known = await contactByDevice(from);

    if (type === 'sync') {
      // Only from one of MY other devices (as the postman lists them now).
      if (!ownDevices.includes(from)) await refreshDevices({ force: true });
      if (!ownDevices.includes(from)) return 'not my device';
      return applySync(from, opened.data || {});
    }

    // A contact writing from a device we don't know yet (e.g. they linked
    // their phone): ask the postman for my contacts' current devices once.
    if (!known && ['text', 'contact-accept', 'msg-edit', 'msg-delete'].includes(type) && !refreshedThisRun) {
      refreshedThisRun = true;
      for (const c of await listContacts()) if (c.status !== STATUS.BLOCKED) await freshDevices(c);
      known = await contactByDevice(from);
    }

    if (type === 'contact-request') {
      const { nickname, code } = opened.data || {};
      if (typeof nickname !== 'string' || !HEX64.test(code || '')) return 'damaged';
      // Who is it really? The directory says which devices belong to that
      // nickname; the sender's device must be one of them. The device list
      // is taken from the directory, never from the request.
      const player = await playerAt(nickname);
      if (!player || !player.devices.includes(from)) return 'not who they say';
      let entry = known || await contactByName(player.nickname);
      if (entry && !known && !entry.devices.some((d) => player.devices.includes(d))) {
        // Same nickname, but none of the devices we knew: a different
        // player took this nickname. Keep the old conversation apart.
        await run('UPDATE chat_contacts SET nickname = ?, ended = 1 WHERE id = ?', [`${entry.nickname} (earlier player)`, entry.id]);
        if (entry.myCode) await postman.codes({ remove: [entry.myCode] }).catch(() => {});
        entry = null;
      }
      const devices = await ownDevicesOnly(player.devices, entry?.id);
      if (!devices.includes(from)) return 'device of another contact';
      if (entry?.status === STATUS.BLOCKED) return 'blocked';
      if (entry?.status === STATUS.OUTGOING) {
        // We both asked: that's a yes on both sides.
        await run('UPDATE chat_contacts SET their_code = ?, devices = ?, nickname = ?, status = ?, last_at = ? WHERE id = ?',
          [code, JSON.stringify(devices), player.nickname, STATUS.ACCEPTED, t, entry.id]);
        return 'accepted';
      }
      if (entry?.status === STATUS.ACCEPTED) {
        // They asked again (e.g. they had removed me, or lost their
        // browser data): answer with my code again, so they can write.
        await run('UPDATE chat_contacts SET their_code = ?, devices = ?, nickname = ?, ended = 0 WHERE id = ?',
          [code, JSON.stringify(devices), player.nickname, entry.id]);
        const myCode = entry.myCode ?? await newCode();
        await run('UPDATE chat_contacts SET my_code = ? WHERE id = ?', [myCode, entry.id]);
        await sendControl({ ...entry, devices, theirCode: code }, 'contact-accept', { nickname: await getMe('nickname'), code: myCode, devices: [identity.publicKey] });
        return 'updated';
      }
      if (entry) {
        await run('UPDATE chat_contacts SET their_code = ?, devices = ?, nickname = ? WHERE id = ?', [code, JSON.stringify(devices), player.nickname, entry.id]);
        return 'updated';
      }
      await run(
        'INSERT INTO chat_contacts (nickname, devices, their_code, status, created, last_at, unread) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [player.nickname, JSON.stringify(devices), code, STATUS.INCOMING, t, t],
      );
      return 'request';
    }

    if (type === 'group-key') {
      // A member's Hub let us into a group we asked to join.
      let g;
      try { g = readGroupKeyMessage(opened.data); } catch { return 'damaged'; }
      let mine = await first('SELECT * FROM chat_groups WHERE id = ?', [g.id]);
      if (!mine) {
        // Asked to join (or let in) from another of my devices: the postman
        // knows the account is in it or asking, so this device takes the key too.
        const { groups } = await postman.groups();
        const there = groups.find((x) => x.id === g.id);
        if (!there || !(there.member || there.asking)) return 'ignored';
        await run('INSERT OR IGNORE INTO chat_groups (id, name, description, owner, status, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
          [g.id, there.name, there.description ?? '', there.owner ?? null, GROUP_STATUS.ASKING, t]);
        mine = await first('SELECT * FROM chat_groups WHERE id = ?', [g.id]);
      }
      const isNewEpoch = mine.status === GROUP_STATUS.MEMBER && mine.key && g.epoch > mine.epoch;
      if (!isNewEpoch && mine.status !== GROUP_STATUS.ASKING && mine.key) return 'ignored';
      // Only the group's real (current) key: it must match the fingerprint
      // the postman keeps for it (nobody can hand us a fake one).
      const { groups, createThreshold } = await postman.groups();
      // (A fresh list: the screen shows us as a member straight away, not after the cache runs out.)
      groupsCache = { at: now(), groups, createThreshold: createThreshold ?? null };
      const there = groups.find((x) => x.id === g.id);
      // The key AND its number must be the group's current ones.
      if (!there || g.epoch !== there.epoch || groupKeyCheck(g.id, g.key) !== there.keyCheck) return 'fake key';
      await run('INSERT OR REPLACE INTO chat_group_keys (grp, epoch, key) VALUES (?, ?, ?)', [g.id, g.epoch, g.key]);
      if (isNewEpoch) {
        await run('UPDATE chat_groups SET key = ?, epoch = ? WHERE id = ?', [g.key, g.epoch, g.id]);
        return 'new key';
      }
      await run('UPDATE chat_groups SET key = ?, epoch = ?, status = ?, code = NULL, joined_at = ? WHERE id = ?',
        [g.key, g.epoch, GROUP_STATUS.MEMBER, t, g.id]);
      // (The code we gave for this is single-use: the postman removes it when we're let in.)
      return 'joined';
    }

    if (!known) return 'unknown sender';

    if (type === 'contact-accept') {
      const { code } = opened.data || {};
      if (!HEX64.test(code || '')) return 'damaged';
      if (known.status === STATUS.BLOCKED || known.status === STATUS.INCOMING) return 'ignored';
      // Their current devices, from the directory (not from the message).
      const player = await playerAt(known.nickname);
      if (!player || !player.devices.includes(from)) return 'not who they say';
      const devices = await ownDevicesOnly(player.devices, known.id);
      await run('UPDATE chat_contacts SET their_code = ?, devices = ?, status = ?, ended = 0, last_at = ? WHERE id = ?',
        [code, JSON.stringify(devices), STATUS.ACCEPTED, t, known.id]);
      return 'accepted';
    }

    if (type === 'text') {
      if (known.status !== STATUS.ACCEPTED) return 'ignored';
      await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at, mid) VALUES (?, 0, ?, ?, ?, ?)',
        [known.id, opened.text, opened.sentAt, t, opened.mid ?? null]);
      await run('UPDATE chat_contacts SET last_at = ?, unread = unread + 1 WHERE id = ?', [t, known.id]);
      return 'message';
    }
    // The contact edited or deleted one of their messages (29 Oct 2026). Only
    // their own: the message is looked up among the ones FROM this contact.
    if (type === 'msg-edit' || type === 'msg-delete') {
      if (known.status !== STATUS.ACCEPTED) return 'ignored';
      const d = opened.data || {};
      return applyMessageChange(known.id, { mine: false, mid: d.mid, text: d.text, deleted: type === 'msg-delete', at: opened.sentAt });
    }
    return 'unknown type';
  }

  let mailRun = null;
  let leaving = false;
  /**
   * Collects what's waiting at the postman, files it, and tells the postman
   * it can delete it. → { messages, requests, accepted } (counts of new ones)
   * Only one collection runs at a time. If something goes wrong while
   * filing (e.g. the postman can't be reached for a check), that envelope
   * and the ones after it stay at the postman for the next try.
   */
  function checkMail() {
    if (leaving) return Promise.resolve({ messages: 0, requests: 0, accepted: 0 });
    if (!mailRun) mailRun = collectMail().finally(() => { mailRun = null; });
    return mailRun;
  }

  async function collectMail() {
    const counts = { messages: 0, requests: 0, accepted: 0 };
    refreshedThisRun = false;
    await refreshDevices().catch(() => {});
    const { items } = await postman.mail();
    const done = [];
    let failure = null;
    for (const item of items) {
      if (leaving) break;
      const seenId = typeof item.envelope?.id === 'string' ? item.envelope.id : null;
      if (seenId && await first('SELECT id FROM chat_seen WHERE id = ?', [seenId])) {
        done.push(item.id);
        continue;
      }
      let opened = null;
      try { opened = openDirect(item.envelope, identity); } catch { opened = null; }
      let result = 'damaged';
      if (opened) {
        try {
          result = await handle(opened);
        } catch (e) {
          failure = e;
          break;
        }
      }
      if (seenId) await run('INSERT OR IGNORE INTO chat_seen (id, at) VALUES (?, ?)', [seenId, now()]);
      done.push(item.id);
      if (result === 'message') counts.messages += 1;
      if (result === 'request') counts.requests += 1;
      if (result === 'accepted') counts.accepted += 1;
      if (result === 'joined') counts.joined = (counts.joined || 0) + 1;
      if (result === 'new key') counts.newKeys = (counts.newKeys || 0) + 1;
      if (result === 'synced' || result === 'history') counts.synced = (counts.synced || 0) + 1;
      if (result === 'history') counts.history = (counts.history || 0) + 1;
    }
    if (done.length) await postman.mailDone(done);
    await run('DELETE FROM chat_seen WHERE at < ?', [now() - SEEN_KEEP]);
    // (parts of a history copy that never completed)
    await run('DELETE FROM chat_sync_in WHERE at < ?', [now() - SEEN_KEEP]);
    // What's still waiting to go to my other devices (e.g. the rest of a history copy).
    await flushSync().catch(() => {});
    if (failure) throw failure;
    if (!leaving) await refreshAlbums().catch(() => {});
    if (!leaving && (await account()).account) {
      const talk = await collectAlbumTalk().catch(() => 0);
      if (talk) counts.albumTalk = talk;
    }
    if (!leaving && (await first('SELECT id FROM chat_groups LIMIT 1'))) await syncGroups();
    return counts;
  }

  /** Leave the chat on this device: the postman forgets it; local chat data is deleted. */
  async function leave() {
    leaving = true;
    try {
      if (mailRun) await mailRun.catch(() => {});
      // My albums go too (only if this was my last device; otherwise the others keep them).
      if (!(await refreshDevices({ force: true }).catch(() => ownDevices)).length) {
        for (const a of await all('SELECT key FROM chat_albums WHERE event IS NOT NULL')) await deleteAlbum(a.key).catch(() => {});
      }
      await postman.leave();
    } catch (e) {
      leaving = false;
      throw e;
    }
    for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES, ...DEVICE_TABLES, ...ALBUM_TABLES]) await run(`DELETE FROM ${table}`);
    ownDevices = [];
    // A new chat key for a fresh start (the old one is forgotten at the postman).
    identity = createIdentity();
    await setMe('identity', identity);
    postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });
    leaving = false;
  }

  // --- linked devices (27 Oct 2026) -------------------------------------------

  /** True if this device has something worth copying to a new one. */
  async function hasHistory() {
    return (await all('SELECT id FROM chat_contacts LIMIT 1')).length > 0 || (await all('SELECT id FROM chat_groups LIMIT 1')).length > 0;
  }

  /**
   * Asks the postman which devices belong to this account (at most once a
   * minute, `devicesCheckEveryMs`, unless `force`). Devices seen for the first time are noted: on a
   * device that has a history they're 'new' (the screen offers to copy the
   * history to them); each new one gets a short hello with this device's kind.
   */
  async function refreshDevices({ force = false } = {}) {
    if (!force && now() - devicesCheckedAt < devicesCheckEveryMs) return ownDevices;
    if (!(await getMe('account'))) return ownDevices;
    const me = await postman.me();
    devicesCheckedAt = now();
    if (!me?.signedIn) return ownDevices;
    const listed = Array.isArray(me.deviceList) ? me.deviceList : (me.devices || []).map((key) => ({ key, added: 0 }));
    const others = listed.filter((d) => d && d.key !== identity.publicKey && isPublicKey(d.key));
    const keys = new Set(others.map((d) => d.key));
    const known = new Set((await all('SELECT key FROM chat_devices')).map((r) => r.key));
    const offer = await hasHistory();
    const fresh = [];
    for (const d of others) {
      if (known.has(d.key)) {
        await run('UPDATE chat_devices SET seen = ? WHERE key = ?', [Number(d.seen) || null, d.key]);
        continue;
      }
      await run('INSERT OR IGNORE INTO chat_devices (key, added, state, seen) VALUES (?, ?, ?, ?)', [d.key, Number(d.added) || 0, offer ? 'new' : 'known', Number(d.seen) || null]);
      fresh.push(d.key);
    }
    for (const key of known) {
      if (keys.has(key)) continue;
      // (taken out of the account: forget it, and what was waiting for it)
      await run('DELETE FROM chat_devices WHERE key = ?', [key]);
      await run('DELETE FROM chat_sync_out WHERE device = ?', [key]);
    }
    ownDevices = [...keys];
    // What my other devices posted before this device knew them (e.g. from the
    // phone before linked devices existed) is mine too.
    for (const key of ownDevices) {
      await run('UPDATE chat_group_posts SET mine = 1 WHERE author = ? AND mine = 0', [key]);
      await run('UPDATE chat_group_polls SET mine = 1 WHERE author = ? AND mine = 0', [key]);
    }
    // Hello (this device's kind) to new devices - and to all of them once
    // the label itself changed (e.g. "Website" became "Chrome on Mac", 27 Oct 2026).
    if (deviceLabel && ownDevices.length) {
      const targets = (await getMe('helloLabel')) === deviceLabel ? fresh : ownDevices;
      if (targets.length) {
        await queueSync({ t: 'hello', label: deviceLabel }, targets);
        await setMe('helloLabel', deviceLabel);
      }
    }
    return ownDevices;
  }

  /**
   * Queues a sync envelope for my other devices (all of them, or `devices`)
   * and tries to send right away; what can't go now goes with the next mail
   * check. Never throws: the change itself has already happened here.
   */
  async function queueSync(body, devices = ownDevices) {
    if (!devices.length) return;
    const text = JSON.stringify(body);
    for (const d of devices) await run('INSERT INTO chat_sync_out (device, body) VALUES (?, ?)', [d, text]);
    await flushSync().catch(() => {});
  }

  const syncContact = async (id) => {
    const c = await first('SELECT * FROM chat_contacts WHERE id = ?', [id]);
    if (c) await queueSync({ t: 'contact', c });
  };
  const syncContactGone = (nickname) => queueSync({ t: 'contact', c: { nickname }, deleted: true });
  const syncGroup = async (id) => {
    const g = await first('SELECT * FROM chat_groups WHERE id = ?', [id]);
    if (g) await queueSync({ t: 'group', g, keys: await all('SELECT * FROM chat_group_keys WHERE grp = ?', [id]) });
  };

  let flushRun = null;
  /** Sends what's waiting for my other devices (one run at a time, in order). */
  function flushSync() {
    if (!flushRun) flushRun = sendQueued().finally(() => { flushRun = null; });
    return flushRun;
  }
  async function sendQueued() {
    for (;;) {
      const batch = await all('SELECT * FROM chat_sync_out ORDER BY id LIMIT 10');
      if (!batch.length) return;
      const live = batch.filter((b) => ownDevices.includes(b.device));
      for (const b of batch) if (!ownDevices.includes(b.device)) await run('DELETE FROM chat_sync_out WHERE id = ?', [b.id]);
      if (!live.length) continue;
      const items = live.flatMap((b) => sealDirect({ from: identity, toDevices: [b.device], type: 'sync', body: JSON.parse(b.body) }));
      await postman.self(items);
      for (const b of live) await run('DELETE FROM chat_sync_out WHERE id = ?', [b.id]);
    }
  }

  /** What a new device gets: everything but this device's own key and sign-in. */
  async function historyData() {
    const contacts = await all('SELECT * FROM chat_contacts ORDER BY id');
    const nameOf = new Map(contacts.map((c) => [c.id, c.nickname]));
    return {
      kind: 'history',
      version: 1,
      contacts,
      // (by the contact's nickname: the other device numbers its contacts itself)
      messages: (await all('SELECT * FROM chat_messages ORDER BY id'))
        .filter((m) => nameOf.has(m.contact))
        .map((m) => ({ peer: nameOf.get(m.contact), mine: m.mine, text: m.text, sent_at: m.sent_at, received_at: m.received_at,
          mid: m.mid ?? null, edits: m.edits || 0, deleted: m.deleted || 0 })),
      groups: await all('SELECT * FROM chat_groups'),
      groupKeys: await all('SELECT * FROM chat_group_keys'),
      groupPosts: await all('SELECT * FROM chat_group_posts ORDER BY id'),
      groupReactions: await all('SELECT * FROM chat_group_reactions'),
      groupPolls: await all('SELECT * FROM chat_group_polls'),
      groupPollVotes: await all('SELECT * FROM chat_group_poll_votes'),
      voteHistory: await all('SELECT * FROM chat_vote_history'),
      groupLast: await all('SELECT * FROM chat_group_last'),
      groupNames: await all('SELECT * FROM chat_group_names'),
      albums: await all('SELECT * FROM chat_albums'),
    };
  }

  /**
   * Copies all contacts and history to one of my other devices (after the
   * player said yes on this one). Sent in parts; what doesn't go now goes
   * with the next mail checks. → { parts }
   */
  async function copyHistoryTo(key) {
    await refreshDevices({ force: true });
    if (!ownDevices.includes(key)) throw new Error('That device is no longer linked to your chat.');
    const text = JSON.stringify(await historyData());
    const total = Math.max(1, Math.ceil(text.length / SYNC_PART_CHARS));
    if (total > SYNC_MAX_PARTS) throw new Error('Your chat history is too big to copy in one go.');
    const transfer = randomCode().slice(0, 16);
    for (let part = 0; part < total; part += 1) {
      const data = text.slice(part * SYNC_PART_CHARS, (part + 1) * SYNC_PART_CHARS);
      await run('INSERT INTO chat_sync_out (device, body) VALUES (?, ?)', [key, JSON.stringify({ t: 'history', transfer, part, total, data })]);
    }
    await run("UPDATE chat_devices SET state = 'known' WHERE key = ?", [key]);
    await tellDeviceAnswered(key);
    await flushSync().catch(() => {});
    return { parts: total };
  }

  /** "Not now": the new device isn't offered the history again. */
  async function dismissNewDevice(key) {
    await run("UPDATE chat_devices SET state = 'known' WHERE key = ?", [key]);
    await tellDeviceAnswered(key);
  }

  /** My other devices stop asking about this new device too (28 Oct 2026: the question came back on each one). */
  async function tellDeviceAnswered(key) {
    const others = ownDevices.filter((d) => d !== key);
    if (others.length) await queueSync({ t: 'device-known', key }, others);
  }

  /** Takes one of my other devices out of the account (e.g. a lost phone, or "that's not mine"). */
  async function removeDevice(key) {
    await postman.removeDevice(key);
    await run('DELETE FROM chat_devices WHERE key = ?', [key]);
    await run('DELETE FROM chat_sync_out WHERE device = ?', [key]);
    ownDevices = ownDevices.filter((d) => d !== key);
  }

  /**
   * This device and my other ones: { thisDevice, label, others: [{ key, added,
   * label, isNew }], copying: { received, total } | null (a history copy coming in) }
   */
  async function linkedDevices() {
    await refreshDevices().catch(() => {});
    const others = (await all('SELECT * FROM chat_devices ORDER BY added, key'))
      .map((r) => ({ key: r.key, added: r.added, seen: r.seen || null, label: r.label || null, isNew: r.state === 'new' }));
    const incoming = await first('SELECT total, COUNT(*) AS n FROM chat_sync_in GROUP BY transfer ORDER BY MIN(at) LIMIT 1');
    return { thisDevice: identity.publicKey, label: deviceLabel || null, others, copying: incoming ? { received: incoming.n, total: incoming.total } : null };
  }

  const HEX32 = /^[0-9a-f]{32}$/;
  const arr = (x) => (Array.isArray(x) ? x : []);
  const codeOrNull = (c) => (HEX64.test(c || '') ? c : null);

  /** One contact from another of my devices. `overwrite`: a live change (else only what's missing here is filled in). */
  async function mergeContact(c, { overwrite = true } = {}) {
    if (!c || typeof c.nickname !== 'string' || !c.nickname || !Object.values(STATUS).includes(c.status)) return null;
    let devices = [];
    try { devices = arr(typeof c.devices === 'string' ? JSON.parse(c.devices) : c.devices).filter(isPublicKey); } catch { devices = []; }
    const local = await contactByName(c.nickname);
    if (local && !overwrite) {
      await run('UPDATE chat_contacts SET their_code = COALESCE(their_code, ?), my_code = COALESCE(my_code, ?) WHERE id = ?',
        [codeOrNull(c.their_code), codeOrNull(c.my_code), local.id]);
      return local.id;
    }
    if (local) {
      await run('UPDATE chat_contacts SET devices = ?, their_code = ?, my_code = ?, status = ?, ended = ?, before_block = ?, last_at = MAX(last_at, ?) WHERE id = ?',
        [JSON.stringify(devices), codeOrNull(c.their_code), codeOrNull(c.my_code), c.status, c.ended ? 1 : 0,
          Object.values(STATUS).includes(c.before_block) ? c.before_block : null, Number(c.last_at) || 0, local.id]);
      return local.id;
    }
    const r = await run(
      `INSERT INTO chat_contacts (nickname, devices, their_code, my_code, status, created, last_at, unread, ended, before_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [c.nickname, JSON.stringify(devices), codeOrNull(c.their_code), codeOrNull(c.my_code), c.status, Number(c.created) || now(),
        Number(c.last_at) || now(), c.ended ? 1 : 0, Object.values(STATUS).includes(c.before_block) ? c.before_block : null],
    );
    return r.lastInsertRowId;
  }

  /** A 1:1 message, unless it's here already. */
  async function mergeMessage(contactId, { mine, text, sentAt, receivedAt, mid = null, edits = 0, deleted = false }) {
    const id = MID.test(mid || '') ? mid : null;
    const isDeleted = !!deleted && !!id;
    const clean = isDeleted ? '' : typeof text === 'string' ? cleanText(text) : '';
    if ((!clean && !isDeleted) || !Number.isFinite(sentAt)) return false;
    const editCount = Math.min(MAX_EDITS, Math.max(0, Number(edits) || 0));
    if (id) {
      // (with an id: the same message, even if it was edited or deleted since)
      const here = await first('SELECT * FROM chat_messages WHERE contact = ? AND mine = ? AND mid = ?', [contactId, mine ? 1 : 0, id]);
      if (here) {
        // The other copy knows more (edited more often, or deleted): take that.
        if (isDeleted && !here.deleted) await run("UPDATE chat_messages SET text = '', deleted = 1 WHERE id = ?", [here.id]);
        else if (!isDeleted && !here.deleted && editCount > (here.edits || 0)) await run('UPDATE chat_messages SET text = ?, edits = ? WHERE id = ?', [clean, editCount, here.id]);
        return false;
      }
    } else if (await first('SELECT id FROM chat_messages WHERE contact = ? AND mine = ? AND text = ? AND sent_at = ?', [contactId, mine ? 1 : 0, clean, sentAt])) {
      return false;
    }
    await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at, mid, edits, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [contactId, mine ? 1 : 0, clean, sentAt, Number.isFinite(receivedAt) ? receivedAt : now(), id, editCount, isDeleted ? 1 : 0]);
    return true;
  }

  /** Groups (with their keys) from another of my devices: added if missing; a key fills in a group waiting for one. */
  async function mergeGroups(groups, keys) {
    for (const g of arr(groups)) {
      if (!HEX32.test(g?.id || '') || !Object.values(GROUP_STATUS).includes(g.status)) continue;
      const key = HEX64.test(g.key || '') ? g.key : null;
      const local = await first('SELECT * FROM chat_groups WHERE id = ?', [g.id]);
      if (!local) {
        await run(
          `INSERT INTO chat_groups (id, name, description, owner, is_owner, status, key, epoch, code, last_seq, unread, pinned_text, pinned_at, joined_at, owner_account)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          [g.id, String(g.name ?? ''), String(g.description ?? ''), g.owner ?? null, g.is_owner ? 1 : 0, key ? g.status : GROUP_STATUS.ASKING, key,
            Number(g.epoch) || 1, codeOrNull(g.code), key ? Number(g.last_seq) || 0 : 0, g.pinned_text ?? null, g.pinned_at ?? null, Number(g.joined_at) || now(), g.owner_account ?? null],
        );
      } else if (key && g.status === GROUP_STATUS.MEMBER && (!local.key || (Number(g.epoch) || 1) > local.epoch)) {
        await run('UPDATE chat_groups SET key = ?, epoch = ?, status = ?, code = NULL WHERE id = ?', [key, Number(g.epoch) || 1, GROUP_STATUS.MEMBER, g.id]);
      }
    }
    for (const k of arr(keys)) {
      if (!HEX32.test(k?.grp || '') || !HEX64.test(k.key || '')) continue;
      await run('INSERT OR IGNORE INTO chat_group_keys (grp, epoch, key) VALUES (?, ?, ?)', [k.grp, Number(k.epoch) || 1, k.key]);
    }
  }

  /** A history copy from another of my devices, merged with what's here (nothing here is lost). */
  async function mergeHistory(data) {
    const idOf = new Map();
    for (const c of arr(data.contacts)) {
      const id = await mergeContact(c, { overwrite: false });
      if (id) idOf.set(nicknameKey(c.nickname), id);
    }
    for (const m of arr(data.messages)) {
      const id = typeof m?.peer === 'string' ? idOf.get(nicknameKey(m.peer)) : null;
      if (id) {
        await mergeMessage(id, { mine: !!m.mine, text: m.text, sentAt: Number(m.sent_at), receivedAt: Number(m.received_at), mid: m.mid, edits: m.edits, deleted: !!m.deleted });
      }
    }
    for (const c of await all('SELECT id FROM chat_contacts')) {
      const last = await first('SELECT MAX(received_at) AS t FROM chat_messages WHERE contact = ?', [c.id]);
      if (last?.t) await run('UPDATE chat_contacts SET last_at = MAX(last_at, ?) WHERE id = ?', [last.t, c.id]);
    }
    await mergeGroups(data.groups, data.groupKeys);
    const groupOk = (x) => HEX32.test(x?.grp || '');
    for (const p of arr(data.groupPosts)) {
      if (!groupOk(p) || typeof p.text !== 'string') continue;
      const editIds = typeof p.edit_ids === 'string' ? p.edit_ids : null;
      const r = await run(
        'INSERT OR IGNORE INTO chat_group_posts (grp, seq, pid, author, nickname, text, written_at, received_at, mine, account, edit_ids, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [p.grp, Number(p.seq) || 0, typeof p.pid === 'string' ? p.pid : null, String(p.author ?? ''), p.nickname ?? null, p.deleted ? '' : p.text,
          Number(p.written_at) || 0, Number(p.received_at) || 0, p.mine || isMe(p.author) ? 1 : 0, p.account ?? null, editIds, p.deleted ? 1 : 0]);
      if (!r?.changes) {
        // Already here: the other copy may know more (edited more often, or deleted).
        const here = await first('SELECT * FROM chat_group_posts WHERE grp = ? AND seq = ?', [p.grp, Number(p.seq) || 0]);
        if (here && p.deleted && !here.deleted) await run("UPDATE chat_group_posts SET text = '', deleted = 1 WHERE id = ?", [here.id]);
        else if (here && !p.deleted && !here.deleted && editCount(p) > editCount(here)) {
          await run('UPDATE chat_group_posts SET text = ?, edit_ids = ? WHERE id = ?', [p.text, editIds, here.id]);
        }
      }
    }
    for (const p of arr(data.groupPolls)) {
      if (!groupOk(p) || typeof p.pid !== 'string' || typeof p.question !== 'string' || typeof p.options !== 'string') continue;
      await run(
        `INSERT OR IGNORE INTO chat_group_polls (grp, pid, seq, creator, author, nickname, question, options, opened_at, ends_at, closed_at, mine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.grp, p.pid, Number(p.seq) || 0, String(p.creator ?? ''), String(p.author ?? ''), p.nickname ?? null, p.question, p.options,
          Number(p.opened_at) || 0, Number(p.ends_at) || 0, p.closed_at == null ? null : Number(p.closed_at), p.mine || isMe(p.author) ? 1 : 0],
      );
    }
    for (const v of arr(data.groupPollVotes)) {
      if (!groupOk(v) || typeof v.poll !== 'string' || typeof v.player !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_group_poll_votes (grp, poll, player, choice, nickname, at, mine) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.grp, v.poll, v.player, v.choice == null ? null : Number(v.choice), v.nickname ?? null, Number(v.at) || 0, v.mine ? 1 : 0]);
    }
    for (const r of arr(data.groupReactions)) {
      if (!groupOk(r) || typeof r.pid !== 'string' || typeof r.player !== 'string' || typeof r.value !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_group_reactions (grp, pid, player, value, at, mine) VALUES (?, ?, ?, ?, ?, ?)',
        [r.grp, r.pid, r.player, r.value, Number(r.at) || 0, r.mine ? 1 : 0]);
    }
    for (const h of arr(data.voteHistory)) {
      if (!groupOk(h) || typeof h.id !== 'string' || typeof h.data !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_vote_history (grp, id, opened_at, data) VALUES (?, ?, ?, ?)', [h.grp, h.id, Number(h.opened_at) || 0, h.data]);
    }
    for (const l of arr(data.groupLast)) {
      if (!groupOk(l) || typeof l.author !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_group_last (grp, author, at) VALUES (?, ?, ?)', [l.grp, l.author, Number(l.at) || 0]);
    }
    for (const n of arr(data.groupNames)) {
      if (!groupOk(n) || typeof n.device !== 'string' || typeof n.nickname !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_group_names (grp, device, nickname) VALUES (?, ?, ?)', [n.grp, n.device, n.nickname]);
    }
    for (const a of arr(data.albums)) await mergeAlbum(a);
  }

  /** One of my albums from another of my devices (its key and its latest version). */
  async function mergeAlbum(a) {
    if (!isPublicKey(a?.key) || !HEX64.test(a.secret || '')) return false;
    try { secretBytes({ publicKey: a.key, secretKey: a.secret }); } catch { return false; } // (the secret must belong to the key)
    let event = null;
    if (typeof a.event === 'string') {
      try {
        const e = JSON.parse(a.event);
        if (checkAlbum(e).ok && e.pubkey === a.key) event = a.event;
      } catch { event = null; }
    }
    const local = await first('SELECT * FROM chat_albums WHERE key = ?', [a.key]);
    if (!local) {
      await run('INSERT INTO chat_albums (key, secret, event, published, created) VALUES (?, ?, ?, ?, ?)',
        [a.key, a.secret, event, event ? Number(a.published) || 0 : 0, Number(a.created) || now()]);
    } else if (event && (Number(a.published) || 0) > local.published) {
      await run('UPDATE chat_albums SET event = ?, published = ? WHERE key = ?', [event, Number(a.published) || 0, a.key]);
    }
    return true;
  }

  /** A sync envelope from another of my devices. */
  async function applySync(from, d) {
    if (d.t === 'badge') {
      // A fresh badge from my wallet sign-in on another device: only if it's
      // genuine, for this device, and newer than the one here.
      const check = checkBadge(d.badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() });
      if (!check.ok || check.account !== (await getMe('account'))) return 'ignored';
      if (check.until <= ((await getMe('verifiedUntil')) ?? 0)) return 'ignored';
      await setMe('badge', d.badge);
      await setMe('verifiedUntil', check.until);
      await setMe('nfts', check.nfts);
      return 'synced';
    }
    if (d.t === 'device-known') {
      // (another of my devices answered the "new device" question: copied, or not now)
      if (typeof d.key === 'string') await run("UPDATE chat_devices SET state = 'known' WHERE key = ?", [d.key]);
      return 'synced';
    }
    if (d.t === 'hello') {
      if (typeof d.label === 'string') await run('UPDATE chat_devices SET label = ? WHERE key = ?', [cleanText(d.label).slice(0, 40), from]);
      return 'synced';
    }
    if (d.t === 'history') {
      const ok = typeof d.transfer === 'string' && d.transfer.length <= 64 && Number.isInteger(d.part) && Number.isInteger(d.total)
        && d.total >= 1 && d.total <= SYNC_MAX_PARTS && d.part >= 0 && d.part < d.total && typeof d.data === 'string';
      if (!ok) return 'damaged';
      await run('INSERT OR IGNORE INTO chat_sync_in (transfer, part, total, data, at) VALUES (?, ?, ?, ?, ?)', [d.transfer, d.part, d.total, d.data, now()]);
      const parts = await all('SELECT data FROM chat_sync_in WHERE transfer = ? ORDER BY part', [d.transfer]);
      if (parts.length < d.total) return 'synced';
      await run('DELETE FROM chat_sync_in WHERE transfer = ?', [d.transfer]);
      let data = null;
      try { data = JSON.parse(parts.map((x) => x.data).join('')); } catch { data = null; }
      if (!data || data.kind !== 'history') return 'damaged';
      await mergeHistory(data);
      return 'history';
    }
    if (d.t === 'msg-edit' || d.t === 'msg-delete') {
      // (I edited or deleted one of my messages on another of my devices)
      const c = typeof d.peer === 'string' ? await contactByName(d.peer) : null;
      if (!c) return 'ignored';
      await applyMessageChange(c.id, { mine: true, mid: d.mid, text: d.text, deleted: d.t === 'msg-delete' });
      return 'synced';
    }
    if (d.t === 'msg') {
      const c = typeof d.peer === 'string' ? await contactByName(d.peer) : null;
      if (!c) return 'ignored';
      if (await mergeMessage(c.id, { mine: true, text: d.text, sentAt: Number(d.sentAt), receivedAt: Number(d.sentAt), mid: d.mid })) {
        await run('UPDATE chat_contacts SET last_at = MAX(last_at, ?), ended = 0 WHERE id = ?', [Number(d.sentAt), c.id]);
      }
      return 'synced';
    }
    if (d.t === 'contact') {
      if (d.deleted) {
        const local = typeof d.c?.nickname === 'string' ? await contactByName(d.c.nickname) : null;
        if (local) {
          await run('DELETE FROM chat_messages WHERE contact = ?', [local.id]);
          await run('DELETE FROM chat_contacts WHERE id = ?', [local.id]);
        }
        return 'synced';
      }
      await mergeContact(d.c, { overwrite: true });
      return 'synced';
    }
    if (d.t === 'album') {
      if (d.deleted) {
        if (isPublicKey(d.key)) await run('DELETE FROM chat_albums WHERE key = ?', [d.key]);
        return 'synced';
      }
      return (await mergeAlbum(d.a)) ? 'synced' : 'damaged';
    }
    if (d.t === 'group') {
      await mergeGroups([d.g], d.keys);
      groupsCache = null;
      return 'synced';
    }
    return 'unknown type';
  }

  // --- groups ---------------------------------------------------------------

  async function postmanKey() {
    let key = await getMe('postmanKey');
    if (!key) {
      key = (await postman.hello()).postman;
      await setMe('postmanKey', key);
    }
    return key;
  }

  // Pinned messages are kept locally as a JSON list (older: one plain text).
  function readPins(stored) {
    if (!stored) return null;
    try {
      const list = JSON.parse(stored);
      if (Array.isArray(list)) return list.length ? { pins: list } : null;
    } catch {
      // plain text
    }
    return { pins: [stored] };
  }

  const groupRow = (r) => r && ({
    id: r.id,
    name: r.name,
    description: r.description,
    owner: r.owner,
    isOwner: !!r.is_owner,
    status: r.status,
    unread: r.unread,
    pinned: readPins(r.pinned_text),
    hasKey: !!r.key,
    pausedUntil: r.paused_until > now() ? r.paused_until : 0,
  });

  /**
   * All open groups at the postman, with this device's own state merged in
   * (member / asking, unread). → [{ id, name, description, owner, members,
   * member, asking, isOwner, unread, pinned }]
   */
  let groupsCache = null;
  async function listGroups({ maxAgeMs = 0 } = {}) {
    if (!groupsCache || maxAgeMs <= 0 || now() - groupsCache.at > maxAgeMs) {
      const r = await postman.groups();
      groupsCache = { at: now(), groups: r.groups, createThreshold: r.createThreshold ?? null };
    }
    const { groups } = groupsCache;
    const local = new Map((await all('SELECT * FROM chat_groups')).map((r) => [r.id, groupRow(r)]));
    // Groups that are gone (or that we're no longer in) are forgotten here too.
    for (const [id, g] of local) {
      const there = groups.find((x) => x.id === id);
      if (!there || (!there.member && !there.asking && g.status === GROUP_STATUS.MEMBER && maxAgeMs === 0)) await forgetGroup(id);
    }
    return groups.map((g) => {
      const mine = local.get(g.id);
      const hasKey = !!mine?.hasKey;
      const asking = g.asking || mine?.status === GROUP_STATUS.ASKING;
      return {
        ...g,
        unread: mine?.unread ?? 0,
        pinned: mine?.pinned ?? null,
        hasKey,
        member: g.member && hasKey,
        asking,
        pausedUntil: mine?.pausedUntil ?? 0,
        // In the group, but this browser has no key (e.g. a new browser): "Get the key" asks again.
        needsKey: g.member && !hasKey && !asking,
      };
    });
  }

  /**
   * May this device start a group? Starting one takes the voting threshold
   * (24 Oct 2026), counted by the last sign-in (the badge).
   * → { threshold, nfts, allowed }   (threshold null = not known yet)
   */
  async function groupCreateInfo() {
    const threshold = groupsCache?.createThreshold ?? null;
    const badge = await getMe('badge');
    const check = badge ? checkBadge(badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() }) : { ok: false };
    const nfts = check.ok ? check.nfts : 0;
    // (badges carry bands: the threshold is compared by its band, as the postman does)
    return { threshold, nfts, allowed: threshold === null || nfts >= holdingBand(threshold) };
  }

  async function forgetGroup(id) {
    for (const table of ['chat_group_posts', 'chat_group_last', 'chat_group_recent', 'chat_group_reactions', 'chat_group_polls', 'chat_group_poll_votes',
      'chat_vote_history', 'chat_group_names']) await run(`DELETE FROM ${table} WHERE grp = ?`, [id]);
    await run('DELETE FROM chat_groups WHERE id = ?', [id]);
  }

  async function myGroup(id) {
    const g = await first('SELECT * FROM chat_groups WHERE id = ?', [id]);
    if (!g || g.status !== GROUP_STATUS.MEMBER || !g.key) throw new Error("You're not in this group (yet).");
    return g;
  }

  /** Starts a new open group; this device holds its first key. */
  async function createGroup(name, description = '') {
    const id = randomCode().slice(0, 32);
    const key = randomCode();
    // (The postman checks the holdings in this device's badge: starting a group takes the voting threshold.)
    const { name: saved } = await postman.createGroup({ id, name, description, keyCheck: groupKeyCheck(id, key), badge: await getMe('badge') });
    groupsCache = null;
    await run('INSERT INTO chat_groups (id, name, description, owner, is_owner, status, key, epoch, joined_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?)',
      [id, saved, description, await getMe('nickname'), GROUP_STATUS.MEMBER, key, now()]);
    await run('INSERT OR REPLACE INTO chat_group_keys (grp, epoch, key) VALUES (?, 1, ?)', [id, key]);
    await syncGroup(id);
    return id;
  }

  /** Asks to join: the first member's Hub that's open lets us in (hands over the key). */
  async function joinGroup(id, { force = false } = {}) {
    const existing = await first('SELECT * FROM chat_groups WHERE id = ?', [id]);
    if (existing?.status === GROUP_STATUS.MEMBER && existing.key && !force) return 'member';
    const code = existing?.code ?? await newCode();
    await postman.joinGroup(id, code);
    groupsCache = null;
    const { groups } = await postman.groups();
    const g = groups.find((x) => x.id === id) || { name: 'Group', description: '' };
    await run(
      `INSERT INTO chat_groups (id, name, description, owner, status, code, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, code = excluded.code`,
      [id, g.name, g.description ?? '', g.owner ?? null, GROUP_STATUS.ASKING, code, now()],
    );
    await syncGroup(id);
    return 'asking';
  }

  async function leaveGroup(id) {
    await postman.leaveGroup(id);
    groupsCache = null;
    const g = await first('SELECT code FROM chat_groups WHERE id = ?', [id]);
    if (g?.code) await postman.codes({ remove: [g.code] }).catch(() => {});
    await forgetGroup(id);
  }

  /** Lets in whoever is waiting to join a group we're in: hands them the key, sealed. */
  async function admitWaiting(g) {
    const { joins } = await postman.groupJoins(g.id);
    for (const j of joins) {
      if (!j.devices.length) continue;
      const items = sealDirect({
        from: identity,
        toDevices: j.devices,
        type: 'group-key',
        body: { group: g.id, epoch: g.epoch, key: g.key },
      });
      try {
        await postman.drop(j.code, items);
      } catch {
        continue; // they took the request back, or their mailbox is full: try another time
      }
      await postman.admit(g.id, j.account);
    }
  }

  /**
   * Who wrote it: a nickname for an author's chat key in this group. The
   * member list is asked for at most once per collection (`run` = { asked }).
   */
  async function authorName(grp, device, runState) {
    const known = await first('SELECT nickname FROM chat_group_names WHERE grp = ? AND device = ?', [grp, device]);
    if (known) return known.nickname;
    if (runState.asked) return null;
    runState.asked = true;
    const { members } = await postman.groupMembers(grp);
    for (const m of members) {
      if (typeof m.nickname !== 'string' || !m.nickname) continue;
      for (const d of m.devices) await run('INSERT OR REPLACE INTO chat_group_names (grp, device, nickname) VALUES (?, ?, ?)', [grp, d, m.nickname]);
    }
    return members.find((m) => m.devices.includes(device))?.nickname ?? null;
  }

  async function keysOf(grp) {
    const keys = {};
    for (const r of await all('SELECT epoch, key FROM chat_group_keys WHERE grp = ?', [grp])) keys[r.epoch] = r.key;
    return keys;
  }

  /** { [player]: [times of accepted posts] } for a group - the daily allowance's memory. */
  async function recentPosts(grp) {
    const out = {};
    for (const r of await all('SELECT author, at FROM chat_group_recent WHERE grp = ? ORDER BY at', [grp])) (out[r.author] ||= []).push(r.at);
    // Players known only from before the allowance (24 Oct 2026): their last post.
    for (const r of await all('SELECT author, at FROM chat_group_last WHERE grp = ?', [grp])) if (!out[r.author]) out[r.author] = [r.at];
    return out;
  }

  /** Collects a group's new posts, applies the posting limits, files them. → number of new posts from others */
  async function collectGroup(g) {
    const pk = await postmanKey();
    const blockedDevices = [];
    for (const c of await listContacts()) if (c.status === STATUS.BLOCKED) blockedDevices.push(...c.devices);
    let total = 0;
    const runState = { asked: false };
    const seen = new Set((await all('SELECT pid FROM chat_group_posts WHERE grp = ? AND pid IS NOT NULL', [g.id])).map((r) => r.pid));
    const keys = await keysOf(g.id);
    for (;;) {
      let added = 0;
      const { posts } = await postman.groupPosts(g.id, g.last_seq);
      if (!posts.length) break;
      const items = [];
      for (const p of posts) {
        let post = null;
        try { post = openGroupPost(p.envelope, { groupId: g.id, keys }); } catch { post = null; }
        if (post) items.push({ post, receivedAt: p.receivedAt, seq: p.seq });
      }
      // 👍 / 👎: free, each player's latest one per post counts.
      const myAccount = await getMe('account');
      for (const { item, player } of acceptReactions(items, { postmanPublicKey: pk, seen })) {
        const r = item.post;
        const mine = isMe(r.from) || (myAccount && player === myAccount) ? 1 : 0;
        await run(
          `INSERT INTO chat_group_reactions (grp, pid, player, value, at, mine) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (grp, pid, player) DO UPDATE SET value = excluded.value, at = excluded.at WHERE excluded.at >= chat_group_reactions.at`,
          [g.id, r.target, player, r.value, r.writtenAt, mine],
        );
      }
      // Posts this Hub already has (when reading a mailbox again): not again.
      const have = new Map((await all('SELECT seq, pid FROM chat_group_posts WHERE grp = ?', [g.id])).map((r) => [r.seq, r.pid]));
      for (const r of await all('SELECT seq, pid FROM chat_group_polls WHERE grp = ?', [g.id])) have.set(r.seq, r.pid);
      for (const item of items) {
        if (item.post.kind === 'post' && have.has(item.seq) && !have.get(item.seq) && item.post.id) {
          // (posts from a backup made before 24 Oct 2026 had no id yet)
          await run('UPDATE chat_group_posts SET pid = ? WHERE grp = ? AND seq = ?', [item.post.id, g.id, item.seq]);
          seen.add(item.post.id);
        }
      }
      const newItems = items.filter((i) => !have.has(i.seq));
      const lastAccepted = await recentPosts(g.id);
      const { shown } = acceptPosts(newItems, { postmanPublicKey: pk, lastAccepted, blocked: blockedDevices, seen, owners: g.owner_account ? [g.owner_account] : [] });
      for (const [author, times] of Object.entries(lastAccepted)) {
        if (!times.length) continue;
        await run('INSERT OR REPLACE INTO chat_group_last (grp, author, at) VALUES (?, ?, ?)', [g.id, author, Math.max(...times)]);
        for (const at of times) await run('INSERT OR IGNORE INTO chat_group_recent (grp, author, at) VALUES (?, ?, ?)', [g.id, author, at]);
      }
      // (Older than two days can't count any more.)
      await run('DELETE FROM chat_group_recent WHERE grp = ? AND at < ?', [g.id, now() - 2 * POST_WINDOW]);
      for (const item of shown) {
        const mine = isMe(item.post.from);
        if (item.post.kind === 'poll') {
          const p = item.post;
          const badge = checkBadge(p.badge, { postmanPublicKey: pk, holder: p.from, at: item.receivedAt });
          const r = await run(
            `INSERT OR IGNORE INTO chat_group_polls (grp, pid, seq, creator, author, nickname, question, options, opened_at, ends_at, mine)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [g.id, p.id, item.seq, badge.account ?? p.from, p.from, await authorName(g.id, p.from, runState), p.question,
              JSON.stringify(p.options), item.receivedAt, item.receivedAt + p.durationMs, mine ? 1 : 0],
          );
          if (!mine && r?.changes) added += 1;
          continue;
        }
        // (the author's account, from the badge: their other devices may edit or delete it too)
        const account = checkBadge(item.post.badge, { postmanPublicKey: pk, holder: item.post.from, at: item.receivedAt }).account ?? null;
        const r = await run(
          'INSERT OR IGNORE INTO chat_group_posts (grp, seq, pid, author, nickname, text, written_at, received_at, mine, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [g.id, item.seq, item.post.id ?? null, item.post.from, await authorName(g.id, item.post.from, runState), item.post.text, item.post.writtenAt, item.receivedAt, mine ? 1 : 0, account],
        );
        if (!mine && r?.changes) added += 1;
      }
      // Edits and deletes (29 Oct 2026): free; only from the post's author.
      for (const { item, player } of acceptReactions(items, { postmanPublicKey: pk, seen, kinds: ['edit', 'delete'] })) {
        await applyPostChange(g.id, item, player);
      }
      // Poll answers and "closed" (free; in the order the postman got them, after the polls above).
      for (const { item, player } of acceptReactions(items, { postmanPublicKey: pk, seen, kinds: ['poll-vote', 'poll-close'] })) {
        const x = item.post;
        const poll = await first('SELECT * FROM chat_group_polls WHERE grp = ? AND pid = ?', [g.id, x.target]);
        if (!poll || item.receivedAt < poll.opened_at) continue;
        const end = Math.min(poll.ends_at, poll.closed_at ?? Infinity);
        if (item.receivedAt >= end) continue; // too late
        if (x.kind === 'poll-close') {
          if (player === poll.creator) await run('UPDATE chat_group_polls SET closed_at = ? WHERE grp = ? AND pid = ?', [item.receivedAt, g.id, poll.pid]);
          continue;
        }
        if (x.option !== null && x.option >= JSON.parse(poll.options).length) continue;
        const mine = isMe(x.from) || (myAccount && player === myAccount) ? 1 : 0;
        await run(
          `INSERT INTO chat_group_poll_votes (grp, poll, player, choice, nickname, at, mine) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (grp, poll, player) DO UPDATE SET choice = excluded.choice, nickname = excluded.nickname, at = excluded.at
           WHERE excluded.at >= chat_group_poll_votes.at`,
          [g.id, poll.pid, player, x.option, await authorName(g.id, x.from, runState), item.receivedAt, mine],
        );
      }
      g.last_seq = posts[posts.length - 1].seq;
      await run('UPDATE chat_groups SET last_seq = ?, unread = unread + ? WHERE id = ?', [g.last_seq, added, g.id]);
      total += added;
      if (posts.length < 200) break;
    }
    return total;
  }

  /**
   * An edit or delete of a group post, checked and applied (29 Oct 2026):
   *   - only by the author: the same device, or the same player (account,
   *     from the badge) on another device;
   *   - an edit: not after a delete, at most MAX_EDITS times, within
   *     EDIT_WINDOW of the post (both times from the postman);
   *   - each edit counts once, also when the mailbox is read again (its id is
   *     kept with the post).
   */
  async function applyPostChange(grp, item, player) {
    const x = item.post;
    const p = await first('SELECT * FROM chat_group_posts WHERE grp = ? AND pid = ?', [grp, x.target]);
    if (!p) return 'ignored';
    const byAuthor = x.from === p.author || (!!p.account && player === p.account);
    if (!byAuthor || item.receivedAt < p.received_at) return 'ignored';
    if (x.kind === 'delete') {
      if (!p.deleted) await run("UPDATE chat_group_posts SET text = '', deleted = 1 WHERE id = ?", [p.id]);
      return 'deleted';
    }
    let applied = [];
    try { applied = JSON.parse(p.edit_ids || '[]'); } catch { applied = []; }
    if (!Array.isArray(applied)) applied = [];
    if (applied.includes(x.id) || p.deleted || applied.length >= MAX_EDITS || item.receivedAt - p.received_at > EDIT_WINDOW) return 'ignored';
    applied.push(x.id);
    await run('UPDATE chat_group_posts SET text = ?, edit_ids = ? WHERE id = ?', [x.text, JSON.stringify(applied), p.id]);
    return 'edited';
  }

  /** The owner's pinned message, checked: it must be signed by one of the owner's devices. */
  async function collectPinned(g, owner) {
    const { envelope, at } = await postman.pinned(g.id);
    let text = null;
    if (envelope) {
      let opened = null;
      try { opened = openPinned(envelope, { groupId: g.id, keys: await keysOf(g.id) }); } catch { opened = null; }
      if (opened) {
        const ownerPlayer = owner ? await playerAt(owner) : null;
        // The owner isn't listed right now (e.g. their weekly check ran out):
        // keep what we have and look again next time.
        if (!ownerPlayer) return;
        if (ownerPlayer.devices.includes(opened.from)) text = JSON.stringify(opened.pins);
      }
    }
    await run('UPDATE chat_groups SET pinned_text = ?, pinned_at = ? WHERE id = ?', [text, at, g.id]);
  }

  // Groups (and key numbers) whose pinned messages the owner's Hub checked this session.
  const repinChecked = new Set();

  /** Everything for the groups we're in: new posts, the pinned message, letting people in. */
  async function syncGroups() {
    const { groups } = await postman.myGroups();
    const readAgain = (Number(await getMe('group_format')) || 1) < GROUP_FORMAT;
    for (const there of groups) {
      const g = await first('SELECT * FROM chat_groups WHERE id = ?', [there.id]);
      if (!g) continue;
      if (readAgain && g.status === GROUP_STATUS.MEMBER && g.key) g.last_seq = 0;
      if (there.owner !== g.owner || there.isOwner !== !!g.is_owner || there.ownerAccount !== g.owner_account) {
        await run('UPDATE chat_groups SET owner = ?, is_owner = ?, owner_account = ? WHERE id = ?', [there.owner, there.isOwner ? 1 : 0, there.ownerAccount ?? null, g.id]);
        g.owner_account = there.ownerAccount ?? null;
      }
      if ((there.pausedUntil || 0) !== (g.paused_until || 0)) await run('UPDATE chat_groups SET paused_until = ? WHERE id = ?', [there.pausedUntil || 0, g.id]);
      if (g.status !== GROUP_STATUS.MEMBER || !g.key) continue;
      // Someone was removed by a vote: the first open Hub makes the new key.
      if (there.needsRekey && there.epoch === g.epoch) await renewKey(g, there.epoch + 1);
      // A new key was made while we weren't looking and didn't reach us: ask again.
      else if (!there.needsRekey && there.epoch > g.epoch && !g.code) await joinGroup(g.id, { force: true }).catch(() => {});
      if (there.lastSeq > g.last_seq) await collectGroup(g);
      if ((there.pinnedAt ?? null) !== (g.pinned_at ?? null)) await collectPinned(g, there.owner);
      // The owner's Hub seals the pinned messages again with the group's
      // current key after a new key (a removal by vote): members who join
      // later only get that key and couldn't read them otherwise (24 Oct 2026).
      if (g.is_owner && g.pinned_text && !repinChecked.has(`${g.id}:${g.epoch}`)) {
        repinChecked.add(`${g.id}:${g.epoch}`);
        const { envelope } = await postman.pinned(g.id).catch(() => ({ envelope: null }));
        const pins = readPins(g.pinned_text)?.pins;
        if (envelope && envelope.epoch !== g.epoch && pins?.length) await setPins(g.id, pins).catch(() => {});
      }
      // (Only a Hub with the group's current key lets people in.)
      if (there.waiting > 0 && there.epoch === g.epoch && !there.needsRekey) await admitWaiting(g);
    }
    // Groups we're no longer in (e.g. the group was deleted) are forgotten here.
    for (const g of await all('SELECT id FROM chat_groups WHERE status = ?', [GROUP_STATUS.MEMBER])) {
      if (!groups.some((x) => x.id === g.id)) await forgetGroup(g.id);
    }
    // (only once everything went through - otherwise again next time)
    if (readAgain) await setMe('group_format', GROUP_FORMAT);
  }

  /** After a removal: a new key for the group, sealed for every remaining member's devices. */
  async function renewKey(g, epoch) {
    const key = randomCode();
    const { members } = await postman.groupMembers(g.id);
    const devices = [...new Set(members.flatMap((m) => m.devices))];
    const items = devices.length ? sealDirect({ from: identity, toDevices: devices, type: 'group-key', body: { group: g.id, epoch, key } }) : [];
    try {
      await postman.rekey({ group: g.id, epoch, keyCheck: groupKeyCheck(g.id, key), items });
    } catch (e) {
      if (e.status === 409) return; // another member's Hub was quicker; its key arrives by mail
      throw e;
    }
    await run('INSERT OR REPLACE INTO chat_group_keys (grp, epoch, key) VALUES (?, ?, ?)', [g.id, epoch, key]);
    await run('UPDATE chat_groups SET key = ?, epoch = ? WHERE id = ?', [key, epoch, g.id]);
    g.key = key;
    g.epoch = epoch;
  }

  /**
   * The group's removal votes (open, and decided in the last week), with the
   * reasons opened, the threshold, and whether I may start one.
   */
  async function groupVotes(id) {
    const r = await postman.votes(id);
    const keys = await keysOf(id);
    const votes = r.votes.map((v) => {
      let reason = null;
      try { reason = openPinned(v.reason, { groupId: id, keys, kind: VOTE_REASON_KIND })?.pins?.[0] ?? null; } catch { reason = null; }
      const yes = v.ballots.filter((b) => b.yes).length;
      return { ...v, reason, yes, no: v.ballots.length - yes };
    });
    // Decided votes are kept here for good (the postman shows them for 7 days; 25 Oct 2026).
    for (const v of votes.filter((x) => x.decided)) {
      const { myBallot, mayVote, aboutMe, ...kept } = v;
      await run('INSERT OR REPLACE INTO chat_vote_history (grp, id, opened_at, data) VALUES (?, ?, ?, ?)', [id, v.id, v.openedAt, JSON.stringify({ ...kept, aboutMe })]);
    }
    const history = (await all('SELECT data FROM chat_vote_history WHERE grp = ? ORDER BY opened_at DESC', [id])).map((h) => JSON.parse(h.data));
    // (A first guess from the weekly badge; the postman checks the wallet
    // itself when you vote, and again when the vote closes.)
    const badge = await getMe('badge');
    const check = badge ? checkBadge(badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() }) : { ok: false };
    return {
      threshold: r.threshold,
      canVote: check.ok && check.nfts >= holdingBand(r.threshold),
      canOpen: r.canOpen,
      // What this device's sign-in counted (the badge); "Update my holdings"
      // signs in again to refresh it.
      myNfts: check.ok ? check.nfts : 0,
      // open ones (and the decided ones of the last 7 days, as the postman has them)
      votes,
      // every decided vote this Hub has seen, newest first
      history,
      banned: r.banned,
    };
  }

  /**
   * Voting needs the wallet to sign a short text (no transaction):
   * `signText(text)` → { address, signature } (the Klever extension).
   */
  async function walletProof(signText) {
    const { code, text } = await postman.proofStart();
    const { address, signature } = await signText(text);
    return { code, wallet: address, signature };
  }

  async function openVote(id, nickname, reason, signText) {
    const g = await myGroup(id);
    const text = cleanText(reason);
    if (!text) throw new Error('Please give a reason.');
    const sealed = sealPinned({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, pins: [text], now: now(), kind: VOTE_REASON_KIND });
    return postman.openVote({ group: id, accused: nickname, reason: sealed, proof: await walletProof(signText) });
  }

  async function castVote(voteId, yes, signText) {
    return postman.castVote({ vote: voteId, yes: !!yes, proof: await walletProof(signText) });
  }

  /** The members' nicknames (for "start a vote"). */
  async function groupMemberNames(id) {
    return (await postman.groupMembers(id)).members.map((m) => m.nickname).filter(Boolean);
  }

  async function letBackIn(id, banId) {
    return postman.unban(id, banId);
  }

  async function groupPosts(id) {
    await run('UPDATE chat_groups SET unread = 0 WHERE id = ?', [id]);
    const reactions = new Map();
    for (const r of await all("SELECT pid, value, mine FROM chat_group_reactions WHERE grp = ? AND value != ''", [id])) {
      const x = reactions.get(r.pid) || { counts: {}, mine: '' };
      x.counts[r.value] = (x.counts[r.value] || 0) + 1;
      if (r.mine) x.mine = r.value;
      reactions.set(r.pid, x);
    }
    return (await all('SELECT * FROM chat_group_posts WHERE grp = ? ORDER BY seq', [id])).map((p) => {
      const edits = editCount(p);
      return {
        id: p.id, pid: p.pid ?? null, mine: !!p.mine, author: p.author, nickname: p.nickname, text: p.text, writtenAt: p.written_at, receivedAt: p.received_at,
        // { counts: { '👍': 2, '👎': 1 }, mine: '👍' | '👎' | '' }  (none on a deleted post)
        reactions: (!p.deleted && p.pid && reactions.get(p.pid)) || { counts: {}, mine: '' },
        // Editing and deleting (29 Oct 2026)
        edits, edited: edits > 0, deleted: !!p.deleted,
        canEdit: !!p.mine && !!p.pid && !p.deleted && edits < MAX_EDITS && now() - p.received_at < EDIT_WINDOW,
        editsLeft: Math.max(0, MAX_EDITS - edits),
        canDelete: !!p.mine && !!p.pid && !p.deleted,
      };
    });
  }

  function editCount(p) {
    try {
      const list = JSON.parse(p.edit_ids || '[]');
      return Array.isArray(list) ? list.length : 0;
    } catch {
      return 0;
    }
  }

  /** My post `pid` in group `id`, for an edit or delete (on any of my devices). */
  async function myPost(id, pid) {
    const p = await first('SELECT * FROM chat_group_posts WHERE grp = ? AND pid = ?', [id, pid]);
    if (!p || !p.mine) throw new Error('Only your own posts can be changed.');
    return p;
  }

  /** The current badge, checked (needed to seal anything for a group). */
  async function freshBadge() {
    const badge = await getMe('badge');
    const check = badge ? checkBadge(badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() }) : { ok: false };
    if (!check.ok) throw new Error('Please sign in again (your weekly check has run out).');
    return badge;
  }

  /**
   * Edits my post (29 Oct 2026): at most MAX_EDITS times, within 24 hours of
   * posting it. Free: never counts as a post (no daily allowance, no 10-second gap).
   */
  async function editGroupPost(id, pid, text) {
    const g = await myGroup(id);
    const p = await myPost(id, pid);
    if (p.deleted) throw new Error('This post was deleted.');
    if (editCount(p) >= MAX_EDITS) throw new Error(`A post can be edited at most ${MAX_EDITS} times.`);
    if (now() - p.received_at >= EDIT_WINDOW) throw new Error('A post can only be edited within 24 hours.');
    const clean = cleanText(text);
    if (!clean) throw new Error('Nothing to send. (To remove the post, delete it.)');
    if (clean === p.text) return;
    const envelope = sealGroupEdit({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, postId: pid, text: clean, badge: await freshBadge(), now: now() });
    await postman.groupPost(envelope, { reaction: true });
    await collectGroup(g);
  }

  /** Deletes my post for everyone (29 Oct 2026). Always possible, free; it stays as "deleted". */
  async function deleteGroupPost(id, pid) {
    const g = await myGroup(id);
    const p = await myPost(id, pid);
    if (p.deleted) return;
    const envelope = sealGroupDelete({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, postId: pid, badge: await freshBadge(), now: now() });
    await postman.groupPost(envelope, { reaction: true });
    await collectGroup(g);
  }

  /** When this device may post in the group again (by the holdings in its badge). */
  async function nextGroupPostAt(id) {
    const badge = await getMe('badge');
    const pk = await postmanKey();
    const check = badge ? checkBadge(badge, { postmanPublicKey: pk, holder: identity.publicKey, at: now() }) : { ok: false };
    if (!check.ok) return { allowedAt: null, nfts: 0 };
    const times = (await recentPosts(id))[check.account ?? identity.publicKey] || [];
    const g = await first('SELECT is_owner FROM chat_groups WHERE id = ?', [id]);
    if (g?.is_owner) {
      // The owner may always answer: every 10 seconds (the postman's limit).
      return { allowedAt: times.length ? Math.max(...times) + MIN_POST_INTERVAL : 0, nfts: check.nfts, owner: true };
    }
    return {
      allowedAt: nextPostAllowedAt(times, check.nfts, now()),
      nfts: check.nfts,
      perDay: postsPerDay(check.nfts),
      left: postsLeft(times, check.nfts, now()),
      owner: false,
    };
  }

  async function postToGroup(id, text) {
    const g = await myGroup(id);
    const { allowedAt } = await nextGroupPostAt(id);
    if (allowedAt === null) throw new Error('Please sign in again (your weekly check has run out).');
    if (allowedAt > now()) throw new Error('Not yet: your next post in this group is possible later (see above).');
    const envelope = sealGroupPost({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, text, badge: await getMe('badge'), now: now() });
    await postman.groupPost(envelope);
    await collectGroup(g);
  }

  /**
   * 👍 / 👎 on a post (its pid); the same again takes it back. Free: no
   * daily allowance, no 10-second gap (24 Oct 2026). Shown here at once.
   */
  async function reactToPost(id, pid, value) {
    const g = await myGroup(id);
    const badge = await getMe('badge');
    const check = badge ? checkBadge(badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() }) : { ok: false };
    if (!check.ok) throw new Error('Please sign in again (your weekly check has run out).');
    const player = check.account ?? identity.publicKey;
    const current = await first('SELECT value FROM chat_group_reactions WHERE grp = ? AND pid = ? AND player = ?', [id, pid, player]);
    const next = current?.value === value ? '' : value;
    const envelope = sealGroupReaction({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, postId: pid, value: next, badge, now: now() });
    await postman.groupPost(envelope, { reaction: true });
    await run(
      `INSERT INTO chat_group_reactions (grp, pid, player, value, at, mine) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (grp, pid, player) DO UPDATE SET value = excluded.value, at = excluded.at, mine = 1`,
      [id, pid, player, next, now()],
    );
    return next;
  }

  /**
   * A new poll (25 Oct 2026): counts as a post (the daily allowance).
   * durationMs: 1 hour – 7 days. → the poll's id
   */
  async function startPoll(id, question, options, durationMs) {
    const g = await myGroup(id);
    const { allowedAt } = await nextGroupPostAt(id);
    if (allowedAt === null) throw new Error('Please sign in again (your weekly check has run out).');
    if (allowedAt > now()) throw new Error('Not yet: a poll counts as a post, and your next post in this group is possible later (see below).');
    const envelope = sealGroupPoll({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, question, options, durationMs, badge: await getMe('badge'), now: now() });
    await postman.groupPost(envelope);
    await collectGroup(g);
    return envelope;
  }

  /** My answer (its number; null takes my vote back) - free, changeable until the poll ends. */
  async function votePoll(id, pollId, option) {
    const g = await myGroup(id);
    const envelope = sealGroupPollVote({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, pollId, option: option === null ? '' : option, badge: await getMe('badge'), now: now() });
    await postman.groupPost(envelope, { reaction: true });
    await collectGroup(g);
  }

  /** The poll's creator ends it now. */
  async function closePoll(id, pollId) {
    const g = await myGroup(id);
    const envelope = sealGroupPollClose({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, pollId, badge: await getMe('badge'), now: now() });
    await postman.groupPost(envelope, { reaction: true });
    await collectGroup(g);
  }

  /**
   * The group's polls, newest first, with the results so far.
   * → [{ id, question, options, counts, voters: [{ nickname, choice }], myChoice,
   *      creator (nickname), mine, openedAt, endsAt, closedAt, open }]
   */
  async function groupPolls(id) {
    const polls = await all('SELECT * FROM chat_group_polls WHERE grp = ? ORDER BY opened_at DESC', [id]);
    const out = [];
    for (const p of polls) {
      const options = JSON.parse(p.options);
      const votes = (await all('SELECT * FROM chat_group_poll_votes WHERE grp = ? AND poll = ? AND choice IS NOT NULL ORDER BY at', [id, p.pid]))
        .filter((v) => v.choice < options.length);
      const counts = options.map((_, i) => votes.filter((v) => v.choice === i).length);
      const endedAt = Math.min(p.ends_at, p.closed_at ?? Infinity);
      out.push({
        id: p.pid,
        question: p.question,
        options,
        counts,
        voters: votes.map((v) => ({ nickname: v.nickname, choice: v.choice })),
        myChoice: votes.find((v) => v.mine)?.choice ?? null,
        creator: p.nickname,
        mine: !!p.mine,
        openedAt: p.opened_at,
        endsAt: p.ends_at,
        closedAt: p.closed_at ?? null,
        open: now() < endedAt,
      });
    }
    return out;
  }

  /** The owner sets the whole list of pinned messages (empty list: nothing pinned). */
  async function setPins(id, pins) {
    const g = await myGroup(id);
    const list = (pins || []).map((p) => cleanText(p)).filter(Boolean);
    const envelope = list.length ? sealPinned({ group: { id: g.id, epoch: g.epoch, key: g.key }, from: identity, pins: list, now: now() }) : null;
    await postman.setPinned(id, envelope);
    await run('UPDATE chat_groups SET pinned_text = ?, pinned_at = ? WHERE id = ?', [list.length ? JSON.stringify(list) : null, null, id]);
  }
  /** (one pinned text – kept for simple use) */
  const setPinned = (id, text) => setPins(id, text && text.trim() ? [text] : []);

  // --- backup (locked with a password by backup.js) ------------------------

  /** True if there's a chat here worth backing up (signed in once, or contacts). */
  // --- Collectors Albums (27 Oct 2026) -----------------------------------------
  // An album has its own key (album.js): published under that key only, so it
  // isn't linked to my chat account unless I choose to show my nickname on it.

  const albumRow = (r) => {
    let album = null;
    if (r.event) {
      const c = checkAlbum(JSON.parse(r.event));
      album = c.ok ? c.album : null;
    }
    return { key: r.key, published: r.published, album };
  };

  /** My albums (published or not), newest first: [{ key, published, album | null }]. */
  async function myAlbums() {
    return (await all('SELECT * FROM chat_albums ORDER BY created DESC')).map(albumRow);
  }

  /**
   * A new album key (step 1 of making an album). → { key, proofText }:
   * the wallet signs proofText next (Klever extension / KLV Signer).
   */
  async function newAlbum() {
    const k = createAlbumKey();
    await run('INSERT INTO chat_albums (key, secret, event, published, created) VALUES (?, ?, NULL, 0, ?)', [k.publicKey, k.secretKey, now()]);
    await queueSync({ t: 'album', a: { key: k.publicKey, secret: k.secretKey, event: null, published: 0, created: now() } });
    return { key: k.publicKey, proofText: albumProofText(k.publicKey) };
  }

  /** The text the wallet signs for one of my albums (e.g. to show another wallet in it). */
  const albumProof = (key) => albumProofText(key);

  /**
   * Publishes (or updates) one of my albums. contents: { title, description,
   * showName (my chat nickname on it, or not), wallet, proof, items: [{ kind, nonce, note }] }
   * → the checked album
   */
  async function publishAlbum(key, { title, description = '', showName = false, wallet, proof, items }) {
    const r = await first('SELECT * FROM chat_albums WHERE key = ?', [key]);
    if (!r) throw new Error('This album is no longer on this device.');
    const name = showName ? await getMe('nickname') : null;
    if (showName && !name) throw new Error('Pick a chat nickname first, or publish the album without a name.');
    cleanAlbum({ title, description, name, wallet, proof, items }); // (plain messages for the screen)
    // (never older than the version published before, also if this device's clock is behind)
    const at = Math.max(now(), r.published + 1000);
    const event = sealAlbum({ publicKey: r.key, secretKey: r.secret }, { title, description, name, wallet, proof, items }, at);
    const checked = checkAlbum(event);
    if (!checked.ok) throw new Error(checked.problem === "the wallet's proof doesn't match"
      ? "The wallet's signature doesn't match this wallet. Please sign again with the wallet whose NFTs are in the album."
      : `This album can't be published (${checked.problem}).`);
    await postman.publishAlbum(event);
    const text = JSON.stringify(event);
    await run('UPDATE chat_albums SET event = ?, published = ? WHERE key = ?', [text, at, key]);
    await queueSync({ t: 'album', a: { key, secret: r.secret, event: text, published: at, created: r.created } });
    return checked.album;
  }

  /** Takes one of my albums down (at the postman and on my devices); a not-yet-published one is just forgotten. */
  async function deleteAlbum(key) {
    const r = await first('SELECT * FROM chat_albums WHERE key = ?', [key]);
    if (!r) return;
    if (r.event) {
      // (signed with the album's own key: the postman lets only that key delete it)
      await createPostmanClient({ baseUrl: postmanUrl, identity: { publicKey: r.key, secretKey: r.secret }, fetchFn, now }).deleteAlbum();
    }
    await run('DELETE FROM chat_albums WHERE key = ?', [key]);
    await run("DELETE FROM chat_album_talk WHERE album = ? AND side = 'owner'", [key]);
    await run("DELETE FROM chat_album_threads WHERE album = ? AND side = 'owner'", [key]);
    await queueSync({ t: 'album', key, deleted: true });
  }

  /**
   * Publishes my albums again with a fresh date once they're a week old, so
   * the postman keeps them (it forgets albums 60 days after their last
   * update, e.g. of a player who stopped using the Hub). Only from a
   * signed-in device; the same contents, the same wallet proof.
   */
  async function refreshAlbums() {
    if ((await status()).state !== 'ready') return 0;
    let n = 0;
    for (const r of await all('SELECT * FROM chat_albums WHERE event IS NOT NULL AND published < ?', [now() - ALBUM_REFRESH_MS])) {
      const c = checkAlbum(JSON.parse(r.event));
      if (!c.ok) continue;
      const { title, description, name, wallet, proof, items } = c.album;
      const at = Math.max(now(), r.published + 1000);
      const event = sealAlbum({ publicKey: r.key, secretKey: r.secret }, { title, description, name, wallet, proof, items }, at);
      try {
        await postman.publishAlbum(event);
      } catch (e) {
        // (another of my devices was quicker: its version comes as a sync; not tried again for a week)
        if (e.status === 409) { await run('UPDATE chat_albums SET published = ? WHERE key = ?', [now(), r.key]); continue; }
        throw e;
      }
      const text = JSON.stringify(event);
      await run('UPDATE chat_albums SET event = ?, published = ? WHERE key = ?', [text, at, r.key]);
      await queueSync({ t: 'album', a: { key: r.key, secret: r.secret, event: text, published: at, created: r.created } });
      n += 1;
    }
    return n;
  }

  // --- Comments on NFTs (28 Oct 2026) ----------------------------------------
  // Reading them needs no sign-in (client.js publicAlbums.comments); these
  // are the signed-in player's actions.

  const albumClient = (r) => createPostmanClient({ baseUrl: postmanUrl, identity: { publicKey: r.key, secretKey: r.secret }, fetchFn, now });

  /** A comment on one NFT of an album (shown under my chat nickname). */
  async function commentOnNft(album, kind, nonce, text) {
    return postman.addComment({ album, kind, nonce, text });
  }

  /** 1 = I can confirm, -1 = not right, 0 = take my vote back. */
  async function voteOnComment(comment, vote) {
    await postman.voteComment(comment, vote);
    if (vote === 0) await run('DELETE FROM chat_comment_votes WHERE comment = ?', [comment]);
    else await run('INSERT OR REPLACE INTO chat_comment_votes (comment, vote, at) VALUES (?, ?, ?)', [comment, vote, now()]);
  }

  /**
   * My votes: { [commentId]: 1 | -1 }. With `comments` (from the postman), a
   * vote cast before the comment was edited doesn't count any more.
   */
  async function myCommentVotes(comments = null) {
    const editedAt = new Map((comments || []).map((c) => [c.id, Number(c.edited) || 0]));
    return Object.fromEntries((await all('SELECT comment, vote, at FROM chat_comment_votes'))
      .filter((r) => !editedAt.get(r.comment) || (Number(r.at) || 0) > editedAt.get(r.comment))
      .map((r) => [r.comment, r.vote]));
  }

  /** Changing my own comment (its votes start again). */
  async function editComment(comment, text) {
    return postman.editComment(comment, text);
  }

  async function deleteComment(comment) {
    await postman.deleteComment(comment);
  }

  /** The owner hides (or shows again) a comment in one of MY albums. */
  async function hideCommentInAlbum(albumKey, comment, hidden) {
    const r = await first('SELECT * FROM chat_albums WHERE key = ?', [albumKey]);
    if (!r) throw new Error('This album is no longer on this device.');
    await albumClient(r).hideComment(comment, hidden);
  }

  /** Is this album one of mine (so its page can offer hiding comments / the inbox)? */
  async function isMyAlbum(albumKey) {
    return !!(await first('SELECT key FROM chat_albums WHERE key = ?', [albumKey]));
  }

  // --- The album mailbox (28 Oct 2026) ------------------------------------------
  // I write to "the owner of album X" (sealed for the album's key, and for my
  // other devices); the owner answers under the album's name (sealed with the
  // album key, for my devices and for their own other devices). The owner sees
  // my nickname; I don't learn who the owner is.

  async function storeTalk({ album, side, thread, mine, text, sentAt }) {
    const clean = cleanText(text || '');
    if (!clean || !Number.isFinite(sentAt)) return false;
    // (the database itself refuses a second copy: two mail checks at the same moment could both bring it)
    const r = await run('INSERT OR IGNORE INTO chat_album_talk (album, side, thread, mine, text, sent_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [album, side, thread, mine ? 1 : 0, clean, sentAt, now()]);
    if (!r.changes) return false;
    await run(`UPDATE chat_album_threads SET last_at = MAX(last_at, ?), unread = unread + ? WHERE album = ? AND side = ? AND thread = ?`,
      [sentAt, mine ? 0 : 1, album, side, thread]);
    return true;
  }

  async function ensureThread({ album, side, thread, title = null, nickname = null, devices = null, blocked = null }) {
    await run('INSERT OR IGNORE INTO chat_album_threads (album, side, thread, title, nickname, devices) VALUES (?, ?, ?, ?, ?, ?)',
      [album, side, thread, title, nickname, devices ? JSON.stringify(devices) : null]);
    if (title) await run('UPDATE chat_album_threads SET title = ? WHERE album = ? AND side = ? AND thread = ?', [title, album, side, thread]);
    if (nickname) await run('UPDATE chat_album_threads SET nickname = ? WHERE album = ? AND side = ? AND thread = ?', [nickname, album, side, thread]);
    if (devices) await run('UPDATE chat_album_threads SET devices = ? WHERE album = ? AND side = ? AND thread = ?', [JSON.stringify(devices), album, side, thread]);
    if (blocked !== null) await run('UPDATE chat_album_threads SET blocked = ? WHERE album = ? AND side = ? AND thread = ?', [blocked ? 1 : 0, album, side, thread]);
  }

  /** Writing to the owner of someone's album. `title`: the album's title (kept to show the conversation). */
  async function messageAlbumOwner(albumKey, title, text) {
    if (!isPublicKey(albumKey)) throw new Error('Not an album.');
    if (await isMyAlbum(albumKey)) throw new Error('This is your own album.');
    const clean = cleanText(text || '');
    if (!clean) throw new Error('Nothing to send.');
    await refreshDevices().catch(() => {});
    const sentAt = now();
    const items = sealDirect({ from: identity, toDevices: [albumKey], ownDevices, type: 'album-talk', body: { album: albumKey, text: clean, sentAt, title } });
    const { thread } = await postman.albumTalkSend(albumKey, items);
    await ensureThread({ album: albumKey, side: 'visitor', thread, title });
    await storeTalk({ album: albumKey, side: 'visitor', thread, mine: true, text: clean, sentAt });
    return thread;
  }

  /** Answering a visitor of one of MY albums (under the album's name). */
  async function replyAsAlbum(albumKey, thread, text) {
    const r = await first('SELECT * FROM chat_albums WHERE key = ?', [albumKey]);
    const th = await first("SELECT * FROM chat_album_threads WHERE album = ? AND side = 'owner' AND thread = ?", [albumKey, thread]);
    if (!r || !th) throw new Error('This conversation is no longer on this device.');
    const clean = cleanText(text || '');
    if (!clean) throw new Error('Nothing to send.');
    const devices = JSON.parse(th.devices || '[]').filter(isPublicKey);
    if (!devices.length) throw new Error("This player can't be reached any more.");
    const sentAt = now();
    const items = sealDirect({ from: { publicKey: r.key, secretKey: r.secret }, toDevices: devices, ownDevices: [r.key], type: 'album-talk', body: { album: albumKey, text: clean, sentAt } });
    await albumClient(r).albumTalkReply(thread, items);
    await storeTalk({ album: albumKey, side: 'owner', thread, mine: true, text: clean, sentAt });
  }

  /** The owner stops (or allows again) messages from one visitor to this album. */
  async function blockAlbumVisitor(albumKey, thread, blocked) {
    const r = await first('SELECT * FROM chat_albums WHERE key = ?', [albumKey]);
    if (!r) throw new Error('This album is no longer on this device.');
    await albumClient(r).albumTalkBlock(thread, blocked);
    await ensureThread({ album: albumKey, side: 'owner', thread, blocked });
  }

  /** New album messages: for this device (as a visitor) and for each of my albums (as the owner). → how many new */
  let talkRun = null;
  function collectAlbumTalk() {
    // (one run at a time: the album screen and the chat's mail check both ask)
    if (!talkRun) talkRun = fetchAlbumTalk().finally(() => { talkRun = null; });
    return talkRun;
  }
  async function fetchAlbumTalk() {
    let added = 0;
    const take = async (client, key, ident, side) => {
      const afterKey = `talkAfter:${key}`;
      const { items } = await client.albumTalk((await getMe(afterKey)) || 0);
      let last = (await getMe(afterKey)) || 0;
      for (const it of items || []) {
        last = Math.max(last, Number(it.id) || 0);
        let opened = null;
        try { opened = openDirect(it.envelope, ident); } catch { opened = null; }
        const d = opened?.type === 'album-talk' ? opened.data || {} : null;
        if (!d || d.album !== it.album || typeof d.text !== 'string') continue;
        if (side === 'visitor') {
          // From the album's owner, or a copy of what I wrote on another of my devices.
          const mine = opened.from !== it.album;
          if (mine && !ownDevices.includes(opened.from)) continue;
          await ensureThread({ album: it.album, side, thread: it.thread, title: typeof d.title === 'string' ? cleanText(d.title).slice(0, 60) : null });
          if (await storeTalk({ album: it.album, side, thread: it.thread, mine, text: d.text, sentAt: Number(d.sentAt) })) added += mine ? 0 : 1;
        } else {
          // From a visitor (one of their devices), or my own answer (from another of my devices).
          const mine = opened.from === key;
          if (!mine && !(it.devices || []).includes(opened.from)) continue;
          await ensureThread({ album: key, side, thread: it.thread, nickname: it.nickname, devices: it.devices, blocked: it.blocked });
          if (await storeTalk({ album: key, side, thread: it.thread, mine, text: d.text, sentAt: Number(d.sentAt) })) added += mine ? 0 : 1;
        }
      }
      if (last) await setMe(afterKey, last);
    };
    await take(postman, identity.publicKey, identity, 'visitor');
    for (const r of await all('SELECT * FROM chat_albums WHERE event IS NOT NULL')) {
      await take(albumClient(r), r.key, { publicKey: r.key, secretKey: r.secret }, 'owner').catch(() => {});
    }
    return added;
  }

  /** My album conversations, newest first: [{ album, side, thread, title, nickname, blocked, unread, lastAt }] */
  async function albumConversations() {
    const titles = Object.fromEntries((await myAlbums()).map((a) => [a.key, a.album?.title || null]));
    return (await all('SELECT * FROM chat_album_threads ORDER BY last_at DESC')).map((t) => ({
      album: t.album, side: t.side, thread: t.thread, title: t.side === 'owner' ? titles[t.album] || t.title : t.title,
      nickname: t.nickname, blocked: !!t.blocked, unread: t.unread, lastAt: t.last_at,
    }));
  }

  /** One conversation's messages (oldest first); marks it read. */
  async function albumMessages(album, side, thread) {
    await run('UPDATE chat_album_threads SET unread = 0 WHERE album = ? AND side = ? AND thread = ?', [album, side, thread]);
    return (await all('SELECT * FROM chat_album_talk WHERE album = ? AND side = ? AND thread = ? ORDER BY sent_at, id', [album, side, thread]))
      .map((m) => ({ id: m.id, mine: !!m.mine, text: m.text, sentAt: m.sent_at }));
  }

  /** My conversation with the owner of this album, if there is one (its thread id). */
  async function albumThreadWith(album) {
    return (await first("SELECT thread FROM chat_album_threads WHERE album = ? AND side = 'visitor'", [album]))?.thread ?? null;
  }

  async function hasChat() {
    return !!(await getMe('account')) || (await all('SELECT id FROM chat_contacts LIMIT 1')).length > 0;
  }

  /** Everything needed to bring this chat back in another browser. */
  async function backupData() {
    const me = {};
    for (const r of await all('SELECT k, v FROM chat_me')) me[r.k] = JSON.parse(r.v);
    return {
      kind: 'chat',
      version: 1,
      me,
      contacts: await all('SELECT * FROM chat_contacts ORDER BY id'),
      messages: await all('SELECT * FROM chat_messages ORDER BY id'),
      groups: await all('SELECT * FROM chat_groups'),
      groupPosts: await all('SELECT * FROM chat_group_posts ORDER BY id'),
      groupReactions: await all('SELECT * FROM chat_group_reactions'),
      groupPolls: await all('SELECT * FROM chat_group_polls'),
      groupPollVotes: await all('SELECT * FROM chat_group_poll_votes'),
      voteHistory: await all('SELECT * FROM chat_vote_history'),
      groupLast: await all('SELECT * FROM chat_group_last'),
      groupKeys: await all('SELECT * FROM chat_group_keys'),
      albums: await all('SELECT * FROM chat_albums'),
    };
  }

  /**
   * Brings a chat back from backupData(). Only into a browser without a
   * chat of its own (one browser, one chat key). → status()
   */
  async function restoreBackupData(data) {
    if (await hasChat()) throw new Error('This browser already has a chat. Leave it first (Chat > Leave the chat in this browser) to bring back the one from the backup.');
    if (!data || data.kind !== 'chat' || data.version !== 1 || !data.me?.identity || !Array.isArray(data.contacts) || !Array.isArray(data.messages)) {
      throw new Error("The chat in this backup can't be read.");
    }
    const restored = data.me.identity;
    try {
      secretBytes(restored); // a damaged chat key is refused
    } catch {
      throw new Error("The chat in this backup can't be read.");
    }
    const wipe = async () => {
      for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES, ...DEVICE_TABLES, ...ALBUM_TABLES]) await run(`DELETE FROM ${table}`);
    };
    await wipe();
    try {
      await restoreRows(data);
      // The chat key and sign-in last: only a complete restore counts.
      for (const [k, v] of Object.entries(data.me)) await setMe(k, v);
    } catch (e) {
      await wipe().catch(() => {});
      await setMe('identity', identity).catch(() => {});
      throw new Error(`The chat couldn't be brought back (${e?.message || e}). Nothing was changed.`);
    }
    identity = restored;
    postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });
    return status();
  }

  async function restoreRows(data) {
    for (const g of Array.isArray(data.groups) ? data.groups : []) {
      if (typeof g.id !== 'string' || !Object.values(GROUP_STATUS).includes(g.status)) continue;
      await run(
        `INSERT INTO chat_groups (id, name, description, owner, is_owner, status, key, epoch, code, last_seq, unread, pinned_text, pinned_at, joined_at, owner_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [g.id, String(g.name ?? ''), String(g.description ?? ''), g.owner ?? null, g.is_owner ? 1 : 0, g.status, g.key ?? null,
          Number(g.epoch) || 1, g.code ?? null, Number(g.last_seq) || 0, Number(g.unread) || 0, g.pinned_text ?? null, g.pinned_at ?? null, Number(g.joined_at) || 0, g.owner_account ?? null],
      );
    }
    for (const p of Array.isArray(data.groupPosts) ? data.groupPosts : []) {
      if (typeof p.grp !== 'string' || typeof p.text !== 'string') continue;
      await run('INSERT OR IGNORE INTO chat_group_posts (grp, seq, pid, author, nickname, text, written_at, received_at, mine, account, edit_ids, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [p.grp, Number(p.seq) || 0, typeof p.pid === 'string' ? p.pid : null, String(p.author ?? ''), p.nickname ?? null, p.deleted ? '' : p.text, Number(p.written_at) || 0, Number(p.received_at) || 0, p.mine ? 1 : 0,
          p.account ?? null, typeof p.edit_ids === 'string' ? p.edit_ids : null, p.deleted ? 1 : 0]);
    }
    for (const p of Array.isArray(data.groupPolls) ? data.groupPolls : []) {
      if (typeof p.grp !== 'string' || typeof p.pid !== 'string' || typeof p.question !== 'string' || typeof p.options !== 'string') continue;
      await run(
        `INSERT OR REPLACE INTO chat_group_polls (grp, pid, seq, creator, author, nickname, question, options, opened_at, ends_at, closed_at, mine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.grp, p.pid, Number(p.seq) || 0, String(p.creator ?? ''), String(p.author ?? ''), p.nickname ?? null, p.question, p.options,
          Number(p.opened_at) || 0, Number(p.ends_at) || 0, p.closed_at == null ? null : Number(p.closed_at), p.mine ? 1 : 0],
      );
    }
    for (const v of Array.isArray(data.groupPollVotes) ? data.groupPollVotes : []) {
      if (typeof v.grp !== 'string' || typeof v.poll !== 'string' || typeof v.player !== 'string') continue;
      await run('INSERT OR REPLACE INTO chat_group_poll_votes (grp, poll, player, choice, nickname, at, mine) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.grp, v.poll, v.player, v.choice == null ? null : Number(v.choice), v.nickname ?? null, Number(v.at) || 0, v.mine ? 1 : 0]);
    }
    for (const h of Array.isArray(data.voteHistory) ? data.voteHistory : []) {
      if (typeof h.grp !== 'string' || typeof h.id !== 'string' || typeof h.data !== 'string') continue;
      await run('INSERT OR REPLACE INTO chat_vote_history (grp, id, opened_at, data) VALUES (?, ?, ?, ?)', [h.grp, h.id, Number(h.opened_at) || 0, h.data]);
    }
    for (const r of Array.isArray(data.groupReactions) ? data.groupReactions : []) {
      if (typeof r.grp !== 'string' || typeof r.pid !== 'string' || typeof r.player !== 'string' || typeof r.value !== 'string') continue;
      await run('INSERT OR REPLACE INTO chat_group_reactions (grp, pid, player, value, at, mine) VALUES (?, ?, ?, ?, ?, ?)',
        [r.grp, r.pid, r.player, r.value, Number(r.at) || 0, r.mine ? 1 : 0]);
    }
    for (const k of Array.isArray(data.groupKeys) ? data.groupKeys : []) {
      if (typeof k.grp !== 'string' || !/^[0-9a-f]{64}$/.test(k.key || '')) continue;
      await run('INSERT OR REPLACE INTO chat_group_keys (grp, epoch, key) VALUES (?, ?, ?)', [k.grp, Number(k.epoch) || 1, k.key]);
    }
    for (const g of Array.isArray(data.groups) ? data.groups : []) {
      if (g.key) await run('INSERT OR IGNORE INTO chat_group_keys (grp, epoch, key) VALUES (?, ?, ?)', [g.id, Number(g.epoch) || 1, g.key]);
    }
    for (const l of Array.isArray(data.groupLast) ? data.groupLast : []) {
      if (typeof l.grp !== 'string' || typeof l.author !== 'string') continue;
      await run('INSERT OR REPLACE INTO chat_group_last (grp, author, at) VALUES (?, ?, ?)', [l.grp, l.author, Number(l.at) || 0]);
    }
    const idMap = new Map();
    for (const c of data.contacts) {
      if (typeof c.nickname !== 'string' || !Object.values(STATUS).includes(c.status)) continue;
      const r = await run(
        `INSERT INTO chat_contacts (nickname, devices, their_code, my_code, status, created, last_at, unread, ended, before_block)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.nickname, typeof c.devices === 'string' ? c.devices : '[]', c.their_code ?? null, c.my_code ?? null, c.status,
          Number(c.created) || 0, Number(c.last_at) || 0, Number(c.unread) || 0, c.ended ? 1 : 0, c.before_block ?? null],
      );
      idMap.set(c.id, r.lastInsertRowId);
    }
    for (const a of Array.isArray(data.albums) ? data.albums : []) await mergeAlbum(a);
    for (const m of data.messages) {
      const contact = idMap.get(m.contact);
      if (!contact || typeof m.text !== 'string') continue;
      await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at, mid, edits, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [contact, m.mine ? 1 : 0, m.deleted ? '' : m.text, Number(m.sent_at) || 0, Number(m.received_at) || 0,
          MID.test(m.mid || '') ? m.mid : null, Math.min(MAX_EDITS, Number(m.edits) || 0), m.deleted ? 1 : 0]);
    }
  }

  /**
   * Removes the chat from THIS browser only: the postman isn't told, so the
   * same chat key keeps working where else it is (e.g. after bringing the
   * chat into another browser with a backup). A new, unused chat key is
   * made here.
   */
  async function forgetHere() {
    leaving = true;
    try {
      if (mailRun) await mailRun.catch(() => {});
      for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES, ...DEVICE_TABLES, ...ALBUM_TABLES]) await run(`DELETE FROM ${table}`);
      ownDevices = [];
      identity = createIdentity();
      await setMe('identity', identity);
      postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });
    } finally {
      leaving = false;
    }
  }

  return {
    listGroups,
    groupCreateInfo,
    createGroup,
    joinGroup,
    leaveGroup,
    groupPosts,
    postToGroup,
    editGroupPost,
    deleteGroupPost,
    nextGroupPostAt,
    setPinned,
    setPins,
    reactToPost,
    startPoll,
    votePoll,
    closePoll,
    groupPolls,
    groupVotes,
    openVote,
    castVote,
    letBackIn,
    groupMemberNames,
    syncGroups,
    forgetHere,
    hasChat,
    backupData,
    restoreBackupData,
    get identity() { return { publicKey: identity.publicKey }; },
    status,
    startSignIn,
    finishSignIn,
    setNickname,
    findPlayers,
    listContacts,
    requestContact,
    acceptContact,
    declineContact,
    blockContact,
    unblockContact,
    removeContact,
    messages,
    sendMessage,
    editMessage,
    deleteMessage,
    checkMail,
    leave,
    // linked devices (27 Oct 2026)
    startLink,
    finishLink,
    linkedDevices,
    copyHistoryTo,
    dismissNewDevice,
    removeDevice,
    // Collectors Albums (27 Oct 2026)
    myAlbums,
    newAlbum,
    albumProof,
    publishAlbum,
    deleteAlbum,
    refreshAlbums,
    // comments and the album mailbox (28 Oct 2026)
    commentOnNft,
    voteOnComment,
    myCommentVotes,
    deleteComment,
    editComment,
    hideCommentInAlbum,
    isMyAlbum,
    messageAlbumOwner,
    replyAsAlbum,
    blockAlbumVisitor,
    collectAlbumTalk,
    albumConversations,
    albumMessages,
    albumThreadWith,
  };
}
