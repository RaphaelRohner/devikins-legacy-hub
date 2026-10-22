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
import { createIdentity, isPublicKey } from './identity.js';
import { sealDirect, openDirect } from './direct.js';
import { cleanText, nicknameKey } from './rules.js';
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
`;

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
    }
    if (done.length) await postman.mailDone(done);
    await run('DELETE FROM chat_seen WHERE at < ?', [now() - SEEN_KEEP]);
    if (failure) throw failure;
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
    for (const table of ['chat_messages', 'chat_contacts', 'chat_seen', 'chat_me']) await run(`DELETE FROM ${table}`);
    // A new chat key for a fresh start (the old one is forgotten at the postman).
    identity = createIdentity();
    await setMe('identity', identity);
    postman = createPostmanClient({ baseUrl: postmanUrl, identity, fetchFn, now });
    leaving = false;
  }

  return {
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
