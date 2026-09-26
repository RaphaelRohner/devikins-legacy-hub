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
 * before adding it here) - nothing for a bundler to get wrong.
 *
 * STREAMING, NOT ALL-AT-ONCE (revised 2026-09-26): the first version of
 * this file used fflate's all-at-once `zipSync`/`unzipSync` - simpler to
 * write, but it meant holding an entire wallet set's raw image bytes,
 * PLUS the whole zip's output buffer, all in memory simultaneously
 * before writing a single byte to disk. Raphael actually tried "Export
 * all sets" against his real ~9,500-NFT set (roughly 130MB of images)
 * and confirmed this was a real, not just theoretical, problem: the
 * progress label froze right after the last image finished reading, and
 * a few minutes later the whole Expo Go process got killed and dropped
 * back to its QR-scan home screen - no JS error, no console output,
 * exactly what an Android out-of-memory kill of the whole app process
 * looks like from the outside, rather than something this app's own
 * try/catch could ever have caught.
 *
 * Fixed by switching to fflate's STREAMING classes (`Zip`/`ZipPassThrough`
 * for writing, `Unzip`/`UnzipPassThrough` for reading) instead of the
 * all-at-once functions - see StreamingFileWriter/StreamingZipWriter
 * below. Both directions now process the archive in bounded-size
 * windows (~4MB at a time, WRITE_FLUSH_THRESHOLD_BYTES/READ_CHUNK_BYTES
 * below) rather than the whole thing at once - peak memory is now
 * roughly "one chunk's worth" regardless of how many thousands of
 * images are involved, not "the whole wallet set's worth." Still worth
 * testing against Raphael's real large set again to confirm this
 * actually holds up in practice, but this addresses the specific,
 * reproduced failure directly rather than just lowering the odds of it.
 *
 * Export format (changed in this same revision): single-set and
 * "export all" zips now share exactly one shape - a top-level
 * `export-manifest.json` plus one `set-<id>-<name>/` folder per
 * included set (manifest.json/database.db/images/ underneath) - rather
 * than single-set exports being a special flat case. This isn't just
 * tidiness: it lets the streaming importer below use one code path for
 * both instead of two, which matters a lot more once the "read
 * everything, then figure out its shape" approach (fine for a small
 * in-memory map) is no longer how this reads files at all.
 *
 * expo-file-system's writeAsStringAsync/readAsStringAsync only speak
 * plain text or base64 strings, not raw bytes (no ArrayBuffer/Uint8Array
 * read or write in this SDK's file API) - so every file this module
 * touches has to cross that base64 boundary somewhere. Rather than
 * relying on a global `atob`/`btoa` (not guaranteed to exist in every
 * Hermes/RN version) or pulling in yet another dependency just for
 * this, uint8ArrayToBase64/base64ToUint8Array below are small,
 * dependency-free implementations of that one conversion - written so
 * they can be called once per chunk without producing spurious padding
 * in the middle of a stream (see StreamingFileWriter's own comment).
 * Reading/writing in bounded chunks also relies on
 * FileSystem.readAsStringAsync's `position`/`length` options and
 * writeAsStringAsync's `append` option - both confirmed present in the
 * installed expo-file-system version before relying on them here.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import { Zip, ZipPassThrough, Unzip, UnzipPassThrough, strToU8, strFromU8 } from 'fflate';
import { getWalletSetDatabasePath } from './storageStats';
import { checkpointWalletSetForExport, registerImportedWalletSet } from '../db/database';

// Bumped only if a future change to what's INSIDE an export (the shape
// of manifest.json, what folders/files exist) would need the import
// side to tell an old-style export apart from a new one. Not tied to
// the app's own version number in app.json/package.json - this only
// describes the export FILE FORMAT, which can easily stay stable across
// several app versions in a row.
const EXPORT_FORMAT_VERSION = 2;

// How much raw data to buffer in memory, on either side, before
// actually reading from or writing to disk - see this file's header
// comment for why this exists at all. 4MB keeps peak memory small
// (a few times this, accounting for the base64 string a chunk this
// size produces) while keeping the number of separate native
// read/write calls for a large export in the tens rather than the
// thousands (one per file would work too, but a lot more slowly).
const STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ArrayToBase64(bytes) {
  // Callers only ever pass a length that's already a multiple of 3
  // (StreamingFileWriter's own job) except for the very last, genuinely
  // final piece of a stream - so padding only ever needs to be
  // considered at the true end of the whole file, never mid-stream.
  const chunks = [];
  const innerChunkBytes = 3 * 20000;
  for (let offset = 0; offset < bytes.length; offset += innerChunkBytes) {
    const chunkEnd = Math.min(offset + innerChunkBytes, bytes.length);
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

function concatUint8Arrays(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Incrementally writes bytes to one destination file as base64, without
 * ever holding more than STREAM_CHUNK_BYTES or so of un-written data in
 * memory at once. Used both as the final output stage for
 * StreamingZipWriter below (writing the zip container itself) and
 * directly by the importer (writing each extracted file straight to its
 * real destination - a set's database.db or one of its images).
 *
 * Base64 works in fixed 3-byte-in/4-character-out groups, so a chunk
 * boundary that doesn't line up with a multiple of 3 bytes would
 * otherwise force padding ('=') in the MIDDLE of the file, corrupting
 * it. `pendingBytes` below is exactly the 0-2 leftover bytes from the
 * last flush that couldn't form a full group yet - carried over and
 * prepended to the next chunk, so padding only ever gets added once,
 * for real, in finish().
 */
class StreamingFileWriter {
  constructor(fileUri) {
    this.fileUri = fileUri;
    this.pendingBytes = new Uint8Array(0);
    this.bufferedChunks = [];
    this.bufferedLength = 0;
    this.started = false;
    // Every actual disk operation for this writer runs through this
    // chain, one at a time, in the order it was requested. push() itself
    // is synchronous and safe to call anytime, but flushIfNeeded()/
    // finish() can each be requested again before an earlier one has
    // actually finished writing (the importer below can receive several
    // chunks for the very same still-open file before fflate ever
    // pauses for a microtask) - without this chain, two flushes could
    // run concurrently and interleave their writes, corrupting the file
    // (or both thinking they're the "first" write and using
    // append:false, overwriting each other instead of appending).
    this._chain = Promise.resolve();
  }

  // Cheap and synchronous on purpose - safe to call from inside a
  // library's own synchronous data callback (see StreamingZipWriter and
  // the importer below, both of which receive data from fflate this
  // way). Actually writing to disk happens separately, in
  // flushIfNeeded/finish, and always through this._chain above.
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.bufferedChunks.push(chunk);
    this.bufferedLength += chunk.length;
  }

  // Queues a flush (only if enough is actually buffered) behind
  // whatever this writer is already doing. Returns the updated chain,
  // in case a caller needs to know THIS flush specifically has landed -
  // finish() below relies on that to guarantee it never runs ahead of
  // an already-queued flush.
  flushIfNeeded() {
    this._chain = this._chain.then(() => {
      if (this.bufferedLength >= STREAM_CHUNK_BYTES) {
        return this._flushBuffered();
      }
    });
    return this._chain;
  }

  async _flushBuffered() {
    if (this.bufferedLength === 0) return;
    const newBytes = new Uint8Array(this.bufferedLength);
    let offset = 0;
    for (const chunk of this.bufferedChunks) {
      newBytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.bufferedChunks = [];
    this.bufferedLength = 0;

    const combined = concatUint8Arrays(this.pendingBytes, newBytes);
    const usableLength = Math.floor(combined.length / 3) * 3;
    if (usableLength > 0) {
      const base64Piece = uint8ArrayToBase64(combined.subarray(0, usableLength));
      await FileSystem.writeAsStringAsync(this.fileUri, base64Piece, {
        encoding: FileSystem.EncodingType.Base64,
        append: this.started,
      });
      this.started = true;
    }
    this.pendingBytes = combined.slice(usableLength);
  }

  // Queues the final flush (everything still buffered, plus whatever
  // 1-2 leftover bytes only now get their real base64 padding) behind
  // everything already queued for this writer - via the same _chain, so
  // this can never jump ahead of an in-flight flushIfNeeded().
  finish() {
    this._chain = this._chain.then(() => this._flushBuffered()).then(() => this._finalize());
    return this._chain;
  }

  async _finalize() {
    if (this.pendingBytes.length > 0) {
      const base64Piece = uint8ArrayToBase64(this.pendingBytes);
      await FileSystem.writeAsStringAsync(this.fileUri, base64Piece, {
        encoding: FileSystem.EncodingType.Base64,
        append: this.started,
      });
      this.started = true;
      this.pendingBytes = new Uint8Array(0);
    }
    if (!this.started) {
      // Nothing was ever pushed (a genuinely empty file) - still leave
      // a real, empty file behind rather than nothing at all.
      await FileSystem.writeAsStringAsync(this.fileUri, '', { encoding: FileSystem.EncodingType.Base64 });
      this.started = true;
    }
  }
}

/**
 * Builds a zip archive incrementally, writing it straight to `fileUri`
 * as files are added - never holding the whole archive (input files or
 * output bytes) in memory at once. Wraps fflate's streaming `Zip` +
 * `ZipPassThrough` (store/no-compression entries - see this file's own
 * header comment on why no compression is used at all) around a
 * StreamingFileWriter that actually lands the bytes on disk.
 */
class StreamingZipWriter {
  constructor(fileUri) {
    this.fileWriter = new StreamingFileWriter(fileUri);
    this.error = null;
    this.zip = new Zip((err, chunk) => {
      if (err) {
        this.error = err;
        return;
      }
      this.fileWriter.push(chunk);
    });
  }

  _throwIfErrored() {
    if (this.error) {
      const err = this.error;
      this.error = null;
      throw err;
    }
  }

  /**
   * Adds one whole file's contents as a single zip entry. `bytes` is
   * one file at a time (an image, a database file, a manifest) - never
   * the whole archive - so the caller (buildWalletSetEntries below)
   * only ever needs one file's raw bytes in memory at a time, not every
   * file in the set.
   */
  async addFile(path, bytes) {
    const entry = new ZipPassThrough(path);
    this.zip.add(entry);
    entry.push(bytes, true);
    this._throwIfErrored();
    await this.fileWriter.flushIfNeeded();
  }

  async finish() {
    this.zip.end();
    this._throwIfErrored();
    await this.fileWriter.finish();
  }
}

function sanitizeForFileName(name) {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'wallet-set';
}

function timestampForFileName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function readFileBytes(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return base64ToUint8Array(base64);
}

/**
 * Streams one wallet set's database file, every image, and a
 * manifest.json into `writer` under `pathPrefix` (always
 * `set-<id>-<name>/` - see this file's own header comment on why every
 * export now uses this same folder shape, single-set exports included).
 * Only ever holds ONE file's raw bytes in memory at a time (whatever
 * readFileBytes just returned) - `writer` itself is what keeps the
 * actual zip-building/disk-writing side bounded, per its own comment.
 */
async function streamWalletSetIntoWriter(writer, walletSet, pathPrefix, onProgress, stats) {
  await checkpointWalletSetForExport(walletSet.db_file_name);

  const dbPath = getWalletSetDatabasePath(walletSet.db_file_name);
  const dbInfo = await FileSystem.getInfoAsync(dbPath);
  if (dbInfo.exists) {
    const dbBytes = await readFileBytes(dbPath);
    if (stats) stats.totalRawBytes += dbBytes.length;
    await writer.addFile(`${pathPrefix}database.db`, dbBytes);
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
      if (stats) stats.totalRawBytes += bytes.length;
      await writer.addFile(`${pathPrefix}images/${fileName}`, bytes);
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
  await writer.addFile(`${pathPrefix}manifest.json`, strToU8(JSON.stringify(manifest, null, 2)));
}

/**
 * Diagnostic-only, added after Raphael reported a real, unexplained
 * mismatch: the app's own "Total storage used" display (storageStats.js,
 * real bytes off actual files) said 129MB across all sets, but an
 * "export all sets" zip came out at 1.08GB - roughly 8x bigger. Logs
 * (via console.log, visible in the Expo console) how many raw bytes were
 * actually read off disk while building the export versus how big the
 * finished zip file turned out to be, so the next real run tells us
 * directly whether the SOURCE data itself is bigger than storageStats
 * thinks, or whether reading/zipping it is what's inflating it - rather
 * than guessing from code review alone. Never throws - a failure to
 * stat the finished zip shouldn't fail an export that otherwise worked.
 */
async function logExportSizeCheck(fileUri, totalRawBytes) {
  try {
    const info = await FileSystem.getInfoAsync(fileUri, { size: true });
    const zipBytes = info.exists ? info.size || 0 : 0;
    const ratio = totalRawBytes > 0 ? (zipBytes / totalRawBytes).toFixed(2) : 'n/a';
    console.log(
      `[exportImport] size check - raw bytes read from disk: ${totalRawBytes} (${formatMB(totalRawBytes)}), ` +
      `finished zip file: ${zipBytes} (${formatMB(zipBytes)}), ratio: ${ratio}x`
    );
  } catch (err) {
    console.log(`[exportImport] size check failed (non-fatal): ${err.message}`);
  }
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function pathPrefixForSet(walletSet) {
  return `set-${walletSet.id}-${sanitizeForFileName(walletSet.name)}/`;
}

/**
 * Builds and writes a zip for exactly one wallet set. The file is
 * written into expo-file-system's cache directory (a plain, ordinary
 * local file, not yet visible to Raphael anywhere) - see
 * presentSaveOrShareChoice in WalletManager.js for what happens to it
 * next (Save to a folder he picks, and/or Share via the OS share sheet
 * - his own explicit request to support both rather than picking one).
 */
export async function exportWalletSet(walletSet, { onProgress } = {}) {
  const fileName = `devikins-${sanitizeForFileName(walletSet.name)}-${timestampForFileName()}.zip`;
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  const writer = new StreamingZipWriter(fileUri);
  const stats = { totalRawBytes: 0 };

  await streamWalletSetIntoWriter(writer, walletSet, pathPrefixForSet(walletSet), onProgress, stats);
  await writer.addFile('export-manifest.json', strToU8(JSON.stringify(
    { formatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), sets: [{ id: walletSet.id, name: walletSet.name }] },
    null,
    2
  )));

  onProgress?.({ phase: 'writing', setName: walletSet.name });
  await writer.finish();
  await logExportSizeCheck(fileUri, stats.totalRawBytes);
  return { fileUri, fileName };
}

/**
 * Same idea as exportWalletSet, but for every wallet set at once - each
 * set gets its own `set-<id>-<name>/` folder inside a single zip. The
 * id in the folder name (not just the sanitized name) is what keeps two
 * differently-set-up sets that happen to share a display name from
 * colliding into the same folder.
 */
export async function exportAllWalletSets(walletSets, { onProgress } = {}) {
  const fileName = `devikins-all-sets-${timestampForFileName()}.zip`;
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  const writer = new StreamingZipWriter(fileUri);
  const setSummaries = [];
  const stats = { totalRawBytes: 0 };

  for (const walletSet of walletSets) {
    await streamWalletSetIntoWriter(writer, walletSet, pathPrefixForSet(walletSet), onProgress, stats);
    setSummaries.push({ id: walletSet.id, name: walletSet.name });
  }

  await writer.addFile('export-manifest.json', strToU8(JSON.stringify(
    { formatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), sets: setSummaries },
    null,
    2
  )));

  onProgress?.({ phase: 'writing' });
  await writer.finish();
  await logExportSizeCheck(fileUri, stats.totalRawBytes);
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
  // Streamed in chunks rather than one readAsStringAsync/writeAsStringAsync
  // pair over the whole file, for the same reason as everything else in
  // this file - a large export could otherwise mean one giant string in
  // memory again right as it's about to be saved.
  const sourceInfo = await FileSystem.getInfoAsync(fileUri, { size: true });
  const totalBytes = sourceInfo.size || 0;
  let position = 0;
  let started = false;
  while (position < totalBytes) {
    const length = Math.min(STREAM_CHUNK_BYTES, totalBytes - position);
    const base64Chunk = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length,
    });
    await FileSystem.writeAsStringAsync(destUri, base64Chunk, {
      encoding: FileSystem.EncodingType.Base64,
      append: started,
    });
    started = true;
    position += length;
  }
  if (!started) {
    await FileSystem.writeAsStringAsync(destUri, '', { encoding: FileSystem.EncodingType.Base64 });
  }
  return true;
}

/**
 * The whole import flow: opens the OS document picker so Raphael can
 * pick a .zip he previously exported (from this phone, or copied over
 * from another one), streams it apart (see StreamingUnzipReader-style
 * logic inline below - reads the picked file in bounded chunks and
 * feeds them to fflate's streaming `Unzip`, writing each extracted file
 * straight to its own new destination as its data arrives, rather than
 * ever holding the whole archive - compressed or extracted - in memory
 * at once), writes out and registers a brand-new wallet set for each
 * one found, and returns the list of new sets' display names. Returns
 * null (not an error) if he backs out of the file picker without
 * choosing anything.
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

  // FOUND AND FIXED (2026-09-26): reading straight from DocumentPicker's
  // own cache copy (pickResult.assets[0].uri) via readAsStringAsync's
  // position/length options threw a real, reproducible native error -
  // "java.io.IOException: Location '...DocumentPicker/<uuid>.zip' isn't
  // readable" - even though that exact same file's plain existence/size
  // check (getInfoAsync) succeeded just fine. A whole-file read (no
  // position/length) would likely have worked, but that's exactly the
  // all-at-once approach this file exists to avoid for a large export.
  // Fixed by making our OWN plain copy of the picked file, under a
  // directory this app fully owns (FileSystem.cacheDirectory, not
  // DocumentPicker's own cache subfolder) - copyAsync does a normal
  // whole-file stream copy, no ranged reads involved, so it isn't
  // affected by whatever made the picker's own copy unreadable that
  // way. Every read below happens against THIS copy, never the original
  // picked URI. Cleaned up in the `finally` at the bottom either way -
  // it's a temporary scratch copy, not something worth leaving behind.
  const importScratchUri = `${FileSystem.cacheDirectory}import-scratch-${Date.now()}.zip`;
  await FileSystem.copyAsync({ from: pickResult.assets[0].uri, to: importScratchUri });

  try {
    return await importWalletSetsZipFromLocalFile(importScratchUri, { onProgress });
  } finally {
    await FileSystem.deleteAsync(importScratchUri, { idempotent: true });
  }
}

async function importWalletSetsZipFromLocalFile(pickedUri, { onProgress } = {}) {
  const pickedInfo = await FileSystem.getInfoAsync(pickedUri, { size: true });
  const totalBytes = pickedInfo.size || 0;
  if (totalBytes === 0) {
    throw new Error("That file is empty - nothing to import.");
  }

  // One entry per top-level zip folder (a `set-<id>-<name>/` from
  // exportWalletSet/exportAllWalletSets above) - allocated the first
  // time any file belonging to that folder is seen, since the
  // destination filenames only need to be new and unique, not derived
  // from anything inside the zip itself (see registerImportedWalletSet's
  // own comment in database.js for why fresh filenames are used at
  // all).
  const groups = new Map();
  const pendingFileWrites = [];
  let streamError = null;
  let groupCounter = 0;

  function getOrCreateGroup(folderName) {
    let group = groups.get(folderName);
    if (!group) {
      groupCounter += 1;
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}-${groupCounter}`;
      group = {
        dbFileName: `devikins-import-${suffix}.db`,
        imagesDirName: `nft-images-import-${suffix}`,
        imagesDirEnsured: null,
        manifestChunks: [],
      };
      groups.set(folderName, group);
    }
    return group;
  }

  const unzipper = new Unzip((file) => {
    const slashIndex = file.name.indexOf('/');
    if (slashIndex === -1) {
      // A file sitting at the zip's own root - only export-manifest.json
      // does this, which is purely informational (see
      // exportAllWalletSets above) and not needed to actually import
      // anything. Still has to be started and consumed (fflate expects
      // every discovered file to be either started or left alone
      // consistently), so give it a no-op sink rather than leaving it
      // unhandled.
      file.ondata = () => {};
      file.start();
      return;
    }

    const folderName = file.name.slice(0, slashIndex);
    const restOfPath = file.name.slice(slashIndex + 1);
    if (!restOfPath) {
      file.ondata = () => {};
      file.start();
      return;
    }

    const group = getOrCreateGroup(folderName);

    if (restOfPath === 'manifest.json') {
      file.ondata = (err, chunk) => {
        if (err) {
          streamError = streamError || err;
          return;
        }
        if (chunk && chunk.length > 0) group.manifestChunks.push(chunk);
      };
      file.start();
      return;
    }

    if (restOfPath === 'database.db') {
      // finish() and flushIfNeeded() both queue their work onto the
      // writer's own internal chain (see StreamingFileWriter's own
      // comment) rather than running immediately, so it's safe to call
      // one right after the other here without waiting for either to
      // actually land on disk first - they can never run out of order
      // relative to each other for this one writer.
      const writer = new StreamingFileWriter(getWalletSetDatabasePath(group.dbFileName));
      pendingFileWrites.push(
        new Promise((resolve, reject) => {
          file.ondata = (err, chunk, final) => {
            if (err) {
              reject(err);
              return;
            }
            writer.push(chunk);
            if (final) {
              writer.finish().then(resolve).catch(reject);
            } else {
              writer.flushIfNeeded().catch(reject);
            }
          };
          file.start();
        })
      );
      return;
    }

    if (restOfPath.startsWith('images/') && restOfPath.length > 'images/'.length) {
      const imageFileName = restOfPath.slice('images/'.length);
      const imagesDirUri = `${FileSystem.documentDirectory}${group.imagesDirName}/`;
      if (!group.imagesDirEnsured) {
        group.imagesDirEnsured = FileSystem.makeDirectoryAsync(imagesDirUri, { intermediates: true });
      }
      const writer = new StreamingFileWriter(`${imagesDirUri}${imageFileName}`);
      pendingFileWrites.push(
        group.imagesDirEnsured.then(
          () =>
            new Promise((resolve, reject) => {
              file.ondata = (err, chunk, final) => {
                if (err) {
                  reject(err);
                  return;
                }
                writer.push(chunk);
                if (final) {
                  writer.finish().then(resolve).catch(reject);
                } else {
                  writer.flushIfNeeded().catch(reject);
                }
              };
              file.start();
            })
        )
      );
      return;
    }

    // Anything else under a set's folder isn't something this app wrote
    // there - ignore it rather than guessing what to do with it.
    file.ondata = () => {};
    file.start();
  });
  unzipper.register(UnzipPassThrough);

  let position = 0;
  while (position < totalBytes) {
    const length = Math.min(STREAM_CHUNK_BYTES, totalBytes - position);
    const base64Chunk = await FileSystem.readAsStringAsync(pickedUri, {
      encoding: FileSystem.EncodingType.Base64,
      position,
      length,
    });
    const bytes = base64ToUint8Array(base64Chunk);
    position += length;
    const isFinalChunk = position >= totalBytes;

    onProgress?.({ phase: 'unzipping', current: position, total: totalBytes });
    unzipper.push(bytes, isFinalChunk);
    if (streamError) throw streamError;
  }

  await Promise.all(pendingFileWrites);
  if (streamError) throw streamError;

  const importedNames = [];
  for (const group of groups.values()) {
    if (group.manifestChunks.length === 0) {
      // A folder with no manifest.json isn't a wallet set this app
      // exported - skip it rather than registering something with no
      // real name/metadata behind it.
      continue;
    }
    const manifestBytes = group.manifestChunks.reduce((acc, chunk) => concatUint8Arrays(acc, chunk), new Uint8Array(0));
    let manifest;
    try {
      manifest = JSON.parse(strFromU8(manifestBytes));
    } catch {
      continue;
    }
    const importedName = `${manifest.name || 'Imported set'} (imported)`;
    await registerImportedWalletSet(importedName, group.dbFileName, group.imagesDirName);
    importedNames.push(importedName);
  }

  return importedNames;
}

// Re-exported purely so WalletManager.js can check "does this platform
// even have a folder-picker option" without importing react-native's
// Platform a second time for one boolean - see its own
// presentSaveOrShareChoice, which only offers the "Save to folder"
// button at all when this is true.
export const supportsSaveToFolder = Platform.OS === 'android';
