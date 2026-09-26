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
 * Fixed by switching WRITING to fflate's streaming `Zip`/`ZipPassThrough`
 * classes instead of the all-at-once functions - see StreamingFileWriter/
 * StreamingZipWriter below. The archive is now built in bounded-size
 * windows (~4MB at a time, STREAM_CHUNK_BYTES below) rather than all at
 * once - peak memory is roughly "one chunk's worth" regardless of how
 * many thousands of images are involved, not "the whole wallet set's
 * worth." Confirmed against Raphael's real ~9,500-NFT set afterward.
 *
 * READING (revised again 2026-09-26, same day, after a real import bug):
 * this file originally read a picked zip back the mirror-image way -
 * fflate's streaming `Unzip`/`UnzipPassThrough` classes, fed the picked
 * file in the same ~4MB chunks. That turned out to have a real, silent
 * data-corruption bug for this app's specific use (STORED/uncompressed
 * entries whose writer never declares a size up front - see
 * findEndOfCentralDirectory/readCentralDirectoryEntries's own long
 * comment below for the full mechanism and how it was confirmed with a
 * standalone reproduction before writing the fix). Reading now goes
 * through the zip's own central directory instead, which sidesteps that
 * failure mode entirely while keeping the same bounded-memory,
 * chunked-read approach for each entry's actual bytes.
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
import { Zip, ZipPassThrough, strToU8, strFromU8 } from 'fflate';
import { getWalletSetDatabasePath, resolveExistingWalletSetDatabasePath } from './storageStats';
import { checkpointWalletSetForExport, registerImportedWalletSet, logImportedSetRowCounts } from '../db/database';

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

async function readRangeBytes(uri, position, length) {
  if (length <= 0) return new Uint8Array(0);
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position,
    length,
  });
  return base64ToUint8Array(base64);
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

const ZIP_END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
// The end-of-central-directory record is exactly 22 bytes, plus an
// optional trailing comment this app never writes (fflate's own zip
// writer doesn't add one either) - so it's always the very last 22
// bytes of a file this app produced. A generous 4KB tail window covers
// a stray comment from a zip made by some other tool too, without
// having to read the whole file just to find it.
const ZIP_EOCD_SEARCH_WINDOW_BYTES = 4096;

/**
 * Locates and parses the ZIP "end of central directory" record - see
 * readCentralDirectoryEntries's own comment just below for why the
 * importer reads a zip this way instead of fflate's streaming Unzip.
 */
async function findEndOfCentralDirectory(uri, totalBytes) {
  const windowSize = Math.min(ZIP_EOCD_SEARCH_WINDOW_BYTES, totalBytes);
  const windowStart = totalBytes - windowSize;
  const tail = await readRangeBytes(uri, windowStart, windowSize);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (readUint32LE(tail, i) === ZIP_END_OF_CENTRAL_DIR_SIGNATURE) {
      return {
        centralDirSize: readUint32LE(tail, i + 12),
        centralDirOffset: readUint32LE(tail, i + 16),
      };
    }
  }
  throw new Error("That file doesn't look like a wallet-set export (no zip directory found).");
}

/**
 * V3.1, 2026-09-26 - the reason the importer reads a zip this way at
 * all, REPLACING an earlier version that used fflate's streaming
 * `Unzip` class: that class figures out where an entry's data ends by
 * scanning the incoming byte stream for the next zip signature, because
 * this app's own exporter (via fflate's streaming `Zip` writer) always
 * marks an entry's size as "unknown at header-write time" and appends
 * the real size afterward in a trailing marker - genuinely
 * streaming-safe when the payload is compressed (noise-like output,
 * essentially never spells out an exact 4-byte zip signature by
 * coincidence), but every entry here is STORED, uncompressed (see this
 * file's own header comment on why): a raw SQLite database file, or a
 * raw PNG. A large enough raw binary blob has a real, reproduced-in-a-
 * standalone-test chance of coincidentally containing that exact 4-byte
 * sequence somewhere in its own content - and when it does, the
 * scanning reader mistakes it for the entry ending early (or a brand
 * new entry starting), silently corrupting everything read from that
 * point on, with no crash at all. That silent corruption is exactly
 * what a real import showed: it completed with no error and the
 * correct total file size, but the resulting wallet set had no wallets
 * or NFTs in it once switched into.
 *
 * The robust fix: don't scan for signatures inside entries at all.
 * Every ZIP file's CENTRAL DIRECTORY - a separate index written once,
 * at the very end of the file, after every entry's real compressed size
 * is already known - lists each entry's name, exact size, and its local
 * header's byte offset, unambiguously (this is how real random-access
 * zip readers, like Python's zipfile or Java's ZipFile, work). Since
 * this app's own picked/copied zip file already supports reliable
 * ranged reads (see pickAndImportWalletSetsZip's own history), each
 * entry can still be read in bounded STREAM_CHUNK_BYTES-sized pieces
 * afterward - never the whole entry, let alone the whole archive, in
 * memory at once.
 *
 * Deliberately reads each entry's data-start offset using the FILENAME/
 * EXTRA-FIELD lengths already recorded in the central directory, rather
 * than re-reading each local header separately just to get those same
 * two numbers (an extra native read per file, times potentially
 * thousands of images) - safe here specifically because this app is
 * always both the writer AND the reader of its own exports, and
 * fflate's zip writer (see StreamingZipWriter/Zip.prototype.add) always
 * uses the exact same filename bytes and no extra field for both an
 * entry's local header and its central directory record.
 */
async function readCentralDirectoryEntries(uri, eocd) {
  const dirBytes = await readRangeBytes(uri, eocd.centralDirOffset, eocd.centralDirSize);
  const entries = [];
  let pos = 0;
  while (pos + 46 <= dirBytes.length) {
    if (readUint32LE(dirBytes, pos) !== ZIP_CENTRAL_DIR_SIGNATURE) break;
    const compressionMethod = readUint16LE(dirBytes, pos + 10);
    const compressedSize = readUint32LE(dirBytes, pos + 20);
    const fileNameLength = readUint16LE(dirBytes, pos + 28);
    const extraFieldLength = readUint16LE(dirBytes, pos + 30);
    const fileCommentLength = readUint16LE(dirBytes, pos + 32);
    const localHeaderOffset = readUint32LE(dirBytes, pos + 42);
    const nameBytes = dirBytes.subarray(pos + 46, pos + 46 + fileNameLength);
    entries.push({
      name: strFromU8(nameBytes),
      compressionMethod,
      compressedSize,
      localHeaderOffset,
      // Right after this entry's local header's fixed 30 bytes plus
      // that same filename/extra-field length (see this function's own
      // comment on why it's safe to reuse those lengths from here).
      dataOffset: localHeaderOffset + 30 + fileNameLength + extraFieldLength,
    });
    pos += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
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

  const dbPath = await resolveExistingWalletSetDatabasePath(walletSet.db_file_name);
  const dbInfo = await FileSystem.getInfoAsync(dbPath, { size: true });
  // TEMPORARY diagnostic, added 2026-09-26 - confirms the real fix
  // (resolveExistingWalletSetDatabasePath in storageStats.js - see its
  // own long comment for the "/data/data/" vs "/data/user/0/" story)
  // actually finds the file this time, for a set already proven to have
  // real data.
  console.log(
    `[exportImport] DIAG export "${walletSet.name}" (db_file_name=${walletSet.db_file_name}): ` +
    `resolved dbPath=${dbPath}, exists=${dbInfo.exists}, size=${dbInfo.exists ? dbInfo.size : 'n/a'}`
  );
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
 * from another one), reads it apart via its own zip central directory
 * (see findEndOfCentralDirectory/readCentralDirectoryEntries below for
 * why it's read this way instead of a simpler streaming unzip), writing
 * each file straight to its own new destination in bounded chunks
 * rather than ever holding a whole file - let alone the whole archive -
 * in memory at once, writes out and registers a brand-new wallet set
 * for each one found, and returns the list of new sets' display names.
 * Returns null (not an error) if he backs out of the file picker
 * without choosing anything.
 *
 * Deliberately does NOT switch to any imported set, or touch whatever
 * set is currently active - see registerImportedWalletSet's own comment
 * in database.js.
 */
export async function pickAndImportWalletSetsZip({ onProgress } = {}) {
  // SECOND ROUND (2026-09-26): the first fix (copy the picked file to
  // our own path, then read from THAT) didn't hold up - Raphael hit the
  // exact same "isn't readable" error, just now thrown by the copyAsync
  // call itself rather than by the ranged read, and still pointing at
  // DocumentPicker's own cache file as the unreadable SOURCE. That
  // moves the actual bug: it was never about ranged reads specifically
  // - ANY read of that file fails, ranged or whole-file, which means
  // DocumentPicker's own `copyToCacheDirectory: true` step is what's
  // producing a file this app's own process can't actually read back,
  // not something wrong with how this app was reading it afterward.
  //
  // Fixed (attempt 2) by turning `copyToCacheDirectory` OFF, so
  // `pickResult.assets[0].uri` is the RAW SAF/content:// URI Android's
  // own picker handed back, never touched by DocumentPicker's own copy
  // step at all - and doing the copy into our own cache path ourselves,
  // directly from that content:// URI, via the exact same
  // FileSystem.copyAsync this app already uses elsewhere. expo-file-
  // system's own docs describe this exact scenario for copyAsync -
  // "copy content shared by other apps to local filesystem" - so this
  // is its intended use, not a workaround bolted on sideways.
  //
  // THIRD ROUND (2026-09-26, later the same day): attempt 2's fix turned
  // out to be necessary but not sufficient - live testing showed the
  // EXACT SAME "isn't readable" IOException still happening on THIS
  // copyAsync call itself, intermittently: picking the identical file
  // several times in a row failed with a fresh DocumentPicker-cache
  // path each time on most attempts, then eventually succeeded on one,
  // with no code change in between. That's Android not having the
  // picked document's bytes fully ready to read the instant the picker
  // resolves - a timing/readiness race, not a wrong-URI bug. Worse: a
  // race like that could plausibly let a copy "succeed" while only
  // PARTIALLY landing rather than throwing at all, which would neatly
  // explain a separate real symptom already seen once - an import that
  // completed with no error at all, but produced a database with no
  // tables in it once opened. So this doesn't just retry on a thrown
  // error - it verifies the copy's byte size against the source's own
  // reported size before trusting it, retrying the whole copy again if
  // either the copy throws or the sizes don't match, rather than
  // silently proceeding to import whatever landed.
  const pickResult = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: false,
  });
  if (pickResult.canceled || !pickResult.assets?.[0]) {
    return null;
  }

  const sourceUri = pickResult.assets[0].uri;
  let expectedSize = null;
  try {
    const sourceInfo = await FileSystem.getInfoAsync(sourceUri, { size: true });
    if (sourceInfo.exists && sourceInfo.size) expectedSize = sourceInfo.size;
  } catch {
    // Some content providers won't report a size for their own URI up
    // front - fine, the retry loop below just can't size-check in that
    // case, but still protects against a thrown error.
  }

  const importScratchUri = `${FileSystem.cacheDirectory}import-scratch-${Date.now()}.zip`;
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastError = null;
    try {
      await FileSystem.deleteAsync(importScratchUri, { idempotent: true });
      await FileSystem.copyAsync({ from: sourceUri, to: importScratchUri });
      const copiedInfo = await FileSystem.getInfoAsync(importScratchUri, { size: true });
      const gotBytes = copiedInfo.exists ? copiedInfo.size || 0 : 0;
      if (gotBytes === 0) {
        lastError = new Error('The copy came back empty.');
      } else if (expectedSize != null && gotBytes !== expectedSize) {
        lastError = new Error(`The copy came back as ${gotBytes} bytes, but the original is ${expectedSize}.`);
      }
    } catch (err) {
      lastError = err;
    }
    if (!lastError) break;
    console.log(`[exportImport] import copy attempt ${attempt}/${maxAttempts} not ready yet: ${lastError.message}`);
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  if (lastError) {
    await FileSystem.deleteAsync(importScratchUri, { idempotent: true });
    throw new Error("Android wasn't ready to hand over that file after a few tries. Please try picking it again.");
  }

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

  const eocd = await findEndOfCentralDirectory(pickedUri, totalBytes);
  const centralEntries = await readCentralDirectoryEntries(pickedUri, eocd);

  // TEMPORARY diagnostics, added 2026-09-26 after the central-directory
  // rewrite still showed no data once imported ("no such table:
  // wallets" straight from SQLite - i.e. the copied database.db wasn't
  // real database content at all). Logs exactly what parsing the zip's
  // central directory found, and directly verifies the one thing the
  // whole rewrite depends on: that a local file header really does
  // start at the byte offset the central directory says it does. If
  // that check fails, the offsets themselves are wrong (something off
  // in how this zip's central directory is being read); if it passes
  // but the resulting file still isn't valid SQLite, the bug is in the
  // actual byte copy instead, not the offset math.
  console.log(
    `[exportImport] DIAG zip: totalBytes=${totalBytes}, centralDirOffset=${eocd.centralDirOffset}, ` +
    `centralDirSize=${eocd.centralDirSize}, entries found=${centralEntries.length}`
  );
  for (const entry of centralEntries) {
    if (entry.name.endsWith('database.db') || entry.name.endsWith('manifest.json')) {
      const sigBytes = await readRangeBytes(pickedUri, entry.localHeaderOffset, 4);
      const sig = readUint32LE(sigBytes, 0);
      const sigOk = sig === 0x04034b50;
      console.log(
        `[exportImport] DIAG entry "${entry.name}": compressionMethod=${entry.compressionMethod}, ` +
        `compressedSize=${entry.compressedSize}, localHeaderOffset=${entry.localHeaderOffset}, ` +
        `dataOffset=${entry.dataOffset}, local header signature ${sigOk ? 'OK' : `WRONG (0x${sig.toString(16)})`}`
      );
    }
  }

  // One entry per top-level zip folder (a `set-<id>-<name>/` from
  // exportWalletSet/exportAllWalletSets above) - allocated the first
  // time any file belonging to that folder is seen, since the
  // destination filenames only need to be new and unique, not derived
  // from anything inside the zip itself (see registerImportedWalletSet's
  // own comment in database.js for why fresh filenames are used at
  // all).
  const groups = new Map();
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
        manifestBytes: null,
      };
      groups.set(folderName, group);
    }
    return group;
  }

  // A first pass over the central directory's (already-complete) entry
  // list, sorting every file into its set's group before reading any
  // actual bytes - mirrors the old streaming version's up-front
  // folder-name grouping, just done from a known-complete list instead
  // of discovering folders as they streamed past.
  const plannedEntries = [];
  for (const entry of centralEntries) {
    const slashIndex = entry.name.indexOf('/');
    if (slashIndex === -1) continue; // export-manifest.json at the zip root - informational only
    const folderName = entry.name.slice(0, slashIndex);
    const restOfPath = entry.name.slice(slashIndex + 1);
    if (!restOfPath) continue;
    plannedEntries.push({ entry, group: getOrCreateGroup(folderName), restOfPath });
  }

  const totalPlannedBytes = plannedEntries.reduce((sum, p) => sum + p.entry.compressedSize, 0) || 1;
  let bytesProcessed = 0;

  function assertStored(entry) {
    // Every entry this app's own exporter writes is stored,
    // uncompressed (see this file's header comment) - anything else
    // means this isn't really one of Companion's own exports.
    if (entry.compressionMethod !== 0) {
      throw new Error("This file doesn't look like a Companion export Raphael can import.");
    }
  }

  // Reads one entry's exact byte range in STREAM_CHUNK_BYTES-sized
  // pieces and writes it straight to destUri - deliberately one whole
  // file at a time, start to finish, rather than the old version's
  // several-files-in-flight-at-once approach: simpler, and this project
  // has already been burned once this same cycle by a "clever"
  // concurrent version of something that turned out to hide a real race
  // condition (see NOTES.md's storage-undercount writeup) - not worth
  // that trade-off for an action Raphael only does occasionally.
  async function copyEntryBytesTo(entry, destUri) {
    assertStored(entry);
    const writer = new StreamingFileWriter(destUri);
    let remaining = entry.compressedSize;
    let position = entry.dataOffset;
    while (remaining > 0) {
      const length = Math.min(STREAM_CHUNK_BYTES, remaining);
      const bytes = await readRangeBytes(pickedUri, position, length);
      writer.push(bytes);
      await writer.flushIfNeeded();
      position += length;
      remaining -= length;
      bytesProcessed += length;
      onProgress?.({ phase: 'unzipping', current: bytesProcessed, total: totalPlannedBytes });
    }
    await writer.finish();
  }

  for (const { entry, group, restOfPath } of plannedEntries) {
    if (restOfPath === 'manifest.json') {
      assertStored(entry);
      group.manifestBytes = await readRangeBytes(pickedUri, entry.dataOffset, entry.compressedSize);
      bytesProcessed += entry.compressedSize;
      continue;
    }

    if (restOfPath === 'database.db') {
      const destPath = getWalletSetDatabasePath(group.dbFileName);
      await copyEntryBytesTo(entry, destPath);
      // TEMPORARY - see this function's own DIAG comment above.
      try {
        const writtenInfo = await FileSystem.getInfoAsync(destPath, { size: true });
        console.log(
          `[exportImport] DIAG wrote ${destPath} - expected ${entry.compressedSize} bytes, ` +
          `actually on disk: ${writtenInfo.exists ? writtenInfo.size : '(missing!)'}`
        );
      } catch (err) {
        console.log(`[exportImport] DIAG couldn't stat ${destPath} after writing: ${err.message}`);
      }
      continue;
    }

    if (restOfPath.startsWith('images/') && restOfPath.length > 'images/'.length) {
      const imageFileName = restOfPath.slice('images/'.length);
      const imagesDirUri = `${FileSystem.documentDirectory}${group.imagesDirName}/`;
      if (!group.imagesDirEnsured) {
        group.imagesDirEnsured = FileSystem.makeDirectoryAsync(imagesDirUri, { intermediates: true });
      }
      await group.imagesDirEnsured;
      await copyEntryBytesTo(entry, `${imagesDirUri}${imageFileName}`);
      continue;
    }

    // Anything else under a set's folder isn't something this app wrote
    // there - ignore it rather than guessing what to do with it.
    bytesProcessed += entry.compressedSize;
  }

  const importedNames = [];
  for (const group of groups.values()) {
    if (!group.manifestBytes || group.manifestBytes.length === 0) {
      // A folder with no manifest.json isn't a wallet set this app
      // exported - skip it rather than registering something with no
      // real name/metadata behind it.
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(strFromU8(group.manifestBytes));
    } catch {
      continue;
    }
    // TEMPORARY diagnostic - see streamWalletSetIntoWriter's own DIAG
    // comment. This is the exported manifest.json's own recorded
    // hasDatabase/imageCount for THIS zip, straight from the file
    // itself - tells us what the export actually believed it packed,
    // even for a zip exported before this diagnostic existed.
    console.log(`[exportImport] DIAG manifest for "${manifest.name}": ${JSON.stringify(manifest)}`);
    const importedName = `${manifest.name || 'Imported set'} (imported)`;
    await registerImportedWalletSet(importedName, group.dbFileName, group.imagesDirName);
    await logImportedSetRowCounts(group.dbFileName);
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
