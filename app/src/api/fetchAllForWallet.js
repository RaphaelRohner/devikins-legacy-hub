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
import { storeImage, fetchImageEtag } from './imageStorage';
import {
  getExistingStatuses,
  upsertNft,
  getFailedNonces,
  getNoncesMissingCachedImage,
  updateLocalImagePath,
  getCachedImageRows,
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
        const { localImagePath, etag } = await storeImage(kind, nonce, result.metadata?.image ?? null);
        await upsertNft(kind, { nonce, ownerAddress, status: 'ok', metadata: result.metadata, localImagePath, imageEtag: etag });
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

        const { localImagePath, etag } = await storeImage(kind, row.nonce, row.image);
        if (localImagePath) {
          await updateLocalImagePath(kind, row.nonce, localImagePath, etag);
        }

        completedCount += 1;
        onProgress({ phase: 'fetching', kind, label: imageLabel, completed: completedCount, total: totalCount, skipped: 0 });
      }
    }
  }

  onProgress({ phase: 'done' });
}

/**
 * The other half of the automatic background maintenance (see App.js's
 * timer for how this gets scheduled): periodically asks "did Moonlabs
 * change any already-downloaded picture?" for every cached image across
 * all of a wallet's NFTs, using a cheap HTTP HEAD request per image (see
 * imageStorage.js's fetchImageEtag) rather than re-downloading anything
 * just to check. A cheaply-confirmed real change forces a real
 * re-download (storeImage's forceRedownload); an image with no ETag on
 * record yet (anything cached before this feature existed) just gets
 * today's ETag backfilled, without assuming it changed, so future
 * checks have something to compare against; anything inconclusive
 * (network hiccup, host sent no ETag) is left alone entirely and tried
 * again next time.
 *
 * Deliberately its own separate pass, not folded into
 * retryPendingItemsForWallets above - that one exists to fix broken/
 * missing fetches quickly (fast burst, then hourly), while this one is
 * about a rare, low-urgency event (the game studio correcting artwork),
 * so it runs on its own plain hourly cadence regardless of whether
 * there's anything else pending. See App.js for how the two share one
 * timer without stepping on each other.
 */
export async function checkImageFreshnessForWallets(walletAddresses, { onProgress, shouldCancel }) {
  const walletTotal = walletAddresses.length;

  for (let i = 0; i < walletTotal; i++) {
    if (shouldCancel()) return;

    const walletAddress = walletAddresses[i];
    const walletIndex = i + 1;

    for (const kind of Object.keys(COLLECTIONS)) {
      if (shouldCancel()) return;

      const { label } = COLLECTIONS[kind];
      const rows = await getCachedImageRows(kind, walletAddress);
      if (rows.length === 0) continue;

      let completedCount = 0;
      const totalCount = rows.length;
      const checkLabel = `${label} (image check)`;

      // Tagged with walletIndex/walletTotal the same way
      // fetchAllForWallets/retryPendingItemsForWallets do, so a multi-
      // wallet setup's tap-to-detail text says which wallet this is for
      // instead of looking like just one is taking a long time.
      onProgress({
        phase: 'fetching', kind, label: checkLabel, completed: completedCount, total: totalCount, skipped: 0,
        walletAddress, walletIndex, walletTotal,
      });

      for (const row of rows) {
        if (shouldCancel()) return;

        const currentEtag = await fetchImageEtag(row.image);

        if (!currentEtag) {
          // Inconclusive - couldn't ask, or the host didn't answer with
          // one. Leave this row exactly as it is and try again next time.
        } else if (!row.image_etag) {
          // Nothing on record to compare against yet (downloaded before
          // this column existed) - record today's ETag for next time,
          // without assuming the already-cached file is wrong.
          await updateLocalImagePath(kind, row.nonce, row.local_image_path, currentEtag);
        } else if (currentEtag !== row.image_etag) {
          // Confirmed changed - force a real re-download and save its
          // new ETag too.
          const { localImagePath, etag } = await storeImage(kind, row.nonce, row.image, { forceRedownload: true });
          if (localImagePath) {
            await updateLocalImagePath(kind, row.nonce, localImagePath, etag);
          }
        }

        completedCount += 1;
        onProgress({
          phase: 'fetching', kind, label: checkLabel, completed: completedCount, total: totalCount, skipped: 0,
          walletAddress, walletIndex, walletTotal,
        });
      }
    }

    if (shouldCancel()) return;
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
 * A lightweight "how big would this scan be" pass - used by App.js's
 * handleFetchPress to warn before a manual Fetch/Update that's likely
 * to add a lot of storage (see storageStats.js's
 * STORAGE_WARNING_THRESHOLD_BYTES/AVERAGE_BYTES_PER_NFT for how the
 * count this returns gets turned into a projected byte size and a
 * decision to actually warn). The main contract address is the obvious
 * way this could happen by accident - it holds roughly 94% of the
 * entire characters collection (see klever-api-endpoints.md's wallets
 * section) - but any address holding a lot of NFTs the app hasn't seen
 * yet would trigger the same warning.
 *
 * Reuses the exact same "what does this wallet hold" + "what do we
 * already have" logic fetchAllForWallet's own listing phase uses, just
 * without ever going on to actually download anything - cheap compared
 * to a real fetch (no metadata lookups, no image downloads), but NOT
 * free: it still has to ask the blockchain for every nonce each wallet
 * holds, the same call the real fetch makes right after it. For a
 * wallet holding tens of thousands of NFTs, that alone can take a
 * little while - deliberately accepted, since finding that out before
 * committing to the real fetch (and its storage) is the whole point.
 *
 * Returns the number of nonces, across every wallet and collection,
 * that don't already have a locally-saved 'ok' row - i.e. ones the real
 * fetch is actually likely to download a fresh image for. Already-'ok'
 * nonces are excluded because storeImage's own "already have a good
 * copy" fast path (see imageStorage.js) means re-fetching them normally
 * won't trigger a new download; already-'unavailable' ones are excluded
 * because the real fetch skips them entirely too (see
 * fetchAllForWallet's own noncesToFetch filter above). Not meant to be
 * exact down to the NFT - just close enough to reliably catch "this
 * scan is about to add a lot of storage" before it happens.
 */
export async function estimateNewNftCountForWallets(walletAddresses, { shouldCancel } = {}) {
  let newCount = 0;

  for (const walletAddress of walletAddresses) {
    for (const kind of Object.keys(COLLECTIONS)) {
      if (shouldCancel && shouldCancel()) return newCount;

      const { assetId } = COLLECTIONS[kind];

      let nonces;
      try {
        nonces = await fetchWalletNonces(walletAddress, assetId);
      } catch (err) {
        // Same spirit as fetchAllForWallet's own listing phase: one
        // collection failing to list shouldn't block the estimate for
        // everything else - it just can't count what it couldn't see,
        // so this likely undercounts slightly rather than overcounting.
        continue;
      }

      const existingStatuses = await getExistingStatuses(kind, nonces);
      for (const nonce of nonces) {
        const status = existingStatuses[nonce];
        if (status === 'unavailable') continue;
        if (status !== 'ok') newCount += 1;
      }
    }
  }

  return newCount;
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
