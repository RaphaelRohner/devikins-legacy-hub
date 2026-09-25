/**
 * storageStats.js
 *
 * Answers two closely related questions Raphael raised after testing
 * with ~3,000 NFTs across several wallet sets: "how much space is the
 * app actually using right now" (see WalletManager.js's per-set/total
 * display), and "how much would a given scan add" (see
 * fetchAllForWallet.js's estimateNewNftCountForWallets, used by App.js's
 * handleFetchPress to warn before a scan that's likely to use a lot of
 * storage - the main contract address being the obvious way someone
 * could trigger that by accident).
 *
 * Every wallet set (see database.js's "Wallet sets" section) is exactly
 * two things on disk: one SQLite database file, and one folder of
 * downloaded images (see imageStorage.js) - nothing else the app writes
 * counts toward a set's own footprint. So "how much space does this set
 * use" is just those two sizes added together, no estimation needed for
 * the CURRENT-usage side of this file - only the projected-future-usage
 * side (below) has to guess, since it's asking about NFTs that haven't
 * been fetched yet.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

// How many files to stat at once when summing up an images folder - the
// same "small worker pool" idea fetchAllForWallet.js uses for network
// requests (see its own CONCURRENCY comment), just applied to local
// filesystem calls instead. A wallet set built from a big scan can have
// thousands of image files in it, and stat-ing them one at a time would
// make this screen noticeably slow to open.
const SIZE_CHECK_CONCURRENCY = 8;

// Raphael's own real-world number: about 600MB across roughly 3,000
// NFTs after a round of testing that included several wallet sets built
// from random Kleverscan holder addresses (2026-09-25) - which works out
// to a bit under 200KB per NFT (almost entirely the downloaded image;
// each NFT's own database row is well under 1KB, negligible next to
// its picture). Used only to PROJECT how big an upcoming scan might be
// before it happens (see estimateNewNftCountForWallets below) - the
// actual current-usage numbers this file also computes are always real
// measured bytes, never this estimate. This doesn't need to be exact,
// just close enough to reliably catch "this scan is about to add a lot
// of storage" - see STORAGE_WARNING_THRESHOLD_BYTES below for where
// that line is drawn.
export const AVERAGE_BYTES_PER_NFT = 200 * 1024;

// The line a projected scan has to cross before App.js's handleFetchPress
// interrupts with a confirmation instead of just proceeding quietly, per
// Raphael's own suggestion after the "how does Android handle app
// storage" conversation.
export const STORAGE_WARNING_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GB

/**
 * Turns a raw byte count into something readable ("640 MB", "1.2 GB") -
 * shared by WalletManager.js's per-set/total display and App.js's
 * pre-scan warning, so both describe sizes the same way.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // Whole numbers once a value's in the double digits or higher read
  // cleaner than a fake-precise decimal ("12.0 MB") - one decimal place
  // only while the number's still small enough that it actually helps
  // ("1.2 GB" vs "12 GB").
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

// Mirrors expo-sqlite's own (internal, not exported) createDatabasePath
// - see node_modules/expo-sqlite/src/pathUtils.ts. Not calling that
// function directly since it isn't part of the package's public exports,
// but SQLite.defaultDatabaseDirectory itself is (re-exported from
// SQLiteDatabase.ts), and every db_file_name this app ever hands
// openDatabaseAsync/deleteDatabaseAsync is a plain flat filename with no
// leading slash - so joining the two the same way that internal helper
// does is enough to reconstruct exactly where a given set's database
// file actually lives on disk, including for a set that isn't the
// currently active one (and so has no open connection to ask directly).
function databaseFilePath(dbFileName) {
  const dir = (SQLite.defaultDatabaseDirectory || '').replace(/\/*$/, '');
  return `${dir}/${dbFileName}`;
}

async function fileSizeBytes(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory ? info.size || 0 : 0;
  } catch {
    // Missing/unreadable file (e.g. a set that was created but never
    // actually fetched into, so its database file doesn't exist as an
    // actual file yet) - treat that as zero bytes rather than throwing,
    // same "safe no-op on nothing to look at" spirit as
    // deleteStoredImagesForDir in imageStorage.js.
    return 0;
  }
}

async function directorySizeBytes(dirUri) {
  let fileNames;
  try {
    const dirInfo = await FileSystem.getInfoAsync(dirUri);
    if (!dirInfo.exists) return 0;
    fileNames = await FileSystem.readDirectoryAsync(dirUri);
  } catch {
    return 0;
  }

  if (fileNames.length === 0) return 0;

  let total = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < fileNames.length) {
      const name = fileNames[nextIndex];
      nextIndex += 1;
      total += await fileSizeBytes(`${dirUri}${name}`);
    }
  }
  const workerCount = Math.min(SIZE_CHECK_CONCURRENCY, fileNames.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return total;
}

/**
 * The real, measured storage footprint of one wallet set - its database
 * file's size plus every file in its images folder, added together.
 * Works on any set (not just the active one), since both pieces are
 * plain files on disk identified by name, not by which connection
 * happens to be open right now.
 */
export async function getWalletSetStorageBytes(walletSet) {
  const [dbBytes, imagesBytes] = await Promise.all([
    fileSizeBytes(databaseFilePath(walletSet.db_file_name)),
    directorySizeBytes(`${FileSystem.documentDirectory}${walletSet.images_dir_name}/`),
  ]);
  return { dbBytes, imagesBytes, totalBytes: dbBytes + imagesBytes };
}

/**
 * The same thing across every wallet set at once, plus a grand total -
 * what WalletManager.js's Wallet sets screen actually renders. Runs one
 * set at a time (each set's own images-folder stat-ing already runs
 * with its own internal concurrency above) rather than piling every
 * set's file checks on top of each other simultaneously.
 */
export async function getStorageBytesForSets(walletSets) {
  const perSet = [];
  let grandTotalBytes = 0;

  for (const set of walletSets) {
    const stats = await getWalletSetStorageBytes(set);
    perSet.push({ id: set.id, ...stats });
    grandTotalBytes += stats.totalBytes;
  }

  return { perSet, grandTotalBytes };
}
