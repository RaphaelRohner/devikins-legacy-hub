/**
 * chatPostman.mjs - the REAL chat postman code (app/chat/postman) as a tiny
 * local server for the website tests (chat.spec.js starts it). Only
 * Cloudflare and Klever's API are pretend: the postman's database is
 * Node's built-in SQLite, and the test wallets are real Ed25519 keys made
 * with Klever's own library.
 *
 * Besides the postman's own requests it answers two test-only ones:
 *   POST /__test/wallet {nfts}         → a new wallet holding that many Devikins
 *   POST /__test/sign {address, text}  → that wallet's signature of the text
 *   POST /__test/holdings {address, nfts} → the wallet now holds that many
 * Prints "ready <port>" when it's listening.
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, signMessageSync, prepareKlvMessage } from '@klever/connect-crypto';
import { bech32Encode } from '@klever/connect-encoding';
import { createPostOffice } from '../../chat/postman/src/postOffice.js';

const POSTMAN = 'https://devi-postman-test.raphaelrohner.workers.dev';
const db = new DatabaseSync(':memory:');
// The game account's holdings set the voting threshold (1,066,763 → 10 Devikins).
const holdings = new Map([['klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf', 1066763]]);
const wallets = new Map();
const office = createPostOffice({
  sql: { exec: (q, ...p) => { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } },
  fetchKlever: async (url) => {
    const address = url.split('/address/')[1];
    if (!holdings.has(address)) return new Response('{}', { status: 404 });
    return Response.json({ data: { account: { address, assets: { 'DVKNFT-1SW5': { balance: holdings.get(address) } } } } });
  },
});

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/__test/wallet') {
    const { nfts } = JSON.parse(bodyText);
    const { privateKey, publicKey } = generateKeyPairSync();
    const address = bech32Encode(publicKey.bytes, 'klv');
    holdings.set(address, nfts);
    wallets.set(address, privateKey.bytes);
    return send(200, { address });
  }
  if (req.url === '/__test/holdings') {
    const { address, nfts } = JSON.parse(bodyText);
    holdings.set(address, nfts);
    return send(200, { ok: true });
  }
  if (req.url === '/__test/sign') {
    const { address, text } = JSON.parse(bodyText);
    const signature = Buffer.from(signMessageSync(prepareKlvMessage(text), wallets.get(address))).toString('hex');
    return send(200, { signature });
  }
  // A postman request, forwarded by the test with its original address.
  const r = await office.handle({
    method: req.method,
    url: POSTMAN + req.url,
    bodyText,
    authorization: req.headers.authorization ?? null,
  });
  return send(r.status, r.body);
});
server.listen(0, '127.0.0.1', () => console.log(`ready ${server.address().port}`));
