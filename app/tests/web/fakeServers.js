/**
 * fakeServers.js - pretend versions of every outside server the Hub talks to.
 *
 * During a test the browser never reaches the real internet. Each request
 * the Hub makes is caught here and answered with small, made-up test data:
 *
 *   - Klever's API ("which NFTs does this wallet hold?")
 *   - the Hub's Cloudflare relay (NFT details, the anonymous user counter)
 *   - the Moonlabs picture servers (imgweapon / imgequipment / img.devikins.com)
 *
 * Anything else is blocked, so a test can never put load on a real server.
 * The test can also "switch off" the picture server (fake.picturesDown) to
 * check what the Hub shows when Moonlabs' images are unavailable.
 */
const zlib = require('node:zlib');

// A public, valid Klever address used only as test input (it's the Hub's
// donation address, already published in the code). Its "holdings" below
// are made up - nothing real is fetched.
const TEST_WALLET = 'klv170t523zjwkvc8j0k0smgysevegx0ddwjxx4nu2xpcsy7e3jvdccsh2m2sg';

const COLLECTION_IDS = { devikin: 'DVKNFT-1SW5', weapon: 'DVKWPNFT-169T', equipment: 'DVKEQNFT-1Q56' };

const IMAGE_URL = {
  devikin: (n) => `https://img.devikins.com/devikin/${n}.png`,
  weapon: (n) => `https://imgweapon.devikins.com/0/${n}.png`,
  equipment: (n) => `https://imgequipment.devikins.com/0/${n}.png`,
};

// The made-up collection: two of each kind.
const TEST_NFTS = {
  devikin: [
    { nonce: 101, name: 'Testy the Brave #101', attributes: { Rarity: 'Rare', Ancestry: 'Faery', 'Life Stage': 'Adult', 'Procreations Left': 3 } },
    { nonce: 102, name: 'Mock the Mighty #102', attributes: { Rarity: 'Common', Ancestry: 'Demon', 'Life Stage': 'Adult', 'Procreations Left': 0 } },
  ],
  weapon: [
    { nonce: 201, name: 'Fine Test Hammer #201', attributes: { Rarity: 'Uncommon', Type: 'Hammer', Quality: 'Fine', 'Icon Image': 'Weapons/hammer_uncommon.png' } },
    { nonce: 202, name: 'Decent Test Wand #202', attributes: { Rarity: 'Common', Type: 'Wand', Quality: 'Decent', 'Icon Image': 'Weapons/wand_common.png' } },
  ],
  equipment: [
    { nonce: 301, name: 'Excellent Test Socks #301', attributes: { Rarity: 'Rare', Type: 'Socks', Quality: 'Excellent', Protection: 12 } },
    { nonce: 302, name: 'Decent Test Necklace #302', attributes: { Rarity: 'Common', Type: 'Necklace', Quality: 'Decent', Protection: 4 } },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
}

function metadataFor(kind, nft) {
  return {
    name: nft.name,
    description: `Made-up ${kind} for the Hub's automatic tests.`,
    image: IMAGE_URL[kind](nft.nonce),
    attributes: Object.entries(nft.attributes).map(([trait_type, value]) => ({ trait_type, value })),
  };
}

// ---- A tiny PNG maker, so every test NFT gets its own real picture ----
function crc32(buf) {
  return zlib.crc32(buf); // built into Node 22 and newer
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
/** A 48x64 test picture (well over the 200-byte "that's an error page,
 *  not a picture" limit the Hub uses). style:
 *   'item'       coloured background with a dark-outlined item in the
 *                middle - what a real NFT picture looks like
 *   'background' only the coloured background (a blank, Moonlabs-style)
 *   'white'      plain white (the other kind of blank) */
function makePng(seed, style = 'item') {
  const w = 48, h = 64;
  const r = 120 + ((seed * 67) % 120), g = 120 + ((seed * 131) % 120), b = 120 + ((seed * 29) % 120);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let px = [r, g, b];
      if (style === 'white') px = [255, 255, 255];
      else if (style === 'item') {
        const inBox = x >= 14 && x <= 34 && y >= 18 && y <= 50;
        const onEdge = inBox && (x <= 16 || x >= 32 || y <= 20 || y >= 48);
        if (onEdge) px = [10, 10, 10]; // the dark outline
        else if (inBox) px = [200, 60, 60];
      }
      row[1 + x * 3] = px[0]; row[2 + x * 3] = px[1]; row[3 + x * 3] = px[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Installs the pretend servers on a Playwright browser context (all tabs).
 * Returns an object the test can use to change behaviour and to see what
 * was requested.
 */
async function installFakeServers(context) {
  const fake = {
    picturesDown: false, // true = picture servers answer "403 access denied"
    blankPictures: new Map(), // picture URL -> 'white' | 'background' | 'missing'
    requests: [], // every outside URL the Hub asked for, for checks
    blocked: [], // anything unexpected that was blocked
    // A tiny pretend blockchain for the withdrawal tracker:
    //   holders: "weapon:3265" -> address that holds it now
    //   transfers: [{ hash, kind, nonce, from, to, timestamp (seconds) }]
    chain: { holders: new Map(), transfers: [] },
  };

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost') return route.continue();
    fake.requests.push(url.href);

    if (url.hostname === 'api.mainnet.klever.org') {
      // Which NFTs a wallet holds
      let m = url.pathname.match(/\/address\/([^/]+)\/collection\/([^/]+)$/);
      if (m) {
        const kind = Object.keys(COLLECTION_IDS).find((k) => COLLECTION_IDS[k] === m[2]);
        const page = Number(url.searchParams.get('page') || 1);
        let nonces = [];
        if (kind && page === 1) {
          if (m[1] === TEST_WALLET) nonces = TEST_NFTS[kind].map((n) => n.nonce);
          else nonces = [...fake.chain.holders].filter(([k, a]) => a === m[1] && k.startsWith(kind + ':')).map(([k]) => Number(k.split(':')[1]));
        }
        return json(route, { data: { collection: nonces.map((nftNonce) => ({ nftNonce, balance: 1 })) }, code: 'successful' });
      }
      // Who holds one NFT
      m = url.pathname.match(/\/assets\/nft\/holder\/([^/]+)\/(\d+)$/);
      if (m) {
        const kind = Object.keys(COLLECTION_IDS).find((k) => COLLECTION_IDS[k] === m[1]);
        const holder = fake.chain.holders.get(`${kind}:${m[2]}`);
        if (!holder) return json(route, { data: null, error: 'not found', code: 'internal_issue' }, 404);
        return json(route, { data: { account: { address: holder } }, code: 'successful' });
      }
      // Transfers into a wallet (newest first)
      if (url.pathname === '/v1.0/transaction/list') {
        const to = url.searchParams.get('toAddress');
        const txs = fake.chain.transfers
          .filter((t) => t.to === to)
          .sort((a, b) => b.timestamp - a.timestamp)
          .map((t) => ({
            hash: t.hash,
            sender: t.from,
            timestamp: t.timestamp,
            status: 'success',
            receipts: [
              { assetId: `${COLLECTION_IDS[t.kind]}/${t.nonce}`, assetType: 'NonFungible', collection: COLLECTION_IDS[t.kind], from: t.from, to: t.to, nonce: String(t.nonce), typeString: 'Transfer', value: 1 },
            ],
          }));
        return json(route, { data: { transactions: txs }, pagination: { totalPages: 1 }, code: 'successful' });
      }
    }

    // The Hub's relay: NFT details and the anonymous user counter
    if (url.hostname === 'devi-hub-relay.raphaelrohner.workers.dev') {
      const m = url.pathname.match(/^\/(devikin|weapon|equipment)\/(\d+)$/);
      if (m) {
        const nft = TEST_NFTS[m[1]].find((n) => n.nonce === Number(m[2]));
        if (!nft) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metadataFor(m[1], nft)) });
      }
      if (url.pathname === '/ping') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/stats') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ today: 1, last7Days: 4, last30Days: 7, total: 12, visits: { today: 3, last7Days: 15, last30Days: 40, total: 61 }, last30DaysByPlatform: { web: 5, android: 2 } }) });
      }
    }

    // Moonlabs picture servers
    if (/^img(weapon|equipment)?\.devikins\.com$/.test(url.hostname)) {
      const special = fake.blankPictures.get(url.href);
      if (fake.picturesDown || special === 'missing') return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Access Denied' });
      const nonce = Number(url.pathname.match(/(\d+)\.png$/)?.[1] || 1);
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: makePng(nonce, special || 'item') });
    }

    fake.blocked.push(url.href);
    return route.abort();
  });

  return fake;
}

/** Made-up but well-formed Klever addresses for the withdrawal tests. */
function fakeAddress(letter) {
  return 'klv1' + letter.repeat(58);
}
const GAME_MAIN_WALLET = 'klv1a35lsdqvsmk370ujzjc4js2666kvp7wukumtjejj7ze8ehde5slqe0uvpf';

module.exports = { installFakeServers, TEST_WALLET, TEST_NFTS, makePng, fakeAddress, GAME_MAIN_WALLET, IMAGE_URL };
