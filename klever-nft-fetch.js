/**
 * klever-nft-fetch.js
 *
 * Fetches Devikins NFT metadata from the AWS Lambda metadata API, with:
 *   - Automatic retries using exponential backoff (1s, then 2s, then 4s)
 *   - A concurrency cap, so we never fire dozens of parallel requests at a
 *     Lambda that's already slow/cold-starting
 *
 * Background: the metadata endpoint
 *   https://1fl8e08843.execute-api.us-east-1.amazonaws.com/<collection>/<nonce>
 * is flaky — it times out on a "cold" first request but works fine once it's
 * warm. Retrying with backoff instead of failing immediately (or hammering
 * it with instant retries) is the standard fix for this kind of behavior.
 *
 * Requires Node.js 18+ (uses the built-in `fetch`). No extra packages needed.
 *
 * Run directly to see it in action:
 *   node klever-nft-fetch.js
 *
 * Or import the functions into your app:
 *   const { fetchNftMetadata, fetchNftMetadataBatch } = require('./klever-nft-fetch');
 */

// ---- Config ----

const METADATA_BASE = 'https://1fl8e08843.execute-api.us-east-1.amazonaws.com';

// Devikins collection name -> URL slug used by the metadata API.
const COLLECTION_SLUGS = {
  characters: 'devikin',
  weapons: 'weapon',
  equipment: 'equipment',
};

const DEFAULT_MAX_RETRIES = 3;       // total attempts = 1 + this (so 4 tries total)
const DEFAULT_BASE_DELAY_MS = 1000;  // backoff: 1s, 2s, 4s
const DEFAULT_CONCURRENCY = 5;       // max requests in flight at once
const DEFAULT_TIMEOUT_MS = 10000;    // give the Lambda 10s per attempt before giving up

// ---- Small helpers ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single URL as JSON, retrying with exponential backoff on failure.
 * Retries on network errors, timeouts, and non-2xx HTTP responses.
 */
async function fetchJsonWithRetry(url, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err.name === 'AbortError' ? new Error(`Timed out after ${timeoutMs}ms`) : err;

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) break;

      const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s, ...
      console.warn(
        `[retry] ${url} failed (${lastError.message}). Retrying in ${delay}ms ` +
        `(attempt ${attempt + 1}/${maxRetries})...`
      );
      await sleep(delay);
    }
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries + 1} attempt(s): ${lastError.message}`);
}

/**
 * Run an array of task functions (each returning a promise) with at most
 * `limit` running at the same time. Never rejects as a whole — each task's
 * outcome is captured individually so one failure doesn't sink the batch.
 */
async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await tasks[currentIndex]() };
      } catch (error) {
        results[currentIndex] = { status: 'rejected', reason: error };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ---- Public API ----

/**
 * Fetch metadata (name, image, attributes/traits) for a single NFT.
 *
 * @param {'characters'|'weapons'|'equipment'} collection
 * @param {number|string} nonce - the NFT's token number, e.g. 1
 * @param {object} [options] - passed through to fetchJsonWithRetry
 *   (maxRetries, baseDelayMs, timeoutMs)
 */
async function fetchNftMetadata(collection, nonce, options = {}) {
  const slug = COLLECTION_SLUGS[collection];
  if (!slug) {
    throw new Error(
      `Unknown collection "${collection}". Use one of: ${Object.keys(COLLECTION_SLUGS).join(', ')}`
    );
  }
  const url = `${METADATA_BASE}/${slug}/${nonce}`;
  return fetchJsonWithRetry(url, options);
}

/**
 * Fetch metadata for many NFTs at once, with a concurrency cap so we don't
 * fire a wall of parallel requests at the Lambda while it's cold-starting.
 *
 * @param {'characters'|'weapons'|'equipment'} collection
 * @param {(number|string)[]} nonces
 * @param {object} [options]
 * @param {number} [options.concurrency=5]
 * @returns {Promise<Array<{nonce, metadata?: object, error?: string}>>}
 *   One entry per nonce, in the same order as the input array.
 */
async function fetchNftMetadataBatch(collection, nonces, options = {}) {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const tasks = nonces.map((nonce) => async () => {
    const metadata = await fetchNftMetadata(collection, nonce, options);
    return { nonce, metadata };
  });

  const settled = await runWithConcurrencyLimit(tasks, concurrency);

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    return { nonce: nonces[i], error: result.reason.message };
  });
}

module.exports = {
  fetchNftMetadata,
  fetchNftMetadataBatch,
  fetchJsonWithRetry,
  COLLECTION_SLUGS,
};

// ---- Example run (only executes when you run `node klever-nft-fetch.js` directly) ----

if (require.main === module) {
  (async () => {
    console.log('Fetching Devikin characters #1, #2, #3 (retry + concurrency cap in action)...\n');

    const results = await fetchNftMetadataBatch('characters', [1, 2, 3], { concurrency: 3 });

    for (const result of results) {
      if (result.metadata) {
        const rarity = result.metadata.attributes.find((a) => a.trait_type === 'Rarity')?.value ?? 'Unknown';
        console.log(`OK   #${result.nonce}: ${result.metadata.name} - Rarity: ${rarity}`);
      } else {
        console.log(`FAIL #${result.nonce}: ${result.error}`);
      }
    }
  })();
}
