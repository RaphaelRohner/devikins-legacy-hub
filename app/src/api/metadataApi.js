/**
 * metadataApi.js
 *
 * Talks to the (unofficial, unreliable) AWS Lambda that serves each NFT's
 * actual traits/stats/image. This is the ONLY source for that information
 * - Klever's own blockchain API never returns game traits, only ownership.
 *
 * Endpoint used:
 *   GET https://1fl8e08843.execute-api.us-east-1.amazonaws.com/{kind}/{nonce}
 *   e.g. .../devikin/1, .../weapon/100, .../equipment/1
 *
 * This backend is known to be slow and flaky (our own testing found
 * roughly a 1-in-10 chance of any single request timing out or erroring,
 * even for perfectly normal NFTs - see NOTES.md). So this file is built
 * around one central idea: distinguish TWO very different kinds of
 * failure, because they need opposite handling:
 *
 *   1. PERMANENT failure (HTTP 404 - "not found"): this specific NFT has
 *      no metadata record at all. Retrying won't help; it will never
 *      succeed. We return { outcome: 'unavailable' } so the caller can
 *      remember this and never waste time retrying it again.
 *
 *   2. TRANSIENT failure (timeout, HTTP 5xx server errors, dropped
 *      connections): this is the Lambda just being unreliable right now.
 *      The SAME nonce might work fine 30 seconds from now. We retry these
 *      automatically with exponential backoff (waiting 1s, then 2s, then
 *      4s, then 8s between attempts) before finally giving up and
 *      returning { outcome: 'failed' } - which, unlike 'unavailable', WILL
 *      be retried again on a future fetch, since the problem was probably
 *      temporary.
 *
 * A single NFT can take up to about a minute in the worst case (5
 * attempts, each with a 10-second timeout, plus the waits between them) -
 * which is exactly why the optional `shouldCancel` this function accepts
 * matters: without it, tapping "Stop" mid-request would look like it did
 * nothing for up to that long, since nothing would check for a cancel
 * until the current nonce's retry sequence finished on its own. With it,
 * an in-flight request is aborted and any remaining backoff wait is cut
 * short within a fraction of a second of the user tapping Stop.
 */

const METADATA_API_BASE = 'https://1fl8e08843.execute-api.us-east-1.amazonaws.com';

// "Exponential backoff" means each retry waits longer than the last -
// giving a struggling server progressively more breathing room instead of
// hammering it at a constant rate. 1s, 2s, 4s, 8s = 4 retries (5 attempts
// total per NFT, in the worst case).
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10000; // give each individual attempt 10 seconds before treating it as a timeout

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Like sleep(), but wakes up early (well before `ms` is up) if
// `shouldCancel` starts returning true - checked every 100ms rather than
// waiting out the full backoff delay. Used for the pauses BETWEEN retry
// attempts; the in-flight request itself is made abortable separately,
// below.
async function cancellableSleep(ms, shouldCancel) {
  const stepMs = 100;
  let waited = 0;
  while (waited < ms) {
    if (shouldCancel && shouldCancel()) return;
    const thisStep = Math.min(stepMs, ms - waited);
    await sleep(thisStep);
    waited += thisStep;
  }
}

/**
 * Fetches one NFT's metadata (name, image, attributes). Never throws -
 * always resolves to one of:
 *   { outcome: 'ok', metadata: {...} }
 *   { outcome: 'unavailable' }              (permanent - HTTP 404)
 *   { outcome: 'failed', error: 'message' } (transient - retries exhausted)
 *   { outcome: 'cancelled' }                (the user tapped Stop)
 *
 * `kind` is one of 'devikin' | 'weapon' | 'equipment' (matches the URL
 * segment the Lambda expects, and also our database table names).
 *
 * `shouldCancel` is optional - a function returning true once the user
 * wants to stop (see fetchAllForWallet.js). When provided, it's checked
 * before every attempt, used to abort a request that's already in
 * flight, and used to cut short the wait between retries - see the file
 * comment above for why this matters.
 */
export async function fetchNftMetadata(kind, nonce, shouldCancel) {
  let lastErrorMessage = 'unknown error';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (shouldCancel && shouldCancel()) return { outcome: 'cancelled' };

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

    // Also abort this specific attempt (not just time it out) if the
    // user cancels while it's in flight - checked every 100ms, same
    // granularity as cancellableSleep below, so a cancel is felt almost
    // immediately regardless of which stage of the request it happens
    // during.
    const cancelPollId = shouldCancel
      ? setInterval(() => {
          if (shouldCancel()) abortController.abort();
        }, 100)
      : null;

    try {
      const response = await fetch(`${METADATA_API_BASE}/${kind}/${nonce}`, {
        signal: abortController.signal,
      });
      clearTimeout(timeoutId);
      if (cancelPollId) clearInterval(cancelPollId);

      if (shouldCancel && shouldCancel()) return { outcome: 'cancelled' };

      if (response.status === 404) {
        return { outcome: 'unavailable' };
      }

      if (!response.ok) {
        // A non-404 error status (500, 502, 503, etc) - this is the
        // "transient" bucket, so we fall through to the retry logic below
        // rather than giving up immediately.
        throw new Error(`HTTP ${response.status}`);
      }

      const metadata = await response.json();
      return { outcome: 'ok', metadata };
    } catch (err) {
      clearTimeout(timeoutId);
      if (cancelPollId) clearInterval(cancelPollId);

      // An abort triggered by OUR OWN cancel-poll above (not the normal
      // 10-second timeout) means the user tapped Stop, not that the
      // request was slow - report that distinctly rather than as a
      // retryable failure.
      if (err.name === 'AbortError' && shouldCancel && shouldCancel()) {
        return { outcome: 'cancelled' };
      }

      lastErrorMessage = err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message;

      const isLastAttempt = attempt === MAX_RETRIES;
      if (isLastAttempt) break;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await cancellableSleep(delay, shouldCancel);
      if (shouldCancel && shouldCancel()) return { outcome: 'cancelled' };
    }
  }

  return { outcome: 'failed', error: lastErrorMessage };
}
