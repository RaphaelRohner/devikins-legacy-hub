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
/** A 48x64 picture in one colour with a darker stripe - well over the
 *  200-byte "that's an error page, not a picture" limit the Hub uses. */
function makePng(seed) {
  const w = 48, h = 64;
  const r = (seed * 67) % 256, g = (seed * 131) % 256, b = (seed * 29) % 256;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const dark = (x + y + seed) % 7 === 0 ? 0.4 : 1;
      row[1 + x * 3] = r * dark; row[2 + x * 3] = g * dark; row[3 + x * 3] = b * dark;
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
    requests: [], // every outside URL the Hub asked for, for checks
    blocked: [], // anything unexpected that was blocked
  };

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost') return route.continue();
    fake.requests.push(url.href);

    // Klever API: which NFTs a wallet holds
    if (url.hostname === 'api.mainnet.klever.org') {
      const m = url.pathname.match(/\/address\/([^/]+)\/collection\/([^/]+)$/);
      if (m) {
        const kind = Object.keys(COLLECTION_IDS).find((k) => COLLECTION_IDS[k] === m[2]);
        const page = Number(url.searchParams.get('page') || 1);
        const items = m[1] === TEST_WALLET && kind && page === 1 ? TEST_NFTS[kind].map((n) => ({ nftNonce: n.nonce })) : [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { collection: items }, code: 'successful' }) });
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
      if (fake.picturesDown) return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Access Denied' });
      const nonce = Number(url.pathname.match(/(\d+)\.png$/)?.[1] || 1);
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: makePng(nonce) });
    }

    fake.blocked.push(url.href);
    return route.abort();
  });

  return fake;
}

module.exports = { installFakeServers, TEST_WALLET, TEST_NFTS, makePng };
