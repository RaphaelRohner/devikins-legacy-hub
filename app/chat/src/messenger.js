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
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { createIdentity, isPublicKey, secretBytes } from './identity.js';
import { sealDirect, openDirect } from './direct.js';
import { cleanText, nicknameKey, nextPostAllowedAt, MIN_POST_INTERVAL, POST_WINDOW, postsPerDay, postsLeft } from './rules.js';
import {
  sealGroupPost, sealGroupReaction, openGroupPost, acceptPosts, acceptReactions, readGroupKeyMessage, sealPinned, openPinned, groupKeyCheck, VOTE_REASON_KIND,
} from './group.js';
import { checkBadge } from './badge.js';
import { createPostmanClient } from './client.js';

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
CREATE TABLE IF NOT EXISTS chat_group_names (grp TEXT NOT NULL, device TEXT NOT NULL, nickname TEXT NOT NULL, PRIMARY KEY (grp, device));
CREATE TABLE IF NOT EXISTS chat_group_keys (grp TEXT NOT NULL, epoch INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (grp, epoch));
`;

/** Group states on this device. */
export const GROUP_STATUS = {
  ASKING: 'asking', // asked to join; waiting for a member's Hub to hand over the key
  MEMBER: 'member',
};

const GROUP_TABLES = ['chat_groups', 'chat_group_posts', 'chat_group_last', 'chat_group_recent', 'chat_group_reactions', 'chat_group_names', 'chat_group_keys'];

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
 *   fetchFn, now: for tests
 */
export async function createMessenger({ db, postmanUrl, fetchFn, now = () => Date.now() }) {
  await db.execAsync(SCHEMA);
  const all = (sql, params = []) => db.getAllAsync(sql, params);
  const first = async (sql, params = []) => (await all(sql, params))[0] ?? null;
  const run = (sql, params = []) => db.runAsync(sql, params);

  // Chats started with an earlier version: add the columns added since
  // (CREATE TABLE IF NOT EXISTS leaves an existing table as it was).
  const added = {
    chat_contacts: [['ended', 'INTEGER NOT NULL DEFAULT 0'], ['before_block', 'TEXT']],
    chat_groups: [['owner_account', 'TEXT'], ['paused_until', 'INTEGER NOT NULL DEFAULT 0']],
  };
  for (const [table, cols] of Object.entries(added)) {
    const columns = new Set((await all(`PRAGMA table_info(${table})`)).map((c) => c.name));
    for (const [name, type] of cols) {
      if (!columns.has(name)) await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
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
    return status();
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
      return existing.id;
    }
    const r = await run(
      'INSERT INTO chat_contacts (nickname, devices, my_code, status, created, last_at) VALUES (?, ?, ?, ?, ?, ?)',
      [player.nickname, JSON.stringify(player.devices), code, STATUS.OUTGOING, t, t],
    );
    return r.lastInsertRowId;
  }

  async function sendControl(contact, type, body) {
    const items = sealDirect({ from: identity, toDevices: contact.devices, type, body });
    await postman.drop(contact.theirCode, items);
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
    return id;
  }

  /** Decline a contact request: it's forgotten; they aren't told. */
  async function declineContact(id) {
    await run('DELETE FROM chat_contacts WHERE id = ? AND status = ?', [id, STATUS.INCOMING]);
  }

  /** Block: take back my drop code, so the postman refuses their envelopes. */
  async function blockContact(id) {
    const c = await contactById(id);
    if (!c) return;
    if (c.status === STATUS.BLOCKED) return;
    if (c.myCode) await postman.codes({ remove: [c.myCode] });
    await run('UPDATE chat_contacts SET status = ?, my_code = NULL, before_block = ? WHERE id = ?', [STATUS.BLOCKED, c.status, id]);
  }

  /** Unblock: a new drop code, sent to them, so they can write again. */
  async function unblockContact(id) {
    const c = await contactById(id);
    if (!c || c.status !== STATUS.BLOCKED) return;
    // A blocked request goes back to being an open request (not accepted).
    if (c.beforeBlock === STATUS.INCOMING && c.theirCode) {
      await run('UPDATE chat_contacts SET status = ?, before_block = NULL WHERE id = ?', [STATUS.INCOMING, id]);
      return;
    }
    // Never accepted by them (or no way to reach them): simply forget it.
    if (c.beforeBlock !== STATUS.ACCEPTED || !c.theirCode) {
      await run('DELETE FROM chat_contacts WHERE id = ?', [id]);
      return;
    }
    const code = await newCode();
    await sendControl(c, 'contact-accept', { nickname: await getMe('nickname'), code, devices: [identity.publicKey] });
    await run('UPDATE chat_contacts SET my_code = ?, status = ?, before_block = NULL WHERE id = ?', [code, STATUS.ACCEPTED, id]);
  }

  /** Remove a contact from the list (blocks them first, so they can't write any more). */
  async function removeContact(id) {
    const c = await contactById(id);
    if (!c) return;
    if (c.myCode) await postman.codes({ remove: [c.myCode] }).catch(() => {});
    await run('DELETE FROM chat_messages WHERE contact = ?', [id]);
    await run('DELETE FROM chat_contacts WHERE id = ?', [id]);
  }

  // --- messages ------------------------------------------------------------

  async function messages(contactId) {
    await run('UPDATE chat_contacts SET unread = 0 WHERE id = ?', [contactId]);
    return (await all('SELECT * FROM chat_messages WHERE contact = ? ORDER BY id', [contactId]))
      .map((m) => ({ id: m.id, mine: !!m.mine, text: m.text, sentAt: m.sent_at, receivedAt: m.received_at }));
  }

  async function sendMessage(contactId, text) {
    const c = await contactById(contactId);
    if (!c || c.status !== STATUS.ACCEPTED || !c.theirCode) throw new Error('You can write once they have accepted.');
    const clean = cleanText(text);
    if (!clean) throw new Error('Nothing to send.');
    const t = now();
    try {
      await sendControl(c, 'text', clean);
    } catch (e) {
      if (e.status === 403) {
        await run('UPDATE chat_contacts SET ended = 1 WHERE id = ?', [contactId]);
        throw new Error(`${c.nickname} isn't receiving your messages any more (they left the chat or blocked you).`);
      }
      throw e;
    }
    await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at) VALUES (?, 1, ?, ?, ?)', [contactId, clean, t, t]);
    await run('UPDATE chat_contacts SET last_at = ?, ended = 0 WHERE id = ?', [t, contactId]);
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

  async function handle(opened) {
    const { from, type } = opened;
    const t = now();
    const known = await contactByDevice(from);

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
      const mine = await first('SELECT * FROM chat_groups WHERE id = ?', [g.id]);
      if (!mine) return 'ignored';
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
      await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at) VALUES (?, 0, ?, ?, ?)',
        [known.id, opened.text, opened.sentAt, t]);
      await run('UPDATE chat_contacts SET last_at = ?, unread = unread + 1 WHERE id = ?', [t, known.id]);
      return 'message';
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
    }
    if (done.length) await postman.mailDone(done);
    await run('DELETE FROM chat_seen WHERE at < ?', [now() - SEEN_KEEP]);
    if (failure) throw failure;
    if (!leaving && (await first('SELECT id FROM chat_groups LIMIT 1'))) await syncGroups();
    return counts;
  }

  /** Leave the chat on this device: the postman forgets it; local chat data is deleted. */
  async function leave() {
    leaving = true;
    try {
      if (mailRun) await mailRun.catch(() => {});
      await postman.leave();
    } catch (e) {
      leaving = false;
      throw e;
    }
    for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES]) await run(`DELETE FROM ${table}`);
    // A new chat key for a fresh start (the old one is forgotten at the postman).
    identity = createIdentity();
    await setMe('identity', identity);
    postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });
    leaving = false;
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
    return { threshold, nfts, allowed: threshold === null || nfts >= threshold };
  }

  async function forgetGroup(id) {
    for (const table of ['chat_group_posts', 'chat_group_last', 'chat_group_recent', 'chat_group_reactions', 'chat_group_names']) await run(`DELETE FROM ${table} WHERE grp = ?`, [id]);
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
        const mine = r.from === identity.publicKey || (myAccount && player === myAccount) ? 1 : 0;
        await run(
          `INSERT INTO chat_group_reactions (grp, pid, player, value, at, mine) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (grp, pid, player) DO UPDATE SET value = excluded.value, at = excluded.at WHERE excluded.at >= chat_group_reactions.at`,
          [g.id, r.target, player, r.value, r.writtenAt, mine],
        );
      }
      const lastAccepted = await recentPosts(g.id);
      const { shown } = acceptPosts(items, { postmanPublicKey: pk, lastAccepted, blocked: blockedDevices, seen, owners: g.owner_account ? [g.owner_account] : [] });
      for (const [author, times] of Object.entries(lastAccepted)) {
        if (!times.length) continue;
        await run('INSERT OR REPLACE INTO chat_group_last (grp, author, at) VALUES (?, ?, ?)', [g.id, author, Math.max(...times)]);
        for (const at of times) await run('INSERT OR IGNORE INTO chat_group_recent (grp, author, at) VALUES (?, ?, ?)', [g.id, author, at]);
      }
      // (Older than two days can't count any more.)
      await run('DELETE FROM chat_group_recent WHERE grp = ? AND at < ?', [g.id, now() - 2 * POST_WINDOW]);
      for (const item of shown) {
        const mine = item.post.from === identity.publicKey;
        await run(
          'INSERT INTO chat_group_posts (grp, seq, pid, author, nickname, text, written_at, received_at, mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [g.id, item.seq, item.post.id ?? null, item.post.from, await authorName(g.id, item.post.from, runState), item.post.text, item.post.writtenAt, item.receivedAt, mine ? 1 : 0],
        );
        if (!mine) added += 1;
      }
      g.last_seq = posts[posts.length - 1].seq;
      await run('UPDATE chat_groups SET last_seq = ?, unread = unread + ? WHERE id = ?', [g.last_seq, added, g.id]);
      total += added;
      if (posts.length < 200) break;
    }
    return total;
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
    for (const there of groups) {
      const g = await first('SELECT * FROM chat_groups WHERE id = ?', [there.id]);
      if (!g) continue;
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
    // (A first guess from the weekly badge; the postman checks the wallet
    // itself when you vote, and again when the vote closes.)
    const badge = await getMe('badge');
    const check = badge ? checkBadge(badge, { postmanPublicKey: await postmanKey(), holder: identity.publicKey, at: now() }) : { ok: false };
    return {
      threshold: r.threshold,
      canVote: check.ok && check.nfts >= r.threshold,
      canOpen: r.canOpen,
      // What this device's sign-in counted (the badge); "Update my holdings"
      // signs in again to refresh it.
      myNfts: check.ok ? check.nfts : 0,
      votes,
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
    return (await all('SELECT * FROM chat_group_posts WHERE grp = ? ORDER BY seq', [id])).map((p) => ({
      id: p.id, pid: p.pid ?? null, mine: !!p.mine, author: p.author, nickname: p.nickname, text: p.text, writtenAt: p.written_at, receivedAt: p.received_at,
      // { counts: { '👍': 2, '👎': 1 }, mine: '👍' | '👎' | '' }
      reactions: (p.pid && reactions.get(p.pid)) || { counts: {}, mine: '' },
    }));
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
      groupLast: await all('SELECT * FROM chat_group_last'),
      groupKeys: await all('SELECT * FROM chat_group_keys'),
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
      for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES]) await run(`DELETE FROM ${table}`);
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
      await run('INSERT INTO chat_group_posts (grp, seq, pid, author, nickname, text, written_at, received_at, mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [p.grp, Number(p.seq) || 0, typeof p.pid === 'string' ? p.pid : null, String(p.author ?? ''), p.nickname ?? null, p.text, Number(p.written_at) || 0, Number(p.received_at) || 0, p.mine ? 1 : 0]);
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
    for (const m of data.messages) {
      const contact = idMap.get(m.contact);
      if (!contact || typeof m.text !== 'string') continue;
      await run('INSERT INTO chat_messages (contact, mine, text, sent_at, received_at) VALUES (?, ?, ?, ?, ?)',
        [contact, m.mine ? 1 : 0, m.text, Number(m.sent_at) || 0, Number(m.received_at) || 0]);
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
      for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me', ...GROUP_TABLES]) await run(`DELETE FROM ${table}`);
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
    nextGroupPostAt,
    setPinned,
    setPins,
    reactToPost,
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
    checkMail,
    leave,
  };
}
