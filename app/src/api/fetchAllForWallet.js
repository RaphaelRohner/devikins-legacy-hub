/**
 * fetchAllForWallet.js
 *
 * This is the "conductor" that runs when the user taps the Fetch button
 * (fetchAllForWallet), and also the one that runs quietly in the
 * background on a timer to clean up anything left unfinished from a
 * previous fetch (retryPendingItems - see App.js for what schedules it).
 * Both share the same per-nonce worker logic below, tying together
 * kleverApi.js (which nonces does the wallet hold), metadataApi.js (what
 * are this NFT's traits), imageStorage.js (download its picture), and
 * database.js (save the result).
 *
 * Three things this file is specifically responsible for, because the
 * project requirements call them out explicitly:
 *
 *   1. Progress reporting: fetching stats for a big wallet can take a
 *      while (each individual NFT lookup can take up to ~47 seconds in
 *      the worst case, if it fails all 5 attempts). The `onProgress`
 *      callback fires every time something meaningful happens, so the UI
 *      can show "Weapons: 12 / 40" instead of leaving the user staring at
 *      a frozen screen wondering if the app crashed.
 *
 *   2. Being gentle with the flaky metadata Lambda: we never fetch more
 *      than CONCURRENCY nonces at the same time. Firing off hundreds of
 *      simultaneous requests would make an already-struggling server even
 *      worse - and likely make our own results worse too.
 *
 *   3. Being interruptible: `shouldCancel` is a function the caller
 *      passes in that returns true once the user wants to stop. We check
 *      it frequently (before starting each new NFT, and between
 *      collections) so a cancel takes effect quickly rather than after
 *      everything already in flight finishes.
 */

import { COLLECTIONS } from '../constants/schema';
import { fetchWalletNonces } from './kleverApi';
import { fetchNftMetadata } from './metadataApi';
import { storeImage } from './imageStorage';
import {
  getExistingStatuses,
  upsertNft,
  getFailedNonces,
  getNoncesMissingCachedImage,
  updateLocalImagePath,
} from '../db/database';

const CONCURRENCY = 4; // "no more than 3-5 parallel requests" - see NOTES.md

/**
 * Fetches full metadata (+ image) for a plain list of nonces in one
 * collection, saving each one as it finishes, using a small worker pool
 * so at most CONCURRENCY requests are in flight at once. This is the
 * shared core both fetchAllForWallet and retryPendingItems use below -
 * they differ only in HOW they come up with the list of nonces to pass
 * in here.
 */
async function fetchAndSaveNonces(kind, label, nonces, ownerAddress, { skippedCount = 0, onProgress, shouldCancel }) {
  let completedCount = 0;
  const totalCount = nonces.length;

  onProgress({ phase: 'fetching', kind, label, completed: completedCount, total: totalCount, skipped: skippedCount });

  if (totalCount === 0) return;

  // A small worker pool: up to CONCURRENCY of these run at once, each
  // pulling the next nonce off the shared queue as soon as it finishes
  // its previous one. This is a common pattern for "do N things at a
  // time" without needing an extra library.
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < nonces.length) {
      if (shouldCancel()) return;

      const nonce = nonces[nextIndex];
      nextIndex += 1;

      const result = await fetchNftMetadata(kind, nonce, shouldCancel);

      if (result.outcome === 'cancelled') {
        // The user tapped Stop while this nonce's request was in
        // flight - nothing to save (it's not a real failure, just
        // interrupted), and this worker is done for good, same as if
        // the shouldCancel() check above had caught it before starting.
        return;
      }

      if (result.outcome === 'ok') {
        // Download the image to the phone's own storage so it's still
        // there even if the image host is briefly slow/unreachable
        // later - see imageStorage.js. A failed download just means we
        // fall back to the remote URL for this item, same as before -
        // and it'll get picked up again next time retryPendingItems
        // runs, since it specifically looks for 'ok' rows missing a
        // cached image.
        const localImagePath = await storeImage(kind, nonce, result.metadata?.image ?? null);
        await upsertNft(kind, { nonce, ownerAddress, status: 'ok', metadata: result.metadata, localImagePath });
      } else if (result.outcome === 'unavailable') {
        await upsertNft(kind, { nonce, ownerAddress, status: 'unavailable', metadata: null });
      } else {
        await upsertNft(kind, { nonce, ownerAddress, status: 'failed', metadata: null });
      }

      completedCount += 1;
      onProgress({ phase: 'fetching', kind, label, completed: completedCount, total: totalCount, skipped: skippedCount });
    }
  }

  const workerCount = Math.min(CONCURRENCY, nonces.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Fetches everything for one wallet address, across all three
 * collections, saving results into the local database as it goes (so
 * even if the user closes the app partway through, whatever finished
 * successfully is already saved).
 *
 * @param {string} walletAddress
 * @param {object} callbacks
 * @param {(progress: object) => void} callbacks.onProgress - called
 *   repeatedly with the current state, e.g.
 *   { phase: 'listing', kind: 'weapon', label: 'Weapons' }
 *   { phase: 'fetching', kind: 'weapon', label: 'Weapons', completed: 3, total: 12, skipped: 1 }
 *   { phase: 'done' }
 * @param {() => boolean} callbacks.shouldCancel - return true to stop
 *   as soon as possible.
 */
export async function fetchAllForWallet(walletAddress, { onProgress, shouldCancel }) {
  for (const kind of Object.keys(COLLECTIONS)) {
    if (shouldCancel()) return;

    const { assetId, label } = COLLECTIONS[kind];

    onProgress({ phase: 'listing', kind, label });

    let nonces;
    try {
      nonces = await fetchWalletNonces(walletAddress, assetId);
    } catch (err) {
      // If even asking "what does this wallet hold" fails, tell the UI
      // about this specific collection's problem and move on to the next
      // collection rather than aborting the whole fetch over one glitch.
      onProgress({ phase: 'error', kind, label, error: err.message });
      continue;
    }

    if (shouldCancel()) return;

    // Don't bother re-fetching nonces we already know are permanently
    // gone (status 'unavailable' - see metadataApi.js for what earns that
    // status). Everything else - never seen before, or previously
    // 'failed', or even previously 'ok' - gets (re)fetched, because trait
    // values like level and slots can genuinely change over time.
    const existingStatuses = await getExistingStatuses(kind, nonces);
    const noncesToFetch = nonces.filter((nonce) => existingStatuses[nonce] !== 'unavailable');
    const skippedCount = nonces.length - noncesToFetch.length;

    await fetchAndSaveNonces(kind, label, noncesToFetch, walletAddress, { skippedCount, onProgress, shouldCancel });

    if (shouldCancel()) return;
  }

  onProgress({ phase: 'done' });
}

/**
 * Retries anything left over in an unfinished state from a previous
 * fetch, WITHOUT re-asking the blockchain what the wallet holds (we
 * already know from the database which nonces need work) - so this is
 * much cheaper than a full fetchAllForWallet run, and safe to run
 * automatically and repeatedly in the background. See App.js for the
 * timer that calls this.
 *
 * Handles two kinds of "unfinished":
 *   1. status = 'failed' - the metadata fetch itself never succeeded.
 *      These get a full retry (metadata + image).
 *   2. status = 'ok' but no cached image yet - the metadata succeeded
 *      last time, but the picture never got downloaded. These only need
 *      the image retried, not the whole metadata fetch again.
 */
export async function retryPendingItems(walletAddress, { onProgress, shouldCancel }) {
  for (const kind of Object.keys(COLLECTIONS)) {
    if (shouldCancel()) return;

    const { label } = COLLECTIONS[kind];

    const failedNonces = await getFailedNonces(kind, walletAddress);
    if (failedNonces.length > 0) {
      await fetchAndSaveNonces(kind, `${label} (NFT refetch)`, failedNonces, walletAddress, { onProgress, shouldCancel });
      if (shouldCancel()) return;
    }

    const missingImageRows = await getNoncesMissingCachedImage(kind, walletAddress);
    if (missingImageRows.length > 0) {
      let completedCount = 0;
      const totalCount = missingImageRows.length;
      const imageLabel = `${label} (image refetch)`;

      onProgress({ phase: 'fetching', kind, label: imageLabel, completed: completedCount, total: totalCount, skipped: 0 });

      for (const row of missingImageRows) {
        if (shouldCancel()) return;

        const localImagePath = await storeImage(kind, row.nonce, row.image);
        if (localImagePath) {
          await updateLocalImagePath(kind, row.nonce, localImagePath);
        }

        completedCount += 1;
        onProgress({ phase: 'fetching', kind, label: imageLabel, completed: completedCount, total: totalCount, skipped: 0 });
      }
    }
  }

  onProgress({ phase: 'done' });
}


/**
 * The multi-wallet version of fetchAllForWallet above - loops over every
 * saved wallet address (see WalletManager.js) one at a time, running a
 * full fetchAllForWallet for each. Deliberately sequential (not done in
 * parallel across wallets) for the same reason fetchAndSaveNonces limits
 * itself to CONCURRENCY requests at once - the metadata Lambda is
 * already flaky under light load (see NOTES.md), so piling multiple
 * wallets' worth of simultaneous requests on top of each other would
 * only make that worse.
 *
 * Every progress update gets `walletAddress`/`walletIndex`/`walletTotal`
 * added to it, so the UI (see ProgressBar.js) can show which of the
 * user's wallets is currently being worked on when there's more than
 * one. Each wallet's own "phase: 'done'" update (from fetchAllForWallet
 * finishing its three collections) is swallowed here unless it's truly
 * the LAST wallet - otherwise the progress bar would flicker away and
 * back between every wallet instead of showing one continuous run.
 */
export async function fetchAllForWallets(walletAddresses, { onProgress, shouldCancel }) {
  const walletTotal = walletAddresses.length;

  for (let i = 0; i < walletTotal; i++) {
    if (shouldCancel()) return;

    const walletAddress = walletAddresses[i];
    const walletIndex = i + 1;

    await fetchAllForWallet(walletAddress, {
      onProgress: (progress) => {
        if (progress.phase === 'done' && walletIndex < walletTotal) return;
        onProgress({ ...progress, walletAddress, walletIndex, walletTotal });
      },
      shouldCancel,
    });

    if (shouldCancel()) return;
  }
}

/**
 * The multi-wallet version of retryPendingItems above - same idea as
 * fetchAllForWallets: loop over every saved wallet, sequentially, tagging
 * each progress update with which wallet it's for.
 */
export async function retryPendingItemsForWallets(walletAddresses, { onProgress, shouldCancel }) {
  const walletTotal = walletAddresses.length;

  for (let i = 0; i < walletTotal; i++) {
    if (shouldCancel()) return;

    const walletAddress = walletAddresses[i];
    const walletIndex = i + 1;

    await retryPendingItems(walletAddress, {
      onProgress: (progress) => {
        if (progress.phase === 'done' && walletIndex < walletTotal) return;
        onProgress({ ...progress, walletAddress, walletIndex, walletTotal });
      },
      shouldCancel,
    });

    if (shouldCancel()) return;
  }
}
