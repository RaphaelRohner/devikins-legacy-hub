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

// Corrected AGAIN (2026-09-26), and this time the previous "measured"
// figure it was corrected FROM turned out to be wrong too - not because
// anyone mismeasured anything, but because getStorageBytesForSets below
// had a real bug (a classic JS lost-update race across concurrent
// workers - see directorySizeBytes's own comment) that silently threw
// away most of what it was supposed to be adding up. The 129MB/14KB-
// per-NFT figure the previous version of this comment cited was itself
// a symptom of that bug, not a real measurement - the SAME three wallet
// sets, once the race was fixed, actually came out to just over 1GB
// (1024MB across 9,702 saved images: 54MB + 18MB + 952MB), roughly
// 108KB/NFT, not 14KB - about 7.7x higher. 112KB/NFT here keeps a
// little headroom above that measured ~108KB rather than using it
// exactly, same spirit as this constant's very first correction. Used
// only to PROJECT how big an upcoming scan might be before it happens
// (see estimateNewNftCountForWallets below) - the actual current-usage
// numbers this file also computes are always real measured bytes, never
// this estimate (and can no longer undercount the way they used to).
export const AVERAGE_BYTES_PER_NFT = 112 * 1024;

// The line a projected scan has to cross before App.js's handleFetchPress
// interrupts with a confirmation instead of just proceeding quietly.
// Originally set at 1GB per Raphael's own suggestion, then lowered to
// 200MB (2026-09-25) once AVERAGE_BYTES_PER_NFT's correction at the time
// made clear 1GB would need roughly 75,000 new NFTs to ever be reached -
// more than the entire Devikins collection had minted, so a warning that
// could realistically never fire. That 75,000 figure is now known to
// have been wrong too (see AVERAGE_BYTES_PER_NFT's own comment above,
// 2026-09-26) - with the corrected ~112KB/NFT, 200MB is actually only
// about 1,800 new NFTs away, well within reach of a single big scan.
// Raphael's own call once shown the corrected math: keep the line at
// 200MB anyway - still a meaningful amount of storage to warn about
// before spending it, corrected estimate or not.
export const STORAGE_WARNING_THRESHOLD_BYTES = 200 * 1024 * 1024; // 200 MB

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
//
// THE REAL BUG, FOUND (2026-09-26) by reading expo-file-system's own
// Android source directly (node_modules/expo-file-system/android/src/
// main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt) -
// this superseded TWO earlier guesses, both wrong, about a "/data/data/"
// vs "/data/user/0/" directory-form mismatch. The real story is much
// simpler: SQLite.defaultDatabaseDirectory returns a bare filesystem
// path with NO "file://" scheme at all (its native Android definition is
// literally just `context.filesDir.canonicalPath + "/SQLite"` - see
// node_modules/expo-sqlite/android/.../SQLiteModule.kt). Compare that to
// FileSystem.documentDirectory, which every image this app reads/writes
// goes through and which has ALWAYS worked - its own native definition
// is `Uri.fromFile(filesDirectory).toString() + "/"`, which always
// produces a real "file://" URI.
//
// expo-file-system's native getInfoAsync/readAsStringAsync/
// writeAsStringAsync all call `Uri.parse(...)` on whatever string
// they're given and branch on its `scheme`. With a real "file" scheme,
// they read/write/stat the actual file, exactly as expected - this is
// the only path images have ever taken. With NO scheme at all (exactly
// what a bare path like SQLite.defaultDatabaseDirectory produces),
// they take a completely different branch instead: reads get treated as
// a request to open an ANDROID RESOURCE by name (meant for bundled app
// assets, not real files - see FileSystemLegacyModule.kt's
// openResourceInputStream), which fails for a real absolute path and
// gets silently swallowed into "exists: false"; writes are refused
// outright ("Unsupported scheme for location..."). THAT - not which of
// Android's two equivalent internal path forms was used - is why every
// wallet set's own database file has been invisible to expo-file-system
// this whole time: the storage-size calculation below has been silently
// reporting 0 bytes for every set's database (hidden by images
// dwarfing it in the total - see AVERAGE_BYTES_PER_NFT's own comment
// above), and every export has produced a zip with no database.db in it
// at all (see NOTES.md's write-up). It also explains why the earlier
// "/data/data/" <-> "/data/user/0/" swap fix changed nothing at all:
// both forms are equally missing the scheme, so both were equally
// broken.
//
// The actual fix: always build this path as a real file:// URI, the
// same format FileSystem.documentDirectory already uses successfully.
export function getWalletSetDatabasePath(dbFileName) {
  const dir = (SQLite.defaultDatabaseDirectory || '').replace(/\/*$/, '');
  return `file://${dir}/${dbFileName}`;
}

/**
 * Historically this did extra work trying a second, alternate directory
 * form when the first one came back "missing" (see the two now-corrected
 * guesses in getWalletSetDatabasePath's own comment above) - now that
 * getWalletSetDatabasePath itself returns a real, correctly-scoped
 * file:// URI, there's nothing left to fall back to. Kept as a thin
 * pass-through purely so exportImport.js's existing import/call sites
 * don't need to change again.
 */
export async function resolveExistingWalletSetDatabasePath(dbFileName) {
  return getWalletSetDatabasePath(dbFileName);
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

/**
 * FOUND AND FIXED (2026-09-26): this used to accumulate into one shared
 * `total` via `total += await fileSizeBytes(...)` from several
 * concurrent workers - a classic lost-update race. `total += await X`
 * reads the CURRENT value of `total` before awaiting X, so if two
 * workers are both "in flight" at once, whichever one finishes its
 * await and writes back last wins, silently discarding the other's
 * contribution. With SIZE_CHECK_CONCURRENCY workers all racing on the
 * same variable, this was throwing away roughly (concurrency-1) out of
 * every `concurrency` file sizes - not occasionally, structurally, any
 * time two of the 8 workers' getInfoAsync calls overlapped, which for
 * thousands of files was effectively always.
 *
 * This is what was actually behind Raphael's real, reported mismatch:
 * the app's own "Total storage used" said 129MB across all sets, but
 * exporting them for real (exportImport.js, which reads every file's
 * bytes directly, with no shared-variable summing at all) came out to
 * 1.08GB - and a smaller, easier-to-check single set ("Test 1") showed
 * the same pattern exactly: computed at 2.1MB here, but 18.7MB when
 * actually exported, three separate times. Confirmed via temporary
 * per-file logging that every individual getInfoAsync call was already
 * returning the correct size (zero files came back missing or
 * zero-byte) - the individual reads were fine, only the summing itself
 * was wrong, which pointed straight at this race rather than anything
 * about the files or the read calls themselves.
 *
 * Fixed by giving each worker its OWN local running total (a plain
 * local variable, never shared or raced) and only adding the workers'
 * totals together once every one of them has completely finished - see
 * Promise.all below. `nextIndex` staying shared is fine: reading it and
 * incrementing it happens in the same synchronous step with no `await`
 * in between, so JS's single-threaded execution already makes that part
 * atomic - it was only a statement spanning an `await` that could be
 * interleaved.
 */
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

  let nextIndex = 0;
  async function worker() {
    let workerTotal = 0;
    while (nextIndex < fileNames.length) {
      const name = fileNames[nextIndex];
      nextIndex += 1;
      workerTotal += await fileSizeBytes(`${dirUri}${name}`);
    }
    return workerTotal;
  }
  const workerCount = Math.min(SIZE_CHECK_CONCURRENCY, fileNames.length);
  const workerTotals = await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return workerTotals.reduce((sum, t) => sum + t, 0);
}

/**
 * The real, measured storage footprint of one wallet set - its database
 * file's size plus every file in its images folder, added together.
 * Works on any set (not just the active one), since both pieces are
 * plain files on disk identified by name, not by which connection
 * happens to be open right now.
 */
export async function getWalletSetStorageBytes(walletSet) {
  const [dbPath, imagesBytes] = await Promise.all([
    resolveExistingWalletSetDatabasePath(walletSet.db_file_name),
    directorySizeBytes(`${FileSystem.documentDirectory}${walletSet.images_dir_name}/`),
  ]);
  const dbBytes = await fileSizeBytes(dbPath);
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
