// Shared by the chat tests: two (or more) players' Hubs (messenger.js),
// talking to the real postman code (chat/postman) through a pretend network,
// with real Klever wallet signatures.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, signMessageSync, prepareKlvMessage } from '@klever/connect-crypto';
import { bech32Encode } from '@klever/connect-encoding';
import { createMessenger } from '../src/messenger.js';
import { createPostOffice } from '../postman/src/postOffice.js';

export const BASE = 'https://postman.test';

/** Node's SQLite dressed like expo-sqlite's async calls (the Hub's local database). */
export function localDb() {
  const db = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: r.changes };
    },
    async getAllAsync(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
  };
}

/** The postman's own database (like Cloudflare's ctx.storage.sql). */
export function postmanSql() {
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } };
}

export function world() {
  const clock = { t: Date.UTC(2026, 9, 22, 10, 0, 0) };
  const holdings = new Map([['klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf', 1066763]]); // the game account: voting threshold 10
  const office = createPostOffice({
    sql: postmanSql(),
    now: () => clock.t,
    fetchKlever: async (url) => {
      const address = url.split('/address/')[1];
      if (!holdings.has(address)) return new Response('{}', { status: 404 });
      return Response.json({ data: { account: { address, assets: { 'DVKNFT-1SW5': { balance: holdings.get(address) } } } } });
    },
  });
  const network = { down: false };
  const fetchFn = async (url, init = {}) => {
    if (network.down) throw new TypeError('Failed to fetch');
    if (network.directoryDown && url.includes('/directory')) throw new TypeError('Failed to fetch');
    const r = await office.handle({ method: init.method || 'GET', url, bodyText: init.body || '', authorization: init.headers?.Authorization ?? null });
    return Response.json(r.body, { status: r.status });
  };
  async function player(nickname, nfts = 3, sameWalletAs = null, deviceLabel = '') {
    const { privateKey, publicKey } = sameWalletAs ? sameWalletAs.walletKeys : generateKeyPairSync();
    const wallet = bech32Encode(publicKey.bytes, 'klv');
    if (!sameWalletAs) holdings.set(wallet, nfts);
    const db = localDb();
    const m = await createMessenger({ db, postmanUrl: BASE, fetchFn, deviceLabel, now: () => clock.t });
    // (for tests that play a modified Hub: the device's raw key and postman)
    m.db = db;
    const { createPostmanClient } = await import('../src/client.js');
    m.postman = createPostmanClient({ baseUrl: BASE, identity: JSON.parse((await db.getAllAsync("SELECT v FROM chat_me WHERE k = 'identity'"))[0].v), fetchFn, now: () => clock.t });
    const { code, text } = await m.startSignIn();
    const signature = Buffer.from(signMessageSync(prepareKlvMessage(text), privateKey.bytes)).toString('hex');
    const signedIn = await m.finishSignIn({ code, wallet, signature });
    m.walletKeys = { privateKey, publicKey };
    // What the Klever extension does when asked to sign a text:
    m.sign = async (t) => ({ address: wallet, signature: Buffer.from(signMessageSync(prepareKlvMessage(t), privateKey.bytes)).toString('hex') });
    m.wallet = wallet;
    m.holdings = holdings;
    /** "Update my holdings": the wallet now holds `n`, and the player signs in again. */
    m.setHoldings = async (n) => {
      holdings.set(wallet, n);
      const again = await m.startSignIn();
      await m.finishSignIn({ code: again.code, wallet, signature: (await m.sign(again.text)).signature });
    };
    /**
     * Starting a group takes the voting threshold (10 here): players below it
     * hold 10 just long enough to start one (most tests are about other things).
     */
    m.startGroup = async (name, description) => {
      const before = holdings.get(wallet);
      if (before >= 10) return m.createGroup(name, description);
      await m.setHoldings(10);
      const id = await m.createGroup(name, description);
      await m.setHoldings(before);
      return id;
    };
    if (sameWalletAs) return m; // a second browser of the same player
    assert.equal(signedIn.state, 'needs-nickname');
    assert.equal((await m.setNickname(nickname)).state, 'ready');
    return m;
  }
  /** A browser without a chat yet (not signed in). */
  async function blank() {
    const db = localDb();
    const m = await createMessenger({ db, postmanUrl: BASE, fetchFn, now: () => clock.t });
    m.db = db;
    return m;
  }
  /** The postman's alarm: counts the votes whose time is over. */
  async function decide() {
    while (await office.decideAllVotes()) { /* (a few wallets per run) */ }
  }
  return { clock, network, player, blank, decide, office };
}

