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
 * Two quirks worth remembering (see NOTES.md for the full story):
 *
 *   1. This API's own `pagination` object in its response cannot be
 *      trusted - it just echoes back whatever `limit` you asked for, and
 *      `totalRecords` can come back wildly, obviously wrong (millions,
 *      for a collection that doesn't have anywhere near that many
 *      items). So instead of trusting any of `pagination`, we keep
 *      asking for more pages until a page comes back with fewer items
 *      than we asked for - that's the reliable signal that we've
 *      reached the last page.
 *
 *   2. This API hard-caps how deep you can page into ONE address+
 *      collection query: `page * limit` can't exceed 10,000, full stop.
 *      Ask for page 101 at limit=100 and every response is the same
 *      flat `{"error": "result window is too large."}` (HTTP 400) -
 *      confirmed directly against the game's main contract address,
 *      which holds far more than that. This isn't a bug in this app or
 *      a sign of a wrong collection ID - it's Klever's own backend
 *      (an Elasticsearch-style "max result window" limit, going by the
 *      wording) refusing to page any further, and no combination of
 *      `sort`/`order` params or a bigger `limit` gets around it (all
 *      tried, all hit the same error). A wallet holding more than
 *      10,000 of one collection is simply unreachable past its first
 *      10,000 via this endpoint as it exists today.
 */

const KLEVER_API_BASE = 'https://api.mainnet.klever.org/v1.0';
const PAGE_SIZE = 100; // comfortably under the ~100 item silent-truncation point we found

// The exact message Klever's API sends back for quirk #2 above - matched
// so fetchWalletNonces can tell "this wallet genuinely holds more than we
// can list" apart from a real, unexpected failure, and word the message
// each one gets accordingly.
const RESULT_WINDOW_TOO_LARGE_ERROR = 'result window is too large.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches every nonce a wallet holds in one collection. Returns a plain
 * array of numbers, e.g. [5, 1121358, 1122161] - empty if the wallet
 * holds nothing in this collection, which is a completely normal,
 * expected outcome, not a failure.
 *
 * Never throws. If something goes wrong partway through - a real error,
 * or hitting Klever's own 10,000-item pagination ceiling (see this
 * file's header comment) - this stops there and returns whatever it
 * DID manage to gather instead of discarding it, with two extra
 * properties attached to the returned array so callers can tell:
 * `.truncated` (true if this is not the complete list) and
 * `.truncationReason` (a plain-English explanation, or null when
 * `.truncated` is false). Attaching these to the array itself (rather
 * than changing the return shape to `{ nonces, truncated }`) means
 * every existing caller that just reads `.length` or loops over the
 * result keeps working unchanged - only a caller that cares about
 * truncation needs to look for it.
 */
export async function fetchWalletNonces(walletAddress, collectionId) {
  const nonces = [];
  let page = 1;
  let truncated = false;
  let truncationReason = null;

  while (true) {
    const url = `${KLEVER_API_BASE}/address/${walletAddress}/collection/${collectionId}?limit=${PAGE_SIZE}&page=${page}`;

    let response;
    try {
      // Klever's API has been reliable in our testing (unlike the
      // metadata Lambda), but network blips can happen anywhere, so we
      // still retry a couple of times before giving up on this page.
      response = await fetchWithRetry(url, { maxRetries: 2, baseDelayMs: 1000 });
    } catch (err) {
      // Ran out of retries on a real network failure - stop here rather
      // than throwing away every nonce already gathered from the pages
      // that DID work.
      truncated = true;
      truncationReason = err.message;
      break;
    }

    if (response.status === 404) {
      // Some wallets/collections combinations come back as 404 rather
      // than an empty list - treat that the same as "holds nothing
      // here" (not a truncation - there was never anything to list).
      break;
    }

    if (!response.ok) {
      // Try to read the actual error Klever sent back, so the "hit the
      // 10,000-item pagination ceiling" case (see this file's header
      // comment) can get its own plain-English explanation instead of a
      // raw HTTP status code. If the body isn't readable/JSON for some
      // reason, fall back to a generic message rather than failing here.
      let bodyError = null;
      try {
        bodyError = (await response.json())?.error;
      } catch {
        // Not JSON, or already consumed - bodyError stays null below.
      }

      truncated = true;
      truncationReason = bodyError === RESULT_WINDOW_TOO_LARGE_ERROR
        ? `This wallet holds more of this collection than Klever's own API will let us list in one query - only the first ${nonces.length.toLocaleString()} could be fetched.`
        : `Klever API returned HTTP ${response.status} while listing ${collectionId} for this wallet.`;
      break;
    }

    let json;
    try {
      json = await response.json();
    } catch (err) {
      // A 200 that somehow isn't valid JSON - as unexpected as the
      // network-failure case above, handled the same way.
      truncated = true;
      truncationReason = `Couldn't read Klever's response while listing ${collectionId} for this wallet.`;
      break;
    }

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

  nonces.truncated = truncated;
  nonces.truncationReason = truncationReason;
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
