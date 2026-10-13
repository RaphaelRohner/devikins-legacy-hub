/**
 * storageStats.web.js
 *
 * The website version of storageStats.js (the storage line on the Wallets
 * screen). On the phone, each set's database file and picture folder are
 * measured on disk. A browser has no such files, so here:
 *   - each set shows the size of its own data (its database), asked from
 *     SQLite itself;
 *   - the total adds the stored pictures, counted by the Hub itself (they
 *     are shared by all sets, so each counts once). Browsers' own figures
 *     turned out too rough (Safari: 724 MB with nothing stored).
 * Before 12 Oct 2026 the website simply showed "0 MB" everywhere (Raphael
 * noticed it while testing S3).
 */

import { getWalletSetDatabaseBytes } from '../db/database';
import { measureCachedImages } from './webImageCache';

export const AVERAGE_BYTES_PER_NFT = 112 * 1024;
export const STORAGE_WARNING_THRESHOLD_BYTES = 200 * 1024 * 1024; // 200 MB

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
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export async function getWalletSetStorageBytes(walletSet) {
  const dbBytes = await getWalletSetDatabaseBytes(walletSet.db_file_name);
  return { dbBytes, imagesBytes: 0, totalBytes: dbBytes };
}

export async function getStorageBytesForSets(walletSets) {
  const perSet = [];
  let setsTotal = 0;
  for (const set of walletSets) {
    const stats = await getWalletSetStorageBytes(set);
    perSet.push({ id: set.id, ...stats });
    setsTotal += stats.totalBytes;
  }

  // The stored pictures, counted by the Hub itself (all sets share them).
  const pictures = await measureCachedImages(AVERAGE_BYTES_PER_NFT);

  return { perSet, grandTotalBytes: setsTotal + pictures.bytes, includesSharedPictures: true, pictureCount: pictures.count };
}
