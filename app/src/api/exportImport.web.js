/**
 * exportImport.web.js
 *
 * The website version of exportImport.js. When the Hub is built for the
 * browser, the build tool automatically picks this ".web.js" file instead
 * of the phone one.
 *
 * On the website, a wallet set's data (wallets, fetched NFTs, names,
 * stars, comments) lives only inside the visitor's browser, so export is
 * the way to keep a backup or move to another browser or device.
 *
 * SAME FILE FORMAT AS THE PHONE APP: a zip with export-manifest.json at
 * the top and one `set-<id>-<name>/` folder per set holding manifest.json
 * and database.json (files stored uncompressed, exactly like the phone
 * writes them). So:
 *   - a website export can be imported in the phone app, and
 *   - a phone export can be imported on the website.
 * The only difference: the website stores no pictures (see
 * imageStorage.web.js), so its exports contain no images/ folder, and when
 * importing a phone export the pictures in it are skipped. The phone app
 * downloads missing pictures again by itself; the website always shows
 * them straight from Moonlabs' image server.
 *
 * Export: the zip is built in memory and handed to the browser as a
 * normal download. Import: a normal "choose file" dialog; the file is
 * read in the browser, nothing is uploaded anywhere. Like the phone app,
 * import re-checks each file's checksum (CRC32) against the one recorded
 * in the zip, and a damaged database.json is never trusted.
 */
import { zipSync, strToU8, strFromU8 } from 'fflate';
import {
  checkpointWalletSetForExport,
  registerImportedWalletSet,
  logImportedSetRowCounts,
  dumpWalletSetData,
  restoreWalletSetData,
} from '../db/database';

// Must match exportImport.js, so both sides recognise each other's files.
const EXPORT_FORMAT_VERSION = 3;

// The website has no "save to a chosen folder" step: the browser's own
// download handling decides where the file goes.
export const supportsSaveToFolder = false;

function sanitizeForFileName(name) {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'wallet-set';
}

function timestampForFileName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function pathPrefixForSet(walletSet) {
  return `set-${walletSet.id}-${sanitizeForFileName(walletSet.name)}/`;
}

// Standard CRC32 (the checksum every zip file uses), same as the phone file.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Bytes(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function addWalletSetFiles(files, walletSet) {
  await checkpointWalletSetForExport(walletSet.db_file_name);
  const dataDump = await dumpWalletSetData(walletSet.db_file_name);
  const prefix = pathPrefixForSet(walletSet);
  files[`${prefix}database.json`] = strToU8(JSON.stringify(dataDump));
  files[`${prefix}manifest.json`] = strToU8(JSON.stringify({
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name: walletSet.name,
    hasDatabase: true,
    imageCount: 0,
  }, null, 2));
}

function buildZip(files, setSummaries) {
  files['export-manifest.json'] = strToU8(JSON.stringify(
    { formatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(), sets: setSummaries },
    null,
    2
  ));
  // level 0 = stored uncompressed, exactly like the phone app's exports
  // (the phone's importer only accepts that).
  const bytes = zipSync(files, { level: 0 });
  const blob = new Blob([bytes], { type: 'application/zip' });
  return URL.createObjectURL(blob);
}

export async function exportWalletSet(walletSet, { onProgress } = {}) {
  onProgress?.({ phase: 'writing', setName: walletSet.name });
  const files = {};
  await addWalletSetFiles(files, walletSet);
  const fileUri = buildZip(files, [{ id: walletSet.id, name: walletSet.name }]);
  return { fileUri, fileName: `devikins-${sanitizeForFileName(walletSet.name)}-${timestampForFileName()}.zip` };
}

export async function exportAllWalletSets(walletSets, { onProgress } = {}) {
  onProgress?.({ phase: 'writing' });
  const files = {};
  const setSummaries = [];
  for (const walletSet of walletSets) {
    await addWalletSetFiles(files, walletSet);
    setSummaries.push({ id: walletSet.id, name: walletSet.name });
  }
  const fileUri = buildZip(files, setSummaries);
  return { fileUri, fileName: `devikins-all-sets-${timestampForFileName()}.zip` };
}

/**
 * On the website "sharing" an export means downloading it: the browser
 * saves it like any other download (usually into Downloads).
 */
export async function shareExportedFile(fileUri, fileName = 'devikins-export.zip') {
  const link = document.createElement('a');
  link.href = fileUri;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before freeing it.
  setTimeout(() => URL.revokeObjectURL(fileUri), 60000);
}

export async function saveExportedFileToFolder() {
  throw new Error('Saving to a folder is only available in the phone app.');
}

// Opens the browser's "choose file" dialog. Resolves with the chosen File,
// or null if the person closes the dialog without choosing.
function pickZipFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    let settled = false;
    input.addEventListener('change', () => {
      settled = true;
      resolve(input.files?.[0] || null);
    });
    // Browsers don't reliably report "cancelled"; when the window gets
    // focus back without a file having been chosen, treat it as cancelled.
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!settled) resolve(null);
      }, 1000);
    }, { once: true });
    input.click();
  });
}

function readUint16LE(b, o) { return b[o] | (b[o + 1] << 8); }
function readUint32LE(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// Reads the zip's table of contents (its "central directory"): every
// file's name, checksum, size and where its bytes start.
function readZipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (readUint32LE(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("That file doesn't look like a Hub export (not a zip file).");
  const count = readUint16LE(bytes, eocd + 10);
  let p = readUint32LE(bytes, eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (readUint32LE(bytes, p) !== 0x02014b50) throw new Error('That zip file seems to be damaged.');
    const method = readUint16LE(bytes, p + 10);
    const crc32 = readUint32LE(bytes, p + 16);
    const size = readUint32LE(bytes, p + 20);
    const nameLen = readUint16LE(bytes, p + 28);
    const extraLen = readUint16LE(bytes, p + 30);
    const commentLen = readUint16LE(bytes, p + 32);
    const localOffset = readUint32LE(bytes, p + 42);
    const name = strFromU8(bytes.subarray(p + 46, p + 46 + nameLen));
    const localNameLen = readUint16LE(bytes, localOffset + 26);
    const localExtraLen = readUint16LE(bytes, localOffset + 28);
    entries.push({ name, method, crc32, size, dataOffset: localOffset + 30 + localNameLen + localExtraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function pickAndImportWalletSetsZip({ onProgress } = {}) {
  const file = await pickZipFile();
  if (!file) return null;
  onProgress?.({ phase: 'unzipping', current: 0, total: 1 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new Error('That file is empty - nothing to import.');

  const groups = new Map();
  for (const entry of readZipEntries(bytes)) {
    const slash = entry.name.indexOf('/');
    if (slash === -1) continue; // export-manifest.json - informational only
    const folder = entry.name.slice(0, slash);
    const rest = entry.name.slice(slash + 1);
    if (rest !== 'manifest.json' && rest !== 'database.json') continue; // pictures are skipped on the website
    if (entry.method !== 0) throw new Error("That file doesn't look like a Hub export (unexpected compression).");
    const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size);
    const group = groups.get(folder) || {};
    group[rest] = { data, ok: crc32Bytes(data) === entry.crc32 };
    groups.set(folder, group);
  }

  const importedNames = [];
  const warnings = [];
  let counter = 0;
  for (const group of groups.values()) {
    if (!group['manifest.json']) continue;
    let manifest;
    try {
      manifest = JSON.parse(strFromU8(group['manifest.json'].data));
    } catch {
      continue;
    }
    const importedName = `${manifest.name || 'Imported set'} (imported)`;

    let dump = {};
    const db = group['database.json'];
    if (db && db.ok) {
      try {
        dump = JSON.parse(strFromU8(db.data));
      } catch {
        warnings.push(`${importedName}: its data couldn't be read, so it was added as an empty set.`);
      }
    } else if (db && !db.ok) {
      warnings.push(`${importedName}: its data didn't match the export's checksum (the file may be damaged), so it was added as an empty set.`);
    }

    counter += 1;
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}-${counter}`;
    const dbFileName = `devikins-import-${suffix}.db`;
    const imagesDirName = `nft-images-import-${suffix}`;

    onProgress?.({ phase: 'restoring', setName: manifest.name });
    await restoreWalletSetData(dbFileName, dump, (rowProgress) => {
      onProgress?.({ phase: 'restoring', setName: manifest.name, current: rowProgress.current, total: rowProgress.total });
    });
    await registerImportedWalletSet(importedName, dbFileName, imagesDirName);
    await logImportedSetRowCounts(dbFileName);
    importedNames.push(importedName);
  }

  return { importedNames, warnings };
}
