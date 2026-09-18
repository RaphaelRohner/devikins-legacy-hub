/**
 * kleverApi.js
 *
 * Talks to Klever's public blockchain API to answer one question: "which
 * NFT numbers (nonces) does this wallet currently hold, in this
 * collection?" This tells us WHICH NFTs to look up - it does NOT tell us
 * anything about their traits/stats. That's metadataApi.js's job.
 *
 * Endpoint used:
 *   GET https://api.mainnet.klever.org/v1.0/address/{address}/collection/{collectionID}
 *
 * A quirk worth remembering (see NOTES.md for the full story): this API's
 * own `pagination` object in its response cannot be trusted at high page
 * sizes - it just echoes back whatever `limit` you asked for, even when it
 * silently returned fewer rows than that. So instead of trusting
 * `pagination.totalPages`, we keep asking for more pages until a page
 * comes back with fewer items than we asked for - that's the reliable
 * signal that we've reached the last page.
 */

const KLEVER_API_BASE = 'https://api.mainnet.klever.org/v1.0';
const PAGE_SIZE = 100; // comfortably under the ~100 item silent-truncation point we found

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches every nonce a wallet holds in one collection. Returns a plain
 * array of numbers, e.g. [5, 1121358, 1122161]. Returns an empty array
 * (not an error) if the wallet holds nothing in this collection - that's
 * a completely normal, expected outcome, not a failure.
 */
export async function fetchWalletNonces(walletAddress, collectionId) {
  const nonces = [];
  let page = 1;

  while (true) {
    const url = `${KLEVER_API_BASE}/address/${walletAddress}/collection/${collectionId}?limit=${PAGE_SIZE}&page=${page}`;

    // Klever's API has been reliable in our testing (unlike the metadata
    // Lambda), but network blips can happen anywhere, so we still retry a
    // couple of times before giving up and telling the user something's
    // wrong.
    const response = await fetchWithRetry(url, { maxRetries: 2, baseDelayMs: 1000 });

    if (response.status === 404) {
      // Some wallets/collections combinations come back as 404 rather
      // than an empty list - treat that the same as "holds nothing here".
      break;
    }

    if (!response.ok) {
      throw new Error(`Klever API returned HTTP ${response.status} while listing ${collectionId} for this wallet.`);
    }

    const json = await response.json();
    const items = json?.data?.collection ?? [];

    for (const item of items) {
      if (typeof item.nftNonce === 'number') {
        nonces.push(item.nftNonce);
      }
    }

    if (items.length < PAGE_SIZE) {
      // Got fewer than a full page back - this was the last page.
      break;
    }
    page += 1;
  }

  return nonces;
}

async function fetchWithRetry(url, { maxRetries, baseDelayMs }) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}
