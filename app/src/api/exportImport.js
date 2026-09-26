/**
 * exportImport.js
 *
 * V3.1: lets Raphael get a wallet set's entire data - its wallets'
 * fetched Devikins/Weapons/Equipment, their custom names/ratings/
 * comments, and every downloaded image - OUT of the app as a single
 * file, and back IN again later. Raised as its own feature (separate
 * from the still-pending background-scan work) for two concrete
 * reasons: moving to a new phone without re-fetching everything from
 * scratch, and making his own testing easier (export a known-good set
 * once, then import it back instead of re-running a real multi-minute
 * fetch every time).
 *
 * What "a wallet set" actually IS on disk (see database.js's own
 * "Wallet sets" section, and storageStats.js's file comment) is exactly
 * two things: one SQLite database file, and one folder of downloaded
 * images - nothing else. So export is just "bundle those two things
 * into a zip," and import is "unzip them back into a new set's own
 * files, then register it" - deliberately NOT a row-by-row JSON dump of
 * every table, which would need to know about every column this app
 * has ever added (see database.js's own ensureColumn history) and get
 * every one of them exactly right to avoid silently losing data. A
 * plain file copy can't get any of that wrong, since it doesn't have to
 * know what's inside those files at all.
 *
 * Zip library choice: `jszip` (the obvious first choice) was ruled out
 * - it pulls in `readable-stream` (a userland reimplementation of
 * Node's own `stream` module) as a real dependency, and Metro (Expo's
 * bundler) has a spotty history of correctly following that package's
 * own browser-field remapping meant to avoid Node's `stream` in
 * non-Node environments - a real, previously-reported failure mode for
 * other people trying to use jszip from Expo. `fflate` has ZERO
 * dependencies of its own (confirmed via its own published package.json
 * before adding it here) - nothing for a bundler to get wrong - and
 * works directly with plain Uint8Array in and out, which is exactly
 * what reading/writing raw files as bytes needs anyway.
 *
 * KNOWN, NOT-YET-FULLY-TESTED RISK: everything below builds the whole
 * zip in memory before writing it out (fflate's zipSync/unzipSync are
 * both all-at-once, not streaming) - for Raphael's own real ~9,500-NFT
 * wallet set (roughly 130MB of images, per the storage-warning
 * correction above in NOTES.md/storageStats.js), that means holding
 * something in the neighborhood of a few hundred MB in memory at once
 * (the raw image bytes, plus the zip's own output buffer, plus
 * temporary base64 strings along the way - see uint8ArrayToBase64/
 * base64ToUint8Array below for why base64 is involved at all). This is
 * exactly the scale Raphael's real wallet sets reach, so it's meant to
 * be tested directly against them rather than assumed safe - if it
 * turns out to fail on his biggest set, the fix would most likely be
 * splitting a huge export into several smaller zips rather than
 * switching libraries again.
 *
 * expo-file-system's writeAsStringAsync/readAsStringAsync only speak
 * plain text or base64 strings, not raw bytes (no ArrayBuffer/Uint8Array
 * read or write in this SDK's file API) - so every file this module
 * touches has to cross that base64 boundary somewhere. Rather than
 * relying on a global `atob`/`btoa` (not guaranteed to exist in every
 * Hermes/RN version) or pulling in yet another dependency just for
 * this, uint8ArrayToBase64/base64ToUint8Array below are small,
 * dependency-free implementations of that one conversion.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { getWalletSetDatabasePath } from './storageStats';
import { checkpointWalletSetForExport, registerImportedWalletSet } from '../db/database';

// Bumped only if a future change to what's INSIDE an export (the shape
// of manifest.json, what folders/files exist) would need the import
// side to tell an old-style export apart from a new one. Not tied to
// the app's own version number in app.json/package.json - this only
// describes the export FILE FORMAT, which can easily stay stable across
// several app versions in a row.
const EXPORT_FORMAT_VERSION = 1;

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// How many bytes of raw input to turn into base64 per inner loop before
// pushing the result onto an array and moving on - kept a clean multiple
// of 3 (base64 works in 3-byte -> 4-character groups) so no chunk ever
// needs its own padding characters, only the very last one might. Doing
// this in chunks and joining once at the end, rather than one giant
// string built up with += over millions of iterations, is a lot easier
// on the JS engine for a large file (see this file's own header comment
// on why a big wallet set's export can mean tens of millions of these
// tiny steps).
const BASE64_CHUNK_BYTES = 3 * 20000;

function uint8ArrayToBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunkEnd = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    let chunkStr = '';
    for (let i = offset; i < chunkEnd; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < chunkEnd ? bytes[i + 1] : 0;
      const b2 = i + 2 < chunkEnd ? bytes[i + 2] : 0;
      const triple = (b0 << 16) | (b1 << 8) | b2;
      chunkStr += BASE64_CHARS[(triple >> 18) & 0x3f];
      chunkStr += BASE64_CHARS[(triple >> 12) & 0x3f];
      chunkStr += i + 1 < chunkEnd ? BASE64_CHARS[(triple >> 6) & 0x3f] : '=';
      chunkStr += i + 2 < chunkEnd ? BASE64_CHARS[triple & 0x3f] : '=';
    }
    chunks.push(chunkStr);
  }
  return chunks.join('');
}

const BASE64_LOOKUP = (() => {
  const lookup = new Uint8Array(256);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) {
    lookup[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return lookup;
})();

function base64ToUint8Array(base64) {
  // Defensive: strip anything that isn't a real base64 character - some
  // sources (a value that passed through more than one system) can pick
  // up stray whitespace/newlines that would otherwise throw the whole
  // decode off by however many characters got added.
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  let paddingCount = 0;
  if (clean.endsWith('==')) paddingCount = 2;
  else if (clean.endsWith('=')) paddingCount = 1;

  const outputLength = Math.floor(clean.length / 4) * 3 - paddingCount;
  const output = new Uint8Array(Math.max(outputLength, 0));
  let outPos = 0;

  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)];
    const c1 = BASE64_LOOKUP[clean.charCodeAt(i + 1)];
    const isPad2 = clean.charCodeAt(i + 2) === 61; // '='
    const isPad3 = clean.charCodeAt(i + 3) === 61; // '='
    const c2 = isPad2 ? 0 : BASE64_LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = isPad3 ? 0 : BASE64_LOOKUP[clean.charCodeAt(i + 3)];
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outPos < output.length) output[outPos++] = (triple >> 16) & 0xff;
    if (outPos < output.length) output[outPos++] = (triple >> 8) & 0xff;
    if (outPos < output.length) output[outPos++] = triple & 0xff;
  }

  return output;
}

async function readFileBytes(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return base64ToUint8Array(base64);
}

async function writeFileBytes(uri, bytes) {
  const base64 = uint8ArrayToBase64(bytes);
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
}

// Turns a wallet set's name into something safe to use as a zip-internal
// folder name or part of a real filename on disk - strips anything that
// isn't a plain letter/number/space/dash/underscore, then collapses
// spaces into dashes. Falls back to a generic name rather than an empty
// string if a set's name is somehow nothing but punctuation/emoji.
function sanitizeForFileName(name) {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'wallet-set';
}

function timestampForFileName() {
  // e.g. "2026-09-26-1432" - sortable, human-readable, and never
  // collides with a previous export from the same set unless two are
  // made in the same minute.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Reads one wallet set's database file and every image in its images
 * folder into a flat { zipPath: [Uint8Array, options] } map ready to
 * hand to fflate's zipSync, plus a manifest.json describing what's in
 * it. `pathPrefix` is '' for a standalone single-set export (files sit
 * at the zip's root) or 'set-<id>-<name>/' when this set is one of
 * several bundled together by exportAllWalletSets below.
 *
 * Compression level 0 (store, no compression) everywhere on purpose -
 * images are already in a compressed format (JPEG/PNG/WebP), so
 * spending CPU time running DEFLATE over them again would barely
 * shrink the file while making a large export noticeably slower. Speed
 * and low memory pressure matter a lot more here than a few percent of
 * file size (see this file's header comment on the real risk already
 * being memory, not disk space).
 *
 * `onProgress`, if given, is called with a plain object describing what
 * phase this is currently in - see exportWalletSet/exportAllWalletSets
 * below for how the Wallets screen turns that into a status line.
 */
async function buildWalletSetEntries(walletSet, pathPrefix, onProgress) {
  await checkpointWalletSetForExport(walletSet.db_file_name);

  const entries = {};
  const dbPath = getWalletSetDatabasePath(walletSet.db_file_name);
  const dbInfo = await FileSystem.getInfoAsync(dbPath);
  if (dbInfo.exists) {
    const dbBytes = await readFileBytes(dbPath);
    entries[`${pathPrefix}database.db`] = [dbBytes, { level: 0 }];
  }

  const imagesDirUri = `${FileSystem.documentDirectory}${walletSet.images_dir_name}/`;
  const imagesDirInfo = await FileSystem.getInfoAsync(imagesDirUri);
  let imageCount = 0;
  if (imagesDirInfo.exists) {
    const fileNames = await FileSystem.readDirectoryAsync(imagesDirUri);
    for (let i = 0; i < fileNames.length; i += 1) {
      const fileName = fileNames[i];
      onProgress?.({ phase: 'reading-images', setName: walletSet.name, current: i + 1, total: fileNames.length });
      const bytes = await readFileBytes(`${imagesDirUri}${fileName}`);
      entries[`${pathPrefix}images/${fileName}`] = [bytes, { level: 0 }];
      imageCount += 1;
    }
  }

  const manifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name: walletSet.name,
    hasDatabase: dbInfo.exists,
    imageCount,
  };
  entries[`${pathPrefix}manifest.json`] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 0 }];

  return entries;
}

/**
 * Builds and writes a zip for exactly one wallet set - manifest.json,
 * database.db, and an images/ folder, all at the zip's root. The file
 * is written into expo-file-system's cache directory (a plain,
 * ordinary local file, not yet visible to Raphael anywhere) - see
 * presentSaveOrShareChoice in WalletManager.js for what happens to it
 * next (Save to a folder he picks, and/or Share via the OS share sheet
 * - his own explicit request to support both rather than picking one).
 */
export async function exportWalletSet(walletSet, { onProgress } = {}) {
  const entries = await buildWalletSetEntries(walletSet, '', onProgress);
  onProgress?.({ phase: 'zipping', setName: walletSet.name });
  const zipped = zipSync(entries);
  const fileName = `devikins-${sanitizeForFileName(walletSet.name)}-${timestampForFileName()}.zip`;
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  onProgress?.({ phase: 'writing', setName: walletSet.name });
  await writeFileBytes(fileUri, zipped);
  return { fileUri, fileName };
}

/**
 * Same idea as exportWalletSet, but for every wallet set at once - each
 * set gets its own `set-<id>-<name>/` folder inside a single zip (its
 * own manifest.json/database.db/images/ underneath), plus one top-level
 * export-manifest.json listing which sets are in here. That id in the
 * folder name (not just the sanitized name) is what keeps two
 * differently-set-up sets that happen to share a display name from
 * colliding into the same folder.
 */
export async function exportAllWalletSets(walletSets, { onProgress } = {}) {
  const entries = {};
  const setSummaries = [];

  for (const walletSet of walletSets) {
    const pathPrefix = `set-${walletSet.id}-${sanitizeForFileName(walletSet.name)}/`;
    const setEntries = await buildWalletSetEntries(walletSet, pathPrefix, onProgress);
    Object.assign(entries, setEntries);
    setSummaries.push({ id: walletSet.id, name: walletSet.name });
  }

  entries['export-manifest.json'] = [
    strToU8(JSON.stringify(
      { formatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), sets: setSummaries },
      null,
      2
    )),
    { level: 0 },
  ];

  onProgress?.({ phase: 'zipping' });
  const zipped = zipSync(entries);
  const fileName = `devikins-all-sets-${timestampForFileName()}.zip`;
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  onProgress?.({ phase: 'writing' });
  await writeFileBytes(fileUri, zipped);
  return { fileUri, fileName };
}

/**
 * Opens the OS share sheet for an already-built export file - "Share"
 * in Raphael's own two-option request (see WalletManager.js). Works on
 * both Android and iOS; on iOS, this is ALSO how saving to the Files
 * app happens, since the share sheet itself offers "Save to Files" as
 * one of its own options there (iOS has no separate folder-picker API
 * the way Android's StorageAccessFramework does - see
 * saveExportedFileToFolder below, which is Android-only for that
 * reason).
 */
export async function shareExportedFile(fileUri) {
  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, { mimeType: 'application/zip', dialogTitle: 'Save or send this export' });
}

/**
 * "Save to a folder" (Android only - see shareExportedFile above for
 * why iOS doesn't need its own version of this) - asks Android for a
 * folder via its own native picker (StorageAccessFramework), then
 * copies the already-built export file into it under its real filename.
 * Returns false (not an error) if Raphael backs out of the folder
 * picker without choosing anything.
 */
export async function saveExportedFileToFolder(fileUri, fileName) {
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) {
    return false;
  }
  const destUri = await FileSystem.StorageAccessFramework.createFileAsync(
    permissions.directoryUri,
    fileName,
    'application/zip'
  );
  // Copies via base64 rather than rebuilding the zip a second time -
  // the file at fileUri (expo-file-system's cache dir) is already the
  // exact bytes we want, this just moves them into the folder Raphael
  // picked.
  const base64Content = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  await FileSystem.writeAsStringAsync(destUri, base64Content, { encoding: FileSystem.EncodingType.Base64 });
  return true;
}

// Splits unzipSync's flat { "set-3-my-wallets/images/devikin-1.jpg": ... }
// map into one flat map per top-level folder - { "set-3-my-wallets": {
// "images/devikin-1.jpg": ... } } - so an "export all sets" zip's
// several bundled sets can each be handed to importOneSetFromFlatFiles
// below one at a time, the exact same way a standalone single-set
// export already is. Any file sitting at the zip's own root (like
// export-manifest.json itself, or a stray single-set export's own
// manifest.json/database.db) has no folder to belong to and is simply
// skipped here - a single-set export's flat files are passed to
// importOneSetFromFlatFiles directly instead, never through this.
function groupFilesByTopFolder(flatFiles) {
  const groups = {};
  for (const path of Object.keys(flatFiles)) {
    const slashIndex = path.indexOf('/');
    if (slashIndex === -1) continue;
    const folder = path.slice(0, slashIndex);
    const rest = path.slice(slashIndex + 1);
    if (!rest) continue;
    if (!groups[folder]) groups[folder] = {};
    groups[folder][rest] = flatFiles[path];
  }
  return groups;
}

/**
 * Writes one set's worth of extracted files (a flat { "database.db":
 * bytes, "images/x.jpg": bytes, "manifest.json": bytes } map - either a
 * whole standalone export, or one folder's worth pulled out of an
 * "export all" bundle by groupFilesByTopFolder above) to brand new,
 * never-used-before db/images filenames, then registers the result as a
 * new wallet set (see registerImportedWalletSet's own comment in
 * database.js for why this doesn't just reuse the original filenames -
 * they could collide with a set that already exists on THIS phone).
 * Returns the new set's display name, or throws if this folder doesn't
 * actually look like a wallet set export at all (no manifest.json).
 */
async function importOneSetFromFlatFiles(filesForOneSet) {
  const manifestBytes = filesForOneSet['manifest.json'];
  if (!manifestBytes) {
    throw new Error("Missing manifest.json - this doesn't look like a Devikins wallet set export.");
  }
  const manifest = JSON.parse(strFromU8(manifestBytes));

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const dbFileName = `devikins-import-${suffix}.db`;
  const imagesDirName = `nft-images-import-${suffix}`;

  const dbBytes = filesForOneSet['database.db'];
  if (dbBytes) {
    await writeFileBytes(getWalletSetDatabasePath(dbFileName), dbBytes);
  }

  const imageEntries = Object.keys(filesForOneSet).filter((path) => path.startsWith('images/') && path.length > 'images/'.length);
  if (imageEntries.length > 0) {
    const imagesDirUri = `${FileSystem.documentDirectory}${imagesDirName}/`;
    await FileSystem.makeDirectoryAsync(imagesDirUri, { intermediates: true });
    for (const path of imageEntries) {
      const fileName = path.slice('images/'.length);
      await writeFileBytes(`${imagesDirUri}${fileName}`, filesForOneSet[path]);
    }
  }

  const importedName = `${manifest.name || 'Imported set'} (imported)`;
  await registerImportedWalletSet(importedName, dbFileName, imagesDirName);
  return importedName;
}

/**
 * The whole import flow: opens the OS document picker so Raphael can
 * pick a .zip he previously exported (from this phone, or copied over
 * from another one), figures out whether it's a single-set export or an
 * "export all" bundle, writes out and registers a brand-new wallet set
 * for each one found, and returns the list of new sets' display names.
 * Returns null (not an error) if he backs out of the file picker
 * without choosing anything.
 *
 * Deliberately does NOT switch to any imported set, or touch whatever
 * set is currently active - see registerImportedWalletSet's own comment
 * in database.js.
 */
export async function pickAndImportWalletSetsZip({ onProgress } = {}) {
  const pickResult = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (pickResult.canceled || !pickResult.assets?.[0]) {
    return null;
  }

  const pickedUri = pickResult.assets[0].uri;
  onProgress?.({ phase: 'reading' });
  const zipBytes = await readFileBytes(pickedUri);

  onProgress?.({ phase: 'unzipping' });
  const flatFiles = unzipSync(zipBytes);

  const importedNames = [];

  if (flatFiles['export-manifest.json']) {
    const groups = groupFilesByTopFolder(flatFiles);
    for (const folderName of Object.keys(groups)) {
      const importedName = await importOneSetFromFlatFiles(groups[folderName]);
      importedNames.push(importedName);
    }
  } else if (flatFiles['manifest.json']) {
    const importedName = await importOneSetFromFlatFiles(flatFiles);
    importedNames.push(importedName);
  } else {
    throw new Error("This doesn't look like a Devikins wallet set export - no manifest.json found in it.");
  }

  return importedNames;
}

// Re-exported purely so WalletManager.js can check "does this platform
// even have a folder-picker option" without importing react-native's
// Platform a second time for one boolean - see its own
// presentSaveOrShareChoice, which only offers the "Save to folder"
// button at all when this is true.
export const supportsSaveToFolder = Platform.OS === 'android';
